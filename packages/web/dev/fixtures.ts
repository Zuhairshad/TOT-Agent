import {
  TenderRecordSchema,
  type TenderRecord,
  type TenderRecordInput,
} from '@tender-monitor/shared';

/**
 * FIXTURE (synthetic) data. Nothing here is a real tender, buyer or contact. Used by the unit
 * tests and by the dev mock API, and validated against the real TenderRecordSchema.
 */

const T0 = '2026-10-30T09:00:00Z';
const ev = (quote: string, page: number | null = null) => ({
  sourceUrl: 'https://example.org/fixture/notice',
  quote,
  page,
  documentUrl: page ? 'https://example.org/fixture/docs/specification.pdf' : null,
  retrievedAt: T0,
});

const published = <V>(value: V, quote?: string) => ({
  value,
  status: 'published' as const,
  evidence: quote ? [ev(quote)] : [],
});
const notPublished = { value: null, status: 'not_published' as const };

export function makeItems(
  n: number,
  opts: { missingQtyEvery?: number } = {},
): TenderRecordInput['items'] {
  return Array.from({ length: n }, (_, i) => {
    const missingQty = opts.missingQtyEvery ? (i + 1) % opts.missingQtyEvery === 0 : false;
    return {
      lotNo: i < n / 2 ? '1' : '2',
      lineNo: String(i + 1),
      description: `FIXTURE item ${i + 1}: ${['Motorcycle 150cc', 'Full-face helmet', 'Riding jacket', 'Gloves', 'High-visibility vest'][i % 5]}`,
      specification:
        i % 4 === 3
          ? notPublished
          : published(
              `Specification for FIXTURE item ${i + 1}. ` +
                'Must comply with the standard referenced in section 4.2, include a 12-month warranty, ' +
                'be delivered fully assembled, and carry a label in English and French. ' +
                (i % 3 === 0
                  ? 'Additional notes: ' +
                    'long-technical-token-'.repeat(6) +
                    ' and further wording to force several wrapped lines in the table cell.'
                  : ''),
            ),
      quantity: missingQty
        ? { value: null, originalText: null }
        : { value: (i + 1) * 10, originalText: `${(i + 1) * 10}` },
      unit: i % 5 === 1 ? null : (['pcs', 'sets', 'pairs'][i % 3] ?? 'pcs'),
      evidence: [],
      needsReview: i % 7 === 6,
    };
  });
}

export function makeRecord(
  over: Partial<TenderRecordInput> & { sourceRecordId: string },
): TenderRecord {
  return TenderRecordSchema.parse({
    source: 'fixture',
    canonicalUrl: `https://example.org/fixture/notice/${over.sourceRecordId}`,
    title: `FIXTURE (synthetic) tender ${over.sourceRecordId}`,
    relevance: {
      score: 0.5,
      groups: [],
      matches: [],
      explanation: 'FIXTURE: matched the term "motorcycle" in the title.',
    },
    firstSeenAt: T0,
    lastCheckedAt: T0,
    lastUpdatedAt: T0,
    contentHash: 'a'.repeat(64),
    ...over,
  });
}

