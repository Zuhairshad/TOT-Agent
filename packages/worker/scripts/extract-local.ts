// Runs the extraction + PDF build locally on a real tender PDF (no Slack, no D1).
// Usage:
//   ANTHROPIC_API_KEY=... CLAUDE_MODEL=... \
//     pnpm --filter @tender-monitor/worker extract:local -- path/to/tender.pdf [outDir]
// Prints the extracted JSON; writes <outDir>/summary.pdf and, if `pdftoppm` is installed,
// <outDir>/summary.png (page 1). outDir defaults to ./test-results/local (git-ignored).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractTender } from '../src/claude.js';
import { buildTenderPdf } from '../src/pdf-builder.js';

async function main(): Promise<number> {
  const [pdfPath, outArg] = process.argv.slice(2).filter((a) => a !== '--');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.CLAUDE_MODEL;
  if (!pdfPath || !apiKey || !model) {
    console.error(
      'Usage: ANTHROPIC_API_KEY=... CLAUDE_MODEL=... tsx scripts/extract-local.ts <file.pdf> [outDir]\n' +
        [
          !pdfPath && '  missing: PDF path',
          !apiKey && '  missing: env ANTHROPIC_API_KEY',
          !model && '  missing: env CLAUDE_MODEL',
        ]
          .filter(Boolean)
          .join('\n'),
    );
    return 1;
  }
  let pdf: Uint8Array;
  try {
    pdf = new Uint8Array(readFileSync(pdfPath));
  } catch (err) {
    console.error(`Cannot read ${pdfPath}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  try {
    const details = await extractTender({ apiKey, model, pdf });
    console.log(JSON.stringify(details, null, 2));

    const outDir = outArg ?? path.join('test-results', 'local');
    mkdirSync(outDir, { recursive: true });
    const t0 = performance.now();
    const cpu0 = process.cpuUsage();
    const out = await buildTenderPdf(details, {
      totRef: 'LOCAL-RUN',
      title: path.basename(pdfPath),
      sourceUrl: `file://${path.resolve(pdfPath)}`,
      generatedAt: new Date(),
    });
    const cpu = process.cpuUsage(cpu0);
    console.error(
      `PDF built: ${(performance.now() - t0).toFixed(0)} ms wall, ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms CPU (Node, cold)`,
    );
    const pdfOut = path.join(outDir, 'summary.pdf');
    writeFileSync(pdfOut, out);
    console.error(`Wrote ${pdfOut}`);
    if (spawnSync('which', ['pdftoppm']).status === 0) {
      execFileSync('pdftoppm', [
        '-png',
        '-r',
        '110',
        '-f',
        '1',
        '-l',
        '1',
        '-singlefile',
        pdfOut,
        path.join(outDir, 'summary'),
      ]);
      console.error(`Wrote ${path.join(outDir, 'summary.png')}`);
    } else {
      console.error('pdftoppm not found: skipped the PNG preview');
    }
    return 0;
  } catch (err) {
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = await main();
