import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const KeywordsSchema = z.array(z.string().trim().min(1)).min(1);

export async function loadKeywords(file: string): Promise<string[]> {
  const raw = await readFile(file, 'utf8');
  const parsed = KeywordsSchema.parse(JSON.parse(raw));
  return [...new Set(parsed)];
}
