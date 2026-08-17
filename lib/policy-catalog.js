/**
 * policy-catalog.js — COMP-POLICY-CHECK-1: local detection-pattern catalog loader.
 *
 * Reads the `## Detection patterns` fenced-yaml convention out of a Claude Code
 * memory directory (`<memory-dir>/feedback_*.md`) and turns it into data. This
 * mirrors SmartMemory's Python loader
 * (`smart-memory-core/smartmemory/adherence/detection.py`) field-for-field —
 * SmartMemory's `memory_get_violation_patterns` MCP tool is a thin wrapper over
 * that same parse, and Compose's engine is plain Node with no MCP client, so we
 * parse the markdown directly rather than fetching it.
 *
 * Pure parsing + caching. No enforcement, no response inspection: that is
 * `lib/policy-check.js`.
 *
 * Degradation contract:
 *   - memory dir absent            → empty catalog, silent (opt-in feature)
 *   - file without a block         → skipped, silent (the section is opt-in)
 *   - block present but malformed  → skipped with a WARNING (authored intent
 *     that produced nothing must be visible — no-silent-degradation rule)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';

// Leading `---` ... `---` frontmatter block.
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

// `## Detection patterns` heading followed by the first fenced code block.
// The fence language tag (```yaml / ```yml / ```) is optional.
const DETECTION_RE = /^##[ \t]+Detection patterns[ \t]*\n+```(?:ya?ml)?[ \t]*\n([\s\S]*?)\n```/im;

const PATTERN_KEYS = ['regex', 'phrase', 'exclude_regex'];
const DEFAULT_SCAN_TARGET = 'response';
const DEFAULT_RECENT_TURN_WINDOW = 1;
const DEFAULT_RULE_TYPE = 'feedback';

/** dir → { key, catalog } — per-process, invalidated on max-mtime/file-count change. */
const catalogCache = new Map();

/**
 * Read `.compose/compose.json` → `policyCheck` block. Uncached direct read,
 * try/catch → {} on missing/malformed (same shape as smartmemory-config.js).
 *
 * An ABSENT block means enabled: the check ships as the Compose default and is
 * structurally inert without a catalog. `enabled: false` is the kill switch.
 *
 * @param {string} cwd
 * @returns {{ enabled?: boolean, memoryDir?: string }}
 */
export function getPolicyCheckConfig(cwd) {
  try {
    const cfg = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf-8'));
    const block = cfg.policyCheck;
    return block && typeof block === 'object' && !Array.isArray(block) ? block : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} cwd
 * @param {object} [config] pre-read config block (avoids a second file read)
 * @returns {boolean} false only when the kill switch is explicitly set
 */
export function isPolicyCheckEnabled(cwd, config = getPolicyCheckConfig(cwd)) {
  return config.enabled !== false;
}

/** Expand a leading `~` against the current user's home directory. */
function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Claude Code's project-directory encoding: the absolute project path with `/`
 * and `.` replaced by `-` (so `/Users/x/reg/my/App` → `-Users-x-reg-my-App`).
 *
 * @param {string} cwd
 * @returns {string}
 */
export function encodeProjectDir(cwd) {
  return resolve(cwd).replace(/[/.]/g, '-');
}

/**
 * Resolve the memory directory for a project: config override (absolute, `~`,
 * or cwd-relative) → the default Claude Code project memory dir.
 *
 * @param {string} cwd
 * @param {object} [config]
 * @returns {string} absolute path (existence not checked)
 */
export function resolveMemoryDir(cwd, config = getPolicyCheckConfig(cwd)) {
  if (typeof config.memoryDir === 'string' && config.memoryDir.length > 0) {
    const expanded = expandHome(config.memoryDir);
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  }
  return join(homedir(), '.claude', 'projects', encodeProjectDir(cwd), 'memory');
}

/**
 * Normalize a YAML list into the `{regex|phrase|exclude_regex: string}`
 * contract. Non-list → []. Items are reduced to recognized string-valued keys;
 * an item with no such key is dropped, so garbage never reaches consumers that
 * assume string patterns.
 */
function validPatternItems(value) {
  if (!Array.isArray(value)) return [];
  const items = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const cleaned = {};
    for (const key of PATTERN_KEYS) {
      if (typeof item[key] === 'string') cleaned[key] = item[key];
    }
    if (Object.keys(cleaned).length > 0) items.push(cleaned);
  }
  return items;
}

