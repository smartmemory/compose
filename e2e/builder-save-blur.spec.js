/**
 * e2e/builder-save-blur.spec.js — Compose's own user flow for the Stratum builder's Save
 * (COMP-VERIFY-FLOW-1 dogfood, replays incident I18).
 *
 * I18: the step id field commits its draft on blur, and Save did not wait for that commit, so
 * Save wrote the old document. This does what a person does: open the saved pipeline, click a
 * step, type a new id, click Save without pressing Tab or clicking elsewhere, reload, open the
 * same pipeline and step, and print `RELOADED id=<value>`. The verify block expects
 * `RELOADED id=renamed-step`; the old code prints the old id.
 */
import { expect, test } from '@playwright/test';

import { SEED_NAME, SEED_STEP } from './flow-setup.mjs';

const LIVE = /^https?:\/\/(127\.0\.0\.1|localhost):(4001|4002)\//;

async function openSeed(page) {
  await page.goto(`${process.env.FLOW_COCKPIT_URL}/?view=stratum`);
  await page.getByRole('tab', { name: 'New pipeline', exact: true }).click();
  const open = page.getByTestId('builder-open');
  await expect(open.locator(`option[value="${SEED_NAME}"]`)).toHaveCount(1, { timeout: 30_000 });
  await open.selectOption(SEED_NAME);
  await expect(page.getByTestId('builder-status')).toContainText(`Opened ${SEED_NAME}`);
}

test('builder Save keeps an id typed just before it', async ({ page }) => {
  // Belt and braces: the cockpit must never reach the owner's live server or agent.
  await page.route(LIVE, (route) => { console.error(`SETUP: blocked a request to a live port: ${route.request().url()}`); return route.abort(); });

  await openSeed(page);
  await page.locator(`[data-step-id="${SEED_STEP}"]`).first().click();
  const id = page.getByLabel('field id');
  await expect(id).toHaveValue(SEED_STEP);
  await id.fill('renamed-step');
  await page.waitForTimeout(600); // a person's pause; no Tab, no click elsewhere
  await page.getByTestId('builder-save').click();
  await expect(page.getByTestId('builder-status')).toContainText(`Updated ${SEED_NAME}`, { timeout: 15_000 });

  await page.reload();
  await openSeed(page);
  await page.locator('[data-step-id]').first().click();
  console.log(`RELOADED id=${await page.getByLabel('field id').inputValue()}`);
});
