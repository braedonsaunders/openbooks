import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t07-006: activating a draft unit without a charge item 422s with
// `charge_item_required`, but the drawer toasted a reason-less
// "Could not save equipment" and left no trace on the record. The refused
// activation must pin the server's reason on the record (until the next
// save) and point at the Charge item field.
// Fleet-8 m1: the pin moved onto the shared action path (useAppAction +
// ActionAlert) — same contract, render-proved in
// equipment-drawer-refusal.test.tsx.
const drawerSource = readFileSync(new URL('./EquipmentDrawer.tsx', import.meta.url), 'utf8')

const saveFn = drawerSource.slice(drawerSource.indexOf('async function save('))

test('a refused equipment save pins its reason on the record instead of only toasting', () => {
  assert.match(
    drawerSource,
    /const \{ busy, refusal, execute, clearRefusal \} = useAppAction\(\)/,
    'a refused save must pin into the shared refusal state: toasts alone expire and the finding shows the failure reads as silent',
  )
  assert.match(
    saveFn,
    /await execute\(/,
    'save() must run through the shared action path, which pins the refusal until the next action AND toasts it',
  )
  assert.match(
    drawerSource,
    /<ActionAlert error=\{refusal\}/,
    'the pinned refusal must render as a persistent alert on the record',
  )
  assert.doesNotMatch(
    drawerSource,
    /setSaveError/,
    'the hand-rolled save-error state must stay retired',
  )
})

test('a missing charge item at activation names the typed reason, not the generic failure', () => {
  assert.match(
    saveFn,
    /charge_item_required/,
    'save() must branch on the typed charge-item code: the API names the blocker as a stable code at activation',
  )
  assert.match(
    saveFn,
    /t\('chargeItemRequired'\)/,
    'the charge-item branch must surface its translated reason, not the generic failure',
  )
  assert.match(
    saveFn,
    /new ActionError\(\{ kind: 'refused', code:.*serverMessage: t\('chargeItemRequired'\)/,
    'the translated reason must ride as the refusal server message so pin and toast agree, never the raw code',
  )
  assert.match(
    saveFn,
    /fetchAction\(/,
    'save() must read through the never-throwing shared fetch instead of a bare res.json()',
  )
  assert.doesNotMatch(
    saveFn,
    /res\.json\(\)/,
    'a bare res.json() throws past the toast on a non-JSON refusal and must stay retired',
  )
})

test('the charge-item refusal flags the Charge item field', () => {
  assert.match(
    drawerSource,
    /refusal\?\.code === 'charge_item_required'/,
    'the Charge item field must flag straight from the pinned refusal code, which names no remedy on its own',
  )
  assert.match(
    drawerSource,
    /charge_item_required/,
    'the field flag must key off the stable charge-item code',
  )
  assert.doesNotMatch(
    drawerSource,
    /saveErrorCode/,
    'the hand-rolled field-flag state must stay retired',
  )
})
