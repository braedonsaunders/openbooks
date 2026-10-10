import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'
import { connectorSettings } from '@openbooks/engine/src/sync/connection-settings.ts'

await bootJsdomEnvironment({ url: 'http://localhost/sync', event: 'jsdom' })
const uiSource = new URL('../../../../packages/ui/src/index.ts', import.meta.url).href
registerHooks({ resolve(specifier, context, next) {
  return specifier === '@openbooks/ui' ? { shortCircuit: true, url: uiSource } : next(specifier, context)
} })
stubModules({ navigation: { pathname: '/sync' }, extra: {
  'next/link': 'export default function Link(p){return p.children}',
  sonner: 'export const toast={success(){},error(message){globalThis.__connectionErrors.push(String(message))}};export function Toaster(){return null}',
} })
const React = await import('react')
Object.assign(globalThis, { React, __connectionErrors: [] as string[] })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider, createTranslator } = await import('next-intl')
const { LOCALE_CODES } = await import('../../../i18n/config')
const messages = (await import('../../../messages/en')).default
const { ConnectionDrawer } = await import('./PlatformClient')
const { ConfirmRoot } = await import('../../../lib/confirm')
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const errorMessages = () => (globalThis as typeof globalThis & { __connectionErrors: string[] }).__connectionErrors

async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim().replace(/\s*\d+$/, '') === text)
  assert.ok(button, `missing ${text}`)
  await act(async () => { button.click(); await tick() })
}
async function fill(label: string, value: string) {
  const element = [...document.querySelectorAll('label')].find((element) => element.textContent === label)
  assert.ok(element, `missing ${label}`)
  const input = document.getElementById(element.htmlFor) as HTMLInputElement | HTMLSelectElement | HTMLButtonElement
  assert.ok(input, `${label} is associated with its control`)
  if (input.tagName === 'BUTTON') {
    await act(async () => { input.click(); await tick() })
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.trim() === value)
    assert.ok(option, `missing choice ${value}`)
    await act(async () => { option.click(); await tick() })
    assert.equal(input.textContent?.trim(), value, `${label} commits the selected choice`)
    return
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    await tick()
  })
}

const manifest = (source: string) => ({ source, displayName: source, authKind: 'token' as const, blurb: '',
  configFields: source === 'netsuite' ? [{ key: 'mappingJson', label: 'Legacy JSON', kind: 'textarea' as const }] : [],
  secretFields: [], ...connectorSettings(source),
})

