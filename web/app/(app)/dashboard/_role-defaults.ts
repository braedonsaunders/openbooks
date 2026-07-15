import type { DashboardLayoutData } from '@openbooks/schema'
import type { RoleTier } from './_role-tier'

export const DEFAULT_LAYOUTS: Record<RoleTier, DashboardLayoutData> = {
  admin: {
    widgets: [
      { id: 'kpi-journal-entries', x: 0, y: 0, w: 3, h: 2 },
      { id: 'kpi-journal-lines', x: 3, y: 0, w: 3, h: 2 },
      { id: 'kpi-accounts-active', x: 6, y: 0, w: 3, h: 2 },
      { id: 'kpi-parties', x: 9, y: 0, w: 3, h: 2 },
      { id: 'personal-actions', x: 0, y: 2, w: 12, h: 2 },
      { id: 'kpi-pending-approvals', x: 0, y: 4, w: 3, h: 2 },
      { id: 'kpi-ledger-balance', x: 3, y: 4, w: 3, h: 2 },
      { id: 'kpi-entries-today', x: 6, y: 4, w: 3, h: 2 },
      { id: 'list-recent-entries', x: 0, y: 6, w: 6, h: 5 },
      { id: 'list-pending-approvals', x: 6, y: 6, w: 6, h: 5 },
    ],
  },
  controller: {
    widgets: [
      { id: 'kpi-journal-entries', x: 0, y: 0, w: 3, h: 2 },
      { id: 'kpi-accounts-active', x: 3, y: 0, w: 3, h: 2 },
      { id: 'kpi-pending-approvals', x: 6, y: 0, w: 3, h: 2 },
      { id: 'kpi-ledger-balance', x: 9, y: 0, w: 3, h: 2 },
      { id: 'personal-actions', x: 0, y: 2, w: 12, h: 2 },
      { id: 'list-recent-entries', x: 0, y: 4, w: 6, h: 5 },
      { id: 'list-pending-approvals', x: 6, y: 4, w: 6, h: 5 },
      { id: 'personal-inbox', x: 0, y: 9, w: 12, h: 5 },
    ],
  },
  accountant: {
    widgets: [
      { id: 'kpi-journal-entries', x: 0, y: 0, w: 3, h: 2 },
      { id: 'kpi-accounts-active', x: 3, y: 0, w: 3, h: 2 },
      { id: 'kpi-parties', x: 6, y: 0, w: 3, h: 2 },
      { id: 'kpi-entries-today', x: 9, y: 0, w: 3, h: 2 },
      { id: 'personal-actions', x: 0, y: 2, w: 12, h: 2 },
      { id: 'list-recent-entries', x: 0, y: 4, w: 12, h: 5 },
      { id: 'personal-in-progress', x: 0, y: 9, w: 12, h: 5 },
    ],
  },
  approver: {
    widgets: [
      { id: 'personal-actions', x: 0, y: 0, w: 12, h: 2 },
      { id: 'kpi-pending-approvals', x: 0, y: 2, w: 3, h: 2 },
      { id: 'personal-inbox', x: 0, y: 4, w: 6, h: 5 },
      { id: 'list-pending-approvals', x: 6, y: 4, w: 6, h: 5 },
    ],
  },
  viewer: {
    widgets: [
      { id: 'kpi-journal-entries', x: 0, y: 0, w: 3, h: 2 },
      { id: 'kpi-accounts-active', x: 3, y: 0, w: 3, h: 2 },
      { id: 'kpi-parties', x: 6, y: 0, w: 3, h: 2 },
      { id: 'kpi-ledger-balance', x: 9, y: 0, w: 3, h: 2 },
      { id: 'list-recent-entries', x: 0, y: 2, w: 12, h: 5 },
    ],
  },
}
