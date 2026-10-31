/**
 * ask-options.test.js — COMP-COCKPIT-NOTIFY-ACTIONS-1: `optionsOf`, the one parser the answer route and the cockpit share.
 * One row table: each marker style, envelope options, and every shape that must give no options (free text only).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { optionsOf, choiceText } from '../lib/ask-options.js';

describe('optionsOf', () => {
  // [name, record, expected [value, label] pairs]
  const ROWS = [
    ['(a) (b) inline', { text: 'QUESTION: ship it? (a) yes (b) no' }, [['a', 'yes'], ['b', 'no']]],
    ['a) b) on their own lines', { text: 'Pick one:\na) the fast path\nb) the safe path' }, [['a', 'the fast path'], ['b', 'the safe path']]],
    ['a. b. c. after colons and semicolons', { text: 'Order:a. first; b. second; c. third' }, [['a', 'first'], ['b', 'second'], ['c', 'third']]],
    ['envelope options as objects win over the text', { text: '(a) x (b) y', options: [{ value: 'go', label: 'Go now' }, { value: 'wait', label: 'Wait' }] }, [['go', 'Go now'], ['wait', 'Wait']]],
    ['envelope options as plain strings', { text: 'whatever', options: ['yes', 'no'] }, [['yes', 'yes'], ['no', 'no']]],
    ['no markers: free text only', { text: 'QUESTION: what should the cap be?' }, []],
    ['a single (a) is not a choice', { text: 'see (a) above' }, []],
    ['letters that skip are not options', { text: '(a) one (c) three' }, []],
    ['mixed styles are not options', { text: '(a) one b) two' }, []],
    ['prose like "plan a. then" is not an option', { text: 'we follow plan a. then we stop' }, []],
    ['e.g. inside a label does not split it', { text: '(a) a tool, e.g. ruff (b) none' }, [['a', 'a tool, e.g. ruff'], ['b', 'none']]],
    ['labels are clipped at a newline', { text: '(a) yes\nmore words here (b) no' }, [['a', 'yes'], ['b', 'no']]],
    ['an empty label gives no options', { text: 'pick (a) (b) now' }, []],
    ['letters must start at a', { text: '(b) one (c) two' }, []],
  ];
  it('rows', () => {
    for (const [name, record, want] of ROWS) {
      assert.deepEqual(optionsOf(record).map((o) => [o.value, o.label]), want, name);
    }
  });
  it('choiceText is "(value) label"', () => {
    assert.equal(choiceText({ value: 'b', label: 'no' }), '(b) no');
  });
});
