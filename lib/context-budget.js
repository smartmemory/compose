/**
 * context-budget.js — Audit the session-start loaded surface and budget its token cost.
 *
 * Scans agents, skills, rules, MCP server tool schemas, and the CLAUDE.md chain;
 * estimates per-component tokens; classifies each into always / sometimes / rarely
 * needed; and renders a ranked cut list with estimated reclaim.
 *
 * Read-only. The human reviews and chooses cuts (auto-applying cuts is a non-goal).
 * Backs the `/context-budget` skill — see compose/.claude/skills/context-budget/SKILL.md.
 *
 * Token estimates use a dependency-free ~4-chars-per-token heuristic. They are relative
 * budgeting estimates, NOT billing-accurate; `estimateTokens` is pluggable so a real
 * tokenizer can be swapped in later. COMP-CTXBUDGET-1.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { createHash } from 'crypto';

const TOKENS_PER_MCP_TOOL = 500;
const SIMPLE_CLI_COMMANDS = new Set(['git', 'gh', 'npm', 'npx', 'cat', 'ls', 'grep', 'sed', 'awk']);

// Flag thresholds (lines) from the plan.
const FLAG_LINES = { agent: 200, skill: 400, rule: 100 };

/**
 * Estimate tokens for a chunk of text. Dependency-free ~4-chars-per-token heuristic.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function readTextSafe(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function lineCount(text) {
  if (!text) return 0;
  // Count lines without a trailing-newline off-by-one surprise.
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

function contentHash(text) {
  return createHash('sha1').update(text || '').digest('hex');
}

/**
 * Extract the YAML frontmatter block (including the `---` fences) from a skill or
 * agent file. This is what Claude Code surfaces at session start — name +
 * description — under progressive disclosure; the body loads only on invocation.
 * Returns null if there is no leading frontmatter.
 */
export function extractFrontmatter(text) {
  if (!text || !text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  return text.slice(0, end + 4);
}

/**
 * The text that is actually loaded into context at session start for a component.
 * - skill / agent: progressive disclosure → only the frontmatter (name+description)
 *   loads until the component is invoked. Falls back to the first line if no
 *   frontmatter is present.
 * - rule / claude-md: inlined into the CLAUDE.md context at startup → full text.
 * - mcp-server: handled in scanMcpServers (full schema estimate).
 */
function matchFrontmatterField(fm, key) {
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, 'mi');
  const m = fm.match(re);
  return m ? m[1].trim() : null;
}

function liveTextFor(kind, text) {
  if (kind === 'skill' || kind === 'agent') {
    const fm = extractFrontmatter(text);
    if (fm == null) return (text || '').split('\n').find((l) => l.trim()) || '';
    // Only name + description surface at startup — count those fields specifically
    // (robust to extra frontmatter keys like allowed-tools). If neither is present
    // (unusual shape), fall back to the whole block as a conservative estimate.
    const name = matchFrontmatterField(fm, 'name');
    const desc = matchFrontmatterField(fm, 'description');
    if (name == null && desc == null) return fm;
    return [name, desc].filter(Boolean).join(' ');
  }
  return text || '';
}

function makeComponent(kind, path, label, text, extraFlags = []) {
  const lines = lineCount(text);
  const flags = [...extraFlags];
  const threshold = FLAG_LINES[kind];
  if (threshold && lines > threshold) flags.push(`over-${threshold}-lines`);
  return {
    kind,
    path,
    label,
    lines,
    tokens: estimateTokens(text), // on-disk surface (full file)
    liveTokens: estimateTokens(liveTextFor(kind, text)), // loaded at startup
    hash: contentHash(text),
    flags,
  };
}

// ---------- Surface scanners ----------

function scanAgents(roots) {
  const out = [];
  for (const root of roots) {
    for (const rel of ['.claude/agents', '.agents', 'agents']) {
      const dir = join(root, rel);
      if (!existsSync(dir)) continue;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        const p = join(dir, e.name);
        const text = readTextSafe(p);
        if (text == null) continue;
        out.push(makeComponent('agent', p, `agent:${basename(e.name, '.md')}`, text));
      }
    }
  }
  return out;
}

function scanSkills(roots) {
  const out = [];
  for (const root of roots) {
    for (const rel of ['.claude/skills', 'skills']) {
      const dir = join(root, rel);
      if (!existsSync(dir)) continue;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = join(dir, e.name, 'SKILL.md');
        const text = readTextSafe(p);
        if (text == null) continue;
        out.push(makeComponent('skill', p, `skill:${e.name}`, text));
      }
    }
  }
  return out;
}

