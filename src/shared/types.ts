/**
 * Shared types for Gitleaf extension
 */

export interface FileManifestEntry {
  ovHash: string; // SHA-1 of Overleaf content
  ghHash: string; // SHA-1 of GitHub content
  ghSha: string; // GitHub blob SHA (for PUT API)
}

export interface SyncManifest {
  overleafProjectId: string;
  github: {
    owner: string;
    repo: string;
    branch: string;
    subPath?: string; // e.g., "paper/" — Phase 2+
  };
  lastSync: string; // ISO 8601 timestamp
  files: Record<string, FileManifestEntry>;
}

export interface LinkConfig {
  overleafProjectId: string;
  overleafProjectName?: string;
  github: {
    owner: string;
    repo: string;
    branch: string;
    subPath?: string;
  };
  syncDirection: 'push' | 'pull' | 'sync'; // Phase 1: only 'push'
  autoSyncIntervalMinutes?: number;
  createdAt: string; // ISO 8601 timestamp
}

export interface GitHubToken {
  accessToken: string;
  scopes: string[];
  login?: string;
  expiresAt?: string; // ISO 8601 or undefined for classic tokens
}

export interface ProjectFileTree {
  [path: string]: {
    content: Uint8Array;
    hash: string; // SHA-1
  };
}

export interface SyncResult {
  success: boolean;
  changes?: {
    added: string[];
    modified: string[];
    deleted: string[];
  };
  conflict?: {
    files: string[];
  };
  error?: string;
}

export interface ContentScriptMessage {
  type: 'PROJECT_META';
  projectId: string;
  projectName: string;
  csrfToken: string;
  userId?: string;
  rootFolder?: unknown;
}

export interface PopupMessage {
  type:
    | 'GET_LINK_STATUS'
    | 'PUSH'
    | 'PULL'
    | 'SYNC'
    | 'LINK_GITHUB'
    | 'GET_GITHUB_REPOS'
    | 'SET_GITHUB_TOKEN'
    | 'GET_AUTH_STATUS';
  payload?: Record<string, unknown>;
}

export interface ServiceWorkerResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}
