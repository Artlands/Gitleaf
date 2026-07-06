/**
 * Overleaf API client
 * Uses publicly available REST endpoints (same as Overleaf web UI)
 */

import { unzip } from 'fflate';
import { computeSHA1 } from '@shared/hash';

const OVERLEAF_BASE = 'https://www.overleaf.com';

export interface OverleafProjectMeta {
  id: string;
  name: string;
  csrfToken: string;
}

export interface OverleafFileTree {
  [path: string]: Uint8Array;
}

export interface OverleafFileTreeWithHashes {
  [path: string]: {
    content: Uint8Array;
    hash: string;
  };
}

export interface OverleafEntity {
  path: string;
  id: string;
  type: 'doc' | 'file' | 'folder';
}

export interface OverleafProjectTree {
  rootFolderId?: string;
  entities: Record<string, OverleafEntity>;
}

export interface ApplyProjectFilesResult {
  added: string[];
  modified: string[];
  deleted: string[];
}

type RefreshProjectTreeFn = (options?: { force?: boolean }) => Promise<OverleafProjectTree>;

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) || path;
}

function dirname(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function entityId(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.$oid === 'string') {
    return record.$oid;
  }
  const id = record._id || record.id || record.entity_id || record.folder_id || record.folderId;
  if (typeof id === 'string') {
    return id;
  }
  if (id && typeof id === 'object') {
    const objectId = (id as Record<string, unknown>).$oid;
    if (typeof objectId === 'string') {
      return objectId;
    }
  }
  return null;
}

