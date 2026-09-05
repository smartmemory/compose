import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import express from 'express';
import { EventEmitter } from 'node:events';
import { FileWatcherServer } from '../server/file-watcher.js';
import { BuildStreamBridge } from '../server/build-stream-bridge.js';
import { WorkspaceRuntime } from '../server/workspace-runtime.js';
import { createAgentApp } from '../server/agent-workspace.js';
import { getTargetRoot, switchProject, withProjectContext, loadProjectConfig, prepareProject } from '../server/project-root.js';
import { HealthMonitor } from '../server/agent-health.js';
import { CoalescingBuffer } from '../server/coalescing-buffer.js';
import { PassThrough } from 'node:stream';
import { attachBuildRoutes } from '../server/build-routes.js';
import { _getDesignStratumForTest, closeDesignStratum } from '../server/design-routes.js';

// Real Express routing with Node HTTP request/response objects; no TCP listener.
function httpRequest(app, url, options={}) {
  const socket=new PassThrough();const request=new http.IncomingMessage(socket);
  request.url=url;request.method=options.method??'GET';request.headers=options.headers??{};
  if(options.body)request.body=JSON.parse(options.body);
  const response=new http.ServerResponse(request);
  options.onResponse?.(response);
  return new Promise((resolve,reject)=>{
    response.on('error',reject);
    response.end=body=>{
      resolve({status:response.statusCode,json:async()=>JSON.parse(String(body))});
      response.emit('finish');socket.destroy();return response;
    };
    app.handle(request,response);
  });
}

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function project(root,name,config={}) {
  const path=join(root,name);await mkdir(join(path,'.compose'),{recursive:true});
  await writeFile(join(path,'.compose','compose.json'),JSON.stringify({workspaceId:name,capabilities:{stratum:false},...config}));
  return path;
}

test('workspace HTTP prepares unvisited roots, handles no active root, refreshes switched config, and enforces capacity',{timeout:5000},async t=>{
  // OS watchers are outside this route/config test; real watcher coverage stays in workspace-switch-runtime.
  t.mock.method(FileWatcherServer.prototype, 'startWatching', () => {});
  const oldRoot=getTargetRoot();
  const oldToken=process.env.COMPOSE_API_TOKEN;process.env.COMPOSE_API_TOKEN='test-runtime-token';
  t.after(()=>{if(oldToken===undefined)delete process.env.COMPOSE_API_TOKEN;else process.env.COMPOSE_API_TOKEN=oldToken;});
  const root=await mkdtemp(join(tmpdir(),'workspace-review-'));
  const a=await project(root,'a'); const b=await project(root,'b'); const c=await project(root,'c');
  const app=express();app.use(express.json());
  const server=http.createServer(app);const runtime=new WorkspaceRuntime(server,{maxWorkspaces:2});
  app.use((req,res,next)=>{if(req.get('x-test-root'))req.workspace={root:req.get('x-test-root')};runtime.handle(req,res,next);});
  const url='';
  t.after(async()=>{runtime.close();switchProject(oldRoot);await rm(root,{recursive:true,force:true});});
  let response=await httpRequest(app,url+'/api/settings');
  assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'No workspace selected',code:'WorkspaceUnset',root:null});
  response=await httpRequest(app,url+'/api/settings',{headers:{'x-test-root':a}});
  assert.equal(response.status,200);assert.equal(runtime.active,null);assert.equal(runtime.contexts.size,1);
  runtime.switch(a);runtime.switch(b);
  await writeFile(join(a,'.compose','compose.json'),JSON.stringify({workspaceId:'a',capabilities:{stratum:false,guardAuth:true},paths:{features:'new-features'}}));
  const refreshed=runtime.switch(a);
  assert.equal(withProjectContext(refreshed.binding,()=>loadProjectConfig().paths.features),'new-features');
  response=await httpRequest(app,url+'/api/vision/items',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'auth required',type:'feature'})});
  assert.equal(response.status,401,'refreshed guardAuth applies to existing routes');
  // C3: the cap only refuses when nothing is evictable, so pin the one idle
  // retained workspace as busy; the LRU path has its own test below.
  const retainedB=runtime.get(b);retainedB.sessionManager.currentSession={id:'busy'};
  assert.throws(()=>runtime.switch(c),{code:'WorkspaceCapacityExceeded'});
  assert.equal(runtime.contexts.size,2);assert.equal(runtime.active,refreshed);
  await writeFile(join(a,'.compose','compose.json'),JSON.stringify({workspaceId:'a',capabilities:{stratum:false}}));
  runtime.switch(a);
  assert.equal(withProjectContext(refreshed.binding,()=>loadProjectConfig().paths?.features),undefined,'removed config keys do not survive refresh');
  const permitted=await httpRequest(app,'/api/vision/items',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'auth disabled',type:'feature'})});
  assert.equal(permitted.status,201);
  await assert.rejects(readFile(join(c,'.compose/data/vision-state.json')),{code:'ENOENT'});
});

