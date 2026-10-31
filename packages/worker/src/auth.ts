const encoder = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/**
 * Constant-time string comparison. Both inputs are hashed first so the loop
 * always runs over 32 bytes, whatever the input lengths are.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= (ha[i] ?? 0) ^ (hb[i] ?? 0);
  return diff === 0;
}

/** True when the request carries `Authorization: Bearer <secret>`. */
export async function verifyBearer(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false; // never accept an empty / unset secret
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) return false;
  return constantTimeEqual(match[1], secret);
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const SLACK_MAX_AGE_SECONDS = 5 * 60;

/**
 * Verifies a Slack request signature (v0 scheme). `rawBody` must be the exact
 * bytes Slack sent, so read the body as text before parsing it.
 * crypto.subtle.verify compares the MAC in constant time.
 */
export async function verifySlackSignature(
  request: Request,
  rawBody: string,
  signingSecret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!signingSecret) return false;
  const timestamp = request.headers.get('X-Slack-Request-Timestamp') ?? '';
  const signature = request.headers.get('X-Slack-Signature') ?? '';
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > SLACK_MAX_AGE_SECONDS) return false;
  if (!signature.startsWith('v0=')) return false;
  const sigBytes = hexToBytes(signature.slice(3));
  if (!sigBytes) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(`v0:${timestamp}:${rawBody}`));
}

/** Test helper / reference implementation: computes the header Slack would send. */
export async function signSlackBody(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${timestamp}:${body}`)),
  );
  return 'v0=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}
