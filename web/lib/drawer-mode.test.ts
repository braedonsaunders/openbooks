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
    // The shared document kinds carry the intent one level in: the button is
    // URL-only and every href it can build comes from documentCreateHref,
    // which appends mode=edit for exactly the creatable kinds.
    source('lib/document-kinds.ts'),
    source('components/global-create-menu.tsx'),
    // NewOrderButton keeps a legacy instant-into-draft branch (mode=edit)
    // for the field-tickets caller until its own slice migrates it; the
    // three order kinds take the URL-only createParam branch above.
    source('app/(app)/_order/NewOrderButton.tsx'),
    source('app/(app)/expenses/NewExpenseButton.tsx'),
    source('app/(app)/ap/capture/CaptureReviewDrawer.tsx'),
    source('app/(app)/crm/OpportunityDrawer.tsx'),
    source('app/(app)/projects/tabs/BillingSection.tsx'),
  ]

  for (const creationSource of creationSources) {
    assert.match(creationSource, /mode=edit/)
  }
  // The button itself must not hand-roll a href: routing through the shared
  // builder is what keeps its intent (and its kind refusal) honest.
  assert.match(source('components/new-document-button.tsx'), /documentCreateHref\(/)
})

// The Parties/Projects/Orders slices open unsaved-create drawers
// (?partyNew=1 / ?projectNew=1 / ?estimateNew=1 / ?orderNew=1) instead of
// persisted drafts, so their entry points carry no mode=edit param — the
// marker IS the intent, and the drawers start in edit mode through
// createMode. Same property (creation opens editable), carried end to end:
// entry marker, loader create mode, drawer edit default.
test('unsaved-create entry points open editable drawers through createMode', () => {
  for (const entry of [
    source('app/(app)/parties/NewPartyButton.tsx'),
    source('app/(app)/parties/NewPartyRedirect.tsx'),
    source('app/(app)/projects/NewProjectButton.tsx'),
    source('app/(app)/projects/NewProjectRedirect.tsx'),
    source('app/(app)/_order/NewOrderButton.tsx'),
    source('app/(app)/_order/NewOrderRedirect.tsx'),
    source('app/(app)/payments/NewPaymentButton.tsx'),
    source('app/(app)/journal/NewJournalButton.tsx'),
  ]) {
    assert.match(
      entry,
      /partyNew: '1'|projectNew: '1'|paymentNew: '1'|entryNew: '1'|\[createParam!?\]: '1'/,
    )
  }
  assert.match(
    source('app/(app)/parties/PartyDrawer.tsx'),
    /createMode \? 'edit' : initialDrawerMode\(/,
  )
  assert.match(
    source('app/(app)/projects/ProjectDrawer.tsx'),
    /useState<'view' \| 'edit'>\(createMode \? 'edit' : 'view'\)/,
  )
  // Orders reuse the one OrderDrawer: createMode switches it onto the
  // in-memory payload (recordId 'new', no evidence tabs) and routes close
  // through the list href with zero writes.
  assert.match(source('app/(app)/_order/OrderDrawer.tsx'), /createMode\?: boolean/)
  assert.match(source('app/(app)/_order/OrderDrawer.tsx'), /recordId=\{createMode \? 'new' : String\(doc\.id\)\}/)
  assert.match(source('app/(app)/_order/OrderDrawer.tsx'), /closeHref=\{closeHref \?\? meta\.base\}/)
})
