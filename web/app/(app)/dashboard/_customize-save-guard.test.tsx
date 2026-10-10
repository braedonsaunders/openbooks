import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import './_dashboard-render-harness'
import { click, mountDashboard } from './_dashboard-render-harness'
import type { DashboardLayoutData } from '@openbooks/schema'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims (css/dynamic/actions/sonner/next-link).
const { DashboardGrid } = await import('./_dashboard-grid')

const dir = dirname(fileURLToPath(import.meta.url));
const dashboardEn = JSON.parse(
  readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'dashboard.json'), 'utf8'),
);
const appsEn = JSON.parse(
  readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'apps.json'), 'utf8'),
);
const commonEn = JSON.parse(
  readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'common.json'), 'utf8'),
);
const messages = { dashboard: dashboardEn, apps: appsEn, common: commonEn };

// The customize draft must survive the widget picker: its drawer backdrop
// covers the header toolbar, so Save has to answer from inside the picker,
// and tab-close has to name the unsaved draft instead of a blank prompt.

const LAYOUT: DashboardLayoutData = {
  widgets: [{ id: 'kpi-cash-balance', x: 0, y: 0, w: 3, h: 2 }],
};

function paletteToggle(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Add widget',
  ) as HTMLButtonElement | undefined
}

function paletteAdd(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

function pickerFooterSave(): HTMLButtonElement | null {
  return document.querySelector('[role="dialog"] footer button')
}

function routerPushes(): string[] {
  return (globalThis as unknown as { __dashRouter: { pushes: string[] } }).__dashRouter.pushes
}

function toastKinds(): string[] {
  return (globalThis as unknown as { __dashToasts: { kind: string }[] }).__dashToasts.map((t) => t.kind)
}

test('saving works with the widget picker open', async () => {
  let saves = 0
  const { unmount } = await mountDashboard(
    <DashboardGrid
      initialLayout={LAYOUT}
      nodes={{
        'kpi-cash-balance': <div>Cash tile</div>,
        'kpi-journal-lines': <div>Journal tile</div>,
      }}
      role="admin"
      mode="edit"
      libraryCards={[]}
      apps={[]}
      allowedWidgetIds={new Set(['kpi-cash-balance', 'kpi-journal-lines'])}
      saveLayoutAction={async () => { saves += 1; return { ok: true } }}
      resetLayoutAction={async () => ({ ok: true })}
    />,
    messages,
  )
  try {
    await click(paletteToggle()!)
    await click(paletteAdd('Journal lines')!)
    assert.ok(document.querySelector('[role="dialog"]'), 'the picker is open over the toolbar')
    const save = pickerFooterSave()
    assert.ok(save, 'the open picker offers its own Save')
    assert.equal(save.disabled, false, 'the picker Save is enabled with a dirty draft')
    await click(save)
    assert.equal(saves, 1, 'the picker Save persists the draft, backdrop notwithstanding')
    assert.ok(toastKinds().includes('success'), 'the operator sees the save succeed')
    assert.ok(routerPushes().includes('/'), 'a saved draft leaves customize like the toolbar Save')
  } finally {
    await unmount()
  }
})

test('the picker Save stays disabled on a clean draft', async () => {
  const { unmount } = await mountDashboard(
    <DashboardGrid
      initialLayout={LAYOUT}
      nodes={{ 'kpi-cash-balance': <div>Cash tile</div> }}
      role="admin"
      mode="edit"
      libraryCards={[]}
      apps={[]}
      allowedWidgetIds={new Set(['kpi-cash-balance', 'kpi-journal-lines'])}
      saveLayoutAction={async () => ({ ok: true })}
      resetLayoutAction={async () => ({ ok: true })}
    />,
    messages,
  )
  try {
    await click(paletteToggle()!)
    const save = pickerFooterSave()
    assert.ok(save, 'the open picker offers its own Save')
    assert.equal(save.disabled, true, 'nothing to save yet, like the toolbar Save')
  } finally {
    await unmount()
  }
})

type BeforeUnloadListener = (event: { preventDefault(): void; returnValue: string }) => void

function captureBeforeUnload(): { listeners: BeforeUnloadListener[]; restore(): void } {
  const listeners: BeforeUnloadListener[] = []
  const original = window.addEventListener.bind(window)
  window.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
    if (type === 'beforeunload') listeners.push(listener as unknown as BeforeUnloadListener)
    return original(type, listener, options)
  }) as typeof window.addEventListener
  return { listeners, restore() { window.addEventListener = original } }
}

test('tab close names the unsaved draft instead of a blank prompt', async () => {
  const capture = captureBeforeUnload()
  const { unmount } = await mountDashboard(
    <DashboardGrid
      initialLayout={LAYOUT}
      nodes={{
        'kpi-cash-balance': <div>Cash tile</div>,
        'kpi-journal-lines': <div>Journal tile</div>,
      }}
      role="admin"
      mode="edit"
      libraryCards={[]}
      apps={[]}
      allowedWidgetIds={new Set(['kpi-cash-balance', 'kpi-journal-lines'])}
      saveLayoutAction={async () => ({ ok: true })}
      resetLayoutAction={async () => ({ ok: true })}
    />,
    messages,
  )
  try {
    await click(paletteToggle()!)
    await click(paletteAdd('Journal lines')!)
    assert.ok(capture.listeners.length > 0, 'a dirty draft traps tab close')
    const event = { preventDefault() {}, returnValue: '' }
    capture.listeners[capture.listeners.length - 1]!(event)
    assert.equal(
      event.returnValue,
      commonEn.feedback.unsavedChanges,
      'the prompt names what leaving would lose',
    )
  } finally {
    await unmount()
    capture.restore()
  }
})

test('a clean draft registers no tab-close trap', async () => {
  const capture = captureBeforeUnload()
  const { unmount } = await mountDashboard(
    <DashboardGrid
      initialLayout={LAYOUT}
      nodes={{ 'kpi-cash-balance': <div>Cash tile</div> }}
      role="admin"
      mode="edit"
      libraryCards={[]}
      apps={[]}
      allowedWidgetIds={new Set(['kpi-cash-balance', 'kpi-journal-lines'])}
      saveLayoutAction={async () => ({ ok: true })}
      resetLayoutAction={async () => ({ ok: true })}
    />,
    messages,
  )
  try {
    assert.equal(capture.listeners.length, 0, 'nothing unsaved, nothing trapped')
  } finally {
    await unmount()
    capture.restore()
  }
})
