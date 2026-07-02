import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { applyProjectFiles } from '../overleaf-client';

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rootFolder() {
  return {
    _id: 'root-folder-id',
    docs: [],
    fileRefs: [],
    folders: [],
  };
}

function rootFolderWithFigures() {
  return {
    ...rootFolder(),
    folders: [
      {
        _id: 'figures-folder-id',
        name: 'figures',
        docs: [],
        fileRefs: [],
        folders: [],
      },
    ],
  };
}

function rootFolderWithoutId() {
  return {
    docs: [],
    fileRefs: [
      {
        _id: 'main-file-id',
        name: 'main.pdf',
      },
    ],
    folders: [],
  };
}

function wrappedRootFolder() {
  return {
    folder: {
      _id: 'root-folder-id',
      name: 'rootFolder',
    },
    docs: [],
    fileRefs: [],
    folders: [],
  };
}

function wrappedRootFolderWithFigures() {
  return {
    ...wrappedRootFolder(),
    folders: [
      {
        folder: {
          _id: 'figures-folder-id',
          name: 'figures',
        },
        docs: [],
        fileRefs: [],
        folders: [],
      },
    ],
  };
}

function mockOverleafFetch(options: { folderResponse?: Response; joinRootFolders?: unknown[] } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let joinCount = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.includes('/download/zip')) {
      return new Response('zip unavailable in test', {
        status: 500,
        statusText: 'Server Error',
      });
    }

    if (url.endsWith('/join')) {
      const joinRootFolder = options.joinRootFolders?.[joinCount] || rootFolder();
      joinCount += 1;
      return jsonResponse({
        project: {
          rootFolder: [joinRootFolder],
        },
      });
    }

    if (url.endsWith('/folder')) {
      return (
        options.folderResponse ||
        new Response('cannot create folder in test', {
          status: 500,
          statusText: 'Server Error',
        })
      );
    }

    if (url.includes('/upload')) {
      return jsonResponse({ success: true });
    }

    return new Response('unexpected request', {
      status: 404,
      statusText: 'Not Found',
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

describe('Overleaf client', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uploads nested binary files into newly created Overleaf folders', async () => {
    const { calls } = mockOverleafFetch({
      folderResponse: jsonResponse({
        folder: {
          _id: 'figures-folder-id',
          name: 'figures',
        },
      }),
    });

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      rootFolder(),
      {
        'figures/figure1.pdf': { content: new Uint8Array([1, 2, 3]) },
      },
      []
    );

    expect(result.added).toEqual(['figures/figure1.pdf']);
    const folderCall = calls.find((call) => call.url.endsWith('/folder'));
    expect(folderCall).toBeDefined();
    expect(JSON.parse(String(folderCall?.init?.body))).toMatchObject({
      name: 'figures',
      parent_folder_id: 'root-folder-id',
      parentFolderId: 'root-folder-id',
    });

    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall).toBeDefined();
    expect(uploadCall?.url).toContain('folder_id=figures-folder-id');
    expect(uploadCall?.init?.body).toBeInstanceOf(FormData);

    const body = uploadCall?.init?.body as FormData;
    expect(body.get('relativePath')).toBe('null');
    expect(body.get('name')).toBe('figure1.pdf');
  });

  it('resolves the root folder id from wrapped Overleaf folder payloads', async () => {
    const { calls } = mockOverleafFetch({
      joinRootFolders: [wrappedRootFolder()],
    });

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      wrappedRootFolder(),
      {
        'main.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['main.tex']);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=root-folder-id');
  });

  it('resolves nested folders from wrapped Overleaf folder payloads', async () => {
    const { calls } = mockOverleafFetch({
      joinRootFolders: [wrappedRootFolderWithFigures()],
    });

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      wrappedRootFolderWithFigures(),
      {
        'figures/figure1.pdf': { content: new Uint8Array([1, 2, 3]) },
      },
      []
    );

    expect(result.added).toEqual(['figures/figure1.pdf']);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=figures-folder-id');
    const body = uploadCall?.init?.body as FormData;
    expect(body.get('relativePath')).toBe('null');
    expect(body.get('name')).toBe('figure1.pdf');
  });

  it('reuses a newly created folder for multiple files when live tree refresh is stale', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let folderCreated = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [rootFolder()],
          },
        });
      }

      if (url.endsWith('/folder')) {
        if (folderCreated) {
          return new Response('folder exists', { status: 409, statusText: 'Conflict' });
        }
        folderCreated = true;
        return jsonResponse({
          folder: {
            _id: 'figures-folder-id',
            name: 'figures',
          },
        });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      rootFolder(),
      {
        'figures/figure1.pdf': { content: new Uint8Array([1, 2, 3]) },
        'figures/figure2.pdf': { content: new Uint8Array([4, 5, 6]) },
      },
      []
    );

    expect(result.added).toEqual(['figures/figure1.pdf', 'figures/figure2.pdf']);
    const uploadCalls = calls.filter((call) => call.url.includes('/upload'));
    expect(uploadCalls.map((call) => call.url)).toEqual([
      'https://www.overleaf.com/project/project-id/upload?folder_id=figures-folder-id',
      'https://www.overleaf.com/project/project-id/upload?folder_id=figures-folder-id',
    ]);
    expect(calls.filter((call) => call.url.endsWith('/folder'))).toHaveLength(1);
  });

  it('refreshes the project tree when folder creation succeeds without returning an id', async () => {
    const { calls } = mockOverleafFetch({
      folderResponse: jsonResponse({ success: true }),
      joinRootFolders: [rootFolder(), rootFolderWithFigures()],
    });

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      rootFolder(),
      {
        'figures/figure1.pdf': { content: new Uint8Array([1, 2, 3]) },
      },
      []
    );

    expect(result.added).toEqual(['figures/figure1.pdf']);
    expect(calls.filter((call) => call.url.endsWith('/join'))).toHaveLength(2);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=figures-folder-id');
  });

  it('uses root relativePath when a new nested file parent folder cannot be created or resolved', async () => {
    const { calls } = mockOverleafFetch();

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      rootFolder(),
      {
        'figures/figure1.pdf': { content: new Uint8Array([1, 2, 3]) },
      },
      []
    );

    expect(result.added).toEqual(['figures/figure1.pdf']);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=root-folder-id');
    const body = uploadCall?.init?.body as FormData;
    expect(body.get('relativePath')).toBe('figures/figure1.pdf');
  });

  it('uses root relativePath when an existing zip folder cannot be resolved in the tree', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response(new Uint8Array(zipSync({ 'figures/figure1.pdf': new Uint8Array([1, 2, 3]) })));
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [rootFolder()],
          },
        });
      }

      if (url.endsWith('/folder')) {
        return new Response('cannot create folder in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      rootFolder(),
      {
        'figures/figure1.pdf': { content: new Uint8Array([4, 5, 6]) },
      },
      []
    );

    expect(result.modified).toEqual(['figures/figure1.pdf']);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=root-folder-id');
    const body = uploadCall?.init?.body as FormData;
    expect(body.get('relativePath')).toBe('figures/figure1.pdf');
    expect(body.get('name')).toBe('figure1.pdf');
  });

  it('retries via root folder + relativePath when /upload returns 404 for a stale folder_id', async () => {
    // Simulates the case where the cached rootFolder from the content script
    // contains a stale `figures` folder id (the user re-created the folder in
    // Overleaf after the snapshot was taken). The first upload fails with 404
    // because the server no longer knows that folder id; the client should
    // recover by retrying against the project root + relativePath.
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let uploadCallCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [
              {
                ...rootFolder(),
                folders: [
                  {
                    _id: 'stale-figures-folder-id',
                    name: 'figures',
                    docs: [],
                    fileRefs: [],
                    folders: [],
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes('/upload')) {
        uploadCallCount += 1;
        if (url.includes('folder_id=stale-figures-folder-id')) {
          return new Response('not found', { status: 404, statusText: '' });
        }
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      {
        ...rootFolder(),
        folders: [
          {
            _id: 'stale-figures-folder-id',
            name: 'figures',
            docs: [],
            fileRefs: [],
            folders: [],
          },
        ],
      },
      {
        'figures/figure1.pdf': { content: new Uint8Array([1, 2, 3]) },
      },
      []
    );

    expect(result.added).toEqual(['figures/figure1.pdf']);
    expect(uploadCallCount).toBeGreaterThanOrEqual(2);

    const uploadCalls = calls.filter((call) => call.url.includes('/upload'));
    expect(uploadCalls[0]?.url).toContain('folder_id=stale-figures-folder-id');
    const firstBody = uploadCalls[0]?.init?.body as FormData;
    expect(firstBody.get('relativePath')).toBe('null');

    // The retry should anchor at the root folder and include the full path so
    // Overleaf can re-resolve the folder by name.
    const retryCall = uploadCalls.find(
      (call) => !call.url.includes('folder_id=stale-figures-folder-id')
    );
    expect(retryCall).toBeDefined();
    expect(retryCall?.url).toContain('folder_id=root-folder-id');
    const retryBody = retryCall?.init?.body as FormData;
    expect(retryBody.get('relativePath')).toBe('figures/figure1.pdf');
    expect(retryBody.get('name')).toBe('figure1.pdf');
  });

  it('retries a stale folder upload with a freshly resolved folder id before root fallback', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let joinCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        joinCount += 1;
        return jsonResponse({
          project: {
            rootFolder: [
              {
                ...rootFolder(),
                folders: [
                  {
                    _id: joinCount === 1 ? 'stale-figures-folder-id' : 'fresh-figures-folder-id',
                    name: 'figures',
                    docs: [],
                    fileRefs: [],
                    folders: [],
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes('/upload')) {
        if (url.includes('folder_id=stale-figures-folder-id')) {
          return new Response('not found', { status: 404, statusText: '' });
        }
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      {
        ...rootFolder(),
        folders: [
          {
            _id: 'stale-figures-folder-id',
            name: 'figures',
            docs: [],
            fileRefs: [],
            folders: [],
          },
        ],
      },
      {
        'figures/figure1.pdf': { content: new Uint8Array([1, 2, 3]) },
      },
      []
    );

    expect(result.added).toEqual(['figures/figure1.pdf']);

    const uploadCalls = calls.filter((call) => call.url.includes('/upload'));
    expect(uploadCalls.map((call) => call.url)).toEqual([
      'https://www.overleaf.com/project/project-id/upload?folder_id=stale-figures-folder-id',
      'https://www.overleaf.com/project/project-id/upload?folder_id=fresh-figures-folder-id',
    ]);

    const retryBody = uploadCalls[1]?.init?.body as FormData;
    expect(retryBody.get('relativePath')).toBe('null');
    expect(retryBody.get('name')).toBe('figure1.pdf');
  });

  it('falls back to root relativePath when an existing cached folder id is stale and live tree cannot resolve it', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder_id: 'root-folder-id',
            rootFolder: [rootFolderWithoutId()],
          },
        });
      }

      if (url.endsWith('/folder')) {
        return new Response('cannot create folder in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.includes('/upload')) {
        if (url.includes('folder_id=stale-figures-folder-id')) {
          return new Response('not found', { status: 404, statusText: '' });
        }
        if (!url.includes('folder_id=root-folder-id')) {
          return new Response('not found', { status: 404, statusText: '' });
        }
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      {
        folders: [
          {
            _id: 'stale-figures-folder-id',
            name: 'figures',
            docs: [],
            fileRefs: [],
            folders: [],
          },
        ],
      },
      {
        'figures/figure1.pdf': { content: new Uint8Array([1, 2, 3]) },
      },
      []
    );

    expect(result.added).toEqual(['figures/figure1.pdf']);
    const uploadCalls = calls.filter((call) => call.url.includes('/upload'));
    expect(uploadCalls.map((call) => call.url)).toEqual([
      'https://www.overleaf.com/project/project-id/upload?folder_id=stale-figures-folder-id',
      'https://www.overleaf.com/project/project-id/upload?folder_id=root-folder-id',
    ]);
    const retryBody = uploadCalls[1]?.init?.body as FormData;
    expect(retryBody.get('relativePath')).toBe('figures/figure1.pdf');
    expect(retryBody.get('name')).toBe('figure1.pdf');
  });

  it('does not attempt root file uploads without a folder_id after resolving root from project metadata', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder_id: 'root-folder-id',
            rootFolder: [rootFolderWithoutId()],
          },
        });
      }

      if (url.includes('/upload')) {
        if (!url.includes('folder_id=root-folder-id')) {
          return new Response('not found', { status: 404, statusText: '' });
        }
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      rootFolderWithoutId(),
      {
        'main.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['main.tex']);
    const uploadCalls = calls.filter((call) => call.url.includes('/upload'));
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]?.url).toBe(
      'https://www.overleaf.com/project/project-id/upload?folder_id=root-folder-id'
    );
  });

  it('resolves root folder id when Overleaf returns rootFolder as an id string', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: ['root-folder-id'],
          },
        });
      }

      if (url.includes('/upload')) {
        if (!url.includes('folder_id=root-folder-id')) {
          return new Response('not found', { status: 404, statusText: '' });
        }
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      undefined,
      {
        'main.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['main.tex']);
    const uploadCalls = calls.filter((call) => call.url.includes('/upload'));
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]?.url).toContain('folder_id=root-folder-id');
  });

  it('resolves root folder id when Overleaf returns rootFolder as an ObjectId object', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [{ $oid: 'root-folder-id' }],
          },
        });
      }

      if (url.includes('/upload')) {
        if (!url.includes('folder_id=root-folder-id')) {
          return new Response('not found', { status: 404, statusText: '' });
        }
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      undefined,
      {
        'main.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['main.tex']);
    const uploadCalls = calls.filter((call) => call.url.includes('/upload'));
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]?.url).toContain('folder_id=root-folder-id');
  });

  it('resolves a top-level rootFolder payload not wrapped in project', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          rootFolder: [
            {
              _id: 'root-folder-id',
              docs: [],
              fileRefs: [],
              folders: [],
            },
          ],
        });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      undefined,
      {
        'main.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['main.tex']);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=root-folder-id');
  });

  it('resolves existing folders from nested entity payloads', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [
              {
                _id: 'root-folder-id',
                docs: [],
                fileRefs: [],
                folders: [
                  {
                    folder: {
                      _id: 'figures-folder-id',
                      name: 'figures',
                    },
                    docs: [],
                    fileRefs: [],
                    folders: [],
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      undefined,
      {
        'figures/figure1.pdf': { content: new Uint8Array([1, 2, 3]) },
      },
      []
    );

    expect(result.added).toEqual(['figures/figure1.pdf']);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=figures-folder-id');
    const body = uploadCall?.init?.body as FormData;
    expect(body.get('relativePath')).toBe('null');
  });

  it('replaces existing Overleaf files even when the downloaded zip content already matches GitHub', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const content = new TextEncoder().encode('same content');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response(new Uint8Array(zipSync({ 'main.tex': content })));
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [
              {
                ...rootFolder(),
                docs: [
                  {
                    _id: 'main-doc-id',
                    name: 'main.tex',
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes('/doc/main-doc-id')) {
        return jsonResponse({ success: true });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      rootFolder(),
      {
        'main.tex': { content },
      },
      []
    );

    expect(result.modified).toEqual(['main.tex']);
    expect(calls.some((call) => call.url.includes('/doc/main-doc-id'))).toBe(true);
    expect(calls.some((call) => call.url.includes('/upload'))).toBe(true);
  });

  it('uploads changed existing text files when the Overleaf entity id cannot be resolved', async () => {
    const oldContent = new TextEncoder().encode('old content');
    const newContent = new TextEncoder().encode('new content');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });

      if (url.includes('/download/zip')) {
        return new Response(new Uint8Array(zipSync({ 'main.tex': oldContent })));
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [rootFolder()],
          },
        });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      rootFolder(),
      {
        'main.tex': { content: newContent },
      },
      []
    );

    expect(result.modified).toEqual(['main.tex']);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=root-folder-id');
  });

  it('reuses one live tree refresh across multiple missing entity lookups', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [rootFolder()],
          },
        });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      rootFolder(),
      {
        'main.tex': { content: new TextEncoder().encode('main') },
        'refs.bib': { content: new TextEncoder().encode('@book{a}') },
      },
      []
    );

    expect(result.added).toEqual(['main.tex', 'refs.bib']);
    expect(calls.filter((call) => call.url.endsWith('/join')).length).toBeLessThanOrEqual(2);
    expect(calls.filter((call) => call.url.includes('/upload'))).toHaveLength(2);
  });

  it('deletes and uploads an existing root doc found from the live tree when the cached tree is stale', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response(new Uint8Array(zipSync({ 'main.tex': new TextEncoder().encode('old') })));
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [
              {
                ...rootFolder(),
                docs: [
                  {
                    _id: 'main-doc-id',
                    name: 'main.tex',
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes('/doc/main-doc-id')) {
        return jsonResponse({ success: true });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      rootFolder(),
      {
        'main.tex': { content: new TextEncoder().encode('new') },
      },
      []
    );

    expect(result.modified).toEqual(['main.tex']);
    expect(calls.some((call) => call.url.includes('/doc/main-doc-id'))).toBe(true);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=root-folder-id');
  });

  it('uploads new root text files through the upload endpoint', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [rootFolder()],
          },
        });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      rootFolder(),
      {
        'main.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['main.tex']);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=root-folder-id');
    const body = uploadCall?.init?.body as FormData;
    expect(body.get('name')).toBe('main.tex');
  });

  it('resolves the root folder id before uploading root-level files', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [rootFolder()],
          },
        });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      undefined,
      {
        'main.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['main.tex']);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=root-folder-id');
  });

  it('resolves root folder id via join without a user id before uploading root files', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [rootFolder()],
          },
        });
      }

      if (url.includes('/upload')) {
        if (!url.includes('folder_id=')) {
          return new Response('not found', { status: 404, statusText: '' });
        }
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      undefined,
      undefined,
      {
        'main.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['main.tex']);
    const uploadCalls = calls.filter((call) => call.url.includes('/upload'));
    expect(uploadCalls.map((call) => call.url)).toEqual([
      'https://www.overleaf.com/project/project-id/upload?folder_id=root-folder-id',
    ]);
  });

  it('resolves root folder id via socket when Overleaf join is unavailable', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const socketSends: string[] = [];

    class FakeWebSocket {
      static OPEN = 1;
      readyState = FakeWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(public url: string) {
        setTimeout(() => {
          this.onopen?.();
        }, 0);
      }

      send(message: string) {
        socketSends.push(message);
        setTimeout(() => {
          this.onmessage?.({
            data:
              '5:::' +
              JSON.stringify({
                name: 'joinProjectResponse',
                args: [
                  {
                    project: {
                      rootFolder: [rootFolder()],
                    },
                  },
                ],
              }),
          } as MessageEvent);
        }, 0);
      }

      close() {
        this.readyState = 3;
      }
    }

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return new Response('join unavailable in test', {
          status: 404,
          statusText: 'Not Found',
        });
      }

      if (url.endsWith('/entities')) {
        return new Response('entities unavailable in test', {
          status: 404,
          statusText: 'Not Found',
        });
      }

      if (url.includes('/socket.io/1/')) {
        return new Response('socket-id:60:60:websocket,xhr-polling');
      }

      if (url.includes('/upload')) {
        if (!url.includes('folder_id=root-folder-id')) {
          return new Response('missing folder id', { status: 404, statusText: 'Not Found' });
        }
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      undefined,
      {
        'main.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['main.tex']);
    expect(socketSends).toContain(
      '5:::' +
        JSON.stringify({
          name: 'joinProject',
          args: ['project-id'],
        })
    );
    expect(calls.some((call) => call.url.includes('/socket.io/1/'))).toBe(true);
    const uploadCalls = calls.filter((call) => call.url.includes('/upload'));
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]?.url).toBe(
      'https://www.overleaf.com/project/project-id/upload?folder_id=root-folder-id'
    );
  });

  it('uses project-level root folder id when the rootFolder object has no id', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder_id: 'root-folder-id',
            rootFolder: [rootFolderWithoutId()],
          },
        });
      }

      if (url.includes('/upload')) {
        if (!url.includes('folder_id=root-folder-id')) {
          return new Response('not found', { status: 404, statusText: '' });
        }
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      undefined,
      {
        'main.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['main.tex']);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=root-folder-id');
  });

  it('uses project-level root folder id for unresolved nested folder fallback', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder_id: 'root-folder-id',
            rootFolder: [rootFolderWithoutId()],
          },
        });
      }

      if (url.endsWith('/folder')) {
        return new Response('cannot create folder in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.includes('/upload')) {
        if (!url.includes('folder_id=root-folder-id')) {
          return new Response('not found', { status: 404, statusText: '' });
        }
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      undefined,
      {
        'figures/figure1.pdf': { content: new Uint8Array([1, 2, 3]) },
      },
      []
    );

    expect(result.added).toEqual(['figures/figure1.pdf']);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=root-folder-id');
    const body = uploadCall?.init?.body as FormData;
    expect(body.get('relativePath')).toBe('figures/figure1.pdf');
  });

  it('uploads nested text files after creating the parent folder', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({
          project: {
            rootFolder: [rootFolder()],
          },
        });
      }

      if (url.endsWith('/folder')) {
        return jsonResponse({
          folder: {
            _id: 'sections-folder-id',
            name: 'sections',
          },
        });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      rootFolder(),
      {
        'sections/intro.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['sections/intro.tex']);
    const uploadCall = calls.find((call) => call.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=sections-folder-id');
    const body = uploadCall?.init?.body as FormData;
    expect(body.get('relativePath')).toBe('null');
    expect(body.get('name')).toBe('intro.tex');
  });
});

  // BUG REPRODUCTION TESTS - these should fail if the described bug exists
  it('pulls root-level files when Overleaf project already has a figures subfolder', async () => {
    const mainContent = new TextEncoder().encode('hello world');
    const figContent = new Uint8Array([1, 2, 3]);

    const rootFolderWithFiguresAndDocs = {
      _id: 'root-folder-id',
      docs: [{ _id: 'main-doc-id', name: 'main.tex' }],
      fileRefs: [],
      folders: [{
        _id: 'figures-folder-id',
        name: 'figures',
        docs: [],
        fileRefs: [{ _id: 'fig1-id', name: 'figure1.pdf' }],
        folders: []
      }]
    };

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        const { zipSync } = await import('fflate');
        return new Response(new Uint8Array(zipSync({ 'main.tex': mainContent, 'figures/figure1.pdf': figContent })));
      }
      if (url.endsWith('/join')) {
        return jsonResponse({ project: { rootFolder: [rootFolderWithFiguresAndDocs] } });
      }
      if (url.includes('/doc/main-doc-id')) {
        return jsonResponse({ success: true });
      }
      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }
      return new Response('unexpected: ' + url, { status: 404, statusText: 'Not Found' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id', 'csrf-token', 'user-id',
      rootFolderWithFiguresAndDocs,
      { 'main.tex': { content: new TextEncoder().encode('new content') } },
      []
    );

    expect(result.modified).toEqual(['main.tex']);
    const uploadCall = calls.find((c) => c.url.includes('/upload'));
    expect(uploadCall?.url).toContain('folder_id=root-folder-id');
  });

  it('pulls both root and nested files when Overleaf project already has a figures subfolder', async () => {
    const mainContent = new TextEncoder().encode('hello world');
    const figContent = new Uint8Array([1, 2, 3]);

    const rootFolderWithFiguresAndDocs = {
      _id: 'root-folder-id',
      docs: [{ _id: 'main-doc-id', name: 'main.tex' }],
      fileRefs: [],
      folders: [{
        _id: 'figures-folder-id',
        name: 'figures',
        docs: [],
        fileRefs: [{ _id: 'fig1-id', name: 'figure1.pdf' }],
        folders: []
      }]
    };

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        const { zipSync } = await import('fflate');
        return new Response(new Uint8Array(zipSync({ 'main.tex': mainContent, 'figures/figure1.pdf': figContent })));
      }
      if (url.endsWith('/join')) {
        return jsonResponse({ project: { rootFolder: [rootFolderWithFiguresAndDocs] } });
      }
      if (url.includes('/doc/main-doc-id')) {
        return jsonResponse({ success: true });
      }
      if (url.includes('/file/fig1-id')) {
        return jsonResponse({ success: true });
      }
      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }
      return new Response('unexpected: ' + url, { status: 404, statusText: 'Not Found' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id', 'csrf-token', 'user-id',
      rootFolderWithFiguresAndDocs,
      {
        'main.tex': { content: new TextEncoder().encode('new content') },
        'figures/figure1.pdf': { content: new Uint8Array([4, 5, 6]) }
      },
      []
    );

    expect(result.modified).toEqual(['main.tex', 'figures/figure1.pdf']);
    const uploadCalls = calls.filter((c) => c.url.includes('/upload'));
    expect(uploadCalls).toHaveLength(2);
  });

  it('falls back to uploading root files without folder_id when root id cannot be resolved', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({ project: { rootFolder: [] } });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      undefined,
      {
        'main.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['main.tex']);
    const uploadCalls = calls.filter((call) => call.url.includes('/upload'));
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]?.url).toBe('https://www.overleaf.com/project/project-id/upload');
    const body = uploadCalls[0]?.init?.body as FormData;
    expect(body.get('relativePath')).toBe('main.tex');
    expect(body.get('name')).toBe('main.tex');
  });

  it('falls back to uploading nested files without folder_id using relativePath', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/download/zip')) {
        return new Response('zip unavailable in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.endsWith('/join')) {
        return jsonResponse({ project: { rootFolder: [] } });
      }

      if (url.endsWith('/folder')) {
        return new Response('cannot create folder in test', {
          status: 500,
          statusText: 'Server Error',
        });
      }

      if (url.includes('/upload')) {
        return jsonResponse({ success: true });
      }

      return new Response('unexpected request', {
        status: 404,
        statusText: 'Not Found',
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await applyProjectFiles(
      'project-id',
      'csrf-token',
      'user-id',
      undefined,
      {
        'sections/intro.tex': { content: new TextEncoder().encode('hello') },
      },
      []
    );

    expect(result.added).toEqual(['sections/intro.tex']);
    const uploadCalls = calls.filter((call) => call.url.includes('/upload'));
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]?.url).toBe('https://www.overleaf.com/project/project-id/upload');
    const body = uploadCalls[0]?.init?.body as FormData;
    expect(body.get('relativePath')).toBe('sections/intro.tex');
    expect(body.get('name')).toBe('intro.tex');
  });
