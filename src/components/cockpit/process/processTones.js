/**
 * processTones.js — heat coding for the Process view (COMP-COCKPIT-13-POLISH). Pure, no React.
 *
 * A rollup cell keeps its verbatim builder text; this file only picks a short headline that is a substring of
 * that text, and a tone from the cell's rank within its row (best to worst), so no threshold is invented and no
 * figure is computed for display. Tones map onto the index.css tokens, so light and dark both follow the theme.
 */

const hsl = (v, a) => (a == null ? `hsl(var(${v}))` : `hsl(var(${v}) / ${a})`);

/** Tone -> inline styles: `cell` (heat background), `bar` (mini bar / tone bar), `badge` (pill), `text`. */
export const TONES = {
  good: { cell: { background: hsl('--success', 0.12) }, bar: { background: hsl('--success') }, badge: { background: hsl('--success', 0.15), color: hsl('--success'), boxShadow: `inset 0 0 0 1px ${hsl('--success', 0.35)}` } },
  warn: { cell: { background: hsl('--warning', 0.12) }, bar: { background: hsl('--warning') }, badge: { background: hsl('--warning', 0.15), color: hsl('--warning'), boxShadow: `inset 0 0 0 1px ${hsl('--warning', 0.35)}` } },
  bad: { cell: { background: hsl('--destructive', 0.12) }, bar: { background: hsl('--destructive') }, badge: { background: hsl('--destructive', 0.15), color: hsl('--destructive'), boxShadow: `inset 0 0 0 1px ${hsl('--destructive', 0.35)}` } },
  stale: {
    cell: { backgroundColor: hsl('--artifact', 0.1), backgroundImage: `repeating-linear-gradient(135deg, ${hsl('--artifact', 0.14)} 0 4px, transparent 4px 9px)` },
    bar: { background: hsl('--artifact', 0.75) },
    badge: { background: hsl('--artifact', 0.15), color: hsl('--artifact'), boxShadow: `inset 0 0 0 1px ${hsl('--artifact', 0.35)}` },
  },
  failed: { cell: { background: hsl('--destructive', 0.22) }, bar: { background: hsl('--destructive') }, badge: { background: hsl('--destructive', 0.25), color: hsl('--destructive'), boxShadow: `inset 0 0 0 1px ${hsl('--destructive', 0.6)}` } },
  missing: { cell: { background: 'transparent' }, bar: { background: hsl('--muted') }, badge: { background: 'transparent', color: hsl('--muted-foreground'), boxShadow: `inset 0 0 0 1px ${hsl('--border')}` } },
  neutral: { cell: { background: hsl('--muted', 0.5) }, bar: { background: hsl('--muted-foreground', 0.5) }, badge: { background: hsl('--muted'), color: hsl('--muted-foreground') } },
};

const num = (s) => (s == null ? null : Number(s));
const first = (re) => (t) => { const m = t.match(re); return m ? m : null; };

/**
 * One spec per builder row, matched on the row's measure text. `dir` is which way is better; `key` returns the
 * number used for ranking only; `head` returns the headline, always a substring of the cell text.
 * Rows that match no spec stay neutral and show their text truncated.
 */
