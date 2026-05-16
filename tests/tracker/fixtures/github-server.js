// Minimal in-process recorder: maps (method,path) -> handler returning {status, body, headers}.
// repo param defaults to 'o/r' so existing tests need no changes.
export function makeGitHubFixture(repo = 'o/r') {
  const issues = new Map(); let n = 0; let upd = 0;
  const comments = new Map(); let cid = 0; // issueNumber -> [{id, body}]
  const projectUpdates = []; // inspectable: captures updateProjectV2ItemFieldValue inputs
  const escapedRepo = repo.replace('/', '\\/');
  const issuePathRe = new RegExp(`^/repos/${escapedRepo}/issues/\\d+$`);
  const issueCommentsPathRe = new RegExp(`^/repos/${escapedRepo}/issues/(\\d+)/comments$`);

  // Projects v2 options — mirrors common Compose statuses
  const PROJECT_OPTIONS = [
    { id: 'O_PLANNED',     name: 'PLANNED'     },
    { id: 'O_IN_PROGRESS', name: 'IN_PROGRESS' },
    { id: 'O_COMPLETE',    name: 'COMPLETE'     },
    { id: 'O_KILLED',      name: 'KILLED'       },
    { id: 'O_PARKED',      name: 'PARKED'       },
    { id: 'O_BLOCKED',     name: 'BLOCKED'      },
    { id: 'O_PARTIAL',     name: 'PARTIAL'      },
    { id: 'O_SUPERSEDED',  name: 'SUPERSEDED'   },
  ];

  function handleGraphql(body) {
    const q = body?.query ?? '';
    const vars = body?.variables ?? {};

    // Force-error sentinel: any call with __forceError in variables
    if (vars.__forceError) {
      return { status: 200, body: { errors: [{ message: 'boom' }] }, headers: {} };
    }

    // ProjectV2 metadata lookup (owner.projectV2 by number)
    if (q.includes('projectV2') && q.includes('options') && !q.includes('mutation')) {
      // Determine owner from repo ('o/r' -> owner='o')
      const owner = repo.split('/')[0];
      return {
        status: 200,
        body: {
          data: {
            [owner]: {
              projectV2: {
                id: 'P1',
                field: {
                  id: 'F1',
                  options: PROJECT_OPTIONS,
                },
              },
            },
          },
        },
        headers: {},
      };
    }

    // Add issue to project / get item id
    if (q.includes('addProjectV2ItemById')) {
      return {
        status: 200,
        body: { data: { addProjectV2ItemById: { item: { id: 'IT1' } } } },
        headers: {},
      };
    }

    // Update project field value — record for test inspection
    if (q.includes('updateProjectV2ItemFieldValue')) {
      const input = vars.input ?? {};
      projectUpdates.push(input);
      return {
        status: 200,
        body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'IT1' } } } },
        headers: {},
      };
    }

    // Generic fallback
    return { status: 200, body: { data: {} }, headers: {} };
  }

  return {
    async request(method, path, body) {
      if (method === 'POST' && path === `/repos/${repo}/issues`) {
        n += 1;
        const issue = {
          number: n, node_id: `gid_${n}`, title: body.title, body: body.body,
          labels: (body.labels ?? []).map(name => ({ name })), state: 'open', updated_at: `t${n}`,
        };
        issues.set(n, issue); comments.set(n, []);
        return { status: 201, body: issue, headers: {} };
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
      const commentMatch = issueCommentsPathRe.exec(path);
      if (commentMatch) {
        const num = Number(commentMatch[1]);
        if (method === 'POST') {
          cid += 1;
          const comment = { id: cid, body: body?.body ?? '' };
          if (!comments.has(num)) comments.set(num, []);
          comments.get(num).push(comment);
          return { status: 201, body: comment, headers: {} };
        }
        if (method === 'GET') {
          return { status: 200, body: comments.get(num) ?? [], headers: {} };
        }
      }

      // POST /graphql
      if (method === 'POST' && path === '/graphql') {
        return handleGraphql(body);
      }

      return { status: 404, body: {}, headers: {} };
    },
    _issues: issues,
    _comments: comments,
    _projectUpdates: projectUpdates,
  };
}
