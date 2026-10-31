import type { Evidence, TenderDetailResponse, TenderVersion, VersionChange } from '../api/types';
import { errorMessage, type AppContext } from '../context';
import {
  DOC_STATUS_LABELS,
  MONEY_LABELS,
  NOT_PUBLISHED,
  factText,
  formatChangeValue,
  formatDate,
  formatDateTimeUtc,
  formatDeadline,
  formatMoney,
  listGaps,
  type MoneyKey,
} from '../format';
import {
  categoryChips,
  dateValue,
  deadlineValue,
  field,
  itemsTable,
  missingTag,
  moneyValue,
  starButton,
  statusBadge,
} from '../ui/components';
import { clear, h, link, notice, type Child } from '../ui/dom';

function section(title: string, ...body: Child[]): HTMLElement {
  return h('section', { class: 'panel' }, h('h3', {}, title), ...body);
}

function textFact(f: Parameters<typeof factText>[0]) {
  const t = factText(f);
  return t.missing ? missingTag(t.text) : h('span', { class: 'prose' }, t.text);
}

function listFact(f: Parameters<typeof factText>[0]): HTMLElement {
  if (!f.value || f.value.length === 0) return missingTag(factText(f).text);
  const items = Array.isArray(f.value) ? f.value : [f.value];
  return h(
    'ul',
    { class: 'plain-list' },
    items.map((x) => h('li', {}, x)),
  );
}

export function dateBlock(f: Parameters<typeof formatDate>[0], deadline: boolean): HTMLElement {
  const d = deadline ? formatDeadline(f) : formatDate(f);
  const out = h(
    'div',
    { class: 'date-block' },
    deadline ? deadlineValue(d as ReturnType<typeof formatDeadline>) : dateValue(d),
  );
  if (d.original) out.append(h('div', { class: 'muted' }, `As published: “${d.original}”`));
  if (!d.missing) {
    out.append(
      h(
        'div',
        { class: 'muted' },
        d.timezone ? `Timezone stated: ${d.timezone}` : 'No timezone stated (shown in UTC)',
      ),
    );
  }
  if (d.ambiguous)
    out.append(
      h(
        'div',
        { class: 'notice notice-warn inline', role: 'note' },
        'This date is ambiguous: the source text can be read more than one way (day/month order, missing year or timezone). Check the source before relying on it.',
      ),
    );
  return out;
}

function evidenceItem(e: Evidence): HTMLElement {
  return h(
    'li',
    {},
    e.quote ? h('blockquote', {}, e.quote) : h('span', { class: 'muted' }, 'No quote saved'),
    h(
      'div',
      { class: 'muted' },
      'Source: ',
      link(e.documentUrl ?? e.sourceUrl),
      e.page ? ` (page ${e.page})` : '',
      ` · retrieved ${formatDateTimeUtc(e.retrievedAt)}`,
    ),
  );
}

export function evidenceSection(r: TenderDetailResponse['record']): HTMLElement {
  const groups: [string, Evidence[]][] = [
    ['Status', r.statusEvidence],
    ['Reference', r.reference.evidence],
    ['Buyer', r.buyer.evidence],
    ['Country', r.country.evidence],
    ['Published date', r.publishedAt.evidence],
    ['Deadline', r.deadline.evidence],
    [MONEY_LABELS.estimatedValue, r.estimatedValue.evidence],
    [MONEY_LABELS.awardValue, r.awardValue.evidence],
    [MONEY_LABELS.tenderFee, r.tenderFee.evidence],
    [MONEY_LABELS.bidSecurity, r.bidSecurity.evidence],
    ['Scope of supply', r.scopeOfSupply.evidence],
    ['Eligibility', r.eligibility.evidence],
    ['Required documents', r.requiredDocuments.evidence],
    ['Submission method', r.submissionMethod.evidence],
  ];
  const withEvidence = groups.filter(([, e]) => e.length > 0);
  if (withEvidence.length === 0)
    return section(
      'Evidence',
      h('p', { class: 'muted' }, 'No supporting quotes were saved for this record.'),
    );
  return section(
    'Evidence',
    h(
      'p',
      { class: 'muted' },
      'Where the important facts were read. Expand a fact to see the quote.',
    ),
    withEvidence.map(([label, ev]) =>
      h(
        'details',
        { class: 'evidence' },
        h('summary', {}, `${label} (${ev.length})`),
        h('ul', { class: 'plain-list' }, ev.map(evidenceItem)),
      ),
    ),
  );
}

