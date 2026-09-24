import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// OM-14: a failed sample-company create must leave a persistent inline error
// beside the company picker (not just a transient toast), keep the
// operator's chosen company and profile, and clear the error on the next
// attempt — retry is safe because nothing was created.

declare global {
  var __sampleTestRouter: { pushes: string[] } | undefined
  var __sampleTestToasts: { kind: string; message: string }[] | undefined
  var __sampleTestEnteredOrgs: string[] | undefined
}

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/data/import',
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

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return {push(url){globalThis.__sampleTestRouter.pushes.push(String(url))}}}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__sampleTestToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__sampleTestToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__sampleTestToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
      }
    }
    if (specifier.endsWith('lib/sandbox-session')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function enterOrg(orgId){globalThis.__sampleTestEnteredOrgs.push(String(orgId))}',
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
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const messages = (await import('../../../../messages/en')).default
const { ImportWizard } = await import('./ImportWizard')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const PROFILE = {
  industryKey: 'sim_atlas',
  profileId: 'sim-atlas',
  companyName: 'SIM Atlas',
  focus: ['Services'],
  templateReady: true,
  existingOrgId: null,
}

const script = {
  postStatus: 500,
  postBody: { error: 'sample-company-clone-failed', stage: 'clone' },
  resources: [] as { key: string; label: string; group: string }[],
  importRequests: [] as { mode?: string }[],
  importFailureMode: null as string | null,
}

function stubFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: BodyInit | null }) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/data/resources' && method === 'GET') {
      return Response.json({ resources: script.resources })
    }
    if (url === '/api/data/sample-companies' && method === 'GET') {
      return Response.json({ profiles: [PROFILE] })
    }
    if (url === '/api/data/sample-companies' && method === 'POST') {
      if (script.postStatus !== 200) {
        return new Response(JSON.stringify(script.postBody), {
          status: script.postStatus,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return Response.json({ ok: true, orgId: 'org-new', created: true, templateGenerated: false })
    }
    if (url === '/api/data/import' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { mode?: string }
      script.importRequests.push(body)
      if (body.mode === script.importFailureMode) return new Response('<html>upstream unavailable</html>', { status: 502 })
      if (body.mode === 'parse') {
        return Response.json({ headers: ['Name'], rows: [{ Name: 'Acme' }], mapping: { Name: 'name' }, fields: [{ key: 'name', label: 'Name', kind: 'text' }] })
      }
      if (body.mode === 'preview') {
        return Response.json({ outcome: { created: 1, updated: 0, failed: 0, errors: [] } })
      }
      return Response.json({ outcome: { created: 1, updated: 0, failed: 0, errors: [] } })
    }
    throw new Error(`unexpected fetch ${method} ${url}`)
  }) as typeof fetch
}

async function mountWizard(t: TestContext): Promise<void> {
  globalThis.__sampleTestRouter = { pushes: [] }
  globalThis.__sampleTestToasts = []
  globalThis.__sampleTestEnteredOrgs = []
  script.postStatus = 500
  script.postBody = { error: 'sample-company-clone-failed', stage: 'clone' }
  script.importRequests = []
  script.importFailureMode = null
  stubFetch()
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
        <BusinessDateProvider today="2026-09-23">
          <ImportWizard />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  await tick()
}

function sampleSelect(): HTMLSelectElement {
  const selects = [...document.querySelectorAll('select')] as HTMLSelectElement[]
  const select = selects.find((candidate) =>
    [...candidate.options].some((option) => option.value === 'sim_atlas'),
  )
  assert.ok(select, 'the sample-company picker must render with the SIM Atlas profile')
  return select
}

function createButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    /Create sample company|Opening|Preparing/.test((candidate.textContent ?? '').trim()),
  ) as HTMLButtonElement | undefined
  assert.ok(button, 'the sample-company create button must render')
  return button
}

async function clickCreate(): Promise<void> {
  await act(async () => {
    createButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  await tick()
}

function importAction(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent ?? '').includes(label),
  ) as HTMLButtonElement | undefined
  assert.ok(button, `the ${label} action must render`)
  return button
}

async function chooseImportSource(): Promise<void> {
  const resourceSelect = ([...document.querySelectorAll('select')] as HTMLSelectElement[]).find((candidate) =>
    [...candidate.options].some((option) => option.value === 'customers'),
  )
  assert.ok(resourceSelect, 'an import resource is available')
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(resourceSelect, 'customers')
    resourceSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Name\nAcme')
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    textarea.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}