function findEntityIdDeep(value: unknown): string | null {
  const direct = entityId(value);
  if (direct) {
    return direct;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findEntityIdDeep(item);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['folder', 'entity', 'file', 'doc', 'linkedFileData']) {
    const nested = findEntityIdDeep(record[key]);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function folderEntityId(value: unknown): string | null {
  const direct = entityId(value);
  if (direct) {
    return direct;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = folderEntityId(item);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['folder', 'entity']) {
    const nested = folderEntityId(record[key]);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function findCreatedEntityId(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.entity_id === 'string') {
    return record.entity_id;
  }

  for (const key of ['doc', 'entity', 'file', 'folder']) {
    const id = entityId(record[key]);
    if (id) {
      return id;
    }
  }

  return entityId(record);
}

function entityName(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = record.name || record.path || record.pathname;
  if (typeof name === 'string') {
    return name;
  }

  for (const key of ['folder', 'entity', 'file', 'doc', 'linkedFileData']) {
    const nested = entityName(record[key]);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function rootFolderValue(project: Record<string, unknown> | undefined): unknown {
  const rootFolder = project?.rootFolder || project?.root_folder || project?.rootFolderId || project?.root_folder_id;
  return Array.isArray(rootFolder) ? rootFolder[0] : rootFolder;
}

function rootFolderIdFromProject(project: Record<string, unknown> | undefined, rootFolder: unknown): string | null {
  if (!project) {
    return entityId(rootFolder);
  }

  for (const key of ['rootFolderId', 'root_folder_id', 'rootFolder_id', 'rootFolderID', 'rootFolder', 'root_folder']) {
    const value = project[key];
    const id = folderEntityId(Array.isArray(value) ? value[0] : value);
    if (id) {
      return id;
    }
  }

  return folderEntityId(rootFolder);
}

function projectPayload(value: Record<string, unknown>): Record<string, unknown> {
  return value.project && typeof value.project === 'object'
    ? (value.project as Record<string, unknown>)
    : value;
}

function treeFromProjectPayload(value: Record<string, unknown>): OverleafProjectTree {
  const project = projectPayload(value);
  const root = rootFolderValue(project) || rootFolderValue(value) || project.rootDoc || value.rootDoc || project;
  const tree: OverleafProjectTree = { entities: {} };
  walkOverleafTree(root, '', tree);
  tree.rootFolderId =
    tree.rootFolderId ||
    rootFolderIdFromProject(project, root) ||
    rootFolderIdFromProject(value, root) ||
    undefined;
  return tree;
}

function extractCSRFTokenFromHtml(html: string): string {
  const patterns = [
    /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i,
    /<meta[^>]+name=["']csrfToken["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrfToken["']/i,
    /<meta[^>]+name=["']ol-csrfToken["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']ol-csrfToken["']/i,
    /<input[^>]+name=["']_csrf["'][^>]+value=["']([^"']+)["']/i,
    /<input[^>]+value=["']([^"']+)["'][^>]+name=["']_csrf["']/i,
    /(?:csrfToken|csrf_token|_csrf|ol-csrfToken)["']?\s*[:=]\s*["']([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return '';
}

function walkOverleafTree(node: unknown, currentPath: string, tree: OverleafProjectTree): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walkOverleafTree(child, currentPath, tree);
    }
    return;
  }

  if (!node || typeof node !== 'object') {
    return;
  }

  const record = node as Record<string, unknown>;
  const folders = Array.isArray(record.folders) ? record.folders : [];
  const docs = Array.isArray(record.docs) ? record.docs : [];
  const fileRefs = Array.isArray(record.fileRefs) ? record.fileRefs : [];
  const files = Array.isArray(record.files) ? record.files : fileRefs;

  const folderId = currentPath ? null : folderEntityId(record);
  if (!tree.rootFolderId && folderId) {
    tree.rootFolderId = folderId;
  }

  for (const doc of docs) {
    const name = entityName(doc);
    const id = findEntityIdDeep(doc);
    if (name && id) {
      const path = [currentPath, name].filter(Boolean).join('/');
      tree.entities[path] = { path, id, type: 'doc' };
    }
  }

  for (const file of files) {
    const name = entityName(file);
    const id = findEntityIdDeep(file);
    if (name && id) {
      const path = [currentPath, name].filter(Boolean).join('/');
      tree.entities[path] = { path, id, type: 'file' };
    }
  }

  for (const folder of folders) {
    const name = entityName(folder);
    const id = findEntityIdDeep(folder);
    if (!name) {
      continue;
    }
    const path = [currentPath, name].filter(Boolean).join('/');
    if (id) {
      tree.entities[path] = { path, id, type: 'folder' };
    }
    walkOverleafTree(folder, path, tree);
  }
}

function treeFromRootFolder(rootFolder: unknown): OverleafProjectTree {
  const tree: OverleafProjectTree = { entities: {} };
  walkOverleafTree(rootFolder, '', tree);
  if (!tree.rootFolderId && rootFolder && typeof rootFolder === 'object') {
    const record = rootFolder as Record<string, unknown>;
    tree.rootFolderId = rootFolderIdFromProject(record.project as Record<string, unknown> | undefined, rootFolder) || undefined;
  }
  return tree;
}

function errorMessageFromResponse(response: Response, fallback: string): string {
  return response.statusText || `${fallback} (HTTP ${response.status})`;
}

function fetchProjectTreeViaSocket(projectId: string): Promise<OverleafProjectTree> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: WebSocket | null = null;
    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error('Timed out while fetching Overleaf project tree.')));
    }, 15000);

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      if (socket && socket.readyState <= WebSocket.OPEN) {
        socket.close();
      }
      callback();
    };

    fetch(`${OVERLEAF_BASE}/socket.io/1/?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`, {
      method: 'GET',
      credentials: 'include',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(errorMessageFromResponse(response, 'Failed to open Overleaf socket'));
        }

        const handshake = await response.text();
        const socketId = handshake.split(':')[0];
        if (!socketId) {
          throw new Error('Overleaf socket handshake did not return a socket id.');
        }

        socket = new WebSocket(
          `wss://www.overleaf.com/socket.io/1/websocket/${socketId}?projectId=${encodeURIComponent(projectId)}`
        );

        socket.onmessage = (event) => {
          const line = String(event.data);
          if (line.startsWith('7:')) {
            finish(() => reject(new Error('Overleaf rejected the project tree socket connection.')));
            return;
          }
          if (!line.startsWith('5:')) {
            return;
          }

          try {
            const data = JSON.parse(line.slice(2).replace(/^:+/, '')) as Record<string, unknown>;
            if (data.name !== 'joinProjectResponse') {
              return;
            }

            const args = Array.isArray(data.args) ? data.args : [];
            const payload = args[0] as Record<string, unknown> | undefined;
            if (!payload) {
              return;
            }
            const tree = treeFromProjectPayload(payload);
            finish(() => resolve(tree));
          } catch (error) {
            finish(() =>
              reject(error instanceof Error ? error : new Error('Failed to parse Overleaf project tree.'))
            );
          }
        };

        socket.onerror = () => {
          finish(() => reject(new Error('Failed to read Overleaf project tree socket.')));
        };

        socket.onopen = () => {
          socket?.send(
            `5:::${JSON.stringify({
              name: 'joinProject',
              args: [projectId],
            })}`
          );
        };
      })
      .catch((error) => {
        finish(() => reject(error instanceof Error ? error : new Error('Failed to fetch Overleaf project tree.')));
      });
  });
}

