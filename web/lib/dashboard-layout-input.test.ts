import assert from 'node:assert/strict'
import test from 'node:test'
import { filterPersistableDashboardWidgets } from '../app/(app)/dashboard/_layout-input'

const position = { x: 0, y: 0, w: 4, h: 3 }

test('dashboard layouts persist only app widgets from the live org allowlist', () => {
  const widgets = [
    { id: 'app:installed-app', ...position },
    { id: 'app:another-org-app', ...position },
    { id: 'app:../invalid', ...position },
  ]

  assert.deepEqual(
    filterPersistableDashboardWidgets(widgets, {
      allowedAppWidgetIds: new Set(['app:installed-app']),
    }),
    [{ id: 'app:installed-app', ...position }],
  )
})
