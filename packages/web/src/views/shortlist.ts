import { buildTenderQuery, defaultFilters } from '../api/query';
import type { TenderListItem } from '../api/types';
import { errorMessage, type AppContext } from '../context';
import { tenderCard } from '../ui/components';
import { clear, h, notice } from '../ui/dom';
import { tenderHref } from './list';

export function renderShortlist(root: HTMLElement, ctx: AppContext): () => void {
  let alive = true;
  let items: TenderListItem[] = [];
  const list = h('div', { class: 'results' });
  const bar = h('div', { class: 'bulk-bar' });
  const status = h('p', { 'aria-live': 'polite' }, 'Loading...');
  root.append(h('h2', {}, 'Shortlist'), bar, status, list);

  const visible = () => items.filter((i) => ctx.store.has(i.id));
  const err = (e: unknown) => ctx.flash(errorMessage(e) ?? 'Not signed in', 'error');

  const paint = () => {
    if (!alive) return;
    const rows = visible();
    ctx.selection.prune(rows.map((r) => r.id));
    clear(bar);
    clear(list);
    status.textContent = rows.length
      ? `${rows.length} shortlisted tender${rows.length === 1 ? '' : 's'}`
      : 'Nothing shortlisted yet. Use the star on any tender to add it here.';
    if (rows.length) {
      const allId = 'select-all';
      const all = h('input', {
        id: allId,
        type: 'checkbox',
        checked: rows.every((r) => ctx.selection.has(r.id)),
        onchange: (e: Event) => {
          ctx.selection.setAll(
            rows.map((r) => r.id),
            (e.target as HTMLInputElement).checked,
          );
          paint();
        },
      });
      const exportBtn = h(
        'button',
        {
          type: 'button',
          class: 'btn primary',
          disabled: ctx.selection.size === 0,
          onclick: () => {
            exportBtn.disabled = true;
            ctx.exportPdf(ctx.selection.all()).finally(paint);
          },
        },
        `Export selected as PDF (${ctx.selection.size})`,
      );
      bar.append(h('label', { class: 'check', for: allId }, all, ' Select all'), exportBtn);
    }
    for (const it of rows) {
      list.append(
        tenderCard(it, {
          href: tenderHref(it.id),
          store: ctx.store,
          onError: err,
          select: {
            checked: ctx.selection.has(it.id),
            onChange: (on) => {
              ctx.selection.set(it.id, on);
              paint();
            },
            onExport: () => void ctx.exportPdf([it.id]),
          },
        }),
      );
    }
  };

  const q = buildTenderQuery({ ...defaultFilters(), shortlisted: true, pageSize: 100 });
  ctx.api.listTenders(q).then(
    (res) => {
      if (!alive) return;
      items = res.items;
      for (const it of items) ctx.store.seed(it.id, true);
      paint();
    },
    (e) => {
      if (!alive) return;
      status.textContent = '';
      const m = errorMessage(e);
      if (m) list.append(notice('error', `Could not load the shortlist: ${m}`));
    },
  );
  const unsub = ctx.store.subscribe(() => {
    if (items.length) paint();
  });
  return () => {
    alive = false;
    unsub();
  };
}
