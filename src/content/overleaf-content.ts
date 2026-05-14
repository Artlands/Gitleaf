/**
 * Content script for Overleaf pages
 * Extracts project ID, name, and CSRF token
 */

import { ContentScriptMessage } from '@shared/types';

/**
 * Extract project ID from URL pattern: /project/:id
 */
function extractProjectId(): string | null {
  const match = window.location.pathname.match(/\/project\/([a-f0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Extract project name from the page title or HTML
 */
function extractProjectName(): string {
  // Try to get from document title (usually "Project Name - Overleaf")
  const title = document.title;
  const match = title.match(/^(.+?)\s*-\s*Overleaf/);
  if (match) {
    return match[1];
  }
  return 'Untitled Project';
}

function extractCSRFToken(): string | null {
  const metaSelectors = [
    'meta[name="csrf-token"]',
    'meta[name="csrfToken"]',
    'meta[name="ol-csrfToken"]',
    'meta[name="ol-csrf-token"]',
  ];

  for (const selector of metaSelectors) {
    const meta = document.querySelector(selector);
    if (meta instanceof HTMLMetaElement && meta.content) {
      return meta.content;
    }
  }

  const input = document.querySelector('input[name="_csrf"], input[name="csrfToken"]');
  if (input instanceof HTMLInputElement && input.value) {
    return input.value;
  }

  const scripts = Array.from(document.scripts)
    .map((script) => script.textContent || '')
    .join('\n');
  const match = scripts.match(
    /(?:csrfToken|csrf_token|_csrf|ol-csrfToken)["']?\s*[:=]\s*["']([^"']+)["']/i
  );
  if (match) {
    return match[1];
  }

  return null;
}

function extractMetaContent(name: string): string | null {
  const meta = document.querySelector(`meta[name="${name}"]`);
  return meta instanceof HTMLMetaElement && meta.content ? meta.content : null;
}

function rootFolderValue(project: { rootFolder?: unknown[] | unknown } | undefined): unknown | undefined {
  const record = project as Record<string, unknown> | undefined;
  const rootFolder = record?.rootFolder || record?.root_folder || record?.rootFolderId || record?.root_folder_id;
  return Array.isArray(rootFolder) ? rootFolder[0] : rootFolder;
}

function idValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$oid === 'string') {
      return record.$oid;
    }
    for (const key of ['_id', 'id', 'entity_id', 'folder_id', 'folderId']) {
      const id = idValue(record[key]);
      if (id) {
        return id;
      }
    }
  }
  return undefined;
}

function folderIdValue(value: unknown): string | undefined {
  const direct = idValue(value);
  if (direct) {
    return direct;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = folderIdValue(item);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['folder', 'entity']) {
      const nested = folderIdValue(record[key]);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function rootFolderIdFromProject(project: Record<string, unknown> | undefined): string | undefined {
  if (!project) {
    return undefined;
  }

  for (const key of ['rootFolderId', 'root_folder_id', 'rootFolder_id', 'rootFolderID', 'rootFolder', 'root_folder']) {
    const value = project[key];
    const id = folderIdValue(Array.isArray(value) ? value[0] : value);
    if (id) {
      return id;
    }
  }

  return undefined;
}

function rootFolderFromProject(project: Record<string, unknown> | undefined): unknown | undefined {
  const rootFolder = rootFolderValue(project);
  const rootFolderId = rootFolderIdFromProject(project);

  if (
    rootFolderId &&
    rootFolder &&
    typeof rootFolder === 'object' &&
    !Array.isArray(rootFolder) &&
    !('_id' in rootFolder) &&
    !('id' in rootFolder)
  ) {
    return { ...rootFolder, _id: rootFolderId };
  }

  return rootFolder;
}

async function fetchProjectRootFolderViaJoin(
  projectId: string,
  csrfToken: string,
  userId: string | null
): Promise<unknown | undefined> {
  if (!csrfToken) {
    return undefined;
  }

  const response = await fetch(`/project/${projectId}/join`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      ...(userId ? { userId } : {}),
      _csrf: csrfToken,
    }),
  });

  if (!response.ok) {
    return undefined;
  }

  const data = (await response.json()) as { project?: Record<string, unknown> & { rootFolder?: unknown[] | unknown } };
  return rootFolderFromProject(data.project);
}

