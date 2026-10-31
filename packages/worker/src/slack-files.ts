import { slackFormApi } from './slack.js';
import type { Env } from './types.js';

export interface SlackFileInfo {
  id: string;
  name: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
}

/** files.info (needs files:read). */
export async function getFileInfo(env: Env, fileId: string): Promise<SlackFileInfo> {
  const data = await slackFormApi<{ file: SlackFileInfo }>(env, 'files.info', { file: fileId });
  return data.file;
}

export type FileKind = 'pdf' | 'docx' | 'xlsx' | 'other';

export function fileKind(file: SlackFileInfo): FileKind {
  const name = file.name.toLowerCase();
  const type = (file.filetype ?? '').toLowerCase();
  const mime = (file.mimetype ?? '').toLowerCase();
  if (type === 'pdf' || mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (
    type === 'docx' ||
    type === 'doc' ||
    /\.docx?$/.test(name) ||
    mime.includes('wordprocessingml')
  )
    return 'docx';
  if (type === 'xlsx' || type === 'xls' || /\.xlsx?$/.test(name) || mime.includes('spreadsheetml'))
    return 'xlsx';
  return 'other';
}

/** Downloads a private file with the bot token (needs files:read). */
export async function downloadFile(env: Env, file: SlackFileInfo): Promise<Uint8Array> {
  if (!file.url_private) throw new Error('Slack gave no download URL for this file');
  const res = await fetch(file.url_private, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Downloading the file failed (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Without files:read Slack answers 200 with an HTML login page.
  const magic = String.fromCharCode(...bytes.subarray(0, 5));
  if (magic !== '%PDF-')
    throw new Error('The downloaded file is not a PDF (is files:read granted?)');
  return bytes;
}

/**
 * Uploads bytes to a thread with the current external-upload flow
 * (files.getUploadURLExternal -> POST bytes -> files.completeUploadExternal).
 * Needs files:write.
 */
export async function uploadToThread(
  env: Env,
  opts: {
    channel: string;
    threadTs: string;
    filename: string;
    bytes: Uint8Array;
    comment?: string;
  },
): Promise<void> {
  const step1 = await slackFormApi<{ upload_url: string; file_id: string }>(
    env,
    'files.getUploadURLExternal',
    { filename: opts.filename, length: String(opts.bytes.byteLength) },
  );
  const put = await fetch(step1.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: opts.bytes,
  });
  if (!put.ok) throw new Error(`Uploading file bytes to Slack failed (HTTP ${put.status})`);
  await slackFormApi(env, 'files.completeUploadExternal', {
    files: JSON.stringify([{ id: step1.file_id, title: opts.filename }]),
    channel_id: opts.channel,
    thread_ts: opts.threadTs,
    ...(opts.comment ? { initial_comment: opts.comment } : {}),
  });
}