async function fetchProjectTreeViaJoin(
  projectId: string,
  userId: string | undefined,
  csrfToken: string
): Promise<OverleafProjectTree> {
  const response = await fetch(`${OVERLEAF_BASE}/project/${projectId}/join`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/json',
      Referer: `${OVERLEAF_BASE}/project/${projectId}`,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      ...(userId ? { userId } : {}),
      _csrf: csrfToken,
    }),
  });

  if (!response.ok) {
    throw new Error(errorMessageFromResponse(response, 'Failed to join Overleaf project'));
  }

  const data = (await response.json()) as Record<string, unknown>;
  return treeFromProjectPayload(data);
}

async function fetchProjectTreeViaEntities(projectId: string): Promise<OverleafProjectTree> {
  const response = await fetch(`${OVERLEAF_BASE}/project/${projectId}/entities`, {
    method: 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      Referer: `${OVERLEAF_BASE}/project/${projectId}`,
    },
  });

  if (!response.ok) {
    throw new Error(errorMessageFromResponse(response, 'Failed to fetch Overleaf project entities'));
  }

  const data = (await response.json()) as Record<string, unknown>;
  return treeFromProjectPayload(data);
}

function extractProjectTreeFromHtml(html: string): OverleafProjectTree {
  const tree: OverleafProjectTree = { entities: {} };
  const candidates = [
    /window\.__INITIAL_DATA__\s*=\s*({.*?});\s*<\/script>/s,
    /window\._ideData\s*=\s*({.*?});\s*<\/script>/s,
    /window\.project\s*=\s*({.*?});\s*<\/script>/s,
  ];

  for (const candidate of candidates) {
    const match = html.match(candidate);
    if (!match) {
      continue;
    }

    try {
      const data = JSON.parse(match[1]) as Record<string, unknown>;
      const parsedTree = treeFromProjectPayload(data);
      Object.assign(tree.entities, parsedTree.entities);
      tree.rootFolderId = parsedTree.rootFolderId || tree.rootFolderId;
      if (Object.keys(parsedTree.entities).length > 0 || parsedTree.rootFolderId) {
        return parsedTree;
      }
    } catch {
      // Try the next embedded data shape.
    }
  }

  return tree;
}

