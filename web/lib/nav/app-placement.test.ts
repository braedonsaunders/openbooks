import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * App placement: installing an app must not implicitly place it in
 * organization navigation (unlike record types, which appear via
 * show_in_nav). An app reaches the sidebar only through an explicit
 * `{ kind: 'app' }` shortcut in the saved config, resolved against its
 * install row — and removing that shortcut uninstalls nothing.
 */

const navKey = Symbol.for('openbooks.nav-app-placement-test')
const navState: { configRows: Array<{ config: unknown }>; appRows: Array<Record<string, unknown>> } = {
  configRows: [],
  appRows: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[navKey] = navState

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@openbooks/engine/src/extensions/projections.ts') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function listActiveExtensionContributions() { return [] }',
      }
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`
          const state = globalThis[Symbol.for('openbooks.nav-app-placement-test')]
          const sqlText = ${sqlText.toString()}
          export const db = {
            async execute(query) {
              const text = sqlText(query)
              if (text.includes('from org_nav_configs')) return { rows: state.configRows }
              if (text.includes('from apps a')) return { rows: state.appRows }
              return { rows: [] }
            },
          }
        `)}`,
      }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter() { return { refresh() {} } }',
      }
    }
    if (specifier === 'next-intl') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useTranslations() { const t = (key) => key; t.has = () => true; return t }',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast = { error() {}, success() {} }',
      }
    }
    return nextResolve(specifier, context)
  },
})

const { resolveNav } = await import('./resolve.ts')
const { defaultNavConfig } = await import('./registry.ts')

const REPORTER = { key: 'reporter', name: 'Reporter', iconKey: 'chart' }
const t = (key: string) => key

function hrefs(groups: Array<{ items: Array<{ href?: string }> }>): string[] {
  return groups.flatMap((group) => group.items.map((item) => item.href ?? ''))
}

test('installing an app does not place it in organization navigation', async () => {
  navState.configRows = []
  navState.appRows = [{ ...REPORTER }]

  const groups = await resolveNav('org-1', () => true, [], t)
  assert.ok(groups.length > 0, 'the default workspace still resolves')
  assert.ok(
    hrefs(groups).every((href) => !href.startsWith('/apps/')),
    'an installed app with no explicit shortcut stays out of the sidebar',
  )
})

test('an explicitly placed app shortcut resolves against its install', async () => {
  const config = defaultNavConfig()
  config.groups[0]!.items.push({ kind: 'app', appKey: 'reporter' })
  navState.configRows = [{ config }]
  navState.appRows = [{ ...REPORTER }]

  const groups = await resolveNav('org-1', () => true, [], t)
  const placed = groups
    .flatMap((group) => group.items)
    .find((item) => item.href === '/apps/reporter')
  assert.ok(placed, 'the explicit shortcut resolves to the installed app')
  assert.equal(placed.label, 'Reporter')
})

// --- NavEditor removal (jsdom + the real component and design system) ---

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost:4800/' })
const editorGlobals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (editorGlobals[key] === undefined) editorGlobals[key] = domWindow[key]
}
if (typeof (dom.window as unknown as { matchMedia?: unknown }).matchMedia !== 'function') {
  ;(dom.window as unknown as Record<string, unknown>).matchMedia = () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false
    },
  })
}
{
  const calls: Array<{ url: string; init: RequestInit }> = []
  ;(editorGlobals as Record<symbol, unknown>)[Symbol.for('openbooks.nav-editor-fetch-calls')] = calls
  editorGlobals.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return { ok: true, json: async () => ({}) }
  }) as typeof fetch
}
function fetchCalls(): Array<{ url: string; init: RequestInit }> {
  return (editorGlobals as Record<symbol, unknown>)[
    Symbol.for('openbooks.nav-editor-fetch-calls')
  ] as Array<{ url: string; init: RequestInit }>
}

;(editorGlobals as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NavEditor } = await import('../../app/(app)/admin/navigation/NavEditor.tsx')
hooks.deregister()

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function editorConfig() {
  const config = defaultNavConfig()
  config.groups[0]!.items.push({ kind: 'app', appKey: 'reporter' })
  return config
}

async function mountEditor() {
  fetchCalls().length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      React.createElement(NavEditor, {
        initial: editorConfig(),
        apps: [{ ...REPORTER }],
      }),
    )
    await tick()
  })
  await tick()
  return {
    host,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

function removeAppButton(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector('button[aria-label="removeApp"]')
}

function appRow(host: HTMLElement): boolean {
  return [...host.querySelectorAll('span')].some((el) => el.textContent === 'app:Reporter')
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new (dom.window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
}

test('removing an app shortcut keeps the app installed and saves without uninstalling', async (t) => {
  const { host, unmount } = await mountEditor()
  t.after(unmount)
  assert.ok(appRow(host), 'the placed shortcut renders before removal')

  const remove = removeAppButton(host)
  assert.ok(remove, 'an app shortcut offers removal')
  await click(remove)
  assert.ok(!appRow(host), 'removal drops the shortcut row')

  assert.ok(
    host.querySelector('option[value="reporter"]'),
    'the removed app stays installed and offerable — removal uninstalls nothing',
  )

  const save = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'save')
  assert.ok(save, 'the editor offers save')
  await click(save)
  const calls = fetchCalls()
  assert.equal(calls.length, 1, 'saving persists once')
  assert.equal(calls[0]!.init.method, 'PUT')
  assert.ok(!calls.some((call) => call.init.method === 'DELETE'), 'shortcut removal never uninstalls the app')
  const saved = JSON.parse(String(calls[0]!.init.body)) as {
    config: { groups: Array<{ items: Array<{ kind?: string }> }> }
  }
  assert.ok(
    saved.config.groups.every((group) => group.items.every((item) => item.kind !== 'app')),
    'the saved config carries no app shortcut',
  )
})
