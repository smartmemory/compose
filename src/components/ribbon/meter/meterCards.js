/**
 * meterCards.js — COMP-COCKPIT-RIBBON-METER-1: the two cards behind a click on the Day page's meter. Pure, no React.
 * A card is `{kind, title, rows: [{label, value, missing}], bars, link}`. A field with no source is `not recorded`
 * (never a number from the prototype); Plan 2 of the unit report names the command that proved each one has no source.
 * Numbers go through costLogic's `fmtPct`/`resetIn`, so the card and the meter cannot round one seat two ways.
 */
import { fmtPct, resetIn, creditValue, FIVE_H_ONLY } from '../../cockpit/cost/costLogic.js';

export const NOT_RECORDED = 'not recorded';
export const SEAT_LINK = 'Where did this seat go? ▸';
export const MONEY_LINK = 'By session and engine ▸';

const row = (label, value) => (value == null || value === '' || value === '—'
  ? { label, value: NOT_RECORDED, missing: true }
  : { label, value, missing: false });
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/** One seat's card from its `seatRows` row (usage_watch). `now` is epoch ms. */
export function seatCard(seat, now = Date.now()) {
  const five = seat?.five_h;
  const seven = seat?.seven_d;
  const resetMs = five?.resets_at ? Date.parse(five.resets_at) : NaN;
  const idle = seat?.seat_idle;
  const rows = [
    row('5h used', fmtPct(five?.used_pct)),
    seven?.status === 'missing' ? { label: '7d used', value: FIVE_H_ONLY, missing: false } : row('7d used', fmtPct(seven?.used_pct)),
    row('resets', Number.isFinite(resetMs) ? `${hhmm(resetMs)} (in ${resetIn(five.resets_at, now)})` : null),
    row('burn', null), // usage_watch status prints no burn rate
    row('on it', null), // no lane-per-seat field (owner_sessions are chat tabs, not lanes)
    row('auto-hop', null), // armed state is not in the status document
  ];
  if (idle && typeof idle.ready_units === 'number') {
    rows.push(row('ready work', `${idle.ready_units} units ready${typeof idle.hours_left === 'number' ? `, ${idle.hours_left}h left in this window` : ''}`));
  }
  return { kind: 'seat', id: seat?.id ?? null, title: seat?.label || seat?.id || 'Seat', rows, bars: null, link: { label: SEAT_LINK, to: 'usage' } };
}

/**
 * The money card. `spend` is the meter's `{ceiling, spend}` (fleetSpend), `codex` is `meterRows(...).codex`, `hourly` is the
 * hourly reader's answer `{value: {buckets}, error}` or null, `credit` the API-credit answer `{value, error}` or null.
 */
export function moneyCard({ spend, codex, hourly, credit } = {}) {
  const c = spend?.ceiling;
  const h = spend?.spend;
  const rows = [
    row('today', c ? (c.down || c.text) : null),
    row('last hour', h ? (h.down || h.text) : null),
  ];
  const buckets = Array.isArray(hourly?.value?.buckets) ? hourly.value.buckets : null;
  let bars = null;
  if (buckets && buckets.length > 0) {
    const peak = buckets.reduce((m, b) => (b.usd > m.usd ? b : m), buckets[0]);
    bars = { hours: buckets.map((b) => ({ label: hhmm(Date.parse(b.start)).slice(0, 2), usd: b.usd })), max: peak.usd };
    rows.push(row('closed hours', `peak ${usd(peak.usd)} at ${hhmm(Date.parse(peak.start))}`));
  } else {
    rows.push(row('hourly', null));
  }
  rows.push(row('Codex', codex && codex.pts != null && codex.cap != null ? `${codex.pts} of ${codex.cap} pts today` : null));
  rows.push({ label: 'API credit', value: creditValue(credit), missing: false });
  return { kind: 'money', id: null, title: 'Spend today', rows, bars, link: { label: MONEY_LINK, to: 'usage' } };
}
