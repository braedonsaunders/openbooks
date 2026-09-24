import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrialBalanceData } from './view'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    // Platform boundary, not our own module: lets the unit partition import
    // the pure spec builder without a Next server runtime.
    if (specifier === 'server-only') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default {}',
      }
    }
    return next(specifier, context)
  },
})

const { trialBalanceSpec } = await import('./view')

// F-t06-025: enabling Multi-subsidiary crashed the trial balance with React
// error 441 — the loader converts the typed rates refusal into a banner with
// a derive link instead of throwing it out of SSR. These tests pin the spec
// half of that contract: given blocked data, the page shows the banner and
// hides the paper. (The loader half needs a database and has no unit
// interface. The banner copy in every locale is covered by
// web/lib/rates-blocked-copy.test.ts.)
function blockedData(): TrialBalanceData {
  return {
    ratesBlocked: {
      code: 'rates-not-derived',
      title: 'Rates have not been derived',
      description: 'No consolidated exchange rates for EUR for March 2026.',
      deriveLabel: 'Derive rates',
      deriveHref: '/close',
    },
    ratesReady: false,
  } as unknown as TrialBalanceData
}

function blocksOf(spec: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node === 'object' && node !== null) {
      found.push(node as Record<string, unknown>)
      for (const value of Object.values(node)) visit(value)
    }
  }
  visit((spec as { body: unknown }).body)
  return found
}

test('a rates refusal renders as a derive banner gated on the block', () => {
  const blocks = blocksOf(trialBalanceSpec(blockedData()))
  const banner = blocks.find((block) => block.widget === 'empty-state')
  assert.ok(banner, 'the blocked statement must render an empty-state banner')
  assert.deepEqual(banner.when, { $: 'ratesBlocked' }, 'the banner shows exactly while the notice is set')
  const props = banner.props as Record<string, unknown>
  assert.equal(props.title, 'Rates have not been derived')
  assert.equal(props.description, 'No consolidated exchange rates for EUR for March 2026.')
  assert.equal(props.action, 'link-button')
  const actionProps = props.actionProps as Record<string, unknown>
  assert.equal(actionProps.href, '/close', 'the banner must link to period close to derive rates')
  assert.equal(actionProps.label, 'Derive rates')
})

test('the paper hides while rates are blocked', () => {
  const blocks = blocksOf(trialBalanceSpec(blockedData()))
  const paper = blocks.find((block) => block.widget === 'paper-view')
  assert.ok(paper, 'the statement paper must still be in the spec')
  assert.deepEqual(
    paper.when,
    { $: 'ratesReady' },
    'the paper shows only when rates are ready — no numbers beside the banner',
  )
})
