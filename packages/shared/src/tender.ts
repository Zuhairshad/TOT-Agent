import { z } from 'zod';

export const TenderSchema = z.object({
  totRef: z.string().min(1),
  title: z.string().min(1),
  country: z.string().min(1),
  purchaser: z.string().optional(),
  postedAt: z.string().datetime(),
  deadline: z.string().datetime().nullable(),
  valueText: z.string().optional(),
  valueAmount: z.number().optional(),
  currency: z.string().optional(),
  url: z.string().url(),
  matchedKeyword: z.string().min(1),
  scrapedAt: z.string().datetime(),
});
export type Tender = z.infer<typeof TenderSchema>;

/** Body of POST /ingest. `status: "blocked"` lets the scraper report a blocked run. */
export const IngestBodySchema = z.object({
  source: z.string().default('github-actions'),
  status: z.enum(['ok', 'blocked', 'error']).default('ok'),
  note: z.string().optional(),
  tenders: z.array(TenderSchema),
});
export type IngestBody = z.infer<typeof IngestBodySchema>;
