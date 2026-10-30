// COMP-COCKPIT-12 UI-test server: the real /api/fleet route (and the real Cadence handler on the sibling's
// fixture roots, when the sibling exists) in its own Node process, on a loopback ephemeral port.
// Readers come from the COMPOSE_FLEET_* env overrides. FLEET_FIXTURE_NO_CADENCE=1 skips the Cadence mount.
// Prints `PORT <n>` once listening; exits when stdin closes (the test ends).
import express from 'express';
import { join } from 'node:path';
import { attachFleetRoutes } from '../../../server/fleet-routes.js';
import { attachCadenceUiRoutes } from '../../../server/cadence-ui-routes.js';
import { resolveCadenceUiDir } from '../../../lib/cadence-ui-link.js';

const app = express();
const uiDir = resolveCadenceUiDir();
if (uiDir && process.env.FLEET_FIXTURE_NO_CADENCE !== '1') {
  const fx = join(uiDir, 'tests', 'fixtures');
  await attachCadenceUiRoutes(app, { uiDir, opsRoot: join(fx, 'ops'), stateDir: join(fx, 'state'), scriptsDir: '/none', run: async () => '{}' });
}
attachFleetRoutes(app, { warn: () => {}, info: () => {} });
const server = app.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${server.address().port} CADENCE ${uiDir ? 1 : 0}\n`));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
