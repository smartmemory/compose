import { checkedConsumerAdapter } from './helpers/routing-adapter-check.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  StratumMcpClient,
  REQUIRED_STRATUM_SURFACE,
  REQUIRED_STRATUM_RANGE,
} from '../lib/stratum-mcp-client.js';
import { runAndNormalize, AgentTimeoutError, UserInterruptError } from '../lib/result-normalizer.js';
import { reportUsageReceipts } from '../lib/build.js';
import { runLocalClaudeAgent } from '../lib/local-claude-connector.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'compose-review-wire-'));
  const main = join(root, 'server.mjs');
  await writeFile(main, `
import {Server} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import {ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
import {appendFileSync} from 'node:fs';
const mode=${JSON.stringify(mode)};
const server=new Server({name:'fixture-stratum',version:mode==='old'?'0.3.4':'0.4.0'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=> {
  if(mode==='probe-hang') return new Promise(()=>{});
  const fields=mode==='old'?['agent','prompt','cwd']:['agent','prompt','cwd','model','effort','sandboxMode','cancellationId','allowedTools','disallowedTools','thinking','flow'];
  return {tools:[{name:'stratum_agent_run',inputSchema:{type:'object',properties:Object.fromEntries(fields.map(k=>[k,{}]))}}]};
});
let finish;
server.setRequestHandler(CallToolRequestSchema, async request=> {
  appendFileSync('calls',JSON.stringify(request.params)+'\\n');
  if(request.params.name==='stratum_cancel_agent_run') {
    if(mode==='not-found' || mode==='late-usage') finish();
    return {structuredContent:{status:mode==='not-found'?'not_found':'cancelled'},content:[]};
  }
  if(mode==='crash') process.exit(2);
  if(mode==='ack-hang') return new Promise(()=>{});
  if(mode==='not-found') {
    await new Promise(resolve=>{finish=resolve});
    throw new McpError(ErrorCode.InternalError,'request never registered');
  }
  if(mode==='failure') throw new McpError(ErrorCode.InternalError,'billable failure', {code:'agent_run_failed',usage:{tokens:9,usd:0.25,ms:12},split:{input:7,output:2,cacheRead:4},usdSource:'reported'});
  if(mode==='late-usage') {
    await new Promise(resolve=>{finish=resolve});
    return {structuredContent:{text:'late',usage:{tokens:9,usd:0.25,ms:12},split:{input:7,output:2,cacheRead:4},usdSource:'reported',telemetry:{model:'fixture',durationMs:12}},content:[]};
  }
  return {structuredContent:{text:'done',usage:{}},content:[]};
});
await server.connect(new StdioServerTransport());
`);
  const client = new StratumMcpClient();
  await client.connect({ command: process.execPath, args: [main], cwd: root });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  return { client, root };
}

test('late successful MCP cancellation retains dollar provenance through timeout receipts', async t => {
  const { client, root } = await fixture(t, 'late-usage');
  const error = await runAndNormalize(null, 'fixture', { step_id: 'work', agent: 'codex' }, { stratum: client, cwd: root, maxDurationMs: 100 }).catch(error => error);
  assert.ok(error instanceof AgentTimeoutError);
  const receipts = [];
  await reportUsageReceipts({ flowId: 'flow', receiptsMode: true, stratum: { usageReport: async (_flow, receipt) => { receipts.push(receipt); } } }, error.usages ?? error.usage);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].usage, { tokens: 9, ms: 12, usd: 0.25 });
  assert.deepEqual(receipts[0].split, { input: 7, output: 2, cacheRead: 4 });
  assert.equal(receipts[0].usdSource, 'reported');
});

test('old surface accepts a basic call and names installed versus required surface only for requested controls', async t => {
  const {client, root} = await fixture(t, 'old');
  assert.equal((await client.agentRun('codex', 'basic', {cwd:root})).text, 'done');
  await assert.rejects(client.agentRun('claude', 'restricted', {cwd:root,allowedTools:[]}), error => {
    assert.equal(error.code, 'UNSUPPORTED_AGENT_OPTIONS');
    const rangeEsc = REQUIRED_STRATUM_RANGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expected = new RegExp(
      `Installed Stratum 0.3.4.*allowedTools.*surface: ${REQUIRED_STRATUM_SURFACE}.*${rangeEsc}`,
    );
    assert.match(error.message, expected);
    return true;
  });
  assert.equal((await readFile(join(root,'calls'),'utf8')).trim().split('\n').length, 1);
});

