import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// A uuid column compared to `${maybeId ?? ''}` fails at bind time with
// 22P02 (invalid input syntax for type uuid: ""), even when an OR branch
// beside it is already true: PostgreSQL validates every bound parameter.
// The purchase-order, estimate, and sales-order create views crashed into
// the error boundary exactly this way. Guard the shape everywhere in web/:
// build the comparison only when the id is a real uuid instead.
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

const EMPTY_UUID_BIND = /id\s*=\s*\$\{[^}]*\?\?\s*''\s*\}/g

test('no sql id comparison binds an empty-string fallback', () => {
  const offenders: string[] = []
  for (const path of walk(webRoot)) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(EMPTY_UUID_BIND)) {
      const line = source.slice(0, match.index).split('\n').length
      offenders.push(`${relative(webRoot, path)}:${line}: ${match[0]}`)
    }
  }
  assert.deepEqual(offenders, [], 'bind the id only when it is a uuid (see purchase-orders/view.ts openDocumentId)')
})

test('the guard recognises the shape it exists to catch', () => {
  const sample = 'where org_id = ${orgId} and document_id = ${openId ?? \'\'} and item_id is not null'
  assert.equal([...sample.matchAll(EMPTY_UUID_BIND)].length, 1)
})