async function fetchProjectTree(
  projectId: string,
  userId?: string,
  csrfToken = '',
  rootFolder?: unknown,
  options: { skipCachedRootFolder?: boolean } = {}
): Promise<OverleafProjectTree> {
  if (rootFolder && !options.skipCachedRootFolder) {
    const tree = treeFromRootFolder(rootFolder);
    if (tree.rootFolderId || Object.keys(tree.entities).length > 0) {
      return tree;
    }
  }

  if (csrfToken) {
    try {
      const tree = await fetchProjectTreeViaJoin(projectId, userId, csrfToken);
      if (tree.rootFolderId || Object.keys(tree.entities).length > 0) {
        return tree;
      }
    } catch (error) {
      console.warn('[Gitleaf] Falling back from Overleaf join project tree extraction:', error);
    }
  }

  try {
    const tree = await fetchProjectTreeViaEntities(projectId);
    if (tree.rootFolderId || Object.keys(tree.entities).length > 0) {
      return tree;
    }
  } catch (error) {
    console.warn('[Gitleaf] Falling back from Overleaf entities project tree extraction:', error);
  }

  try {
    const tree = await fetchProjectTreeViaSocket(projectId);
    if (tree.rootFolderId || Object.keys(tree.entities).length > 0) {
      return tree;
    }
  } catch (error) {
    console.warn('[Gitleaf] Falling back to HTML project tree extraction:', error);
  }

  const response = await fetch(`${OVERLEAF_BASE}/project/${projectId}`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(errorMessageFromResponse(response, 'Failed to fetch Overleaf project tree'));
  }

  return extractProjectTreeFromHtml(await response.text());
}

/**
 * Force-refresh the project tree from live Overleaf endpoints, bypassing any
 * cached `rootFolder` snapshot from the content script. Used whenever the
 * cached tree may be stale (e.g., when ensureFolderPath/findEntityByPath
 * couldn't find an entity that the user can see in the Overleaf UI).
 */
async function refreshProjectTree(
  projectId: string,
  userId?: string,
  csrfToken = ''
): Promise<OverleafProjectTree> {
  return fetchProjectTree(projectId, userId, csrfToken, undefined, {
    skipCachedRootFolder: true,
  });
}

async function createFolder(
  projectId: string,
  name: string,
  parentFolderId: string | undefined,
  csrfToken: string
): Promise<string | null> {
  const response = await fetch(`${OVERLEAF_BASE}/project/${projectId}/folder`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/json',
      Referer: `${OVERLEAF_BASE}/project/${projectId}`,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      name,
      parent_folder_id: parentFolderId,
      parentFolderId,
      _csrf: csrfToken,
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(
      `${errorMessageFromResponse(response, `Failed to create Overleaf folder "${name}"`)}${
        details ? `: ${details}` : ''
      }`
    );
  }

  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return findCreatedEntityId(data);
}

