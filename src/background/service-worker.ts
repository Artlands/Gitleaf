/**
 * Service Worker (background script)
 * Orchestrates sync operations and handles messaging
 */

import { ContentScriptMessage, PopupMessage, ServiceWorkerResponse, LinkConfig } from '@shared/types';
import * as Storage from './storage';
import * as OverleafClient from './overleaf-client';
import * as GitHubClient from './github-client';
import * as SyncEngine from './sync-engine';

interface ProjectMeta {
  projectId: string;
  projectName: string;
  csrfToken: string;
  userId?: string;
  rootFolder?: unknown;
}

// In-memory store for the current tab's project metadata
const currentProjectMeta: Map<number, ProjectMeta> = new Map();

function getMessageTabId(sender: chrome.runtime.MessageSender, payload?: Record<string, unknown>): number {
  const payloadTabId = payload?.tabId;
  if (typeof payloadTabId === 'number') {
    return payloadTabId;
  }
  return sender.tab?.id || 0;
}

function extractProjectIdFromUrl(url?: string): string | null {
  if (!url) {
    return null;
  }
  const match = url.match(/\/project\/([a-f0-9]+)/i);
  return match ? match[1] : null;
}

function getProjectMeta(tabId: number, payload?: Record<string, unknown>): ProjectMeta | null {
  const stored = currentProjectMeta.get(tabId);

  // Always prefer freshly fetched values from the payload (the popup actively
  // re-fetches the rootFolder, csrfToken, etc. each time it opens), and only
  // fall back to whatever was stored from the initial PROJECT_META broadcast.
  const payloadProjectId =
    typeof payload?.projectId === 'string'
      ? payload.projectId
      : extractProjectIdFromUrl(typeof payload?.tabUrl === 'string' ? payload.tabUrl : undefined);

  const projectId = payloadProjectId || stored?.projectId;
  if (!projectId) {
    return null;
  }

  const payloadProjectName =
    typeof payload?.projectName === 'string' ? payload.projectName : undefined;
  const payloadCsrfToken =
    typeof payload?.csrfToken === 'string' && payload.csrfToken ? payload.csrfToken : undefined;
  const payloadUserId = typeof payload?.userId === 'string' ? payload.userId : undefined;
  const payloadRootFolder = payload?.rootFolder;

  const merged: ProjectMeta = {
    projectId,
    projectName: payloadProjectName || stored?.projectName || 'Untitled Project',
    csrfToken: payloadCsrfToken || stored?.csrfToken || '',
    userId: payloadUserId || stored?.userId,
    rootFolder: payloadRootFolder ?? stored?.rootFolder,
  };

  // Persist the merged meta so subsequent calls (e.g., when invoked from the
  // content script without a payload) can still see the fresh data.
  currentProjectMeta.set(tabId, merged);

  return merged;
}

function normalizeSubPath(subPath?: string): string | undefined {
  if (!subPath) {
    return undefined;
  }
  const trimmed = subPath.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `${trimmed}/` : undefined;
}

function mapToGitHubPath(path: string, subPath?: string): string {
  return `${normalizeSubPath(subPath) || ''}${path}`.replace(/^\/+/, '');
}

function mapBlobShasToOverleafPaths(
  blobShas: Record<string, string>,
  subPath?: string
): Record<string, string> {
  const prefix = normalizeSubPath(subPath) || '';
  const mapped: Record<string, string> = {};

  for (const [path, sha] of Object.entries(blobShas)) {
    mapped[prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path] = sha;
  }

  return mapped;
}

