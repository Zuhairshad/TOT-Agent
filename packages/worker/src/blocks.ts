import { daysLeft } from './days.js';
import type { TenderRow } from './types.js';

export { daysLeft };

type Block = Record<string, unknown>;
export interface SlackMessage {
  text: string;
  blocks: Block[];
}

/** Escape the three characters Slack mrkdwn treats as control characters. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'n/a';
}

export function formatDeadline(deadline: string | null, now: Date): string {
  const left = daysLeft(deadline, now);
  if (left === null) return 'No deadline listed';
  if (left < 0) return `${formatDate(deadline)} (closed)`;
  if (left === 0) return `${formatDate(deadline)} (closes today)`;
  return `${formatDate(deadline)} (${left} day${left === 1 ? '' : 's'} left)`;
}

export function parseKeywords(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** Block Kit message for one new tender. Shared by the worker and scripts/preview-slack.ts. */
export function buildTenderMessage(tender: TenderRow, now: Date): SlackMessage {
  const keywords = parseKeywords(tender.matched_keywords).join(', ') || 'n/a';
  const value =
    tender.value_text ??
    (tender.value_amount != null
      ? `${tender.value_amount} ${tender.currency ?? ''}`.trim()
      : 'n/a');
  const field = (label: string, v: string): Block => ({
    type: 'mrkdwn',
    text: `*${label}*\n${escapeMrkdwn(v)}`,
  });
  return {
    text: `New tender: ${tender.title}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*<${tender.url}|${escapeMrkdwn(tender.title)}>*` },
      },
      {
        type: 'section',
        fields: [
          field('Country', tender.country),
          field('Purchaser', tender.purchaser ?? 'n/a'),
          field('Posted', formatDate(tender.posted_at)),
          field('Deadline', formatDeadline(tender.deadline, now)),
          field('Value', value),
          field('Matched keyword', keywords),
        ],
      },
      {
        type: 'actions',
        block_id: 'tender_actions',
        elements: [
          {
            type: 'button',
            action_id: 'shortlist',
            style: 'primary',
            text: { type: 'plain_text', text: 'Shortlist' },
            value: tender.tot_ref,
          },
          {
            type: 'button',
            action_id: 'ignore',
            text: { type: 'plain_text', text: 'Ignore' },
            value: tender.tot_ref,
          },
        ],
      },
    ],
  };
}

/** Same message with the buttons swapped for a "Shortlisted by" line. */
export function buildShortlistedBlocks(original: Block[], userId: string): Block[] {
  return [
    ...original.filter((b) => b.type !== 'actions'),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Shortlisted by <@${userId}>` }] },
  ];
}

/** One-line collapsed message for an ignored tender. */
export function buildIgnoredMessage(title: string, url: string, userId: string): SlackMessage {
  const line = `~<${url}|${escapeMrkdwn(title)}>~ ignored by <@${userId}>`;
  return {
    text: `Ignored: ${title}`,
    blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: line }] }],
  };
}

export function buildSummaryMessage(extra: number, shown: number): SlackMessage {
  const text = `+${extra} more new tender${extra === 1 ? '' : 's'} (showing the ${shown} with the soonest deadlines)`;
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}
