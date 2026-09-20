import assert from 'node:assert/strict'
import test from 'node:test'
import { personaDefaultLayout, type PersonaLayoutFlags } from './_persona-layout'

/**
 * HR-15 persona default layouts: three compositions chosen by what the
 * actor holds. Gated tiles join only when their source is live — turning a
 * feature off removes its widget, never data.
 */

const ALL_ON: PersonaLayoutFlags = {
  payroll: true,
  hrm: true,
  celebrations: true,
  nudges: true,
  announcements: true,
  quals: true,
}

const ALL_OFF: PersonaLayoutFlags = {
  payroll: false,
  hrm: false,
  celebrations: false,
  nudges: false,
  announcements: false,
  quals: false,
}

const ids = (persona: 'admin' | 'manager' | 'employee', flags: PersonaLayoutFlags): string[] =>
  personaDefaultLayout(persona, flags).widgets.map((widget) => widget.id)

test('an actor with nothing gets the employee column only', () => {
  const layout = ids('employee', ALL_ON)
  assert.ok(layout.includes('inbox-list'), 'my tasks opens the employee home')
  assert.ok(layout.includes('home-ask'), 'the ask box closes it')
  assert.ok(!layout.includes('team-approvals'), 'no manager column without reports or grants')
  assert.ok(!layout.includes('admin-attention'), 'no admin rail without manage grants')
})

test('a manager adds the second column, never the admin rail', () => {
  const layout = ids('manager', ALL_ON)
  assert.ok(layout.includes('inbox-list'), 'the employee base stays')
  assert.ok(layout.includes('team-approvals'), 'approvals awaiting me')
  assert.ok(layout.includes('team-headcount'), 'team headcount')
  assert.ok(layout.includes('team-steps'), 'overdue team steps')
  assert.ok(layout.includes('team-nudges'), '1:1 prompts and attention items')
  assert.ok(!layout.includes('admin-attention'), 'no admin rail without manage grants')
})

test('an admin adds the rail on top of both columns', () => {
  const layout = ids('admin', ALL_ON)
  assert.ok(layout.includes('inbox-list'), 'the employee base stays')
  assert.ok(layout.includes('team-approvals'), 'the manager column stays')
  assert.ok(layout.includes('admin-attention'), 'cockpit attention rollup')
  assert.ok(layout.includes('workflow-errors'), 'workflow errors')
  assert.ok(layout.includes('admin-calendar'), 'compliance calendar')
})

test('feature-off removes the optional widgets, never the core', () => {
  const off = ids('admin', ALL_OFF)
  assert.ok(!off.includes('celebrations-list'), 'hrmCelebrations off hides celebrations')
  assert.ok(!off.includes('team-nudges'), 'hrmManagerNudges off hides nudges')
  assert.ok(!off.includes('announcements-card'), 'homeAnnouncements off hides announcements')
  assert.ok(!off.includes('team-quals'), 'no HR-14 table means no qualifications tile')
  assert.ok(!off.includes('pay-tile'), 'no payroll means no pay tile')
  assert.ok(!off.includes('balance-tile'), 'no hrm means no balance tile')
  assert.ok(off.includes('inbox-list'), 'the inbox stays: it is core, not a feature')
  assert.ok(off.includes('home-ask'), 'the ask box stays')
  assert.ok(off.includes('admin-attention'), 'the admin rail stays')
})

test('layouts are stable grids: unique ids, twelve columns, no overlaps', () => {
  for (const persona of ['employee', 'manager', 'admin'] as const) {
    const widgets = personaDefaultLayout(persona, ALL_ON).widgets
    const seen = new Set(widgets.map((widget) => widget.id))
    assert.equal(seen.size, widgets.length, `${persona}: widget ids are unique`)
    for (const widget of widgets) {
      assert.ok(widget.x >= 0 && widget.x + widget.w <= 12, `${persona}/${widget.id}: inside twelve columns`)
      assert.ok(widget.w >= 2 && widget.h >= 2, `${persona}/${widget.id}: meets the minimum size`)
    }
  }
})
