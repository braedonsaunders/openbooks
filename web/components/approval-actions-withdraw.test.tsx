import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

declare global {
  var __withdrawToasts: { kind: string; message: string }[] | undefined
  var __withdrawPrompt: string | null | undefined
  var __withdrawRouter: { push(): void; refresh(): void } | undefined
}

// A pending-approval document shows its submitter a "Withdraw submission"
// recall beside the pending chip; the click collects the mandatory reason,
// posts the native withdraw, and toasts. Strangers (canWithdraw false) and
// surfaces without a document id never see the button — never offered then
// refused.
const script = {
  posts: [] as Array<{ url: string; body: unknown }>,
  canWithdraw: true,
  withdrawDocumentId: 'doc-1' as string | undefined,
}
Object.assign(globalThis, {
  __withdrawToasts: [],
  __withdrawRouter: { push() {}, refresh() {} },
})
const { registerHooks } = await import('node:module')
await bootJsdomEnvironment({ url: 'http://localhost:4800/ap/bills' })

stubModules({ navigation: { source: 'export function useRouter(){return globalThis.__withdrawRouter}' }, intl: false, authz: false, features: false })

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__withdrawToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__withdrawToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__withdrawToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
      }
    }
    if (specifier === '@/lib/prompt' || specifier.endsWith('/lib/prompt')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function promptDialog(){return globalThis.__withdrawPrompt ?? null}',
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { ApprovalActions } = await import('./approval-actions')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount() {
  globalThis.__withdrawToasts = []
  script.posts.length = 0
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const href = String(url)
    if (href.includes('/api/flows/record-state')) {
      return Response.json({
        approvalState: {
          status: 'pending_approval',
          pendingWith: [{ name: 'Alicia Approver', gateId: 'gate-1', since: '2026-10-01T00:00:00.000Z' }],
          myActions: null,
        },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: false,
        canWithdraw: script.canWithdraw,
      })
    }
    if (href === '/api/documents/actions' && (init?.method ?? 'GET') === 'POST') {
      script.posts.push({ url: href, body: JSON.parse(String(init?.body)) })
      return Response.json({ id: 'doc-1', status: 'draft', withdrawn: true })
    }
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${href}`)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ApprovalActions subjectKind="vendor_bill" subjectId="doc-1" withdrawDocumentId={script.withdrawDocumentId} />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  return { host, root }
}

function withdrawButton(host: HTMLElement) {
  return [...host.querySelectorAll('button')].find(
    (b) => /withdraw submission/i.test(b.textContent ?? ''),
  ) as HTMLButtonElement | undefined
}

test('the submitter sees Withdraw submission and it posts the prompted reason', async (t) => {
  script.canWithdraw = true
  script.withdrawDocumentId = 'doc-1'
  globalThis.__withdrawPrompt = 'billed the wrong vendor'
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const button = withdrawButton(host)
  assert.ok(button, 'the submitter must see a Withdraw submission button')
  await act(async () => {
    button.click()
    await tick()
    await tick()
  })
  assert.deepEqual(script.posts, [
    {
      url: '/api/documents/actions',
      body: { action: 'withdraw', documentId: 'doc-1', reason: 'billed the wrong vendor' },
    },
  ])
  assert.ok(
    (globalThis.__withdrawToasts ?? []).some((toast) => toast.kind === 'success'),
    `the withdraw must toast success, got ${JSON.stringify(globalThis.__withdrawToasts)}`,
  )
})

test('no Withdraw submission when the viewer may not withdraw', async (t) => {
  script.canWithdraw = false
  script.withdrawDocumentId = 'doc-1'
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  assert.equal(
    withdrawButton(host),
    undefined,
    'a viewer who may not withdraw must never see the button',
  )
})

test('no Withdraw submission without a document id', async (t) => {
  script.canWithdraw = true
  script.withdrawDocumentId = undefined
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  assert.equal(
    withdrawButton(host),
    undefined,
    'surfaces without a document withdraw path must stay quiet',
  )
})