test('SDK workspace header cannot create an arbitrary workspace, and retained SDK contexts are bounded',{timeout:5000},async t=>{
  t.mock.method(BuildStreamBridge.prototype, 'start', () => {});
  const root=await mkdtemp(join(tmpdir(),'agent-workspace-review-'));
  const a=await project(root,'a');const b=await project(root,'b');const arbitrary=join(root,'arbitrary');await mkdir(arbitrary);
  const oldToken=process.env.COMPOSE_API_TOKEN;process.env.COMPOSE_API_TOKEN='test-workspace-token';
  let queries=0;const sdk=createAgentApp({query:()=>{queries++;throw new Error('must not run');},maxWorkspaces:1});
  
  t.after(async()=>{sdk.close();if(oldToken===undefined)delete process.env.COMPOSE_API_TOKEN;else process.env.COMPOSE_API_TOKEN=oldToken;await rm(root,{recursive:true,force:true});});
  const request=target=>httpRequest(sdk.app,'/api/agent/session/status',{headers:{'x-compose-project-root':target,'x-compose-token':'test-workspace-token'}});
  assert.equal((await request(arbitrary)).status,400);
  await assert.rejects(readFile(join(arbitrary,'.compose/data/settings.json')),{code:'ENOENT'});
  const accepted=await request(a);assert.equal(accepted.status,200,JSON.stringify(await accepted.json()));
  await writeFile(join(a, '.compose', 'data', 'active-build.json'), JSON.stringify({ status: 'running' }));
  const rejected=await request(b);assert.equal(rejected.status,409);assert.equal((await rejected.json()).code,'WorkspaceCapacityExceeded');
  assert.equal(queries,0);assert.equal((await request(a)).status,200);
});

test('suspended workspace health and coalescing services stay quiet and resume',async()=>{
  const messages=[];const proc=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),kill(){throw new Error('must not kill');}});
  const monitor=new HealthMonitor({broadcastMessage:msg=>messages.push(msg),silenceWarningMs:15,silenceKillMs:1000,defaultTimeoutMs:10000});
  const flushed=[];const buffer=new CoalescingBuffer(value=>flushed.push(value),{intervalMs:5});buffer.register('state','latest-wins');
  const {VisionServer}=await import('../server/vision-server.js');
  const owner=Object.assign(Object.create(VisionServer.prototype),{_healthMonitor:monitor,_coalescingBuffer:buffer,clients:new Set(),_config:{capabilities:{stratum:false}}});
  try {
    monitor.track('a',proc);owner.suspend();proc.stdout.emit('data','activity');buffer.put('state',1);
    await delay(45);assert.deepEqual(messages,[]);assert.deepEqual(flushed,[]);assert.equal(monitor.isTracked('a'),true);
    owner.resume();await delay(40);assert.equal(messages[0].type,'agentSilent');assert.deepEqual(flushed,[{state:1}]);
  } finally {monitor.destroy();buffer.stop();}
});

