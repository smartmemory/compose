/**
 * Product kickoff runner for `compose new` using the Stratum TS ready loop.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import YAML from 'yaml';

import { StratumMcpClient } from './stratum-mcp-client.js';
import { runAndNormalize } from './result-normalizer.js';
import { buildStepPrompt, buildGateContext } from './step-prompt.js';
import { promptGate } from './gate-prompt.js';
import { VisionWriter } from './vision-writer.js';
import { readFlowRound } from './flow-state.js';
import { validateStep } from './step-validator.js';

const KICKOFF_VALIDATION = new Map([
  ['research', {
    artifact: 'docs/discovery/research.md',
    criteria: [
      'Contains at least 2 existing tools or prior art entries',
      'Mentions architectural patterns or common approaches',
      'Lists risks or pitfalls',
    ],
  }],
  ['brainstorm', {
    artifact: 'docs/discovery/brainstorm.md',
    criteria: [
      'Contains at least 3 features with short codes',
      'Contains user stories in As a, I want, so that format',
      'Contains at least 2 architecture options with trade-offs',
    ],
  }],
  ['roadmap', {
    artifact: 'ROADMAP.md',
    criteria: [
      'Contains a markdown table with feature codes and status columns',
      'Features are organized into phases',
      'All features have PLANNED status',
    ],
  }],
]);

function outputContract(spec, stepId) {
  const step = spec.flows?.new?.steps?.find((candidate) => candidate.id === stepId);
  const fields = typeof step?.out === 'string' ? spec.contracts?.[step.out] : null;
  return fields && typeof fields === 'object' ? fields : {};
}

function waitingGate(audit) {
  return Object.entries(audit?.steps ?? {})
    .find(([, state]) => state?.status === 'waiting_gate');
}

function gateDispatch(spec, stepId) {
  const step = spec.flows?.new?.steps?.find((candidate) => candidate.id === stepId);
  if (!step?.gate) throw new Error(`Kickoff gate ${stepId} is missing from the local TS spec`);
  return { step_id: stepId, ...step.gate };
}

/** Run the product kickoff pipeline. */
export async function runNew(intent, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const projectName = opts.projectName ?? basename(cwd);

  const designDocPath = join(cwd, 'docs', 'design.md');
  if (existsSync(designDocPath)) {
    console.log('Found design doc at docs/design.md — using as enriched intent');
    intent = `${intent}\n\n## Design Document\n${readFileSync(designDocPath, 'utf-8')}`;
  }

  const composeDir = join(cwd, '.compose');
  const dataDir = join(composeDir, 'data');
  if (!existsSync(join(composeDir, 'compose.json'))) {
    throw new Error(`No .compose/compose.json found at ${cwd}. Run 'compose init' first.`);
  }
  mkdirSync(join(cwd, 'docs', 'discovery'), { recursive: true });

  const specPath = join(cwd, 'pipelines', 'new.stratum.yaml');
  if (!existsSync(specPath)) {
    throw new Error(`Kickoff spec not found: ${specPath}. Run 'compose init' to get default pipelines.`);
  }

  const spec = YAML.parse(readFileSync(specPath, 'utf-8'));
  if (opts.skipResearch) {
    const research = spec.flows?.new?.steps?.find((step) => step.id === 'research');
    if (research) research.when = 'false';
    console.log('Skipping research step (per questionnaire).\n');
  }

  const validateConfigs = KICKOFF_VALIDATION;
  const cleanSpecYaml = YAML.stringify(spec, { lineWidth: 120 });

  const visionWriter = new VisionWriter(dataDir);
  const itemId = await visionWriter.ensureFeatureItem(projectName, projectName);
  const stratum = opts.stratum ?? new StratumMcpClient();
  if (!opts.stratum) await stratum.connect({ cwd });

  try {
    console.log(`Starting product kickoff for "${projectName}"...`);
    console.log(`Intent: ${intent}\n`);
    let response = await stratum.plan(
      cleanSpecYaml,
      'new',
      { projectName, intent },
      { workspaceRoot: cwd },
    );
    const flowId = response.runId;
    await visionWriter.updateItemStatus(itemId, 'in_progress');
    const context = { cwd, featureCode: projectName, projectName, intent, stepHistory: [] };

    while (!['completed', 'failed', 'budget_exhausted'].includes(response.status)) {
      if (response.status === 'ready') {
        const step = response.ready?.[0];
        if (!step) throw new Error('Stratum returned ready without a kickoff step');
        const dispatch = {
          ...step,
          step_id: step.id,
          flow_id: response.runId,
          intent: step.do,
          output_fields: outputContract(spec, step.id),
          has_out_contract: true,
        };
        console.log(`${step.id}...`);
        await visionWriter.updateItemPhase(itemId, step.id);
        const prompt = buildStepPrompt(dispatch, context);
        const { result } = await runAndNormalize(null, prompt, dispatch, { stratum, cwd });

        const validation = validateConfigs.get(step.id);
        if (validation) {
          console.log(`  ✓ Validating ${step.id}...`);
          const checked = await validateStep({
            artifact: validation.artifact,
            criteria: validation.criteria,
            stepId: step.id,
            stratum,
            cwd,
          });
          if (!checked.valid) {
            console.log('  ✗ Validation failed:');
            for (const issue of checked.issues) console.log(`    - ${issue}`);
            const fixPrompt =
              `Read "${validation.artifact}" and fix these issues:\n` +
              checked.issues.map((issue) => `- ${issue}`).join('\n') +
              `\n\nUpdate the file in place. Do not skip any issue.\n\n` +
              `## Context\nWorking directory: ${cwd}\nProject: ${projectName}`;
            await runAndNormalize(null, fixPrompt, { ...dispatch, agent: 'claude' }, { stratum, cwd });
          }
        }

        if (result?.summary) console.log(`  ✓ ${result.summary}`);
        else console.log(`  ✓ ${step.id} complete`);
        context.stepHistory.push({ stepId: step.id, summary: result?.summary ?? 'Step complete' });
        response = await stratum.stepDone(
          response.runId,
          step.id,
          { output: result ?? { summary: 'Step complete' } },
          step.dispatchToken,
        );
        continue;
      }

      if (response.status === 'running') {
        const audit = await stratum.audit(response.runId);
        const waiting = waitingGate(audit);
        if (!waiting) throw new Error('Kickoff flow is running without ready work or a waiting gate');
        const [stepId, state] = waiting;
        const dispatch = gateDispatch(spec, stepId);
        console.log(`\nGate: ${stepId}`);

        const priorStepId = dispatch.on_revise;
        const priorValidation = validateConfigs.get(priorStepId);
        const artifact = priorValidation?.artifact ? join(cwd, priorValidation.artifact) : null;
        if (artifact && existsSync(artifact)) {
          const content = readFileSync(artifact, 'utf-8');
          console.log(`\n--- ${priorValidation.artifact} ---`);
          const lines = content.split('\n');
          console.log(lines.length <= 80 ? content : `${lines.slice(0, 60).join('\n')}\n\n... (${lines.length - 60} more lines)`);
          console.log('--- end ---\n');
        }

        const gateId = await visionWriter.createGate(
          response.runId,
          stepId,
          itemId,
          { round: readFlowRound(response.runId) },
        );
        const preamble = buildGateContext(dispatch, context, null);
        const askAgent = async (question, artifactPath) => {
          const fileRef = artifactPath
            ? `Read the file "${artifactPath}" and answer`
            : 'Look at the project files in the working directory and answer';
          return stratum.runAgentText(
            'claude',
            `${preamble}\n\n---\n\n${fileRef} this question concisely:\n\n${question}`,
            { cwd },
          );
        };
        const decision = await promptGate(dispatch, {
          ...(opts.gateOpts ?? {}),
          artifact: artifact ?? cwd,
          askAgent,
        });
        await visionWriter.resolveGate(gateId, decision.outcome);
        context.stepHistory.push({
          stepId,
          summary: `Gate ${decision.outcome}${decision.rationale ? `: ${decision.rationale}` : ''}`,
          outcome: decision.outcome,
        });
        response = await stratum.gateResolve(
          response.runId,
          stepId,
          decision.outcome,
          decision.rationale,
          'human',
          state.gateToken,
        );
        continue;
      }

      throw new Error(`Unknown TS kickoff status: ${response.status}`);
    }

    if (response.status === 'completed') {
      console.log('\nProduct kickoff complete.');
      await visionWriter.updateItemStatus(itemId, 'complete');
      console.log('\nNext steps:');
      console.log('  compose pipeline show          # review the build pipeline');
      console.log('  compose build <FEATURE-CODE>   # build the first feature');
    } else {
      await visionWriter.updateItemStatus(itemId, 'failed');
    }

    try {
      const audit = await stratum.audit(flowId);
      const auditPath = join(cwd, 'docs', 'discovery', 'kickoff-audit.json');
      writeFileSync(auditPath, JSON.stringify(audit, null, 2));
      console.log('Audit trace written to docs/discovery/kickoff-audit.json');
    } catch (err) {
      console.warn(`Warning: could not write audit trace: ${err.message}`);
    }
    return response;
  } finally {
    await stratum.close();
  }
}