async function ensureFolderPath(
  projectId: string,
  folderPath: string,
  tree: OverleafProjectTree,
  csrfToken: string,
  userId?: string,
  _rootFolder?: unknown,
  refreshTree: RefreshProjectTreeFn = () => refreshProjectTree(projectId, userId, csrfToken)
): Promise<string | undefined> {
  if (!folderPath) {
    return tree.rootFolderId;
  }

  let parentId = tree.rootFolderId;
  const parts = folderPath.split('/').filter(Boolean);
  let currentPath = '';
  let didLiveRefresh = false;

  const mergeRefreshedTree = (refreshed: OverleafProjectTree) => {
    Object.assign(tree.entities, refreshed.entities);
    tree.rootFolderId = refreshed.rootFolderId || tree.rootFolderId;
  };
  const refreshAndFindCurrent = async (): Promise<OverleafEntity | undefined> => {
    const refreshedTree = await refreshTree({ force: true });
    mergeRefreshedTree(refreshedTree);
    return tree.entities[currentPath];
  };

  for (const part of parts) {
    currentPath = [currentPath, part].filter(Boolean).join('/');
    let existing = tree.entities[currentPath];

    // If we haven't found the folder in the (possibly stale) cached tree,
    // refresh once from a live Overleaf endpoint before trying to create it.
    // This handles the case where the user added the folder in Overleaf
    // after the cached rootFolder snapshot was taken.
    if (!existing && !didLiveRefresh) {
      didLiveRefresh = true;
      try {
        const refreshedTree = await refreshTree();
        if (refreshedTree.rootFolderId || Object.keys(refreshedTree.entities).length > 0) {
          mergeRefreshedTree(refreshedTree);
          if (!parentId) {
            parentId = tree.rootFolderId;
          }
          existing = tree.entities[currentPath];
        }
      } catch (error) {
        console.warn(`[Gitleaf] Failed to refresh Overleaf project tree while resolving "${currentPath}":`, error);
      }
    }

    if (existing?.type === 'folder') {
      parentId = existing.id;
      continue;
    }

    let newId: string | null = null;
    try {
      newId = await createFolder(projectId, part, parentId, csrfToken);
    } catch (error) {
      // The folder may already exist on the server — refresh from a live
      // endpoint (bypassing the cached rootFolder) and look again.
      try {
        const refreshedTree = await refreshTree({ force: true });
        mergeRefreshedTree(refreshedTree);
        const refreshed = tree.entities[currentPath];
        if (refreshed?.type === 'folder') {
          parentId = refreshed.id;
          continue;
        }
      } catch (refreshError) {
        console.warn(
          `[Gitleaf] Failed to refresh Overleaf project tree after createFolder error for "${currentPath}":`,
          refreshError
        );
      }
      console.warn(`[Gitleaf] Could not create or locate Overleaf folder "${currentPath}":`, error);
      return undefined;
    }
    if (newId) {
      tree.entities[currentPath] = { path: currentPath, id: newId, type: 'folder' };
      parentId = newId;
      continue;
    }

    try {
      const refreshed = await refreshAndFindCurrent();
      if (refreshed?.type === 'folder') {
        parentId = refreshed.id;
        continue;
      }
    } catch (refreshError) {
      console.warn(
        `[Gitleaf] Failed to refresh Overleaf project tree after creating "${currentPath}" without an id:`,
        refreshError
      );
    }

    console.warn(`[Gitleaf] Created Overleaf folder "${currentPath}", but could not resolve its id.`);
    return undefined;
  }

  return parentId;
}

async function findEntityByPath(
  projectId: string,
  path: string,
  tree: OverleafProjectTree,
  userId: string | undefined,
  csrfToken: string,
  _rootFolder?: unknown,
  refreshTree: RefreshProjectTreeFn = () => refreshProjectTree(projectId, userId, csrfToken)
): Promise<OverleafEntity | undefined> {
  const existing = tree.entities[path];
  if (existing) {
    return existing;
  }

  // The cached rootFolder from the content script may be stale (e.g., the
  // user added files in Overleaf since the page loaded). Fetch a fresh tree
  // from the live Overleaf endpoints rather than re-using the cached one.
  let refreshedTree: OverleafProjectTree;
  try {
    refreshedTree = await refreshTree();
  } catch (error) {
    console.warn(`[Gitleaf] Failed to refresh Overleaf project tree while resolving "${path}":`, error);
    return undefined;
  }
  Object.assign(tree.entities, refreshedTree.entities);
  tree.rootFolderId = refreshedTree.rootFolderId || tree.rootFolderId;
  return tree.entities[path];
}