// C3: retention was a hard wall — the 9th project was refused with "restart to
// release retained sessions" even when every retained workspace was idle.
test('workspace retention evicts the least-recently-used idle workspace and refuses only when all are busy',{timeout:5000},async t=>{
  t.mock.method(FileWatcherServer.prototype,'startWatching',()=>{});
  const oldRoot=getTargetRoot();
  const root=await mkdtemp(join(tmpdir(),'workspace-retention-'));
  const a=await project(root,'a');const b=await project(root,'b');const c=await project(root,'c');const d=await project(root,'d');
  const app=express();app.use(express.json());
  const server=http.createServer(app);const runtime=new WorkspaceRuntime(server,{maxWorkspaces:2});
  t.after(async()=>{runtime.close();switchProject(oldRoot);await rm(root,{recursive:true,force:true});});
  const closed=[];
  t.mock.method(FileWatcherServer.prototype,'close',function(){closed.push(this.projectRoot);});
  runtime.switch(a);runtime.switch(b);
  assert.equal(runtime.contexts.size,2);
  const evictable=runtime.get(a);
  // a is idle and least-recently-used; c takes its slot instead of being refused.
  const withC=runtime.switch(c);
  assert.equal(runtime.active,withC);
  assert.equal(runtime.contexts.size,2,'the cap still bounds retention');
  assert.equal(runtime.get(a),undefined,'the idle LRU workspace was evicted');
  assert.ok(runtime.get(b),'a retained non-LRU workspace survives');
  assert.ok(closed.includes(evictable.binding.targetRoot),'the evicted workspace was closed, not dropped');
  // Now every retained workspace is busy: c is active, b holds a live session.
  runtime.get(b).sessionManager.currentSession={id:'busy'};
  assert.throws(()=>runtime.switch(d),{code:'WorkspaceCapacityExceeded'});
  assert.equal(runtime.contexts.size,2);
  assert.equal(runtime.active,withC,'a refused switch never moves the active workspace');
  // A live vision socket is also work: freeing the session but holding a client keeps it.
  runtime.get(b).sessionManager.currentSession=null;
  runtime.get(b).visionServer.clients.add({readyState:1,close(){},send(){}});
  assert.throws(()=>runtime.switch(d),{code:'WorkspaceCapacityExceeded'});
  runtime.get(b).visionServer.clients.clear();
  assert.ok(runtime.switch(d),'freeing the last busy workspace makes room again');
  assert.equal(runtime.get(b),undefined);
});

// C4: refreshConfig used to clear its own holder before copying, so passing the
// context's OWN config back through switch() emptied it. The write goes through
// switch(); the read goes through the project-context path the routes use.
test('switching with a workspace\'s own config object preserves it',{timeout:5000},async t=>{
  t.mock.method(FileWatcherServer.prototype,'startWatching',()=>{});
  const oldRoot=getTargetRoot();
  const root=await mkdtemp(join(tmpdir(),'workspace-config-alias-'));
  const a=await project(root,'a',{paths:{features:'specs'}});
  const app=express();app.use(express.json());
  const server=http.createServer(app);const runtime=new WorkspaceRuntime(server);
  t.after(async()=>{runtime.close();switchProject(oldRoot);await rm(root,{recursive:true,force:true});});
  const context=runtime.switch(a);
  const aliased=context.binding.config;
  assert.equal(aliased.paths.features,'specs');
  runtime.switch(a,aliased);
  const seen=withProjectContext(context.binding,()=>loadProjectConfig());
  assert.equal(seen.paths.features,'specs','the config survives being handed back to switch');
  assert.equal(seen.capabilities.stratum,false);
  assert.equal(context.visionServer.config.paths.features,'specs');
  assert.equal(context.binding.config,context.visionServer.config,'both holders point at one object');
});

