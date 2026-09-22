import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync('schema/migrations/generated/0244_item_pricing_hierarchy.sql', 'utf8')
const scheduleRoute = readFileSync('web/app/api/items/[id]/prices/route.ts', 'utf8')
const resolver = readFileSync('web/lib/item-pricing.ts', 'utf8')
const editor = readFileSync('web/app/(app)/items/ItemPriceMatrixEditor.tsx', 'utf8')
const orderDrawer = readFileSync('web/app/(app)/_order/OrderDrawer.tsx', 'utf8')

test('pricing schedules have one unambiguous tenant-scoped hierarchy', () => {
  assert.match(migration, /customer_id IS NULL AND price_level_id IS NOT NULL/)
  assert.match(migration, /customer_id IS NOT NULL AND price_level_id IS NULL/)
  assert.match(migration, /FOREIGN KEY \(org_id, item_id\)/)
  assert.match(migration, /FOREIGN KEY \(org_id, price_level_id\)/)
  assert.match(migration, /FOREIGN KEY \(org_id, customer_id\)/)
  assert.match(migration, /item_price_schedule_general_no_overlap/)
  assert.match(migration, /item_price_schedule_customer_no_overlap/)
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g)
  assert.match(migration, /price_level_base_guard/)
  assert.match(migration, /item_price_schedule_level_active_check/)
  assert.doesNotMatch(resolver, /price_level_id is null/)
})

test('schedule creation is idempotent, audited, and refuses changed replays', () => {
  const keyCheck = scheduleRoute.indexOf("request.headers.get('Idempotency-Key')")
  const bodyParse = scheduleRoute.indexOf('parseJsonBody(request, jsonObject)', keyCheck)
  assert.ok(keyCheck >= 0 && keyCheck < bodyParse, 'idempotency identity must be validated before request work')
  assert.match(scheduleRoute, /claimIdempotentCreate/)
  assert.match(scheduleRoute, /resolveIdempotentReplay/)
  assert.match(scheduleRoute, /on conflict \(id\) do nothing/)
  assert.match(scheduleRoute, /requestId[^\n]*\}, tx\)/)
  assert.match(scheduleRoute, /invalid_idempotency_key/)
})

test('matrix editing reuses the shared paged table, line grid, and confirmation UI', () => {
  assert.match(editor, /<PagedTable/)
  assert.match(editor, /<LineGrid/)
  assert.match(editor, /addPlacement="top"/)
  assert.match(editor, /confirmDialog/)
  assert.doesNotMatch(editor, /window\.confirm/)
  const failed = editor.indexOf('if (!response.ok)')
  const parsedError = editor.indexOf('response.json().catch', failed)
  assert.ok(failed >= 0 && failed < parsedError, 'error bodies are parsed only after response status is checked')
})

test('sales lines resolve the hierarchy without overwriting a manual price', () => {
  assert.match(orderDrawer, /fetch\('\/api\/items\/price'/)
  assert.match(orderDrawer, /if \(!response\.ok\) return null/)
  assert.match(orderDrawer, /manuallyChanged/)
  assert.match(orderDrawer, /resolvedPriceRef\.current\.delete\(index\)/)
})
