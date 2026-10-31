import { z } from 'zod';

/**
 * What Claude must return for an uploaded tender document. Lives in the worker
 * (not packages/shared) because only the worker and its local script use it;
 * it is not part of the scraper <-> worker contract.
 *
 * Scalars that are not in the document are `null`, and their key must then be
 * listed in `missing`, so "not found" is explicit and never an invented value.
 */
const text = z.string().nullable();
const textOrNumber = z.union([z.string(), z.number()]).nullable();

export const ExtractedItemSchema = z.object({
  lineNo: textOrNumber,
  description: z.string().min(1),
  specification: text,
  unit: text,
  quantity: textOrNumber,
});

const SCALAR_KEYS = [
  'tenderTitle',
  'purchaser',
  'referenceNo',
  'submissionDeadline',
  'bidSecurity',
  'deliveryLocation',
  'deliveryPeriod',
  'estimatedValue',
  'notes',
] as const;

export const ExtractedTenderSchema = z
  .object({
    tenderTitle: text,
    purchaser: text,
    referenceNo: text,
    submissionDeadline: text,
    bidSecurity: text,
    deliveryLocation: text,
    deliveryPeriod: text,
    eligibility: z.array(z.string()),
    items: z.array(ExtractedItemSchema),
    estimatedValue: text,
    notes: text,
    missing: z.array(z.string()),
  })
  .superRefine((v, ctx) => {
    const listed = new Set(v.missing.map((m) => m.trim().toLowerCase()));
    for (const key of SCALAR_KEYS) {
      if ((v[key] === null || v[key].trim() === '') && !listed.has(key.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['missing'],
          message: `"${key}" is empty but is not listed in "missing"`,
        });
      }
    }
    if (v.eligibility.length === 0 && !listed.has('eligibility')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['missing'],
        message: '"eligibility" is empty but is not listed in "missing"',
      });
    }
    if (v.items.length === 0 && !listed.has('items')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['missing'],
        message: '"items" is empty but is not listed in "missing"',
      });
    }
  });

export type ExtractedTender = z.infer<typeof ExtractedTenderSchema>;
export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;