test('a stalled listTools probe is released by the execution deadline without dispatch or cancel', {timeout:3000}, async t => {
  const {client, root} = await fixture(t, 'probe-hang');
  await assert.rejects(runAndNormalize(null, 'p', {step_id:'work',agent:'codex'}, {stratum:client,cwd:root,maxDurationMs:30}), AgentTimeoutError);
  await assert.rejects(readFile(join(root,'calls')), {code:'ENOENT'});
});

test('real stdio transport failure preserves the original RPC error and does not attempt cancellation', async t => {
  const {client, root} = await fixture(t, 'crash');
  await assert.rejects(client.agentRun('codex','p',{cwd:root,signal:new AbortController().signal}), error => {
    assert.equal(error.code, -32000);
    assert.match(error.message, /Connection closed/);
    return true;
  });
  assert.equal((await readFile(join(root,'calls'),'utf8')).trim().split('\n').length, 1);
});

for (const mode of ['not-found','ack-hang']) {
  // This asserts cancellation SEMANTICS, not latency, so its budget is generous: the old
  // 3000ms was an unstated assumption about machine load, not a property under test.
  test(`${mode}: explicit cancellation settles or diagnoses the original RPC deadline`, {timeout:30000}, async t => {
    const {client, root} = await fixture(t, mode);
    const controller = new AbortController();
    const running = client.agentRun('codex','p',{cwd:root,signal:controller.signal,cancellationTimeoutMs:40});
    const outcome = running.catch(error=>error);
    // The original RPC must have REACHED the fixture server before we cancel — this test is
    // about cancelling an IN-FLIGHT call. The poll used to give up after 100*5ms and abort
    // anyway, with nothing asserting the precondition held, so a slow child spawn silently
    // turned it into a different test (cancel-BEFORE-dispatch) that then failed on the
    // outcome assertion with nothing pointing at the real cause. Observed twice under a
    // loaded full suite at duration_ms 535, i.e. the poll had just exhausted its 500ms;
    // production was right both times (no original RPC in flight, so it reported the
    // acknowledgement timeout rather than the original RPC's deadline).
    let dispatched = false;
    for(let i=0;i<400;i++){if(await readFile(join(root,'calls')).catch(()=>null)){dispatched=true;break;}await delay(5);}
    assert.ok(dispatched, 'fixture server never recorded the agent_run call within 2s — nothing was in flight to cancel');
    controller.abort();
    const error = await outcome;
    if(mode==='not-found') { assert.equal(error.name,'AbortError'); assert.notEqual(error.code,'CANCELLATION_UNCONFIRMED'); }
    else { assert.equal(error.code,'CANCELLATION_TEARDOWN_TIMEOUT'); assert.match(error.message,/Original agent RPC.*40ms/); }
  });
}

// C11: the engine's string code replaces the JSON-RPC numeric code on the error
// object. Callers depend on the string one, so the numeric one is preserved
// beside it rather than lost.
test('an engine error code does not destroy the JSON-RPC code', async t => {
  const {client, root} = await fixture(t, 'failure');
  await assert.rejects(client.agentRun('codex','p',{cwd:root}), error => {
    assert.equal(error.code, 'agent_run_failed');
    assert.equal(error.rpcCode, -32603);
    return true;
  });
});

test('billable MCP failure reaches the real consumer failureUsageFields and debits its step envelope', async t => {
  const {client, root} = await fixture(t, 'failure');
  const envelopes=[];
  client.stepDone=async (_flow,_step,envelope)=>{envelopes.push(envelope);return {status:'completed',runId:'flow-1'};};
  client.audit=async()=>({});
  const descriptor={id:'work/0',step:'work',flow:'build',itemIndex:0,stage:0,generation:1,attempt:1,epoch:1,dispatchToken:'tok',agent:'codex',do:'fixture',item:{id:'T1'},policy:{isolation:'none'},contract:{root:'R',contracts:{R:{summary:'string'}}}};
  const usage=[];
  await checkedConsumerAdapter({descriptor,flowId:'flow-1',stratum:client,
    artifacts:{hooks:{},reconcileDescriptor:()=>({action:'execute',worktree:root}),prepareIssuance:()=>({diff:''}),reconcileAudit(){},restoreToPreStageWitness(){}},
    localSpec:{flows:{build:{steps:[{id:'work',fanout:{steps:[{agent:'codex',do:'fixture',out:'R'}]}}]}},contracts:descriptor.contract.contracts},
    context:{cwd:root,flowId:'flow-1',receiptsMode:false,onUsage:value=>usage.push(value)},
    progress:Object.assign(new EventEmitter(),{stepStart(){},stepDone(){},warn(){},debug(){},info(){},toolUse(){},toolSummary(){},findings(){}}),streamWriter:{write(){}},
  });
  assert.equal(envelopes.length,1);
  assert.deepEqual(envelopes[0].usage,{tokens:9,usd:0.25,ms:12});
  assert.equal(usage[0].input_tokens,7);
  assert.equal(usage[0].output_tokens,2);
  assert.equal(usage[0].usd_source,'reported');
});

