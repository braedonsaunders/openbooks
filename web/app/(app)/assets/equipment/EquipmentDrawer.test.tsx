import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t07-006: activating a draft unit without a charge item 422s with
// `charge_item_required`, but the drawer toasted a reason-less
// "Could not save equipment" and left no trace on the record. The refused
// activation must pin the server's reason on the record (until the next
// save) and point at the Charge item field.
const drawerSource = readFileSync(new URL('./EquipmentDrawer.tsx', import.meta.url), 'utf8')

const saveFn = drawerSource.slice(drawerSource.indexOf('async function save('))

test('a refused equipment save pins its reason on the record instead of only toasting', () => {
  assert.match(drawerSource, /const \[saveError, setSaveError\] = useState<string \| null>\(null\)/)
  assert.match(saveFn, /setSaveError\(null\)/)
  assert.match(drawerSource, /<p role="alert"[\s\S]*?\{saveError/)
})

test('a missing charge item at activation names the typed reason, not the generic failure', () => {
  assert.match(saveFn, /charge_item_required/)
  assert.match(saveFn, /t\('chargeItemRequired'\)/)
  assert.match(saveFn, /res\.json\(\)/)
})

test('the charge-item refusal flags the Charge item field', () => {
  assert.match(drawerSource, /saveErrorCode/)
  assert.match(drawerSource, /charge_item_required/)
})