export const RICH = makeRecord({
  sourceRecordId: 'FIXTURE-001',
  title: 'FIXTURE (synthetic) Supply of 40 motorcycles and rider protective equipment',
  reference: published('FIX-MoH-2026-001'),
  buyer: published('FIXTURE Ministry of Health (synthetic)'),
  country: published('Zambia'),
  deliveryLocation: published('Lusaka central warehouse'),
  publishedAt: {
    ...published('2026-10-01T00:00:00Z', 'Published: 1 October 2026'),
    originalText: '1 October 2026',
    precision: 'date',
  },
  deadline: {
    ...published('2026-11-20T10:00:00Z', 'Deadline 20/11/2026 12:00 CAT'),
    originalText: '20 November 2026, 12:00',
    timezone: 'CAT (UTC+2)',
    precision: 'datetime',
  },
  status: 'open',
  noticeType: 'Invitation for Bids',
  categories: ['motorbikes', 'ppe'],
  relevance: {
    score: 0.91,
    groups: ['motorbikes', 'ppe'],
    matches: [],
    excluded: [],
    explanation:
      'FIXTURE: "motorcycle" in the title and "helmet" in item 2; PPE kept separate from riding gear.',
  },
  scopeOfSupply: published(
    'Supply and delivery of 40 motorcycles (150cc) for field outreach teams, with helmets and high-visibility vests.\nWarranty and a first service are included.',
    'Supply and delivery of 40 motorcycles',
  ),
  lots: [
    { lotNo: '1', title: 'Motorcycles', description: 'Forty 150cc motorcycles', evidence: [] },
    { lotNo: '2', title: 'Rider protective equipment', description: null, evidence: [] },
  ],
  items: makeItems(3),
  deliverySchedule: published('Within 90 days of contract signature'),
  estimatedValue: {
    amount: 250000,
    currency: 'USD',
    originalText: 'USD 250,000 (estimate)',
    status: 'published',
    evidence: [ev('Estimated budget USD 250,000', 3)],
  },
  awardValue: { amount: null, currency: null, originalText: null, status: 'not_published' },
  tenderFee: {
    amount: 50,
    currency: 'USD',
    originalText: 'USD 50 non-refundable',
    status: 'published',
  },
  bidSecurity: {
    amount: 5000,
    currency: 'USD',
    originalText: 'bid security of USD 5,000',
    status: 'published',
  },
  eligibility: published([
    'Registered supplier in the country of supply',
    'Three similar contracts in the last five years',
  ]),
  requiredDocuments: published([
    'Company registration certificate',
    'Tax clearance',
    'Manufacturer authorisation',
  ]),
  submissionMethod: published('Sealed bid delivered to the procurement office, or by email'),
  contact: {
    name: published('FIXTURE Procurement Officer (synthetic)'),
    email: published('procurement@example.org'),
    phone: notPublished,
    address: { value: null, status: 'could_not_verify' },
  },
  documents: [
    {
      url: 'https://example.org/fixture/docs/bid-document.pdf',
      title: 'Bid document',
      status: 'retrieved',
      mimeType: 'application/pdf',
      pageCount: 24,
      textExtracted: true,
    },
    {
      url: 'https://example.org/fixture/docs/specification.pdf',
      title: 'Technical specification',
      status: 'requires_login',
      error: 'Sign-in needed',
    },
    { url: 'https://example.org/fixture/docs/boq.xlsx', title: null, status: 'blocked' },
  ],
  accessLimitations: ['FIXTURE: the technical specification needs a login that is not configured.'],
});

export const SPARSE = makeRecord({
  sourceRecordId: 'FIXTURE-002',
  title: 'FIXTURE (synthetic) Notice with almost nothing published',
  publishedAt: {
    value: null,
    originalText: '03/04/2026',
    ambiguous: true,
    status: 'could_not_verify',
  },
  status: 'unknown',
  categories: ['riding_gear'],
  relevance: {
    score: 0.2,
    groups: ['riding_gear'],
    matches: [],
    explanation: 'FIXTURE: weak match on "gloves".',
  },
});

export const AWARD = makeRecord({
  sourceRecordId: 'FIXTURE-003',
  title: 'FIXTURE (synthetic) Contract award: protective equipment',
  buyer: published('FIXTURE Roads Agency (synthetic)'),
  country: published('Kenya'),
  publishedAt: {
    ...published('2026-09-12T00:00:00Z'),
    precision: 'date',
    originalText: '12 Sep 2026',
  },
  deadline: { ...notPublished },
  status: 'closed',
  noticeType: 'Contract Award',
  categories: ['ppe'],
  relevance: {
    score: 0.7,
    groups: ['ppe'],
    matches: [],
    explanation: 'FIXTURE: "safety helmets" in the award description.',
  },
  estimatedValue: { amount: null, currency: null, originalText: null, status: 'not_published' },
  awardValue: { amount: 120000, currency: 'KES', originalText: 'KES 120,000', status: 'published' },
  items: [
    {
      description: 'FIXTURE safety helmets',
      quantity: { value: null, originalText: null },
      unit: 'pcs',
      specification: notPublished,
      needsReview: true,
    },
  ],
});

