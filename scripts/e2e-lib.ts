/**
 * Pure logic of the production smoke test (scripts/e2e.ts). Everything that touches the network
 * goes through the injected `fetch`, so the step logic is unit-tested without any real service.
 *
 * Flow: ingest ONE fake tender -> find its Slack card -> (always) clean up the D1 row and the
 * Slack message. It can only ever touch a tender whose ref starts with "TEST-".
 */

export const TEST_REF_PREFIX = 'TEST-';

export interface E2EConfig {
  /** Full ingest URL, e.g. https://x.workers.dev/ingest */
  ingestUrl: string;
  ingestSecret: string;
  slackToken: string;
  channelId: string;
}

export interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface E2EOptions {
  /** How often / how long to look for the Slack card. Posting happens after /ingest answers. */
  pollAttempts?: number;
  pollIntervalMs?: number;
}

/** Env names the script reads. Values are never printed. */
export const REQUIRED_ENV = ['INGEST_SECRET', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID'] as const;

export function loadConfig(
  env: Record<string, string | undefined>,
): { ok: true; config: E2EConfig } | { ok: false; missing: string[] } {
  const ingestUrl = (env.E2E_INGEST_URL || env.INGEST_URL || '').trim();
  const missing: string[] = [];
  if (!ingestUrl) missing.push('E2E_INGEST_URL (or INGEST_URL)');
  for (const k of REQUIRED_ENV) if (!env[k]?.trim()) missing.push(k);
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    config: {
      ingestUrl,
      ingestSecret: (env.INGEST_SECRET as string).trim(),
      slackToken: (env.SLACK_BOT_TOKEN as string).trim(),
      channelId: (env.SLACK_CHANNEL_ID as string).trim(),
    },
  };
}

/** The ingest URL must be https (or localhost for `wrangler dev`) and end in /ingest. */
export function validateIngestUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'ingest URL is not a valid URL';
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return 'ingest URL must be https (http only for localhost)';
  }
  if (!url.pathname.endsWith('/ingest')) return 'ingest URL must end with /ingest';
  return null;
}

export function adminDeleteUrl(ingestUrl: string, totRef: string): string {
  const url = new URL(ingestUrl);
  url.pathname = url.pathname.replace(/\/ingest$/, `/admin/tenders/${encodeURIComponent(totRef)}`);
  url.search = '';
  return url.toString();
}

export function makeTestRef(nowMs: number): string {
  return `${TEST_REF_PREFIX}${nowMs}`;
}

/** Hard safety guard, checked before anything is sent. */
export function assertTestRef(totRef: string): void {
  if (!totRef.startsWith(TEST_REF_PREFIX) || totRef.length <= TEST_REF_PREFIX.length) {
    throw new Error(
      `refusing to run: tender ref "${totRef}" does not start with ${TEST_REF_PREFIX}`,
    );
  }
}

export function makeFakeTender(totRef: string, nowMs: number) {
  assertTestRef(totRef);
  const iso = new Date(nowMs).toISOString();
  return {
    totRef,
    title: `E2E smoke test ${totRef} (safe to ignore, deleted automatically)`,
    country: 'Zambia',
    purchaser: 'E2E test',
    postedAt: iso,
    deadline: new Date(nowMs + 30 * 86_400_000).toISOString(),
    valueText: 'n/a',
    url: `https://example.com/e2e/${encodeURIComponent(totRef)}`,
    matchedKeyword: 'e2e-test',
    scrapedAt: iso,
  };
}

interface SlackMessage {
  ts?: string;
  text?: string;
  blocks?: unknown;
}

/** A message belongs to the test if its text/blocks mention the ref (the title contains it). */
export function findMessage(messages: SlackMessage[], totRef: string): SlackMessage | undefined {
  return messages.find((m) => JSON.stringify([m.text, m.blocks]).includes(totRef));
}

export interface E2EReport {
  ok: boolean;
  steps: StepResult[];
}

/**
 * Runs the whole check. Never throws: every problem becomes a failed step. Cleanup always runs
 * (try/finally) and reports its own steps.
 */
