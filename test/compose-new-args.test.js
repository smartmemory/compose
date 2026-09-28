import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const cli = readFileSync(new URL('../bin/compose.js', import.meta.url), 'utf8')
const parsingBlock = cli.match(/if \(cmd === 'new'\) \{\s*([\s\S]*?)\n\s*if \(!intent\) \{/)
assert.ok(parsingBlock, 'compose new argument parsing block exists')

// Evaluate the CLI's own parsing statements without entering its build flow.
const parseNewArgs = new Function('args', `${parsingBlock[1]}\nreturn { intent, autoMode }`)

const cases = [
  { args: ['desc'], intent: 'desc', autoMode: false },
  { args: ['desc', '--auto'], intent: 'desc', autoMode: true },
  { args: ['--auto', 'desc'], intent: 'desc', autoMode: true },
  { args: ['desc', '--from-idea', 'ID'], intent: 'desc', autoMode: false },
  { args: ['--from-idea', 'ID'], intent: '', autoMode: false },
  { args: [], intent: '', autoMode: false },
  { args: ['a', 'b', 'c'], intent: 'a b c', autoMode: false },
]

for (const { args, intent, autoMode } of cases) {
  test(`compose new ${args.join(' ') || '(no args)'}`, () => {
    assert.deepEqual(parseNewArgs(args), { intent, autoMode })
  })
}
