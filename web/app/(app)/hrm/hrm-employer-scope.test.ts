import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * F3: ?requisition=new showed a raw UUID in the Employer field — the loader
 * fell back to [{ value: rootId, label: '' }] and the form rendered
 * `label || value`. The loader now resolves the authorized employer's NAME
 * (the named root for single-entity orgs), and a caller scoped out of every
 * visible entity is refused by name instead of being offered an
 * unauthorized root. No form may ever render an id as a label.
 */

const HRM = join(process.cwd(), 'web', 'app', '(app)', 'hrm')
const MESSAGES = join(process.cwd(), 'web', 'messages')
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) tsxFiles(path, out)
    else if (entry.endsWith('.tsx') && !entry.endsWith('.test.ts')) out.push(path)
  }
  return out
}

test('the loaders resolve the authorized employer name, never an empty label', () => {
  for (const view of ['recruiting/view.ts', 'positions/view.ts']) {
    const source = read(join(HRM, view))
    assert.match(source, /rootSubsidiary\(\)/, `${view}: the single-entity fallback resolves the named root`)
    assert.ok(!source.includes("label: ''"), `${view}: no empty employer label may ship`)
    assert.ok(!source.includes('rootSubsidiaryId()'), `${view}: the bare id lookup is gone`)
  }
})

test('a caller with no authorized legal entity is refused by name', () => {
  const recruiting = read(join(HRM, 'recruiting/view.ts'))
  const positions = read(join(HRM, 'positions/view.ts'))
  assert.match(recruiting, /employerRefusal = t\('recruiting\.create\.noEmployer'\)/, 'recruiting refuses by name')
  assert.match(positions, /employerRefusal = t\('positions\.create\.noEmployer'\)/, 'positions refuses by name')
  for (const [file, form] of [
    ['recruiting/RecruitingCreateForm.tsx', 'recruiting'],
    ['positions/PositionCreateForm.tsx', 'positions'],
  ] as const) {
    const source = read(join(HRM, file))
    assert.match(source, /employerRefusal/, `${form}: the form receives the refusal`)
    assert.match(source, /role="alert"/, `${form}: the refusal renders as an accessible alert`)
    assert.match(source, /employerRefusal !== null/, `${form}: the refusal blocks submit`)
  }
})

test('no HRM create form renders an id as a label', () => {
  const offenders = tsxFiles(HRM).filter((file) => /label \|\| .*value/.test(read(file)))
  assert.deepEqual(offenders, [], `forms rendering an id where a name belongs: ${offenders.join(', ')}`)
  for (const file of ['recruiting/RecruitingCreateForm.tsx', 'positions/PositionCreateForm.tsx']) {
    const source = read(join(HRM, file))
    assert.ok(!/\{\s*employers\[0\]\?\.value\s*\}/.test(source), `${file}: the raw employer id never renders as text`)
  }
})

test('the refusal names the remedy in every locale', () => {
  for (const locale of LOCALES) {
    const catalog = JSON.parse(read(join(MESSAGES, locale, 'hrm.json')))
    for (const section of ['recruiting', 'positions']) {
      const message = catalog[section]?.create?.noEmployer
      assert.ok(typeof message === 'string' && message.length > 0, `${locale}/${section}: noEmployer must be translated`)
      assert.ok(!/^[0-9a-f-]{36}$/i.test(message), `${locale}/${section}: the refusal is words, never an id`)
    }
  }
})
