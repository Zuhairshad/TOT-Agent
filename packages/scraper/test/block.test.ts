import { describe, expect, it } from 'vitest';
import { checkBlock } from '../src/block.js';

const ok = {
  status: 200,
  url: 'https://x.test/search',
  html: '<html><body><ul><li>tender</li></ul></body></html>',
};

describe('checkBlock', () => {
  it('passes a normal page', () => {
    expect(checkBlock(ok, { expectLoggedIn: true })).toEqual({ status: 'ok' });
  });
  it('blocks on a CAPTCHA widget', () => {
    const html = '<div class="g-recaptcha" data-sitekey="k"></div>';
    expect(checkBlock({ ...ok, html })).toEqual({ status: 'blocked', reason: 'captcha' });
  });
  it('blocks on a "verify you are human" challenge', () => {
    const html = '<h1>Please verify you are human</h1>';
    expect(checkBlock({ ...ok, html })).toEqual({ status: 'blocked', reason: 'challenge' });
  });
  it('blocks on a checking-your-browser interstitial', () => {
    expect(checkBlock({ ...ok, html: '<title>Just a moment...</title>' }).status).toBe('blocked');
  });
  it('blocks on HTTP 403 and 429 regardless of body', () => {
    expect(checkBlock({ ...ok, status: 403 })).toEqual({ status: 'blocked', reason: 'http-403' });
    expect(checkBlock({ ...ok, status: 429 })).toEqual({ status: 'blocked', reason: 'http-429' });
  });
  it('blocks when the login form shows again after login', () => {
    const html = '<form><input type="email"><input type="password" name="p"></form>';
    expect(checkBlock({ ...ok, html }, { expectLoggedIn: true })).toEqual({
      status: 'blocked',
      reason: 'login-form-shown',
    });
  });
  it('does not treat a login form as a block when not yet logged in', () => {
    const html = '<form><input type="password"></form>';
    expect(checkBlock({ ...ok, html })).toEqual({ status: 'ok' });
  });
});