// C6: a route that throws synchronously used to be reported as an unavailable
// workspace (400 with the raw message), hiding real route bugs.
test('a throwing route reaches the error handler instead of becoming a workspace 400',{timeout:5000},async t=>{
  t.mock.method(FileWatcherServer.prototype,'startWatching',()=>{});
  const oldRoot=getTargetRoot();
  const root=await mkdtemp(join(tmpdir(),'workspace-route-error-'));
  const a=await project(root,'a');
  const app=express();app.use(express.json());
  const server=http.createServer(app);const runtime=new WorkspaceRuntime(server);
  t.after(async()=>{runtime.close();switchProject(oldRoot);await rm(root,{recursive:true,force:true});});
  const context=runtime.switch(a);
  context.router.get('/api/boom',()=>{throw new Error('route bug with internals');});
  const handled=[];
  app.use((req,res,next)=>runtime.handle(req,res,next));
  // eslint-disable-next-line no-unused-vars
  app.use((err,req,res,_next)=>{handled.push(err.message);res.statusCode=500;res.end(JSON.stringify({error:'Internal error'}));});
  const response=await httpRequest(app,'/api/boom');
  assert.equal(response.status,500);
  assert.deepEqual(await response.json(),{error:'Internal error'});
  assert.deepEqual(handled,['route bug with internals']);
});

// C8: switching to the workspace already active used to suspend() it, which
// closes every vision WebSocket with code 1000 — the cockpit dropped its live
// connection on a no-op switch.
test('re-switching to the active workspace keeps its vision sockets open',{timeout:5000},async t=>{
  t.mock.method(FileWatcherServer.prototype,'startWatching',()=>{});
  const oldRoot=getTargetRoot();
  const root=await mkdtemp(join(tmpdir(),'workspace-same-switch-'));
  const a=await project(root,'a');
  const app=express();app.use(express.json());
  const server=http.createServer(app);const runtime=new WorkspaceRuntime(server);
  t.after(async()=>{runtime.close();switchProject(oldRoot);await rm(root,{recursive:true,force:true});});
  const context=runtime.switch(a);
  const closes=[];
  const socket={readyState:1,close:(code,reason)=>closes.push({code,reason}),send(){}};
  context.visionServer.clients.add(socket);
  assert.equal(runtime.switch(a),context);
  assert.deepEqual(closes,[],'a same-root switch must not close vision clients');
  assert.ok(context.visionServer.clients.has(socket));
  // A real switch away still tears the socket down.
  const b=await project(root,'b');
  runtime.switch(b);
  assert.deepEqual(closes,[{code:1000,reason:'Workspace changed'}]);
});

// C10: a malformed compose.json is fatal (it must not silently become the
// default config), but the failure has to name the file and the way out.
test('a malformed compose.json fails with the file name and a remedy',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workspace-bad-config-'));
  t.after(async()=>rm(root,{recursive:true,force:true}));
  const bad=await project(root,'bad');
  await writeFile(join(bad,'.compose','compose.json'),'{');
  assert.throws(()=>prepareProject(bad),error=>{
    assert.equal(error.code,'InvalidProjectConfig');
    assert.ok(error.message.includes(join(bad,'.compose','compose.json')),error.message);
    assert.match(error.message,/Fix the file or delete it/);
    return true;
  });
  // A workspace with NO config still falls back to defaults.
  const bare=join(root,'bare');await mkdir(bare,{recursive:true});
  assert.equal(prepareProject(bare).config.capabilities.lifecycle,true);
});

