import assert from 'node:assert/strict'
import test from 'node:test'
import type { DashboardLayoutData } from '@openbooks/schema'
import {
  DEFAULT_QUICK_ACTIONS,
  mergeQuickActionsSave,
} from '../app/(app)/dashboard/_quick-actions-shared'

const GRID = [
  { id: 'kpi-cash-balance', x: 0, y: 0, w: 3, h: 2 },
  { id: 'personal-actions', x: 0, y: 2, w: 12, h: 3 },
]

/**
 * A quick-actions save must never wipe the widget grid. A fresh tenant has
 * no stored row, so there is no grid to retain — the save must seed the
 * shipped default grid instead of persisting an empty one (which blanked
 * the dashboard on the next read).
 */
test('quick-actions save seeds the default grid when nothing is stored', () => {
  const incoming = DEFAULT_QUICK_ACTIONS.slice(0, 2)
  const empties: Array<DashboardLayoutData['widgets'] | null | undefined> = [null, undefined, []]
  for (const existingWidgets of empties) {
    const layout = mergeQuickActionsSave({
      existingWidgets,
      existingQuickActions: null,
      incoming,
      hiddenIds: new Set(),
      defaultWidgets: GRID,
    })
    assert.deepEqual(layout.widgets, GRID)
    assert.deepEqual(layout.quickActions, incoming)
  }
})

test('quick-actions save retains a stored grid and preserves hidden actions', () => {
  const stored = [...GRID, { id: 'list-recent-entries', x: 0, y: 5, w: 12, h: 5 }]
  const hiddenKept = { id: 'd-reports', label: 'Reports', href: '/reports', iconKey: 'chart', tone: 'slate' }
  const visible = { id: 'd-journal', labelKey: 'newJournalEntry', href: '/journal', iconKey: 'journal', tone: 'teal' }
  const layout = mergeQuickActionsSave({
    existingWidgets: stored,
    existingQuickActions: [visible, hiddenKept],
    incoming: [visible],
    hiddenIds: new Set(['d-reports']),
    defaultWidgets: GRID,
  })
  assert.deepEqual(layout.widgets, stored)
  // normalizeQuickActions stamps labelKey: undefined on non-curated rows.
  assert.deepEqual(layout.quickActions, [visible, { ...hiddenKept, labelKey: undefined }])
})
