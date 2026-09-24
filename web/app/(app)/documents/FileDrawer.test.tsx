import assert from 'node:assert/strict'
import test from 'node:test'

// F4T-5 (rename/delete/replace toasted generic failures, dropping the
// server's named refusal; replace parsed after the check): the status is
// checked first through the shared helper in all three mutations.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/documents?file=file-1',
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
  var __fileToasts: { kind: string; message: string }[] | undefined
  var __fileFetchImpl: ((url: string, init?: { method?: string }) => Promise<Response>) | undefined
}

Object.assign(globalThis, {
  __fileToasts: [] as { kind: string; message: string }[],
  __fileFetchImpl: undefined as ((url: string, init?: { method?: string }) => Promise<Response>) | undefined,
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return {refresh(){},push(){}}}export function usePathname(){return "/documents"}export function useSearchParams(){return new URLSearchParams("file=file-1")}',
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__fileToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__fileToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
      }
    }
    if (specifier.endsWith('/lib/confirm')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function confirmDialog(){return true}',
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
const { FileDrawer } = await import('./FileDrawer')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const file = {
  id: 'file-1',
  folderId: 'folder-1',
  name: 'contract.pdf',
  extension: 'pdf',
  fileType: 'pdf',
  contentType: 'application/pdf',
  sizeBytes: 100,
  isInactive: false,
  currentVersionId: 'v-1',
  versionCount: 1,
  createdAt: '2026-01-05T00:00:00.000Z',
  createdBy: null,
  updatedAt: '2026-01-05T00:00:00.000Z',
  updatedBy: null,
  folderName: 'Contracts',
  versions: [],
  attachments: [],
}

async function mount() {
  ;(globalThis as Record<string, unknown>).__fileToasts = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    return (globalThis.__fileFetchImpl ?? (async () => Response.json({ ok: true })))(
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
        <FileDrawer file={file} canEdit canManage />
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

async function renameTo(scope: ParentNode, name: string) {
  await act(async () => {
    findButton(scope, 'Edit').click()
    await tick()
  })
  const input = scope.querySelector('input:not([type="hidden"])') as HTMLInputElement | null
  assert.ok(input, 'edit mode must offer the name input')
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')
  await act(async () => {
    descriptor?.set?.call(input, name)
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  await act(async () => {
    findButton(scope, 'Save').click()
    await tick()
    await tick()
    await tick()
  })
}

function errors(): string[] {
  return (globalThis.__fileToasts ?? []).filter((t) => t.kind === 'error').map((t) => t.message)
}

test('a refused rename toasts the named refusal and stays in edit mode (F4T-5)', async (t) => {
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  ;(globalThis as Record<string, unknown>).__fileFetchImpl = async (url: string, init?: { method?: string }) =>
    url === '/api/file-cabinet/files/file-1' && init?.method === 'PATCH'
      ? Response.json({ error: 'name is taken in this folder' }, { status: 409 })
      : Response.json({ ok: true })
  await renameTo(document.body, 'taken.pdf')
  assert.ok(errors().some((m) => m.includes('name is taken in this folder')), 'the toast carries the named refusal')
  assert.ok(
    [...document.body.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === 'Save'),
    'a refused rename stays in edit mode',
  )
})

test('a non-JSON 500 on delete names the failure (F4T-5)', async (t) => {
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  ;(globalThis as Record<string, unknown>).__fileFetchImpl = async () => new Response('', { status: 500 })
  await act(async () => {
    findButton(document.body, 'Actions').click()
    await tick()
    await tick()
  })
  await act(async () => {
    findButton(document.body, 'Delete').click()
    await tick()
    await tick()
    await tick()
  })
  assert.match(errors().join('\n'), /Could not delete file \(status 500\)/)
})
