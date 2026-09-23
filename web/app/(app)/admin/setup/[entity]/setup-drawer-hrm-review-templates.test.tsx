import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// OM-17: /admin/setup/hrm-review-templates "New" crashed the page with React
// #301. The New drawer mounts a TagInput for the ref-less ratingScaleLabels
// field with zero suggestion rows, and TagInput's render-phase setHighlight
// looped forever on that state. This renders the real SetupDrawer for
// hrm-review-templates with row=null (the ?row=new state) and proves the
// drawer opens with a usable rating-scale labels control.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/setup/hrm-review-templates?row=new',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement',
  'HTMLInputElement', 'HTMLButtonElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'self',
]) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {}
}

registerHooks({
  resolve(specifier, context, next) {
    // next/navigation: the drawer only navigates on save/close/tab switch.
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export function useRouter(){return globalThis.__setupRouter}export function usePathname(){return '/admin/setup/hrm-review-templates'}export function useSearchParams(){return new URLSearchParams(globalThis.__setupQuery ?? '')}`,
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}`,
      }
    }
    // LossOfControlButton only renders for the subsidiary-ownership entity
    // under test here, so it loads as a null stub; everything else resolves
    // normally and the drawer loads unmodified.
    if (specifier === '@/app/(app)/accounting/changes/LossOfControlButton') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function LossOfControlButton(){return null}',
      }
    }
    return next(specifier, context)
  },
})

declare global {
  var __setupRouter: { push(url: string): void; replace(url: string): void; refresh(): void } | undefined
  var __setupQuery: string | undefined
}

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { SetupDrawer } = await import('./SetupDrawer')
const { SETUP_ENTITY_BY_KEY } = await import('../../../../../lib/setup/registry')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function renderNewDrawer() {
  globalThis.__setupQuery = 'row=new'
  const pushes: string[] = []
  globalThis.__setupRouter = {
    push(url: string) {
      pushes.push(url)
    },
    replace() {},
    refresh() {},
  }
  const entity = SETUP_ENTITY_BY_KEY.get('hrm-review-templates')
  assert.ok(entity, 'the registry must declare hrm-review-templates')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SetupDrawer entity={entity} row={null} members={[]} refOptions={{}} />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  return {
    host,
    pushes,
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

test('the hrm-review-templates New drawer renders with a usable scale-labels control (OM-17)', async () => {
  // Pre-fix this render threw "Too many re-renders" twice through the error
  // boundary: the ratingScaleLabels TagInput mounted with zero rows.
  const { unmount } = await renderNewDrawer()
  try {
    // UrlDrawer portals into document.body, so assertions query the document.
    const boxes = document.querySelectorAll('input[role="combobox"]')
    assert.equal(boxes.length, 1, 'the New drawer must render exactly the rating-scale labels TagInput')
    const input = boxes[0] as HTMLInputElement
    // Free entry: type a label and commit it with Enter.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'Needs improvement')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await tick()
    const chips = [...document.querySelectorAll('span.truncate')].map((el) => el.textContent)
    assert.ok(
      chips.includes('Needs improvement'),
      `the committed label must render as a chip, saw: ${JSON.stringify(chips)}`,
    )
    // Removal: the chip's remove button takes the label back off.
    const remove = document.querySelector('button[aria-label*="Needs improvement"]')
    assert.ok(remove instanceof HTMLButtonElement, 'the chip must offer a remove button')
    await act(async () => {
      remove.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await tick()
    assert.equal(
      document.querySelector('span.truncate'),
      null,
      'removing the chip must clear the labels value',
    )
  } finally {
    await unmount()
  }
})
