/**
 * workspace-routes.js — boot-deterministic workspace identity endpoint.
 *
 * Mounts GET /api/workspace, returning the workspace resolved at boot time.
 * No descendant discovery, no ambiguity check, no resolveWorkspace() call —
 * this is the bootstrap endpoint the frontend hits BEFORE it has a workspace
 * id to send (per design SD-2 of COMP-WORKSPACE-HTTP).
 *
 * Response shape: { id, root, source: 'boot' }
 *   - id    — string, derived via deriveId({ root }).id
 *   - root  — absolute path of the boot target
 *   - source — always 'boot' for this endpoint
 */
import { getTargetRoot } from './project-root.js';
import { deriveId } from '../lib/discover-workspaces.js';

export function attachWorkspaceRoutes(app) {
  app.get('/api/workspace', (req, res) => {
    const root = getTargetRoot();
    // deriveId returns { id, root, configPath } — destructure the id only.
    // The route deliberately does NOT leak configPath to the client.
    const { id } = deriveId({ root });
    res.json({ id, root, source: 'boot' });
  });
}
