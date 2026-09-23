import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * F1: the requisition drawer heading rendered the literal
 * "Requisition {number}" — the loader called t('recruiting.drawer.title')
 * without the {number} the message declares, and next-intl leaves the
 * braces on the page. Every t()/tc() call in the HRM views whose English
 * message declares {placeholders} must pass values, so no heading, badge,
 * or refusal ever ships with braces again.
 *
 * Derived from the call sites, never a hand list: the test walks every
 * HRM view file and checks each translation call against the catalog.
 */

const HRM = join(process.cwd(), 'web', 'app', '(app)', 'hrm')
const EN = join(process.cwd(), 'web', 'messages', 'en')

function flat(node: unknown, prefix: string, out: Map<string, string>): void {
  if (typeof node === 'string') {
    out.set(prefix, node)
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      flat(value, prefix ? `${prefix}.${key}` : key, out)
    }
  }
}

function catalog(name: string): Map<string, string> {
  const out = new Map<string, string>()
  flat(JSON.parse(readFileSync(join(EN, `${name}.json`), 'utf8')), '', out)
  return out
}

function viewFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      viewFiles(path, out)
    } else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.endsWith('.test.ts')) {
      out.push(path)
    }
  }
  return out
}

function placeholdersOf(message: string): string[] {
  return [...message.matchAll(/\{(\w+)/g)].map((m) => m[1]!)
}

test('every HRM translation call whose message declares placeholders passes values', () => {
  const hrm = catalog('hrm')
  const common = catalog('common')
  const violations: string[] = []
  // t('key') or t('key', {...}) — the comma may sit on a later line, so the
  // match runs multiline and only asks whether values follow the key.
  const calls = /\b(?:t|tc)\(\s*'([^']+)'\s*(,|\))/gs
  for (const file of viewFiles(HRM)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(calls)) {
      const key = match[1]!
      const passesValues = match[2] === ','
      const message = hrm.get(key) ?? common.get(key)
      if (message === undefined) continue
      const placeholders = placeholdersOf(message)
      if (placeholders.length > 0 && !passesValues) {
        const line = source.slice(0, match.index).split('\n').length
        violations.push(`${file}:${line} t('${key}') renders ${JSON.stringify(message)} with no values`)
      }
    }
  }
  assert.deepEqual(violations, [], `translation calls that would render literal {braces}:\n${violations.join('\n')}`)
})

test('the requisition drawer title carries the requisition number', () => {
  const view = readFileSync(join(HRM, 'recruiting', 'view.ts'), 'utf8')
  assert.match(
    view,
    /t\('recruiting\.drawer\.title',\s*\{\s*number:/,
    'the drawer title must pass { number } so the heading never renders a literal {number}',
  )
})
