import { extractTender, MAX_PDF_BYTES } from './claude.js';
import { escapeMrkdwn } from './blocks.js';
import { buildTenderPdf } from './pdf-builder.js';
import { downloadFile, fileKind, getFileInfo, uploadToThread } from './slack-files.js';
import { postMessage } from './slack.js';
import type { Env, TenderRow } from './types.js';

export const ONLY_PDF_TEXT = 'Only PDF works for now. Please upload the tender document as a PDF.';

/**
 * Document-reading step. Called once per file uploaded in the thread of a
 * shortlisted tender (inside ctx.waitUntil, after the thread was acknowledged).
 * It reports every failure in the thread and never throws.
 *
 * Steps (each is a separate function so the heavy PDF step can be moved out,
 * e.g. to a GitHub Action, by replacing only `buildPdf`):
 *   download -> extract (Claude, network wait) -> save JSON -> buildPdf (CPU) -> upload
 */
export async function onTenderDocumentUploaded(
  env: Env,
  tender: TenderRow,
  fileId: string,
): Promise<void> {
  const target = { channel: env.SLACK_CHANNEL_ID, threadTs: tender.slack_ts ?? undefined };
  const say = (text: string) => postMessage(env, { text }, target);
  try {
    const file = await getFileInfo(env, fileId);
    const kind = fileKind(file);
    if (kind !== 'pdf') {
      await say(ONLY_PDF_TEXT);
      return;
    }
    if ((file.size ?? 0) > MAX_PDF_BYTES) {
      await say(
        `This PDF is ${((file.size ?? 0) / 1048576).toFixed(1)} MB; the limit is ${MAX_PDF_BYTES / 1048576} MB.`,
      );
      return;
    }
    const pdf = await downloadFile(env, file);

    const details = await extractTender({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.CLAUDE_MODEL,
      pdf,
    });

    // Save the JSON before the CPU-heavy step so it survives a PDF/upload failure.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO tender_details (file_id, tot_ref, details_json, model, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        fileId,
        tender.tot_ref,
        JSON.stringify(details),
        env.CLAUDE_MODEL ?? null,
        new Date().toISOString(),
      )
      .run();

    const t0 = performance.now();
    const out = await buildTenderPdf(details, {
      totRef: tender.tot_ref,
      title: tender.title,
      sourceUrl: tender.url,
      generatedAt: new Date(),
      deadlineIso: tender.deadline,
    });
    // Workers freezes performance.now() during pure CPU work, so this shows ~0 there;
    // read the real number from Workers Observability (cpuTime). See SLACK_SETUP.md.
    console.log(
      `pdf-build ${tender.tot_ref}: ${(performance.now() - t0).toFixed(1)} ms, ${out.byteLength} bytes`,
    );

    await uploadToThread(env, {
      channel: target.channel,
      threadTs: tender.slack_ts as string,
      filename: `${tender.tot_ref}-summary.pdf`,
      bytes: out,
      comment: `Summary for *${escapeMrkdwn(tender.tot_ref)}*`,
    });
  } catch (err) {
    console.error(`document step failed for ${fileId}`, err);
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await say(`Could not process the document: ${msg}`);
    } catch (e) {
      console.error('could not report the failure to Slack', e);
    }
  }
}
