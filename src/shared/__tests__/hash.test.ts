import { describe, it, expect } from 'vitest';
import { computeSHA1, hashesEqual, extractHashHex } from '../hash';

describe('Hash utilities', () => {
  it('should compute SHA-1 for strings', async () => {
    const hash = await computeSHA1('hello world');
    expect(hash).toMatch(/^sha1:[a-f0-9]{40}$/);
  });

  it('should compute SHA-1 for Uint8Array', async () => {
    const data = new TextEncoder().encode('hello world');
    const hash = await computeSHA1(data);
    expect(hash).toMatch(/^sha1:[a-f0-9]{40}$/);
  });

  it('should return consistent hashes for the same input', async () => {
    const hash1 = await computeSHA1('test content');
    const hash2 = await computeSHA1('test content');
    expect(hash1).toBe(hash2);
  });

  it('should return different hashes for different inputs', async () => {
    const hash1 = await computeSHA1('content1');
    const hash2 = await computeSHA1('content2');
    expect(hash1).not.toBe(hash2);
  });

  it('should extract hex from sha1: prefixed hash', () => {
    const hash = 'sha1:2aae6c35c94fcfb415dbe95f408b9ce91ee846ed';
    const hex = extractHashHex(hash);
    expect(hex).toBe('2aae6c35c94fcfb415dbe95f408b9ce91ee846ed');
  });

  it('should handle hashes without prefix', () => {
    const hex = '2aae6c35c94fcfb415dbe95f408b9ce91ee846ed';
    expect(extractHashHex(hex)).toBe(hex);
  });

  it('should compare hashes regardless of prefix', async () => {
    const content = 'test';
    const hash = await computeSHA1(content);
    const hashWithoutPrefix = extractHashHex(hash);

    expect(hashesEqual(hash, hashWithoutPrefix)).toBe(true);
  });

  it('should correctly identify unequal hashes', async () => {
    const hash1 = await computeSHA1('content1');
    const hash2 = await computeSHA1('content2');
    expect(hashesEqual(hash1, hash2)).toBe(false);
  });
});
