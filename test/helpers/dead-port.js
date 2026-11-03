import { spawnSync } from 'node:child_process';

// A port that refuses connections, chosen at runtime. A fixed number in the shared
// test range (19000-19999) is not dead: 19997 answered with MongoDB's HTTP banner
// during the pre-push gate of 953051f5 (COMP-TEST-ISOLATION-FU-1). The child binds
// port 0, reads what the OS gave it, and closes, so the number was free a moment ago
// and the OS hands out ephemeral ports round-robin rather than reusing it at once.
// Synchronous because several callers set COMPOSE_PORT at module top level.
const PROBE = `const s=require('node:net').createServer();`
  + `s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p));});`;

export function deadPortSync() {
  const r = spawnSync(process.execPath, ['-e', PROBE], { encoding: 'utf8' });
  const port = Number.parseInt(r.stdout, 10);
  if (r.status !== 0 || !Number.isInteger(port)) {
    throw new Error(`could not pick a refusing port: ${r.stderr || r.stdout}`);
  }
  return String(port);
}
