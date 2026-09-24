import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * F2: attaching a candidate to a DRAFT requisition refused with "open it",
 * but the drawer offered no Open action — the persona had to hand-PATCH the
 * API. The drawer now carries the lifecycle controls the requisition's
 * status allows, through the shared action-island composition, gated by the
 * same hrm.recruiting.manage grant the PATCH endpoint enforces.
 * (Ticket in comment only; the test names state the behaviour.)
 *
 * These tests RENDER the island: the status matrix shows exactly the
 * actions each status allows, behind the manage grant; acting PATCHes the
 * requisition route with the reason the API requires; and an API refusal
 * pins in the drawer as an alert, never a transient toast. The service
 * side of the transitions (draft -> open -> hold/resume/cancel) is proven
 * by engine/src/hrm/recruiting.integration.test.ts, not doubled here.
 */

// jsdom first: the island reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/hrm/recruiting',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}

declare global {
  var __lifecyclePrompts: Array<{ title: string; label: string }> | undefined
  var __lifecyclePromptAnswer: string | null | undefined
  var __lifecycleRefreshes: number | undefined
}

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return { refresh(){ globalThis.__lifecycleRefreshes = (globalThis.__lifecycleRefreshes || 0) + 1 }, push(){} }}',
      }
    }
    if (typeof specifier === 'string' && specifier.endsWith('/lib/prompt')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function promptDialog(opts){ globalThis.__lifecyclePrompts = [...(globalThis.__lifecyclePrompts || []), { title: opts.title, label: opts.label }]; return globalThis.__lifecyclePromptAnswer; }',
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
// Dynamic: the island's next/navigation and prompt seams are stubbed by
// the hook above, so the module must load after it registers — a static
// import would resolve the real router first.
const { lifecycleActionsForStatus, RequisitionLifecycleIsland } = await import('./actions')

const LABELS = {
  title: 'Lifecycle',
  open: 'Open',
  hold: 'Hold',
  resume: 'Resume',
  cancel: 'Cancel',
  reason: 'Reason for this change',
  failed: 'Could not change the requisition',
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

interface Post {
  url: string
  method: string
  body: unknown
}

function installFetch(handler: (post: Post) => Response): () => void {
  const prior = globalThis.fetch
  const posts: Post[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const post: Post = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null }
    posts.push(post)
    ;(globalThis as Record<string, unknown>).__lifecyclePosts = posts
    return handler(post)
  }) as typeof fetch
  return () => {
    globalThis.fetch = prior
  }
}

function posts(): Post[] {
  return ((globalThis as Record<string, unknown>).__lifecyclePosts as Post[] | undefined) ?? []
}

async function mountIsland(status: string, canManage: boolean): Promise<() => Promise<void>> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <RequisitionLifecycleIsland requisitionId="req-1" status={status} canManage={canManage} labels={LABELS} />,
    )
    await tick()
  })
  await tick()
  return async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll('button')] as HTMLButtonElement[]
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === name)
  assert.ok(found, `expected a button named ${name}`)
  return found!
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
    await tick()
  })
  await tick()
}

function resetInteractionState(): void {
  const gap = globalThis as Record<string, unknown>
  gap.__lifecyclePrompts = []
  gap.__lifecyclePromptAnswer = undefined
  gap.__lifecycleRefreshes = 0
  gap.__lifecyclePosts = []
}

test('a draft requisition shows Open; after it opens, Hold and Cancel show', () => {
  assert.deepEqual(lifecycleActionsForStatus('draft'), ['open'], 'a draft offers only Open')
  assert.deepEqual(
    lifecycleActionsForStatus('open'),
    ['hold', 'cancel'],
    'an open requisition offers Hold and Cancel',
  )
  assert.deepEqual(lifecycleActionsForStatus('on_hold'), ['resume'], 'an on-hold requisition offers Resume')
  assert.deepEqual(lifecycleActionsForStatus('filled'), [], 'a filled requisition offers nothing')
  assert.deepEqual(lifecycleActionsForStatus('cancelled'), [], 'a cancelled requisition offers nothing')
})

test('the island renders exactly the actions each status allows, behind the manage grant', async (t) => {
  const restoreFetch = installFetch(() => Response.json({}))
  t.after(restoreFetch)

  let unmount = await mountIsland('draft', true)
  t.after(unmount)
  assert.deepEqual(
    buttons().map((b) => b.textContent?.trim()),
    ['Open'],
    'a draft offers only Open',
  )
  await unmount()

  unmount = await mountIsland('open', true)
  t.after(unmount)
  assert.deepEqual(
    buttons().map((b) => b.textContent?.trim()),
    ['Hold', 'Cancel'],
    'an open requisition offers Hold and Cancel',
  )
  await unmount()

  unmount = await mountIsland('filled', true)
  t.after(unmount)
  assert.deepEqual(buttons(), [], 'a filled requisition offers nothing')
  await unmount()

  unmount = await mountIsland('draft', false)
  t.after(unmount)
  assert.equal(document.body.textContent?.trim(), '', 'without the manage grant nothing renders')
  await unmount()
})

test('opening posts the action without a reason prompt and refreshes', async (t) => {
  resetInteractionState()
  const restoreFetch = installFetch(() => Response.json({}))
  t.after(restoreFetch)
  const unmount = await mountIsland('draft', true)
  t.after(unmount)

  await click(buttonNamed('Open'))

  assert.deepEqual(posts(), [
    { url: '/api/hrm/recruiting/requisitions/req-1', method: 'PATCH', body: { action: 'open' } },
  ])
  assert.deepEqual(globalThis.__lifecyclePrompts, [], 'opening asks no reason')
  assert.equal(globalThis.__lifecycleRefreshes, 1, 'success refreshes the loader-resolved drawer')
  assert.equal(document.querySelector('[role="alert"]'), null, 'no refusal beside success')
})

test('holding prompts for the reason the API requires and pins a refusal in the drawer', async (t) => {
  resetInteractionState()
  const refusal = 'only an open requisition can be held — reopen it first'
  const restoreFetch = installFetch(() => Response.json({ error: refusal }, { status: 422 }))
  t.after(restoreFetch)
  globalThis.__lifecyclePromptAnswer = 'waiting on headcount approval'
  const unmount = await mountIsland('open', true)
  t.after(unmount)

  await click(buttonNamed('Hold'))

  assert.equal(globalThis.__lifecyclePrompts?.length, 1, 'hold prompts once')
  assert.match(globalThis.__lifecyclePrompts?.[0]?.label ?? '', /Reason/, 'the prompt asks for the reason')
  assert.deepEqual(posts(), [
    {
      url: '/api/hrm/recruiting/requisitions/req-1',
      method: 'PATCH',
      body: { action: 'hold', reason: 'waiting on headcount approval' },
    },
  ])
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the refusal pins in the drawer as an alert')
  assert.ok((alert?.textContent ?? '').includes(refusal), 'the refusal message renders intact')
})
