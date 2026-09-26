import assert from 'node:assert/strict'
import test from 'node:test'

// F1T-2 (runNow parsed the body before checking the status, toasted
// data.error ?? runFailed, and left the button stuck on Running when fetch
// itself rejected): the status is checked first through the shared helper,
// the server's named refusal wins, and busy always releases.
const { bootJsdomEnvironment } = await import('../../../../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/reports/custom/run/def-1/delivery' })

declare global {
  var __deliveryToasts: { kind: string; message: string }[] | undefined
  var __deliveryRefreshes: number | undefined
}

Object.assign(globalThis, {
  __deliveryToasts: [] as { kind: string; message: string }[],
  __deliveryRefreshes: 0,
  __deliveryTestRouter: {
    push() {},
    refresh() {
      globalThis.__deliveryRefreshes = (globalThis.__deliveryRefreshes ?? 0) + 1
    },
    replace() {},
    back() {},
    prefetch() {},
  },
})
const { stubModules } = await import('../../../../../../../testing/stub-modules')
stubModules({
  navigation:
    'export function useRouter(){return globalThis.__deliveryTestRouter}export function usePathname(){return "/"}export function useSearchParams(){return new URLSearchParams()}',
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      "export const toast={success(m){(globalThis.__deliveryToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__deliveryToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../../../messages/en')).default
const { DeliveryPanel } = await import('./DeliveryPanel')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount(runImpl: () => Promise<Response>) {
  ;(globalThis as Record<string, unknown>).__deliveryToasts = []
  ;(globalThis as Record<string, unknown>).__deliveryRefreshes = 0
  globalThis.fetch = (async () => runImpl()) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <DeliveryPanel definitionId="def-1" schedules={[]} recentRuns={[]} canSchedule={false} />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  return { host, root }
}

function runNowButton(host: Element): HTMLButtonElement {
  const btn = [...host.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === 'Run now',
  ) as HTMLButtonElement | undefined
  assert.ok(btn, 'the panel must offer Run now')
  return btn
}

async function clickRun(btn: HTMLButtonElement) {
  await act(async () => {
    btn.click()
    await tick()
    await tick()
    await tick()
  })
}

function errors(): string[] {
  return (globalThis.__deliveryToasts ?? []).filter((t) => t.kind === 'error').map((t) => t.message)
}

test('a non-JSON 500 names the failure and releases the button (F1T-2)', async (t) => {
  const { host, root } = await mount(async () => new Response('', { status: 500 }))
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const btn = runNowButton(host)
  await clickRun(btn)
  assert.match(errors().join('\n'), /Report run failed \(status 500\)/)
  assert.equal(btn.disabled, false, 'busy releases after the failure')
})

test('a named 422 surfaces the server refusal (F1T-2)', async (t) => {
  const { host, root } = await mount(async () => Response.json({ error: 'not a query report' }, { status: 422 }))
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await clickRun(runNowButton(host))
  assert.ok(errors().some((m) => m.includes('not a query report')), 'the toast carries the named refusal')
})

test('a successful run toasts completion and refreshes (F1T-2)', async (t) => {
  const { host, root } = await mount(async () => Response.json({ ok: true }, { status: 200 }))
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await clickRun(runNowButton(host))
  assert.deepEqual(errors(), [], 'success must not toast an error')
  assert.ok(
    (globalThis.__deliveryToasts ?? []).some(
      (toast) => toast.kind === 'success' && toast.message.includes('Report run complete'),
    ),
    'success toasts completion',
  )
  assert.equal(globalThis.__deliveryRefreshes, 1, 'the run list refreshes after the run')
})
