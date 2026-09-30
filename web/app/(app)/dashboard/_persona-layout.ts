import type { DashboardLayoutData } from '@openbooks/schema'
import { packDefaultLayout } from './_default-layout'
export type Persona = 'admin' | 'manager' | 'employee'

export interface PersonaLayoutFlags {
  payroll: boolean
  hrm: boolean
  announcements: boolean
  quals: boolean
}

/**
 * Default dashboard layouts per persona. Gated tiles are included only
 * when their source is live — a tile with nothing true to say never ships
 * in the default. Celebrations and manager nudges ride Human resources;
 * tenants place or drop them through dashboard layouts, never a switch.
 * Users who customized keep their layout (see _load-layout.ts); everyone
 * else recomputes this on every load.
 */
export function personaDefaultLayout(persona: Persona, flags: PersonaLayoutFlags): DashboardLayoutData {
  const ids = [
    'inbox-list',
    ...(persona === 'admin' ? ['admin-attention'] : []),
    ...(persona !== 'employee' ? ['team-approvals'] : []),
    ...(flags.payroll ? ['pay-tile'] : []),
    ...(flags.hrm ? ['balance-tile', 'whos-out-strip'] : []),
    ...(flags.payroll || flags.hrm ? ['home-upcoming'] : []),
    ...(flags.announcements ? ['announcements-card'] : []),
    ...(flags.hrm ? ['celebrations-list'] : []),
    ...(persona !== 'employee' && flags.hrm ? ['team-headcount', 'team-steps', 'team-nudges'] : []),
    ...(persona !== 'employee' && flags.quals ? ['team-quals'] : []),
    ...(persona === 'admin' ? ['workflow-errors', 'admin-calendar'] : []),
    'home-ask',
  ]
  return packDefaultLayout({ widgets: [
    { id: 'personal-actions', x: 0, y: 0, w: 12, h: 2 },
    ...ids.map((id) => ({ id, x: 0, y: 0, w: 6, h: 3 })),
  ] })
}
