/** The catalog belongs to the MCP installation selected for dispatch. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveStratumBin } from './stratum-engine.js';

export const MODEL_TIER_KEYS = Object.freeze(['critical', 'standard', 'fast', 'budget', 'coordinator']);
const providers = ['claude', 'codex', 'devin'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const efforts = ['unavailable', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function validate(payload) {
  if (!object(payload) || !object(payload.catalog) || !/^[a-f0-9]{64}$/.test(payload.catalogDigest)
    || !text(payload.path) || !text(payload.version)) throw new Error('expected catalog, SHA-256 catalogDigest, path and version');
  const c = payload.catalog;
  for (const provider of providers) {
    if (!text(c[provider]?.default?.model) || !object(c.tiers?.[provider])
      || MODEL_TIER_KEYS.some(key => !Object.hasOwn(c.tiers[provider], key))) throw new Error(`missing ${provider} default or tier keys`);
    const accepted = provider === 'claude' ? c.models?.claude : Object.keys(c.pricing?.[provider] ?? {});
    if (!Array.isArray(accepted) || !accepted.length || accepted.some(id => !text(id))
      || !Array.isArray(c.retired?.[provider])) throw new Error(`missing ${provider} model list`);
    const available = id => accepted.includes(id) && !c.retired[provider].includes(id);
    if (!available(c[provider].default.model)) throw new Error(`unknown ${provider} default model`);
    for (const key of MODEL_TIER_KEYS) {
      const tier = c.tiers[provider][key];
      if (tier === 'unavailable') continue;
      if (!object(tier) || !text(tier.model) || !available(tier.model)
        || !efforts.includes(tier.effort) || !['unavailable', 'adaptive', 'off'].includes(tier.mode)) {
        throw new Error(`invalid ${provider}:${key} tier`);
      }
    }
  }
}

function freeze(value) {
  if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function installation(bin) {
  const realBin = realpathSync(bin);
  let root = dirname(realBin);
  const checked = [];
  for (;;) {
    checked.push(root);
    const manifest = join(root, 'package.json');
    try {
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if (pkg.name === '@smartmemory/stratum' && text(pkg.bin?.stratum)) {
          return { root, cli: resolve(root, pkg.bin.stratum) };
        }
      }
    } catch { /* Skip malformed or unreadable manifests and keep walking. */ }
    const parent = dirname(root);
    if (parent === root) throw new Error(`Unable to locate Stratum package root for MCP bin ${realBin}; directories checked: ${checked.join(', ')}. Set COMPOSE_STRATUM_TS_MCP_BIN to select the catalog installation`);
    root = parent;
  }
}

/** A separate client is a test seam; production caches success or failure once. */
export function createModelCatalogClient({ resolveBin = kind => resolveStratumBin(kind, process.cwd()),
  run = execFileSync, warn = message => console.warn(message) } = {}) {
  let cached;
  let failure;
  function load() {
    const mcpBin = resolveBin('mcp');
    const selected = installation(mcpBin);
    let separateCli;
    let separateRoot;
    // A separately configured CLI cannot prevent loading the dispatch installation.
    try {
      separateCli = resolveBin('cli');
      separateRoot = installation(separateCli).root;
    } catch { /* The selected MCP installation remains authoritative. */ }
    if (separateCli && separateRoot !== selected.root) {
      warn(`[model-catalog] MCP bin ${mcpBin} and separately resolved CLI bin ${separateCli} belong to different installations; using ${selected.cli} for the catalog.`);
    }
    const bin = selected.cli;
    let output;
    try {
      output = run(process.env.COMPOSE_STRATUM_TS_NODE || process.execPath, [bin, 'models', '--json'], {
        encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`Unable to load model catalog from resolved Stratum bin ${bin}: models --json failed: ${error.stderr?.toString().trim() || error.message}`, { cause: error });
    }
    try {
      const payload = JSON.parse(output);
      validate(payload);
      cached = freeze(payload);
      return cached;
    } catch (error) {
      throw new Error(`Malformed model catalog JSON from resolved Stratum bin ${bin}: ${error.message}`, { cause: error });
    }
  }
  return () => {
    if (failure) throw failure;
    if (cached) return cached;
    try { return load(); } catch (error) {
      error.message += '. This failure is cached for this process; restart Compose after fixing it.';
      failure = error;
      throw error;
    }
  };
}

export const getModelCatalog = createModelCatalogClient();
