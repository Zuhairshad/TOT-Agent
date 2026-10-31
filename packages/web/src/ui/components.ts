import type { LineItem, TenderListItem, TenderStatus } from '../api/types';
import { CATEGORY_OPTIONS } from '../api/query';
import {
  COULD_NOT_VERIFY,
  MONEY_LABELS,
  NOT_PUBLISHED,
  STATUS_LABELS,
  factText,
  formatDate,
  formatDeadline,
  formatMoney,
  formatQuantity,
  type DateDisplay,
  type DeadlineDisplay,
  type MoneyDisplay,
} from '../format';
import type { ShortlistStore } from '../state';
import { h, type Child } from './dom';

export function statusBadge(status: TenderStatus): HTMLElement {
  // Text, not only colour, carries the meaning. "unknown" is never styled like "open".
  return h('span', { class: `badge badge-${status}` }, STATUS_LABELS[status]);
}

export function missingTag(label: string): HTMLElement {
  return h('span', { class: 'missing' }, label);
}

export function categoryChips(categories: string[]): HTMLElement {
  return h(
    'ul',
    { class: 'chips', 'aria-label': 'Categories' },
    categories.length
      ? categories.map((c) =>
          h('li', { class: 'chip' }, CATEGORY_OPTIONS.find((o) => o.id === c)?.label ?? c),
        )
      : h('li', { class: 'chip chip-empty' }, 'No category'),
  );
}

/** A "label: value" pair used on cards and detail. */
export function field(label: string, ...value: Child[]): HTMLElement {
  return h('div', { class: 'field' }, h('dt', {}, label), h('dd', {}, ...value));
}

export function dateValue(d: DateDisplay): HTMLElement {
  const wrap = h('span', { class: 'date' });
  wrap.append(d.missing ? missingTag(d.text) : document.createTextNode(d.text));
  if (d.ambiguous)
    wrap.append(
      ' ',
      h(
        'span',
        { class: 'warn-tag', title: 'The source text can be read more than one way' },
        'Ambiguous date',
      ),
    );
  return wrap;
}

export function deadlineValue(d: DeadlineDisplay): HTMLElement {
  if (!d.unknown) return dateValue(d);
  return h(
    'span',
    { class: 'date' },
    h('strong', { class: 'unknown' }, d.headline),
    ' ',
    missingTag(d.reason ?? COULD_NOT_VERIFY),
  );
}

export function moneyValue(m: MoneyDisplay): HTMLElement {
  return h(
    'span',
    { class: 'money' },
    m.missing ? missingTag(m.text) : h('strong', {}, m.text),
    m.note ? h('span', { class: 'muted' }, ` (${m.note})`) : null,
  );
}

export function starButton(id: string, store: ShortlistStore, onError: (e: unknown) => void) {
  const btn = h('button', { type: 'button', class: 'btn star' });
  const paint = () => {
    const on = store.has(id);
    btn.textContent = on ? '★ Shortlisted' : '☆ Shortlist';
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
  };
  paint();
  btn.addEventListener('click', () => {
    btn.disabled = true;
    store
      .toggle(id)
      .catch(onError)
      .finally(() => {
        btn.disabled = false;
      });
  });
  const unsub = store.subscribe(() => {
    if (!btn.isConnected) unsub();
    else paint();
  });
  return btn;
}

export interface CardOptions {
  href: string;
  store: ShortlistStore;
  onError: (e: unknown) => void;
  /** Shortlist view: a checkbox to pick tenders for export, plus a per-tender export button. */
  select?: { checked: boolean; onChange: (on: boolean) => void; onExport: () => void };
}

