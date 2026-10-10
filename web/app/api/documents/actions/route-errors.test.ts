import assert from 'node:assert/strict'
import test from 'node:test'

// A server defect must never reach the user as driver text. The
// failure map is pure (no DB, no session), but the route module drags the

const { toActionFailure } = await import('./action-failure')
const { PostingError } = await import("@openbooks/engine/src/journal/posting-contracts.ts");
const { ControlAccountsIncompleteError } = await import('@openbooks/engine/src/records/control-accounts.ts')
const { PayrollError } = await import('@openbooks/engine/src/payroll/error.ts')
const { InventoryError, InventoryOwnershipError } = await import('@openbooks/engine/src/inventory/contracts.ts')
const { PostingEffectsReplayError } = await import('@openbooks/engine/src/ledger/posting-effects.ts')
const { postingRefusal } = await import('@/lib/api/responses')

test('typed refusals keep their message as a 422', () => {
  for (const error of [
    new PostingError('1000 Cash only accepts CAD postings, not USD'),
    new ControlAccountsIncompleteError('missing control account'),
    new PayrollError('payroll refused'),
    new InventoryError('insufficient stock of FG-100 at MAIN: need 40.0000, on hand 0.0000'),
  ]) {
    const mapped = toActionFailure(error) as { status: number; body: { error?: string } }
    assert.equal(mapped.status, 422)
    assert.equal(mapped.body.error, (error as Error).message)
  }
})

test('a stock movement into another legal entity refuses as an authorization boundary', () => {
  const mapped = toActionFailure(new InventoryOwnershipError('stock location belongs to another legal entity')) as { status: number; body: { error?: string } }
  assert.equal(mapped.status, 403)
  assert.equal(mapped.body.error, 'stock location belongs to another legal entity')
})

test('posting-effect replay refusals keep their message in the shared vocabulary', async () => {
  const response = postingRefusal(new PostingEffectsReplayError('replay reason must be reviewed'))!
  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), {
    error: 'replay reason must be reviewed',
    code: 'posting_effects_replay_refused',
  })
})

test('an unexpected driver failure becomes a stable code with no echo', () => {
  const leakedUuid = '2574cf01-a276-4f77-b4ab-b842f2ac7b90'
  const driver = new Error(
    `Failed query: insert into "journal_lines" ("id", "org_id") values (default, $1) params: ${leakedUuid},12450.0000,USD`,
  )
  const mapped = toActionFailure(driver) as { status: number; body: Record<string, unknown> }
  assert.equal(mapped.status, 500)
  assert.deepEqual(mapped.body, { code: 'internal_error' })
  assert.ok(!JSON.stringify(mapped.body).includes('Failed query'), 'no driver text escapes')
  assert.ok(!JSON.stringify(mapped.body).includes(leakedUuid), 'no internal id escapes')
})
