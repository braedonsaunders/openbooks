import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/items/item-1' })
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'self']) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) {
    ;(globalThis as Record<string, unknown>)[key] = domWindow[key]
  }
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: true, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}
if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== 'function') {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const virtual = (source: string) => ({ shortCircuit: true as const, url: `data:text/javascript,${encodeURIComponent(source)}` })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next-intl') return virtual('export function useTranslations() { return (key) => key }')
    if (specifier === 'sonner') return virtual('export const toast = { success() {}, error() {} }')
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')

// F-t09-002: the costing form must refuse — inline, before any submit — an
// account combination the PUT route is known to reject with 422 (any offset
// account equal to the inventory asset account). A transient toast after a
// failed save is not a substitute for inline validation.
const { ItemCostingEditor, costingOffsetConflicts, validateConversionRows } = await import('./ItemCostingEditor.tsx')

const ASSET = '11111111-1111-4111-8111-111111111111'
const COGS = '22222222-2222-4222-8222-222222222222'
const ADJUST = '33333333-3333-4333-8333-333333333333'
const VARIANCE = '44444444-4444-4444-8444-444444444444'
const GRNI = '55555555-5555-4555-8555-555555555555'

function valid() {
  return {
    assetAccountId: ASSET,
    cogsAccountId: COGS,
    adjustmentAccountId: ADJUST,
    varianceAccountId: VARIANCE,
    receivedNotBilledAccountId: GRNI,
  }
}

test('a valid account combination reports no conflicts', () => {
  assert.deepEqual(costingOffsetConflicts(valid()), [])
})

test('an empty optional offset is not a conflict', () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), adjustmentAccountId: '', varianceAccountId: '', receivedNotBilledAccountId: '' }),
    [],
  )
})

test('an adjustment account copying the asset account is a conflict', () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), adjustmentAccountId: ASSET }),
    ['adjustmentAccountId'],
  )
})

test('a variance account copying the COGS-selected asset is a conflict', () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), varianceAccountId: ASSET }),
    ['varianceAccountId'],
  )
})

test('a COGS account equal to the asset account is a conflict', () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), cogsAccountId: ASSET }),
    ['cogsAccountId'],
  )
})

test('a received-not-billed account equal to the asset account is a conflict', () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), receivedNotBilledAccountId: ASSET }),
    ['receivedNotBilledAccountId'],
  )
})

test('the comparison matches the server rule regardless of id casing', () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), adjustmentAccountId: ASSET.toUpperCase() }),
    ['adjustmentAccountId'],
  )
})

// Unit conversions: the form mirrors the server's parseUnitConversions rule
// inline, so a row the PUT would answer 422 never submits.

test('well-formed conversion rows validate clean', () => {
  assert.deepEqual(validateConversionRows([{ unit: 'box', factor: '12' }]), [])
  assert.deepEqual(validateConversionRows([{ unit: 'Each', factor: '1' }, { unit: 'kg', factor: '2.5' }]), [])
  assert.deepEqual(validateConversionRows([]), [])
})

test('a blank unit name is refused', () => {
  assert.deepEqual(validateConversionRows([{ unit: '   ', factor: '12' }]), [
    { index: 0, field: 'unit', code: 'required' },
  ])
})

test('a non-positive or inexact factor is refused', () => {
  for (const factor of ['', '0', '-12', 'abc', '1/3', '0.00001', 'Infinity']) {
    assert.deepEqual(
      validateConversionRows([{ unit: 'box', factor }]),
      [{ index: 0, field: 'factor', code: 'invalid' }],
      `factor ${JSON.stringify(factor)} must be refused`,
    )
  }
})

test('factors the server receives as exact decimals are accepted', () => {
  // ".5" and "12." arrive as the JSON numbers 0.5 and 12 — both exactly
  // representable, so the form must not refuse what the server accepts.
  assert.deepEqual(validateConversionRows([{ unit: 'half', factor: '.5' }]), [])
  assert.deepEqual(validateConversionRows([{ unit: 'dozen', factor: '12.' }]), [])
})

test('a repeated unit under any spelling is refused', () => {
  assert.deepEqual(
    validateConversionRows([
      { unit: 'box', factor: '12' },
      { unit: 'BOX', factor: '12' },
    ]),
    [{ index: 1, field: 'unit', code: 'duplicate' }],
  )
})

async function mountEditor(t: TestContext, accounts: { id: string; number: string; name: string }[] = []) {
  const priorFetch = globalThis.fetch
  const requests: Array<{ method: string; body?: Record<string, unknown> }> = []
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    requests.push({ method, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) })
    return Response.json(method === 'GET' ? { profile: null } : { profile: null })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = priorFetch })
  const root = createRoot(document.body)
  t.after(async () => {
    await act(async () => root.unmount())
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    root.render(React.createElement(ItemCostingEditor, { itemId: 'item-1', kind: 'inventory', accounts, canManage: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const configure = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'configure')
  assert.ok(configure, 'a manager can configure the loaded costing profile')
  await act(async () => configure.click())
  return requests
}

async function chooseAccount(label: string) {
  const trigger = [...document.querySelectorAll('button[aria-haspopup="listbox"]')].find((button) => button.getAttribute('aria-label') === label) as HTMLButtonElement | undefined
  assert.ok(trigger, `${label} picker renders`)
  await act(async () => trigger.click())
  const option = [...document.querySelectorAll('button[role="option"]')].find((button) => button.textContent?.includes('100 Stock asset')) as HTMLButtonElement | undefined
  assert.ok(option, 'the inventory asset account is selectable')
  await act(async () => option.click())
}

test('an offset equal to the asset account shows an inline refusal without submitting', async (t) => {
  const requests = await mountEditor(t, [{ id: ASSET, number: '100', name: 'Stock asset' }])
  await chooseAccount('assetAccount')
  await chooseAccount('cogsAccount')
  const save = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'actions.save')
  assert.ok(save, 'the costing form can be submitted')
  await act(async () => save.click())
  assert.deepEqual(requests.map((request) => request.method), ['GET'], 'the invalid account pair never reaches the PUT route')
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /separationConflict/)
})

test('a malformed conversion row is refused inline before the costing PUT', async (t) => {
  const requests = await mountEditor(t)
  const add = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'addConversion')
  assert.ok(add, 'the conversion editor can add a row')
  await act(async () => add.click())
  const unit = document.querySelector('input[aria-label="conversionUnit"]') as HTMLInputElement | null
  const factor = document.querySelector('input[aria-label="conversionFactor"]') as HTMLInputElement | null
  assert.ok(unit)
  assert.ok(factor)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(unit, 'box')
    unit.dispatchEvent(new window.Event('input', { bubbles: true }))
    setter.call(factor, '0')
    factor.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const save = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'actions.save')
  assert.ok(save)
  await act(async () => save.click())
  assert.deepEqual(requests.map((request) => request.method), ['GET'], 'an invalid factor never reaches the PUT route')
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /conversionFactorInvalid|conversionsBlocked/)
})
