/**
 * xref-citation.test.js — grammar parser accept/reject table
 * (COMP-MCP-XREF-SCHEMA #15, task T001). Pure-function coverage; no I/O.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseCitations, ParseError } from '../lib/xref-citation.js';

function only(cell) {
  const { refs, errors } = parseCitations(cell);
  assert.equal(errors.length, 0, `expected no errors, got: ${JSON.stringify(errors)}`);
  assert.equal(refs.length, 1, `expected exactly 1 ref, got ${refs.length}`);
  return refs[0];
}

describe('parseCitations — accepts (spec §3.1 examples)', () => {
  test('github with expect', () => {
    const r = only('<!-- xref: github owner/repo#123 expect=open -->');
    assert.equal(r.provider, 'github');
    assert.equal(r.repo, 'owner/repo');
    assert.equal(r.issue, 123);
    assert.equal(r.expect, 'open');
    assert.equal(r.note, null);
  });

  test('github with expect + note (any order after target)', () => {
    const r = only('<!-- xref: github smartmemory/compose#7 expect=closed note="shipped COMP-MCP-VALIDATE" -->');
    assert.equal(r.repo, 'smartmemory/compose');
    assert.equal(r.issue, 7);
    assert.equal(r.expect, 'closed');
    assert.equal(r.note, 'shipped COMP-MCP-VALIDATE');
  });

  test('note before expect (order-independent)', () => {
    const r = only('<!-- xref: github o/n#5 note="a b c" expect=open -->');
    assert.equal(r.note, 'a b c');
    assert.equal(r.expect, 'open');
  });

  test('local with expect', () => {
    const r = only('<!-- xref: local compose COMP-MCP-VALIDATE expect=COMPLETE -->');
    assert.equal(r.provider, 'local');
    assert.equal(r.repo, 'compose');
    assert.equal(r.toCode, 'COMP-MCP-VALIDATE');
    assert.equal(r.expect, 'COMPLETE');
  });

  test('url with note (no status resolution)', () => {
    const r = only('<!-- xref: url https://example.com/spec note="design ref, not status-checked" -->');
    assert.equal(r.provider, 'url');
    assert.equal(r.url, 'https://example.com/spec');
    assert.equal(r.note, 'design ref, not status-checked');
  });

  test('missing expect= is valid (spec §11.5), not a ParseError', () => {
    const r = only('<!-- xref: github owner/repo#9 -->');
    assert.equal(r.issue, 9);
    assert.equal(r.expect, null);
  });

  for (const p of ['jira', 'linear', 'notion', 'obsidian']) {
    test(`reserved provider ${p} parses url-class`, () => {
      const r = only(`<!-- xref: ${p} https://x.example/${p}/1 -->`);
      assert.equal(r.provider, p);
      assert.equal(r.url, `https://x.example/${p}/1`);
      assert.equal(r.repo, null);
    });
    test(`reserved provider ${p} accepts expect= (parsed, not rejected)`, () => {
      const r = only(`<!-- xref: ${p} https://x.example/${p}/2 expect=whatever -->`);
      assert.equal(r.expect, 'whatever'); // recorded, never resolved/validated
    });
  }
});

describe('parseCitations — multiplicity / ignored content', () => {
  test('cell with no citation → empty', () => {
    assert.deepEqual(parseCitations('just some prose, no xref'), { refs: [], errors: [] });
  });

  test('empty / non-string input → empty', () => {
    assert.deepEqual(parseCitations(''), { refs: [], errors: [] });
    assert.deepEqual(parseCitations(undefined), { refs: [], errors: [] });
  });

  test('non-xref HTML comment ignored entirely', () => {
    const out = parseCitations('text <!-- TODO: not an xref --> more <!-- another -->');
    assert.deepEqual(out, { refs: [], errors: [] });
  });

  test('url target containing note= / expect= in query is NOT mis-consumed', () => {
    const r = only('<!-- xref: url https://x.example/p?note=a&expect=b -->');
    assert.equal(r.provider, 'url');
    assert.equal(r.url, 'https://x.example/p?note=a&expect=b');
    assert.equal(r.note, null);
    assert.equal(r.expect, null);
  });

  test('url with query note= AND a real trailing note="..."', () => {
    const r = only('<!-- xref: url https://x.example/?note=a note="real note" -->');
    assert.equal(r.url, 'https://x.example/?note=a');
    assert.equal(r.note, 'real note');
  });

  test('url with query expect= AND a real trailing expect=', () => {
    const r = only('<!-- xref: github o/n#4 expect=open -->');
    assert.equal(r.expect, 'open');
    const r2 = only('<!-- xref: url https://x.example/?expect=zzz note="n" -->');
    assert.equal(r2.url, 'https://x.example/?expect=zzz');
    assert.equal(r2.note, 'n');
  });

  test('multiple citations in one cell', () => {
    const { refs, errors } = parseCitations(
      'row <!-- xref: github a/b#1 --> and <!-- xref: url https://h.example -->',
    );
    assert.equal(errors.length, 0);
    assert.equal(refs.length, 2);
    assert.equal(refs[0].provider, 'github');
    assert.equal(refs[1].provider, 'url');
  });
});

describe('parseCitations — rejects (structured ParseError)', () => {
  const bad = [
    ['unknown provider', '<!-- xref: bitbucket o/n#1 -->'],
    ['github bad target (no #issue)', '<!-- xref: github owner/repo -->'],
    ['github non-numeric issue', '<!-- xref: github o/n#abc -->'],
    ['github # in owner half', '<!-- xref: github ow#ner/name#1 -->'],
    ['github # in name half', '<!-- xref: github owner/na#me#1 -->'],
    ['local missing feature code', '<!-- xref: local compose -->'],
    ['local invalid feature code', '<!-- xref: local compose not-a-code -->'],
    ['local repo token traversal', '<!-- xref: local ../../etc COMP-X-1 -->'],
    ['local repo token with slash', '<!-- xref: local a/b COMP-X-1 -->'],
    ['missing target', '<!-- xref: github -->'],
    ['unterminated note quote', '<!-- xref: github o/n#1 note="oops -->'],
    ['github invalid expect token', '<!-- xref: github o/n#1 expect=merged -->'],
    ['local invalid expect token', '<!-- xref: local r CODE-1 expect=DONE -->'],
  ];
  for (const [label, cell] of bad) {
    test(label, () => {
      const { refs, errors } = parseCitations(cell);
      assert.equal(refs.length, 0, `${label}: expected 0 refs`);
      assert.equal(errors.length, 1, `${label}: expected 1 error`);
      assert.ok(errors[0] instanceof ParseError);
      assert.ok(typeof errors[0].reason === 'string' && errors[0].reason.length > 0);
      assert.ok(typeof errors[0].raw === 'string');
    });
  }
});
