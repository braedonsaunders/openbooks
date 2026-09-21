import type { DashboardLayoutData } from '@openbooks/schema'
export type Persona = 'admin' | 'manager' | 'employee'

export interface PersonaLayoutFlags {
  payroll: boolean
  hrm: boolean
  celebrations: boolean
  nudges: boolean
  announcements: boolean
  quals: boolean
}

/**
 * Default dashboard layouts per persona. Gated tiles are included only
 * when their source is live — a tile with nothing true to say never ships
 * in the default. Users who customized keep their layout (see
 * _load-layout.ts); everyone else recomputes this on every load.
 */
export function personaDefaultLayout(persona: Persona, flags: PersonaLayoutFlags): DashboardLayoutData {
  type Cell = DashboardLayoutData['widgets'][number]
  const widgets: Cell[] = [
    // Quick actions leads the board. It is a shipped, documented widget
    // with its own customizer and save path, and the persona layouts were
    // written fresh without it -- so every user's home silently lost it.
    // Restored at the top, where an at-hand action list belongs, with the
    // rest of the board shifted down by its height.
    { id: 'personal-actions', x: 0, y: 0, w: 12, h: 3 },
    { id: 'inbox-list', x: 0, y: 3, w: 7, h: 5 },
    ...(flags.payroll ? [{ id: 'pay-tile', x: 7, y: 3, w: 5, h: 2 }] as Cell[] : []),
    ...(flags.hrm ? [{ id: 'balance-tile', x: 7, y: 5, w: 5, h: 3 }] as Cell[] : []),
    ...(flags.hrm ? [{ id: 'whos-out-strip', x: 0, y: 8, w: 6, h: 4 }] as Cell[] : []),
    ...(flags.payroll || flags.hrm ? [{ id: 'home-upcoming', x: 6, y: 8, w: 6, h: 4 }] as Cell[] : []),
    ...(flags.celebrations ? [{ id: 'celebrations-list', x: 0, y: 12, w: 6, h: 4 }] as Cell[] : []),
    ...(flags.announcements ? [{ id: 'announcements-card', x: 6, y: 12, w: 6, h: 4 }] as Cell[] : []),
    { id: 'home-ask', x: 0, y: 16, w: 12, h: 3 },
  ]
  if (persona === 'manager' || persona === 'admin') {
    widgets.push(
      { id: 'team-approvals', x: 0, y: 19, w: 7, h: 5 },
      ...(flags.hrm ? [{ id: 'team-headcount', x: 7, y: 19, w: 5, h: 2 }] as Cell[] : []),
      ...(flags.hrm ? [{ id: 'team-steps', x: 7, y: 21, w: 5, h: 3 }] as Cell[] : []),
      ...(flags.nudges ? [{ id: 'team-nudges', x: 0, y: 24, w: 12, h: 4 }] as Cell[] : []),
      ...(flags.quals ? [{ id: 'team-quals', x: 0, y: 28, w: 12, h: 4 }] as Cell[] : []),
    )
  }
  if (persona === 'admin') {
    widgets.push(
      { id: 'admin-attention', x: 0, y: 32, w: 6, h: 5 },
      { id: 'workflow-errors', x: 6, y: 32, w: 3, h: 2 },
      { id: 'admin-calendar', x: 9, y: 32, w: 3, h: 4 },
    )
  }
  return { widgets }
}