async function uploadFile(
  projectId: string,
  path: string,
  content: Uint8Array,
  parentFolderId: string | undefined,
  csrfToken: string,
  rootFolderId?: string,
  options: {
    resolveFreshParentFolderId?: () => Promise<string | undefined>;
    resolveFreshRootFolderId?: () => Promise<string | undefined>;
  } = {}
): Promise<void> {
  const performUpload = async (
    folderId: string | undefined,
    useRelativePath: boolean
  ): Promise<Response> => {
    const formData = new FormData();
    formData.append('relativePath', useRelativePath ? path : 'null');
    formData.append('name', basename(path));
    formData.append('type', 'application/octet-stream');
    formData.append('qqfile', new Blob([new Uint8Array(content)]), basename(path));

    const uploadUrl = folderId
      ? `${OVERLEAF_BASE}/project/${projectId}/upload?folder_id=${encodeURIComponent(folderId)}`
      : `${OVERLEAF_BASE}/project/${projectId}/upload`;
    return fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        Referer: `${OVERLEAF_BASE}/project/${projectId}`,
        'X-CSRF-Token': csrfToken,
      },
      body: formData,
    });
  };

  let primaryFolderId = parentFolderId || rootFolderId;
  if (!primaryFolderId) {
    primaryFolderId = await options.resolveFreshRootFolderId?.().catch((error) => {
      console.warn(`[Gitleaf] Failed to resolve Overleaf root folder before uploading "${path}":`, error);
      return undefined;
    });
  }
  let response = await performUpload(primaryFolderId, !parentFolderId);

  // Overleaf returns 404 when the supplied folder_id no longer exists on the
  // server, or when a root upload was attempted without a folder_id. First
  // refresh and retry the canonical upload shape against the newly resolved
  // parent/root folder. Only then fall back to root + relativePath.
  if (response.status === 404) {
    const freshParentFolderId = await options.resolveFreshParentFolderId?.().catch((error) => {
      console.warn(`[Gitleaf] Failed to refresh Overleaf folder before retrying "${path}":`, error);
      return undefined;
    });
    if (freshParentFolderId && freshParentFolderId !== primaryFolderId) {
      response = await performUpload(freshParentFolderId, false);
    }
    if (response.status === 404) {
      const freshRootFolderId = (await options.resolveFreshRootFolderId?.().catch((error) => {
        console.warn(`[Gitleaf] Failed to refresh Overleaf root folder before retrying "${path}":`, error);
        return undefined;
      })) || rootFolderId;
      if (freshRootFolderId && freshRootFolderId !== freshParentFolderId) {
        response = await performUpload(freshRootFolderId, true);
      }
    }
  }

  if (!response.ok && !primaryFolderId) {
    throw new Error(`Could not resolve Overleaf root folder for "${path}". Refresh the Overleaf tab and try again.`);
  }

  if (!response.ok) {
    const target = primaryFolderId ? `folder_id=${primaryFolderId}` : 'no folder_id';
    throw new Error(
      `${errorMessageFromResponse(response, `Failed to upload Overleaf file "${path}"`)} (${target})`
    );
  }
}

