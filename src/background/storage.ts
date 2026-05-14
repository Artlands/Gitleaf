/**
 * Typed wrapper for chrome.storage
 * - Local: sensitive data (GitHub token, manifests, link configs)
 * - Sync: user settings (defaults, autosync interval, ignore patterns)
 */

import { SyncManifest, LinkConfig, GitHubToken } from '@shared/types';

const STORAGE_KEYS = {
  GITHUB_TOKEN: 'github_token',
  SYNC_MANIFESTS: 'sync_manifests', // Record<projectId, SyncManifest>
  LINK_CONFIGS: 'link_configs', // Record<projectId, LinkConfig>
  DEFAULT_BRANCH: 'default_branch',
  AUTOSYNC_INTERVAL: 'autosync_interval_minutes',
  IGNORE_PATTERNS: 'ignore_patterns',
};

/**
 * Get GitHub OAuth token
 */
export async function getGitHubToken(): Promise<GitHubToken | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.GITHUB_TOKEN);
  return result[STORAGE_KEYS.GITHUB_TOKEN] || null;
}

/**
 * Store GitHub OAuth token
 */
export async function setGitHubToken(token: GitHubToken): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.GITHUB_TOKEN]: token,
  });
}

/**
 * Clear GitHub OAuth token
 */
export async function clearGitHubToken(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.GITHUB_TOKEN);
}

/**
 * Get all sync manifests
 */
export async function getSyncManifests(): Promise<Record<string, SyncManifest>> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SYNC_MANIFESTS);
  return result[STORAGE_KEYS.SYNC_MANIFESTS] || {};
}

/**
 * Get sync manifest for a specific project
 */
export async function getSyncManifest(projectId: string): Promise<SyncManifest | null> {
  const manifests = await getSyncManifests();
  return manifests[projectId] || null;
}

/**
 * Store sync manifest
 */
export async function setSyncManifest(manifest: SyncManifest): Promise<void> {
  const manifests = await getSyncManifests();
  manifests[manifest.overleafProjectId] = manifest;
  await chrome.storage.local.set({
    [STORAGE_KEYS.SYNC_MANIFESTS]: manifests,
  });
}

/**
 * Get all link configs
 */
export async function getLinkConfigs(): Promise<Record<string, LinkConfig>> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LINK_CONFIGS);
  return result[STORAGE_KEYS.LINK_CONFIGS] || {};
}

/**
 * Get link config for a specific project
 */
export async function getLinkConfig(projectId: string): Promise<LinkConfig | null> {
  const configs = await getLinkConfigs();
  return configs[projectId] || null;
}

/**
 * Store link config
 */
export async function setLinkConfig(config: LinkConfig): Promise<void> {
  const configs = await getLinkConfigs();
  configs[config.overleafProjectId] = config;
  await chrome.storage.local.set({
    [STORAGE_KEYS.LINK_CONFIGS]: configs,
  });
}

/**
 * Remove link config (unlinking)
 */
export async function removeLinkConfig(projectId: string): Promise<void> {
  const configs = await getLinkConfigs();
  delete configs[projectId];
  await chrome.storage.local.set({
    [STORAGE_KEYS.LINK_CONFIGS]: configs,
  });
}

/**
 * Get default GitHub branch setting (from sync storage)
 */
export async function getDefaultBranch(): Promise<string> {
  const result = await chrome.storage.sync.get(STORAGE_KEYS.DEFAULT_BRANCH);
  return result[STORAGE_KEYS.DEFAULT_BRANCH] || 'main';
}

/**
 * Set default GitHub branch
 */
export async function setDefaultBranch(branch: string): Promise<void> {
  await chrome.storage.sync.set({
    [STORAGE_KEYS.DEFAULT_BRANCH]: branch,
  });
}

/**
 * Get autosync interval in minutes
 */
export async function getAutoSyncInterval(): Promise<number> {
  const result = await chrome.storage.sync.get(STORAGE_KEYS.AUTOSYNC_INTERVAL);
  return result[STORAGE_KEYS.AUTOSYNC_INTERVAL] || 10;
}

/**
 * Set autosync interval
 */
export async function setAutoSyncInterval(minutes: number): Promise<void> {
  await chrome.storage.sync.set({
    [STORAGE_KEYS.AUTOSYNC_INTERVAL]: minutes,
  });
}

/**
 * Get ignore patterns (gitignore-style, newline-separated)
 */
export async function getIgnorePatterns(): Promise<string[]> {
  const result = await chrome.storage.sync.get(STORAGE_KEYS.IGNORE_PATTERNS);
  const patterns = (result[STORAGE_KEYS.IGNORE_PATTERNS] || '') as string;
  // Default patterns
  const defaults = ['*.aux', '*.log', '*.synctex.gz', '.vscode/'];
  const custom = patterns
    .split('\n')
    .map((p: string) => p.trim())
    .filter(Boolean);
  return [...new Set([...defaults, ...custom])];
}

/**
 * Set ignore patterns
 */
export async function setIgnorePatterns(patterns: string[]): Promise<void> {
  await chrome.storage.sync.set({
    [STORAGE_KEYS.IGNORE_PATTERNS]: patterns.join('\n'),
  });
}

/**
 * Clear all stored data (for debugging/reset)
 */
export async function clearAllStorage(): Promise<void> {
  await chrome.storage.local.clear();
  await chrome.storage.sync.clear();
}