test('structured connection mappings and content save and reopen without losing nested values or OAuth identity', async (t) => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  let editing = { id: 'connection-1', source: 'netsuite', displayName: 'Source account', authKind: 'token', status: 'active' as const,
    config: { realmId: 'callback-owned', mappingJson: JSON.stringify({ projectForemanField: 'custentity_foreman', projectStatuses: { 'In Progress': 'active' }, taxCodeFallbacks: { sales: '13' } }) } as Record<string, unknown>,
    mirrorEnabled: true, mirrorSchedule: 'daily', postedChangePolicy: 'review_required' as const,
    postedChangeAuthorizedAt: null, cursor: null, lastRunAt: null, lastError: null, hasSecrets: true }
  let saved: { config: Record<string, unknown> } | undefined
  const previousFetch = globalThis.fetch
  const reads: string[] = []
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes('/mapping-options?')) {
      reads.push(String(input))
      const query = new URL(String(input), 'http://localhost').searchParams
      const field = query.get('field')
      if (field === 'timeTypeMultiplierField') assert.equal(query.get('parent'), 'customrecord_time')
      const choices: Record<string, { value: string; label: string }[]> = {
        projectForemanField: [{ value: 'custentity_foreman', label: 'Foreman contact' }],
        timeTypeRecord: [{ value: 'customrecord_time', label: 'Time categories' }],
        timeTypeMultiplierField: [{ value: 'custrecord_multiplier', label: 'Multiplier' }],
        projectStatuses: [{ value: 'Completed', label: 'Completed' }],
      }
      return Response.json(choices[field ?? ''] ?? [])
    }
    assert.equal(String(input), '/api/platform/connections/connection-1'); assert.equal(init?.method, 'PATCH')
    saved = JSON.parse(String(init?.body)); return Response.json({ ok: true })
  }) as typeof fetch
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch })
  const show = (open: boolean) => root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC" onError={(error) => { throw error }}>
    <ConfirmRoot /><ConnectionDrawer open={open} onClose={() => {}} sourceTypes={[manifest('netsuite')]} currencies={[]} editing={editing} onSaved={() => {}} />
  </NextIntlClientProvider>)
  await act(async () => { show(false); await tick() })
  await act(async () => { show(true); await tick() })
  assert.equal(document.querySelector('textarea'), null, 'legacy mapping manifest never exposes raw JSON')
  await click('Mappings')
  assert.match(document.body.textContent ?? '', /Foreman contact/)
  assert.equal(document.querySelector('input[placeholder="Source field or record ID"]'), null, 'source fields use labeled choices rather than identifiers to type')
  await click('Time types')
  const child = [...document.querySelectorAll('label')].find((label) => label.textContent === 'Time-type multiplier')!
  assert.equal((document.getElementById(child.htmlFor) as HTMLInputElement).disabled, true)
  await fill('Time-type source record', 'Time categories')
  await fill('Time-type multiplier', 'Multiplier')
  await click('Projects')
  assert.match(document.body.textContent ?? '', /In Progress/)
  await fill('Source value', 'Completed')
  await fill('Native value', 'Closed')
  await click('Sync content')
  await click('Save changes')
  assert.equal(saved, undefined, 'unfinished mapping is never silently discarded or saved')
  assert.match(errorMessages().at(-1) ?? '', /Finish or discard/)
  await click('Time types'); await click('Projects')
  assert.equal((document.getElementById([...document.querySelectorAll('label')].find((label) => label.textContent === 'Source value')!.htmlFor) as HTMLButtonElement).textContent?.trim(), 'Completed', 'mapping draft survives both resource and drawer switches')
  await click('Add value mapping')
  await click('Sync content')
  const filesLabel = [...document.querySelectorAll('label')].find((label) => label.textContent === 'Sync transaction documents and files')!
  await act(async () => { (document.getElementById(filesLabel.htmlFor) as HTMLInputElement).click(); await tick() })
  await click('Save changes')
  assert.ok(saved, `save must send a request after completing the mapping: ${errorMessages().at(-1) ?? 'no refusal'}`)
  assert.equal(saved.config.realmId, undefined, 'callback identity is not edited')
  assert.deepEqual(saved.config.syncOptions, { attachments: false, projectFinancials: true, crm: true, fixedAssets: true })
  const mappings = saved.config.mappingJson as Record<string, unknown>
  assert.deepEqual(mappings.projectStatuses, { 'In Progress': 'active', Completed: 'closed' })
  assert.deepEqual(mappings.taxCodeFallbacks, { sales: '13' })
  assert.equal(mappings.timeTypeMultiplierField, 'custrecord_multiplier')
  editing = { ...editing, config: { ...saved.config, realmId: 'callback-owned' } }
  await act(async () => { show(false); await tick() })
  await act(async () => { show(true); await tick() })
  await click('Mappings'); await click('Time types')
  assert.equal((document.getElementById([...document.querySelectorAll('label')].find((label) => label.textContent === 'Time-type multiplier')!.htmlFor) as HTMLButtonElement).textContent?.trim(), 'Multiplier')
  assert.ok(reads.some((url) => url.includes('field=timeTypeMultiplierField&parent=customrecord_time')))
  await click('Sync content')
  assert.equal((document.getElementById([...document.querySelectorAll('label')].find((label) => label.textContent === 'Sync transaction documents and files')!.htmlFor) as HTMLInputElement).checked, false)
});

test('every connector uses the same content and mapping panels with truthful availability', async (t) => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()); host.remove() })
  for (const source of ['netsuite', 'odoo', 'erpnext', 'qbd', 'qbo', 'xero', 'dynamics']) {
    const show = (open: boolean) => root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <ConnectionDrawer open={open} onClose={() => {}} sourceTypes={[manifest(source)]} currencies={[]} presetSource={source} onSaved={() => {}} />
    </NextIntlClientProvider>)
    await act(async () => { show(false); await tick() })
    await act(async () => { show(true); await tick() })
    await click('Sync content')
    const choices = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    assert.equal(choices.length, 4)
    assert.equal(choices[0]!.disabled, source === 'qbd')
    assert.ok(choices.slice(1).every((choice) => choice.disabled === (source !== 'netsuite')))
    if (source === 'qbd') assert.match(document.body.textContent ?? '', /does not expose transaction file content/)
    assert.match(document.body.textContent ?? '', /Always included/)
    await click('Mappings')
    assert.equal(document.querySelector('textarea'), null)
    if (source !== 'netsuite') assert.match(document.body.textContent ?? '', /maps its supported records automatically/)
  }
});

test('every new drawer message resolves with real native translation and interpolation in every locale', async () => {
  function paths(value: unknown, prefix: string): string[] {
    if (typeof value === 'string') return [prefix]
    return Object.entries(value as Record<string, unknown>).flatMap(([key, value]) => paths(value, `${prefix}.${key}`))
  }
  const keys = ['drawer.tabsLabel', ...paths(messages.sync.drawer.tabs, 'drawer.tabs'), ...paths(messages.sync.drawer.syncContent, 'drawer.syncContent'), ...paths(messages.sync.drawer.mappings, 'drawer.mappings'), 'runs.stats.contentExcluded', 'drawer.structuredRequired']
  for (const locale of LOCALE_CODES) {
    const catalog = (await import(`../../../messages/${locale}/index.ts`)).default
    const t = createTranslator({ locale, messages: catalog, namespace: 'sync', onError: (error) => { throw error } })
    for (const key of keys) {
      const value = t(key, { parent: 'Source record', source: 'Completed', content: 'Files', value: 'Saved field' })
      assert.ok(value.trim(), `${locale}: ${key}`)
      assert.ok(!/[{}]/.test(value), `${locale}: ${key} must interpolate`)
    }
  }
});
