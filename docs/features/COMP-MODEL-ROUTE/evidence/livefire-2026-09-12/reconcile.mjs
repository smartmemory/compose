#!/usr/bin/env node
/**
 * reconcile.mjs — complete-plus-excluded reconciliation for COMP-MODEL-ROUTE gate 5.
 *
 * Run:  node reconcile.mjs [ledger.jsonl]
 * Exits non-zero if any invariant fails, so this is a falsifier, not a claim.
 *
 * Invariants checked:
 *   1. complete + excluded partitions the ledger exactly (exhaustive, disjoint).
 *   2. Every paid receipt ref is unique by payloadDigest AND by dispatchId, so no
 *      row can double-count another row's receipt.
 *   3. Every row carries exactly one receipt ref (1:1 row <-> receipt).
 *   4. Excluded rows contribute NOTHING: their usd is null, never coerced to 0.
 *   5. The sum over complete rows equals the sum over all non-null usd in the file.
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? new URL('./ledger.jsonl', import.meta.url).pathname;
const rows = readFileSync(path, 'utf-8').trim().split('\n').map(l => JSON.parse(l));

const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); return ok; };

const complete = rows.filter(r => r.completeness.state === 'complete');
const excluded = rows.filter(r => r.completeness.state !== 'complete');

check(complete.length + excluded.length === rows.length, 'partition is not exhaustive');
check(new Set([...complete, ...excluded]).size === rows.length, 'partition is not disjoint');

const refs = rows.flatMap(r => r.cost.paidReceiptRefs);
check(new Set(refs.map(r => r.payloadDigest)).size === refs.length, 'duplicate payloadDigest — double-count possible');
check(new Set(refs.map(r => r.dispatchId)).size === refs.length, 'duplicate dispatchId — double-count possible');
check(rows.every(r => r.cost.paidReceiptRefs.length === 1), 'a row does not carry exactly one receipt ref');

check(excluded.every(r => r.cost.usd === null), 'an excluded row carries a non-null usd');
check(excluded.every(r => r.completeness.reasons.length > 0), 'an excluded row states no reason');

const sum = xs => xs.reduce((a, r) => a + r.cost.usd, 0);
const completeSum = sum(complete);
const nonNullSum = sum(rows.filter(r => r.cost.usd !== null));
check(Math.abs(completeSum - nonNullSum) < 1e-12, `complete sum ${completeSum} != non-null sum ${nonNullSum}`);

const by = p => complete.filter(r => r.cost.provenance.join() === p);
const fmt = n => `$${n.toFixed(7)}`;

console.log(`rows                 ${rows.length}`);
console.log(`complete / excluded  ${complete.length} / ${excluded.length}  (exhaustive, disjoint)`);
console.log(`receipt refs         ${refs.length} total, ${new Set(refs.map(r => r.payloadDigest)).size} unique digests, 1 per row`);
console.log(`exclusion reasons    ${[...new Set(excluded.flatMap(r => r.completeness.reasons))].join(', ')}`);
console.log(`excluded usd         ${[...new Set(excluded.map(r => String(r.cost.usd)))].join(', ')} (never 0)`);
console.log(`reported             n=${by('reported').length}  ${fmt(sum(by('reported')))}`);
console.log(`estimated            n=${by('estimated').length}  ${fmt(sum(by('estimated')))}`);
console.log(`TOTAL ATTRIBUTED     ${fmt(completeSum)}`);

if (fail.length) { console.error('\nFAILED:\n- ' + fail.join('\n- ')); process.exit(1); }
console.log('\nAll reconciliation invariants hold.');
