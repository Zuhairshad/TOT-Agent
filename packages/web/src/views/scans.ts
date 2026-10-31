import type { ScanFailure, ScansResponse, SourceStatus } from '../api/types';
import { ApiError } from '../api/client';
import { errorMessage, type AppContext } from '../context';
import { accessInfo, formatDateTimeUtc } from '../format';
import { clear, h, notice } from '../ui/dom';

const SCAN_STATUS: Record<string, string> = {
  running: 'Running now',
  succeeded: 'Succeeded',
  partial: 'Partly succeeded',
  failed: 'Failed',
  blocked: 'Blocked',
};

const count = (v: unknown[] | number | undefined | null) =>
  Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0;

export function sourceCard(
  s: SourceStatus,
  onRun: (id: string, btn: HTMLButtonElement) => void,
): HTMLElement {
  const info = accessInfo(s.accessStatus);
  const last = s.lastScan;
  const running = s.running ?? last?.status === 'running';
  const failures = last ? count(last.failures) : 0;
  const failureList: ScanFailure[] =
    last && Array.isArray(last.failures) ? last.failures.slice(0, 5) : [];
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'btn primary',
      disabled: running,
      onclick: () => onRun(s.id, btn),
    },
    running ? 'Scan running...' : 'Run scan',
  );
  return h(
    'article',
    { class: 'card source' },
    h(
      'header',
      { class: 'card-head' },
      h('h3', {}, s.id),
      h('span', { class: `badge access-${s.accessStatus}` }, info.label),
    ),
    h('p', { class: 'explain' }, info.text),
    h(
      'dl',
      { class: 'fields' },
      h(
        'div',
        { class: 'field' },
        h('dt', {}, 'Last successful scan'),
        h('dd', {}, s.lastSuccessfulScan ? formatDateTimeUtc(s.lastSuccessfulScan) : 'Never'),
      ),
      s.recordCount !== undefined
        ? h(
            'div',
            { class: 'field' },
            h('dt', {}, 'Tenders stored'),
            h('dd', {}, String(s.recordCount)),
          )
        : null,
      last
        ? [
            h(
              'div',
              { class: 'field' },
              h('dt', {}, 'Latest scan'),
              h(
                'dd',
                {},
                SCAN_STATUS[last.status] ?? last.status,
                last.finishedAt
                  ? ` (finished ${formatDateTimeUtc(last.finishedAt)})`
                  : running
                    ? ''
                    : '',
              ),
            ),
            h(
              'div',
              { class: 'field' },
              h('dt', {}, 'Progress'),
              h(
                'dd',
                {},
                `${last.pagesChecked} pages checked, ${last.recordsFound} records found` +
                  (last.recordsNew !== undefined
                    ? ` (${last.recordsNew} new, ${last.recordsUpdated ?? 0} updated)`
                    : ''),
              ),
            ),
            h(
              'div',
              { class: 'field' },
              h('dt', {}, 'Failures'),
              h('dd', {}, failures ? h('strong', { class: 'bad' }, String(failures)) : '0'),
            ),
          ]
        : h(
            'div',
            { class: 'field' },
            h('dt', {}, 'Latest scan'),
            h('dd', {}, 'No scan has run yet'),
          ),
    ),
    failureList.length
      ? h(
          'div',
          { class: 'notice notice-warn' },
          h('strong', {}, 'What went wrong'),
          h(
            'ul',
            {},
            failureList.map((f) => h('li', {}, f.stage ? `${f.stage}: ${f.error}` : f.error)),
          ),
        )
      : null,
    last && last.coverageLimitations.length
      ? h(
          'div',
          { class: 'notice notice-info' },
          h('strong', {}, 'Coverage limitations'),
          h(
            'ul',
            {},
            last.coverageLimitations.map((c) => h('li', {}, c)),
          ),
          h(
            'p',
            { class: 'muted' },
            'A scan never covers every tender; it reports what it actually checked.',
          ),
        )
      : null,
    h('div', { class: 'card-actions' }, btn),
  );
}

export function renderScans(root: HTMLElement, ctx: AppContext): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const body = h('div', { class: 'results' });
  const msg = h('div', { 'aria-live': 'polite' });
  root.append(
    h('h2', {}, 'Scans'),
    h(
      'p',
      { class: 'muted' },
      'Each source is checked politely (at most hourly). Blocked or login-only sources are reported, never bypassed.',
    ),
    msg,
    body,
  );

  const say = (kind: 'info' | 'warn' | 'error', text: string) => {
    clear(msg);
    msg.append(notice(kind, text));
  };

  const run = async (id: string, btn: HTMLButtonElement) => {
    btn.disabled = true;
    try {
      await ctx.api.startScan(id);
      say('info', `Scan started for ${id}. This page refreshes while it runs.`);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'conflict') say('warn', `${id}: ${e.message}`);
      else if (e instanceof ApiError && e.kind === 'not_configured')
        say('warn', `Cannot run a scan: ${e.message}`);
      else {
        const m = errorMessage(e);
        if (m) say('error', `Could not start the scan: ${m}`);
      }
      btn.disabled = false;
    }
  };

  const paint = (data: ScansResponse) => {
    clear(body);
    if (data.sources.length === 0) body.append(notice('info', 'No sources are configured.'));
    for (const s of data.sources) body.append(sourceCard(s, run));
    if (data.scans.length) {
      body.append(
        h(
          'section',
          { class: 'panel' },
          h('h3', {}, 'Recent scans'),
          h(
            'ul',
            { class: 'plain-list' },
            data.scans
              .slice(0, 10)
              .map((s) =>
                h(
                  'li',
                  {},
                  h('strong', {}, s.source),
                  ` · ${SCAN_STATUS[s.status] ?? s.status}`,
                  s.startedAt ? ` · started ${formatDateTimeUtc(s.startedAt)}` : '',
                  s.recordsFound !== undefined ? ` · ${s.recordsFound} records` : '',
                  s.failures && count(s.failures) ? ` · ${count(s.failures)} failures` : '',
                ),
              ),
          ),
        ),
      );
    }
  };

  const load = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    try {
      const data = await ctx.api.getScans();
      if (!alive) return;
      paint(data);
      if (data.sources.some((s) => s.running ?? s.lastScan?.status === 'running'))
        timer = setTimeout(() => void load(), 5000);
    } catch (e) {
      if (!alive) return;
      const m = errorMessage(e);
      if (m) say('error', `Could not load scans: ${m}`);
    }
  };
  void load();
  return () => {
    alive = false;
    if (timer) clearTimeout(timer);
  };
}
