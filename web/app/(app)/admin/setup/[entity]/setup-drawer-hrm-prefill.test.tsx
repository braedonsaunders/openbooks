import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The document-template edit drawer must prefill its signer checkboxes and
// merge-key chips from the stored jsonb (projectRuleSlotPrefills, driven by
// the RULE_SLOT_ENTITIES fold metadata) — a blank prefill would make a Save
// clear the stored signer set. The test renders the real SetupDrawer for a
// stored row, projected exactly as sections.tsx does.

// jsdom first: the drawer reads browser globals at render.
const { bootJsdomEnvironment } = await import('../../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/admin/setup/hrm-document-templates?row=00000000-0000-4000-8000-000000000042', matchMediaMatches: false, resizeObserver: false })

const { stubModules } = await import('../../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__setupRouter}export function usePathname(){return \'/admin/setup/hrm-document-templates\'}export function useSearchParams(){return new URLSearchParams(globalThis.__setupQuery ?? \'\')}' })
registerHooks({
  resolve(specifier, context, next) {

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

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { SetupDrawer } = await import('./SetupDrawer')
const { SETUP_ENTITY_BY_KEY } = await import('../../../../../lib/setup/registry')
const { projectRuleSlotPrefills } = await import('../../../../../lib/setup/hrm-rule-slots')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

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


test('the document-template edit drawer prefills signer checkboxes from signer_roles', async () => {
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
