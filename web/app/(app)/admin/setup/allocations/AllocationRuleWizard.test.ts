import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const wizardSource = readFileSync(fileURLToPath(new URL('./AllocationRuleWizard.tsx', import.meta.url)), 'utf8')
const drawerSource = readFileSync(fileURLToPath(new URL('./RuleDrawer.tsx', import.meta.url)), 'utf8')

test('new-rule create is the house WizardShell, not a second stepper', () => {
  assert.match(wizardSource, /<WizardShell/)
  assert.match(wizardSource, /testId="allocation-rule-wizard"/)
  assert.match(drawerSource, /<AllocationRuleWizard/)
  assert.ok(!wizardSource.includes('<UrlDrawer'), 'create is the full-screen shell, not a skinny drawer')
})

test('wizard walks when / source / split / targets / policy / review', () => {
  for (const step of ['when', 'source', 'split', 'targets', 'policy', 'review']) {
    assert.ok(wizardSource.includes(`step === '${step}'`), `${step} step must render`)
  }
  assert.match(wizardSource, /wizard\.when\.entry\.title/)
  assert.match(wizardSource, /wizard\.when\.period\.title/)
  assert.match(wizardSource, /wizard\.when\.post\.title/)
  assert.match(wizardSource, /wizard\.split\.ratio\.title/)
  assert.match(wizardSource, /wizard\.split\.driver\.title/)
})

test('wizard writes through the existing rule APIs then opens the editor', () => {
  for (const fragment of [
    '/api/allocations/rules',
    '/versions/${',
    '/targets',
    '/publish',
    '/api/allocations/options',
    '/api/allocations/drivers',
    'hrefWithRule',
  ]) {
    assert.ok(wizardSource.includes(fragment), `${fragment} must be wired`)
  }
  assert.match(wizardSource, /definitionPayload/)
  assert.match(wizardSource, /wizardTargetPayload/)
  assert.match(wizardSource, /wizardDefinitionForm/)
})

test('wizard copy is catalogued and never interpolated as a key', () => {
  assert.ok(!/t\(`[^`]*\$\{/.test(wizardSource), 'no dynamic i18n keys')
  assert.ok(wizardSource.includes('transactionTypes.vendorBill'), 'transaction types reuse common.*')
  assert.ok(wizardSource.includes('transactionTypes.journal'), 'journals are a first-class type')
})
