import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import './_dashboard-render-harness'
import { act, click, mountDashboard, scrolledIntoView, tick } from './_dashboard-render-harness'
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

// Palette adds once appended the widget at the bottom with no feedback —
// off-screen on a tall dashboard the click read as "nothing happened" — and
// a rapid double-click appended the widget twice, because the duplicate check
// ran on stale render state outside the state update. (Fleet-8 dx context.)

const LAYOUT: DashboardLayoutData = {
  widgets: [{ id: 'kpi-cash-balance', x: 0, y: 0, w: 3, h: 2 }],
};

async function mountGrid(layout: DashboardLayoutData = LAYOUT) {
  return mountDashboard(
    <DashboardGrid
      initialLayout={layout}
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
}

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

function rings(): Element[] {
  return [...document.querySelectorAll('.ring-teal-500')]
}

test('adding a widget scrolls it into view with a highlight', async () => {
  const { unmount } = await mountGrid()
  try {
    await click(paletteToggle()!)
    await click(paletteAdd('Journal lines')!)

    assert.equal(rings().length, 1, 'exactly the just-added cell carries the highlight ring')
    assert.equal(scrolledIntoView.length, 1, 'the just-added cell is brought into view')
    const scrolled = scrolledIntoView[0]
    assert.ok(
      scrolled instanceof HTMLElement && document.contains(scrolled),
      'the scrolled element is the mounted cell, not a detached node',
    )
    assert.ok(
      scrolled.innerHTML.includes('ring-teal-500'),
      'the cell brought into view is the highlighted one',
    )
  } finally {
    await unmount()
  }
})

test('a rapid double add appends the widget once', async () => {
  const { unmount } = await mountGrid()
  try {
    await click(paletteToggle()!)
    const add = paletteAdd('Journal lines')!
    // Both clicks land before React re-renders, so the outer presence guard
    // still sees the stale layout on the second click: only the check inside
    // the functional update can collapse them.
    await act(async () => {
      add.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      add.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await tick()
    })
    assert.equal(rings().length, 1, 'the double add collapses to a single cell')
  } finally {
    await unmount()
  }
})

test('already-placed widgets stay out of the picker and return on remove', async () => {
  const { unmount } = await mountGrid({
    widgets: [
      { id: 'kpi-cash-balance', x: 0, y: 0, w: 3, h: 2 },
      { id: 'kpi-journal-lines', x: 3, y: 0, w: 3, h: 2 },
    ],
  })
  try {
    await click(paletteToggle()!)
    assert.equal(
      paletteAdd('Journal lines'),
      undefined,
      'a placed widget is hidden from the picker',
    )

    const journalCell = [...document.querySelectorAll('div')].findLast(
      (el) => el.textContent === 'Journal tile',
    )
    const remove = journalCell?.parentElement?.querySelector(
      'button[aria-label="Remove widget"]',
    ) as HTMLButtonElement | null
    assert.ok(remove, 'each cell offers a remove control')
    await click(remove)
    assert.ok(
      paletteAdd('Journal lines'),
      'removing a widget re-offers it in the picker',
    )
  } finally {
    await unmount()
  }
})
