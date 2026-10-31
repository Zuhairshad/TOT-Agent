import { z } from 'zod';
import { toBase64 } from './base64.js';
import { ExtractedTenderSchema, type ExtractedTender } from './extracted.js';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/** Claude PDF limits: 32 MB request, 100 pages. We stay well under the Worker's 128 MB memory. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export const EXTRACTION_PROMPT = `You are reading a tender document (PDF). Extract the data below and reply with ONE JSON object and nothing else: no prose, no markdown fences.

Rules:
- Copy numbers, dates, names, references and amounts EXACTLY as written in the document. Never estimate, convert, round or guess.
- If something is not in the document, set that field to null (or [] for lists) and add its field name to "missing". Every null or empty field MUST be named in "missing".
- Put each line item in "items", in document order. Copy descriptions, specifications, units and quantities exactly; use null for parts that are not stated.
- "eligibility" is the list of eligibility / qualification requirements, one string each.
- "notes" is anything else a bidder must not overlook (short, copied from the document), or null.

JSON shape:
{
  "tenderTitle": string|null,
  "purchaser": string|null,
  "referenceNo": string|null,
  "submissionDeadline": string|null,
  "bidSecurity": string|null,
  "deliveryLocation": string|null,
  "deliveryPeriod": string|null,
  "eligibility": string[],
  "items": [{ "lineNo": string|number|null, "description": string, "specification": string|null, "unit": string|null, "quantity": string|number|null }],
  "estimatedValue": string|null,
  "notes": string|null,
  "missing": string[]
}`;

export class ExtractionError extends Error {}

export interface ExtractOptions {
  apiKey: string | undefined;
  model: string | undefined;
  pdf: Uint8Array;
  /** Total attempts (default 2 = one retry after invalid JSON). */
  attempts?: number;
}

/** Pulls the JSON object out of a reply, tolerating ```json fences or stray prose around it. */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new SyntaxError('reply is not JSON');
  }
}

interface ClaudeReply {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  error?: { message?: string };
}

/**
 * Sends the PDF to Claude as a base64 document block and returns validated JSON.
 * Invalid JSON / failed validation is retried once (the second prompt includes
 * what was wrong); HTTP errors are not retried. The network wait is not CPU time.
 */
export async function extractTender(opts: ExtractOptions): Promise<ExtractedTender> {
  if (!opts.apiKey) throw new ExtractionError('ANTHROPIC_API_KEY is not set');
  if (!opts.model) throw new ExtractionError('CLAUDE_MODEL is not set');
  if (opts.pdf.byteLength > MAX_PDF_BYTES) {
    throw new ExtractionError(
      `PDF is ${(opts.pdf.byteLength / 1048576).toFixed(1)} MB; the limit is ${MAX_PDF_BYTES / 1048576} MB`,
    );
  }
  const data = toBase64(opts.pdf);
  const attempts = opts.attempts ?? 2;
  let lastProblem = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const prompt =
      attempt === 1
        ? EXTRACTION_PROMPT
        : `${EXTRACTION_PROMPT}\n\nYour previous reply was rejected: ${lastProblem}\nReply again with valid JSON only.`;
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 16000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });
    const reply = (await res.json().catch(() => ({}))) as ClaudeReply;
    if (!res.ok) {
      throw new ExtractionError(
        `Claude API error ${res.status}: ${reply.error?.message ?? 'no details'}`,
      );
    }
    const text = (reply.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (reply.stop_reason === 'max_tokens') {
      lastProblem = 'the reply was cut off (too long)';
      continue;
    }
    try {
      return ExtractedTenderSchema.parse(parseJsonReply(text));
    } catch (err) {
      lastProblem =
        err instanceof z.ZodError
          ? err.issues
              .slice(0, 5)
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; ')
          : err instanceof Error
            ? err.message
            : String(err);
    }
  }
  throw new ExtractionError(
    `Claude's answer was not valid after ${attempts} attempts: ${lastProblem}`,
  );
}
