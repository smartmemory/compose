/**
 * cli-progress.js — Build progress output for compose build.
 *
 * Two modes:
 *   Collapsed (default): last 5 tool events + sticky key hints bar
 *   Expanded: all tool events printed as they arrive
 *
 * Keys: t=toggle  s=skip  r=retry  Ctrl+C=abort
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = '\x1b[';
const RESET   = `${ESC}0m`;
const BOLD    = `${ESC}1m`;
const DIM     = `${ESC}2m`;
const CYAN    = `${ESC}36m`;
const YELLOW  = `${ESC}33m`;
const GREEN   = `${ESC}32m`;
const RED     = `${ESC}31m`;
const MAGENTA = `${ESC}35m`;
const GRAY    = `${ESC}90m`;
const WHITE   = `${ESC}37m`;

const ERASE_LINE = `${ESC}2K\r`;
const MOVE_UP    = (n) => `${ESC}${n}A`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

function visibleWidth(line) {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').length;
}

// ---------------------------------------------------------------------------
// Tool color mapping
// ---------------------------------------------------------------------------

const TOOL_COLORS = {
  Bash:    CYAN,   bash:    CYAN,
  Read:    GREEN,  read:    GREEN,
  Write:   YELLOW, write:   YELLOW,
  Edit:    YELLOW, edit:    YELLOW,
  Glob:    MAGENTA, glob:   MAGENTA,
  Grep:    MAGENTA, grep:   MAGENTA,
  Agent:   BOLD + CYAN, agent: BOLD + CYAN,
};

function colorForTool(tool) {
  return TOOL_COLORS[tool] ?? GRAY;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLAPSED_LINES = 5;   // tool lines to show when collapsed
const HINT_BAR = `${DIM}  keys: ${WHITE}t${GRAY}=toggle  ${WHITE}s${GRAY}=skip  ${WHITE}r${GRAY}=retry  ${WHITE}Ctrl+C${GRAY}=abort${RESET}`;

// ---------------------------------------------------------------------------
// Pipeline step definitions (COMP-TUI-1)
// ---------------------------------------------------------------------------

const PIPELINE_STEPS = [
  'explore_design', 'scope', 'design_gate', 'prd', 'architecture',
  'blueprint', 'verification', 'plan_gate', 'decompose', 'execute',
  'review', 'codex_review', 'coverage', 'report', 'docs', 'ship_gate', 'ship',
];

const STEP_LABELS = {
  explore_design: 'explore', scope: 'scope', design_gate: 'design\u2193',
  prd: 'prd', architecture: 'arch', blueprint: 'blueprint',
  verification: 'verify', plan_gate: 'plan\u2193', decompose: 'decomp',
  execute: 'execute', review: 'review', codex_review: 'codex',
  coverage: 'coverage',
  report: 'report', docs: 'docs', ship_gate: 'ship\u2193', ship: 'ship',
};

// ---------------------------------------------------------------------------
// CliProgress
// ---------------------------------------------------------------------------

export class CliProgress extends EventEmitter {
  #expanded = false;
  #toolHistory = [];     // all tool events for current step
  #toolCount = 0;
  #drawnCollapsedLines = 0; // how many collapsed lines are currently on screen
  #stream;
  #isTTY;
  #onKey;
  #wasRaw;
  #listening = false;
  #heartbeatTimer = null;
  #stepStart = 0;
  #currentStepId = '';
  #pendingAction = null;
  #stepHistory = [];     // completed step IDs for pipeline bar
  // COMP-TUI-4: parallel task grid state
  // Map<stepId, { itemIndex, agent, status, startMs }>
  // status: 'working' | 'done' | 'failed'
  #parallelGrid = new Map();

  constructor({ stream, expanded = false } = {}) {
    super();
    this.#stream = stream ?? process.stderr;
    this.#isTTY = this.#stream.isTTY ?? false;
    this.#expanded = expanded;

    this.#onKey = (key) => {
      if (key === 't' || key === 'T') this.toggle();
      if (key === 's' || key === 'S') {
        this.#pendingAction = 'skip';
        this.#clearCollapsed();
        this.#stream.write(`  ${YELLOW}⏭ Skip requested — interrupting current step...${RESET}\n`);
        this.emit('interrupt');
      }
      if (key === 'r' || key === 'R') {
        this.#pendingAction = 'retry';
        this.#clearCollapsed();
        this.#stream.write(`  ${YELLOW}↻ Retry requested — interrupting current step...${RESET}\n`);
        this.emit('interrupt');
      }
      if (key === '\x03') {
        this.finish();
        process.exit(130);
      }
    };

    this.#startListening();
  }

  get expanded() { return this.#expanded; }

  consumeAction() {
    const action = this.#pendingAction;
    this.#pendingAction = null;
    return action;
  }

  get pendingAction() { return this.#pendingAction; }

  // ── Key listener management ───────────────────────────────────────────

  #startListening() {
    if (this.#listening) return;
    if (!this.#isTTY || !process.stdin.isTTY || !process.stdin.setRawMode) return;
    this.#wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', this.#onKey);
    this.#listening = true;
    if (this.#isTTY) this.#stream.write(HIDE_CURSOR);
  }

  #stopListening() {
    if (!this.#listening) return;
    process.stdin.removeListener('data', this.#onKey);
    if (process.stdin.setRawMode) {
      try { process.stdin.setRawMode(this.#wasRaw ?? false); } catch { /* ignore */ }
    }
    process.stdin.pause();
    this.#listening = false;
    if (this.#isTTY) this.#stream.write(SHOW_CURSOR);
  }

  pause() {
    this.#clearCollapsed();
    this.#stopListening();
  }

  resume() {
    this.#startListening();
    this.#drawActive();
  }

  toggle() {
    this.#clearCollapsed();
    this.#expanded = !this.#expanded;
    if (this.#expanded) {
      // Dump full tool history on expand
      for (const t of this.#toolHistory) {
        this.#stream.write(`    ${colorForTool(t.tool)}↳ ${t.tool}${RESET}${t.detail ? ': ' + t.detail : ''}\n`);
      }
    }
    this.#drawActive();
  }

  // ── Event handlers ────────────────────────────────────────────────────

  toolUse(tool, detail) {
    this.#toolCount++;
    this.#stepStart = Date.now();
    const short = typeof detail === 'string' && detail.length > 60
      ? detail.slice(0, 57) + '...' : (detail || '');

    this.#toolHistory.push({ tool, detail: short });

    // COMP-TUI-4: suppress redraw when parallel grid is active
    if (this.#parallelGrid.size > 0) return;

    if (this.#expanded) {
      this.#stream.write(`    ${colorForTool(tool)}↳ ${tool}${RESET}${short ? ': ' + short : ''}\n`);
    } else {
      this.#drawActive();
    }
  }

  toolSummary(summary) {
    const short = summary.length > 80 ? summary.slice(0, 77) + '...' : summary;
    this.#toolHistory.push({ tool: '✓', detail: short });

    // COMP-TUI-4: suppress redraw when parallel grid is active
    if (this.#parallelGrid.size > 0) return;

    if (this.#expanded) {
      this.#stream.write(`    ${GREEN}✓${RESET} ${short}\n`);
    } else {
      this.#drawActive();
    }
  }

  toolProgress(tool, elapsed) {
    this.#toolHistory.push({ tool, detail: `(${Math.round(elapsed)}s)` });

    // COMP-TUI-4: suppress redraw when parallel grid is active
    if (this.#parallelGrid.size > 0) return;

    if (this.#expanded) {
      this.#stream.write(`    ${colorForTool(tool)}↳ ${tool}${RESET} ${DIM}(${Math.round(elapsed)}s)${RESET}\n`);
    } else {
      this.#drawActive();
    }
  }

  stepStart(stepNum, totalSteps, stepId, opts = {}) {
    // COMP-TUI-4: detect parallel fanout item (∥-prefixed stepNum)
    if (typeof stepNum === 'string' && stepNum.startsWith('∥')) {
      // Extract itemIndex from '∥N'
      const itemIndex = parseInt(stepNum.slice(1), 10);
      const agent = opts.agent ?? '';
      this.#parallelGrid.set(stepId, {
        itemIndex,
        agent,
        status: 'working',
        startMs: Date.now(),
      });
      // Start heartbeat if this is the first item
      if (this.#parallelGrid.size === 1) {
        this.#clearCollapsed();
        this.#stopHeartbeat();
        this.#toolCount = 0;
        this.#toolHistory = [];
        this.#currentStepId = stepId;
        this.#startHeartbeat();
      }
      if (!this.#isTTY) this.#writePlainGridUpdate(stepId, this.#parallelGrid.get(stepId));
      this.#drawActive();
      return;
    }

    // Normal (non-parallel) sequential step — clear the grid
    this.#parallelGrid.clear();
    this.#clearCollapsed();
    this.#stopHeartbeat();
    this.#drawPipelineBar(stepId);
    this.#stream.write(`${BOLD}[${stepNum}/${totalSteps}]${RESET} ${stepId}...\n`);
    this.#toolCount = 0;
    this.#toolHistory = [];
    this.#stepStart = Date.now();
    this.#currentStepId = stepId;
    this.#drawActive();
    this.#startHeartbeat();
  }

  stepDone(stepId, status = 'succeeded') {
    if (!this.#stepHistory.includes(stepId)) {
      this.#stepHistory.push(stepId);
    }
    // COMP-TUI-4: update grid entry if present
    const entry = this.#parallelGrid.get(stepId);
    if (entry) {
      entry.status = status === 'succeeded' ? 'done' : 'failed';
      if (!this.#isTTY) this.#writePlainGridUpdate(stepId, entry);
      this.#drawActive();
    }
  }

  // ── Pipeline bar (COMP-TUI-1) ────────────────────────────────────────

  pipelineBar(stepNum, totalSteps, stepId, stepHistory) {
    this.#stepHistory = (stepHistory ?? []).map(h => h.stepId ?? h);
    this.#drawPipelineBar(stepId);
  }

  #drawPipelineBar(currentStepId) {
    if (!this.#isTTY) return;

    const doneSet = new Set(this.#stepHistory);
    const currentIdx = PIPELINE_STEPS.indexOf(currentStepId);

    // Build the visible window: all done + current + up to 3 pending
    const cols = this.#stream.columns || 80;
    let visibleSteps;

    // Calculate full bar length to decide if we need a sliding window
    const fullLen = PIPELINE_STEPS.reduce((sum, s, i) => {
      const label = STEP_LABELS[s] || s;
      return sum + label.length + 3 + (i < PIPELINE_STEPS.length - 1 ? 3 : 0); // icon + space + label + separator
    }, 4); // 4 for leading indent

    if (fullLen <= cols) {
      visibleSteps = PIPELINE_STEPS;
    } else {
      // Sliding window: show done steps, current, and up to 3 pending
      const start = 0;
      const end = Math.min(PIPELINE_STEPS.length, (currentIdx < 0 ? 0 : currentIdx) + 4);
      visibleSteps = PIPELINE_STEPS.slice(start, end);

      // If window is still too wide, trim from the start (keep current visible)
      while (visibleSteps.length > 3) {
        const windowLen = visibleSteps.reduce((sum, s, i) => {
          const label = STEP_LABELS[s] || s;
          return sum + label.length + 3 + (i < visibleSteps.length - 1 ? 3 : 0);
        }, 4);
        if (windowLen <= cols) break;
        visibleSteps.shift();
      }
    }

    const parts = visibleSteps.map(s => {
      const label = STEP_LABELS[s] || s;
      if (s === currentStepId) {
        return `${CYAN}${BOLD}\u25C9 ${label}${RESET}`;
      } else if (doneSet.has(s)) {
        return `${GREEN}\u25CF ${label}${RESET}`;
      } else {
        return `${DIM}\u25CB ${label}${RESET}`;
      }
    });

    this.#stream.write(`  ${parts.join(` ${DIM}\u2500${RESET} `)}\n`);
  }

  subFlowStep(flowName, stepId) {
    this.#clearCollapsed();
    this.#stopHeartbeat();
    this.#stream.write(`  ${CYAN}[${flowName}]${RESET} ${stepId}...\n`);
    this.#toolHistory = [];
    this.#stepStart = Date.now();
    this.#currentStepId = `${flowName}/${stepId}`;
    this.#drawActive();
    this.#startHeartbeat();
  }

  retry(flowName, stepId, agent) {
    this.#clearCollapsed();
    this.#stream.write(`  ${YELLOW}[${flowName}] ↻ Retrying ${stepId}${agent ? ` (${agent})` : ''}${RESET}\n`);
    this.#drawActive();
  }

  fix(flowName, fixAgent, stepId) {
    this.#clearCollapsed();
    this.#stream.write(`  ${YELLOW}[${flowName}] ↻ Fix (${fixAgent}) for ${stepId}${RESET}\n`);
    this.#drawActive();
  }

  warn(msg) {
    this.#clearCollapsed();
    this.#stream.write(`    ${RED}⚠ ${msg}${RESET}\n`);
    this.#drawActive();
  }

  success(msg) {
    this.#clearCollapsed();
    this.#stream.write(`  ${GREEN}✓${RESET} ${msg}\n`);
    this.#drawActive();
  }

  info(msg) {
    this.#clearCollapsed();
    this.#stream.write(`${msg}\n`);
    this.#drawActive();
  }

  debug(msg) {
    if (!process.env.COMPOSE_DEBUG) return;
    if (this.#expanded) {
      this.#stream.write(`  ${DIM}[debug] ${msg}${RESET}\n`);
    }
  }

  finish() {
    this.#clearCollapsed();
    this.#stopHeartbeat();
    this.#stopListening();
  }

  // ── Collapsed view: last N tools + heartbeat + hints ──────────────────

  #drawCollapsed() {
    if (!this.#isTTY) return;

    // First erase any previously drawn collapsed block
    this.#eraseCollapsedBlock();

    const lines = [];

    // Last N tool events
    const recent = this.#toolHistory.slice(-COLLAPSED_LINES);
    for (const t of recent) {
      const color = colorForTool(t.tool);
      lines.push(`    ${color}↳ ${t.tool}${RESET}${t.detail ? ': ' + t.detail : ''}`);
    }

    // Heartbeat / status line
    const elapsed = Math.round((Date.now() - this.#stepStart) / 1000);
    const countStr = this.#toolCount > 0 ? `${this.#toolCount} calls` : 'waiting';
    lines.push(`  ${DIM}${this.#currentStepId} · ${elapsed}s · ${countStr}${RESET}`);

    // Key hints
    lines.push(HINT_BAR);

    // Write all lines
    for (const line of lines) {
      this.#stream.write(line + '\n');
    }

    this.#drawnCollapsedLines = lines.length;
  }

  #clearCollapsed() {
    this.#eraseCollapsedBlock();
  }

  #eraseCollapsedBlock() {
    if (!this.#isTTY || this.#drawnCollapsedLines === 0) return;
    // Move up and erase each line
    for (let i = 0; i < this.#drawnCollapsedLines; i++) {
      this.#stream.write(MOVE_UP(1) + ERASE_LINE);
    }
    this.#drawnCollapsedLines = 0;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────

  // COMP-TUI-4: dispatch to grid or collapsed view depending on mode
  #drawActive() {
    if (this.#parallelGrid.size > 0) {
      this.#drawGrid();
    } else if (!this.#expanded) {
      this.#drawCollapsed();
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (this.#parallelGrid.size > 0 || !this.#expanded) {
        this.#drawActive();
      } else {
        // In expanded mode, just print elapsed time
        const elapsed = Math.round((Date.now() - this.#stepStart) / 1000);
        this.#stream.write(`    ${DIM}… ${this.#currentStepId} (${elapsed}s)${RESET}\n`);
      }
    }, 5_000);
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  // COMP-TUI-4: render the parallel task grid
  // Format:
  //   parallel · N tasks
  //   ∥0  ⋯  codex    T01-auth-validation-fix        14s
  //   ∥1  ✓  claude   T02-add-coverage-tests           8s
  //   keys: t=toggle  s=skip  r=retry  Ctrl+C=abort
  #drawGrid() {
    if (!this.#isTTY) return;

    this.#eraseCollapsedBlock();

    const entries = [...this.#parallelGrid.entries()];
    // Sort by itemIndex ascending for stable display order
    entries.sort((a, b) => a[1].itemIndex - b[1].itemIndex);

    const cols = this.#stream.columns || 80;
    const now = Date.now();
    const lines = [];

    // Header
    lines.push(`  ${DIM}parallel · ${entries.length} tasks${RESET}`);

    // Per-task rows
    for (const [stepId, { itemIndex, agent, status, startMs }] of entries) {
      const elapsed = Math.round((now - startMs) / 1000);

      let icon, iconColor;
      if (status === 'done') {
        icon = '✓';
        iconColor = GREEN;
      } else if (status === 'failed') {
        icon = '✗';
        iconColor = RED;
      } else {
        icon = '⋯';
        iconColor = CYAN;
      }

      // Column layout: ∥N(4) + agent(6) + stepId(remaining) + elapsed
      const prefix = `∥${itemIndex}`;
      const agentPadded = agent.length >= 6 ? agent.slice(0, 6) : agent + ' '.repeat(6 - agent.length);

      // Available space for stepId: cols - 2(indent) - 4(∥N pad) - 3(icon+spaces) - 8(agent+spaces) - 6(elapsed+spaces) - 2(right margin)
      const stepIdMaxLen = Math.max(12, Math.min(40, cols - 2 - 4 - 3 - 8 - 6 - 2));
      const stepIdDisplay = stepId.length > stepIdMaxLen
        ? stepId.slice(0, stepIdMaxLen - 1) + '…'
        : stepId;

      lines.push(
        `  ${BOLD}${prefix.padEnd(3)}${RESET}  ${iconColor}${icon}${RESET}  ${agentPadded}  ${stepIdDisplay.padEnd(stepIdMaxLen)}  ${DIM}${elapsed}s${RESET}`
      );
    }

    // Key hints
    lines.push(HINT_BAR);

    for (const line of lines) {
      this.#stream.write(line + '\n');
    }

    this.#drawnCollapsedLines = lines.reduce(
      (rows, line) => rows + Math.max(1, Math.ceil(visibleWidth(line) / cols)),
      0,
    );
  }

  #writePlainGridUpdate(stepId, entry) {
    const agent = entry.agent ? ` ${entry.agent}` : '';
    const state = entry.status === 'working' ? 'started' : entry.status;
    const elapsed = entry.status === 'working'
      ? ''
      : ` ${Math.round((Date.now() - entry.startMs) / 1000)}s`;
    this.#stream.write(`[∥${entry.itemIndex}]${agent} ${stepId} ${state}${elapsed}\n`);
  }

  // ── Findings table (COMP-TUI-3) ──────────────────────────────────────

  findings(items) {
    if (!items || items.length === 0) return;

    const SEV_COLORS = { 'must-fix': RED, 'should-fix': YELLOW, nit: GRAY };
    const SEV_ORDER = ['must-fix', 'should-fix', 'nit'];

    // Parse violation strings into structured rows
    const rows = items.map(item => {
      if (typeof item === 'object' && item.severity) {
        return { sev: item.severity, file: item.file ?? '', desc: item.description ?? item.message ?? '' };
      }
      const s = String(item);
      // Try to extract file:line reference and severity
      const fileMatch = s.match(/(\S+\.\w+:\d+)/);
      const file = fileMatch ? fileMatch[1] : '';
      let sev = 'nit';
      if (/must.?fix|error|critical/i.test(s)) sev = 'must-fix';
      else if (/should.?fix|warning/i.test(s)) sev = 'should-fix';
      // Strip severity prefix, file reference, and connectors to get clean description
      const desc = s
        .replace(/^(must[- ]?fix|should[- ]?fix|nit|error|warning|critical)\s*[:]\s*/i, '')
        .replace(fileMatch?.[0] ?? '', '')
        .replace(/^\s*[-:—]\s*/, '')
        .trim() || s;
      return { sev, file, desc };
    });

    // Sort by severity
    rows.sort((a, b) => SEV_ORDER.indexOf(a.sev) - SEV_ORDER.indexOf(b.sev));

    // Column widths
    const cols = this.#stream.columns || 100;
    const sevW = Math.max(10, ...rows.map(r => r.sev.length + 2));
    const fileW = Math.max(10, ...rows.map(r => r.file.length + 2));
    const descW = Math.max(10, cols - sevW - fileW - 10); // account for borders + padding
    const totalW = sevW + fileW + descW + 4; // 4 for border chars

    const pad = (str, w) => str.length >= w ? str.slice(0, w) : str + ' '.repeat(w - str.length);
    const title = ' Review Findings ';

    this.#clearCollapsed();

    // Top border
    const topRule = '\u2500'.repeat(Math.max(0, totalW - 2 - title.length));
    this.#stream.write(`  \u250C\u2500${BOLD}${title}${RESET}${'\u2500'.repeat(Math.max(0, topRule.length))}\u2510\n`);

    // Header
    this.#stream.write(`  \u2502 ${BOLD}${pad('SEV', sevW)}${RESET}\u2502 ${BOLD}${pad('FILE', fileW)}${RESET}\u2502 ${BOLD}${pad('FINDING', descW)}${RESET}\u2502\n`);
    this.#stream.write(`  \u251C${'\u2500'.repeat(sevW + 1)}\u253C${'\u2500'.repeat(fileW + 2)}\u253C${'\u2500'.repeat(descW + 2)}\u2524\n`);

    // Data rows
    for (const row of rows) {
      const sevColor = SEV_COLORS[row.sev] ?? GRAY;
      this.#stream.write(`  \u2502 ${sevColor}${pad(row.sev, sevW)}${RESET}\u2502 ${pad(row.file, fileW)}\u2502 ${pad(row.desc, descW)}\u2502\n`);
    }

    // Bottom border
    this.#stream.write(`  \u2514${'\u2500'.repeat(sevW + 1)}\u2534${'\u2500'.repeat(fileW + 2)}\u2534${'\u2500'.repeat(descW + 2)}\u2518\n`);

    this.#drawActive();
  }
}
