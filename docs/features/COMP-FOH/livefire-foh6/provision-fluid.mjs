// FOH-6 live-fire: provision throwaway FLUID tenant (FOH-4 recipe), NDA, declare record types.
const SM = 'http://localhost:9001';
const email = `foh6-fluid-${Date.now()}@compose.test`;

async function j(url, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  } finally { clearTimeout(t); }
}

const prov = await j(`${SM}/test/provision-user`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email }),
});
if (prov.status !== 200 || !prov.body?.access_token) {
  console.error('provision failed', prov.status, JSON.stringify(prov.body).slice(0, 400));
  process.exit(1);
}
const id = prov.body;
const auth = { Authorization: `Bearer ${id.access_token}`, 'Content-Type': 'application/json' };

const nda = await j(`${SM}/memory/beta/nda/accept`, {
  method: 'POST', headers: auth, body: JSON.stringify({ version: 'v1' }),
});

const declared = {};
for (const name of ['fluid_idea', 'fluid_event', 'fluid_decision']) {
  const r = await j(`${SM}/memory/ontology/types`, {
    method: 'POST', headers: auth, body: JSON.stringify({ name, kind: 'record' }),
  });
  declared[name] = r.status;
}

const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('./fluid-identity.json', import.meta.url), JSON.stringify({ email, ...id }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({
  user_id: id.user_id, tenant_id: id.tenant_id, team_id: id.team_id,
  nda: nda.status, declared,
}, null, 2));
