// Stand-in for server/supervisor.js in test/cockpit-start-piped.test.js: listens on STUB_PORTS and idles until killed.
import http from 'node:http';
for (const p of (process.env.STUB_PORTS || '').split(' ').filter(Boolean)) http.createServer((q, r) => r.end('ok')).listen(Number(p), '127.0.0.1');
setInterval(() => {}, 1 << 30);
