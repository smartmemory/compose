// Minimal in-process recorder: maps (method,path) -> handler returning {status, body, headers}.
// repo param defaults to 'o/r' so existing tests need no changes.
export function makeGitHubFixture(repo = 'o/r') {
  const issues = new Map(); let n = 0; let upd = 0;
  const comments = new Map(); let cid = 0; // issueNumber -> [{id, body}]
  const escapedRepo = repo.replace('/', '\\/');
  const issuePathRe = new RegExp(`^/repos/${escapedRepo}/issues/\\d+$`);
  const issueCommentsPathRe = new RegExp(`^/repos/${escapedRepo}/issues/(\\d+)/comments$`);
  return {
    async request(method, path, body) {
      if (method === 'POST' && path === `/repos/${repo}/issues`) {
        n += 1; const issue = { number: n, node_id: `gid_${n}`, title: body.title, body: body.body,
          labels: (body.labels ?? []).map(name => ({ name })), state: 'open', updated_at: `t${n}` };
        issues.set(n, issue); comments.set(n, []); return { status: 201, body: issue, headers: {} };
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
      // POST /repos/:repo/issues/:n/comments
      const commentPostMatch = issueCommentsPathRe.exec(path);
      if (method === 'POST' && commentPostMatch) {
        const num = Number(commentPostMatch[1]);
        cid += 1;
        const comment = { id: cid, body: body?.body ?? '' };
        if (!comments.has(num)) comments.set(num, []);
        comments.get(num).push(comment);
        return { status: 201, body: comment, headers: {} };
      }
      // GET /repos/:repo/issues/:n/comments
      if (method === 'GET' && commentPostMatch) {
        const num = Number(commentPostMatch[1]);
        return { status: 200, body: comments.get(num) ?? [], headers: {} };
      }
      // POST /graphql
      if (method === 'POST' && path === '/graphql') {
        const q = body?.query ?? '';
        if (q.includes('updateProjectV2ItemFieldValue')) {
          return { status: 200, body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'pi' } } } }, headers: {} };
        }
        return { status: 200, body: { data: {} }, headers: {} };
      }
      return { status: 404, body: {}, headers: {} };
    },
    _issues: issues,
    _comments: comments,
  };
}
