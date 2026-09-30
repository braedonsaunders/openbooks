import assert from 'node:assert/strict'
import test from 'node:test'
import { demoRecords, demoRecordId, type DemoContext } from '../../../engine/src/sample-companies/scenarios.ts'
import { parseAutomationTrigger, parseAutomationActions } from '../../../engine/src/automations/triggers.ts'
import { automationGraphSchema } from '@openbooks/forms-core'
import { parseManifest, validateBundle } from './manifest.ts'
import { parseNativeExtension } from './native-ui.ts'

const id = (key: string) => demoRecordId('00000000-0000-4000-8000-000000000001', 'fixture', key)
const context: DemoContext = {
  orgId: id('org'), industryKey: 'general_business', companyName: 'Example Company',
  actorId: id('actor'), subsidiaryId: id('subsidiary'), bookId: id('book'), periodId: id('period'),
  customerId: id('customer'), vendorId: id('vendor'), employeeId: id('employee'), opportunityStatusId: id('opportunity'),
  currency: 'USD', date: '2026-09-30', year: 2026,
  accounts: Object.fromEntries(['bank', 'receivable', 'revenue', 'expense', 'inventory', 'payable', 'equipment', 'accumulatedDepreciation', 'deferredRevenue'].map(key => [key, id(key)])) as DemoContext['accounts'],
}
const records = demoRecords(context)

test('the industry extension is a complete native app bundle accepted by the actual upload validators', () => {
  const version = records.find(record => record.table === 'app_versions')!
  const files = records.filter(record => record.table === 'app_files')
  const parsed = parseManifest(version.values.manifest)
  assert.equal(parsed.ok, true, parsed.errors.join('; '))
  assert.ok(parsed.manifest)
  const bundle = validateBundle(parsed.manifest, files.map(file => String(file.values.path)))
  assert.equal(bundle.ok, true, bundle.errors.join('; '))
  const frontend = files.find(file => file.values.path === parsed.manifest!.frontend.entry)!
  assert.equal(parseNativeExtension(String(frontend.values.content), parsed.manifest).screens.length, 1)
  assert.deepEqual(parsed.manifest.permissions, [])
})

test('industry automation and approval drafts satisfy their native configuration contracts', () => {
  const automations = records.filter(record => record.table === 'automations')
  assert.equal(automations.length, 3)
  for (const automation of automations) {
    assert.ok(parseAutomationTrigger(automation.values.trigger))
    assert.ok(parseAutomationActions(automation.values.actions).length)
  }
  for (const flow of records.filter(record => record.table === 'flows')) assert.ok(automationGraphSchema.parse(flow.values.graph))
})