test('primary user interruption preserves reported failure usage', async () => {
  const ui=Object.assign(new EventEmitter(),{consumeAction:()=> 'skip',debug(){},warn(){}});
  const stratum={onEvent:()=>()=>{},agentRun:async(_a,_p,{signal})=>{
    queueMicrotask(()=>ui.emit('interrupt'));
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    throw Object.assign(new Error('stopped'),{usage:{tokens:9,usd:0.25}});
  }};
  await assert.rejects(runAndNormalize(null,'p',{step_id:'work',agent:'codex'},{stratum,progress:ui}),error=>{
    assert.ok(error instanceof UserInterruptError);assert.deepEqual(error.usage,{tokens:9,usd:0.25});return true;
  });
});

for(const stubborn of [false,true]) test(`local Claude waits for owned parent and descendant close (${stubborn?'KILL escalation':'TERM cleanup'})`, {timeout:4000}, async t => {
  const root=await mkdtemp(join(tmpdir(),'local-claude-cancel-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const controller=new AbortController();
  const script=`const fs=require('fs'),{spawn}=require('child_process');process.on('SIGTERM',()=>{fs.writeFileSync('term','seen');${stubborn?'':'setTimeout(()=>process.exit(0),20)'}});spawn(process.execPath,['-e',"const fs=require('fs');process.on('SIGTERM',()=>{${stubborn?'':'process.exit(0)'}});setInterval(()=>fs.appendFileSync('ticks','child|'),5)"],{stdio:'inherit'});setInterval(()=>fs.appendFileSync('ticks','parent|'),5);`;
  const running=runLocalClaudeAgent('fixture',{cwd:root,abortController:controller,cancellationGraceMs:80,query:async function*({options}){
    options.spawnClaudeCodeProcess({command:process.execPath,args:['-e',script],cwd:root,env:process.env,signal:new AbortController().signal});
    await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));
    controller.signal.throwIfAborted();
  }}).catch(error=>error);
  try {
    for(let i=0;i<200;i++){if((await readFile(join(root,'ticks'),'utf8').catch(()=>'' )).includes('child'))break;await delay(5);}
    assert.match(await readFile(join(root,'ticks'),'utf8'),/child/);
    controller.abort(new Error('stop'));
    assert.match((await running).message,/stop/);
    assert.equal(await readFile(join(root,'term'),'utf8'),'seen');
    const stopped=await readFile(join(root,'ticks'),'utf8');await delay(50);
    assert.equal(await readFile(join(root,'ticks'),'utf8'),stopped);
  } finally {controller.abort();await running;}
});

