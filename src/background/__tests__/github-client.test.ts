import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeSHA1 } from '@shared/hash';
import { getRepositoryFiles, getRepositoryTree } from '../github-client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function base64(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

describe('GitHub client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pulls files from a configured LaTeX subfolder and maps them to Overleaf paths', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/git/trees/')) {
        return jsonResponse({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            {
              path: 'rep/latex',
              type: 'tree',
              sha: 'latex-tree',
              mode: '040000',
              url: '',
            },
            {
              path: 'rep/latex/main.tex',
              type: 'blob',
              sha: 'main-sha',
              mode: '100644',
              size: 16,
              url: '',
            },
            {
              path: 'rep/latex/sections/intro.tex',
              type: 'blob',
              sha: 'intro-sha',
              mode: '100644',
              size: 12,
              url: '',
            },
            {
              path: 'README.md',
              type: 'blob',
              sha: 'readme-sha',
              mode: '100644',
              size: 7,
              url: '',
            },
          ],
        });
      }

      if (url.endsWith('/git/blobs/main-sha')) {
        return jsonResponse({
          sha: 'main-sha',
          size: 16,
          url: '',
          encoding: 'base64',
          content: base64('\\documentclass{}'),
        });
      }

      if (url.endsWith('/git/blobs/intro-sha')) {
        return jsonResponse({
          sha: 'intro-sha',
          size: 12,
          url: '',
          encoding: 'base64',
          content: base64('intro text'),
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const files = await getRepositoryFiles(
      'token',
      'Artlands',
      'KVCache-survey',
      'main',
      'rep/latex'
    );

    expect(Object.keys(files)).toEqual(['main.tex', 'sections/intro.tex']);
    expect(new TextDecoder().decode(files['main.tex'].content)).toBe('\\documentclass{}');
    expect(files['main.tex'].hash).toBe(await computeSHA1(files['main.tex'].content));
    expect(files['main.tex'].ghSha).toBe('main-sha');
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/git/blobs/readme-sha'),
      expect.anything()
    );
  });

  it('fails clearly when the configured subfolder is not present in the repository tree', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            {
              path: 'README.md',
              type: 'blob',
              sha: 'readme-sha',
              mode: '100644',
              size: 7,
              url: '',
            },
          ],
        })
      )
    );

    await expect(
      getRepositoryFiles('token', 'Artlands', 'KVCache-survey', 'main', 'rep/latex')
    ).rejects.toThrow('GitHub subfolder "rep/latex" was not found');
  });

  it('encodes branch names before calling the GitHub tree endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        sha: 'tree-sha',
        truncated: false,
        tree: [],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await getRepositoryTree('token', 'Artlands', 'KVCache-survey', 'feature/latex import');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/Artlands/KVCache-survey/git/trees/feature%2Flatex%20import?recursive=1',
      expect.anything()
    );
  });

  it('includes GitHub API response messages in tree fetch errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { message: 'Not Found' },
          {
            status: 404,
            statusText: 'Not Found',
          }
        )
      )
    );

    await expect(getRepositoryTree('token', 'Artlands', 'KVCache-survey', 'main')).rejects.toThrow(
      'Failed to fetch tree: Not Found'
    );
  });
});
