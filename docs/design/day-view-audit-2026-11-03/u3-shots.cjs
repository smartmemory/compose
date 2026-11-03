#!/usr/bin/env node
/**
 * u3-shots.cjs — COMP-DAYVIEW-DESIGN-FIX-1 U3: the before/after shots of the Day view, plus the measurements each box needs.
 *
 * Usage: node u3-shots.cjs <before|after> <outDir> <debugPort> [playwright-core path]
 * Read-only: it loads `http://127.0.0.1:5195/?view=day` in headless system Chrome and clicks nothing. Unlike U2's script it
 * waits for the page, not a clock: the WHAT line, a seat meter row and the ribbon (or the phone Now list) must be rendered
 * before a shot (a selector wait, never a sleep). Prints one JSON line of measurements per shot.
 */
const path = require('node:path');

const [phase, outDir, port, pwPath] = process.argv.slice(2);
if (!['before', 'after'].includes(phase) || !outDir || !port) {
  console.error('usage: node u3-shots.cjs <before|after> <outDir> <debugPort> [playwright-core path]');
  process.exit(2);
}
const { chromium } = require(pwPath || 'playwright-core');
const URL = 'http://127.0.0.1:5195/?view=day';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = [
  { name: `u3-${phase}-1440-dark.png`, w: 1440, h: 900, theme: 'dark' },
  { name: `u3-${phase}-1440-light.png`, w: 1440, h: 900, theme: 'light' },
  { name: `u3-${phase}-400.png`, w: 400, h: 860, theme: 'dark' },
];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: [`--remote-debugging-port=${port}`] });
  try {
    for (const s of SHOTS) {
      const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 1 });
      await ctx.addInitScript((t) => { try { localStorage.setItem('compose:theme', t); } catch { /* none */ } }, s.theme);
      const page = await ctx.newPage();
      await page.goto(URL, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="what-line"]', { timeout: 60_000 });
      await page.waitForSelector('[data-testid^="cost-meter-seat-"]', { timeout: 60_000 });
      await page.waitForSelector(s.w < 768 ? '[data-testid="day-phone-now"]' : '[data-testid="ribbon-svg"]', { timeout: 60_000 });
      await page.waitForFunction(() => !document.querySelector('[data-testid="day-skeleton"]'), null, { timeout: 60_000 });
      await page.screenshot({ path: path.join(outDir, s.name) });
      const m = await page.evaluate(() => {
        const q = (sel) => document.querySelector(sel);
        const strip = q('[data-testid="header-status-strip"]');
        const kids = strip ? [...strip.children].map((c) => Math.round(c.getBoundingClientRect().left)) : [];
        const box = q('[data-testid="ribbon-box"]');
        const svg = q('[data-testid="ribbon-svg"]');
        const asOfs = [...document.querySelectorAll('[data-testid="what-asof"], [data-testid="ribbon-fresh"]')].map((e) => e.textContent).filter((t) => /as of/.test(t));
        const decide = q('[data-testid="ribbon-legend"] [data-key="decide"]');
        return {
          viewport: innerWidth,
          sidewaysScroll: document.documentElement.scrollWidth > innerWidth,
          headerChildLefts: kids,
          ribbonBox: box ? { client: box.clientWidth, border: Math.round(box.getBoundingClientRect().width) } : null,
          svgWidth: svg ? Number(svg.getAttribute('width')) : null,
          asOfTexts: asOfs,
          markShapes: document.querySelectorAll('.mark [data-shape]').length,
          markGlyphs: [...document.querySelectorAll('.mark text.tk')].length,
          legendDecide: decide ? { shape: !!decide.querySelector('[data-shape="square"]'), text: decide.textContent } : null,
          footLinkColor: q('[data-testid="day-link-process"]') ? getComputedStyle(q('[data-testid="day-link-process"]')).color : null,
          phoneStrips: document.querySelectorAll('[data-testid="day-phone-strip"]').length,
          phoneRows: document.querySelectorAll('[data-testid="day-phone-lane"]').length,
          sourceNotes: [...document.querySelectorAll('[data-testid="source-note"]')].map((e) => e.textContent),
        };
      });
      console.log(JSON.stringify({ shot: s.name, ...m }));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