function parseFrontmatter(text) {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return {};
  try {
    const data = YAML.parse(m[1]);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * Return the parsed detection block, or null when absent/unusable.
 * Absent → null, silently. Present-but-broken → null plus a WARNING.
 */
function parseDetectionBlock(text, sourceFile) {
  const m = DETECTION_RE.exec(text);
  if (!m) return null; // no block — normal, not an error

  let data;
  try {
    data = YAML.parse(m[1]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[policy-catalog] invalid YAML in detection block of ${sourceFile}: ${err.message}`);
    return null;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    // eslint-disable-next-line no-console
    console.warn(`[policy-catalog] detection block in ${sourceFile} is not a mapping; skipping`);
    return null;
  }
  if (validPatternItems(data.patterns).length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[policy-catalog] detection block in ${sourceFile} has no valid 'patterns' ` +
      "(need {regex|phrase|exclude_regex: str}); skipping"
    );
    return null;
  }
  return data;
}

function safeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Load `## Detection patterns` records from a memory directory.
 *
 * @param {string} memoryDir
 * @param {object} [opts]
 * @param {string} [opts.ruleType='feedback'] filename prefix to scan; also the
 *   fallback rule type when a file's frontmatter omits `type`
 * @returns {Array<{name: string, description: string, ruleType: string,
 *   patterns: object[], suppressionSignals: object[], scanTarget: string,
 *   recentTurnWindow: number, sourceFile: string}>}
 */
export function loadCatalog(memoryDir, { ruleType = DEFAULT_RULE_TYPE } = {}) {
  let names;
  try {
    names = readdirSync(memoryDir);
  } catch {
    // Absent (or unreadable) memory dir: the feature is opt-in, so an empty
    // catalog here is the expected no-op rather than a degradation.
    return [];
  }

  const files = names
    .filter(n => n.startsWith(`${ruleType}_`) && n.endsWith('.md'))
    .sort();

  const out = [];
  for (const name of files) {
    const path = join(memoryDir, name);
    let text;
    try {
      text = readFileSync(path, 'utf-8');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[policy-catalog] could not read ${path}: ${err.message}`);
      continue;
    }

    const block = parseDetectionBlock(text, path);
    if (block === null) continue;

    try {
      const fm = parseFrontmatter(text);
      const metadata = block.metadata && typeof block.metadata === 'object' && !Array.isArray(block.metadata)
        ? block.metadata
        : {};
      out.push({
        name: String(fm.name || name.replace(/\.md$/, '')),
        description: String(fm.description || ''),
        ruleType: String(fm.type || fm?.metadata?.type || ruleType),
        patterns: validPatternItems(block.patterns),
        suppressionSignals: validPatternItems(block.suppression_signals),
        scanTarget: String(metadata.scan_target || DEFAULT_SCAN_TARGET),
        recentTurnWindow: safeInt(metadata.recent_turn_window, DEFAULT_RECENT_TURN_WINDOW),
        sourceFile: path,
      });
    } catch (err) {
      // Defensive: one bad file must not sink the batch.
      // eslint-disable-next-line no-console
      console.warn(`[policy-catalog] failed to build record for ${path}: ${err.message}`);
    }
  }
  return out;
}

/**
 * Cache key for a directory: a digest over the sorted (path, mtimeMs, size) of
 * every rule file. Per-file rather than count + max-mtime, because that older
 * key could not see an edit to an OLDER file while a newer one sat untouched —
 * the max mtime never moved, so a real rule change went unnoticed for the life
 * of the process.
 */
function cacheKey(memoryDir, ruleType) {
  let names;
  try {
    names = readdirSync(memoryDir);
  } catch {
    return 'missing';
  }
  const parts = [];
  for (const name of names.filter(n => n.startsWith(`${ruleType}_`) && n.endsWith('.md')).sort()) {
    try {
      const { mtimeMs, size } = statSync(join(memoryDir, name));
      parts.push(`${name}:${mtimeMs}:${size}`);
    } catch {
      // Raced deletion between readdir and stat — record the absence so the key
      // still changes rather than silently matching the previous digest.
      parts.push(`${name}:gone`);
    }
  }
  return createHash('sha1').update(parts.join('\n')).digest('hex');
}

/**
 * Resolve + load the catalog for a project, cached per process and invalidated
 * when any rule file changes. Returns [] when the kill switch is set or no
 * catalog exists.
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {string} [opts.memoryDir] explicit override (skips config resolution)
 * @param {string} [opts.ruleType='feedback']
 * @returns {Array<object>} catalog records (see loadCatalog)
 */
export function getCatalog(cwd, { memoryDir, ruleType = DEFAULT_RULE_TYPE } = {}) {
  const config = getPolicyCheckConfig(cwd);
  if (!isPolicyCheckEnabled(cwd, config)) return [];

  const dir = memoryDir ?? resolveMemoryDir(cwd, config);
  const key = `${ruleType}|${cacheKey(dir, ruleType)}`;
  const cached = catalogCache.get(dir);
  if (cached && cached.key === key) return cached.catalog;

  const catalog = loadCatalog(dir, { ruleType });
  catalogCache.set(dir, { key, catalog });
  return catalog;
}

/** Test hook: drop the per-process catalog cache. */
export function _clearCatalogCache() {
  catalogCache.clear();
}
