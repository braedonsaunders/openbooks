import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The subject map is pure over the document-kinds registry, but its module
// shares imports with the DB-backed authz layer — stub server-only and
// authz, and keep the REAL map plus the REAL document-kinds registry. A
// stubbed map would make every assertion below hollow.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { url: 'mock:flow-subject-authz-server-only', shortCircuit: true }
    }
    if (
      specifier === './authz' &&
      context.parentURL?.endsWith('/web/lib/flow-subject-authz.ts')
    ) {
      return { url: 'mock:flow-subject-authz-authz', shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:flow-subject-authz-server-only') {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    if (url === 'mock:flow-subject-authz-authz') {
      return {
        format: 'module',
        source: `export function can() { throw new Error('no permission check in this test') }`,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const {
  documentRouteReadPermission,
  flowSubjectPermissions,
  manualButtonPermission,
} = await import('./flow-subject-authz.ts')
hooks.deregister()

import type { AutomationPlan } from '@openbooks/forms-core'

/** A plan carrying just the given action kinds (plus change_status targets). */
function plan(
  actions: Array<{ action: string; to?: string }>,
  gates = 0,
): AutomationPlan {
  return {
    actions,
    actionNodes: [],
    gates: Array.from({ length: gates }, (_, i) => ({ nodeId: `gate-${i}` })),
  } as unknown as AutomationPlan
}

test('registry document kinds resolve through the document-kinds map', () => {
  assert.deepEqual(flowSubjectPermissions('vendor_bill'), {
    read: 'ap.read',
    edit: 'ap.create',
    approve: 'ap.post',
  })
  assert.deepEqual(flowSubjectPermissions('customer_invoice'), {
    read: 'ar.read',
    edit: 'ar.create',
    approve: 'ar.post',
  })
  assert.deepEqual(flowSubjectPermissions('transfer'), {
    read: 'gl.read',
    edit: 'gl.post',
    approve: 'gl.post',
  })
})

test('a vendor payment is not a vendor bill: pay authority, not ap.read', () => {
  // The message must tell two confusable kinds apart — ap.read on a bill
  // must never open a payment, and ap.pay on a payment must never open a bill.
  assert.equal(flowSubjectPermissions('vendor_bill')?.read, 'ap.read')
  assert.equal(flowSubjectPermissions('vendor_payment')?.read, 'ap.pay')
  assert.deepEqual(flowSubjectPermissions('vendor_payment'), {
    read: 'ap.pay',
    edit: 'ap.pay',
    approve: 'ap.pay',
  })
  assert.equal(flowSubjectPermissions('customer_payment')?.read, 'ar.pay')
})

test('project charges and pay runs resolve to their kind-specific surface', () => {
  // Project charges live under Projects, pay runs under payroll — not the
  // GL namespace their posting rules live under.
  assert.deepEqual(flowSubjectPermissions('project_charge'), {
    read: 'projects.read',
    edit: 'projects.manage',
    approve: 'projects.manage',
  })
  assert.deepEqual(flowSubjectPermissions('pay_run'), {
    read: 'payroll.read',
    edit: 'payroll.manage',
    approve: 'payroll.manage',
  })
})

test('non-registry document kinds resolve to their dedicated route grant', () => {
  assert.equal(flowSubjectPermissions('journal')?.read, 'gl.read')
  assert.equal(flowSubjectPermissions('journal')?.approve, 'gl.post')
  assert.equal(flowSubjectPermissions('expense_report')?.read, 'expenses.read')
  assert.equal(flowSubjectPermissions('expense_report')?.edit, 'expenses.create')
  assert.equal(flowSubjectPermissions('sales_order')?.read, 'ar.read')
  assert.equal(flowSubjectPermissions('purchase_order')?.read, 'ap.read')
  assert.equal(flowSubjectPermissions('field_ticket')?.read, 'time.read')
  assert.equal(flowSubjectPermissions('field_ticket')?.edit, 'time.manage')
})

test('non-document subjects resolve to their domain grant', () => {
  assert.deepEqual(flowSubjectPermissions('party_bank_account'), {
    read: 'parties.read',
    edit: 'parties.manage',
    approve: 'parties.manage',
  })
  assert.deepEqual(flowSubjectPermissions('timesheet_week'), {
    read: 'time.read',
    edit: 'time.manage',
    approve: 'time.manage',
  })
  assert.deepEqual(flowSubjectPermissions('budget_scenario'), {
    read: 'budgets.read',
    edit: 'budgets.manage',
    approve: 'budgets.approve',
  })
  assert.deepEqual(flowSubjectPermissions('close_run'), {
    read: 'close.read',
    edit: 'close.run',
    approve: 'close.approve',
  })
  assert.deepEqual(flowSubjectPermissions('allocation_run'), {
    read: 'allocations.read',
    edit: 'allocations.manage',
    approve: 'allocations.approve',
  })
  assert.deepEqual(flowSubjectPermissions('hrm_change_request')?.read, 'hrm.employment.read')
  assert.deepEqual(flowSubjectPermissions('hrm_leave_request')?.read, 'hrm.leave.read')
  assert.deepEqual(flowSubjectPermissions('hrm_comp_cycle')?.read, 'hrm.compensation.read')
  assert.deepEqual(flowSubjectPermissions('crew_time_batch')?.edit, 'time.crew.enter')
})

test('kinds with no single domain grant fail closed', () => {
  // financial_change authorizes polymorphically per change type
  // (assets.manage / ar.post / close.run) — no single grant covers it.
  assert.equal(flowSubjectPermissions('financial_change'), null)
  assert.equal(flowSubjectPermissions('no_such_kind'), null)
})

test('manual buttons require the effect grant, not the trigger grant', () => {
  const bill = 'vendor_bill'
  assert.equal(
    manualButtonPermission(bill, plan([{ action: 'send_email' }, { action: 'notify' }])),
    'ap.read',
    'notify-only buttons need read',
  )
  assert.equal(
    manualButtonPermission(bill, plan([{ action: 'set_field' }])),
    'ap.create',
    'field sets need edit',
  )
  assert.equal(
    manualButtonPermission(bill, plan([{ action: 'lock_record' }])),
    'ap.create',
    'locks need edit',
  )
  assert.equal(
    manualButtonPermission(bill, plan([{ action: 'change_status', to: 'draft' }])),
    'ap.create',
    'return-to-draft needs edit',
  )
  assert.equal(
    manualButtonPermission(bill, plan([{ action: 'change_status', to: 'approved' }])),
    'ap.post',
    'approval transitions need post authority',
  )
  assert.equal(
    manualButtonPermission(bill, plan([{ action: 'post_document' }])),
    'ap.post',
    'posts need post authority',
  )
  assert.equal(
    manualButtonPermission(bill, plan([], 1)),
    'ap.create',
    'raising an approval gate is a write',
  )
  assert.equal(manualButtonPermission('financial_change', plan([])), null)
})

test('the documents-route read map matches the served grants', () => {
  assert.equal(documentRouteReadPermission('vendor_bill'), 'ap.read')
  assert.equal(documentRouteReadPermission('project_charge'), 'projects.read')
  assert.equal(documentRouteReadPermission('journal'), 'gl.read')
  assert.equal(documentRouteReadPermission('vendor_payment'), 'ap.pay')
  assert.equal(documentRouteReadPermission('expense_report'), 'expenses.read')
  assert.equal(documentRouteReadPermission('no_such_kind'), null)
})
