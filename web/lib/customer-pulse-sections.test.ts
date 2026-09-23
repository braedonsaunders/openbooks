import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { pulseSectionsFor } = await import('./customer-pulse.ts')

/**
 * The pulse is a combined payload: no single read permission unlocks all of
 * it. A CRM-only salesperson sees pipeline/activity but no AR figures; an
 * AR-only clerk sees receivables but no pipeline; projects read on its own
 * still opens the delivery rollup. Nobody with zero reads gets in.
 */
test('pulseSectionsFor maps each permission to its own section', () => {
  const crmOnly = pulseSectionsFor((p) => p === 'crm.accounts.read')
  assert.deepEqual(crmOnly, { ar: false, crm: true, projects: false })

  const arOnly = pulseSectionsFor((p) => p === 'ar.read')
  assert.deepEqual(arOnly, { ar: true, crm: false, projects: false })

  const projectsOnly = pulseSectionsFor((p) => p === 'projects.read')
  assert.deepEqual(projectsOnly, { ar: false, crm: false, projects: true })
})

test('pulseSectionsFor grants everything to a fully permissioned caller', () => {
  const both = pulseSectionsFor(
    (p) => p === 'crm.accounts.read' || p === 'ar.read' || p === 'projects.read',
  )
  assert.deepEqual(both, { ar: true, crm: true, projects: true })
})

test('pulseSectionsFor refuses callers with none of the reads', () => {
  assert.equal(pulseSectionsFor(() => false), null)
})

test('pulseSectionsFor honors wildcard grants', () => {
  const admin = pulseSectionsFor(() => true)
  assert.deepEqual(admin, { ar: true, crm: true, projects: true })
})
