import type { AppContext } from '../context';
import { errorMessage } from '../context';
import { downloadBytes } from '../ui/dom';
import { buildTenderPdf } from './export';
import type { TenderRecord } from '../api/types';

export function pdfFilename(records: TenderRecord[], now: Date): string {
  const day = now.toISOString().slice(0, 10);
  if (records.length === 1) {
    const r = records[0] as TenderRecord;
    return `tender-${`${r.source}-${r.sourceRecordId}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60)}-${day}.pdf`;
  }
  return `tenders-${day}.pdf`;
}

/** Fetch the full record for each id (in the browser), build one PDF, trigger the download. */
export async function exportTenders(ctx: AppContext, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  ctx.flash(`Preparing PDF for ${ids.length} tender${ids.length === 1 ? '' : 's'}...`, 'info');
  const records: TenderRecord[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      records.push((await ctx.api.getTender(id)).record);
    } catch (e) {
      if (errorMessage(e) === null) return; // 401: token prompt is showing
      failed.push(id);
    }
  }
  if (records.length === 0) {
    ctx.flash('Could not load any of the selected tenders, so no PDF was made.', 'error');
    return;
  }
  const now = new Date();
  try {
    const bytes = await buildTenderPdf(records, { generatedAt: now.toISOString() });
    downloadBytes(bytes, pdfFilename(records, now), 'application/pdf');
    ctx.flash(
      failed.length
        ? `PDF downloaded, but ${failed.length} tender(s) could not be loaded and are missing: ${failed.join(', ')}`
        : 'PDF downloaded.',
      failed.length ? 'warn' : 'info',
    );
  } catch (e) {
    ctx.flash(`Could not build the PDF: ${errorMessage(e) ?? 'unknown error'}`, 'error');
  }
}
