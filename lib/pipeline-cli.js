/**
 * compose pipeline — view and edit build.stratum.yaml
 *
 * Subcommands:
 *   show                          Print the current pipeline
 *   set <step> --agent <agent>    Change a step's agent
 *   set <step> --mode gate        Convert step to a human gate
 *   set <step> --mode review      Convert step to a codex review sub-flow
 *   set <step> --mode agent       Convert step back to a regular agent step
 *   add --id <id> --after <step> --agent <agent> --intent <intent>  Insert a step
 *   remove <step>                 Remove a step
 *   enable <steps...>             Enable skipped steps (remove when)
 *   disable <steps...>            Disable steps (set when: "false")
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { parse, stringify } from 'yaml'
import { validateSpec } from '@smartmemory/stratum/dist/ir/validate.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadSpec(cwd, specName = 'build.stratum.yaml') {
  const specPath = join(cwd, 'pipelines', specName)
  if (!existsSync(specPath)) {
    throw new Error(`No pipeline found at ${specPath}. Run 'compose init' first.`)
  }
  const flowName = specName.replace(/\.stratum\.yaml$/, '')
  return { specPath, spec: parse(readFileSync(specPath, 'utf-8')), flowName }
}

function saveSpec(specPath, spec) {
  const yaml = stringify(spec, { lineWidth: 120 })
  const validation = validateSpec(parse(yaml))
  if (!validation.ok) {
    const message = `Refusing to write invalid pipeline ${specPath}:\n` +
      validation.errors.map(error => `${error.path}: ${error.message} (${error.code})`).join('\n')
    // Questionnaire callers swallow exceptions; keep genuine validation failures visible.
    console.error(message)
    throw new Error(message)
  }
  writeFileSync(specPath, yaml)
}

function findStep(steps, stepId) {
  const idx = steps.findIndex(s => s.id === stepId)
  if (idx === -1) throw new Error(`Step "${stepId}" not found in pipeline.`)
  return { step: steps[idx], idx }
}

function findFlow(spec, flowName) {
  return spec.flows?.[flowName]
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

const LEVEL_COLORS = {
  gate: '\x1b[33m',    // yellow
  skip: '\x1b[90m',    // gray
  flow: '\x1b[36m',    // cyan
  agent: '\x1b[32m',   // green
}
const RESET = '\x1b[0m'

export function pipelineShow(cwd, specName = 'build.stratum.yaml') {
  const { spec, flowName } = loadSpec(cwd, specName)
  const mainFlow = spec.flows?.[flowName]
  if (!mainFlow) throw new Error(`No "${flowName}" flow found in pipeline spec.`)

  console.log(`\n  Pipeline: ${flowName} (${mainFlow.steps.length} steps)\n`)

  for (const step of mainFlow.steps) {
    const isGate = !!step.function
    const isFlow = !!step.flow
    const isSkipped = step.skip_if === 'true' || step.skip_if === true
    const agent = step.agent ?? (isFlow ? flowAgent(spec, step.flow) : null)

    let kind, color, detail
    if (isSkipped) {
      kind = 'skip'
      color = LEVEL_COLORS.skip
      detail = step.skip_reason || 'skipped'
    } else if (isGate) {
      kind = 'gate'
      color = LEVEL_COLORS.gate
      detail = `human gate (timeout: ${gateTimeout(spec, step.function)}s)`
    } else if (isFlow) {
      kind = 'flow'
      color = LEVEL_COLORS.flow
      const subFlow = findFlow(spec, step.flow)
      const subSteps = subFlow?.steps?.map(s => s.id).join(' → ') || '?'
      detail = `${step.flow}: ${subSteps} (agent: ${agent})`
    } else {
      kind = 'agent'
      color = LEVEL_COLORS.agent
      const ensures = step.ensure?.length ? ` [${step.ensure.length} ensures]` : ''
      const retries = step.retries ? ` (retries: ${step.retries})` : ''
      const onFail = step.on_fail ? ` → on_fail: ${step.on_fail}` : ''
      detail = `agent: ${agent}${ensures}${retries}${onFail}`
    }

    const num = String(mainFlow.steps.indexOf(step) + 1).padStart(2)
    console.log(`  ${color}${num}. ${step.id.padEnd(18)}${kind.padEnd(6)} ${detail}${RESET}`)
  }

  // Show sub-flows
  const subFlowNames = mainFlow.steps.filter(s => s.flow).map(s => s.flow)
  if (subFlowNames.length > 0) {
    console.log(`\n  Sub-flows:`)
    for (const name of subFlowNames) {
      const flow = findFlow(spec, name)
      if (!flow) continue
      console.log(`\n    ${name}:`)
      for (const step of flow.steps) {
        const ensures = step.ensure?.length ? ` [${step.ensure.join(', ')}]` : ''
        const retries = step.retries ? ` (retries: ${step.retries})` : ''
        console.log(`      - ${step.id} (${step.agent})${ensures}${retries}`)
      }
    }
  }

  // Show contracts
  if (spec.contracts) {
    console.log(`\n  Contracts: ${Object.keys(spec.contracts).join(', ')}`)
  }

  console.log('')
}

function flowAgent(spec, flowName) {
  const flow = spec.flows?.[flowName]
  if (!flow?.steps?.length) return '?'
  return flow.steps[0].agent ?? 'claude'
}

function gateTimeout(spec, funcName) {
  return spec.functions?.[funcName]?.timeout ?? '?'
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

export function pipelineSet(cwd, stepId, flags, specName = 'build.stratum.yaml') {
  const { specPath, spec, flowName } = loadSpec(cwd, specName)
  const mainFlow = spec.flows?.[flowName]
  if (!mainFlow) throw new Error(`No "${flowName}" flow found.`)

  const { step, idx } = findStep(mainFlow.steps, stepId)

  // --agent <agent>
  const agentIdx = flags.indexOf('--agent')
  if (agentIdx !== -1) {
    const agent = flags[agentIdx + 1]
    if (!agent) throw new Error('--agent requires a value (claude, codex, gemini)')
    if (step.run) {
      // Change the agent inside the sub-flow
      const flow = findFlow(spec, step.run)
      if (flow?.steps?.length) {
        flow.steps[0].agent = agent
        console.log(`Set ${step.run} → ${flow.steps[0].id} agent to ${agent}`)
      }
    } else if (step.gate) {
      throw new Error(`"${stepId}" is a gate — gates don't have agents. Use --mode to change it.`)
    } else {
      step.agent = agent
      console.log(`Set ${stepId} agent to ${agent}`)
    }
  }

  // --mode gate|review|agent
  const modeIdx = flags.indexOf('--mode')
  if (modeIdx !== -1) {
    const mode = flags[modeIdx + 1]
    if (!mode) throw new Error('--mode requires a value (gate, review, agent)')

    if (mode === 'gate') {
      convertToGate(spec, mainFlow, step, stepId)
    } else if (mode === 'review') {
      convertToReview(spec, mainFlow, step, stepId)
    } else if (mode === 'agent') {
      convertToAgent(spec, mainFlow, step, stepId)
    } else {
      throw new Error(`Unknown mode "${mode}". Use: gate, review, agent`)
    }
  }

  // --retries <n>
  const retriesIdx = flags.indexOf('--retries')
  if (retriesIdx !== -1) {
    const n = parseInt(flags[retriesIdx + 1], 10)
    if (isNaN(n)) throw new Error('--retries requires a number')
    if (step.run) {
      const flow = findFlow(spec, step.run)
      if (flow?.steps?.length) flow.steps[0].attempts = n
    } else {
      step.attempts = n
    }
    console.log(`Set ${stepId} retries to ${n}`)
  }

  saveSpec(specPath, spec)
}

// Preserve scheduling across kind changes; kind-specific fields must be removed.
function replaceStep(step, replacement) {
  const { id, after, when } = step
  Object.keys(step).forEach(key => delete step[key])
  Object.assign(step, { id }, replacement)
  if (after !== undefined) step.after = after
  if (when !== undefined) step.when = when
}

function convertToGate(spec, mainFlow, step, stepId) {
  const idx = mainFlow.steps.indexOf(step)
  // Only explicit ancestors are safe revise targets (array order is not a dependency).
  const previous = mainFlow.steps.slice(0, idx).reverse()
    .find(candidate => step.after?.includes(candidate.id) && candidate.when !== 'false')
  replaceStep(step, {
    gate: {
      on_approve: mainFlow.steps[idx + 1]?.id ?? null,
      on_revise: previous?.id ?? null,
      on_kill: null,
    },
  })
  if (previous) mainFlow.max_rounds ??= 10
  console.log(`Converted ${stepId} to human gate`)
}

function convertToReview(spec, mainFlow, step, stepId) {
  const flowName = `${stepId}_review`
  spec.contracts.ReviewResult ??= {
    clean: 'boolean',
    summary: 'string',
    findings: 'string[]',
  }
  spec.flows[flowName] ??= {
    input: { task: 'string' },
    output: { from: '${review.output}', contract: 'ReviewResult' },
    steps: [{
      id: 'review',
      agent: 'codex',
      do: `Review the output preceding ${stepId}. Task: \${input.task}. Return ReviewResult.`,
      out: 'ReviewResult',
      ensure: [{ expr: 'result.clean == true' }],
      attempts: 5,
    }],
  }

  // Use an actual declared summary, never an assumed output/input field.
  const previous = mainFlow.steps.slice(0, mainFlow.steps.indexOf(step)).reverse()
    .find(candidate => {
      const contract = candidate.out ?? spec.flows[candidate.run]?.output.contract
      return candidate.when !== 'false' && spec.contracts[contract]?.summary === 'string'
    })
  const input = ['intent', 'description'].find(name => mainFlow.input[name] === 'string')
  const task = previous ? `\${${previous.id}.output.summary}`
    : input ? `\${input.${input}}` : `Review the ${stepId} phase.`
  replaceStep(step, { run: flowName, with: { task } })
  console.log(`Converted ${stepId} to codex review loop (flow: ${flowName})`)
}

function convertToAgent(spec, mainFlow, step, stepId) {
  // Retain an existing output contract so downstream references remain meaningful.
  const out = step.out ?? spec.flows[step.run]?.output.contract
  replaceStep(step, {
    agent: 'claude',
    do: `Execute the ${stepId} phase.${out ? ` Return ${out}.` : ''}`,
    ...(out ? { out } : {}),
    attempts: 2,
  })
  console.log(`Converted ${stepId} to agent step`)
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export function pipelineAdd(cwd, flags, specName = 'build.stratum.yaml') {
  const { specPath, spec, flowName } = loadSpec(cwd, specName)
  const mainFlow = spec.flows?.[flowName]
  if (!mainFlow) throw new Error(`No "${flowName}" flow found.`)

  const id = flagVal(flags, '--id')
  const after = flagVal(flags, '--after')
  const agent = flagVal(flags, '--agent') || 'claude'
  const intent = flagVal(flags, '--intent') || `Execute the ${id} step.`

  if (!id) throw new Error('--id is required')
  if (!after) throw new Error('--after is required')

  // Check id doesn't already exist
  if (mainFlow.steps.some(s => s.id === id)) {
    throw new Error(`Step "${id}" already exists.`)
  }

  const { idx } = findStep(mainFlow.steps, after)

  const newStep = {
    id,
    agent,
    intent,
    inputs: {
      featureCode: '$.input.featureCode',
      description: '$.input.description',
    },
    output_contract: 'PhaseResult',
    retries: 2,
    depends_on: [after],
  }

  // Fix depends_on of the step that previously depended on `after`
  const nextStep = mainFlow.steps[idx + 1]
  if (nextStep?.depends_on?.includes(after)) {
    nextStep.depends_on = nextStep.depends_on.map(d => d === after ? id : d)
  }

  mainFlow.steps.splice(idx + 1, 0, newStep)
  saveSpec(specPath, spec)
  console.log(`Added step "${id}" after "${after}" (agent: ${agent})`)
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

export function pipelineRemove(cwd, stepId, specName = 'build.stratum.yaml') {
  const { specPath, spec, flowName } = loadSpec(cwd, specName)
  const mainFlow = spec.flows?.[flowName]
  if (!mainFlow) throw new Error(`No "${flowName}" flow found.`)

  const { step, idx } = findStep(mainFlow.steps, stepId)

  // Rewire depends_on: anything depending on this step now depends on its deps
  const removedDeps = step.depends_on || []
  for (const s of mainFlow.steps) {
    if (s.depends_on?.includes(stepId)) {
      s.depends_on = s.depends_on
        .filter(d => d !== stepId)
        .concat(removedDeps)
      // Deduplicate
      s.depends_on = [...new Set(s.depends_on)]
    }
  }

  // Rewire gate references
  for (const s of mainFlow.steps) {
    if (s.on_approve === stepId) s.on_approve = mainFlow.steps[idx + 1]?.id || null
    if (s.on_revise === stepId) s.on_revise = null
    if (s.on_fail === stepId) s.on_fail = null
  }

  mainFlow.steps.splice(idx, 1)
  saveSpec(specPath, spec)
  console.log(`Removed step "${stepId}"`)
}

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

export function pipelineEnable(cwd, stepIds, specName = 'build.stratum.yaml') {
  const { specPath, spec, flowName } = loadSpec(cwd, specName)
  const mainFlow = spec.flows?.[flowName]
  if (!mainFlow) throw new Error(`No "${flowName}" flow found.`)

  for (const stepId of stepIds) {
    const { step } = findStep(mainFlow.steps, stepId)
    delete step.when
    console.log(`Enabled ${stepId}`)
  }

  saveSpec(specPath, spec)
}

export function pipelineDisable(cwd, stepIds, specName = 'build.stratum.yaml') {
  const { specPath, spec, flowName } = loadSpec(cwd, specName)
  const mainFlow = spec.flows?.[flowName]
  if (!mainFlow) throw new Error(`No "${flowName}" flow found.`)

  for (const stepId of stepIds) {
    const { step } = findStep(mainFlow.steps, stepId)
    step.when = 'false'
    console.log(`Disabled ${stepId} (when: "false")`)
  }

  saveSpec(specPath, spec)
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function flagVal(flags, name) {
  const idx = flags.indexOf(name)
  return idx !== -1 ? flags[idx + 1] : null
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

export function runPipelineCli(cwd, subArgs) {
  const sub = subArgs[0]
  const rest = subArgs.slice(1)

  if (!sub || sub === '--help') {
    printHelp()
    return
  }

  switch (sub) {
    case 'show':
      pipelineShow(cwd)
      break
    case 'set':
      if (!rest[0]) throw new Error('Usage: compose pipeline set <step-id> --agent <agent> | --mode <mode>')
      pipelineSet(cwd, rest[0], rest.slice(1))
      break
    case 'add':
      pipelineAdd(cwd, rest)
      break
    case 'remove':
      if (!rest[0]) throw new Error('Usage: compose pipeline remove <step-id>')
      pipelineRemove(cwd, rest[0])
      break
    case 'enable':
      if (!rest.length) throw new Error('Usage: compose pipeline enable <step-id> [step-id...]')
      pipelineEnable(cwd, rest)
      break
    case 'disable':
      if (!rest.length) throw new Error('Usage: compose pipeline disable <step-id> [step-id...]')
      pipelineDisable(cwd, rest)
      break
    default:
      console.error(`Unknown pipeline subcommand: ${sub}`)
      printHelp()
      process.exit(1)
  }
}

function printHelp() {
  console.log(`
Usage: compose pipeline <command>

Commands:
  show                                    Print the current pipeline
  set <step> --agent <agent>              Change a step's agent
  set <step> --mode gate                  Convert to human gate
  set <step> --mode review                Convert to codex review loop
  set <step> --mode agent                 Convert to regular agent step
  set <step> --retries <n>                Set retry count
  add --id <id> --after <step> [opts]     Insert a new step
  remove <step>                           Remove a step
  enable <steps...>                       Enable skipped steps
  disable <steps...>                      Disable steps (skip)
`)
}