export const MANY_ITEMS = makeRecord({
  sourceRecordId: 'FIXTURE-060',
  title: 'FIXTURE (synthetic) Framework with 60 line items and very long specifications',
  buyer: published('FIXTURE Agency (synthetic)'),
  country: published('Ghana'),
  status: 'open',
  categories: ['riding_gear', 'ppe'],
  deadline: {
    ...published('2026-12-15T00:00:00Z'),
    originalText: '15 Dec 2026',
    precision: 'date',
  },
  items: makeItems(60, { missingQtyEvery: 9 }),
});

export const ODD_CHARS = makeRecord({
  sourceRecordId: 'FIXTURE-ODD',
  title: 'FIXTURE (synthetic) 摩托车 helmets – “quoted” \u{1F6F5} Łódź',
  buyer: published('FIXTURE Buyer مرحبا (synthetic)'),
  scopeOfSupply: published('Scope with a tab\there, a null\u0000 byte and RTL text ‮abc'),
  items: [
    {
      description: 'FIXTURE 头盔 helmet',
      specification: published('规格 – 全盔'),
      quantity: { value: 5, originalText: '5' },
      unit: 'pcs',
    },
  ],
});

const COUNTRIES = ['Zambia', 'Kenya', 'Ghana', 'Nigeria', 'India', 'Peru'];
const CATS: TenderRecord['categories'][] = [
  ['motorbikes'],
  ['riding_gear'],
  ['ppe'],
  ['motorbikes', 'ppe'],
];

/** A deterministic set of FIXTURE records for pagination/filter demos. */
export function fixtureRecords(extra = 24): TenderRecord[] {
  const filler = Array.from({ length: extra }, (_, i) => {
    const day = String((i % 27) + 1).padStart(2, '0');
    const hasDeadline = i % 5 !== 0;
    return makeRecord({
      sourceRecordId: `FIXTURE-${100 + i}`,
      source: i % 4 === 0 ? 'worldbank' : 'fixture',
      title: `FIXTURE (synthetic) ${['Motorcycles', 'Riding gloves and jackets', 'Safety helmets and PPE', 'Patrol motorbikes with PPE'][i % 4]} lot ${i + 1}`,
      country: published(COUNTRIES[i % COUNTRIES.length]),
      buyer: published(`FIXTURE Buyer ${i + 1} (synthetic)`),
      publishedAt: {
        ...published(`2026-10-${day}T00:00:00Z`),
        precision: 'date',
        originalText: `${day} Oct 2026`,
      },
      deadline: hasDeadline
        ? {
            ...published(`2026-11-${day}T00:00:00Z`),
            precision: 'date',
            originalText: `${day} Nov 2026`,
          }
        : { value: null, status: i % 2 ? 'not_published' : 'could_not_verify' },
      status: hasDeadline ? (i % 7 === 0 ? 'closed' : 'open') : 'unknown',
      noticeType: i % 6 === 0 ? 'Contract Award' : 'Invitation for Bids',
      categories: CATS[i % CATS.length],
      relevance: {
        score: Math.round((0.95 - i * 0.03) * 100) / 100,
        groups: CATS[i % CATS.length] ?? [],
        matches: [],
        explanation: `FIXTURE: matched on keyword group ${CATS[i % CATS.length]?.join(' + ')}.`,
      },
      estimatedValue:
        i % 3 === 0
          ? {
              amount: 10000 * (i + 1),
              currency: 'USD',
              originalText: `USD ${10000 * (i + 1)}`,
              status: 'published',
            }
          : { amount: null, currency: null, originalText: null, status: 'not_published' },
      awardValue:
        i % 6 === 0
          ? {
              amount: 8000 * (i + 1),
              currency: 'USD',
              originalText: `USD ${8000 * (i + 1)}`,
              status: 'published',
            }
          : { amount: null, currency: null, originalText: null, status: 'not_published' },
      items: makeItems(2 + (i % 3)),
    });
  });
  return [RICH, SPARSE, AWARD, MANY_ITEMS, ODD_CHARS, ...filler];
}
