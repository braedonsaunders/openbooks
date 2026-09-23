import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// UX-20 (capture): the empty capture queue carries the upload action for
// creators who can upload; while capture is not operational the amber setup
// banner (not this state) owns the remedy; readers without creation access
// hear the grant instead of an action they cannot take.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/ap/capture',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
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

Object.assign(globalThis, {
  __captureTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__captureTestRouter}export function usePathname(){return "/ap/capture"}export function useSearchParams(){return new URLSearchParams()}',
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
        url: 'data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}',
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
const messages = (await import('../../../../messages/en')).default
const { CaptureList } = await import('./sections')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mountEmpty(
  t: TestContext,
  props: { canCreate: boolean; uploadDisabled: boolean },
): Promise<void> {
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CaptureList
          rows={[]}
          currentParams={{}}
          canCreate={props.canCreate}
          uploadDisabled={props.uploadDisabled}
          sort="received"
          dir="desc"
        />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

test('creators get the upload action in the empty queue', async (t) => {
  await mountEmpty(t, { canCreate: true, uploadDisabled: false })
  const body = document.body.textContent ?? ''
  assert.match(body, /No captured documents/, 'the empty title stays')
  const upload = [...document.querySelectorAll('button')].find((b) =>
    /Upload documents/.test(b.textContent ?? ''),
  )
  assert.ok(upload, 'the empty state must offer the upload action')
  assert.equal(upload.disabled, false, 'the offered upload must work')
})

test('no upload action while capture is not operational', async (t) => {
  await mountEmpty(t, { canCreate: true, uploadDisabled: true })
  const upload = [...document.querySelectorAll('button')].find((b) =>
    /Upload documents/.test(b.textContent ?? ''),
  )
  assert.equal(upload, undefined, 'a disabled upload must not repeat here — the setup banner owns the remedy')
})

test('readers without creation access hear the grant', async (t) => {
  await mountEmpty(t, { canCreate: false, uploadDisabled: false })
  const body = document.body.textContent ?? ''
  assert.match(body, /creation access/, 'the empty state must name the grant')
  assert.equal(
    [...document.querySelectorAll('button')].find((b) => /Upload documents/.test(b.textContent ?? '')),
    undefined,
    'no upload action without the grant',
  )
})
