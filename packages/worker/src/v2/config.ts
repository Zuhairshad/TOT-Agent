import { SearchConfigSchema, type SearchConfig } from '@tender-monitor/shared';
import defaultConfigJson from '../../../shared/config/search-config.default.json';
import type { Env } from '../types.js';
import { json, parseJson, readJson, fieldErrors } from './http.js';

export const CONFIG_KEY = 'search_config';
export const MAX_CONFIG_CHARS = 64_000;

const MAX_TERMS_PER_GROUP = 100;
const MAX_EXCLUSIONS = 200;
const MAX_COUNTRIES = 100;
const MAX_TERM_CHARS = 80;

export function defaultSearchConfig(): SearchConfig {
  return SearchConfigSchema.parse(defaultConfigJson);
}

/** The editable config from `settings`, or the packaged default when none was saved. */
export async function loadSearchConfig(
  env: Env,
): Promise<{ config: SearchConfig; custom: boolean }> {
  const row = await env.DB.prepare('SELECT value_json FROM settings WHERE key = ?')
    .bind(CONFIG_KEY)
    .first<{ value_json: string }>();
  if (row) {
    const parsed = SearchConfigSchema.safeParse(parseJson<unknown>(row.value_json, null));
    if (parsed.success) return { config: parsed.data, custom: true };
    console.error('settings.search_config is invalid, falling back to the default');
  }
  return { config: defaultSearchConfig(), custom: false };
}

/** Rules on top of the shared schema. Returns field errors (empty = valid). */
export function configProblems(c: SearchConfig): Record<string, string[]> {
  const problems: Record<string, string[]> = {};
  const add = (k: string, m: string) => (problems[k] ??= []).push(m);
  const ids = c.groups.map((g) => g.id);
  if (new Set(ids).size !== ids.length) add('groups', 'group ids must be unique');
  const owner = new Map<string, string>();
  c.groups.forEach((g, gi) => {
    if (g.terms.length > MAX_TERMS_PER_GROUP)
      add(`groups.${gi}.terms`, `at most ${MAX_TERMS_PER_GROUP} terms`);
    if (g.requireContext.length > MAX_TERMS_PER_GROUP)
      add(`groups.${gi}.requireContext`, `at most ${MAX_TERMS_PER_GROUP} terms`);
    for (const t of [...g.terms, ...g.requireContext]) {
      if (t.length > MAX_TERM_CHARS)
        add(`groups.${gi}.terms`, `term longer than ${MAX_TERM_CHARS} chars`);
    }
    for (const t of g.terms) {
      const key = t.trim().toLowerCase();
      const other = owner.get(key);
      // Broad PPE must stay separate from motorcycle gear: the same term may not sit in both.
      if (other && other !== g.id) {
        add(`groups.${gi}.terms`, `"${t}" is already in group "${other}"; keep broad PPE separate`);
      }
      owner.set(key, g.id);
    }
  });
  if (c.exclusions.length > MAX_EXCLUSIONS) add('exclusions', `at most ${MAX_EXCLUSIONS} terms`);
  if (c.exclusions.some((t) => t.length > MAX_TERM_CHARS))
    add('exclusions', `term longer than ${MAX_TERM_CHARS} chars`);
  if (c.countries.length > MAX_COUNTRIES) add('countries', `at most ${MAX_COUNTRIES} countries`);
  if (c.publishedSince !== null && Number.isNaN(Date.parse(c.publishedSince))) {
    add('publishedSince', 'must be an ISO date or null');
  }
  return problems;
}

export async function handleGetConfig(env: Env): Promise<Response> {
  const { config, custom } = await loadSearchConfig(env);
  return json({ config, custom });
}

export async function handlePutConfig(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, MAX_CONFIG_CHARS);
  if (!body.ok) return body.response;
  const raw = (body.value as { config?: unknown } | null)?.config ?? body.value;
  const parsed = SearchConfigSchema.safeParse(raw);
  if (!parsed.success)
    return json({ error: 'invalid_body', fields: fieldErrors(parsed.error) }, 400);
  const problems = configProblems(parsed.data);
  if (Object.keys(problems).length) return json({ error: 'invalid_body', fields: problems }, 400);
  await env.DB.prepare(
    `INSERT INTO settings (key, value_json) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
  )
    .bind(CONFIG_KEY, JSON.stringify(parsed.data))
    .run();
  return json({ config: parsed.data, custom: true });
}
