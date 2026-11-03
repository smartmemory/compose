# U1 shots: which box each one proves

COMP-DAYVIEW-DESIGN-FIX-1 U1, 2026-11-03. The PNGs sit beside this file. They are git-ignored (`.gitignore:6 *.png`), so they exist only in the local checkout.

BEFORE shots were taken from main `e501918a` after a cockpit restart: the live cockpit was blank (Vite answered 504 "Outdated Optimize Dep" on every dep). AFTER shots were taken from main `3eab0f86` after a restart under the lock, at `http://127.0.0.1:5195/?view=day`, in headless system Chrome.

| Shot | Proves |
|---|---|
| `u1-after-1440-dark.png`, `u1-after-1440-light.png` | **Owner hue.** The one open ask, `NOTIFY-NTFY-1-subscribe`, is a full-height magenta span on the ops lane (its queue row names no lane, and the tip says so) with the "?" marker at now. The WHAT line leads with "1 needs you: Phone push (NOTIFY-NTFY-1)…". Before: a trailing "1 waiting on you" and no owner span anywhere. |
| same | **Fills.** Working is solid green, review is a flat tan band with no hatch, and the legend lists only the kinds drawn in this window (no quota row, for example). |
| same | **No dashed box.** The spend and expiry gaps are one line of words under the ribbon ("Not recorded in this window: spend history … · plan expiry dates …"). |
| same | **Stale.** web ("stale 12d 14h") and bench ("stale 7d 3h") are dashed outlines with "no estimate". |
| `u1-after-400.png` (dark), `u1-after-400-light.png` | **400 Now lines match the 1440 rows.** main reads "waiting on review 3d 21h", web reads "stale: working 12d 14h, no stamp in 24h · ETA none (stale)", and ops reads "waiting on you … · ETA on answer". |
| same | **Meter.** Every seat bar is whole, with no cap and no inner scroll. s4 is in the first row and Codex wraps to the second. |
| all four AFTER shots | **Seat bands (owner D-0043).** Each seat's 5h and 7d bars sit on one shaded `bg-muted/40` band. Measured in the live DOM: 12px between the bars inside a pair and 32px between pairs at both 1440 and 400. The last seat to Codex is 46px (divider plus padding). |
| `u1-before-*.png` | The same views before U1, for comparison. |
