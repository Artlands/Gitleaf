/**
 * GitHub OAuth and REST API client
 * Phase 1: Device Flow as primary OAuth method
 */

import { GitHubToken } from '@shared/types';
import { computeSHA1 } from '@shared/hash';
import * as Storage from './storage';

// GitHub OAuth App credentials (these will be set during setup)
// For now, use placeholder values
const GITHUB_CLIENT_ID = 'YOUR_GITHUB_CLIENT_ID';
const GITHUB_DEVICE_AUTH_ENDPOINT = 'https://github.com/login/device/code';
const GITHUB_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const GITHUB_API_BASE = 'https://api.github.com';

const OAUTH_SCOPES = 'repo read:user';

function githubApiUrl(path: string): string {
  return `${GITHUB_API_BASE}${path}`;
}

async function errorMessageFromResponse(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.clone().json()) as { message?: unknown };
    if (typeof data.message === 'string' && data.message.trim()) {
      return `${fallback}: ${data.message}`;
    }
  } catch {
    // Fall through to status text below.
  }

  return `${fallback}: ${response.statusText || `HTTP ${response.status}`}`;
}

function bytesToBase64(content: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';

  for (let offset = 0; offset < content.length; offset += chunkSize) {
    const chunk = content.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function base64ToBytes(content: string): Uint8Array {
  const binary = atob(content.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubUser {
  login: string;
  id: number;
  name?: string;
  avatar_url?: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
  private: boolean;
  default_branch: string;
  description?: string;
}

export interface GitHubBlob {
  sha: string;
  size: number;
  url: string;
  content?: string;
  encoding?: 'base64' | 'utf-8';
}

export interface GitHubTree {
  sha: string;
  url: string;
  tree: Array<{
    path: string;
    mode: string;
    type: 'blob' | 'tree';
    sha: string;
    size?: number;
    url: string;
  }>;
  truncated: boolean;
}

export interface GitHubBranchRef {
  object: {
    sha: string;
    type: 'commit';
  };
}

export interface GitHubCommit {
  sha: string;
  tree: {
    sha: string;
  };
}

export interface PushFilesResult {
  commitSha: string;
  treeSha: string;
  blobShas: Record<string, string>;
}

export interface GitHubFileTreeWithHashes {
  [path: string]: {
    content: Uint8Array;
    hash: string;
    ghSha: string;
  };
}

/**
 * Initiate Device Flow OAuth
 */
export async function startDeviceFlow(): Promise<DeviceAuthResponse> {
  const response = await fetch(GITHUB_DEVICE_AUTH_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: OAUTH_SCOPES,
    }),
  });

  if (!response.ok) {
    throw new Error(`Device flow initiation failed: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Poll for Device Flow token
 * Polls every `interval` seconds until token is granted or flow expires
 */
export async function pollDeviceToken(
  deviceCode: string,
  expiresIn: number,
  interval: number
): Promise<GitHubToken> {
  const endTime = Date.now() + expiresIn * 1000;

  while (Date.now() < endTime) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));

    const response = await fetch(GITHUB_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = await response.json() as Record<string, unknown>;

    if (data.error === 'authorization_pending') {
      // User hasn't authorized yet, keep polling
      continue;
    }

    if (data.error === 'expired_token') {
      throw new Error('Device flow expired. Please try again.');
    }

    if (data.error) {
      throw new Error(`Device flow error: ${data.error}`);
    }

    if (data.access_token) {
      const token: GitHubToken = {
        accessToken: data.access_token as string,
        scopes: OAUTH_SCOPES.split(' '),
        expiresAt: data.expires_in ? new Date(Date.now() + (data.expires_in as number) * 1000).toISOString() : undefined,
      };

      // Store token
      await Storage.setGitHubToken(token);
      return token;
    }
  }

  throw new Error('Device flow authorization timeout');
}

/**
 * Validate token by fetching user info
 */
export async function validateToken(token: string): Promise<GitHubUser | null> {
  try {
  const response = await fetch(githubApiUrl('/user'), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return null; // Invalid token
      }
      throw new Error(await errorMessageFromResponse(response, 'User API failed'));
    }

    return response.json();
  } catch (error) {
    console.error('[Gitleaf] Token validation error:', error);
    return null;
  }
}

/**
 * Store a user-provided Personal Access Token after validating it.
 */
export async function storePersonalAccessToken(token: string): Promise<GitHubToken> {
  const user = await validateToken(token);
  if (!user) {
    throw new Error('Invalid GitHub token');
  }

  const storedToken: GitHubToken = {
    accessToken: token,
    scopes: [],
    login: user.login,
  };
  await Storage.setGitHubToken(storedToken);
  return storedToken;
}

/**
 * Get user's repositories
 */
export async function getUserRepositories(token: string): Promise<GitHubRepository[]> {
  const repos: GitHubRepository[] = [];
  let page = 1;
  let hasMorePages = true;

  while (hasMorePages) {
    const response = await fetch(githubApiUrl(`/user/repos?page=${page}&per_page=100`), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      throw new Error(await errorMessageFromResponse(response, 'Failed to fetch repositories'));
    }

    const pageRepos = await response.json() as GitHubRepository[];
    if (pageRepos.length === 0) {
      hasMorePages = false;
      continue;
    }

    repos.push(...pageRepos);
    page++;
  }

  return repos;
}

/**
 * Get repository tree
 */
export async function getRepositoryTree(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<GitHubTree> {
  const response = await fetch(
    githubApiUrl(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    ),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response, 'Failed to fetch tree'));
  }

  return response.json();
}

export async function getBranchRef(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<GitHubBranchRef> {
  const response = await fetch(
    githubApiUrl(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`
    ),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response, 'Failed to fetch branch ref'));
  }

  return response.json();
}

