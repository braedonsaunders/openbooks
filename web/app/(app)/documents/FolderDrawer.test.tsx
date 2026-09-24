import assert from 'node:assert/strict'
import test from 'node:test'

// F4T-6 (create/rename/delete toasted generic failures, dropping the
// server's named refusal; delete parsed after the check): the status is
// checked first through the shared helper in all three mutations.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/documents?folder=folder-1',
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
  var __folderToasts: { kind: string; message: string }[] | undefined
  var __folderFetchImpl: ((url: string, init?: { method?: string }) => Promise<Response>) | undefined
}

Object.assign(globalThis, {
  __folderToasts: [] as { kind: string; message: string }[],
  __folderFetchImpl: undefined as ((url: string, init?: { method?: string }) => Promise<Response>) | undefined,
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return {refresh(){},push(){}}}export function usePathname(){return "/documents"}export function useSearchParams(){return new URLSearchParams("folder=folder-1")}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return p.children}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__folderToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__folderToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { FolderDrawer } = await import('./FolderDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const folder = {
  id: 'folder-1',
  name: 'Contracts',
  parentId: null,
  isSystem: false,
  systemKind: null,
  isPrivate: false,
  isInactive: false,
  recordTable: null,
  recordId: null,
  childCount: 0,
  fileCount: 0,
}

async function mountEdit() {
  ;(globalThis as Record<string, unknown>).__folderToasts = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    return (globalThis.__folderFetchImpl ?? (async () => Response.json({ ok: true })))(
      String(url),
      init,
    )
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <FolderDrawer mode="edit" folder={folder} folders={[folder]} canManage />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  return { host, root }
}

function findButton(scope: ParentNode, label: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined
  assert.ok(btn, `must offer a ${label} button`)
  return btn
}

function errors(): string[] {
  return (globalThis.__folderToasts ?? []).filter((t) => t.kind === 'error').map((t) => t.message)
}

test('a non-JSON 500 on rename names the failure (F4T-6)', async (t) => {
  const { host, root } = await mountEdit()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  ;(globalThis as Record<string, unknown>).__folderFetchImpl = async () => new Response('', { status: 500 })
  await act(async () => {
    findButton(document.body, 'Edit').click()
    await tick()
  })
  const input = document.body.querySelector('input#folder-name') as HTMLInputElement | null
  assert.ok(input, 'edit mode must offer the name input')
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')
  await act(async () => {
    descriptor?.set?.call(input, 'Renamed')
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  await act(async () => {
    findButton(document.body, 'Save').click()
    await tick()
    await tick()
    await tick()
  })
  assert.match(errors().join('\n'), /Could not rename folder \(status 500\)/)
})

test('a named 422 on create surfaces the server refusal (F4T-6)', async (t) => {
  ;(globalThis as Record<string, unknown>).__folderToasts = []
  ;(globalThis as Record<string, unknown>).__folderFetchImpl = async (url: string, init?: { method?: string }) =>
    url === '/api/file-cabinet/folders' && init?.method === 'POST'
      ? Response.json({ error: 'a folder with this name exists' }, { status: 409 })
      : Response.json({ ok: true })
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    return (globalThis.__folderFetchImpl ?? (async () => Response.json({ ok: true })))(
      String(url),
      init,
    )
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <FolderDrawer mode="create" folders={[]} />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const input = document.body.querySelector('input#folder-name') as HTMLInputElement | null
  assert.ok(input, 'create mode must offer the name input')
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')
  await act(async () => {
    descriptor?.set?.call(input, 'Taken')
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  await act(async () => {
    findButton(document.body, 'Create folder').click()
    await tick()
    await tick()
    await tick()
  })
  assert.ok(errors().some((m) => m.includes('a folder with this name exists')), 'the toast carries the named refusal')
})
