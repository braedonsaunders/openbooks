import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    return nextResolve(specifier, context)
  },
})

const React = await import('react')
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const { restoreFailedBudgetCells } = await import('../app/(app)/budgets/BudgetDrawer.tsx')
const drawerSource = readFileSync(new URL('../app/(app)/budgets/BudgetDrawer.tsx', import.meta.url), 'utf8')

test('failed budget saves do not restore a cell superseded while the request was pending', () => {
  const key = 'account-1|period-1'
  const stale = { accountId: 'account-1', periodId: 'period-1', amount: '10.0000' }
  const latest = { accountId: 'account-1', periodId: 'period-1', amount: '20.0000' }

  assert.deepEqual(
    restoreFailedBudgetCells([{ key, cell: stale, version: 1 }], new Map([[key, 2]])),
    [],
    'a failed request must not put stale data back over a newer queued edit',
  )

  assert.deepEqual(
    restoreFailedBudgetCells([{ key, cell: latest, version: 2 }], new Map([[key, 2]])),
    [latest],
    'a failed request still retries its cell when no newer edit exists',
  )
  assert.match(drawerSource, /restoreFailedBudgetCells\(pending, pendingVersionsRef\.current\)/)
})
