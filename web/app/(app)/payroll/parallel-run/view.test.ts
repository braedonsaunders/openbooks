import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state = {
  authz: {
    user: { orgId: 'org-visible', id: 'actor-visible' },
    allowedSubsidiaryIds: null as Set<string> | null,
  },
  readCalls: [] as string[],
}
const key = Symbol.for('openbooks.parallel-run-view-scope')
Object.assign(globalThis, { [key]: state })

registerHooks({
  resolve(specifier, context, next) {
    const parent = decodeURIComponent(context.parentURL ?? '')
    const virtual = (source: string) => ({
      shortCircuit: true,
      url: `data:text/javascript,${encodeURIComponent(source)}`,
    })
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual("export function notFound(){throw new Error('NEXT_NOT_FOUND')}")
    if (specifier === 'next-intl/server') {
      return virtual("export async function getTranslations(){return {has:()=>false}}")
    }
    if (parent.endsWith('/payroll/parallel-run/view.ts')) {
      if (specifier.endsWith('/lib/authz')) {
        return virtual(`
          export async function requirePermission(){return globalThis[Symbol.for('openbooks.parallel-run-view-scope')].authz}
          export function can(){return true}
          export async function guardRootSubsidiaryScope(authz){return authz.allowedSubsidiaryIds === null ? null : {status:404}}
        `)
      }
      if (specifier.endsWith('/lib/feature-gates')) {
        return virtual('export async function requireFeatureEnabled(){}')
      }
      if (specifier.endsWith('/module-home/group-tabs')) {
        return virtual('export async function groupTabs(){return []}')
      }
      if (specifier === '@openbooks/engine/src/payroll/parallel-run-store.ts') {
        return virtual(`
          const visible = (scope) => scope?.allowedSubsidiaryIds === null || scope?.allowedSubsidiaryIds?.has('sub-visible')
          const row = (scope) => [{id: visible(scope) ? 'VISIBLE' : 'HIDDEN'}]
          const calls = globalThis[Symbol.for('openbooks.parallel-run-view-scope')].readCalls
          export async function priorRegisters(_org, scope){calls.push('registers');return row({allowedSubsidiaryIds:scope})}
          export async function comparablePayRuns(_org, scope){calls.push('runs');return row({allowedSubsidiaryIds:scope}).map(r=>({documentId:r.id}))}
          export async function parallelComparisons(_org, options){calls.push('comparisons');return row(options)}
          export async function parallelTolerances(){calls.push('tolerances');return []}
          export async function comparableSlots(){calls.push('slots');return []}
        `)
      }
    }
    if (specifier.startsWith('@/')) {
      const path = root + 'web/' + specifier.slice(2)
      return next(path, context)
    }
    return next(specifier, context)
  },
})

const { loadParallelRun } = await import('./view.ts')

test('parallel-run page loader scopes every server-rendered payroll dataset', async () => {
  state.readCalls.length = 0
  const data = await loadParallelRun()
  assert.deepEqual(data.workspace.registers.map((row) => row.id), ['VISIBLE'])
  assert.deepEqual(data.workspace.runs.map((row) => row.documentId), ['VISIBLE'])
  assert.deepEqual(data.workspace.comparisons.map((row) => row.id), ['VISIBLE'])
  assert.deepEqual(state.readCalls, ['registers', 'runs', 'comparisons', 'tolerances', 'slots'])
})

test('parallel-run page refuses subsidiary-restricted readers before loading org-wide tolerances', async () => {
  state.authz.allowedSubsidiaryIds = new Set(['sub-visible'])
  state.readCalls.length = 0
  await assert.rejects(loadParallelRun(), /NEXT_NOT_FOUND/)
  assert.deepEqual(state.readCalls, [])
  state.authz.allowedSubsidiaryIds = null
})