test('agent workspace LRU evicts idle history and protects an unfinished SDK query', async t => {
  t.mock.method(BuildStreamBridge.prototype, 'start', () => {});
  const root = await mkdtemp(join(tmpdir(), 'sdk-lru-'));
  const a = await project(root, 'a'); const b = await project(root, 'b'); const c = await project(root, 'c');
  const oldToken = process.env.COMPOSE_API_TOKEN; process.env.COMPOSE_API_TOKEN = 'lru-token';
  let release;
  const sdk = createAgentApp({ maxWorkspaces: 2, query: async function* ({ prompt, options }) {
    yield { type: 'system', subtype: 'init', session_id: options.cwd };
    if (prompt === 'hold') await new Promise(resolve => { release = resolve; });
  } });
  t.after(async () => { release?.(); sdk.close(); if (oldToken === undefined) delete process.env.COMPOSE_API_TOKEN; else process.env.COMPOSE_API_TOKEN = oldToken; await rm(root, { recursive: true, force: true }); });
  const request = (target, prompt) => httpRequest(sdk.app, prompt ? '/api/agent/session' : '/api/agent/session/status', {
    headers: { 'x-compose-project-root': target, 'x-compose-token': 'lru-token' },
    ...(prompt ? { method: 'POST', body: JSON.stringify({ prompt }) } : {}),
  });
  assert.equal((await request(a, 'hold')).status, 200);
  await delay(0);
  assert.equal((await request(b)).status, 200);
  assert.equal((await request(c)).status, 200, 'idle b must be evicted despite the live query in a');
  assert.equal((await (await request(a)).json()).active, true, 'live query survives eviction pressure');
  release(); await delay(0);
  assert.equal((await request(b)).status, 200);
  assert.equal((await (await request(a)).json()).sessionId, (await import('node:fs')).realpathSync(a), 'a was touched more recently than c');
});

test('retention protects active HTTP builds and monitored agents but permits terminal build history', async t => {
  t.mock.method(FileWatcherServer.prototype, 'startWatching', () => {});
  const oldRoot = getTargetRoot();
  const oldToken = process.env.COMPOSE_API_TOKEN; process.env.COMPOSE_API_TOKEN = 'build-token';
  const root = await mkdtemp(join(tmpdir(), 'workspace-busy-'));
  const a = await project(root, 'a'); const b = await project(root, 'b'); const c = await project(root, 'c');
  const app = express(); const runtime = new WorkspaceRuntime(http.createServer(app), { maxWorkspaces: 2 });
  let release; let began;
  const started = new Promise(resolve => { began = resolve; });
  const context = runtime.switch(a);
  const buildRouter = express.Router();
  attachBuildRoutes(buildRouter, { runBuild: async () => { began(); await new Promise(resolve => { release = resolve; }); return { ok: true }; } });
  context.router.use('/fixture', buildRouter);
  app.use((req, res, next) => runtime.handle(req, res, next));
  let response;
  const pending = httpRequest(app, '/fixture/api/build/start', { method: 'POST', body: JSON.stringify({ featureCode: 'F1' }), headers: { 'x-compose-token': 'build-token' }, onResponse: value => { response = value; } });
  t.after(async () => { release?.(); await pending; runtime.close(); switchProject(oldRoot); if (oldToken === undefined) delete process.env.COMPOSE_API_TOKEN; else process.env.COMPOSE_API_TOKEN = oldToken; await rm(root, { recursive: true, force: true }); });
  await started;
  response.emit('close'); // Disconnect does not cancel an asynchronous build.
  runtime.switch(b);
  assert.throws(() => runtime.switch(c), { code: 'WorkspaceCapacityExceeded' }, 'HTTP build has not written active-build yet');
  release(); await pending;
  const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  context.visionServer._healthMonitor.track('unsaved-agent', proc);
  assert.throws(() => runtime.switch(c), { code: 'WorkspaceCapacityExceeded' }, 'live process survives missing registry file');
  context.visionServer._healthMonitor.untrack('unsaved-agent');
  await writeFile(join(context.binding.dataDir, 'active-build.json'), JSON.stringify({ status: 'complete', pid: process.pid }));
  assert.ok(runtime.switch(c), 'completed build history must not pin an idle workspace');
});

