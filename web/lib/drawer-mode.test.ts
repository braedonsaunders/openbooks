import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { initialDrawerMode } from './drawer-mode.ts'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('new editable transactions may open in edit mode', () => {
  assert.equal(initialDrawerMode('edit', true), 'edit')
})

test('edit intent cannot override lifecycle or permission enforcement', () => {
  assert.equal(initialDrawerMode('edit', false), 'view')
  assert.equal(initialDrawerMode('view', true), 'view')
  assert.equal(initialDrawerMode(undefined, true), 'view')
})

test('new record creation entry points carry explicit edit intent', () => {
  const creationSources = [
    source('components/new-document-button.tsx'),
    source('components/global-create-menu.tsx'),
    source('app/(app)/_order/NewOrderButton.tsx'),
    source('app/(app)/_order/NewOrderRedirect.tsx'),
    source('app/(app)/payments/NewPaymentButton.tsx'),
    source('app/(app)/expenses/NewExpenseButton.tsx'),
    source('app/(app)/journal/NewJournalButton.tsx'),
    source('app/(app)/ap/capture/CaptureReviewDrawer.tsx'),
    source('app/(app)/crm/OpportunityDrawer.tsx'),
    source('app/(app)/projects/tabs/BillingSection.tsx'),
  ]

  for (const creationSource of creationSources) {
    assert.match(creationSource, /mode=edit/)
  }
})

// The Parties/Projects slice opens unsaved-create drawers (?partyNew=1 /
// ?projectNew=1) instead of persisted drafts, so its entry points carry no
// mode=edit param — the marker IS the intent, and the drawers start in edit
// mode through createMode. Same property (creation opens editable), carried
// end to end: entry marker, loader create mode, drawer edit default.
test('unsaved-create entry points open editable drawers through createMode', () => {
  for (const entry of [
    source('app/(app)/parties/NewPartyButton.tsx'),
    source('app/(app)/parties/NewPartyRedirect.tsx'),
    source('app/(app)/projects/NewProjectButton.tsx'),
    source('app/(app)/projects/NewProjectRedirect.tsx'),
  ]) {
    assert.match(entry, /partyNew: '1'|projectNew: '1'/)
  }
  assert.match(
    source('app/(app)/parties/PartyDrawer.tsx'),
    /createMode \? 'edit' : initialDrawerMode\(/,
  )
  assert.match(
    source('app/(app)/projects/ProjectDrawer.tsx'),
    /useState<'view' \| 'edit'>\(createMode \? 'edit' : 'view'\)/,
  )
})
