/**
 * workspace-middleware.js — Express middleware that resolves the per-request
 * workspace from the `X-Compose-Workspace-Id` header and attaches it as
 * `req.workspace = { id, root, source, configPath? }`.
 *
 * Behavior (v1):
 *   - Exempt paths (/api/workspace, /api/project/switch, /api/health) bypass
 *     resolution entirely and get `req.workspace.source = 'exempt'`.
 *   - Header present + valid → resolveWorkspace() result, source carried through.
 *   - Header absent + soft fallback enabled → fallback to getTargetRoot() with
 *     the `X-Compose-Workspace-Fallback: true` response header. Applies to
 *     ALL methods in v1 (GET and POST alike).
 *   - Resolver errors map to HTTP via mapResolverErrorToResponse:
 *       WorkspaceUnknown          → 400 { error, code, id }
 *       WorkspaceAmbiguous        → 409 { error, code, candidates }
 *       WorkspaceIdCollision      → 409 { error, code, roots }
 *       WorkspaceDiscoveryTooBroad → 400 { error, code }
 *       (anything else)           → 500 { error: '...' }
 *
 * Roadmap: COMP-WORKSPACE-HTTP T3.
 */
import { getTargetRoot } from './project-root.js';
import {
  resolveWorkspace,
  WorkspaceUnknown,
  WorkspaceAmbiguous,
  WorkspaceIdCollision,
} from '../lib/resolve-workspace.js';

const EXEMPT_PATHS = new Set([
  '/api/workspace',
  '/api/project/switch',
  '/api/health',
]);

/**
 * Factory for the Express middleware.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.allowGetFallback=true] — when true, requests without
 *   the workspace header soft-fallback to the target root with a hint header.
 *   When false, missing header surfaces as a WorkspaceUnknown(null) → 400.
 */
export function createWorkspaceMiddleware({ allowGetFallback = true } = {}) {
  return function workspaceMiddleware(req, res, next) {
    if (EXEMPT_PATHS.has(req.path)) {
      req.workspace = { id: null, root: getTargetRoot(), source: 'exempt' };
      return next();
    }

    const headerId = req.headers['x-compose-workspace-id'];

    try {
      if (!headerId) {
        if (allowGetFallback) {
          req.workspace = { id: null, root: getTargetRoot(), source: 'fallback' };
          res.setHeader('X-Compose-Workspace-Fallback', 'true');
          return next();
        }
        // Hard-fail mode: missing header is treated as an unknown id.
        throw new WorkspaceUnknown(null);
      }
      const resolved = resolveWorkspace({
        workspaceId: headerId,
        cwd: getTargetRoot(),
      });
      req.workspace = resolved;
      next();
    } catch (err) {
      mapResolverErrorToResponse(err, res, next);
    }
  };
}

/**
 * Translate a resolver error into a JSON HTTP response.
 *
 * @param {Error} err
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} [next] — optional; if provided,
 *   truly unknown errors are forwarded to it instead of generating a 500.
 */
export function mapResolverErrorToResponse(err, res, next) {
  if (err instanceof WorkspaceUnknown || err?.code === 'WorkspaceUnknown') {
    return res.status(400).json({
      error: err.message,
      code: 'WorkspaceUnknown',
      id: err.id ?? null,
    });
  }
  if (err instanceof WorkspaceAmbiguous || err?.code === 'WorkspaceAmbiguous') {
    return res.status(409).json({
      error: err.message,
      code: 'WorkspaceAmbiguous',
      candidates: err.candidates ?? [],
    });
  }
  if (err instanceof WorkspaceIdCollision || err?.code === 'WorkspaceIdCollision') {
    return res.status(409).json({
      error: err.message,
      code: 'WorkspaceIdCollision',
      roots: err.roots ?? [],
    });
  }
  if (err?.code === 'WorkspaceDiscoveryTooBroad') {
    return res.status(400).json({
      error: err.message,
      code: 'WorkspaceDiscoveryTooBroad',
    });
  }
  if (typeof next === 'function') {
    return next(err);
  }
  return res.status(500).json({
    error: err?.message || 'Internal workspace resolver error',
    code: err?.code || 'WorkspaceResolverInternalError',
  });
}

export { EXEMPT_PATHS };
