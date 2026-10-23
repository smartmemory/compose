// COMP-MODEL-AB-RERUN driver: runs a discriminate-debug spec (finished runs are reused by runKey) and writes registry-discriminate.json
// with the sonnet-5-5/medium cell as champion. Same shape as run-skeleton.mjs; separate registry so the G5 cells stay intact.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExperiment } from '../../../../lib/experiment.js';

const dir = dirname(fileURLToPath(import.meta.url));
const spec = join(dir, process.argv[2] ?? 'discriminate-debug-claude.json');
const champion = { debug: 'debug|claude|claude-sonnet-5-5|medium|none' };
const { runs, resultsPath } = await runExperiment(spec, { registry: { registryPath: join(dir, 'registry-discriminate.json'), champion } });
console.log(`Results: ${resultsPath}`);
for (const r of runs) console.log(r.runId, r.metrics?.outcome?.completed, r.metrics?.stage?.accuracy, r.metrics?.cost?.usd ?? null);
