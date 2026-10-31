import type { SearchConfig } from '../api/types';
import { errorMessage, type AppContext } from '../context';
import { chipEditor, type ChipEditor } from '../ui/chips';
import { clear, h, nextId, notice } from '../ui/dom';

/** Build a SearchConfig from the editors (pure given the editor values). */
export function collectConfig(
  base: SearchConfig,
  groups: {
    id: SearchConfig['groups'][number]['id'];
    label: string;
    terms: ChipEditor;
    ctx: ChipEditor;
  }[],
  exclusions: ChipEditor,
  countries: ChipEditor,
  publishedSince: string,
): SearchConfig {
  return {
    ...base,
    groups: groups.map((g) => ({
      id: g.id,
      label: g.label,
      terms: g.terms.values(),
      requireContext: g.ctx.values(),
    })),
    exclusions: exclusions.values(),
    countries: countries.values(),
    publishedSince: publishedSince.trim() ? publishedSince.trim() : null,
  };
}

export function renderSettings(root: HTMLElement, ctx: AppContext): () => void {
  let alive = true;
  const body = h('div', {}, h('p', {}, 'Loading...'));
  root.append(
    h('h2', {}, 'Search settings'),
    h(
      'p',
      { class: 'muted' },
      'These keywords and exclusions are used by the next scans. Changing them does not re-score tenders already stored.',
    ),
    body,
  );

  ctx.api.getConfig().then(
    (cfg) => {
      if (!alive) return;
      clear(body);
      const groups = cfg.groups.map((g) => ({
        id: g.id,
        label: g.label,
        terms: chipEditor('Terms', g.terms),
        ctx: chipEditor('Must also appear nearby (optional context words)', g.requireContext ?? []),
      }));
      const exclusions = chipEditor(
        'Exclusion words (a hit demotes or drops the tender)',
        cfg.exclusions,
      );
      const countries = chipEditor('Countries (empty = all)', cfg.countries);
      const sinceId = nextId('since');
      const since = h('input', {
        id: sinceId,
        type: 'date',
        value: cfg.publishedSince?.slice(0, 10) ?? '',
      });
      const msg = h('div', { 'aria-live': 'polite' });
      const save = h('button', { type: 'submit', class: 'btn primary' }, 'Save settings');
      const form = h(
        'form',
        { class: 'settings' },
        groups.map((g) =>
          h('fieldset', { class: 'panel' }, h('legend', {}, g.label), g.terms.el, g.ctx.el),
        ),
        h('fieldset', { class: 'panel' }, h('legend', {}, 'Exclusions'), exclusions.el),
        h('fieldset', { class: 'panel' }, h('legend', {}, 'Countries'), countries.el),
        h(
          'div',
          { class: 'control' },
          h('label', { for: sinceId }, 'Only scan notices published on or after'),
          since,
        ),
        msg,
        save,
      );
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        save.disabled = true;
        clear(msg);
        ctx.api
          .putConfig(collectConfig(cfg, groups, exclusions, countries, since.value))
          .then(
            () => msg.append(notice('info', 'Settings saved.')),
            (err) => {
              const m = errorMessage(err);
              if (m) msg.append(notice('error', `Could not save: ${m}`));
            },
          )
          .finally(() => {
            save.disabled = false;
          });
      });
      body.append(form);
    },
    (e) => {
      if (!alive) return;
      clear(body);
      const m = errorMessage(e);
      if (m) body.append(notice('error', `Could not load settings: ${m}`));
    },
  );
  return () => {
    alive = false;
  };
}
