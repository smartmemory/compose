// Verify upstream fix: /memory/list must reflect updateItem metadata (read-your-writes).
// Repro preserved in foh-6-progress.md — add → update metadata → GET vs list.
const SM = 'http://localhost:9001';
const email = `foh6-listfix-${Date.now()}@compose.test`;

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

let identity = null;
let failed = false;
const fail = (m) => { console.error('FAIL:', m); failed = true; };
try {
  const prov = await j(`${SM}/test/provision-user`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (prov.status !== 200) { console.error('provision failed', prov.status); process.exit(1); }
  identity = prov.body;
  const auth = {
    Authorization: `Bearer ${identity.access_token}`,
    'Content-Type': 'application/json',
    'X-Workspace-Id': identity.team_id,
  };
  await j(`${SM}/memory/beta/nda/accept`, { method: 'POST', headers: auth, body: JSON.stringify({ version: 'v1' }) });

  const add = await j(`${SM}/memory/add`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ content: 'list-fix probe', memory_type: 'semantic', metadata: { blob: 'v1' }, use_pipeline: false }),
  });
  const itemId = add.body?.id ?? add.body?.item_id;
  if (add.status !== 200 || !itemId) { fail(`add: ${add.status} ${JSON.stringify(add.body).slice(0, 200)}`); process.exit(1); }
  console.log('[add]', itemId);

  const upd = await j(`${SM}/memory/${itemId}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ metadata: { blob: 'v2' } }),
  });
  console.log('[update]', upd.status);
  if (upd.status >= 400) { fail(`update: ${upd.status} ${JSON.stringify(upd.body).slice(0, 200)}`); }

  const get = await j(`${SM}/memory/${itemId}`, { headers: auth });
  const getBlob = (get.body?.metadata ?? get.body?.item?.metadata)?.blob;
  console.log('[direct GET]', 'blob =', getBlob);
  if (getBlob !== 'v2') fail(`direct GET stale: ${getBlob}`);

  // list — poll up to 30s in case the fix is convergence rather than sync
  let listBlob = null;
  for (let i = 0; i < 7; i++) {
    const list = await j(`${SM}/memory/list?limit=100`, { headers: auth });
    const items = Array.isArray(list.body) ? list.body : (list.body?.items || []);
    const it = items.find(x => (x.item_id ?? x.id) === itemId);
    listBlob = it?.metadata?.blob ?? '(item missing from list)';
    if (listBlob === 'v2') break;
    if (i < 6) await new Promise(r => setTimeout(r, 5000));
  }
  console.log('[list]', 'blob =', listBlob);
  if (listBlob !== 'v2') fail(`list still stale after 30s: ${listBlob}`);
} finally {
  if (identity) {
    const del = await j(`${SM}/test/provision-user`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, user_id: identity.user_id, tenant_id: identity.tenant_id }),
    }).catch(() => ({ status: 'ERR' }));
    console.log('[teardown]', del.status);
  }
}
console.log(failed ? 'LIST-FIX: NOT FIXED' : 'LIST-FIX: VERIFIED FRESH');
process.exitCode = failed ? 1 : 0;
