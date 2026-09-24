// source-pin-contract: no HRM create form renders an id as a label; subjects derived by walking web/app/(app)/hrm views
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { isUuid } from '@/lib/list-params'

/**
 * F3: ?requisition=new showed a raw UUID in the Employer field — the loader
 * fell back to [{ value: rootId, label: '' }] and the form rendered
 * `label || value`. The loader now resolves the authorized employer's NAME
 * (the named root for single-entity orgs), and a caller scoped out of every
 * visible entity is refused by name instead of being offered an
 * unauthorized root. No form may ever render an id as a label.
 * (Ticket in comment only; the test names state the behaviour.)
 *
 * The first two tests RENDER the recruiting and position create forms:
 * the refusal reads as an alert with submit disabled, and the employer
 * reads as a name with no id in the output. The repo-wide walk below is
 * the derived structural invariant that catches the NEXT form rendering
 * an id where a name belongs. The every-locale refusal test asserts the
 * data rule (translated words, never an id) on the message catalogs.
 */

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return { refresh(){}, push(){} }}',
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
// Dynamic: the forms resolve next/navigation through the stub above, so
// they must load after the hook registers.
const { RecruitingCreateForm } = await import('./recruiting/RecruitingCreateForm')
const { PositionCreateForm } = await import('./positions/PositionCreateForm')

const HRM = join(process.cwd(), 'web', 'app', '(app)', 'hrm')
const MESSAGES = join(process.cwd(), 'web', 'messages')
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

const ENTITY_ID = 'd726d187-0000-0000-0000-000000000001'
const REFUSAL = 'No legal entity is visible to you — ask an administrator for access.'

const RECRUITING_LABELS = {
  title: 'Title',
  employer: 'Employer',
  department: 'Department',
  noDepartment: 'No department',
  headcount: 'Headcount',
  targetStart: 'Target start',
  submit: 'Create requisition',
  failed: 'Could not create the requisition',
}

const POSITION_LABELS = {
  code: 'Code',
  title: 'Title',
  employer: 'Employer',
  department: 'Department',
  noDepartment: 'No department',
  plannedFte: 'Planned FTE',
  status: 'Status',
  effectiveFrom: 'Effective from',
  reason: 'Reason',
  reasonPlaceholder: 'Why is this position needed?',
  submit: 'Create position',
  failed: 'Could not create the position',
}

function provider(children: React.ReactNode): React.ReactNode {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  )
}

function recruitingHtml(employers: Array<{ value: string; label: string }>, employerRefusal: string | null): string {
  return renderToStaticMarkup(
    provider(
      <RecruitingCreateForm
        basePath="/hrm/recruiting"
        employers={employers}
        employerRefusal={employerRefusal}
        departments={[]}
        labels={RECRUITING_LABELS}
      />,
    ),
  )
}

function positionHtml(employers: Array<{ value: string; label: string }>, employerRefusal: string | null): string {
  return renderToStaticMarkup(
    provider(
      <PositionCreateForm
        basePath="/hrm/positions"
        effectiveDate="2026-09-22"
        employers={employers}
        employerRefusal={employerRefusal}
        departments={[]}
        statuses={[{ value: 'planned', label: 'Planned' }]}
        labels={POSITION_LABELS}
      />,
    ),
  )
}

test('a caller with no authorized legal entity is refused by name and cannot submit', () => {
  for (const [name, html] of [
    ['recruiting', recruitingHtml([], REFUSAL)],
    ['positions', positionHtml([], REFUSAL)],
  ] as const) {
    assert.match(html, /role="alert"/, `${name}: the refusal renders as an accessible alert`)
    assert.ok(html.includes(REFUSAL), `${name}: the refusal names the remedy in words`)
    assert.match(html, /disabled/, `${name}: the refusal blocks submit`)
    assert.ok(!html.includes(ENTITY_ID), `${name}: no unauthorized id is offered beside the refusal`)
  }
})

test('the authorized employer renders as a name, never an id', () => {
  const employers = [{ value: ENTITY_ID, label: 'Main' }]
  for (const [name, html] of [
    ['recruiting', recruitingHtml(employers, null)],
    ['positions', positionHtml(employers, null)],
  ] as const) {
    assert.ok(html.includes('Main'), `${name}: the single entity renders its NAME`)
    assert.ok(!html.includes(ENTITY_ID), `${name}: the raw employer id never renders as text`)
  }
})

test('no HRM create form renders an id as a label', () => {
  function tsxFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) tsxFiles(path, out)
      else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) out.push(path)
    }
    return out
  }
  const offenders = tsxFiles(HRM).filter((file) => /label \|\| .*value/.test(readFileSync(file, 'utf8')))
  assert.deepEqual(offenders, [], `forms rendering an id where a name belongs: ${offenders.join(', ')}`)
})

test('the refusal names the remedy in every locale', () => {
  for (const locale of LOCALES) {
    const catalog = JSON.parse(
      readFileSync(join(MESSAGES, locale, 'hrm.json'), 'utf8'),
    )
    for (const section of ['recruiting', 'positions']) {
      const message = catalog[section]?.create?.noEmployer
      assert.ok(typeof message === 'string' && message.length > 0, `${locale}/${section}: noEmployer must be translated`)
      assert.ok(!isUuid(message), `${locale}/${section}: the refusal is words, never an id`)
    }
  }
})