function scanRules(roots) {
  const out = [];
  const seenPaths = new Set();
  for (const root of roots) {
    for (const rel of ['.claude/rules', 'rules']) {
      const dir = join(root, rel);
      if (!existsSync(dir)) continue;
      walkMdFiles(dir).forEach((p) => {
        if (seenPaths.has(p)) return;
        seenPaths.add(p);
        const text = readTextSafe(p);
        if (text == null) return;
        out.push(makeComponent('rule', p, `rule:${basename(p, '.md')}`, text));
      });
    }
  }
  // Mark content overlap: rules whose first heading line matches another rule's.
  const byHeading = new Map();
  for (const c of out) {
    const head = (readTextSafe(c.path) || '').split('\n')[0].trim();
    if (!head) continue;
    if (byHeading.has(head)) {
      c.flags.push('overlap');
      byHeading.get(head).flags.push('overlap');
    } else {
      byHeading.set(head, c);
    }
  }
  return out;
}

function walkMdFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMdFiles(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function scanMcpServers(mcpConfigPath, toolCounts = {}) {
  const out = [];
  if (!mcpConfigPath || !existsSync(mcpConfigPath)) return out;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
  } catch {
    return out;
  }
  const servers = cfg.mcpServers || {};
  for (const [name, spec] of Object.entries(servers)) {
    const flags = [];
    const cmd = basename(spec.command || '');
    const firstArg = Array.isArray(spec.args) ? spec.args[0] || '' : '';
    if (SIMPLE_CLI_COMMANDS.has(cmd) || SIMPLE_CLI_COMMANDS.has(basename(firstArg))) {
      flags.push('wraps-simple-cli');
    }
    const count = toolCounts[name];
    const hasCount = Number.isFinite(count) && count >= 0;
    let tokens = 0;
    if (hasCount) {
      tokens = TOKENS_PER_MCP_TOOL * count;
    } else {
      flags.push('tool-count-unknown');
    }
    // MCP tool schemas load fully at startup in most harnesses, but tool-deferral
    // harnesses (e.g. ToolSearch) load them on demand — so the live cost may be 0.
    flags.push('mcp-may-defer');
    out.push({
      kind: 'mcp-server',
      path: mcpConfigPath,
      label: `mcp-server:${name}`,
      lines: 0,
      tokens,
      liveTokens: tokens, // full schema when eagerly loaded (see mcp-may-defer)
      hash: contentHash(`mcp:${name}`),
      flags,
      toolCount: hasCount ? count : null,
    });
  }
  return out;
}

/**
 * Resolve the CLAUDE.md chain: home global + every CLAUDE.md from cwd upward to a repo
 * boundary (a dir containing .git) or filesystem root.
 */
