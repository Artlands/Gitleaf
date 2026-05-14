/**
 * Sync engine for Gitleaf
 * Phase 1: Push only
 * Phase 3+: Bidirectional with three-way diff
 */

import { SyncManifest } from '@shared/types';
import { OverleafFileTreeWithHashes } from './overleaf-client';
import { hashesEqual } from '@shared/hash';

export interface PushChanges {
  added: Array<{ path: string; content: Uint8Array }>;
  modified: Array<{ path: string; content: Uint8Array }>;
  deleted: string[];
}

export interface PullChanges {
  added: Array<{ path: string; content: Uint8Array; ghSha: string; hash: string }>;
  modified: Array<{ path: string; content: Uint8Array; ghSha: string; hash: string }>;
  deleted: string[];
}

export interface RemoteFileTreeWithHashes {
  [path: string]: {
    content: Uint8Array;
    hash: string;
    ghSha: string;
  };
}

export function matchesIgnorePattern(path: string, pattern: string): boolean {
  const normalizedPath = path.replace(/^\/+/, '');
  const normalizedPattern = pattern.trim().replace(/^\/+/, '');

  if (!normalizedPattern || normalizedPattern.startsWith('#')) {
    return false;
  }

  if (normalizedPattern.endsWith('/')) {
    return normalizedPath.startsWith(normalizedPattern);
  }

  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  const regex = new RegExp(`(^|/)${escaped}$`);
  return regex.test(normalizedPath);
}

export function filterIgnoredFiles(
  files: OverleafFileTreeWithHashes,
  patterns: string[]
): OverleafFileTreeWithHashes {
  const filtered: OverleafFileTreeWithHashes = {};

  for (const [path, file] of Object.entries(files)) {
    if (!patterns.some((pattern) => matchesIgnorePattern(path, pattern))) {
      filtered[path] = file;
    }
  }

  return filtered;
}

/**
 * Detect what files have changed in Overleaf since last sync
 * Returns files to push to GitHub
 */
export function detectPushChanges(
  currentFiles: OverleafFileTreeWithHashes,
  manifest: SyncManifest | null
): PushChanges {
  const changes: PushChanges = {
    added: [],
    modified: [],
    deleted: [],
  };

  if (!manifest) {
    // First sync: everything is new
    for (const [path, file] of Object.entries(currentFiles)) {
      changes.added.push({ path, content: file.content });
    }
    return changes;
  }

  const manifestPaths = new Set(Object.keys(manifest.files));
  const currentPaths = new Set(Object.keys(currentFiles));

  // Find modified and added files
  for (const [path, file] of Object.entries(currentFiles)) {
    const manifestEntry = manifest.files[path];

    if (!manifestEntry) {
      // File is new
      changes.added.push({ path, content: file.content });
    } else if (!hashesEqual(file.hash, manifestEntry.ovHash)) {
      // File was modified
      changes.modified.push({ path, content: file.content });
    }
    // else: file unchanged, skip
  }

  // Find deleted files
  for (const path of manifestPaths) {
    if (!currentPaths.has(path)) {
      changes.deleted.push(path);
    }
  }

  return changes;
}

export function detectPullChanges(
  currentFiles: RemoteFileTreeWithHashes,
  manifest: SyncManifest | null
): PullChanges {
  const changes: PullChanges = {
    added: [],
    modified: [],
    deleted: [],
  };

  if (!manifest) {
    for (const [path, file] of Object.entries(currentFiles)) {
      changes.added.push({ path, content: file.content, ghSha: file.ghSha, hash: file.hash });
    }
    return changes;
  }

  const manifestPaths = new Set(Object.keys(manifest.files));
  const currentPaths = new Set(Object.keys(currentFiles));

  for (const [path, file] of Object.entries(currentFiles)) {
    const manifestEntry = manifest.files[path];

    if (!manifestEntry) {
      changes.added.push({ path, content: file.content, ghSha: file.ghSha, hash: file.hash });
    } else if (!hashesEqual(file.hash, manifestEntry.ghHash)) {
      changes.modified.push({ path, content: file.content, ghSha: file.ghSha, hash: file.hash });
    }
  }

  for (const path of manifestPaths) {
    if (!currentPaths.has(path)) {
      changes.deleted.push(path);
    }
  }

  return changes;
}

