import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const view = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

/**
 * The unified Reports page is the ONE home for every report, so what it does
 * not show does not exist for the operator.
 *
 * Two ways it used to hide a whole module's reports, both silent:
 *
 *  1. It read `report_definitions` rows without materialising them. Those
 *     rows appear only when something calls `ensureReportDefinitions` — the
 *     builder, the definitions API, the payroll evidence pack. On an org
 *     where none of those had run, the hub rendered with no built-in
 *     reports at all: no Payroll group, no Human-resources group, and
 *     nothing on the page to say they were missing.
 *  2. It capped the read at twelve rows ordered by `updated_at desc`. A
 *     module's entire group could drop off because twelve unrelated reports
 *     had been touched more recently — and the page looked complete either
 *     way. The hub cannot know what the cap cut.
 */

test('the hub materialises the built-in catalog before it reads it', () => {
  assert.match(view, /ensureReportDefinitions\(orgId\)/, 'the hub seeds the catalog it renders')
  assert.ok(
    view.indexOf('ensureReportDefinitions(orgId)') < view.indexOf('from report_definitions'),
    'the seed runs before the read, or the first visit still shows an empty catalog',
  )
})

test('the built-in catalog read is not truncated', () => {
  const definitionsRead = view.slice(
    view.indexOf('from report_definitions'),
    view.indexOf('from report_definitions') + 200,
  )
  assert.doesNotMatch(definitionsRead, /limit \d+/, 'no row cap on the report catalog')
  // Saved views keep theirs on purpose: those are "the most recent twelve".
  assert.match(view, /from saved_reports[\s\S]{0,120}limit 12/, 'saved views stay capped')
})

test('every built-in is first class and Custom contains only org-authored definitions', () => {
  assert.match(view, /builtInDefinitions = visibleDefinitions\.filter\(\(row\) => row\.kind === 'built_in'\)/)
  assert.match(view, /customDefinitions = visibleDefinitions\.filter\(\(row\) => row\.kind !== 'built_in'\)/)
  assert.match(view, /otherBuiltInDefinitions/, 'future built-in categories remain first class instead of leaking into Custom')
  assert.match(view, /customDefinitions\.filter/, 'only user-authored definitions enter Custom & Saved')
  assert.doesNotMatch(
    view.slice(view.indexOf("key: 'custom'")),
    /otherDefinitions|builtInDefinitions/,
    'the Custom group never consumes a built-in collection',
  )
})

test('operational built-ins are classified into their domain groups', () => {
  assert.match(view, /entityCategory\(row\) === 'payroll'/, 'payroll built-ins are first class')
  assert.match(view, /entityCategory\(row\) === 'hrm'/, 'workforce built-ins are first class')
  assert.match(view, /entityCategory\(row\) === 'crm'/, 'CRM built-ins are first class')
  assert.match(view, /entityCategory\(row\) === 'inventory'/, 'inventory built-ins are first class')
  assert.match(view, /entityCategory\(row\) === 'ai governance'/, 'AI governance built-ins are first class')
  assert.match(view, /row\.slug\.startsWith\('allocation-'\)/, 'allocation built-ins are first class')
  assert.match(view, /ap-aging-by-vendor/, 'AP aging joins receivables and payables')
  assert.match(view, /open-ar-by-customer/, 'open AR joins receivables and payables')
  assert.match(view, /key: 'crm'/, 'the CRM group exists')
  assert.match(view, /key: 'hrm'/, 'the workforce group exists')
  // The HR module has no reports page of its own — this is where they live.
  assert.throws(
    () => readFileSync(new URL('../hrm/reports/page.tsx', import.meta.url), 'utf8'), // source-path: synthetic — the absence IS the assertion
    'no second reports page may exist under /hrm',
  )
})

test('HRM uses the unified definition catalog, never a second source catalog', () => {
  assert.match(view, /from report_definitions/, 'the hub reads the one report-definition catalog')
  assert.match(view, /entityCategory\(row\) === 'hrm'/, 'the HRM group is derived from catalog definitions')
  assert.doesNotMatch(view, /HRM_REPORT_ENTITIES/, 'the hub does not maintain a parallel HRM catalog')
  assert.match(view, /hiddenReportEntityKeys\(authz\)/, 'entity permissions and feature gates filter the catalog')
})
