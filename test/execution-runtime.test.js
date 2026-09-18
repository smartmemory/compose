/** Real Compose -> stdio MCP -> connector -> OS process boundary; no model API. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { runAndNormalize, AgentTimeoutError } from '../lib/result-normalizer.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('normal runtime carries Codex write intent, model/effort, and acknowledged process-tree cancellation', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'compose-execution-runtime-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const executable = join(bin, 'codex');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
fs.writeFileSync('wire.json', JSON.stringify({args, cwd: process.cwd()}));
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  if (prompt.includes('hang-probe')) {
    fs.writeFileSync('parent.pid', String(process.pid));
    process.on('SIGTERM', () => {});
    const child = cp.spawn(process.execPath, ['-e', "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync('ticks','child-start|');setInterval(()=>fs.appendFileSync('ticks','child|'),10)"], {stdio:'inherit'});
    fs.writeFileSync('child.pid', String(child.pid));
    setInterval(() => fs.appendFileSync('ticks', 'parent\\n'), 10);
  } else {
    if (prompt.includes('failure-probe')) {
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,output_tokens:2,total_cost_usd:0.25}}));
      console.log(JSON.stringify({type:'turn.failed',error:{message:'billable codex failure'}}));
      return;
    }
    if (args[args.indexOf('--sandbox') + 1] === 'workspace-write') fs.writeFileSync('artifact.txt', 'implemented');
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
  }
});
`, { mode: 0o755 });
  const stratum = new StratumMcpClient();
  try {
    // Deliberately use the production resolver, not the source-first test helper.
    await stratum.connect({ cwd: root, env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, STRATUM_CODEX_TRANSPORT: 'exec', STRATUM_CANCEL_GRACE_MS: '60',
      STRATUM_STATE_DIR: join(root, 'state'),
    }});
    const step = { step_id: 'execute/0', agent: 'codex' };
    await runAndNormalize(null, 'write-probe', step, {
      stratum, profile: 'codex::standard', cwd: root, sandboxMode: 'workspace-write',
    });
    assert.equal(await readFile(join(root, 'artifact.txt'), 'utf8'), 'implemented');
    const wire = JSON.parse(await readFile(join(root, 'wire.json'), 'utf8'));
    assert.equal(wire.cwd, await realpath(root));
    assert.equal(wire.args[wire.args.indexOf('-m') + 1], 'gpt-5.6-terra');
    assert.ok(wire.args.includes('model_reasoning_effort="high"'));
    await rm(join(root, 'artifact.txt'));
    await runAndNormalize(null, 'read-probe', step, {
      stratum, profile: 'codex:read-only-reviewer:fast', cwd: root,
    });
    await assert.rejects(readFile(join(root, 'artifact.txt')), { code: 'ENOENT' });
    const readWire = JSON.parse(await readFile(join(root, 'wire.json'), 'utf8'));
    assert.equal(readWire.args[readWire.args.indexOf('--sandbox') + 1], 'read-only');
    await runAndNormalize(null, 'explicit-write-probe', step, {
      stratum, profile: 'codex:read-only-reviewer:fast', cwd: root, sandboxMode: 'workspace-write', reviewMode: true,
    });
    assert.equal(await readFile(join(root, 'artifact.txt'), 'utf8'), 'implemented', 'explicit caller sandbox overrides profile and review defaults');
    await assert.rejects(runAndNormalize(null, 'failure-probe', step, {stratum, cwd:root}), error => {
      assert.match(error.message, /billable codex failure/);
      assert.equal(error.usage.tokens,9);assert.equal(error.usage.input_tokens,7);assert.equal(error.usage.output_tokens,2);
      assert.equal(error.usage.usd,0.25);assert.equal(error.usage.usd_source,'reported');return true;
    });
    const started = Date.now();
    await assert.rejects(runAndNormalize(null, 'hang-probe', step, {
      stratum, profile: 'codex::standard', cwd: root, sandboxMode: 'workspace-write', maxDurationMs: 2000,
    }), AgentTimeoutError);
    assert.ok(Date.now() - started < 8000, 'timeout must terminate the process, not await its natural completion');
    const snapshot = await readFile(join(root, 'ticks'), 'utf8');
    assert.match(snapshot, /child-start/);
    assert.match(snapshot, /parent/);
    await pause(150);
    assert.equal(await readFile(join(root, 'ticks'), 'utf8'), snapshot, 'no descendant writes after cancellation returns');
  } finally {
    await stratum.close();
    for (const file of ['parent.pid', 'child.pid']) {
      try { process.kill(Number(await readFile(join(root, file), 'utf8')), 'SIGKILL'); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});


test('Claude profile reaches the SDK through the normal stdio MCP runtime', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'compose-claude-runtime-'));
  const sdk = join(root, 'sdk.mjs');
  const loader = join(root, 'loader.mjs');
  const register = join(root, 'register.mjs');
  await writeFile(sdk, `
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
export async function* query({prompt, options}) {
  writeFileSync(join(options.cwd, 'sdk-options.json'), JSON.stringify({
    tools: options.tools, disallowedTools: options.disallowedTools,
    thinking: options.thinking, effort: options.effort, model: options.model,
    hasAbortSignal: Boolean(options.abortController?.signal),
    hasOwnedProcess: typeof options.spawnClaudeCodeProcess === 'function',
  }));
  yield {type:'result',subtype:prompt.includes('failure-probe')?'error_during_execution':'success',errors:['billable claude failure'],result:'done',total_cost_usd:0.01,
    duration_ms:1,usage:{input_tokens:3,output_tokens:5}};
}
`);
  await writeFile(loader, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@anthropic-ai/claude-agent-sdk') return {url:${JSON.stringify(pathToFileURL(sdk).href)},shortCircuit:true};
  return nextResolve(specifier, context);
}
`);
  await writeFile(register, `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);`);
  const stratum = new StratumMcpClient();
  try {
    await stratum.connect({ cwd: root, env: {
      ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(register).href}`,
      STRATUM_STATE_DIR: join(root, 'state'),
    }});
    const result = await runAndNormalize(null, 'Claude SDK option probe', {step_id:'review',agent:'claude'}, {
      stratum, profile:'claude:read-only-reviewer:critical', cwd:root,
    });
    const actual = JSON.parse(await readFile(join(root, 'sdk-options.json'), 'utf8'));
    assert.deepEqual(actual.tools, ['Read','Grep','Glob','Agent','ToolSearch']);
    assert.deepEqual(actual.disallowedTools, ['Edit','Write','Bash']);
    assert.deepEqual(actual.thinking, {type:'adaptive'});
    assert.equal(actual.effort, 'xhigh');
    assert.equal(actual.hasAbortSignal, true);
    assert.equal(actual.hasOwnedProcess, true);
    assert.equal(result.usage.input_tokens, 3);
    assert.equal(result.usage.output_tokens, 5);
    assert.equal(result.usage.cost_usd, 0.01);
    await assert.rejects(runAndNormalize(null, 'failure-probe', {step_id:'work',agent:'claude'}, {stratum,cwd:root}), error => {
      assert.match(error.message,/billable claude failure/);
      assert.equal(error.usage.tokens,8);assert.equal(error.usage.input_tokens,3);assert.equal(error.usage.output_tokens,5);
      assert.equal(error.usage.usd,0.01);assert.equal(error.usage.usd_source,'reported');return true;
    });
  } finally {
    await stratum.close();
    await rm(root, {recursive:true,force:true});
  }
});


test('an older connected MCP server fails before dispatch instead of dropping execution controls', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'compose-old-runtime-'));
  const serverPath = join(root, 'old-server.mjs');
  await writeFile(serverPath, `
import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
import { writeFileSync } from 'node:fs';
const server = new Server({name:'old-stratum',version:'0.3.3'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{
  name:'stratum_agent_run',inputSchema:{type:'object',properties:{
    agent:{type:'string'},prompt:{type:'string'},cwd:{type:'string'},model:{type:'string'},sandboxMode:{type:'string'}
  }}
}]}));
server.setRequestHandler(CallToolRequestSchema, async () => {
  writeFileSync(${JSON.stringify(join(root, 'unexpected-dispatch'))},'called');
  return {content:[{type:'text',text:'{"text":"should not run"}'}]};
});
await server.connect(new StdioServerTransport());
`);
  const stratum = new StratumMcpClient();
  try {
    await stratum.connect({command:process.execPath,args:[serverPath],cwd:root});
    await assert.rejects(runAndNormalize(null, 'old server probe', {step_id:'review',agent:'claude'}, {
      stratum,profile:'claude:read-only-reviewer:critical',cwd:root,
    }), /does not support.*allowedTools/);
    await assert.rejects(readFile(join(root, 'unexpected-dispatch')), {code:'ENOENT'});
  } finally {
    await stratum.close();
    await rm(root,{recursive:true,force:true});
  }
});
