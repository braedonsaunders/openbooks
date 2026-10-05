import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import React from 'react'
import { stubModules } from '../../../../testing/stub-modules'

stubModules({ intl: true })
Object.assign(globalThis, { React })
const { ContractCostError } = await import('@openbooks/engine/revenue')
Object.assign(globalThis, { __costPageRefusal: null as unknown })
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './view' && context.parentURL?.endsWith('/revenue/contract-costs/page.tsx')) {
      return {
        shortCircuit: true,
        url:
          'data:text/javascript,' +
          encodeURIComponent(
            'export async function loadContractCosts(){ throw globalThis.__costPageRefusal }' +
              'export function contractCostsSpec(){ return null }',
          ),
      }
    }
    if (specifier.endsWith('/components/viewspec/module-view')) {
      return { shortCircuit: true, url: 'data:text/javascript,export function ModuleView(){return null}' }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url:
          'data:text/javascript,' +
          encodeURIComponent(
            'export default function Link(p){return globalThis.React.createElement("a",{href:p.href},p.children)}',
          ),
      }
    }
    if (specifier.endsWith('.module.css')) {
      return {
        shortCircuit: true,
        url:
          'data:text/javascript,' +
          encodeURIComponent('export default new Proxy({},{get:(t,p)=>String(p)})'),
      }
    }
    if (specifier === 'server-only' || specifier.endsWith('.css')) {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    return next(specifier, context)
  },
})
const { default: ContractCostsPage } = await import('./page')
test.after(() => hooks.deregister())

/**
 * The raised refusal must survive the page boundary: a named BHD
 * precision failure renders its message and remedy in the page body
 * instead of falling through to the generic error boundary, which
 * strips server copy.
 */
test('a named currency refusal renders its message and remedy in the page body', async () => {
  globalThis.__costPageRefusal = new ContractCostError(
    'Currency BHD has an unsupported precision 5.',
    {
      code: 'contract_cost_currency_exponent',
      remedy:
        'When the code is a supported ISO currency, restore its row with the canonical registry seed ' +
        '(seedCurrencies), which restores its precision without changing posted history; ' +
        'for a legacy code the seed does not carry, review the original-currency evidence ' +
        'without reinterpreting posted costs.',
    },
  )
  const body = (await ContractCostsPage({ searchParams: Promise.resolve({}) })) as {
    props: { title?: unknown; description?: unknown }
  }
  assert.match(String(body.props.title), /Currency BHD has an unsupported precision/)
  assert.match(String(body.props.description), /seedCurrencies/)
  assert.match(String(body.props.description), /original-currency evidence/)
})
