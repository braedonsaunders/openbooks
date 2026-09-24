import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// IN8: inventory action retries posted twice. The drawer minted a fresh
// crypto.randomUUID() on EVERY submit, so a committed-but-lost response
// followed by Post again sent a NEW key the idempotency boundary could not
// replay — a second movement and journal. The drawer must keep ONE key per
// intended action across transport uncertainty (reused on retry, rotated
// only after success or an input change) and must freeze the posting date in
// the first payload (the server hashes the date into the request, so a retry
// after a midnight rollover with a fresh date would 409).

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/inventory?inventoryView=movements&movement=new',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  // Desktop viewport: the pickers render dropdowns instead of the mobile
  // bottom sheet, so options appear as button[role="option"].
  window.matchMedia = (() => ({
    matches: true,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}
if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== 'function') {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

const script = {
  toasts: [] as Array<{ kind: string; message: string }>,
  fetchBodies: [] as Array<Record<string, unknown>>,
  fetchBehavior: [] as Array<'fail' | 'ok' | 'refuse' | 'malformed-refusal'>,
}
Object.assign(globalThis, {
  __drawerTestToasts: script.toasts,
  __drawerTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__drawerTestRouter}export function usePathname(){return "/inventory"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:p.href,className:p.className},p.children)}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__drawerTestToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__drawerTestToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__drawerTestToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
      }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { BusinessDateProvider } = await import('../../../components/business-date-provider')
const { InventoryActionDrawer } = await import('./InventoryActionDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const ITEM = '11111111-1111-4111-8111-111111111111'
const BIN = '22222222-2222-4222-8222-222222222222'
const ACCT = '33333333-3333-4333-8333-333333333333'

async function mountDrawer(t: TestContext): Promise<void> {
  const prior = globalThis.fetch
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    script.fetchBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    const behavior = script.fetchBehavior.shift() ?? 'ok'
    if (behavior === 'fail') throw new TypeError('fetch failed')
    if (behavior === 'refuse') return Response.json({ error: 'Posting period is not open' }, { status: 409 })
    if (behavior === 'malformed-refusal') return new Response('<html>not json</html>', { status: 409 })
    return Response.json({ ok: true, replayed: script.fetchBodies.length > 1, value: '5' })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  script.toasts.length = 0
  script.fetchBodies.length = 0
  script.fetchBehavior.length = 0
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-23">
          <InventoryActionDrawer
            items={[{ id: ITEM, code: 'W-1', name: 'Widget' }]}
            stockLocations={[{ id: BIN, code: 'BIN-1' }]}
            accounts={[{ id: ACCT, number: '1400', name: 'Clearing' }]}
          />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
    await tick()
  })
}

function triggersNamed(label: string): HTMLButtonElement[] {
  return [...document.querySelectorAll('button[aria-haspopup="listbox"]')].filter(
    (b) => b.getAttribute('aria-label') === label,
  ) as HTMLButtonElement[]
}

async function pickOption(triggerLabel: string, optionText: string) {
  const trigger = triggersNamed(triggerLabel)[0]
  assert.ok(trigger, `a ${triggerLabel} picker must exist`)
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
  const option = [...document.querySelectorAll('button[role="option"]')].find((b) =>
    (b.textContent ?? '').includes(optionText),
  ) as HTMLElement | undefined
  assert.ok(option, `option ${optionText} must be offered`)
  await act(async () => {
    option.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

async function fillReceive(): Promise<void> {
  await pickOption('Item', 'W-1')
  await pickOption('Location', 'BIN-1')
  const decimalInputs = [...document.querySelectorAll('input[inputmode="decimal"]')] as HTMLInputElement[]
  assert.ok(decimalInputs.length >= 2, 'quantity and unit-cost inputs must render for a receipt')
  await act(async () => {
    setInputValue(decimalInputs[0]!, '5')
    setInputValue(decimalInputs[1]!, '10')
    await tick()
  })
  await tick()
  await pickOption('Offset account', 'Clearing')
}

async function clickPost() {
  const button = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === 'Post',
  ) as HTMLButtonElement | undefined
  assert.ok(button, 'a Post button must exist')
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  await tick()
}

test('a lost Post response retried with unchanged fields reuses one key and the frozen date', async (t) => {
  await mountDrawer(t)
  await fillReceive()
  // First Post commits server-side but the response is lost in transport.
  script.fetchBehavior.push('fail', 'ok')
  await clickPost()
  assert.equal(script.fetchBodies.length, 1, 'the first Post must fire exactly one request')
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'error'),
    'the lost response must surface, not read as silence',
  )
  // Operator presses Post again with unchanged fields: the retry must carry
  // the SAME key and the SAME frozen business date so the server replays the
  // committed posting instead of minting a second movement and journal.
  await clickPost()
  assert.equal(script.fetchBodies.length, 2, 'the retry must fire exactly one more request')
  const [first, retry] = script.fetchBodies as Array<{ idempotencyKey: string; date: string }>
  assert.ok(first!.idempotencyKey, 'the first Post must carry a retry identity')
  assert.equal(retry!.idempotencyKey, first!.idempotencyKey, 'the retry must reuse the action key, not mint a new one')
  assert.equal(first!.date, '2026-09-23', 'the first Post must freeze the server business day, not omit it')
  assert.equal(retry!.date, '2026-09-23', 'the retry must replay the frozen date even after a midnight rollover')
})

test('changing the inputs after a failure rotates the retry identity', async (t) => {
  await mountDrawer(t)
  await fillReceive()
  script.fetchBehavior.push('fail', 'fail')
  await clickPost()
  await clickPost()
  const [first, retrySame] = script.fetchBodies as Array<{ idempotencyKey: string }>
  assert.equal(retrySame!.idempotencyKey, first!.idempotencyKey, 'unchanged retry keeps the key (guard)')
  // New intended action after an input change: a reused key with different
  // input would 409, so the drawer must rotate.
  const decimalInputs = [...document.querySelectorAll('input[inputmode="decimal"]')] as HTMLInputElement[]
  await act(async () => {
    setInputValue(decimalInputs[0]!, '6')
    await tick()
  })
  await tick()
  await clickPost()
  assert.equal(script.fetchBodies.length, 3)
  const third = script.fetchBodies[2] as { idempotencyKey: string }
  assert.notEqual(third!.idempotencyKey, first!.idempotencyKey, 'an input change must rotate the retry identity')
})

test('a server refusal stays attached to the movement until the next Post', async (t) => {
  await mountDrawer(t)
  await fillReceive()
  script.fetchBehavior.push('refuse')
  await clickPost()

  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Movement failed: Posting period is not open/)
  assert.deepEqual(script.toasts, [{ kind: 'error', message: 'Posting period is not open' }])
  assert.equal(
    [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Post')?.disabled,
    false,
    'the refusal must release Post so the operator can correct the problem',
  )
})

test('a non-JSON refusal shows the ordinary movement error instead of leaving Post stuck', async (t) => {
  await mountDrawer(t)
  await fillReceive()
  script.fetchBehavior.push('malformed-refusal')
  await clickPost()

  assert.equal(document.querySelector('[role="alert"]')?.textContent?.trim(), 'Movement failed')
  assert.equal(
    [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Post')?.disabled,
    false,
  )
})