export async function getCommit(
  token: string,
  owner: string,
  repo: string,
  sha: string
): Promise<GitHubCommit> {
  const response = await fetch(
    githubApiUrl(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(sha)}`
    ),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response, 'Failed to fetch commit'));
  }

  return response.json();
}

/**
 * Get a blob by SHA
 */
export async function getBlob(
  token: string,
  owner: string,
  repo: string,
  sha: string
): Promise<GitHubBlob> {
  const response = await fetch(
    githubApiUrl(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`
    ),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response, 'Failed to fetch blob'));
  }

  return response.json();
}

export async function getRepositoryFiles(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  subPath?: string
): Promise<GitHubFileTreeWithHashes> {
  const tree = await getRepositoryTree(token, owner, repo, branch);
  if (tree.truncated) {
    throw new Error('GitHub repository tree is too large to sync safely.');
  }

  const prefix = subPath?.replace(/^\/+|\/+$/g, '');
  const normalizedPrefix = prefix ? `${prefix}/` : '';
  const files: GitHubFileTreeWithHashes = {};
  let sawSubPath = !normalizedPrefix;

  for (const entry of tree.tree) {
    if (normalizedPrefix && (entry.path === prefix || entry.path.startsWith(normalizedPrefix))) {
      sawSubPath = true;
    }

    if (entry.type !== 'blob') {
      continue;
    }
    if (normalizedPrefix && !entry.path.startsWith(normalizedPrefix)) {
      continue;
    }

    const overleafPath = normalizedPrefix ? entry.path.slice(normalizedPrefix.length) : entry.path;
    if (!overleafPath) {
      continue;
    }

    const blob = await getBlob(token, owner, repo, entry.sha);
    if (!blob.content || blob.encoding !== 'base64') {
      throw new Error(`Unsupported GitHub blob encoding for ${entry.path}`);
    }

    const content = base64ToBytes(blob.content);
    files[overleafPath] = {
      content,
      hash: await computeSHA1(content),
      ghSha: entry.sha,
    };
  }

  if (normalizedPrefix && !sawSubPath) {
    throw new Error(`GitHub subfolder "${prefix}" was not found in ${owner}/${repo}@${branch}.`);
  }

  if (normalizedPrefix && Object.keys(files).length === 0) {
    throw new Error(`GitHub subfolder "${prefix}" does not contain any files to pull.`);
  }

  return files;
}

/**
 * Create a blob in a repository
 */
export async function createBlob(
  token: string,
  owner: string,
  repo: string,
  content: Uint8Array
): Promise<string> {
  // Convert Uint8Array to base64 for the API
  const base64Content = bytesToBase64(content);

  const response = await fetch(
    githubApiUrl(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({
        content: base64Content,
        encoding: 'base64',
      }),
    }
  );

  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response, 'Failed to create blob'));
  }

  const data = (await response.json()) as { sha: string };
  return data.sha;
}

/**
 * Create a tree in a repository
 */
export async function createTree(
  token: string,
  owner: string,
  repo: string,
  tree: Array<{
    path: string;
    mode: '100644' | '100755' | '040000' | '160000';
    type: 'blob' | 'tree' | 'commit';
    sha: string | null;
  }>,
  baseTreeSha?: string
): Promise<string> {
  const response = await fetch(
    githubApiUrl(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({
        tree,
        base_tree: baseTreeSha,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response, 'Failed to create tree'));
  }

  const data = (await response.json()) as { sha: string };
  return data.sha;
}

/**
 * Create a commit
 */
export async function createCommit(
  token: string,
  owner: string,
  repo: string,
  message: string,
  treeSha: string,
  parentSha: string,
  author?: { name: string; email: string; date: string }
): Promise<string> {
  const response = await fetch(
    githubApiUrl(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({
        message,
        tree: treeSha,
        parents: [parentSha],
        author,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response, 'Failed to create commit'));
  }

  const data = (await response.json()) as { sha: string };
  return data.sha;
}

/**
 * Update a branch reference
 */
export async function updateBranchRef(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  sha: string
): Promise<void> {
  const response = await fetch(
    githubApiUrl(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`
    ),
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({
        sha,
        force: false,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response, 'Failed to update branch'));
  }
}

/**
 * Perform a full push: create blobs, tree, commit, update branch
 */
export async function pushFiles(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  files: Array<{ path: string; content: Uint8Array }>,
  deletedPaths: string[],
  baseTreeSha: string,
  parentCommitSha: string,
  message: string
): Promise<PushFilesResult> {
  // 1. Create blobs for all files
  const blobShas: Record<string, string> = {};
  for (const file of files) {
    const sha = await createBlob(token, owner, repo, file.content);
    blobShas[file.path] = sha;
  }

  // 2. Create tree
  const treeEntries: Array<{
    path: string;
    mode: '100644';
    type: 'blob';
    sha: string | null;
  }> = files.map((file) => ({
    path: file.path,
    mode: '100644' as const,
    type: 'blob' as const,
    sha: blobShas[file.path],
  }));

  for (const path of deletedPaths) {
    treeEntries.push({
      path,
      mode: '100644',
      type: 'blob',
      sha: null,
    });
  }

  const treeSha = await createTree(token, owner, repo, treeEntries, baseTreeSha);

  // 3. Create commit
  const commitSha = await createCommit(token, owner, repo, message, treeSha, parentCommitSha);

  // 4. Update branch
  await updateBranchRef(token, owner, repo, branch, commitSha);

  return {
    commitSha,
    treeSha,
    blobShas,
  };
}
