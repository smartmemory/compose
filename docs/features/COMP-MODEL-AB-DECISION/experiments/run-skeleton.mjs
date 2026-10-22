// G5 driver: runs skeleton-debug.json (finished runs are reused by runKey) and writes registry.json with the sonnet-5-5/medium cell as champion.
// The `compose experiment` CLI does not pass opts.registry, so the registry write goes through here.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExperiment } from '../../../../lib/experiment.js';

const dir = dirname(fileURLToPath(import.meta.url));
const spec = join(dir, process.argv[2] ?? 'skeleton-debug.json');
const champion = { debug: 'debug|claude|claude-sonnet-5-5|medium|none' };
const { runs, resultsPath } = await runExperiment(spec, { registry: { registryPath: join(dir, 'registry.json'), champion } });
console.log(`Results: ${resultsPath}`);
for (const r of runs) console.log(r.runId, r.metrics?.outcome?.completed, r.metrics?.stage?.accuracy, r.metrics?.cost?.usd ?? null);
