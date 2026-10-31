import type { TenderRecord } from '@tender-monitor/shared';

export interface MissingReport {
  /** Field names the UI should flag as "not available", e.g. ['deadline', 'items.quantity']. */
  missingData: string[];
  /** field -> why: not_published | could_not_verify | conflicting is listed separately. */
  missingDetails: Record<string, string>;
  /** Facts where two sources/documents disagree. */
  conflictingData: string[];
}

const empty = (v: unknown) => v === null || v === undefined || v === '';

/**
 * Which important facts are absent. "Absent" means the VALUE is null (never a made-up 0): the
 * fact's status then says whether the source omitted it (not_published) or we could not read the
 * place where it would be (could_not_verify, e.g. behind a login).
 */
export function computeMissing(r: TenderRecord): MissingReport {
  const missing: Record<string, string> = {};
  const conflicting: string[] = [];
  const fact = (name: string, value: unknown, status: string) => {
    if (status === 'conflicting') conflicting.push(name);
    if (empty(value)) missing[name] = status === 'conflicting' ? 'could_not_verify' : status;
  };
  fact('reference', r.reference.value, r.reference.status);
  fact('buyer', r.buyer.value, r.buyer.status);
  fact('country', r.country.value, r.country.status);
  fact('publishedAt', r.publishedAt.value, r.publishedAt.status);
  fact('deadline', r.deadline.value, r.deadline.status);
  fact('estimatedValue', r.estimatedValue.amount, r.estimatedValue.status);
  // An award value only exists for award notices; do not flag it on open tenders.
  if (/award/i.test(r.noticeType ?? '') || !empty(r.awardValue.amount)) {
    fact('awardValue', r.awardValue.amount, r.awardValue.status);
  }
  fact('scopeOfSupply', r.scopeOfSupply.value, r.scopeOfSupply.status);
  if (r.items.length === 0) missing['items'] = 'not_published';
  else if (r.items.some((i) => empty(i.quantity.value)))
    missing['items.quantity'] = 'not_published';
  if (r.documents.some((d) => d.status !== 'retrieved')) missing['documents'] = 'could_not_verify';
  return {
    missingData: Object.keys(missing),
    missingDetails: missing,
    conflictingData: conflicting,
  };
}
