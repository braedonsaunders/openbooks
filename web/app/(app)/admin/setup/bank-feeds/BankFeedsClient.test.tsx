import assert from 'node:assert/strict'
import test from 'node:test'

// F-t05-021 (bank feed Remove destroys the connection with no confirmation):
// one click fires DELETE immediately. Removing feed wiring must confirm
// first, mirroring the bank-rule Delete native confirm.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/setup/bank-feeds',
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
  window.matchMedia = (() => ({
    matches: true,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

declare global {
  var __feedConfirmCalls: string[] | undefined
  var __feedConfirmAnswer: boolean | undefined
  var __feedDeletes: string[] | undefined
}

Object.assign(globalThis, {
  __feedConfirmCalls: [] as string[],
  __feedConfirmAnswer: true,
  __feedDeletes: [] as string[],
  __feedTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__feedTestRouter}',
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
const messages = (await import('../../../../../messages/en')).default
const { BankFeedsClient } = await import('./BankFeedsClient')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const connection = {
  id: 'conn-1',
  name: 'RBC manual upload',
  provider: 'manual',
  accountId: 'acc-1',
  status: 'connected',
  externalAccountId: null,
  syncCadence: 'manual',
  lastSyncAt: null,
  lastAttemptAt: null,
  lastError: null,
  isActive: true,
  accountNumber: '1000',
  accountName: 'Operating Cash',
}

async function mount() {
  ;(globalThis as Record<string, unknown>).__feedConfirmCalls = []
  ;(globalThis as Record<string, unknown>).__feedDeletes = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    if (init?.method === 'DELETE') {
      ;(globalThis.__feedDeletes ?? []).push(String(url))
      return Response.json({ ok: true })
    }
    throw new Error(`unexpected fetch ${String(url)}`)
  }) as typeof fetch
  ;(globalThis as Record<string, unknown>).confirm = (message: unknown) => {
    ;(globalThis.__feedConfirmCalls ?? []).push(String(message))
    return globalThis.__feedConfirmAnswer ?? true
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BankFeedsClient
          connections={[connection]}
          sftpServers={[]}
          sftpSchedules={[]}
          accounts={[{ id: 'acc-1', label: '1000 Operating Cash' }]}
          daemon={{ enabled: false, port: 0, host: '', fingerprint: '' }}
        />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  return { host, root }
}

function clickRemove() {
  const btn = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === 'Remove',
  ) as HTMLButtonElement | undefined
  assert.ok(btn, 'the connection must offer Remove')
  return btn
}

test('removing a feed connection confirms first (F-t05-021)', async (t) => {
  globalThis.__feedConfirmAnswer = true
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await act(async () => {
    clickRemove().click()
    await tick()
    await tick()
  })
  assert.equal(globalThis.__feedConfirmCalls?.length, 1, 'Remove must confirm before deleting')
  assert.match(globalThis.__feedConfirmCalls?.[0] ?? '', /Remove this connection/)
  assert.deepEqual(globalThis.__feedDeletes, ['/api/banking/bank-feeds/conn-1'])
})

test('cancelling the confirm leaves the connection alone (F-t05-021)', async (t) => {
  globalThis.__feedConfirmAnswer = false
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await act(async () => {
    clickRemove().click()
    await tick()
    await tick()
  })
  assert.equal(globalThis.__feedConfirmCalls?.length, 1, 'Remove must confirm before deleting')
  assert.deepEqual(globalThis.__feedDeletes, [], 'a cancelled confirm must not delete')
})

async function mountSftpSchedules(
  schedules: Array<{
    id: string
    format: string
    expectedExternalAccountId: string | null
  }>,
) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BankFeedsClient
          connections={[]}
          sftpServers={[
            {
              id: 'srv-1',
              name: 'Bank SFTP',
              username: 'feedbot',
              rootPrefix: 'fleet',
              isActive: true,
              lastConnectedAt: null,
            },
          ]}
          sftpSchedules={schedules.map((s, i) => ({
            id: s.id,
            sftpServerId: 'srv-1',
            accountId: 'acc-1',
            folder: `inbound-${i}`,
            format: s.format,
            isActive: true,
            lastRunAt: null,
            accountNumber: '1000',
            accountName: 'Operating Cash',
            expectedExternalAccountId: s.expectedExternalAccountId,
          }))}
          accounts={[{ id: 'acc-1', label: '1000 Operating Cash' }]}
          daemon={{ enabled: false, port: 0, host: '', fingerprint: '' }}
        />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  return { host, root }
}

// F4T2-14 (feedAction read the body before the status: a 500 with an empty
// body gave r.json().catch -> {}, b.error is falsy, and the operator got an
// 'imported' toast with undefined counts though nothing was imported). The
// status is checked before the body is parsed; a body that carries no counts
// is a named failure, never a phantom success; busy always releases.
const plaidConnection = {
  ...connection,
  id: 'conn-plaid',
  name: 'Plaid test feed',
  provider: 'plaid',
}

async function mountFeed(fetchImpl: typeof fetch) {
  globalThis.fetch = fetchImpl
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BankFeedsClient
          connections={[plaidConnection]}
          sftpServers={[]}
          sftpSchedules={[]}
          accounts={[{ id: 'acc-1', label: '1000 Operating Cash' }]}
          daemon={{ enabled: false, port: 0, host: '', fingerprint: '' }}
        />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  return { host, root }
}

function actionButton(host: Element, label: string): HTMLButtonElement {
  const btn = [...host.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined
  assert.ok(btn, `the connection must offer ${label}`)
  return btn
}

async function clickAndSettle(btn: HTMLButtonElement) {
  await act(async () => {
    btn.click()
    await tick()
    await tick()
    await tick()
    await tick()
  })
}

test('a non-JSON 500 on sync is a named failure, never a phantom import (F4T2-14)', async (t) => {
  const { host, root } = await mountFeed((async () => new Response('', { status: 500 })) as typeof fetch)
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const btn = actionButton(host, 'Sync')
  await clickAndSettle(btn)
  assert.match(host.textContent ?? '', /Request failed \(HTTP 500\)/)
  assert.doesNotMatch(host.textContent ?? '', /Imported/, 'no phantom import toast for work the server never did')
  assert.equal(btn.disabled, false, 'busy releases after the failure')
})

test('a named 422 on sync surfaces the server refusal (F4T2-14)', async (t) => {
  const { host, root } = await mountFeed(
    (async () => Response.json({ error: 'not an API provider' }, { status: 422 })) as typeof fetch,
  )
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await clickAndSettle(actionButton(host, 'Sync'))
  assert.match(host.textContent ?? '', /Sync failed: not an API provider/)
  assert.doesNotMatch(host.textContent ?? '', /Imported/)
})

test('a successful sync still reports its counts (F4T2-14)', async (t) => {
  const { host, root } = await mountFeed(
    (async () => Response.json({ imported: 3, duplicates: 1 }, { status: 200 })) as typeof fetch,
  )
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await clickAndSettle(actionButton(host, 'Sync'))
  assert.match(host.textContent ?? '', /Imported 3 new, 1 duplicate/)
})

test('a refused probe reports its detail, a verified one confirms (F4T2-14)', async (t) => {
  const refused = await mountFeed(
    (async () => Response.json({ ok: false, detail: 'bad token' }, { status: 200 })) as typeof fetch,
  )
  t.after(async () => {
    await act(async () => {
      refused.root.unmount()
    })
    refused.host.remove()
  })
  await clickAndSettle(actionButton(refused.host, 'Test'))
  assert.match(refused.host.textContent ?? '', /Test failed: bad token/)
})

test('an unbound identifying schedule reads paused, bound and CSV routes do not', async (t) => {
  const { host, root } = await mountSftpSchedules([
    { id: 'sched-unbound-ofx', format: 'ofx', expectedExternalAccountId: null },
    { id: 'sched-bound-ofx', format: 'ofx', expectedExternalAccountId: 'BR001-77' },
    { id: 'sched-unbound-csv', format: 'csv', expectedExternalAccountId: null },
  ])
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const badges = [...host.querySelectorAll('li')].filter((li) =>
    (li.textContent ?? '').includes('Paused: expected account not set'),
  )
  assert.equal(badges.length, 1, 'exactly the unbound OFX schedule reads paused')
  assert.equal(
    badges[0]?.getAttribute('id'),
    'sftp-schedule-sched-unbound-ofx',
    'the badge sits on the unbound schedule row',
  )
  const badge = [...(badges[0]?.querySelectorAll('span') ?? [])].find(
    (s) => (s.textContent ?? '').trim() === 'Paused: expected account not set',
  )
  assert.ok(badge, 'the paused badge itself renders')
  assert.match(
    badge?.getAttribute('title') ?? '',
    /bound/,
    'the badge names the remedy, not a generic error',
  )
})

// F4T2-12 (the SFTP server and schedule Removes DELETE with no confirm,
// while the sibling connection Remove got one for F-t05-021): both must
// confirm first, and a cancelled confirm must not delete.
async function mountSftpRemoves() {
  ;(globalThis as Record<string, unknown>).__feedConfirmCalls = []
  ;(globalThis as Record<string, unknown>).__feedDeletes = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    if (init?.method === 'DELETE') {
      ;(globalThis.__feedDeletes ?? []).push(String(url))
      return Response.json({ ok: true })
    }
    throw new Error(`unexpected fetch ${String(url)}`)
  }) as typeof fetch
  ;(globalThis as Record<string, unknown>).confirm = (message: unknown) => {
    ;(globalThis.__feedConfirmCalls ?? []).push(String(message))
    return globalThis.__feedConfirmAnswer ?? true
  }
  return mountSftpSchedules([
    { id: 'sched-1', format: 'csv', expectedExternalAccountId: null },
  ])
}

