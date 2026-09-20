import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// F-t06-002: a server defect must never reach the user as driver text. The
// failure map is pure (no DB, no session), but the route module drags the
// server graph, so this file stubs server-only like its integration sibling.
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export {}',
      }
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})

const { toActionFailure } = await import('./action-failure')
const { PostingError } = await import('@openbooks/engine/src/ledger/posting.ts')
const { ControlAccountsIncompleteError } = await import('@openbooks/engine/src/records/control-accounts.ts')
const { PayrollError } = await import('@openbooks/engine/src/payroll/error.ts')

test('typed refusals keep their message as a 422', () => {
  for (const error of [
    new PostingError('1000 Cash only accepts CAD postings, not USD'),
    new ControlAccountsIncompleteError('missing control account'),
    new PayrollError('payroll refused'),
  ]) {
    const mapped = toActionFailure(error) as { status: number; body: { error?: string } }
    assert.equal(mapped.status, 422)
    assert.equal(mapped.body.error, (error as Error).message)
  }
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
