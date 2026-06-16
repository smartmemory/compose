import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Install Claude Code agent definitions (*.md) from srcDir into destDir.
 * Idempotent: mkdir -p the dest and overwrite existing files. Returns the list
 * of installed agent names (filenames sans `.md`). No-op → [] when srcDir is
 * absent or has no `.md` files. (COMP-AGENT-VENDOR-1 — vendored compose-explorer
 * / compose-architect were referenced by the skill but never installed.)
 */
export function installAgentDefs(srcDir, destDir) {
  if (!srcDir || !existsSync(srcDir)) return [];
  const defs = readdirSync(srcDir).filter(f => f.endsWith('.md'));
  if (defs.length === 0) return [];
  mkdirSync(destDir, { recursive: true });
  const installed = [];
  for (const f of defs) {
    copyFileSync(join(srcDir, f), join(destDir, f));
    installed.push(f.replace(/\.md$/, ''));
  }
  return installed;
}
