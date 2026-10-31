/**
 * Production smoke test: post one fake tender (ref TEST-<timestamp>) to the deployed Worker,
 * check its card shows up in the Slack TEST channel, then delete the row and the message.
 *
 *   pnpm e2e              run it
 *   pnpm e2e --dry-run    print what it would do, send nothing
 *
 * Env: E2E_INGEST_URL (or INGEST_URL), INGEST_SECRET, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID.
 * SLACK_CHANNEL_ID must be the TEST channel the Worker is currently posting to.
 * SLACK_BOT_TOKEN needs channels:history (public) or groups:history (private) to read the channel.
 * Exit codes: 0 all steps passed, 1 a step failed, 2 bad configuration (nothing sent).
 */
import { pathToFileURL } from 'node:url';
import { describePlan, loadConfig, makeTestRef, runE2E, validateIngestUrl } from './e2e-lib.js';

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const totRef = makeTestRef(Date.now());
  if (argv.includes('--dry-run')) {
    const plan = describePlan(env, totRef);
    for (const line of plan.lines) console.log(line);
    return 0;
  }
  const cfg = loadConfig(env);
  if (!cfg.ok) {
    console.error(`FAIL  config: missing ${cfg.missing.join(', ')} (nothing was sent)`);
    return 2;
  }
  const problem = validateIngestUrl(cfg.config.ingestUrl);
  if (problem) {
    console.error(`FAIL  config: ${problem} (nothing was sent)`);
    return 2;
  }
  console.log(`E2E against ${new URL(cfg.config.ingestUrl).origin}, ref ${totRef}`);
  const report = await runE2E(
    cfg.config,
    {
      fetch: (...a) => fetch(...a),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      log: (l) => console.log(l),
    },
    totRef,
  );
  console.log(report.ok ? 'E2E RESULT: PASS' : 'E2E RESULT: FAIL');
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error('E2E RESULT: FAIL', (err as Error).message);
      process.exit(1);
    },
  );
}