const KIND_LABELS: Record<string, string> = {
  deadline_extended: 'Deadline extended',
  deadline_changed: 'Deadline changed',
  cancelled: 'Cancelled',
  status_changed: 'Status changed',
  amendment: 'Amendment',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

const FLAG_LABELS: Record<string, string> = {
  older_notice: 'Older notice, kept for reference (not the current record)',
  conflict: 'Conflicts with the current record, needs a human decision',
};

function changeRow(c: VersionChange): HTMLElement {
  const important = /deadline|cancel|status/i.test(`${c.kind} ${c.field}`);
  return h(
    'li',
    { class: important ? 'change important' : 'change' },
    h('strong', {}, kindLabel(c.kind)),
    ` – ${c.field}: `,
    h('span', { class: 'old' }, formatChangeValue(c.old)),
    ' → ',
    h('span', { class: 'new' }, formatChangeValue(c.new)),
  );
}

export function versionHistory(versions: TenderVersion[]): HTMLElement {
  if (versions.length === 0)
    return section('Version history', h('p', { class: 'muted' }, 'No versions recorded.'));
  return section(
    'Version history',
    h(
      'ol',
      { class: 'versions' },
      [...versions]
        .sort((a, b) => Number(b.version) - Number(a.version))
        .map((v) =>
          h(
            'li',
            {},
            h('strong', {}, `Version ${v.version}`),
            ` · seen ${formatDateTimeUtc(v.seenAt)}`,
            v.flag ? [' ', h('span', { class: 'warn-tag' }, FLAG_LABELS[v.flag] ?? v.flag)] : null,
            v.changes.length
              ? h('ul', { class: 'plain-list' }, v.changes.map(changeRow))
              : h('div', { class: 'muted' }, 'First version or no tracked changes.'),
          ),
        ),
    ),
  );
}

export function renderDetailBody(data: TenderDetailResponse, ctx: AppContext): HTMLElement {
  const r = data.record;
  const id = `${r.source}:${r.sourceRecordId}`;
  const root = h('div', { class: 'detail' });

  root.append(
    h(
      'header',
      { class: 'detail-head' },
      h('h2', {}, r.title),
      h(
        'div',
        { class: 'detail-actions' },
        statusBadge(r.status),
        starButton(id, ctx.store, (e) => ctx.flash(errorMessage(e) ?? 'Not signed in', 'error')),
        h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: (ev: Event) => {
              const b = ev.currentTarget as HTMLButtonElement;
              b.disabled = true;
              ctx.exportPdf([id]).finally(() => {
                b.disabled = false;
              });
            },
          },
          'Export PDF',
        ),
        h(
          'a',
          { class: 'btn', href: r.canonicalUrl, target: '_blank', rel: 'noopener noreferrer' },
          'Open source page',
        ),
      ),
    ),
  );
  if (r.status === 'unknown')
    root.append(
      notice(
        'info',
        'Status is not stated by the source. An unknown deadline does not mean the tender is open.',
      ),
    );

  if (r.accessLimitations.length) {
    root.append(
      h(
        'div',
        { class: 'notice notice-warn', role: 'note' },
        h('strong', {}, 'Access limitations. '),
        'Some details could not be read:',
        h(
          'ul',
          {},
          r.accessLimitations.map((l) => h('li', {}, l)),
        ),
      ),
    );
  }

  root.append(
    section(
      'Key facts',
      h(
        'dl',
        { class: 'fields wide' },
        field('Reference', textFact(r.reference)),
        field('Buyer', textFact(r.buyer)),
        field('Country', textFact(r.country)),
        field('Delivery location', textFact(r.deliveryLocation)),
        field('Notice type', r.noticeType ?? missingTag(NOT_PUBLISHED)),
        field('Source', `${r.source} (${r.sourceRecordId})`),
        field('Published', dateBlock(r.publishedAt, false)),
        field('Deadline', dateBlock(r.deadline, true)),
        field('Last retrieved', formatDateTimeUtc(r.lastCheckedAt)),
        field('First seen', formatDateTimeUtc(r.firstSeenAt)),
      ),
      categoryChips(r.categories),
      h(
        'p',
        { class: 'why' },
        h('strong', {}, 'Why it matched: '),
        r.relevance.explanation || NOT_PUBLISHED,
      ),
    ),
  );

  // Missing-data summary (same function as the PDF's gap box).
  const gaps = listGaps(r);
  root.append(
    h(
      'section',
      { class: 'panel gaps' },
      h('h3', {}, `Missing data (${gaps.length})`),
      gaps.length === 0
        ? h('p', {}, 'No gaps: every field was published.')
        : h(
            'ul',
            { class: 'plain-list' },
            gaps.map((g) => h('li', {}, h('strong', {}, `${g.field}: `), missingTag(g.label))),
          ),
      data.conflictingData?.length
        ? h('p', { class: 'warn-tag' }, `Sources disagree on: ${data.conflictingData.join(', ')}`)
        : null,
    ),
  );

  root.append(section('Scope of supply', textFact(r.scopeOfSupply)));

  if (r.lots.length)
    root.append(
      section(
        `Lots (${r.lots.length})`,
        h(
          'ul',
          { class: 'plain-list' },
          r.lots.map((l) =>
            h(
              'li',
              {},
              h('strong', {}, `Lot ${l.lotNo}`),
              l.title ? `: ${l.title}` : '',
              l.description ? ` – ${l.description}` : '',
            ),
          ),
        ),
      ),
    );

  root.append(section(`Items (${r.items.length})`, itemsTable(r.items)));
  root.append(section('Delivery schedule', textFact(r.deliverySchedule)));

  const money = (Object.keys(MONEY_LABELS) as MoneyKey[]).map((k) => {
    const m = formatMoney(r[k]);
    return h(
      'div',
      { class: 'money-box' },
      h('div', { class: 'money-label' }, MONEY_LABELS[k]),
      h('div', {}, moneyValue(m)),
      m.original ? h('div', { class: 'muted' }, `As published: “${m.original}”`) : null,
      r[k].status === 'conflicting' ? h('div', { class: 'warn-tag' }, 'Sources disagree') : null,
    );
  });
  root.append(
    section(
      'Money',
      h(
        'p',
        { class: 'muted' },
        'Four different things, never merged. Unknown means unknown, not zero.',
      ),
      h('div', { class: 'money-grid' }, money),
    ),
  );

  root.append(section('Eligibility', listFact(r.eligibility)));
  root.append(section('Required documents', listFact(r.requiredDocuments)));
  root.append(
    section(
      'Submission',
      h(
        'dl',
        { class: 'fields wide' },
        field('Method', textFact(r.submissionMethod)),
        field('Contact', textFact(r.contact.name)),
        field('Email', textFact(r.contact.email)),
        field('Phone', textFact(r.contact.phone)),
        field('Address', textFact(r.contact.address)),
      ),
    ),
  );

  root.append(
    section(
      'Source links',
      h('p', {}, 'Notice page: ', link(r.canonicalUrl)),
      r.documents.length === 0
        ? h('p', { class: 'muted' }, 'No documents listed.')
        : h(
            'ul',
            { class: 'plain-list' },
            r.documents.map((d) =>
              h(
                'li',
                {},
                link(d.url, d.title ?? d.url),
                ' ',
                h(
                  'span',
                  { class: d.status === 'retrieved' ? 'doc-status ok' : 'doc-status bad' },
                  DOC_STATUS_LABELS[d.status] ?? d.status,
                ),
                d.needsReview ? [' ', h('span', { class: 'warn-tag' }, 'Needs review')] : null,
                d.error ? h('div', { class: 'muted' }, d.error) : null,
              ),
            ),
          ),
      r.possibleDuplicateOf.length
        ? h(
            'p',
            { class: 'muted' },
            `Possible duplicate of: ${r.possibleDuplicateOf.join(', ')} (not merged)`,
          )
        : null,
    ),
  );

  root.append(evidenceSection(r));
  root.append(versionHistory(data.versions));
  return root;
}

export function renderDetail(root: HTMLElement, ctx: AppContext, id: string): () => void {
  let alive = true;
  const body = h('div', {}, h('p', {}, 'Loading...'));
  root.append(h('p', {}, h('a', { href: '#/' }, '← Back to tenders')), body);
  ctx.api.getTender(id).then(
    (data) => {
      if (!alive) return;
      ctx.store.seed(id, data.shortlisted);
      clear(body);
      body.append(renderDetailBody(data, ctx));
    },
    (e) => {
      if (!alive) return;
      clear(body);
      const msg = errorMessage(e);
      if (msg) body.append(notice('error', `Could not load this tender: ${msg}`));
    },
  );
  return () => {
    alive = false;
  };
}
