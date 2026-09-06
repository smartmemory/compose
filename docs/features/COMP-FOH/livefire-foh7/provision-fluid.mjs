const SM = 'http://localhost:9001';
const tag = process.argv[2];
const email = `foh7-${tag}-${Date.now()}@compose.test`;
async function j(url, opts = {}) { const r = await fetch(url, opts); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b }; }
const prov = await j(`${SM}/test/provision-user`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
if (prov.status !== 200) { console.error(prov); process.exit(1); }
const id = prov.body;
const auth = { Authorization: `Bearer ${id.access_token}`, 'Content-Type': 'application/json', 'X-Workspace-Id': id.team_id };
const nda = await j(`${SM}/memory/beta/nda/accept`, { method: 'POST', headers: auth, body: JSON.stringify({ version: 'v2' }) });
const declared = {};
for (const k of ['idea','position','joint','decision','thread','question','cluster','event']) {
  const r = await j(`${SM}/memory/ontology/types`, { method: 'POST', headers: auth, body: JSON.stringify({ name: `fluid_${k}`, kind: 'record' }) });
  declared[`fluid_${k}`] = r.status;
}
const { writeFileSync } = await import('node:fs');
writeFileSync(`identity-${tag}.json`, JSON.stringify({ email, ...id }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ tag, team_id: id.team_id, nda: nda.body, declared: Object.values(declared).join(',') }));