export async function runE2E(
  config: E2EConfig,
  deps: Deps,
  totRef: string,
  opts: E2EOptions = {},
): Promise<E2EReport> {
  const steps: StepResult[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    deps.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  };
  const attempts = opts.pollAttempts ?? 10;
  const interval = opts.pollIntervalMs ?? 2000;

  try {
    assertTestRef(totRef);
  } catch (err) {
    record('safety guard', false, (err as Error).message);
    return { ok: false, steps };
  }
  record('safety guard', true, `ref ${totRef} starts with ${TEST_REF_PREFIX}`);
  const urlProblem = validateIngestUrl(config.ingestUrl);
  if (urlProblem) {
    record('config', false, urlProblem);
    return { ok: false, steps };
  }

  const startMs = deps.now();
  let ingested = false;
  let foundTs: string | undefined;

  try {
    // 1. POST the fake tender.
    try {
      const res = await deps.fetch(config.ingestUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.ingestSecret}`,
        },
        body: JSON.stringify({
          source: 'e2e-test',
          status: 'ok',
          tenders: [makeFakeTender(totRef, startMs)],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { new?: number; error?: string };
      if (res.ok && body.new === 1) {
        ingested = true;
        record('POST /ingest', true, 'HTTP 200, 1 new tender stored');
      } else {
        // A 200 with new != 1 still left a row behind only if it was stored; cleanup tries anyway.
        ingested = res.ok;
        record('POST /ingest', false, `HTTP ${res.status} ${body.error ?? JSON.stringify(body)}`);
      }
    } catch (err) {
      record('POST /ingest', false, `network error: ${(err as Error).message}`);
    }

    // 2. Find the card in Slack (the worker posts after answering /ingest, so poll).
    if (ingested) {
      let lastError = 'not found yet';
      for (let i = 0; i < attempts && !foundTs; i++) {
        if (i > 0) await deps.sleep(interval);
        try {
          const params = new URLSearchParams({
            channel: config.channelId,
            oldest: String(Math.floor(startMs / 1000) - 60),
            limit: '50',
          });
          const res = await deps.fetch(`https://slack.com/api/conversations.history?${params}`, {
            headers: { authorization: `Bearer ${config.slackToken}` },
          });
          const data = (await res.json()) as {
            ok: boolean;
            error?: string;
            messages?: SlackMessage[];
          };
          if (!data.ok) {
            lastError = `Slack error "${data.error}"`;
            if (data.error === 'missing_scope') {
              lastError += ' (the bot needs channels:history or groups:history)';
            }
            if (data.error !== 'ratelimited') break; // permanent: do not hammer Slack
            continue;
          }
          foundTs = findMessage(data.messages ?? [], totRef)?.ts;
        } catch (err) {
          lastError = `network error: ${(err as Error).message}`;
        }
      }
      if (foundTs) record('Slack card appeared', true, `found message ts ${foundTs}`);
      else record('Slack card appeared', false, lastError);
    } else {
      record('Slack card appeared', false, 'skipped: ingest did not succeed');
    }
  } finally {
    // 3. Cleanup ALWAYS runs. Delete the D1 row first: it returns slack_ts, so a card the search
    //    missed (or that arrived late) can still be removed.
    let rowTs: string | undefined;
    try {
      assertTestRef(totRef); // belt and braces: cleanup is also limited to TEST- refs
      const res = await deps.fetch(adminDeleteUrl(config.ingestUrl, totRef), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${config.ingestSecret}` },
      });
      const body = (await res.json().catch(() => ({}))) as { slack_ts?: string | null };
      rowTs = body.slack_ts ?? undefined;
      if (res.ok) record('cleanup: delete D1 row', true, 'row deleted');
      else if (res.status === 404 && !ingested) {
        record('cleanup: delete D1 row', true, 'no row to delete (ingest never succeeded)');
      } else {
        record(
          'cleanup: delete D1 row',
          false,
          `HTTP ${res.status}: delete it by hand (${totRef})`,
        );
      }
    } catch (err) {
      record(
        'cleanup: delete D1 row',
        false,
        `${(err as Error).message}: delete ${totRef} by hand`,
      );
    }
    const ts = foundTs ?? rowTs;
    if (ts) {
      try {
        const res = await deps.fetch('https://slack.com/api/chat.delete', {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${config.slackToken}`,
          },
          body: JSON.stringify({ channel: config.channelId, ts }),
        });
        const data = (await res.json()) as { ok: boolean; error?: string };
        if (data.ok) record('cleanup: delete Slack message', true, `deleted ts ${ts}`);
        else
          record(
            'cleanup: delete Slack message',
            false,
            `Slack error "${data.error}": delete ts ${ts} by hand`,
          );
      } catch (err) {
        record(
          'cleanup: delete Slack message',
          false,
          `${(err as Error).message}: delete ts ${ts} by hand`,
        );
      }
    } else {
      record(
        'cleanup: delete Slack message',
        !ingested,
        ingested
          ? 'no message ts known: check the channel for the test card'
          : 'nothing was posted',
      );
    }
  }

  return { ok: steps.every((s) => s.ok), steps };
}

/** Text printed by --dry-run: what would happen, with no network access. */
export function describePlan(
  env: Record<string, string | undefined>,
  totRef: string,
): { lines: string[]; configOk: boolean } {
  const cfg = loadConfig(env);
  const lines = [
    'DRY RUN: nothing will be sent.',
    `Would use the fake tender ref: ${totRef} (must start with ${TEST_REF_PREFIX})`,
  ];
  if (cfg.ok) {
    const problem = validateIngestUrl(cfg.config.ingestUrl);
    lines.push(
      `1. POST ${cfg.config.ingestUrl} with Bearer INGEST_SECRET and one fake tender${problem ? `   [PROBLEM: ${problem}]` : ''}`,
      `2. Poll Slack conversations.history on channel ${cfg.config.channelId} (needs channels:history or groups:history) for a message containing ${totRef}`,
      `3. DELETE ${problem ? '<ingest URL>' : adminDeleteUrl(cfg.config.ingestUrl, totRef)} (worker refuses anything but TEST- refs)`,
      '4. Slack chat.delete the card',
      'Steps 3 and 4 always run, even if step 1 or 2 failed.',
    );
    return { lines, configOk: !problem };
  }
  lines.push(`Configuration is incomplete. Missing: ${cfg.missing.join(', ')}`);
  lines.push('(Secret values are never printed.)');
  return { lines, configOk: false };
}
