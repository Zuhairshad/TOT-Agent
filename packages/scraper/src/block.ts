/**
 * Block detection. Pure function over what a page navigation returned. When it says
 * "blocked" the run must stop (CLAUDE.md rule 2): screenshot, report, exit code 2, never retry.
 */
export type BlockReason = 'http-403' | 'http-429' | 'captcha' | 'challenge' | 'login-form-shown';

export interface PageSnapshot {
  status: number;
  url: string;
  html: string;
}

export type BlockResult = { status: 'ok' } | { status: 'blocked'; reason: BlockReason };

const CAPTCHA = /g-recaptcha|h-captcha|hcaptcha|cf-turnstile|recaptcha\/api|captcha/i;
const CHALLENGE =
  /verify (that )?you are (a )?human|are you (a )?(human|robot)|checking your browser|just a moment\.\.\.|attention required|unusual traffic|security check/i;
const PASSWORD_INPUT = /<input\b[^>]*\btype\s*=\s*["']?password/i;

export interface CheckOptions {
  /** True once we believe we are logged in: a password form showing again then means we were bounced. */
  expectLoggedIn?: boolean;
}

export function hasLoginForm(html: string): boolean {
  return PASSWORD_INPUT.test(html);
}

export function checkBlock(snap: PageSnapshot, opts: CheckOptions = {}): BlockResult {
  if (snap.status === 403) return { status: 'blocked', reason: 'http-403' };
  if (snap.status === 429) return { status: 'blocked', reason: 'http-429' };
  if (CAPTCHA.test(snap.html)) return { status: 'blocked', reason: 'captcha' };
  if (CHALLENGE.test(snap.html)) return { status: 'blocked', reason: 'challenge' };
  if (opts.expectLoggedIn && hasLoginForm(snap.html)) {
    return { status: 'blocked', reason: 'login-form-shown' };
  }
  return { status: 'ok' };
}
