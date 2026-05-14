/**
 * SHA-1 hashing utility using SubtleCrypto
 */

/**
 * Compute SHA-1 hash of a Uint8Array or string
 * Returns hex-encoded string prefixed with "sha1:"
 */
export async function computeSHA1(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digestInput = new Uint8Array(bytes);

  const hashBuffer = await crypto.subtle.digest('SHA-1', digestInput);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return `sha1:${hashHex}`;
}

/**
 * Extract hex string from sha1: prefixed hash
 */
export function extractHashHex(hash: string): string {
  if (hash.startsWith('sha1:')) {
    return hash.slice(5);
  }
  return hash;
}

/**
 * Compare two hash strings (with or without sha1: prefix)
 */
export function hashesEqual(hash1: string, hash2: string): boolean {
  return extractHashHex(hash1) === extractHashHex(hash2);
}
