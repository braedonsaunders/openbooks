import assert from 'node:assert/strict'
import test from 'node:test'

declare global {
  var __paySetupRouter: { push(url: string): void; refresh(): void } | undefined
  var __paySetupToasts: { kind: string; message: string }[] | undefined
}

// F-t11-007: the bank-profile drawer checkboxes ignored clicks in both
// directions. The edit row arrives as raw snake_case (`select *`), every
// Toggle/Select reads the snake key first
// (`form.require_run_approval ?? form.requireRunApproval`), but onChange
// wrote the camelCase twin (`set('requireRunApproval', v)`). The snake value
// is never undefined on a loaded row, so the freshly written camel value was
// shadowed forever: the control displayed (and saved) its creation value.
// Proved here through the real editor: clicks flip the controls and the save
// payload carries the edited values.

// jsdom first: the editor reads browser globals at render.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/setup/payment-operations?view=profiles',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
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

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__paySetupRouter}export function usePathname(){return "/admin/setup/payment-operations"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href},p.children)}`,
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export const toast={success(m){(globalThis.__paySetupToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__paySetupToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}`,
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
const commonCatalog = (await import('../../../../../messages/en/common.json', { with: { type: 'json' } })).default as unknown as Record<
  string,
  Record<string, string>
>
const { SetupEditor } = await import('./PaymentOperationsSetup')

type EditorProps = Parameters<typeof SetupEditor>[0]

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const EMPTY_OPTIONS: EditorProps['options'] = {
  formats: [],
  bankAccounts: [],
  accountingAccounts: [],
  subsidiaries: [],
  sftpServers: [],
  profiles: [],
  parties: [],
  currencies: [],
}

interface SeenRequest {
  url: string
  method: string
  body: unknown
}

async function mountEditor(
  view: EditorProps['view'],
  row: Record<string, unknown>,
  options: EditorProps['options'] = EMPTY_OPTIONS,
  responder: () => Response | Promise<Response> = () => Response.json({ ok: true }),
) {
  globalThis.__paySetupRouter = { push() {}, refresh() {} }
  globalThis.__paySetupToasts = []
  const seen: SeenRequest[] = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return responder()
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SetupEditor
          view={view}
          row={row}
          creating={false}
          options={options}
          closeHref="/admin/setup/payment-operations?view=profiles"
        />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  return {
    seen,
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      host.remove()
      globalThis.fetch = prior
    },
  }
}

function profileCheckboxes(): HTMLInputElement[] {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
  assert.ok(boxes.length >= 4, `expected the four profile toggles, saw ${boxes.length} checkboxes`)
  return boxes.slice(0, 4)
}

async function clickCheckbox(box: HTMLInputElement) {
  await act(async () => {
    box.click()
    await tick()
  })
  await tick()
}

test('profile approval toggles follow clicks on a snake-backed row', async () => {
  const { unmount } = await mountEditor('profiles', {
    id: 'p1',
    name: 'Main profile',
    require_run_approval: false,
    require_file_approval: true,
    auto_remittance: false,
    is_active: true,
  })
  try {
    const boxes = profileCheckboxes()
    assert.deepEqual(
      boxes.map((box) => box.checked),
      [false, true, false, true],
      'the toggles must display the stored snake_case row',
    )
    for (const box of boxes) await clickCheckbox(box)
    assert.deepEqual(
      profileCheckboxes().map((box) => box.checked),
      [true, false, true, false],
      'every toggle must move — a shadowed write would leave each control on its creation value',
    )
  } finally {
    await unmount()
  }
})

test('bank-account select follows edits and saves the chosen account', async () => {
  const options: EditorProps['options'] = {
    ...EMPTY_OPTIONS,
    bankAccounts: [
      { id: 'acc-1', number: '1000', name: 'Operating' },
      { id: 'acc-2', number: '2000', name: 'Payroll' },
    ],
  }
  const { seen, unmount } = await mountEditor(
    'profiles',
    { id: 'p1', name: 'Main profile', bank_account_id: 'acc-1', payment_format_id: null },
    options,
  )
  try {
    const select = [...document.querySelectorAll('select')].find(
      (el) => (el as HTMLSelectElement).value === 'acc-1',
    ) as HTMLSelectElement | undefined
    assert.ok(select, 'the bank-account select must display the stored snake_case row')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(select, 'acc-2')
      select.dispatchEvent(new window.Event('change', { bubbles: true }))
      await tick()
    })
    await tick()
    assert.equal(select.value, 'acc-2', 'the select must display its own edit')
    const save = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === String(commonCatalog.actions?.save),
    ) as HTMLButtonElement | undefined
    assert.ok(save, 'the drawer must offer Save')
    await act(async () => {
      save.click()
      await tick()
      await tick()
    })
    await tick()
    assert.equal(seen.length, 1, 'the save must PATCH once')
    assert.equal(
      (seen[0]!.body as Record<string, unknown>).bankAccountId,
      'acc-2',
      'the payload carries the edited account, not the creation value',
    )
  } finally {
    await unmount()
  }
})

test('schedule criteria edits write the key the drawer reads', async () => {
  const { seen, unmount } = await mountEditor('schedules', {
    id: 's1',
    name: 'Weekly',
    payment_bank_profile_id: null,
    cron: '0 8 * * 1',
    action: 'create_draft',
    selection_criteria: { dueThroughDays: 7 },
  })
  try {
    const days = [...document.querySelectorAll('input[type="number"]')].find(
      (el) => (el as HTMLInputElement).value === '7',
    ) as HTMLInputElement | undefined
    assert.ok(days, 'the criteria editor must display the stored snake_case criteria')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(days, '14')
      days.dispatchEvent(new window.Event('input', { bubbles: true }))
      await tick()
    })
    await tick()
    const save = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === String(commonCatalog.actions?.save),
    ) as HTMLButtonElement | undefined
    assert.ok(save, 'the drawer must offer Save')
    await act(async () => {
      save.click()
      await tick()
      await tick()
    })
    await tick()
    assert.equal(seen.length, 1, 'the save must PATCH once')
    assert.deepEqual(
      ((seen[0]!.body as Record<string, unknown>).selectionCriteria as Record<string, unknown>).dueThroughDays,
      14,
      'criteria edits must write the snake key the drawer reads',
    )
  } finally {
    await unmount()
  }
})