function serverRemoveButton(host: Element): HTMLButtonElement {
  const btn = [...host.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === 'Remove' && !b.closest('li'),
  ) as HTMLButtonElement | undefined
  assert.ok(btn, 'the server card must offer Remove')
  return btn
}

function scheduleRemoveButton(host: Element): HTMLButtonElement {
  const btn = [...host.querySelectorAll('li button')].find(
    (b) => (b.textContent ?? '').trim() === 'Remove',
  ) as HTMLButtonElement | undefined
  assert.ok(btn, 'the schedule row must offer Remove')
  return btn
}

async function clickButton(btn: HTMLButtonElement) {
  await act(async () => {
    btn.click()
    await tick()
    await tick()
  })
}

test('removing an SFTP server confirms first (F4T2-12)', async (t) => {
  globalThis.__feedConfirmAnswer = true
  const { host, root } = await mountSftpRemoves()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await clickButton(serverRemoveButton(host))
  assert.equal(globalThis.__feedConfirmCalls?.length, 1, 'server Remove must confirm before deleting')
  assert.match(globalThis.__feedConfirmCalls?.[0] ?? '', /Remove this SFTP login/)
  assert.deepEqual(globalThis.__feedDeletes, ['/api/banking/sftp/srv-1'])
})

test('cancelling the server confirm leaves the login alone (F4T2-12)', async (t) => {
  globalThis.__feedConfirmAnswer = false
  const { host, root } = await mountSftpRemoves()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await clickButton(serverRemoveButton(host))
  assert.equal(globalThis.__feedConfirmCalls?.length, 1, 'server Remove must confirm before deleting')
  assert.deepEqual(globalThis.__feedDeletes, [], 'a cancelled confirm must not delete the server')
})

test('removing a routing schedule confirms first (F4T2-12)', async (t) => {
  globalThis.__feedConfirmAnswer = true
  const { host, root } = await mountSftpRemoves()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await clickButton(scheduleRemoveButton(host))
  assert.equal(globalThis.__feedConfirmCalls?.length, 1, 'schedule Remove must confirm before deleting')
  assert.match(globalThis.__feedConfirmCalls?.[0] ?? '', /Remove this routing schedule/)
  assert.deepEqual(globalThis.__feedDeletes, ['/api/banking/sftp/schedules/sched-1'])
})

test('cancelling the schedule confirm leaves the route alone (F4T2-12)', async (t) => {
  globalThis.__feedConfirmAnswer = false
  const { host, root } = await mountSftpRemoves()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await clickButton(scheduleRemoveButton(host))
  assert.equal(globalThis.__feedConfirmCalls?.length, 1, 'schedule Remove must confirm before deleting')
  assert.deepEqual(globalThis.__feedDeletes, [], 'a cancelled confirm must not delete the schedule')
})
