type Native = Uint8Array & { toBase64?: () => string };
type BufferLike = { from(b: Uint8Array): { toString(enc: 'base64'): string } };

/** Chunked btoa fallback: 24 KiB chunks (a multiple of 3, so no padding mid-string). */
export function toBase64Chunked(bytes: Uint8Array): string {
  const CHUNK = 0x6000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as never)));
  }
  return parts.join('');
}

/**
 * Base64-encodes bytes, preferring a native implementation because base64 of a
 * multi-MB PDF is one of the CPU-heavy steps on a Worker: Uint8Array#toBase64
 * (new runtimes), then Buffer (available under nodejs_compat), then the
 * chunked btoa fallback above (about 50x slower, but never builds one giant
 * intermediate string or spreads a huge array).
 */
export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Native).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  const buf = (globalThis as { Buffer?: BufferLike }).Buffer;
  if (buf) return buf.from(bytes).toString('base64');
  return toBase64Chunked(bytes);
}