export function tenderCard(item: TenderListItem, o: CardOptions): HTMLElement {
  const published = formatDate(item.publishedAt);
  const deadline = formatDeadline(item.deadline, item.deadlineKnown);
  const est = formatMoney(item.estimatedValue);
  const award = formatMoney(item.awardValue);
  const titleId = `t-${item.id.replace(/[^a-z0-9]/gi, '-')}`;

  const values: HTMLElement[] = [];
  if (!est.missing) values.push(field(MONEY_LABELS.estimatedValue, moneyValue(est)));
  if (!award.missing) values.push(field(MONEY_LABELS.awardValue, moneyValue(award)));
  if (values.length === 0) values.push(field('Value', moneyValue(est)));

  const card = h(
    'article',
    { class: 'card', 'aria-labelledby': titleId },
    h(
      'header',
      { class: 'card-head' },
      o.select
        ? h('input', {
            type: 'checkbox',
            class: 'pick',
            checked: o.select.checked,
            'aria-label': `Select for export: ${item.title}`,
            onchange: (e: Event) => o.select?.onChange((e.target as HTMLInputElement).checked),
          })
        : null,
      h('h3', { id: titleId }, h('a', { href: o.href }, item.title)),
      statusBadge(item.status),
    ),
    h(
      'p',
      { class: 'meta' },
      [
        item.buyer ?? `Buyer: ${NOT_PUBLISHED}`,
        item.country ?? `Country: ${NOT_PUBLISHED}`,
        item.reference ? `Ref ${item.reference}` : null,
        item.noticeType,
        item.source,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
    h(
      'dl',
      { class: 'fields' },
      field('Published', dateValue(published)),
      field('Deadline', deadlineValue(deadline)),
      ...values,
    ),
    categoryChips(item.categories),
    h(
      'p',
      { class: 'why' },
      h('strong', {}, 'Why it matched: '),
      item.relevance.explanation || NOT_PUBLISHED,
    ),
    h(
      'div',
      { class: 'card-actions' },
      starButton(item.id, o.store, o.onError),
      o.select
        ? h(
            'button',
            { type: 'button', class: 'btn', onclick: () => o.select?.onExport() },
            'Export PDF',
          )
        : null,
    ),
  );
  return card;
}

export function pagination(
  page: number,
  total: number,
  pageSize: number,
  onPage: (p: number) => void,
): HTMLElement {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return h(
    'nav',
    { class: 'pager', 'aria-label': 'Pagination' },
    h(
      'button',
      { type: 'button', class: 'btn', disabled: page <= 1, onclick: () => onPage(page - 1) },
      'Previous',
    ),
    h('span', { class: 'pager-info' }, `${from}–${to} of ${total} (page ${page} of ${pages})`),
    h(
      'button',
      { type: 'button', class: 'btn', disabled: page >= pages, onclick: () => onPage(page + 1) },
      'Next',
    ),
  );
}

/** The line-items table. A missing quantity reads "Not published", never blank or 0. */
export function itemsTable(items: LineItem[]): HTMLElement {
  if (items.length === 0) {
    return h('p', {}, missingTag(NOT_PUBLISHED), ' No line items were published or readable.');
  }
  const rows = items.map((it) => {
    const qty = formatQuantity(it.quantity);
    const spec = factText(it.specification);
    return h(
      'tr',
      { class: it.needsReview ? 'needs-review' : '' },
      h('td', { 'data-label': 'Lot' }, it.lotNo ?? '–'),
      h('td', { 'data-label': 'Line' }, it.lineNo ?? '–'),
      h(
        'td',
        { 'data-label': 'Description' },
        it.description,
        it.needsReview ? [' ', h('span', { class: 'warn-tag' }, 'Needs review')] : null,
      ),
      h('td', { 'data-label': 'Specification' }, spec.missing ? missingTag(spec.text) : spec.text),
      h(
        'td',
        { 'data-label': 'Quantity', class: 'num' },
        qty.missing ? missingTag(qty.text) : qty.text,
      ),
      h('td', { 'data-label': 'Unit' }, it.unit ?? missingTag(NOT_PUBLISHED)),
    );
  });
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'items' },
      h('caption', { class: 'sr-only' }, 'Line items'),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ['Lot', 'Line', 'Description', 'Specification', 'Quantity', 'Unit'].map((c) =>
            h('th', { scope: 'col' }, c),
          ),
        ),
      ),
      h('tbody', {}, rows),
    ),
  );
}