// C2: Windows has no process groups. The connector used to call
// requireProcessGroups() for ANY run carrying an abortController — and
// runAndNormalize always builds one — so every local Claude dispatch on win32
// threw CANCELLATION_UNSUPPORTED_PLATFORM before spawning. It must now run,
// falling back to the SDK's own (weaker, leader-only) abort.
for (const [platform, wantsHook] of [['win32', false], ['linux', true]]) {
  test(`local Claude on ${platform} ${wantsHook ? 'owns its process group' : 'runs without process groups'}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'local-claude-platform-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const controller = new AbortController();
    let seen = null;
    const result = await runLocalClaudeAgent('fixture', {
      cwd: root, abortController: controller, platform,
      query: async function* ({ options }) {
        seen = options;
        yield { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 }, duration_ms: 1 };
      },
    });
    assert.equal(result.text, 'ok', 'a non-cancel run must never fail before spawn');
    assert.equal(result.usage.tokens, 7);
    assert.equal(typeof seen.spawnClaudeCodeProcess === 'function', wantsHook);
    assert.equal(seen.abortController, controller, 'the SDK abort path is always wired');
  });
}

// D-TERM-1 (2026-09-07). `14be1a7` added the group-signal failure stamp with no
// test at all, and its leader probe cannot discriminate anything: after `close`
// the leader is reaped, so it reads `gone` in every realistic recurrence. The
// stamp that answers the question is the GROUP MEMBER LISTING, so it is driven
// here through the real producer — `processTermination` against a real group
// that really refuses our signal — never a `ps` double.
test('a refused group signal is stamped with who is actually in the group', async (t) => {
  if (process.platform === 'win32') return t.skip('no process groups');
  if (process.getuid?.() === 0) return t.skip('running as root can signal anything');

  // A root-owned group leader: a group that exists and refuses us, which is
  // exactly what EPERM means (measured on Darwin: EPERM, not ESRCH).
  // pgid 1 is EXCLUDED deliberately — `kill(-1, sig)` is not "group 1", it is
  // the POSIX broadcast to every process we may signal.
  const { execFileSync } = await import('node:child_process');
  const table = execFileSync('ps', ['-eo', 'pid=,pgid=,uid='], { encoding: 'utf8' });
  const foreign = table.split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .find(([pid, pgid, uid]) => pid === pgid && pid > 1 && uid === 0);
  if (!foreign) return t.skip('no root-owned process group to probe');
  const [pgid] = foreign;

  const child = Object.assign(new EventEmitter(), { pid: pgid });
  const mod = await import('../lib/process-termination.js');
  // SIGTERM at this group is REFUSED by the kernel before delivery — that
  // refusal is the fixture. The uid guard above is what keeps it a fixture.
  const error = await mod.processTermination(child, true, 0, 20).terminate().catch((e) => e);

  assert.equal(error.code, 'CANCELLATION_UNCONFIRMED');
  assert.equal(error.killSite, 'send', 'the failing call site is named');
  assert.equal(error.killTarget, -pgid);
  assert.ok(Array.isArray(error.killGroupMembers), 'the group was enumerated');
  assert.ok(error.killGroupMembers.length > 0, 'and it is not empty — EPERM means a group EXISTS');
  // The discriminator: a member whose uid is not ours says "we may not signal
  // this", not "the pgid was recycled". Reading `not-ours` as a recycled pgid
  // was the wrong inference this stamp replaces.
  assert.ok(
    error.killGroupMembers.some((m) => m.uid !== process.getuid()),
    'a foreign uid in the listing is what separates a refusal from a recycled pgid',
  );
  assert.match(error.message, /group members: /);
  assert.match(error.message, /our uid \d+/);
});

// The listing runs on an error path, so a failure to read `ps` must be recorded
// as a field, never raised — a second failure there would replace the first.
test('an unreadable process table degrades the stamp instead of throwing', async (t) => {
  if (process.platform === 'win32') return t.skip('no process groups');
  const child = Object.assign(new EventEmitter(), { pid: 999999 });
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); });
  const oldPath = process.env.PATH;
  process.env.PATH = '/nonexistent';   // `ps` cannot be found
  try {
    const mod = await import('../lib/process-termination.js');
    const error = await mod.processTermination(child, true, 0, 20).terminate().catch((e) => e);
    assert.equal(error.code, 'CANCELLATION_UNCONFIRMED');
    assert.equal(Array.isArray(error.killGroupMembers), false);
    assert.ok(error.killGroupMembers.error, 'the read failure is recorded as a field');
    assert.match(error.message, /group members: unreadable/);
  } finally {
    process.env.PATH = oldPath;
  }
});

// C7: process-termination.js is compose's own module now (it was copied
// compiled TypeScript). Only the export compose uses survives, and the grace
// period reads a compose-owned env var.
test('process-termination exports only processTermination and validates its grace env', async () => {
  const mod = await import('../lib/process-termination.js');
  assert.deepEqual(Object.keys(mod).sort(), ['processTermination']);
  const child = new EventEmitter();
  child.pid = null; child.kill = () => {};
  const old = process.env.COMPOSE_CANCEL_GRACE_MS;
  process.env.COMPOSE_CANCEL_GRACE_MS = 'not-a-number';
  try {
    assert.throws(() => mod.processTermination(child, false), /COMPOSE_CANCEL_GRACE_MS/);
  } finally {
    if (old === undefined) delete process.env.COMPOSE_CANCEL_GRACE_MS; else process.env.COMPOSE_CANCEL_GRACE_MS = old;
  }
});
