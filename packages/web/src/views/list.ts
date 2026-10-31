import {
  CATEGORY_OPTIONS,
  SORT_OPTIONS,
  buildTenderQuery,
  defaultFilters,
  parseTenderQuery,
  type Filters,
} from '../api/query';
import type { TenderListResponse } from '../api/types';
import { errorMessage, type AppContext } from '../context';
import { clear, h, nextId, notice } from '../ui/dom';
import { pagination, tenderCard } from '../ui/components';

const STATUS_FILTER = [
  ['', 'Any status'],
  ['open', 'Open'],
  ['closed', 'Closed'],
  ['cancelled', 'Cancelled'],
  ['unknown', 'Status unknown'],
] as const;

export function tenderHref(id: string): string {
  return `#/tender/${encodeURIComponent(id)}`;
}

function textField(label: string, name: string, value: string, type = 'text', hint?: string) {
  const id = nextId(name);
  return h(
    'div',
    { class: 'control' },
    h('label', { for: id }, label),
    h('input', { id, name, type, value, autocomplete: 'off', placeholder: hint ?? '' }),
  );
}

/** Read the form back into Filters (page resets to 1 whenever a filter changes). */
export function readFilters(form: HTMLFormElement, current: Filters): Filters {
  const fd = new FormData(form);
  const get = (k: string) => String(fd.get(k) ?? '').trim();
  return {
    ...current,
    q: get('q'),
    categories: CATEGORY_OPTIONS.map((o) => o.id).filter((id) =>
      fd.getAll('category').includes(id),
    ),
    country: get('country'),
    status: get('status'),
    publishedFrom: get('publishedFrom'),
    publishedTo: get('publishedTo'),
    deadlineFrom: get('deadlineFrom'),
    deadlineTo: get('deadlineTo'),
    noticeType: get('notice_type'),
    sort: parseTenderQuery(`sort=${get('sort')}`).sort,
    page: 1,
  };
}

export function renderList(root: HTMLElement, ctx: AppContext, query: string): () => void {
  const filters = parseTenderQuery(query);
  const go = (f: Filters) => {
    const q = buildTenderQuery(f);
    location.hash = q ? `#/?${q}` : '#/';
  };

  const form = h(
    'form',
    { class: 'filters', role: 'search', 'aria-label': 'Search and filter tenders' },
    h(
      'div',
      { class: 'search-row' },
      h(
        'div',
        { class: 'control grow' },
        h('label', { for: 'q' }, 'Search'),
        h('input', {
          id: 'q',
          name: 'q',
          type: 'search',
          value: filters.q,
          placeholder: 'Title, buyer, item...',
        }),
      ),
      h(
        'div',
        { class: 'control' },
        h('label', { for: 'sort' }, 'Sort by'),
        h(
          'select',
          { id: 'sort', name: 'sort' },
          SORT_OPTIONS.map((o) =>
            h('option', { value: o.value, selected: o.value === filters.sort }, o.label),
          ),
        ),
      ),
      h('button', { type: 'submit', class: 'btn primary' }, 'Search'),
    ),
    h(
      'details',
      { class: 'more-filters', open: !window.matchMedia?.('(max-width: 640px)').matches },
      h('summary', {}, 'Filters'),
      h(
        'fieldset',
        { class: 'cats' },
        h('legend', {}, 'Category'),
        CATEGORY_OPTIONS.map((o) => {
          const id = nextId('cat');
          return h(
            'label',
            { class: 'check', for: id },
            h('input', {
              id,
              type: 'checkbox',
              name: 'category',
              value: o.id,
              checked: filters.categories.includes(o.id),
            }),
            ' ',
            o.label,
          );
        }),
      ),
      h(
        'div',
        { class: 'grid' },
        textField('Country', 'country', filters.country, 'text', 'e.g. Zambia'),
        h(
          'div',
          { class: 'control' },
          h('label', { for: 'status' }, 'Status'),
          h(
            'select',
            { id: 'status', name: 'status' },
            STATUS_FILTER.map(([v, l]) =>
              h('option', { value: v, selected: v === filters.status }, l),
            ),
          ),
        ),
        textField('Notice type', 'notice_type', filters.noticeType, 'text', 'e.g. Contract Award'),
        textField('Published from', 'publishedFrom', filters.publishedFrom, 'date'),
        textField('Published to', 'publishedTo', filters.publishedTo, 'date'),
        textField('Deadline from', 'deadlineFrom', filters.deadlineFrom, 'date'),
        textField('Deadline to', 'deadlineTo', filters.deadlineTo, 'date'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn linkish',
          onclick: () => go({ ...defaultFilters(), sort: filters.sort }),
        },
        'Clear filters',
      ),
    ),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go(readFilters(form, filters));
  });
  // Selects, checkboxes and dates apply as soon as they change.
  form.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'search')) return;
    go(readFilters(form, filters));
  });

  const summary = h('p', { class: 'result-summary', 'aria-live': 'polite' }, 'Loading...');
  const results = h('div', { class: 'results' });
  const pager = h('div', {});
  root.append(h('h2', {}, 'Tenders'), form, summary, results, pager);

  let alive = true;
  const render = (res: TenderListResponse) => {
    if (!alive) return;
    for (const it of res.items) ctx.store.seed(it.id, it.shortlisted);
    summary.textContent =
      res.total === 0
        ? 'No tenders match these filters. This only covers what the configured sources have returned so far, not every tender in the world.'
        : `${res.total} tender${res.total === 1 ? '' : 's'} found`;
    clear(results);
    for (const it of res.items) {
      results.append(
        tenderCard(it, {
          href: tenderHref(it.id),
          store: ctx.store,
          onError: (e) => ctx.flash(errorMessage(e) ?? 'Not signed in', 'error'),
        }),
      );
    }
    clear(pager);
    if (res.total > 0)
      pager.append(
        pagination(res.page, res.total, res.pageSize, (p) => go({ ...filters, page: p })),
      );
  };

  ctx.api.listTenders(buildTenderQuery(filters)).then(render, (e) => {
    if (!alive) return;
    const msg = errorMessage(e);
    summary.textContent = '';
    if (msg) results.append(notice('error', `Could not load tenders: ${msg}`));
  });
  return () => {
    alive = false;
  };
}
