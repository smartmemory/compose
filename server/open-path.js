/**
 * open-path.js — COMP-INBOX-LOCAL-FILE-LINKS-1: `POST /api/fleet/open-path {path}` opens a file or folder under the home dir
 * in the Mac's default app (the inbox's `localfile` links). Mounted by attachFleetRoutes behind requireSensitiveOrPaired.
 *
 * It refuses unless: `path` is a string of at most 4096 characters with no NUL; it is absolute after a leading `~/` is expanded
 * to the home dir (`~user` is refused); no segment is `..`; its realpath (every symlink resolved) lies strictly under the
 * realpath of the home dir; it exists and is a regular file or a directory. Because `open` LAUNCHES some things rather than
 * showing them, it also refuses an app or script bundle or launcher by extension (`LAUNCHER_EXT`) anywhere on the real path,
 * and any regular file with an execute bit, whatever its extension (`open` runs one in Terminal). The opener is spawned with argv only
 * (`['open', <realpath>]` on darwin, `['xdg-open', <realpath>]` otherwise), never a shell, through an injectable `spawner`.
 * Replies are `{status: 'accepted', path}` or `{status: 'rejected', reason}`; every refusal logs one warn line tagged with its
 * class (`[fleet] open-path rejected (<class>)`), never the requested path.
 */
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, sep } from 'node:path';

export const OPEN_PATH_ROUTE = '/api/fleet/open-path';
export const MAX_PATH = 4096;

// Extensions `open` runs, installs or follows rather than shows: app and plugin bundles, shell and Terminal launchers,
// AppleScript, Automator, installers, Java archives, and location files that can point at a URL or another path.
export const LAUNCHER_EXT = new Set([
  '.app', '.bundle', '.framework', '.plugin', '.kext', '.prefpane', '.qlgenerator', '.saver', '.appex', '.xpc',
  '.command', '.tool', '.sh', '.bash', '.zsh', '.csh', '.ksh', '.terminal',
  '.scpt', '.scptd', '.applescript', '.workflow', '.action', '.osax',
  '.pkg', '.mpkg', '.jar', '.webloc', '.inetloc', '.fileloc', '.url', '.desktop', '.mobileconfig',
  // Interpreter scripts and launcher files whose default handler here is a terminal or launcher (.pl -> iTerm, .term -> Terminal,
  // .jnlp -> JavaLauncher), or that a Python Launcher or similar runs on open.
  '.pl', '.pm', '.term', '.jnlp', '.py', '.pyw', '.rb', '.php', '.tcl', '.expect', '.ps1',
]);

/** The default spawner: detached, no stdio, no shell. An `error` event (opener missing) is logged, never thrown. */
export function defaultSpawner(argv, { warn = console.warn } = {}) {
  const child = spawn(argv[0], argv.slice(1), { shell: false, stdio: 'ignore', detached: true });
  child.on('error', (error) => warn(`[fleet] open-path: ${argv[0]} failed to start (${String(error?.message ?? error).slice(0, 160)})`));
  child.unref();
}

/**
 * Validate `body.path` and spawn the opener. Returns the reply; never throws.
 * @param {{path?: unknown}} body
 * @param {{home?: string, platform?: string, spawner?: (argv: string[]) => void, warn?: (line: string) => void}} [opts]
 */
export async function openLocalPath(body, { home = homedir(), platform = process.platform, spawner = defaultSpawner, warn = console.warn } = {}) {
  const rejected = (cls, reason) => { warn(`[fleet] open-path rejected (${cls}): ${reason}`); return { status: 'rejected', reason }; };
  const raw = body && typeof body === 'object' ? body.path : undefined;
  if (typeof raw !== 'string' || !raw) return rejected('shape', 'path must be a non-empty string');
  if (raw.length > MAX_PATH) return rejected('shape', `path must be at most ${MAX_PATH} characters`);
  if (raw.includes('\0')) return rejected('nul', 'path must not contain NUL');
  if (!home || !isAbsolute(home)) return rejected('home', 'the home folder is unknown');
  if (raw.startsWith('~') && raw !== '~' && !raw.startsWith('~/')) return rejected('tilde', 'only ~/ is expanded, not ~user');
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) return rejected('relative', 'path must be absolute or start with ~/');
  if (raw.split(/[/\\]/).includes('..')) return rejected('dotdot', 'path must not contain a .. segment');

  let real;
  let realHome;
  try {
    realHome = await realpath(home);
  } catch {
    return rejected('home', 'the home folder cannot be resolved');
  }
  try {
    real = await realpath(expanded);
  } catch {
    return rejected('missing', 'no such file or folder');
  }
  if (!real.startsWith(realHome + sep)) return rejected('outside-home', 'path is not under the home folder');

  let st;
  try {
    st = await stat(real);
  } catch {
    return rejected('missing', 'no such file or folder');
  }
  if (!st.isFile() && !st.isDirectory()) return rejected('type', 'path is not a regular file or a folder');
  const segments = real.slice(realHome.length + 1).split(sep);
  if (segments.some((seg) => LAUNCHER_EXT.has(extname(seg).toLowerCase()))) return rejected('launcher', 'apps, scripts and launchers are not opened from the cockpit');
  if (st.isFile() && (st.mode & 0o111)) return rejected('executable', 'an executable file is not opened from the cockpit');

  const argv = [platform === 'darwin' ? 'open' : 'xdg-open', real];
  try {
    spawner(argv, { warn });
  } catch (error) {
    return rejected('spawn', `the opener could not start (${String(error?.message ?? error).slice(0, 120)})`);
  }
  return { status: 'accepted', path: real };
}
