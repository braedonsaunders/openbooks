import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// OM-17c: the review-template edit drawer rendered Scale minimum, Scale
// maximum and Scale labels ALL BLANK for a stored row, so a Save cleared
// or rewrote rating_scale. The read path now projects the stored jsonb
// into the drawer slot fields (projectRuleSlotPrefills, driven by the
// RULE_SLOT_ENTITIES fold metadata), and the same gap is closed for the
// document-template signer checkboxes. These tests render the real
// SetupDrawer for a stored row (projected exactly as sections.tsx does)
// and prove the fields prefill; the save test posts without edits and
// proves the stored JSON round-trips through the real write fold.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/setup/hrm-review-templates?row=00000000-0000-4000-8000-000000000041',
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
const { projectRuleSlotPrefills } = await import('../../../../../lib/setup/hrm-rule-slots')
const { normalizeHrmReviewTemplateInput } = await import('../../../../../lib/setup/hrm-review-template')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const STORED_SCALE = { min: 1, max: 3, labels: ['Needs improvement', 'Meets expectations', 'Exceeds expectations'] }

// The stored row as select * returns it: rating_scale jsonb, no flat keys.
const storedReviewRow = {
  id: '00000000-0000-4000-8000-000000000041',
  name: 'Senior review',
  rating_scale: STORED_SCALE,
  is_active: true,
}

const storedDocumentRow = {
  id: '00000000-0000-4000-8000-000000000042',
  name: 'Offer letter',
  categoryKey: 'offer',
  bodyTemplate: 'Hello {{name}}',
  merge_fields: ['name', 'start_date'],
  signer_roles: ['employee', 'hr'],
  requiresSignature: true,
  is_active: true,
}

async function renderEditDrawer(entityKey: string, row: Record<string, unknown>, seedFetch?: (url: string) => unknown) {
  globalThis.__setupQuery = `row=${row.id}`
  const pushes: string[] = []
  const posts: { url: string; method: string; body: Record<string, unknown> }[] = []
  globalThis.__setupRouter = { push(url: string) { pushes.push(url) }, replace() {}, refresh() {} }
  const priorFetch = globalThis.fetch
  ;(globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    if (url.includes('/api/admin/setup/')) {
      posts.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : {} })
    }
    return { ok: true, status: 200, json: async () => ({}), clone: () => ({ json: async () => ({}) }) }
  }
  void seedFetch
  const entity = SETUP_ENTITY_BY_KEY.get(entityKey)
  assert.ok(entity, `the registry must declare ${entityKey}`)
  // sections.tsx projects the stored row before handing it to the drawer.
  const projected = projectRuleSlotPrefills(entityKey, row)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SetupDrawer entity={entity} row={projected} members={[]} refOptions={{}} />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  return {
    pushes,
    posts,
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      host.remove()
      globalThis.fetch = priorFetch
    },
  }
}

function inputByLabel(label: string): HTMLInputElement {
  const el = document.querySelector(`input[aria-label="${label}"]`)
  assert.ok(el instanceof HTMLInputElement, `a text input labelled ${JSON.stringify(label)} must render`)
  return el
}

test('OM-17c: the review-template edit drawer prefills the stored rating scale', async () => {
  const m = await renderEditDrawer('hrm-review-templates', storedReviewRow)
  try {
    assert.equal(inputByLabel('Scale minimum').value, '1', 'the stored min prefills')
    assert.equal(inputByLabel('Scale maximum').value, '3', 'the stored max prefills')
    const chips = [...document.querySelectorAll('span.truncate')].map((el) => el.textContent)
    assert.deepEqual(
      chips.sort(),
      [...STORED_SCALE.labels].sort(),
      `every stored label renders as a chip, saw: ${JSON.stringify(chips)}`,
    )
  } finally {
    await m.unmount()
  }
})

test('OM-17c: saving the prefilled drawer without edits keeps the stored scale JSON', async () => {
  const m = await renderEditDrawer('hrm-review-templates', storedReviewRow, () => ({}))
  try {
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')
    assert.ok(save instanceof HTMLButtonElement, 'a Save button renders')
    await act(async () => {
      save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await tick()
      await tick()
    })
    const patch = m.posts.find((p) => p.method === 'PATCH')
    assert.ok(patch, 'the save posts a PATCH without edits')
    const folded = normalizeHrmReviewTemplateInput('hrm-review-templates', patch.body)
    assert.deepEqual(folded.ratingScale, STORED_SCALE, 'the fold round-trips the stored scale unchanged')
  } finally {
    await m.unmount()
  }
})

test('OM-17c: the document-template edit drawer prefills signer checkboxes from signer_roles', async () => {
  const m = await renderEditDrawer('hrm-document-templates', storedDocumentRow)
  try {
    const box = (label: string): boolean => {
      // Boolean fields render a bare checkbox inside their Label: match by
      // the wrapping label text, since the input carries no aria-label.
      const boxes = [...document.querySelectorAll('input[type="checkbox"]')]
      const el = boxes.find((b) => b.parentElement?.textContent?.includes(label))
      assert.ok(el instanceof HTMLInputElement, `a checkbox labelled ${JSON.stringify(label)} must render`)
      return el.checked
    }
    assert.equal(box('Employee signs'), true, 'the stored employee role checks its box')
    assert.equal(box('Manager signs'), false, 'the absent manager role leaves its box clear')
    assert.equal(box('HR signs'), true, 'the stored hr role checks its box')
    const chips = [...document.querySelectorAll('span.truncate')].map((el) => el.textContent)
    assert.ok(
      chips.includes('name') && chips.includes('start_date'),
      `stored merge keys render as chips, saw: ${JSON.stringify(chips)}`,
    )
  } finally {
    await m.unmount()
  }
})
