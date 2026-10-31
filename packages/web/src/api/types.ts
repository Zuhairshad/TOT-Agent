import type {
  Category,
  Evidence,
  LineItem,
  FactStatus,
  SearchConfig,
  TenderRecord,
  TenderSort,
  TenderStatus,
} from '@tender-monitor/shared';

export type {
  Category,
  Evidence,
  LineItem,
  FactStatus,
  SearchConfig,
  TenderRecord,
  TenderSort,
  TenderStatus,
};

/** Date fact as the list endpoint returns it (a slim version of DateFact). */
export interface ListDate {
  value: string | null;
  originalText: string | null;
  status: FactStatus;
  ambiguous: boolean;
  timezone?: string | null;
}

export interface ListMoney {
  amount: number | null;
  currency: string | null;
  originalText: string | null;
  status: FactStatus;
}

export interface TenderListItem {
  id: string;
  source: string;
  title: string;
  reference: string | null;
  buyer: string | null;
  country: string | null;
  publishedAt: ListDate;
  deadline: ListDate;
  deadlineKnown: boolean;
  status: TenderStatus;
  noticeType: string | null;
  categories: Category[];
  relevance: { score: number; explanation: string; groups: string[] };
  estimatedValue: ListMoney;
  awardValue: ListMoney;
  shortlisted: boolean;
  canonicalUrl: string;
}

export interface TenderListResponse {
  items: TenderListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface VersionChange {
  field: string;
  old: unknown;
  new: unknown;
  kind: string;
}

export interface TenderVersion {
  version: number | string;
  seenAt: string;
  changes: VersionChange[];
  /** 'older_notice' | 'conflict' for a version stored but not shown as the live record. */
  flag?: string | null;
  isCurrent?: boolean;
}

export interface TenderDetailResponse {
  record: TenderRecord;
  versions: TenderVersion[];
  shortlisted: boolean;
  shortlistNote?: string | null;
  /** Server's list of facts with no value (keys such as "buyer", "items.quantity"). */
  missingData: string[];
  missingDetails?: Record<string, string>;
  /** Facts whose sources disagree. */
  conflictingData?: string[];
}

export interface ScanFailure {
  url?: string | null;
  stage?: string;
  error: string;
  retryable?: boolean;
}

/** One scan row, as the UI uses it (normalised from the Worker's scan object in normalize.ts). */
export interface ScanSummary {
  scanId?: string;
  source: string;
  status: string;
  accessStatus?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  pagesChecked?: number;
  recordsFound?: number;
  recordsNew?: number;
  recordsUpdated?: number;
  failures?: ScanFailure[] | number;
  coverageLimitations?: string[];
}

export interface SourceStatus {
  /** The source name (the Worker calls this field `source`). */
  id: string;
  accessStatus: string;
  /** When the last succeeded/partial scan finished (null = never). */
  lastSuccessfulScan: string | null;
  lastScan: {
    status: string;
    pagesChecked: number;
    recordsFound: number;
    recordsNew?: number;
    recordsUpdated?: number;
    failures: ScanFailure[] | number;
    coverageLimitations: string[];
    startedAt?: string | null;
    finishedAt: string | null;
  } | null;
  recordCount?: number;
  /** True while a scan of this source is running (the Worker's own flag). */
  running?: boolean;
  lastFailure?: { at: string | null; status: string; message: string | null } | null;
}

export interface ScansResponse {
  scans: ScanSummary[];
  sources: SourceStatus[];
}