test('artifact routes use the refreshed features path', async t => {
  t.mock.method(FileWatcherServer.prototype, 'startWatching', () => {});
  const oldRoot = getTargetRoot(); const root = await mkdtemp(join(tmpdir(), 'artifact-refresh-'));
  const a = await project(root, 'a'); const app = express();
  const runtime = new WorkspaceRuntime(http.createServer(app));
  t.after(async () => { runtime.close(); switchProject(oldRoot); await rm(root, { recursive: true, force: true }); });
  const context = runtime.switch(a);
  context.store.items.set('item', { id: 'item', lifecycle: { featureCode: 'F1' } });
  await mkdir(join(a, 'relocated', 'F1'), { recursive: true });
  await writeFile(join(a, 'relocated', 'F1', 'design.md'), '# Problem\nFixture\n# Goal\nFresh location');
  await writeFile(join(a, '.compose', 'compose.json'), JSON.stringify({ capabilities: { stratum: false }, paths: { features: 'relocated' } }));
  runtime.switch(a);
  app.use((req, res, next) => runtime.handle(req, res, next));
  const result = await httpRequest(app, '/api/vision/items/item/artifacts');
  assert.equal(result.status, 200);
  assert.equal((await result.json()).artifacts['design.md'].exists, true);
});

for (const completion of [false, true]) test(`design ${completion ? 'completion after disconnect' : 'dispatch after HTTP response'} pins its workspace`, async t => {
  t.mock.method(FileWatcherServer.prototype, 'startWatching', () => {});
  const oldRoot = getTargetRoot(); const root = await mkdtemp(join(tmpdir(), 'design-busy-'));
  const a = await project(root, 'a'); const b = await project(root, 'b'); const c = await project(root, 'c');
  const savedEnv = { NODE_ENV: process.env.NODE_ENV, COMPOSE_DESIGN_DISPATCH: process.env.COMPOSE_DESIGN_DISPATCH };
  delete process.env.NODE_ENV; process.env.COMPOSE_DESIGN_DISPATCH = '1';
  const app = express(); const runtime = new WorkspaceRuntime(http.createServer(app), { maxWorkspaces: 2 });
  const context = runtime.switch(a);
  let release; let began; const started = new Promise(resolve => { began = resolve; });
  let pending; let response;
  await _getDesignStratumForTest(context.binding.targetRoot, { factory: () => ({
    connect: async () => {}, close: async () => {}, onEvent: () => () => {},
    runAgentText: async () => { began(); await new Promise(resolve => { release = resolve; }); return '# Fixture design'; },
    agentRun: async () => { began(); await new Promise(resolve => { release = resolve; }); return { text: 'fixture answer' }; },
  }) });
  t.after(async () => { release?.(); await pending; await delay(0); await closeDesignStratum(); runtime.close(); switchProject(oldRoot); for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(root, { recursive: true, force: true }); });
  app.use((req, res, next) => runtime.handle(req, res, next));
  assert.equal((await httpRequest(app, '/api/design/start', { method: 'POST', body: JSON.stringify({ scope: 'product' }) })).status, 200);
  if (completion) pending = httpRequest(app, '/api/design/complete', { method: 'POST', body: JSON.stringify({ scope: 'product' }), onResponse: value => { response = value; } });
  else assert.equal((await httpRequest(app, '/api/design/message', { method: 'POST', body: JSON.stringify({ scope: 'product', type: 'text', content: 'fixture prompt' }) })).status, 200);
  await started;
  response?.emit('close');
  runtime.switch(b);
  assert.throws(() => runtime.switch(c), { code: 'WorkspaceCapacityExceeded' });
  release(); await pending; await delay(0);
  assert.ok(runtime.switch(c));
});

test('SDK eviction protects a replaced iterator until it settles, even if return rejects', async t => {
  t.mock.method(BuildStreamBridge.prototype, 'start', () => {});
  const root = await mkdtemp(join(tmpdir(), 'sdk-draining-'));
  const a = await project(root, 'a'); const b = await project(root, 'b');
  const token = process.env.COMPOSE_API_TOKEN; process.env.COMPOSE_API_TOKEN = 'draining-token';
  let release; let count = 0;
  const sdk = createAgentApp({ maxWorkspaces: 1, query: () => ++count === 1 ? {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise(resolve => { release = () => resolve({ done: true }); }),
    return: async () => { throw new Error('cleanup refused'); },
  } : (async function* () {})() });
  t.after(async () => { release?.(); await delay(0); sdk.close(); if (token === undefined) delete process.env.COMPOSE_API_TOKEN; else process.env.COMPOSE_API_TOKEN = token; await rm(root, { recursive: true, force: true }); });
  const request = (target, prompt) => httpRequest(sdk.app, prompt ? '/api/agent/session' : '/api/agent/session/status', {
    headers: { 'x-compose-project-root': target, 'x-compose-token': 'draining-token' },
    ...(prompt ? { method: 'POST', body: JSON.stringify({ prompt }) } : {}),
  });
  await request(a, 'first'); await request(a, 'replacement'); await delay(0);
  assert.equal((await request(b)).status, 409);
  release(); await delay(0);
  assert.equal((await request(b)).status, 200);
});

