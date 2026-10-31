/**
 * costLogic.js — pure helpers for the one cost meter (COMP-COCKPIT-COST-METER-1). No React imports.
 *
 * Input is GET /api/usage/seats `seats.value.seats` (usage_watch, one row per account) plus `fleetSpend(...)`
 * (the sm_status ceiling and spend panels). Every number the meter prints goes through `fmtPct`, so Home and
 * Usage cannot round the same seat two ways.
 */

/** The one rounding: an integer percent, `—` for null/NaN. */
export function fmtPct(v) {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}%` : '—';
}

/** Minutes/hours/days until an ISO reset, `reset` once it has passed, `—` when unknown. */
export function resetIn(iso, now) {
  if (!iso) return '—';
  const mins = Math.round((Date.parse(iso) - now) / 60_000);
  if (!Number.isFinite(mins)) return '—';
  if (mins <= 0) return 'reset';
  return mins < 60 ? `${mins}m` : mins < 2880 ? `${(mins / 60).toFixed(1)}h` : `${Math.round(mins / 1440)}d`;
}

export const FIVE_H_ONLY = 'Team seats are 5h-only';
export const API_CREDIT_NOTE = 'API credit: no reader yet';
export const DOLLARS_PER_SEAT_NOTE = 'Dollars per seat: not recorded';
export const RETIRED_NOTE = (n) => `${n} retired seat${n === 1 ? '' : 's'} hidden`;

/** "as of 14:05 (3m ago)" from the seats reader's `generated_at`; `as of —` when it printed none. */
export function asOfText(iso, now) {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return 'as of —';
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const ago = Math.max(0, Math.round((now - ms) / 60_000));
  return `as of ${hhmm} (${ago}m ago)`;
}

const cut = (arr, n) => ({ shown: arr.slice(0, n), more: Math.max(0, arr.length - n) });
export const LAST_HOUR_SHOWN = 3;

/**
 * Pure: the meter's data lines. Retired seats are counted, never listed as rows. A row carrying `codex_daily` is the
 * Codex line (points against the cap in the data), every other row is a seat line.
 */
export function meterRows(seats, spend, now) {
  const all = Array.isArray(seats) ? seats : [];
  const retired = all.filter((s) => s.retired === true);
  const active = all.filter((s) => s.retired !== true);
  const codexRow = active.find((s) => s.codex_daily);
  const seatLines = active.filter((s) => !s.codex_daily).map((s) => ({
    id: s.id,
    label: s.label,
    five: { pct: fmtPct(s.five_h?.used_pct), reset: resetIn(s.five_h?.resets_at, now) },
    seven: s.seven_d?.status === 'missing'
      ? { fiveOnly: true, text: FIVE_H_ONLY }
      : { fiveOnly: false, text: fmtPct(s.seven_d?.used_pct), reset: resetIn(s.seven_d?.resets_at, now) },
  }));
  const fable = active.filter((s) => s.fable).map((s) => ({
    id: s.id,
    label: s.label,
    text: s.fable.used_pct === null ? 'no reading' : fmtPct(s.fable.used_pct),
    reset: resetIn(s.fable.resets_at, now),
    cap: s.fable.cap_pct === null ? null : fmtPct(s.fable.cap_pct),
    over: s.fable.over_cap === true,
  }));
  const codex = codexRow ? {
    label: codexRow.label,
    pts: typeof codexRow.today_pts === 'number' ? codexRow.today_pts : null,
    cap: codexRow.codex_daily.cap_pct,
    state: codexRow.codex_daily.off ? 'cap off' : codexRow.codex_daily.state ?? '—',
    off: codexRow.codex_daily.off === true,
  } : null;
  const hour = spend && Array.isArray(spend.spend?.rows) ? cut(spend.spend.rows, LAST_HOUR_SHOWN) : null;
  return { seats: seatLines, fable, codex, retired: { count: retired.length, names: retired.map((s) => s.label) }, hour };
}
