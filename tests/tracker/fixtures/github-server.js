// Minimal in-process recorder: maps (method,path) -> handler returning {status, body, headers}.
// repo param defaults to 'o/r' so existing tests need no changes.
export function makeGitHubFixture(repo = 'o/r') {
  const issues = new Map(); let n = 0; let upd = 0;
  const escapedRepo = repo.replace('/', '\\/');
  const issuePathRe = new RegExp(`^/repos/${escapedRepo}/issues/\\d+$`);
  return {
    async request(method, path, body) {
      if (method === 'POST' && path === `/repos/${repo}/issues`) {
        n += 1; const issue = { number: n, node_id: `gid_${n}`, title: body.title, body: body.body,
          labels: (body.labels ?? []).map(name => ({ name })), state: 'open', updated_at: `t${n}` };
        issues.set(n, issue); return { status: 201, body: issue, headers: {} };
      }
      if (method === 'GET' && issuePathRe.test(path)) {
        const num = Number(path.split('/').pop());
        const i = issues.get(num);
        return i ? { status: 200, body: i, headers: {} } : { status: 404, body: {}, headers: {} };
      }
      if (method === 'PATCH' && issuePathRe.test(path)) {
        const num = Number(path.split('/').pop());
        const i = issues.get(num);
        if (!i) return { status: 404, body: {}, headers: {} };
        upd += 1;
        if (body.title !== undefined) i.title = body.title;
        if (body.body !== undefined) i.body = body.body;
        if (body.labels !== undefined) i.labels = body.labels.map(l => (typeof l === 'string' ? { name: l } : l));
        if (body.state !== undefined) i.state = body.state;
        i.updated_at = `u${upd}`;
        return { status: 200, body: i, headers: {} };
      }
      if (method === 'GET' && path.startsWith('/search/issues')) {
        return { status: 200, body: { items: [...issues.values()] }, headers: {} };
      }
      return { status: 404, body: {}, headers: {} };
    },
    _issues: issues,
  };
}