/**
 * Handle messages from content scripts and popup
 */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const typedMessage = message as ContentScriptMessage | PopupMessage;

  if (typedMessage.type === 'PROJECT_META') {
    const projectMeta = typedMessage as ContentScriptMessage;
    if (sender.tab?.id) {
      const existing = currentProjectMeta.get(sender.tab.id);
      // Merge with any existing stored meta so that fields not provided by the
      // content script (e.g., an older PROJECT_META broadcast that lacks
      // rootFolder) don't clobber freshly fetched values from the popup.
      currentProjectMeta.set(sender.tab.id, {
        projectId: projectMeta.projectId || existing?.projectId || '',
        projectName: projectMeta.projectName || existing?.projectName || 'Untitled Project',
        csrfToken: projectMeta.csrfToken || existing?.csrfToken || '',
        userId: projectMeta.userId || existing?.userId,
        rootFolder: projectMeta.rootFolder ?? existing?.rootFolder,
      });
    }
    sendResponse({ success: true });
    return;
  }

  if (typedMessage.type === 'GET_LINK_STATUS') {
    handleGetLinkStatus(getMessageTabId(sender, typedMessage.payload), typedMessage.payload).then((response) => {
      sendResponse(response);
    });
    return true; // Async
  }

  if (typedMessage.type === 'PUSH') {
    handlePush(getMessageTabId(sender, typedMessage.payload), typedMessage.payload).then((response) => {
      sendResponse(response);
    });
    return true; // Async
  }

  if (typedMessage.type === 'PULL') {
    handlePull(getMessageTabId(sender, typedMessage.payload), typedMessage.payload).then((response) => {
      sendResponse(response);
    });
    return true;
  }

  if (typedMessage.type === 'PREVIEW_PUSH') {
    handlePreviewPush(getMessageTabId(sender, typedMessage.payload), typedMessage.payload).then(
      (response) => sendResponse(response)
    );
    return true;
  }

  if (typedMessage.type === 'PREVIEW_PULL') {
    handlePreviewPull(getMessageTabId(sender, typedMessage.payload), typedMessage.payload).then(
      (response) => sendResponse(response)
    );
    return true;
  }

  if (typedMessage.type === 'SYNC') {
    sendResponse({
      success: false,
      error: 'Bidirectional sync is not available yet. Use Push or Pull.',
    });
    return;
  }

  if (typedMessage.type === 'LINK_GITHUB') {
    handleLinkGitHub(getMessageTabId(sender, typedMessage.payload), typedMessage.payload).then((response) => {
      sendResponse(response);
    });
    return true; // Async
  }

  if (typedMessage.type === 'GET_GITHUB_REPOS') {
    handleGetGitHubRepos().then((response) => {
      sendResponse(response);
    });
    return true; // Async
  }

  if (typedMessage.type === 'SET_GITHUB_TOKEN') {
    handleSetGitHubToken(typedMessage.payload).then((response) => {
      sendResponse(response);
    });
    return true;
  }

  if (typedMessage.type === 'GET_AUTH_STATUS') {
    handleGetAuthStatus().then((response) => {
      sendResponse(response);
    });
    return true;
  }

  sendResponse({ success: false, error: 'Unknown message type' });
});

/**
 * Handle GET_LINK_STATUS message
 */
