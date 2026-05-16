// Minimal in-process recorder: maps (method,path) -> handler returning {status, body, headers}.
// repo param defaults to 'o/r' so existing tests need no changes.
// opts.repoStatus: if set (e.g. 403 or 404), GET /repos/:repo returns that status.
// opts.projectsAccessDenied: if true, graphql projectV2 metadata returns a 403-style errors array.
export function makeGitHubFixture(repo = 'o/r', opts = {}) {
  const issues = new Map(); let n = 0; let upd = 0;
  const comments = new Map(); let cid = 0; // issueNumber -> [{id, body}]
  const projectUpdates = []; // inspectable: captures updateProjectV2ItemFieldValue inputs

  // Contents file store: path -> { text: string, sha: string }
  const files = new Map(); let shaCounter = 0;

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

    // ProjectV2 any non-mutation query: handle access-denied at this level so both
    // the probe (_probeProjectsAccess) and metadata lookup (_resolveProjectMeta) are covered.
    if (q.includes('projectV2') && !q.includes('mutation') && opts.projectsAccessDenied) {
      return { status: 200, body: { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }, headers: {} };
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

  const repoPath = `/repos/${repo}`;

  return {
    async request(method, path, body) {
      // GET /repos/:repo — lightweight repo probe for init() scope validation
      if (method === 'GET' && path === repoPath) {
        const status = opts.repoStatus ?? 200;
        if (status !== 200) {
          return { status, body: { message: status === 404 ? 'Not Found' : 'Forbidden' }, headers: {} };
        }
        return { status: 200, body: { full_name: repo, private: false }, headers: {} };
      }

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

      // GET /repos/:repo/contents/:filepath — with optional ?ref=... query param
      const contentsGetRe = new RegExp(`^/repos/${escapedRepo}/contents/(.+?)(?:\\?.*)?$`);
      const contentsGetMatch = contentsGetRe.exec(path);
      if (contentsGetMatch && method === 'GET') {
        const filePath = decodeURIComponent(contentsGetMatch[1]);
        const entry = files.get(filePath);
        if (!entry) {
          return { status: 404, body: { message: 'Not Found' }, headers: {} };
        }
        const encoded = Buffer.from(entry.text, 'utf-8').toString('base64');
        return {
          status: 200,
          body: { content: encoded, sha: entry.sha, name: filePath.split('/').pop(), path: filePath },
          headers: {},
        };
      }

      // PUT /repos/:repo/contents/:filepath
      const contentsPutRe = new RegExp(`^/repos/${escapedRepo}/contents/(.+)$`);
      const contentsPutMatch = contentsPutRe.exec(path);
      if (contentsPutMatch && method === 'PUT') {
        const filePath = decodeURIComponent(contentsPutMatch[1]);
        const current = files.get(filePath);
        // Optimistic-lock check: if sha is provided and doesn't match current sha → 409
        if (body?.sha && current && body.sha !== current.sha) {
          return { status: 409, body: { message: 'SHA conflict' }, headers: {} };
        }
        // Also reject if sha provided but file doesn't exist (stale create)
        // (GitHub behavior: sha is required on update, absent on create)
        shaCounter += 1;
        const newSha = `sha_${shaCounter}`;
        const decoded = Buffer.from((body?.content ?? '').replace(/\n/g, ''), 'base64').toString('utf-8');
        files.set(filePath, { text: decoded, sha: newSha });
        return {
          status: 200,
          body: {
            content: { sha: newSha, path: filePath },
            commit: { sha: `commit_${shaCounter}`, message: body?.message ?? '' },
          },
          headers: {},
        };
      }

      return { status: 404, body: {}, headers: {} };
    },
    _issues: issues,
    _comments: comments,
    _projectUpdates: projectUpdates,
    /**
     * Get the current text of a file in the fixture store.
     * Returns null if the file hasn't been set.
     */
    getFile(filePath) {
      return files.get(filePath)?.text ?? null;
    },
    /**
     * Seed a file into the fixture store (simulates a file already in the remote repo).
     * @param {string} filePath
     * @param {string} text
     */
    setFile(filePath, text) {
      shaCounter += 1;
      files.set(filePath, { text, sha: `sha_${shaCounter}` });
    },
    /**
     * Expose files map for advanced test inspection.
     */
    _files: files,
  };
}