export const ROW_SPECS = [
  { id: 'first_pass_clean', match: /clean/i, dir: 'high',
    key: (t) => num(first(/\((\d+(?:\.\d+)?)%\)/)(t)?.[1]), head: (t) => first(/\d+(?:\.\d+)?%/)(t)?.[0] },
  { id: 'waiting_share', match: /waiting/i, dir: 'low',
    key: (t) => num(first(/(\d+(?:\.\d+)?)%/)(t)?.[1]), head: (t) => first(/\d+(?:\.\d+)?%/)(t)?.[0] },
  { id: 'gate_minutes', match: /gate minutes/i, dir: 'low',
    key: (t) => num(first(/median (\d+(?:\.\d+)?)/)(t)?.[1]), head: (t) => first(/\d+(?:\.\d+)? min/)(t)?.[0] ?? first(/median \d+(?:\.\d+)?/)(t)?.[0] },
  { id: 'review_rounds', match: /rounds/i, dir: 'low',
    key: (t) => num(first(/median (\d+(?:\.\d+)?)/)(t)?.[1]), head: (t) => first(/median \d+(?:\.\d+)?/)(t)?.[0] },
  { id: 'pace', match: /pace/i, dir: 'high',
    key: (t) => num(first(/(\d+(?:\.\d+)?) landed\/day/)(t)?.[1]), head: (t) => first(/\d+(?:\.\d+)? landed\/day/)(t)?.[0] },
  { id: 'standard', match: /unit stamps present/i, dir: 'high',
    key: (t) => { const m = first(/(\d+) of (\d+)/)(t); return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null; },
    head: (t) => first(/\d+ of \d+/)(t)?.[0] },
  { id: 'review_files', match: /review files present/i, yn: true, head: (t) => first(/\d+ units?/)(t)?.[0] },
  { id: 'gate_log', match: /gate log present/i, yn: true, head: (t) => first(/\d+ passed/)(t)?.[0] },
];

export const specFor = (measure) => ROW_SPECS.find((s) => s.match.test(String(measure ?? ''))) ?? null;

const STALE_RE = /^STALE:\s*/;
const MISSING_RE = /^no data\b/i;

/** Headline, tone input and state for one cell. `state` is 'stale' | 'missing' | null. */
export function cellInfo(spec, cell) {
  const text = typeof cell === 'string' ? cell : null;
  if (text == null) return { state: 'missing', head: 'not reported', key: null, yn: null };
  if (MISSING_RE.test(text)) return { state: 'missing', head: 'no data', key: null, yn: null };
  const stale = STALE_RE.test(text);
  const body = text.replace(STALE_RE, '');
  if (!spec) return { state: stale ? 'stale' : null, head: body, key: null, yn: null };
  const yn = spec.yn ? (/^y\b/.test(body) ? 'y' : /^n\b/.test(body) ? 'n' : null) : null;
  const h = spec.head(body);
  const head = spec.yn ? (yn ? `${yn}${h ? ` · ${h}` : ''}` : body) : (h ?? body);
  return { state: stale ? 'stale' : null, head, key: spec.yn ? null : spec.key(body), yn };
}

/** Rank-based tone within a row: top third good, middle warn, bottom bad; a lone value is good. */
export function rankTone(dir, key, keys) {
  const vals = keys.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (key == null || !vals.length) return null;
  const pos = vals.indexOf(key) / Math.max(vals.length - 1, 1);
  const score = dir === 'low' ? 1 - pos : pos;
  return score >= 0.67 ? 'good' : score >= 0.34 ? 'warn' : 'bad';
}

/** Every cell of one rollup row: `{ head, tone, state, width }`; `width` (0-100) is the mini bar, null for none. */
export function rowCells(measure, cells) {
  const spec = specFor(measure);
  const infos = (cells ?? []).map((c) => cellInfo(spec, c));
  const keys = infos.map((i) => i.key);
  const max = Math.max(0, ...keys.filter((v) => v != null && Number.isFinite(v)));
  return infos.map((i) => {
    let tone;
    if (i.state === 'missing') tone = 'missing';
    else if (i.state === 'stale') tone = 'stale';
    else if (spec?.yn) tone = i.yn === 'y' ? 'good' : i.yn === 'n' ? 'bad' : 'neutral';
    else tone = (spec && rankTone(spec.dir, i.key, keys)) ?? 'neutral';
    const width = i.key != null && max > 0 ? Math.max(4, (i.key / max) * 100) : null;
    return { head: i.head, tone, state: i.state, width };
  });
}

/** The tone the rollup gives one page for a summary panel (`waiting_share`, ...), or null when no row covers it. */
export function tileTone(table, panelId, column) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const row = rows.find((r) => specFor(r.measure)?.id === panelId);
  if (!row || column < 0) return null;
  return rowCells(row.measure, row.cells)[column] ?? null;
}