async function handleGetLinkStatus(
  tabId: number,
  payload?: Record<string, unknown>
): Promise<ServiceWorkerResponse> {
  try {
    const projectMeta = getProjectMeta(tabId, payload);
    if (!projectMeta) {
      return { success: false, error: 'No project found on this tab' };
    }

    const linkConfig = await Storage.getLinkConfig(projectMeta.projectId);
    if (!linkConfig) {
      return { success: true, data: { linked: false } };
    }

    const manifest = await Storage.getSyncManifest(projectMeta.projectId);

    return {
      success: true,
      data: {
        linked: true,
        linkConfig,
        lastSync: manifest?.lastSync || null,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Handle PUSH message
 */
async function handlePush(
  tabId: number,
  payload?: Record<string, unknown>
): Promise<ServiceWorkerResponse> {
  try {
    const projectMeta = getProjectMeta(tabId, payload);
    if (!projectMeta) {
      return { success: false, error: 'No project found on this tab' };
    }

    // Check if linked
    const linkConfig = await Storage.getLinkConfig(projectMeta.projectId);
    if (!linkConfig) {
      return { success: false, error: 'Project is not linked to GitHub' };
    }

    // Get GitHub token
    const githubToken = await Storage.getGitHubToken();
    if (!githubToken) {
      return { success: false, error: 'Not authenticated with GitHub' };
    }

    // Get current files from Overleaf
    console.log('[Gitleaf] Fetching project files from Overleaf...');
    const currentFiles = await OverleafClient.getProjectFiles(projectMeta.projectId);
    const ignorePatterns = await Storage.getIgnorePatterns();
    const ignoredFilteredFiles = SyncEngine.filterIgnoredFiles(currentFiles, ignorePatterns);

    // Check for large files
    const { valid: validFiles, skipped } = OverleafClient.filterLargeFiles(ignoredFilteredFiles);
    if (skipped.length > 0) {
      console.warn('[Gitleaf] Skipped large files:', skipped);
    }

    // Get current manifest
    const manifest = await Storage.getSyncManifest(projectMeta.projectId);

    // Detect changes
    console.log('[Gitleaf] Detecting changes...');
    const changes = SyncEngine.detectPushChanges(validFiles, manifest);

    // Validate changes
    const validation = SyncEngine.validateChangesForPush(changes);
    if (!validation.valid) {
      return {
        success: false,
        error: `Invalid changes: ${validation.errors.join(', ')}`,
      };
    }

    // If no changes, return early
    if (
      changes.added.length === 0 &&
      changes.modified.length === 0 &&
      changes.deleted.length === 0
    ) {
      console.log('[Gitleaf] No changes to push');
      return {
        success: true,
        data: {
          message: 'No changes to push',
          changes: { added: 0, modified: 0, deleted: 0 },
        },
      };
    }

    // Build commit message
    const commitMessage = SyncEngine.buildCommitMessage(changes).replace(
      '{PROJECT_ID}',
      projectMeta.projectId
    );

    // Fetch repository branch and commit so the new commit is based on the current tree.
    console.log('[Gitleaf] Fetching GitHub repository info...');
    const branchRef = await GitHubClient.getBranchRef(
      githubToken.accessToken,
      linkConfig.github.owner,
      linkConfig.github.repo,
      linkConfig.github.branch
    );
    const parentCommit = await GitHubClient.getCommit(
      githubToken.accessToken,
      linkConfig.github.owner,
      linkConfig.github.repo,
      branchRef.object.sha
    );

    const subPath = normalizeSubPath(linkConfig.github.subPath);
    const filesToPush = [...changes.added, ...changes.modified].map((file) => ({
      path: mapToGitHubPath(file.path, subPath),
      content: file.content,
    }));
    const deletedPaths = changes.deleted.map((path) => mapToGitHubPath(path, subPath));

    // Push files to GitHub
    console.log('[Gitleaf] Pushing files to GitHub...');
    const pushResult = await GitHubClient.pushFiles(
      githubToken.accessToken,
      linkConfig.github.owner,
      linkConfig.github.repo,
      linkConfig.github.branch,
      filesToPush,
      deletedPaths,
      parentCommit.tree.sha,
      parentCommit.sha,
      commitMessage
    );

    console.log('[Gitleaf] Push successful!');

    const pushedBlobShas = mapBlobShasToOverleafPaths(pushResult.blobShas, subPath);
    const existingBlobShas: Record<string, string> = {};
    for (const [path, entry] of Object.entries(manifest?.files || {})) {
      existingBlobShas[path] = entry.ghSha;
    }

    const nextManifest = SyncEngine.createManifestAfterPush(
      projectMeta.projectId,
      linkConfig.github.owner,
      linkConfig.github.repo,
      linkConfig.github.branch,
      validFiles,
      { ...existingBlobShas, ...pushedBlobShas },
      subPath
    );
    await Storage.setSyncManifest(nextManifest);

    return {
      success: true,
      data: {
        message: 'Push successful',
        changes: {
          added: changes.added.length,
          modified: changes.modified.length,
          deleted: changes.deleted.length,
        },
      },
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error during push';
    console.error('[Gitleaf] Push failed:', errorMsg);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

async function handlePull(
  tabId: number,
  payload?: Record<string, unknown>
): Promise<ServiceWorkerResponse> {
  try {
    const projectMeta = getProjectMeta(tabId, payload);
    if (!projectMeta) {
      return { success: false, error: 'No project found on this tab' };
    }

    const linkConfig = await Storage.getLinkConfig(projectMeta.projectId);
    if (!linkConfig) {
      return { success: false, error: 'Project is not linked to GitHub' };
    }

    const githubToken = await Storage.getGitHubToken();
    if (!githubToken) {
      return { success: false, error: 'Not authenticated with GitHub' };
    }

    console.log('[Gitleaf] Fetching GitHub files...');
    const remoteFiles = await GitHubClient.getRepositoryFiles(
      githubToken.accessToken,
      linkConfig.github.owner,
      linkConfig.github.repo,
      linkConfig.github.branch,
      normalizeSubPath(linkConfig.github.subPath)
    );
    const ignorePatterns = await Storage.getIgnorePatterns();
    const filteredRemoteFiles: GitHubClient.GitHubFileTreeWithHashes = {};
    for (const [path, file] of Object.entries(remoteFiles)) {
      if (!ignorePatterns.some((pattern) => SyncEngine.matchesIgnorePattern(path, pattern))) {
        filteredRemoteFiles[path] = file;
      }
    }

    const validRemoteFiles: GitHubClient.GitHubFileTreeWithHashes = {};
    const skippedRemoteFiles: string[] = [];
    for (const [path, file] of Object.entries(filteredRemoteFiles)) {
      if (file.content.length > 100 * 1024 * 1024) {
        skippedRemoteFiles.push(`${path} (${Math.round(file.content.length / 1024 / 1024)} MB)`);
      } else {
        validRemoteFiles[path] = file;
      }
    }
    if (skippedRemoteFiles.length > 0) {
      console.warn('[Gitleaf] Skipped large files:', skippedRemoteFiles);
    }

    const manifest = await Storage.getSyncManifest(projectMeta.projectId);
    // Apply exactly the change set shown in the PREVIEW_PULL dialog.
    const changes = SyncEngine.detectPullChanges(validRemoteFiles, manifest);
    const validation = SyncEngine.validateChangesForPull(changes);
    if (!validation.valid) {
      return {
        success: false,
        error: `Invalid changes: ${validation.errors.join(', ')}`,
      };
    }

    if (
      changes.added.length === 0 &&
      changes.modified.length === 0 &&
      changes.deleted.length === 0
    ) {
      return {
        success: true,
        data: {
          message: 'No changes to pull',
          changes: { added: 0, modified: 0, deleted: 0 },
        },
      };
    }

    const filesToApply: Record<string, { content: Uint8Array }> = {};
    for (const file of [...changes.added, ...changes.modified]) {
      filesToApply[file.path] = { content: file.content };
    }

    console.log('[Gitleaf] Applying files to Overleaf...');
    const applyResult = await OverleafClient.applyProjectFiles(
      projectMeta.projectId,
      projectMeta.csrfToken,
      projectMeta.userId,
      projectMeta.rootFolder,
      filesToApply,
      changes.deleted
    );

    const nextManifest = SyncEngine.createManifestAfterPull(
      projectMeta.projectId,
      linkConfig.github.owner,
      linkConfig.github.repo,
      linkConfig.github.branch,
      validRemoteFiles,
      normalizeSubPath(linkConfig.github.subPath)
    );
    await Storage.setSyncManifest(nextManifest);

    return {
      success: true,
      data: {
        message: 'Pull successful',
        changes: {
          added: applyResult.added.length,
          modified: applyResult.modified.length,
          deleted: applyResult.deleted.length,
        },
      },
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error during pull';
    console.error('[Gitleaf] Pull failed:', errorMsg);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

async function handlePreviewPush(
  tabId: number,
  payload?: Record<string, unknown>
): Promise<ServiceWorkerResponse> {
  try {
    const projectMeta = getProjectMeta(tabId, payload);
    if (!projectMeta) {
      return { success: false, error: 'No project found on this tab' };
    }

    const linkConfig = await Storage.getLinkConfig(projectMeta.projectId);
    if (!linkConfig) {
      return { success: false, error: 'Project is not linked to GitHub' };
    }

    const currentFiles = await OverleafClient.getProjectFiles(projectMeta.projectId);
    const ignorePatterns = await Storage.getIgnorePatterns();
    const ignoredFilteredFiles = SyncEngine.filterIgnoredFiles(currentFiles, ignorePatterns);
    const { valid: validFiles } = OverleafClient.filterLargeFiles(ignoredFilteredFiles);

    const manifest = await Storage.getSyncManifest(projectMeta.projectId);
    const changes = SyncEngine.detectPushChanges(validFiles, manifest);

    return {
      success: true,
      data: {
        preview: {
          added: changes.added.map((f) => f.path),
          modified: changes.modified.map((f) => f.path),
          deleted: changes.deleted,
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function handlePreviewPull(
  tabId: number,
  payload?: Record<string, unknown>
): Promise<ServiceWorkerResponse> {
  try {
    const projectMeta = getProjectMeta(tabId, payload);
    if (!projectMeta) {
      return { success: false, error: 'No project found on this tab' };
    }

    const linkConfig = await Storage.getLinkConfig(projectMeta.projectId);
    if (!linkConfig) {
      return { success: false, error: 'Project is not linked to GitHub' };
    }

    const githubToken = await Storage.getGitHubToken();
    if (!githubToken) {
      return { success: false, error: 'Not authenticated with GitHub' };
    }

    const remoteFiles = await GitHubClient.getRepositoryFiles(
      githubToken.accessToken,
      linkConfig.github.owner,
      linkConfig.github.repo,
      linkConfig.github.branch,
      normalizeSubPath(linkConfig.github.subPath)
    );
    const ignorePatterns = await Storage.getIgnorePatterns();
    const filteredRemoteFiles: GitHubClient.GitHubFileTreeWithHashes = {};
    for (const [path, file] of Object.entries(remoteFiles)) {
      if (!ignorePatterns.some((pattern) => SyncEngine.matchesIgnorePattern(path, pattern))) {
        filteredRemoteFiles[path] = file;
      }
    }

    const validRemoteFiles: GitHubClient.GitHubFileTreeWithHashes = {};
    for (const [path, file] of Object.entries(filteredRemoteFiles)) {
      if (file.content.length <= 100 * 1024 * 1024) {
        validRemoteFiles[path] = file;
      }
    }

    const manifest = await Storage.getSyncManifest(projectMeta.projectId);
    const changes = SyncEngine.detectPullChanges(validRemoteFiles, manifest);

    return {
      success: true,
      data: {
        preview: {
          added: changes.added.map((f) => f.path),
          modified: changes.modified.map((f) => f.path),
          deleted: changes.deleted,
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Handle LINK_GITHUB message
 */
async function handleLinkGitHub(
  tabId: number,
  payload?: Record<string, unknown>
): Promise<ServiceWorkerResponse> {
  try {
    const projectMeta = getProjectMeta(tabId, payload);
    if (!projectMeta) {
      return { success: false, error: 'No project found on this tab' };
    }

    if (!payload || typeof payload.owner !== 'string' || typeof payload.repo !== 'string') {
      return { success: false, error: 'Invalid payload: owner and repo required' };
    }

    const owner = payload.owner;
    const repo = payload.repo;
    const branch = (payload.branch as string) || 'main';
    const subPath = normalizeSubPath(typeof payload.subPath === 'string' ? payload.subPath : undefined);

    // Create link config
    const linkConfig: LinkConfig = {
      overleafProjectId: projectMeta.projectId,
      overleafProjectName: projectMeta.projectName,
      github: {
        owner,
        repo,
        branch,
        subPath,
      },
      syncDirection: 'push', // Phase 1: push only
      createdAt: new Date().toISOString(),
    };

    await Storage.setLinkConfig(linkConfig);

    return {
      success: true,
      data: { message: 'Project linked successfully' },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function handleSetGitHubToken(payload?: Record<string, unknown>): Promise<ServiceWorkerResponse> {
  try {
    const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
    if (!token) {
      return { success: false, error: 'GitHub token is required' };
    }

    const storedToken = await GitHubClient.storePersonalAccessToken(token);
    return {
      success: true,
      data: {
        login: storedToken.login,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function handleGetAuthStatus(): Promise<ServiceWorkerResponse> {
  try {
    const token = await Storage.getGitHubToken();
    return {
      success: true,
      data: {
        authenticated: Boolean(token),
        login: token?.login,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Handle GET_GITHUB_REPOS message
 */
async function handleGetGitHubRepos(): Promise<ServiceWorkerResponse> {
  try {
    const githubToken = await Storage.getGitHubToken();
    if (!githubToken) {
      return { success: false, error: 'Not authenticated with GitHub' };
    }

    const repos = await GitHubClient.getUserRepositories(githubToken.accessToken);

    return {
      success: true,
      data: {
        repos: repos.map((r) => ({
          id: r.id,
          name: r.name,
          full_name: r.full_name,
          owner: r.owner.login,
          default_branch: r.default_branch,
          private: r.private,
        })),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// Log that service worker loaded
console.log('[Gitleaf] Service worker loaded');