async function clickImportAction(label: string): Promise<void> {
  const button = importAction(label)
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
}

test('a failed create shows a persistent inline error and keeps the selection', async (t) => {
  await mountWizard(t)
  assert.equal(sampleSelect().value, 'sim_atlas', 'the profile starts selected')
  await clickCreate()
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the failure must render a persistent inline error, not just a toast')
  assert.match(alert.textContent ?? '', /copying the template's posted history failed/)
  assert.match(alert.textContent ?? '', /Nothing was created; you can retry/)
  assert.equal(sampleSelect().value, 'sim_atlas', 'the failed attempt must keep the chosen company')
  assert.deepEqual(
    globalThis.__sampleTestEnteredOrgs,
    [],
    'the failed attempt must not enter any workspace',
  )
  assert.ok(
    (globalThis.__sampleTestToasts ?? []).some((toast) => toast.kind === 'error'),
    'the failure must still surface as an error toast',
  )
})

test('a subsequent success clears the error and enters the new company', async (t) => {
  await mountWizard(t)
  await clickCreate()
  assert.ok(document.querySelector('[role="alert"]'), 'the failure must render first')
  script.postStatus = 200
  await clickCreate()
  assert.equal(
    document.querySelector('[role="alert"]'),
    null,
    'a retry clears the persistent error on the next attempt',
  )
  assert.deepEqual(globalThis.__sampleTestEnteredOrgs, ['org-new'], 'success enters the new company')
  assert.ok(
    (globalThis.__sampleTestToasts ?? []).some(
      (toast) => toast.kind === 'success' && /Sample company is ready/.test(toast.message),
    ),
    'success must surface the ready confirmation',
  )
})

test('the wizard does not send a commit when retry-key session storage cannot persist', async (t) => {
  script.resources = [{ key: 'customers', label: 'Customers', group: 'Master data' }]
  const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('session storage is disabled')
    },
  })
  t.after(() => {
    if (original) Object.defineProperty(window, 'sessionStorage', original)
    else Reflect.deleteProperty(window, 'sessionStorage')
  })
  await mountWizard(t)

  const resourceSelect = ([...document.querySelectorAll('select')] as HTMLSelectElement[]).find((candidate) =>
    [...candidate.options].some((option) => option.value === 'customers'),
  )
  assert.ok(resourceSelect, 'an import resource is available')
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(resourceSelect, 'customers')
    resourceSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Name\nAcme')
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    textarea.dispatchEvent(new window.Event('change', { bubbles: true }))
  })

  const button = (label: string) => [...document.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent ?? '').includes(label),
  ) as HTMLButtonElement | undefined
  assert.ok(button('Continue') && !button('Continue')?.disabled, 'source data is ready to parse')
  await act(async () => {
    button('Continue')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  await act(async () => {
    button('Preview')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  await act(async () => {
    button('Import 1 rows')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })

  assert.deepEqual(script.importRequests.map(({ mode }) => mode), ['parse', 'preview'])
  assert.ok((globalThis.__sampleTestToasts ?? []).some(
    ({ kind, message }) => kind === 'error' && /browser could not save the import retry key, so no import was sent/.test(message),
  ))
})

test('a non-JSON parse refusal is shown by name instead of a JSON syntax error', async (t) => {
  script.resources = [{ key: 'customers', label: 'Customers', group: 'Master data' }]
  await mountWizard(t)
  script.importFailureMode = 'parse'
  await chooseImportSource()
  await clickImportAction('Continue')

  assert.deepEqual(script.importRequests.map(({ mode }) => mode), ['parse'])
  assert.ok((globalThis.__sampleTestToasts ?? []).some(
    ({ kind, message }) => kind === 'error' && /Could not read the import file\. \(status 502\)/.test(message),
  ))
})

test('a non-JSON preview refusal is shown by name instead of a JSON syntax error', async (t) => {
  script.resources = [{ key: 'customers', label: 'Customers', group: 'Master data' }]
  await mountWizard(t)
  script.importFailureMode = 'preview'
  await chooseImportSource()
  await clickImportAction('Continue')
  await clickImportAction('Preview')

  assert.deepEqual(script.importRequests.map(({ mode }) => mode), ['parse', 'preview'])
  assert.ok((globalThis.__sampleTestToasts ?? []).some(
    ({ kind, message }) => kind === 'error' && /Could not preview this import\. \(status 502\)/.test(message),
  ))
})
