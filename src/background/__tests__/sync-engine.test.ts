import { describe, it, expect } from 'vitest';
import {
  detectPushChanges,
  detectPullChanges,
  validateChangesForPush,
  createManifestAfterPush,
  createManifestAfterPull,
  buildCommitMessage,
  filterIgnoredFiles,
  matchesIgnorePattern,
} from '../sync-engine';
import { SyncManifest } from '@shared/types';

describe('Sync engine', () => {
  const mockFiles = {
    'main.tex': {
      content: new TextEncoder().encode('\\documentclass{article}'),
      hash: 'sha1:abc123',
    },
    'fig.pdf': {
      content: new Uint8Array(1000),
      hash: 'sha1:def456',
    },
  };

  describe('detectPushChanges', () => {
    it('should treat all files as added when manifest is null', () => {
      const changes = detectPushChanges(mockFiles, null);

      expect(changes.added).toHaveLength(2);
      expect(changes.added[0].path).toBe('main.tex');
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
    });

    it('should detect modified files', () => {
      const manifest: SyncManifest = {
        overleafProjectId: 'proj123',
        github: { owner: 'alice', repo: 'thesis', branch: 'main' },
        lastSync: '2026-05-11T00:00:00Z',
        files: {
          'main.tex': {
            ovHash: 'sha1:old_hash',
            ghHash: 'sha1:old_hash',
            ghSha: 'ghblob:123',
          },
          'fig.pdf': {
            ovHash: 'sha1:def456',
            ghHash: 'sha1:def456',
            ghSha: 'ghblob:456',
          },
        },
      };

      const changes = detectPushChanges(mockFiles, manifest);

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(1);
      expect(changes.modified[0].path).toBe('main.tex');
      expect(changes.deleted).toHaveLength(0);
    });

    it('should detect deleted files', () => {
      const manifest: SyncManifest = {
        overleafProjectId: 'proj123',
        github: { owner: 'alice', repo: 'thesis', branch: 'main' },
        lastSync: '2026-05-11T00:00:00Z',
        files: {
          'main.tex': {
            ovHash: 'sha1:abc123',
            ghHash: 'sha1:abc123',
            ghSha: 'ghblob:123',
          },
          'removed.txt': {
            ovHash: 'sha1:removed',
            ghHash: 'sha1:removed',
            ghSha: 'ghblob:removed',
          },
        },
      };

      const changes = detectPushChanges(mockFiles, manifest);

      expect(changes.added).toHaveLength(1);
      expect(changes.added[0].path).toBe('fig.pdf');
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(1);
      expect(changes.deleted[0]).toBe('removed.txt');
    });

    it('should not detect changes for unchanged files', () => {
      const manifest: SyncManifest = {
        overleafProjectId: 'proj123',
        github: { owner: 'alice', repo: 'thesis', branch: 'main' },
        lastSync: '2026-05-11T00:00:00Z',
        files: {
          'main.tex': {
            ovHash: 'sha1:abc123',
            ghHash: 'sha1:abc123',
            ghSha: 'ghblob:123',
          },
          'fig.pdf': {
            ovHash: 'sha1:def456',
            ghHash: 'sha1:def456',
            ghSha: 'ghblob:456',
          },
        },
      };

      const changes = detectPushChanges(mockFiles, manifest);

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
    });
  });

  describe('detectPullChanges', () => {
    const remoteFiles = {
      'main.tex': {
        content: new TextEncoder().encode('\\documentclass{article}'),
        hash: 'sha1:gh-main',
        ghSha: 'gh-main',
      },
      'refs.bib': {
        content: new TextEncoder().encode('@book{a}'),
        hash: 'sha1:gh-bib',
        ghSha: 'gh-bib',
      },
    };

    it('should treat all remote files as added when manifest is null', () => {
      const changes = detectPullChanges(remoteFiles, null);

      expect(changes.added).toHaveLength(2);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
    });

    it('should detect remote modifications and deletions', () => {
      const manifest: SyncManifest = {
        overleafProjectId: 'proj123',
        github: { owner: 'alice', repo: 'thesis', branch: 'main' },
        lastSync: '2026-05-11T00:00:00Z',
        files: {
          'main.tex': {
            ovHash: 'sha1:old',
            ghHash: 'sha1:old',
            ghSha: 'old',
          },
          'removed.tex': {
            ovHash: 'sha1:removed',
            ghHash: 'sha1:removed',
            ghSha: 'removed',
          },
        },
      };

      const changes = detectPullChanges(remoteFiles, manifest);

      expect(changes.added.map((file) => file.path)).toEqual(['refs.bib']);
      expect(changes.modified.map((file) => file.path)).toEqual(['main.tex']);
      expect(changes.deleted).toEqual(['removed.tex']);
    });
  });

  describe('validateChangesForPush', () => {
    it('should pass validation for normal files', () => {
      const changes = {
        added: [{ path: 'test.txt', content: new TextEncoder().encode('hello') }],
        modified: [],
        deleted: [],
      };

      const result = validateChangesForPush(changes);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail for files over size limit', () => {
      const largeContent = new Uint8Array(101 * 1024 * 1024); // 101 MB
      const changes = {
        added: [{ path: 'large.bin', content: largeContent }],
        modified: [],
        deleted: [],
      };

      const result = validateChangesForPush(changes);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('buildCommitMessage', () => {
    it('should create a formatted commit message', () => {
      const changes = {
        added: [
          { path: 'new.tex', content: new Uint8Array() },
          { path: 'fig.pdf', content: new Uint8Array() },
        ],
        modified: [{ path: 'main.tex', content: new Uint8Array() }],
        deleted: ['old.bib'],
      };

      const message = buildCommitMessage(changes);

      expect(message).toContain('Sync from Overleaf');
      expect(message).toContain('Added 2 file(s)');
      expect(message).toContain('Modified 1 file(s)');
      expect(message).toContain('Deleted 1 file(s)');
      expect(message).toContain('Gitleaf-Project-Id: {PROJECT_ID}');
    });

    it('should handle empty changes gracefully', () => {
      const changes = {
        added: [],
        modified: [],
        deleted: [],
      };

      const message = buildCommitMessage(changes);
      expect(message).toContain('Sync from Overleaf');
      expect(message).toContain('Gitleaf-Project-Id: {PROJECT_ID}');
    });
  });

  describe('createManifestAfterPush', () => {
    it('should create a manifest with updated hashes', () => {
      const blobShas = {
        'main.tex': 'ghblob:new123',
        'fig.pdf': 'ghblob:new456',
      };

      const manifest = createManifestAfterPush(
        'proj123',
        'alice',
        'thesis',
        'main',
        mockFiles,
        blobShas
      );

      expect(manifest.overleafProjectId).toBe('proj123');
      expect(manifest.github.owner).toBe('alice');
      expect(manifest.github.repo).toBe('thesis');
      expect(manifest.files['main.tex'].ovHash).toBe('sha1:abc123');
      expect(manifest.files['main.tex'].ghHash).toBe('sha1:abc123');
      expect(new Date(manifest.lastSync)).toBeInstanceOf(Date);
    });
  });

  describe('createManifestAfterPull', () => {
    it('should create a manifest from GitHub files', () => {
      const manifest = createManifestAfterPull(
        'proj123',
        'alice',
        'thesis',
        'main',
        {
          'main.tex': {
            content: new TextEncoder().encode('hello'),
            hash: 'sha1:abc',
            ghSha: 'abc',
          },
        },
        'paper/'
      );

      expect(manifest.github.subPath).toBe('paper/');
      expect(manifest.files['main.tex'].ovHash).toBe('sha1:abc');
      expect(manifest.files['main.tex'].ghSha).toBe('abc');
    });
  });

  describe('ignore patterns', () => {
    it('should match simple gitignore-style patterns', () => {
      expect(matchesIgnorePattern('build/output.log', '*.log')).toBe(true);
      expect(matchesIgnorePattern('.vscode/settings.json', '.vscode/')).toBe(true);
      expect(matchesIgnorePattern('main.tex', '*.log')).toBe(false);
    });

    it('should filter ignored files before planning changes', () => {
      const filtered = filterIgnoredFiles(
        {
          ...mockFiles,
          'main.log': {
            content: new TextEncoder().encode('log'),
            hash: 'sha1:log',
          },
        },
        ['*.log']
      );

      expect(filtered['main.tex']).toBeDefined();
      expect(filtered['main.log']).toBeUndefined();
    });
  });
});