/**
 * Validate that changes are safe to push
 * In Phase 1, we do basic validation
 * Phase 3 will add three-way diff conflict detection
 */
export function validateChangesForPush(
  changes: PushChanges,
  maxFileSize = 100 * 1024 * 1024
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check file size limits
  for (const file of [...changes.added, ...changes.modified]) {
    if (file.content.length > maxFileSize) {
      errors.push(
        `File too large: ${file.path} (${Math.round(file.content.length / 1024 / 1024)} MB)`
      );
    }
  }

  // In Phase 1, we don't have binary detection, so just warn about common binary extensions
  const binaryExtensions = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.tar', '.gz'];
  for (const file of [...changes.added, ...changes.modified]) {
    const hasBinaryExt = binaryExtensions.some((ext) => file.path.endsWith(ext));
    if (hasBinaryExt && file.content.length > 1024 * 1024) {
      // Large binary file, warn but don't error
      console.warn(`[Gitleaf] Large binary file: ${file.path}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export const validateChangesForPull = validateChangesForPush;

/**
 * Create a new manifest after a successful push
 * All files should now match between Overleaf and GitHub
 */
export function createManifestAfterPush(
  projectId: string,
  owner: string,
  repo: string,
  branch: string,
  currentFiles: OverleafFileTreeWithHashes,
  githubBlobShas: Record<string, string>,
  subPath?: string
): SyncManifest {
  const files: Record<string, { ovHash: string; ghHash: string; ghSha: string }> = {};

  for (const [path, file] of Object.entries(currentFiles)) {
    files[path] = {
      ovHash: file.hash,
      ghHash: file.hash,
      ghSha: githubBlobShas[path] || '', // Will be set by caller after GitHub commit
    };
  }

  return {
    overleafProjectId: projectId,
    github: {
      owner,
      repo,
      branch,
      subPath,
    },
    lastSync: new Date().toISOString(),
    files,
  };
}

export function createManifestAfterPull(
  projectId: string,
  owner: string,
  repo: string,
  branch: string,
  currentFiles: RemoteFileTreeWithHashes,
  subPath?: string
): SyncManifest {
  const files: Record<string, { ovHash: string; ghHash: string; ghSha: string }> = {};

  for (const [path, file] of Object.entries(currentFiles)) {
    files[path] = {
      ovHash: file.hash,
      ghHash: file.hash,
      ghSha: file.ghSha,
    };
  }

  return {
    overleafProjectId: projectId,
    github: {
      owner,
      repo,
      branch,
      subPath,
    },
    lastSync: new Date().toISOString(),
    files,
  };
}

/**
 * Build commit message for GitHub
 */
export function buildCommitMessage(changes: PushChanges): string {
  const timestamp = new Date().toUTCString();
  const lines: string[] = ['Sync from Overleaf — ' + timestamp];

  if (changes.added.length > 0) {
    lines.push(`Added ${changes.added.length} file(s)`);
  }
  if (changes.modified.length > 0) {
    lines.push(`Modified ${changes.modified.length} file(s)`);
  }
  if (changes.deleted.length > 0) {
    lines.push(`Deleted ${changes.deleted.length} file(s)`);
  }

  // Add trailer for traceability (will be set by service worker with project ID)
  lines.push('');
  lines.push('Gitleaf-Project-Id: {PROJECT_ID}');

  return lines.join('\n');
}

/**
 * Plan a sync operation (returns what would be done)
 * Useful for preview before execution
 */
export function planSync(
  currentFiles: OverleafFileTreeWithHashes,
  manifest: SyncManifest | null,
  operation: 'push' | 'pull' | 'sync' = 'push'
): {
  operation: string;
  changes: PushChanges;
  summary: string;
} {
  const changes = detectPushChanges(currentFiles, manifest);

  const summary = [
    `${operation.toUpperCase()} operation:`,
    `  Added: ${changes.added.length}`,
    `  Modified: ${changes.modified.length}`,
    `  Deleted: ${changes.deleted.length}`,
  ].join('\n');

  return {
    operation,
    changes,
    summary,
  };
}