async function deleteEntity(
  projectId: string,
  entity: OverleafEntity,
  csrfToken: string
): Promise<void> {
  if (entity.type === 'folder') {
    return;
  }

  const response = await fetch(`${OVERLEAF_BASE}/project/${projectId}/${entity.type}/${entity.id}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: {
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({ _csrf: csrfToken }),
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(errorMessageFromResponse(response, `Failed to delete Overleaf ${entity.type} "${entity.path}"`));
  }
}

/**
 * Download a project as a zip file
 * @param projectId - Overleaf project ID
 * @returns Uint8Array of the zip file
 */
export async function downloadProjectZip(projectId: string): Promise<Uint8Array> {
  const url = `${OVERLEAF_BASE}/project/${projectId}/download/zip`;

  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include', // Include session cookie
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Overleaf session expired. Please log in.');
    }
    if (response.status === 404) {
      throw new Error('Project not found. It may have been deleted or archived.');
    }
    throw new Error(`Failed to download project: ${response.statusText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Extract files from a zip buffer
 */
function extractZipFiles(zipBuffer: Uint8Array): Promise<OverleafFileTree> {
  return new Promise((resolve, reject) => {
    unzip(zipBuffer, (err, decompressed) => {
      if (err) {
        reject(new Error(`Failed to decompress zip: ${err.message}`));
        return;
      }

      const fileTree: OverleafFileTree = {};

      for (const [path, content] of Object.entries(decompressed)) {
        if (!path.endsWith('/') && content instanceof Uint8Array) {
          fileTree[path] = content;
        }
      }

      resolve(fileTree);
    });
  });
}

/**
 * Get all files from an Overleaf project with SHA-1 hashes
 */
export async function getProjectFiles(projectId: string): Promise<OverleafFileTreeWithHashes> {
  try {
    const zipBuffer = await downloadProjectZip(projectId);
    const fileTree = await extractZipFiles(zipBuffer);

    // Compute hashes
    const filesWithHashes: OverleafFileTreeWithHashes = {};
    for (const [path, content] of Object.entries(fileTree)) {
      const hash = await computeSHA1(content);
      filesWithHashes[path] = { content, hash };
    }

    return filesWithHashes;
  } catch (error) {
    console.error('[Gitleaf] Failed to get project files:', error);
    throw error;
  }
}

/**
 * Get project metadata (name, ID, CSRF token)
 * Called after content script provides info
 */
export async function getProjectMetadata(projectId: string): Promise<OverleafProjectMeta | null> {
  try {
    const response = await fetch(`${OVERLEAF_BASE}/project/${projectId}`, {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Overleaf session expired');
      }
      if (response.status === 404) {
        throw new Error('Project not found');
      }
      throw new Error(`Failed to fetch project metadata: ${response.statusText}`);
    }

    const html = await response.text();

    const csrfToken = extractCSRFTokenFromHtml(html);

    // Extract project name from title or data attribute
    const titleMatch = html.match(/<title>(.+?)\s*-\s*(?:Online LaTeX Editor\s+)?Overleaf<\/title>/i);
    const projectName = titleMatch ? titleMatch[1] : 'Untitled Project';

    return {
      id: projectId,
      name: projectName,
      csrfToken,
    };
  } catch (error) {
    console.error('[Gitleaf] Failed to get project metadata:', error);
    throw error;
  }
}

/**
 * Calculate total size of project files
 */
export function calculateProjectSize(files: OverleafFileTreeWithHashes): number {
  return Object.values(files).reduce((sum, file) => sum + file.content.length, 0);
}

/**
 * Filter files that are too large
 * GitHub has a 100 MB limit per blob
 */
export function filterLargeFiles(
  files: OverleafFileTreeWithHashes,
  maxSizeBytes = 100 * 1024 * 1024
): {
  valid: OverleafFileTreeWithHashes;
  skipped: string[];
} {
  const valid: OverleafFileTreeWithHashes = {};
  const skipped: string[] = [];

  for (const [path, file] of Object.entries(files)) {
    if (file.content.length > maxSizeBytes) {
      skipped.push(`${path} (${Math.round(file.content.length / 1024 / 1024)} MB)`);
    } else {
      valid[path] = file;
    }
  }

  return { valid, skipped };
}

export async function applyProjectFiles(
  projectId: string,
  csrfToken: string,
  userId: string | undefined,
  rootFolder: unknown,
  files: Record<string, { content: Uint8Array }>,
  deletedPaths: string[]
): Promise<ApplyProjectFilesResult> {
  if (!csrfToken) {
    const metadata = await getProjectMetadata(projectId);
    csrfToken = metadata?.csrfToken || '';
  }
  if (!csrfToken) {
    throw new Error('Missing Overleaf CSRF token. Refresh the Overleaf tab and try again.');
  }

  const tree = rootFolder ? treeFromRootFolder(rootFolder) : { entities: {} };
  const existingFiles: OverleafFileTreeWithHashes = await getProjectFiles(projectId).catch(() => ({}));
  const existingFolderPaths = new Set<string>();
  for (const path of Object.keys(existingFiles)) {
    let folderPath = dirname(path);
    while (folderPath) {
      existingFolderPaths.add(folderPath);
      folderPath = dirname(folderPath);
    }
  }
  const result: ApplyProjectFilesResult = {
    added: [],
    modified: [],
    deleted: [],
  };
  let liveTreeRefreshPromise: Promise<OverleafProjectTree> | null = null;

  const mergeRefreshedTree = (refreshedTree: OverleafProjectTree) => {
    Object.assign(tree.entities, refreshedTree.entities);
    tree.rootFolderId = refreshedTree.rootFolderId || tree.rootFolderId;
  };

  const replaceWithRefreshedTree = (refreshedTree: OverleafProjectTree) => {
    tree.entities = { ...refreshedTree.entities };
    tree.rootFolderId = refreshedTree.rootFolderId || tree.rootFolderId;
  };

  const refreshAndMergeTree: RefreshProjectTreeFn = async (options = {}) => {
    if (!liveTreeRefreshPromise || options.force) {
      liveTreeRefreshPromise = refreshProjectTree(projectId, userId, csrfToken);
    }
    try {
      const refreshedTree = await liveTreeRefreshPromise;
      if (options.force) {
        replaceWithRefreshedTree(refreshedTree);
      } else {
        mergeRefreshedTree(refreshedTree);
      }
      return refreshedTree;
    } catch (error) {
      liveTreeRefreshPromise = null;
      throw error;
    }
  };

  const refreshAndMergeTreeForUpload: RefreshProjectTreeFn = async (options = {}) => {
    if (liveTreeRefreshPromise && !options.force) {
      const refreshedTree = await liveTreeRefreshPromise;
      mergeRefreshedTree(refreshedTree);
      return refreshedTree;
    }

    const refreshedTree = await fetchProjectTree(projectId, userId, csrfToken, undefined, {
      skipCachedRootFolder: true,
    });
    if (options.force) {
      replaceWithRefreshedTree(refreshedTree);
    } else {
      mergeRefreshedTree(refreshedTree);
    }
    return refreshedTree;
  };

  const refreshAndMergeTreeForced: RefreshProjectTreeFn = async () => {
    const refreshedTree = await fetchProjectTree(projectId, userId, csrfToken, undefined, {
      skipCachedRootFolder: true,
    });
    mergeRefreshedTree(refreshedTree);
    return refreshedTree;
  };

  const resolveRootFolderId = async (): Promise<string | undefined> => {
    if (tree.rootFolderId) {
      return tree.rootFolderId;
    }
    try {
      await refreshAndMergeTreeForUpload({ force: true });
    } catch {
      // The caller will surface the upload error if the root cannot be resolved.
    }
    return tree.rootFolderId;
  };

  for (const path of deletedPaths) {
    const existing = tree.entities[path];
    if (!existing) {
      continue;
    }
    await deleteEntity(projectId, existing, csrfToken);
    delete tree.entities[path];
    result.deleted.push(path);
  }

  for (const [path, file] of Object.entries(files)) {
    const existing = await findEntityByPath(
      projectId,
      path,
      tree,
      userId,
      csrfToken,
      rootFolder,
      refreshAndMergeTreeForced
    );
    const existingFile = existingFiles[path];
    const pathExistsInZip = Boolean(existingFile);
    const folderPath = dirname(path);
    let useRootRelativePath = false;
    let parentFolderId = await ensureFolderPath(
      projectId,
      folderPath,
      tree,
      csrfToken,
      userId,
      rootFolder,
      refreshAndMergeTree
    );
    if (!folderPath && !parentFolderId) {
      parentFolderId = await resolveRootFolderId();
    }
    if (folderPath && !parentFolderId) {
      parentFolderId = await resolveRootFolderId();
      useRootRelativePath = true;
    }

    const resolveFreshParentFolderId = async () => {
      await refreshAndMergeTreeForUpload({ force: true });
      if (!folderPath) {
        return tree.rootFolderId;
      }
      return ensureFolderPath(projectId, folderPath, tree, csrfToken, userId, rootFolder, refreshAndMergeTree);
    };
    const resolveFreshRootFolderId = async () => {
      return resolveRootFolderId();
    };

    if (existing || pathExistsInZip) {
      if (existing) {
        await deleteEntity(projectId, existing, csrfToken);
      }
      await uploadFile(projectId, path, file.content, useRootRelativePath ? undefined : parentFolderId, csrfToken, tree.rootFolderId, {
        resolveFreshParentFolderId,
        resolveFreshRootFolderId,
      });
      result.modified.push(path);
      continue;
    }

    await uploadFile(projectId, path, file.content, useRootRelativePath ? undefined : parentFolderId, csrfToken, tree.rootFolderId, {
      resolveFreshParentFolderId,
      resolveFreshRootFolderId,
    });
    result.added.push(path);
  }

  return result;
}
