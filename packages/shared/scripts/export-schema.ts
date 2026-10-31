import { mkdirSync, writeFileSync } from 'node:fs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  IngestV2BodySchema,
  ScanReportSchema,
  SearchConfigSchema,
  TenderRecordSchema,
} from '../src/record.js';

const out = new URL('../schema/', import.meta.url);
mkdirSync(out, { recursive: true });
const targets = {
  'tender-record': TenderRecordSchema,
  'scan-report': ScanReportSchema,
  'ingest-v2': IngestV2BodySchema,
  'search-config': SearchConfigSchema,
} as const;
for (const [name, schema] of Object.entries(targets)) {
  const json = zodToJsonSchema(schema, { name, $refStrategy: 'none', target: 'jsonSchema7' });
  writeFileSync(new URL(`${name}.schema.json`, out), JSON.stringify(json, null, 2) + '\n');
  console.log('wrote', `schema/${name}.schema.json`);
}