function parseSocketEvent(line: string): Record<string, unknown> | null {
  if (!line.startsWith('5:')) {
    return null;
  }

  try {
    return JSON.parse(line.slice(2).replace(/^:+/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fetchProjectRootFolderViaSocket(projectId: string): Promise<unknown | undefined> {
  const response = await fetch(`/socket.io/1/?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    return undefined;
  }

  const handshake = await response.text();
  const socketId = handshake.split(':')[0];
  if (!socketId) {
    return undefined;
  }

  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(
      `wss://www.overleaf.com/socket.io/1/websocket/${socketId}?projectId=${encodeURIComponent(projectId)}`
    );

    function finish(rootFolder: unknown | undefined) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      if (socket.readyState <= WebSocket.OPEN) {
        socket.close();
      }
      resolve(rootFolder);
    }

    const timeoutId = setTimeout(() => finish(undefined), 15000);

    socket.onopen = () => {
      socket.send(
        `5:::${JSON.stringify({
          name: 'joinProject',
          args: [projectId],
        })}`
      );
    };

    socket.onmessage = (event) => {
      const data = parseSocketEvent(String(event.data));
      if (data?.name !== 'joinProjectResponse') {
        return;
      }

      const args = Array.isArray(data.args) ? data.args : [];
      const payload = args[0] as { project?: Record<string, unknown> } | undefined;
      finish(rootFolderFromProject(payload?.project));
    };

    socket.onerror = () => finish(undefined);
  });
}

async function fetchProjectRootFolder(): Promise<unknown | undefined> {
  const projectId = extractProjectId();
  const csrfToken = extractCSRFToken();
  const userId = extractMetaContent('ol-user_id');

  if (!projectId) {
    return undefined;
  }

  return (
    (await fetchProjectRootFolderViaJoin(projectId, csrfToken || '', userId)) ||
    (await fetchProjectRootFolderViaSocket(projectId))
  );
}

/**
 * Send project metadata to service worker
 */
function sendProjectMeta(): void {
  const projectId = extractProjectId();
  const projectName = extractProjectName();
  const csrfToken = extractCSRFToken();
  const userId = extractMetaContent('ol-user_id') || undefined;

  if (!projectId) {
    return;
  }

  // Kick off a rootFolder fetch in parallel — when it resolves, send an
  // updated PROJECT_META so the service worker has a fresh tree even if the
  // user never opens the popup before pulling.
  const send = (rootFolder?: unknown) => {
    const message: ContentScriptMessage = {
      type: 'PROJECT_META',
      projectId,
      projectName,
      csrfToken: csrfToken || '',
      userId,
      rootFolder,
    };

    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) {
        console.error('[Gitleaf] Failed to send project meta:', chrome.runtime.lastError);
      } else {
        console.log('[Gitleaf] Project meta sent:', projectId, rootFolder ? '(with tree)' : '');
      }
    });
  };

  // Send what we have immediately so other flows aren't blocked, then send
  // again once we have the rootFolder.
  send();
  fetchProjectRootFolder()
    .then((rootFolder) => {
      if (rootFolder) {
        send(rootFolder);
      }
    })
    .catch((error) => {
      console.warn('[Gitleaf] Could not fetch initial Overleaf project tree:', error);
    });
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || (message as { type?: string }).type !== 'GET_PROJECT_META') {
    return;
  }

  fetchProjectRootFolder()
    .then((rootFolder) => {
      sendResponse({
        projectId: extractProjectId(),
        projectName: extractProjectName(),
        csrfToken: extractCSRFToken() || '',
        userId: extractMetaContent('ol-user_id') || undefined,
        rootFolder,
      });
    })
    .catch(() => {
      sendResponse({
        projectId: extractProjectId(),
        projectName: extractProjectName(),
        csrfToken: extractCSRFToken() || '',
        userId: extractMetaContent('ol-user_id') || undefined,
      });
    });
  return true;
});

// Send metadata when the content script loads
sendProjectMeta();

// Re-send if the page changes (e.g., user navigates between projects in same tab)
let lastProjectId = extractProjectId();
const observer = new MutationObserver(() => {
  const currentProjectId = extractProjectId();
  if (currentProjectId && currentProjectId !== lastProjectId) {
    lastProjectId = currentProjectId;
    sendProjectMeta();
  }
});

observer.observe(document.head, { childList: true, subtree: true });
