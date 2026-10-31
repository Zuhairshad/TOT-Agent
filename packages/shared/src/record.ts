import { z } from 'zod';

/**
 * TenderRecord (v2): the contract between the Python source scrapers (Scrapling), the Worker and
 * the web UI. The v1 `Tender` in ./tender.ts is untouched and still feeds the Slack flow.
 *
 * Rules baked into the shape:
 *  - A missing value is `null` plus a status. It is NEVER 0, '' or a guess.
 *  - Important facts carry evidence (source URL, supporting text, document page).
 *  - Estimated value, award value, tender fee and bid security are four separate fields.
 *  - Original text, units and currencies are preserved next to any parsed value.
 */

const iso = z.string().datetime({ offset: true });

export const EvidenceSchema = z.object({
  sourceUrl: z.string().url(),
  /** Exact supporting text from the page/document, trimmed to 600 chars. */
  quote: z.string().max(600).nullable().default(null),
  /** 1-based page number when the evidence comes from a document. */
  page: z.number().int().min(1).nullable().default(null),
  documentUrl: z.string().url().nullable().default(null),
  retrievedAt: iso,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** published: found in the source. not_published: source was read and the value is absent.
 *  could_not_verify: we could not read the place where it would be (login, blocked, OCR doubt).
 *  conflicting: two sources/documents disagree; see `note` and `evidence`. */
export const FactStatusSchema = z.enum([
  'published',
  'not_published',
  'could_not_verify',
  'conflicting',
]);
export type FactStatus = z.infer<typeof FactStatusSchema>;

const factBase = {
  status: FactStatusSchema.default('could_not_verify'),
  evidence: z.array(EvidenceSchema).default([]),
  note: z.string().nullable().default(null),
};

export const textFact = z.object({ value: z.string().nullable().default(null), ...factBase });
export const listFact = z.object({
  value: z.array(z.string()).nullable().default(null),
  ...factBase,
});
export type TextFact = z.infer<typeof textFact>;
export type ListFact = z.infer<typeof listFact>;

/** A date as published. `value` is UTC ISO; `originalText` is what the page said. */
export const DateFactSchema = z.object({
  value: iso.nullable().default(null),
  originalText: z.string().nullable().default(null),
  /** Timezone as stated in the source ("GMT+2", "CAT"), or null if none was stated. */
  timezone: z.string().nullable().default(null),
  /** 'date' when no time of day was published (value is then 00:00 in `timezone` or UTC). */
  precision: z.enum(['datetime', 'date']).nullable().default(null),
  /** True when the text could be read two ways (03/04/2026) or lacked a year/timezone. */
  ambiguous: z.boolean().default(false),
  ...factBase,
});
export type DateFact = z.infer<typeof DateFactSchema>;

/** An amount exactly as published. `amount: null` means unknown, never zero. */
export const MoneyFactSchema = z.object({
  amount: z.number().nonnegative().nullable().default(null),
  /** Currency as published (ISO 4217 code if the source gives one), else null. Never assumed. */
  currency: z.string().nullable().default(null),
  originalText: z.string().nullable().default(null),
  ...factBase,
});
export type MoneyFact = z.infer<typeof MoneyFactSchema>;

export const QuantitySchema = z.object({
  value: z.number().nonnegative().nullable().default(null),
  originalText: z.string().nullable().default(null),
});

export const LineItemSchema = z.object({
  lotNo: z.string().nullable().default(null),
  lineNo: z.string().nullable().default(null),
  description: z.string().min(1),
  specification: textFact.default({}),
  quantity: QuantitySchema.default({}),
  /** Unit exactly as published ("pcs", "sets", "pairs"). Never converted. */
  unit: z.string().nullable().default(null),
  /** Where this line item was read. Items found in several files are merged, not duplicated. */
  evidence: z.array(EvidenceSchema).default([]),
  needsReview: z.boolean().default(false),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const LotSchema = z.object({
  lotNo: z.string().min(1),
  title: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  evidence: z.array(EvidenceSchema).default([]),
});

export const DocumentStatusSchema = z.enum([
  'retrieved',
  'requires_login',
  'blocked',
  'too_large',
  'failed',
  'skipped_unsafe',
  'not_attempted',
]);

export const SourceDocumentSchema = z.object({
  url: z.string().url(),
  title: z.string().nullable().default(null),
  mimeType: z.string().nullable().default(null),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  sha256: z.string().nullable().default(null),
  fetchedAt: iso.nullable().default(null),
  status: DocumentStatusSchema.default('not_attempted'),
  pageCount: z.number().int().nonnegative().nullable().default(null),
  textExtracted: z.boolean().default(false),
  ocrUsed: z.boolean().default(false),
  /** True when extraction was uncertain (OCR, garbled table): a human should check it. */
  needsReview: z.boolean().default(false),
  error: z.string().nullable().default(null),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

export const RelevanceMatchSchema = z.object({
  term: z.string(),
  group: z.string(),
  field: z.enum(['title', 'description', 'item', 'document', 'other']),
  /** ~80 chars either side of the match. */
  context: z.string(),
});

export const RelevanceSchema = z.object({
  /** 0..1, heuristic. Only meaningful for ranking, not as a claim of certainty. */
  score: z.number().min(0).max(1),
  /** Keyword groups that matched, e.g. ["motorbikes"]. Broad PPE stays separate from riding gear. */
  groups: z.array(z.string()),
  matches: z.array(RelevanceMatchSchema),
  /** Exclusion terms that fired (e.g. "garbage", "waste") and why the record was demoted/dropped. */
  excluded: z.array(z.object({ term: z.string(), reason: z.string() })).default([]),
  /** One human-readable sentence: why this tender matched. */
  explanation: z.string(),
});
export type Relevance = z.infer<typeof RelevanceSchema>;

export const CategorySchema = z.enum(['motorbikes', 'riding_gear', 'ppe']);
export type Category = z.infer<typeof CategorySchema>;

export const TenderStatusSchema = z.enum(['open', 'closed', 'cancelled', 'unknown']);
export type TenderStatus = z.infer<typeof TenderStatusSchema>;

export const ContactSchema = z.object({
  name: textFact.default({}),
  email: textFact.default({}),
  phone: textFact.default({}),
  address: textFact.default({}),
});

export const TenderRecordSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  /** Adapter id: "worldbank", "tendersontime", ... */
  source: z.string().min(1),
  /** The source's own identifier for this notice (stable across scans). */
  sourceRecordId: z.string().min(1),
  canonicalUrl: z.string().url(),
  /** Tender/bid reference as published, e.g. "ZM-MoH-12345-GO-RFB". */
  reference: textFact.default({}),
  title: z.string().min(1),
  buyer: textFact.default({}),
  country: textFact.default({}),
  deliveryLocation: textFact.default({}),

  publishedAt: DateFactSchema.default({}),
  deadline: DateFactSchema.default({}),
  status: TenderStatusSchema.default('unknown'),
  statusEvidence: z.array(EvidenceSchema).default([]),
  /** "Invitation for Bids", "Contract Award", "Amendment", ... as published. */
  noticeType: z.string().nullable().default(null),
  /** Source's notice/amendment version if given. Higher supersedes lower. */
  noticeVersion: z.string().nullable().default(null),

  categories: z.array(CategorySchema).default([]),
  relevance: RelevanceSchema,

  scopeOfSupply: textFact.default({}),
  lots: z.array(LotSchema).default([]),
  items: z.array(LineItemSchema).default([]),
  deliverySchedule: textFact.default({}),

  /** Four DIFFERENT things. Never put one in another's field. */
  estimatedValue: MoneyFactSchema.default({}),
  awardValue: MoneyFactSchema.default({}),
  tenderFee: MoneyFactSchema.default({}),
  bidSecurity: MoneyFactSchema.default({}),

  eligibility: listFact.default({}),
  requiredDocuments: listFact.default({}),
  submissionMethod: textFact.default({}),
  contact: ContactSchema.default({}),

  documents: z.array(SourceDocumentSchema).default([]),
  /** Plain-language limits on what we could read, e.g. "Details need a TendersOnTime login". */
  accessLimitations: z.array(z.string()).default([]),
  /** Cautious cross-source matches: ids "source:sourceRecordId". Never auto-merged. */
  possibleDuplicateOf: z.array(z.string()).default([]),

  firstSeenAt: iso,
  lastCheckedAt: iso,
  lastUpdatedAt: iso,
  /** sha256 over the normalised content (not timestamps). Used for change detection. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TenderRecord = z.infer<typeof TenderRecordSchema>;
export type TenderRecordInput = z.input<typeof TenderRecordSchema>;

/* ---------------------------------------------------------------- scans & ingest */

export const AccessStatusSchema = z.enum([
  'ok',
  'login_required',
  'blocked_by_challenge',
  'unconfigured',
  'unreachable',
]);
export type AccessStatus = z.infer<typeof AccessStatusSchema>;

export const ScanStatusSchema = z.enum(['running', 'succeeded', 'partial', 'failed', 'blocked']);
export type ScanStatus = z.infer<typeof ScanStatusSchema>;

export const ScanFailureSchema = z.object({
  url: z.string().nullable().default(null),
  stage: z.enum(['search', 'listing', 'detail', 'document', 'parse', 'ingest', 'other']),
  error: z.string(),
  retryable: z.boolean().default(false),
});

/** What a scan actually did. Never claims "all tenders": it reports pages checked and limits. */
export const ScanReportSchema = z.object({
  scanId: z.string().min(8),
  source: z.string().min(1),
  status: ScanStatusSchema,
  accessStatus: AccessStatusSchema,
  startedAt: iso,
  finishedAt: iso.nullable().default(null),
  params: z.record(z.string(), z.unknown()).default({}),
  keywordsSearched: z.array(z.string()).default([]),
  pagesChecked: z.number().int().nonnegative().default(0),
  recordsFound: z.number().int().nonnegative().default(0),
  documentsFetched: z.number().int().nonnegative().default(0),
  failures: z.array(ScanFailureSchema).default([]),
  /** e.g. "Only notices whose title/description match the keywords were visited". */
  coverageLimitations: z.array(z.string()).default([]),
  /** Opaque cursor so an interrupted scan can resume (last keyword/page/high-water date). */
  checkpoint: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type ScanReport = z.infer<typeof ScanReportSchema>;

export const IngestV2BodySchema = z.object({
  report: ScanReportSchema,
  records: z.array(TenderRecordSchema).max(200),
});
export type IngestV2Body = z.infer<typeof IngestV2BodySchema>;

/* ---------------------------------------------------------------- search config */

export const KeywordGroupSchema = z.object({
  /** Stable id; the category this group maps to. Broad PPE is its own group. */
  id: CategorySchema,
  label: z.string(),
  terms: z.array(z.string().min(1)),
  /** Terms that must ALSO appear nearby for a match to count (context rule), optional. */
  requireContext: z.array(z.string()).default([]),
});

export const SearchConfigSchema = z.object({
  groups: z.array(KeywordGroupSchema),
  /** Global exclusion terms (e.g. "garbage truck"). A hit demotes or drops the record. */
  exclusions: z.array(z.string()).default([]),
  countries: z.array(z.string()).default([]),
  /** Only notices published on/after this ISO date are scanned (incremental scans advance it). */
  publishedSince: z.string().nullable().default(null),
});
export type SearchConfig = z.infer<typeof SearchConfigSchema>;

/* ---------------------------------------------------------------- API query */

export const TenderSortSchema = z.enum([
  'published_desc',
  'published_asc',
  /** Upcoming deadlines first (soonest), then past deadlines (most recent first), unknown last. */
  'closing_soon',
  'relevance_desc',
]);
export type TenderSort = z.infer<typeof TenderSortSchema>;
