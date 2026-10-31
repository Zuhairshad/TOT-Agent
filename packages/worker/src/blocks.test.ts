import { describe, expect, it } from 'vitest';
import {
  buildIgnoredMessage,
  buildShortlistedBlocks,
  buildSummaryMessage,
  buildTenderMessage,
  daysLeft,
  escapeMrkdwn,
} from './blocks.js';
import { sampleRow } from '../test/fixtures.js';

const NOW = new Date('2026-10-30T00:00:00.000Z');

describe('blocks', () => {
  it('matches the Slack payload snapshot', () => {
    expect(buildTenderMessage(sampleRow, NOW)).toMatchSnapshot();
  });
  it('has Shortlist and Ignore buttons carrying tot_ref', () => {
    const actions = buildTenderMessage(sampleRow, NOW).blocks.find((b) => b.type === 'actions') as {
      elements: Array<{ action_id: string; value: string }>;
    };
    expect(actions.elements.map((e) => [e.action_id, e.value])).toEqual([
      ['shortlist', 'TOT-1001'],
      ['ignore', 'TOT-1001'],
    ]);
  });
  it('escapes mrkdwn and computes days left', () => {
    expect(escapeMrkdwn('a<b>&')).toBe('a&lt;b&gt;&amp;');
    expect(daysLeft('2026-11-15T12:00:00.000Z', NOW)).toBe(17);
    expect(daysLeft(null, NOW)).toBeNull();
    expect(JSON.stringify(buildTenderMessage({ ...sampleRow, deadline: null }, NOW))).toContain(
      'No deadline listed',
    );
  });
  it('replaces buttons when shortlisted, shrinks when ignored', () => {
    const msg = buildTenderMessage(sampleRow, NOW);
    const blocks = buildShortlistedBlocks(msg.blocks, 'U1');
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(JSON.stringify(blocks)).toContain('Shortlisted by <@U1>');
    expect(buildIgnoredMessage('T', 'https://x', 'U2').blocks).toHaveLength(1);
    expect(buildSummaryMessage(5, 15).text).toContain('+5 more');
  });
});
