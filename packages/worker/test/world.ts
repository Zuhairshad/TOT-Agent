import { vi } from 'vitest';

export interface WorldCall {
  url: string;
  method: string;
  /** Parsed JSON / form body (Slack and Anthropic), or raw bytes length for uploads. */
  body: Record<string, unknown>;
  headers: Record<string, string>;
  bytes?: number;
}

export interface WorldOptions {
  files: Record<string, { name: string; filetype: string; size?: number; bytes: Uint8Array }>;
  /** Successive text replies from the fake Claude; the last one repeats. */
  claude?: string[];
}

/** Fake Slack + Anthropic on global fetch. */
export function stubWorld(opts: WorldOptions): WorldCall[] {
  const calls: WorldCall[] = [];
  let n = 0;
  let claudeIdx = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const raw = init?.body;
      let body: Record<string, unknown> = {};
      let bytes: number | undefined;
      if (typeof raw === 'string') {
        body =
          headers['content-type']?.includes('x-www-form-urlencoded') === true
            ? Object.fromEntries(new URLSearchParams(raw))
            : (JSON.parse(raw || '{}') as Record<string, unknown>);
      } else if (raw instanceof Uint8Array) {
        bytes = raw.byteLength;
      }
      calls.push({ url, method: init?.method ?? 'GET', body, headers, bytes });

      if (url.startsWith('https://slack.com/api/files.info')) {
        const f = opts.files[String(body.file)];
        if (!f) return Response.json({ ok: false, error: 'file_not_found' });
        return Response.json({
          ok: true,
          file: {
            id: body.file,
            name: f.name,
            filetype: f.filetype,
            size: f.size ?? f.bytes.byteLength,
            url_private: `https://files.slack.com/files-pri/T1-${String(body.file)}/${f.name}`,
          },
        });
      }
      if (url.startsWith('https://files.slack.com/')) {
        const f = Object.entries(opts.files).find(([id]) => url.includes(`-${id}/`))?.[1];
        return f ? new Response(f.bytes) : new Response('nope', { status: 404 });
      }
      if (url.endsWith('files.getUploadURLExternal')) {
        return Response.json({
          ok: true,
          upload_url: 'https://upload.slack.test/u/1',
          file_id: 'FOUT',
        });
      }
      if (url.startsWith('https://upload.slack.test/')) return new Response('OK');
      if (url.startsWith('https://api.anthropic.com/')) {
        const replies = opts.claude ?? [];
        const text = replies[Math.min(claudeIdx++, replies.length - 1)] ?? '';
        return Response.json({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
      }
      if (url.startsWith('https://slack.com/api/')) {
        return Response.json({ ok: true, ts: `1700000000.${String(++n).padStart(6, '0')}` });
      }
      return new Response('unexpected ' + url, { status: 500 });
    }),
  );
  return calls;
}
