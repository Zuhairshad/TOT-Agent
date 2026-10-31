import type { Category, TenderSort } from './types';

export const CATEGORY_OPTIONS: { id: Category; label: string }[] = [
  { id: 'motorbikes', label: 'Motorbikes' },
  { id: 'riding_gear', label: 'Riding gear' },
  { id: 'ppe', label: 'PPE' },
];

/** The label for each API sort value, in the order shown in the control. */
export const SORT_OPTIONS: { value: TenderSort; label: string }[] = [
  { value: 'published_desc', label: 'Newest first' },
  { value: 'published_asc', label: 'Oldest first' },
  { value: 'closing_soon', label: 'Closing soon' },
  { value: 'relevance_desc', label: 'Most relevant' },
];

export const DEFAULT_SORT: TenderSort = 'published_desc';
export const DEFAULT_PAGE_SIZE = 20;

export interface Filters {
  q: string;
  categories: Category[];
  country: string;
  source: string;
  status: string;
  publishedFrom: string;
  publishedTo: string;
  deadlineFrom: string;
  deadlineTo: string;
  noticeType: string;
  shortlisted: boolean;
  minRelevance: string;
  sort: TenderSort;
  page: number;
  pageSize: number;
}

export function defaultFilters(): Filters {
  return {
    q: '',
    categories: [],
    country: '',
    source: '',
    status: '',
    publishedFrom: '',
    publishedTo: '',
    deadlineFrom: '',
    deadlineTo: '',
    noticeType: '',
    shortlisted: false,
    minRelevance: '',
    sort: DEFAULT_SORT,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

const SORT_VALUES = new Set<string>(SORT_OPTIONS.map((o) => o.value));
const CATEGORY_VALUES = new Set<string>(CATEGORY_OPTIONS.map((o) => o.id));

/** Map a (possibly user-edited, e.g. from the URL) sort string to a valid API value. */
export function normalizeSort(value: string | null | undefined): TenderSort {
  return value && SORT_VALUES.has(value) ? (value as TenderSort) : DEFAULT_SORT;
}

/**
 * Filters -> query string (no leading "?"). Only non-default values are written, so the same
 * string is used for the API call and for the shareable URL hash.
 */
export function buildTenderQuery(f: Filters): string {
  const p = new URLSearchParams();
  const put = (k: string, v: string) => {
    const t = v.trim();
    if (t) p.set(k, t);
  };
  put('q', f.q);
  if (f.categories.length) p.set('category', f.categories.join(','));
  put('country', f.country);
  put('source', f.source);
  put('status', f.status);
  put('publishedFrom', f.publishedFrom);
  put('publishedTo', f.publishedTo);
  put('deadlineFrom', f.deadlineFrom);
  put('deadlineTo', f.deadlineTo);
  put('notice_type', f.noticeType);
  if (f.shortlisted) p.set('shortlisted', '1');
  put('minRelevance', f.minRelevance);
  if (f.sort !== DEFAULT_SORT) p.set('sort', f.sort);
  if (f.page > 1) p.set('page', String(f.page));
  if (f.pageSize !== DEFAULT_PAGE_SIZE) p.set('pageSize', String(f.pageSize));
  return p.toString();
}

/** The inverse of buildTenderQuery. Unknown or invalid values fall back to defaults. */
export function parseTenderQuery(query: string | URLSearchParams): Filters {
  const p = typeof query === 'string' ? new URLSearchParams(query) : query;
  const f = defaultFilters();
  f.q = p.get('q') ?? '';
  f.categories = (p.get('category') ?? '')
    .split(',')
    .filter((c): c is Category => CATEGORY_VALUES.has(c));
  f.country = p.get('country') ?? '';
  f.source = p.get('source') ?? '';
  f.status = p.get('status') ?? '';
  f.publishedFrom = p.get('publishedFrom') ?? '';
  f.publishedTo = p.get('publishedTo') ?? '';
  f.deadlineFrom = p.get('deadlineFrom') ?? '';
  f.deadlineTo = p.get('deadlineTo') ?? '';
  f.noticeType = p.get('notice_type') ?? '';
  f.shortlisted = p.get('shortlisted') === '1';
  f.minRelevance = p.get('minRelevance') ?? '';
  f.sort = normalizeSort(p.get('sort'));
  const page = Number.parseInt(p.get('page') ?? '', 10);
  f.page = Number.isFinite(page) && page > 0 ? page : 1;
  const size = Number.parseInt(p.get('pageSize') ?? '', 10);
  f.pageSize = Number.isFinite(size) && size > 0 && size <= 100 ? size : DEFAULT_PAGE_SIZE;
  return f;
}
