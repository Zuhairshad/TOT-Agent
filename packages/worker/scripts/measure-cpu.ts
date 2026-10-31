// Indicative CPU measurement of the heavy steps in plain Node (NOT real Workers numbers).
// Usage: pnpm --filter @tender-monitor/worker measure:cpu
import { toBase64, toBase64Chunked } from '../src/base64.js';
import { buildTenderPdf } from '../src/pdf-builder.js';
import { FIXTURE, makeItems } from '../test/fixture-tender.js';

const meta = {
  totRef: 'TOT-1001',
  title: 't',
  sourceUrl: 'https://example.com/1',
  generatedAt: new Date(),
};

async function measure(label: string, fn: () => Promise<unknown> | unknown, runs = 20) {
  await fn(); // warm-up (JIT, font parsing caches)
  const cold: number[] = [];
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await fn();
    cold.push(performance.now() - s);
  }
  const wall = (performance.now() - t0) / runs;
  const c = process.cpuUsage(cpu0);
  const cpu = (c.user + c.system) / 1000 / runs;
  cold.sort((a, b) => a - b);
  console.log(
    `${label.padEnd(34)} cpu ${cpu.toFixed(1).padStart(7)} ms  wall ${wall.toFixed(1).padStart(7)} ms  p50 ${(cold[Math.floor(runs / 2)] as number).toFixed(1)} ms`,
  );
}

async function firstRun(label: string, fn: () => Promise<unknown>) {
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  await fn();
  const c = process.cpuUsage(cpu0);
  console.log(
    `${label.padEnd(34)} cpu ${((c.user + c.system) / 1000).toFixed(1).padStart(7)} ms  wall ${(performance.now() - t0).toFixed(1).padStart(7)} ms (cold, first call)`,
  );
}

await firstRun('buildTenderPdf, 2 items (cold)', () => buildTenderPdf(FIXTURE, meta));
for (const n of [1, 10, 60]) {
  await measure(`buildTenderPdf, ${n} items (warm)`, () =>
    buildTenderPdf({ ...FIXTURE, items: makeItems(n) }, meta),
  );
}
for (const mb of [1, 5, 20]) {
  const bytes = Uint8Array.from({ length: mb * 1024 * 1024 }, (_, i) => i & 255);
  await measure(`toBase64 (native), ${mb} MB`, () => toBase64(bytes), 5);
  await measure(`toBase64Chunked (btoa), ${mb} MB`, () => toBase64Chunked(bytes), 3);
}
const big = JSON.stringify({ ...FIXTURE, items: makeItems(2000) });
await measure(`JSON.parse, ${(big.length / 1024).toFixed(0)} KB`, () => JSON.parse(big), 20);
