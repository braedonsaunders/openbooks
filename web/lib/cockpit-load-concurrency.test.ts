import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const scope = new Set(['subsidiary-visible'])
let releaseConfig: (value: { weeklyApCap: string; restrictToSafe: number }) => void
const state = {
  config: Promise.resolve({ weeklyApCap: '0.0000', restrictToSafe: 0 }),
  events: [] as string[],
  positionArgs: [] as unknown[],
  scope,
}
Object.assign(globalThis, { __cockpitLoadTest: state })
registerHooks({
  resolve(specifier, context, next) {
    if (!/\/web\/app\/\(app\)\/(ar|ap)\/view\.ts$/.test(context.parentURL ?? '')) return next(specifier, context)
    const mocks: Record<string, string> = {
      'next-intl/server': 'export async function getLocale(){return "fr"}export async function getTranslations(){return key=>key}',
      '../../../lib/authz': 'export async function requirePermission(){return {user:{orgId:"org-visible"},allowedSubsidiaryIds:globalThis.__cockpitLoadTest.scope}}export function can(){return true}',
      '../../../lib/analytics/config': 'export async function analyticsConfig(){globalThis.__cockpitLoadTest.events.push("configuration");return globalThis.__cockpitLoadTest.config}',
      '../../../components/module-home/group-tabs': 'async function tabs(){globalThis.__cockpitLoadTest.events.push("tabs");return []}export const customerGroupTabs=tabs;export const groupTabs=tabs',
      '../../../lib/cash/ar-position': 'export async function arPosition(...args){globalThis.__cockpitLoadTest.events.push("position");globalThis.__cockpitLoadTest.positionArgs=args;return {weeks:[],timeline:[],worklist:[]}}',
      '../../../lib/cash/ap-position': 'export async function apPosition(...args){globalThis.__cockpitLoadTest.events.push("position");globalThis.__cockpitLoadTest.positionArgs=args;return {weeks:[],timeline:[]}}',
    }
    if (mocks[specifier]) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]) }
    return next(specifier, context)
  },
})
const { loadArCockpit } = await import('../app/(app)/ar/view')
const { loadApCockpit } = await import('../app/(app)/ap/view')

for (const [name, load] of [['AR', loadArCockpit], ['AP', loadApCockpit]] as const) {
  test(`${name} navigation reads run alongside configuration without changing forecast scope`, async () => {
    state.events = []
    state.positionArgs = []
    state.config = new Promise((resolve) => { releaseConfig = resolve })
    const pending = load()
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(state.events, ['configuration', 'tabs'], 'navigation must not wait for configuration or forecasting')
    } finally {
      releaseConfig!({ weeklyApCap: '1234.5678', restrictToSafe: 1 })
    }
    await pending
    assert.deepEqual(state.events, ['configuration', 'tabs', 'position'])
    assert.deepEqual(state.positionArgs, ['org-visible', 4, { weeklyCap: '1234.5678', restrictToSafe: true }, undefined, scope, 'fr'])
  })
}