test('SDK eviction protects SSE subscribers until disconnect', async t => {
  t.mock.method(BuildStreamBridge.prototype, 'start', () => {});
  const root = await mkdtemp(join(tmpdir(), 'sdk-sse-busy-'));
  const a = await project(root, 'a'); const b = await project(root, 'b');
  const token = process.env.COMPOSE_API_TOKEN; process.env.COMPOSE_API_TOKEN = 'stream-token';
  const sdk = createAgentApp({ maxWorkspaces: 1, query: () => { throw new Error('must not run'); } });
  const socket = new PassThrough(); const req = new http.IncomingMessage(socket); const res = new http.ServerResponse(req);
  req.method = 'GET'; req.url = '/api/agent/stream'; req.headers = { 'x-compose-project-root': a, 'x-compose-token': 'stream-token' };
  res.flushHeaders = () => {}; res.write = () => true;
  sdk.app.handle(req, res);
  t.after(async () => { req.emit('close'); sdk.close(); socket.destroy(); if (token === undefined) delete process.env.COMPOSE_API_TOKEN; else process.env.COMPOSE_API_TOKEN = token; await rm(root, { recursive: true, force: true }); });
  const request = () => httpRequest(sdk.app, '/api/agent/session/status', { headers: { 'x-compose-project-root': b, 'x-compose-token': 'stream-token' } });
  assert.equal((await request()).status, 409);
  req.emit('close');
  assert.equal((await request()).status, 200);
});

test('an invalid switch at capacity does not evict a retained workspace', async t => {
  t.mock.method(FileWatcherServer.prototype, 'startWatching', () => {});
  const oldRoot = getTargetRoot(); const root = await mkdtemp(join(tmpdir(), 'invalid-switch-lru-'));
  const a = await project(root, 'a'); const b = await project(root, 'b');
  const runtime = new WorkspaceRuntime(http.createServer(), { maxWorkspaces: 2 });
  t.after(async () => { runtime.close(); switchProject(oldRoot); await rm(root, { recursive: true, force: true }); });
  const retained = runtime.switch(a); const active = runtime.switch(b);
  assert.throws(() => runtime.switch(join(root, 'missing')), { code: 'ENOENT' });
  assert.equal(runtime.get(a), retained);
  assert.equal(runtime.active, active);
  assert.equal(runtime.contexts.size, 2);
});

test('workspace eviction closes only its own idle design MCP connection', async t => {
  t.mock.method(FileWatcherServer.prototype, 'startWatching', () => {});
  const oldRoot = getTargetRoot(); const root = await mkdtemp(join(tmpdir(), 'evicted-design-client-'));
  const a = await project(root, 'a'); const b = await project(root, 'b'); const c = await project(root, 'c');
  const runtime = new WorkspaceRuntime(http.createServer(), { maxWorkspaces: 2 });
  const closed = [];
  t.after(async () => { runtime.close(); await closeDesignStratum(); switchProject(oldRoot); await rm(root, { recursive: true, force: true }); });
  for (const target of [a, b]) {
    const context = runtime.switch(target);
    await _getDesignStratumForTest(context.binding.targetRoot, { factory: () => ({ connect: async () => {}, close: async () => { closed.push(target); } }) });
  }
  runtime.switch(c);
  assert.deepEqual(closed, [a]);
});