function claudeMdChain({ home, cwd }) {
  const paths = [];
  if (home) paths.push(join(home, '.claude', 'CLAUDE.md'));
  let dir = cwd;
  const seen = new Set();
  while (dir && !seen.has(dir)) {
    seen.add(dir);
    paths.push(join(dir, 'CLAUDE.md'));
    if (existsSync(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const out = [];
  const usedPaths = new Set();
  for (const p of paths) {
    if (usedPaths.has(p)) continue;
    usedPaths.add(p);
    const text = readTextSafe(p);
    if (text == null) continue;
    out.push(makeComponent('claude-md', p, `claude-md:${p}`, text));
  }
  return out;
}

/**
 * Walk every surface into a flat inventory of components.
 * @param {{cwd:string, home?:string, mcpConfigPath?:string, toolCounts?:object}} opts
 * @returns {Array} components
 */
export function scanSurface({ cwd, home, mcpConfigPath, toolCounts = {} }) {
  const roots = [home, cwd].filter(Boolean);
  return [
    ...scanAgents(roots),
    ...scanSkills(roots),
    ...scanRules(roots),
    ...scanMcpServers(mcpConfigPath, toolCounts),
    ...claudeMdChain({ home, cwd }),
  ];
}

/**
 * Collapse identical skill copies across surfaces (the real source of churn between
 * compose/.claude/skills and ~/.claude/skills). Keeps the first occurrence; later
 * identical copies are retained but marked `duplicateOf` and zeroed so totals don't
 * double-count. Non-identical same-named skills are both kept.
 */
export function dedupeSkills(components) {
  const seen = new Map(); // key: skill label + content hash -> kept component
  return components.map((c) => {
    if (c.kind !== 'skill') return c;
    const key = `${c.label}::${c.hash}`;
    if (seen.has(key)) {
      return { ...c, duplicateOf: seen.get(key).path, tokens: 0, liveTokens: 0, flags: [...c.flags, 'duplicate'] };
    }
    seen.set(key, c);
    return c;
  });
}

/**
 * Classify a component into a budget bucket with an explaining reason.
 * @param {object} component
 * @param {{claudeMdText?:string, projectType?:string}} ctx
 * @returns {{bucket:string, reason:string}}
 */
export function classifyComponent(component, ctx = {}) {
  const { claudeMdText = '', projectType = '' } = ctx;
  const flags = component.flags || [];
  const name = component.label.split(':').slice(1).join(':');

  // Duplicates are always a recommended cut.
  if (component.duplicateOf) {
    return { bucket: 'rarely', reason: `duplicate of ${component.duplicateOf}` };
  }

  // CLAUDE.md itself and MCP servers backing the project are load-bearing.
  if (component.kind === 'claude-md') {
    return { bucket: 'always', reason: 'CLAUDE.md chain is always loaded' };
  }

  if (nameReferenced(name, claudeMdText)) {
    return { bucket: 'always', reason: `referenced by name in the CLAUDE.md chain` };
  }

  // Overlapping rules / unknown-or-CLI-wrapping MCP servers / over-size domain content.
  if (flags.includes('overlap')) {
    return { bucket: 'rarely', reason: 'content overlaps a sibling in the same module' };
  }
  if (component.kind === 'mcp-server' && flags.includes('wraps-simple-cli')) {
    return { bucket: 'rarely', reason: 'wraps a simple CLI the Bash tool can call directly' };
  }

  if (component.kind === 'mcp-server') {
    // A real server with tools, not referenced by name — load-bearing while configured,
    // but a disable-if-unused candidate (schemas are the heaviest single line items).
    return {
      bucket: 'sometimes',
      reason: 'active MCP server, not referenced in CLAUDE.md — disable in .mcp.json if unused',
    };
  }

  // Default: domain-specific, not referenced => sometimes (consider lazy-load).
  return { bucket: 'sometimes', reason: 'not referenced in CLAUDE.md — consider on-demand activation' };
}

/**
 * Whole-word "referenced by name" check that tolerates hyphen/space variants.
 * `compose` matches "the compose skill" but NOT "decompose"/"composed";
 * `code-standards` matches "code standards", "code-standards", or "codestandards".
 */
export function nameReferenced(name, text) {
  if (!name || !text) return false;
  const n = name.toLowerCase();
  const variants = new Set([n, n.replace(/-/g, ' '), n.replace(/-/g, '')]);
  for (const v of variants) {
    if (!v) continue;
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i');
    if (re.test(text)) return true;
  }
  return false;
}

function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/**
 * Build the structured report (and rendered text) from a classified inventory.
 * Accepts raw components; classifies internally if a ctx is provided, else expects
 * components already carrying a `bucket`.
 */
export function buildReport(components, ctx = {}) {
  // Ensure each component is classified and carries a liveTokens estimate.
  // scanSurface() always sets liveTokens. For a hand-built component that omits
  // it, default CONSERVATIVELY to the full surface tokens — a budget tool should
  // over-report cost, never hide it. (We can't recompute a description-only
  // estimate here without the source text.)
  const classified = components.map((c) => {
    const withLive = c.liveTokens == null ? { ...c, liveTokens: c.tokens } : c;
    if (withLive.bucket) return withLive;
    const { bucket, reason } = classifyComponent(withLive, ctx);
    return { ...withLive, bucket, reason };
  });

  const buckets = { always: [], sometimes: [], rarely: [] };
  for (const c of classified) buckets[c.bucket].push(c);

  const totalTokens = classified.reduce((a, c) => a + c.tokens, 0); // on-disk surface
  const totalLiveTokens = classified.reduce((a, c) => a + c.liveTokens, 0); // loaded at startup

  // Top reclaims: ranked by LIVE tokens — the savings you actually get back by
  // cutting it (progressive disclosure means a big on-disk skill reclaims only
  // its description). Among sometimes+rarely with non-zero live cost.
  const topReclaims = [...buckets.sometimes, ...buckets.rarely]
    .filter((c) => c.liveTokens > 0)
    .sort((a, b) => b.liveTokens - a.liveTokens)
    .slice(0, 5);

  const text = renderReport({ buckets, totalTokens, totalLiveTokens, topReclaims });
  return { totalTokens, totalLiveTokens, buckets, topReclaims, classified, text };
}

function renderBucketLines(list) {
  return list
    .slice()
    .sort((a, b) => b.liveTokens - a.liveTokens || b.tokens - a.tokens)
    .map((c) => {
      const flagStr = c.flags && c.flags.length ? ` [${c.flags.join(', ')}]` : '';
      return `  - ${c.label} (${c.lines} lines, ~${formatTokens(c.tokens)} surface / ~${formatTokens(c.liveTokens)} live) — ${c.reason}${flagStr}`;
    })
    .join('\n');
}

function bucketSurface(list) {
  return list.reduce((a, c) => a + c.tokens, 0);
}
function bucketLive(list) {
  return list.reduce((a, c) => a + c.liveTokens, 0);
}

function renderReport({ buckets, totalTokens, totalLiveTokens, topReclaims }) {
  const lines = [];
  lines.push(
    `CONTEXT BUDGET — ~${formatTokens(totalTokens)} tokens on disk / ~${formatTokens(totalLiveTokens)} loaded at startup`
  );
  lines.push(
    '  (skills & agents are progressive-disclosure: only their description loads until invoked,'
  );
  lines.push(
    '   so "live" is the real session-start cost; MCP schemas may also defer — see mcp-may-defer)'
  );
  lines.push('');
  lines.push(
    `ALWAYS NEEDED (keep, ~${formatTokens(bucketSurface(buckets.always))} surface / ~${formatTokens(bucketLive(buckets.always))} live)`
  );
  lines.push(renderBucketLines(buckets.always) || '  (none)');
  lines.push('');
  lines.push(
    `SOMETIMES NEEDED (consider lazy-load, ~${formatTokens(bucketSurface(buckets.sometimes))} surface / ~${formatTokens(bucketLive(buckets.sometimes))} live)`
  );
  lines.push(renderBucketLines(buckets.sometimes) || '  (none)');
  lines.push('');
  lines.push(
    `RARELY NEEDED (recommend cut, ~${formatTokens(bucketSurface(buckets.rarely))} surface / ~${formatTokens(bucketLive(buckets.rarely))} live)`
  );
  lines.push(renderBucketLines(buckets.rarely) || '  (none)');
  lines.push('');
  lines.push('TOP 5 RECLAIMS (by live tokens — what you actually get back):');
  if (topReclaims.length === 0) {
    lines.push('  (none)');
  } else {
    topReclaims.forEach((c, i) => {
      lines.push(
        `  ${i + 1}. ${c.label} (~${formatTokens(c.liveTokens)} live / ~${formatTokens(c.tokens)} surface) — ${c.reason}`
      );
    });
  }
  const potentialLive = bucketLive(buckets.sometimes) + bucketLive(buckets.rarely);
  const potentialSurface = bucketSurface(buckets.sometimes) + bucketSurface(buckets.rarely);
  lines.push('');
  lines.push(
    `Potential reclaim if all sometimes+rarely cut: ~${formatTokens(potentialLive)} live (~${formatTokens(potentialSurface)} surface)`
  );
  return lines.join('\n');
}

/**
 * Top-level orchestrator: scan → dedupe → classify → report.
 * @param {{cwd:string, home?:string, mcpConfigPath?:string, toolCounts?:object}} opts
 */
export function auditContextBudget({ cwd, home, mcpConfigPath, toolCounts = {} }) {
  const resolvedMcp = mcpConfigPath || (cwd ? join(cwd, '.mcp.json') : undefined);
  const raw = scanSurface({ cwd, home, mcpConfigPath: resolvedMcp, toolCounts });
  const deduped = dedupeSkills(raw);

  // Build the CLAUDE.md context text used for "referenced by name" classification.
  const claudeMdText = deduped
    .filter((c) => c.kind === 'claude-md')
    .map((c) => readTextSafe(c.path) || '')
    .join('\n');

  return buildReport(deduped, { claudeMdText, projectType: 'node' });
}

// ---------- CLI guard ----------
export function parseToolCounts(arg) {
  const out = {};
  if (!arg) return out;
  for (const pair of arg.split(',')) {
    const [name, n] = pair.split('=');
    if (!name || n == null || n.trim() === '') continue;
    const num = Number(n);
    if (Number.isFinite(num) && num >= 0) out[name.trim()] = num;
  }
  return out;
}

function isMainModule() {
  try {
    return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const cwd = args.find((a) => !a.startsWith('--')) || process.cwd();
  const home = process.env.HOME;
  const tcArg = args.find((a) => a.startsWith('--tool-counts='));
  const toolCounts = parseToolCounts(tcArg ? tcArg.split('=').slice(1).join('=') : '');
  const report = auditContextBudget({ cwd, home, toolCounts });
  process.stdout.write(report.text + '\n');
}
