import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { dataTransferJob } from '../../../../testing/data-transfer'

// a failed sample-company create must leave a persistent inline error
// beside the company picker (not just a transient toast), keep the
// operator's chosen company and profile, and clear the error on the next
// attempt — retry is safe because nothing was created.

declare global {
  var __sampleTestRouter: { pushes: string[] } | undefined
  var __sampleTestToasts: { kind: string; message: string }[] | undefined
  var __sampleTestEnteredOrgs: string[] | undefined
}

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/data/import', scrollIntoView: false, resizeObserver: false })

const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({
  navigation: {
    pathname: '/data/import',
    routerSource: 'export function useRouter(){return {push(url){globalThis.__sampleTestRouter.pushes.push(String(url))}}}',
  },
})
registerHooks({
  resolve(specifier, context, next) {

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

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const messages = (await import('../../../../messages/en')).default
const { ImportWizard } = await import('./ImportWizard')
const { SampleCompanyPicker } = await import('../../../../components/sample-company-picker')

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
  sampleGets: 0,
  postStatus: 500,
  postBody: { error: 'sample-company-clone-failed', stage: 'clone' },
  resources: [] as { key: string; label: string; group: string; supportsImport?: boolean }[],
  importRequests: [] as { mode?: string }[],
  importFailureMode: null as string | null,
  job: dataTransferJob(),
}

function stubFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: BodyInit | null }) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/data/resources' && method === 'GET') {
      return Response.json({ resources: script.resources })
    }
    if (url === '/api/data/sample-companies' && method === 'GET') {
      script.sampleGets += 1
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
    if (url === '/api/data/transfers' && method === 'GET') return Response.json({ jobs: [] })
    if (url === '/api/data/transfers' && method === 'POST') {
      script.importRequests.push({ mode: 'parse' })
      if (script.importFailureMode === 'parse') return new Response('<html>upstream unavailable</html>', { status: 502 })
      const body = JSON.parse(String(init?.body))
      script.job = dataTransferJob({ resource: body.resource, format: body.format, filename: body.filename, bytes: body.bytes })
      return Response.json({ job: script.job })
    }
    if (url.includes('/chunks/') && method === 'PUT') {
      script.job = { ...script.job, uploadedBytes: script.job.bytes }
      return Response.json({ job: script.job })
    }
    if (url.startsWith('/api/data/transfers/') && method === 'GET') {
      if (script.job.state === 'parsing') script.job = { ...script.job, state: 'mapping', totalRows: 1, processedRows: 0 }
      if (script.job.state === 'previewing') script.job = { ...script.job, state: 'ready', processedRows: 1, approvalHash: 'approved-source', preview: { created: 1, updated: 0, failed: 0, errors: [] } }
      if (script.job.state === 'committing') script.job = { ...script.job, state: 'completed', processedRows: 1, outcome: { created: 1, updated: 0, failed: 0, errors: [] } }
      return Response.json({ job: script.job })
    }
    if (url.startsWith('/api/data/transfers/') && method === 'POST') {
      const body = JSON.parse(String(init?.body))
      if (body.action === 'preview' || body.action === 'commit') {
        script.importRequests.push({ mode: body.action })
        if (body.action === script.importFailureMode) return new Response('<html>upstream unavailable</html>', { status: 502 })
      }
      script.job = { ...script.job, revision: script.job.revision + 1,
        state: body.action === 'finish-upload' ? 'parsing' : body.action === 'preview' ? 'previewing' : 'committing',
        options: body.options ?? script.job.options }
      return Response.json({ job: script.job })
    }
    throw new Error(`unexpected fetch ${method} ${url}`)
  }) as typeof fetch
}

async function mountWizard(t: TestContext, sample = false, back?: { backHref: string; backLabel: string }): Promise<void> {
  globalThis.__sampleTestRouter = { pushes: [] }
  globalThis.__sampleTestToasts = []
  globalThis.__sampleTestEnteredOrgs = []
  script.sampleGets = 0
  script.postStatus = 500
  script.postBody = { error: 'sample-company-clone-failed', stage: 'clone' }
  script.importRequests = []
  script.importFailureMode = null
  window.history.replaceState(null, '', '/data/import')
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
          {sample ? <SampleCompanyPicker /> : <ImportWizard {...back} />}
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
  assert.ok(resourceSelect, 'an import resource is available'); assert.equal((document.querySelector('textarea') as HTMLTextAreaElement)?.placeholder, '')
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
  for (let attempt = 0; attempt < 120; attempt++) {
    const ready = [...document.querySelectorAll('button')].find((item) => (item.textContent ?? '').includes(label) && !item.disabled)
    if (ready) break
    await act(async () => { await tick() })
  }
  const button = importAction(label)
  assert.equal(button.disabled, false)
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
}

test('a failed create shows a persistent inline error and keeps the selection', async (t) => {
  await mountWizard(t, true)
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
  await mountWizard(t, true)
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

test('the durable server job preserves retry identity when session storage is unavailable', async (t) => {
  script.resources = [{ key: 'customers', label: 'Customers', group: 'Master data', supportsImport: true }]
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

  assert.equal(script.sampleGets, 0, 'file imports never load sample-company provisioning')
  assert.equal(document.querySelector('#sample-companies'), null)
  await chooseImportSource()

  await clickImportAction('Continue')
  await clickImportAction('Preview')
  await clickImportAction('Import 1 row')
  assert.deepEqual(script.importRequests.map(({ mode }) => mode), ['parse', 'preview', 'commit'])
  assert.equal(new URL(window.location.href).searchParams.get('transfer'), script.job.id)
  assert.equal(document.querySelector('[role="alert"]'), null)

})

for (const stage of [
  { mode: 'parse' as const, clicks: ['Continue'], requests: ['parse'], error: /The transfer request could not be completed\. \(status 502\)/ },
  { mode: 'preview' as const, clicks: ['Continue', 'Preview'], requests: ['parse', 'preview'], error: /The transfer request could not be completed\. \(status 502\)/ },
]) {
  test(`a non-JSON ${stage.mode} refusal is shown by name instead of a JSON syntax error`, async (t) => {
    script.resources = [{ key: 'customers', label: 'Customers', group: 'Master data', supportsImport: true }]
    await mountWizard(t)
    script.importFailureMode = stage.mode
    await chooseImportSource()
    for (const label of stage.clicks) await clickImportAction(label)

    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', stage.error)
    assert.deepEqual(script.importRequests.map(({ mode }) => mode), stage.requests)
    assert.doesNotMatch(document.querySelector('[role="alert"]')?.textContent ?? '', /Unexpected token|JSON syntax/)
  })
}


test('the import header returns to Company Settings instead of history', async (t) => {
  await mountWizard(t, false, { backHref: '/admin/setup/company', backLabel: 'Company Settings' })
  const back = document.querySelector<HTMLAnchorElement>('a[href="/admin/setup/company"]')
  assert.ok(back)
  assert.match(back.textContent ?? '', /Company Settings/)
  assert.equal(document.querySelector('a[href="/data/import/history"]'), null)
})
