import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  loadPaymentDocument,
  openItemsForParty,
  PAYMENT_KIND_SIDE,
  type PaymentKind,
} from '@openbooks/engine/src/payments.ts'
import type { OpenItemClient } from '../app/(app)/payments/PaymentDrawer'
import {
  RelatedTransactionDrawerClient,
  type RelatedTransactionDrawerData,
} from './related-transaction-drawer-client'
import { loadOrder } from '../app/api/_order/lib'
import type { OrderKind } from '../lib/order-kinds'
import { can, type Authz } from '../lib/authz'
import { loadFieldDefs } from '../lib/custom-fields'
import { resolveFormLayout } from '../lib/customization/resolve'
import { loadFieldTicketDrawerData } from '../lib/field-ticket-drawer-data'
import {
  DOC_KINDS,
  accountOptions,
  bankAccountOptions,
  cardOptions,
  createPermission,
  dimensionOptions,
  itemOptions,
  loadDocument,
  partyOptions,
  postPermission,
  readPermission,
  taxCodeOptions,
  taxGroupOptions,
} from '../lib/documents'
import { loadExpenseReport } from '../lib/expenses'
import { loadJournalDoc } from '../lib/journals'
import { customSegmentOptions } from '../lib/segments'
import { isMultiSubsidiary, subsidiaryOptions } from '../lib/subsidiaries'

const PAYMENT_KINDS = new Set(['vendor_payment', 'customer_payment'])
const ORDER_KINDS = new Set(['quote', 'sales_order', 'purchase_order'])

function canSeeDocument(doc: Record<string, any>, partyId: string | undefined, authz: Authz): boolean {
  return String(doc.org_id) === authz.user.orgId
    && (!partyId || String(doc.party_id) === partyId)
    && (!authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(String(doc.subsidiary_id)))
}

async function visibleSubsidiaries(authz: Authz) {
  if (!(await isMultiSubsidiary(authz.user.orgId))) return undefined
  const options = await subsidiaryOptions()
  return authz.allowedSubsidiaryIds
    ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
    : options
}

/**
 * Hydrates a native transaction drawer for any stacked record context. Party
 * drawers pass partyId to enforce that relationship; report drawers omit it
 * while retaining organization, subsidiary, and permission checks.
 */
export async function loadRelatedTransactionDrawerData({
  id,
  kind,
  partyId,
  projectId,
  authz,
  formLayoutId,
}: {
  id: string
  kind: string
  partyId?: string
  projectId?: string
  authz: Authz
  formLayoutId?: string
}): Promise<RelatedTransactionDrawerData | null> {
  if (projectId) {
    const related = (await db.execute<{ id: string }>(sql`
      select d.id
        from documents d
       where d.id = ${id}
         and d.org_id = ${authz.user.orgId}
         and (
           d.project_id = ${projectId}
           or exists (
             select 1 from document_lines line
              where line.org_id = d.org_id
                and line.document_id = d.id
                and line.project_id = ${projectId}
           )
         )
         ${authz.allowedSubsidiaryIds
           ? authz.allowedSubsidiaryIds.size > 0
             ? sql`and d.subsidiary_id in ${[...authz.allowedSubsidiaryIds]}`
             : sql`and false`
           : sql``}
    `))
    if (!related.rows[0]) return null
  }
  if (kind === 'field_ticket') {
    const props = await loadFieldTicketDrawerData({ authz, ticketId: id, formLayoutId })
    return props ? { type: 'fieldTicket', props } : null
  }
  if (PAYMENT_KINDS.has(kind)) {
    const permission = kind === 'vendor_payment' ? 'ap.read' : 'ar.read'
    if (!can(authz, permission)) return null
    const paymentKind = kind as PaymentKind
    const payment = await loadPaymentDocument(id, paymentKind)
    if (!payment || !canSeeDocument(payment.doc as Record<string, any>, partyId, authz)) return null

    const side = PAYMENT_KIND_SIDE[paymentKind]
    const partyFilter = side === 'ap'
      ? sql`exists (select 1 from vendor_roles vr where vr.party_id = p.id and vr.is_active)`
      : sql`exists (select 1 from customer_roles cr where cr.party_id = p.id and cr.is_active)`
    const [parties, banks, resolvedForm] = await Promise.all([
      db.execute(sql`
        select id, display_name from parties p
         where p.org_id = ${authz.user.orgId} and ${partyFilter} and p.is_active
         order by display_name limit 2000`) as any,
      db.execute(sql`
        select id, number, name from accounts
         where org_id = ${authz.user.orgId} and type = 'asset_bank' and is_active and not is_summary
         order by number nulls last, name`) as any,
      resolveFormLayout({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        recordType: kind,
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs: [],
        lineDefs: [],
        explicitLayoutId: formLayoutId,
      }),
    ])
    const openItems: OpenItemClient[] = payment.doc.status === 'draft'
      ? await openItemsForParty(String(payment.doc.party_id), side)
      : []
    return {
      type: 'payment',
      props: {
        payment: payment as any,
        initialOpenItems: openItems,
        parties: parties.rows,
        bankAccounts: banks.rows,
        side,
        basePath: side === 'ap' ? '/payments' : '/receipts',
        layout: resolvedForm.layout,
      },
    }
  }

  if (ORDER_KINDS.has(kind)) {
    const orderKind = kind as OrderKind
    const permission = orderKind === 'purchase_order' ? 'ap.read' : 'ar.read'
    if (!can(authz, permission)) return null
    const order = await loadOrder(id, authz.user.orgId, orderKind)
    if (!order || !canSeeDocument(order.doc as Record<string, any>, partyId, authz)) return null
    const roleCondition = orderKind === 'purchase_order'
      ? sql`exists (select 1 from vendor_roles r where r.party_id = p.id and r.is_active)`
      : sql`exists (select 1 from customer_roles r where r.party_id = p.id and r.is_active)`
    const [parties, accounts, items, taxCodes, taxGroups, departments, projects, segments, subsidiaries, resolvedForm] = await Promise.all([
      db.execute(sql`select p.id, p.display_name from parties p where p.org_id = ${authz.user.orgId} and ${roleCondition} and p.is_active order by p.display_name limit 2000`) as any,
      db.execute(sql`select id, number, name from accounts where org_id = ${authz.user.orgId} and is_active and not is_summary order by number nulls last`) as any,
      db.execute(sql`select id, code, name, default_rate, income_account_id, expense_account_id, tax_code_id, unit from items where org_id = ${authz.user.orgId} and is_active order by name limit 2000`) as any,
      taxCodeOptions(),
      taxGroupOptions(),
      db.execute(sql`select id, name from departments where org_id = ${authz.user.orgId} and is_active order by name`) as any,
      db.execute(sql`select id, name from projects where org_id = ${authz.user.orgId} and is_active order by name limit 2000`) as any,
      customSegmentOptions(authz.user.orgId),
      visibleSubsidiaries(authz),
      resolveFormLayout({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        recordType: kind,
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs: [],
        lineDefs: [],
        explicitLayoutId: formLayoutId,
      }),
    ])
    return {
      type: 'order',
      props: {
        order: order as any,
        kind: orderKind,
        parties: parties.rows,
        accounts: accounts.rows,
        items: items.rows,
        taxCodes: taxCodes as any,
        taxGroups: taxGroups as any,
        departments: departments.rows,
        projects: projects.rows,
        segments,
        subsidiaries: (subsidiaries ?? []).map((subsidiary) => ({
          id: subsidiary.id,
          name: `${'  '.repeat(subsidiary.depth)}${subsidiary.name}`,
        })),
        canManage: can(authz, orderKind === 'purchase_order' ? 'ap.create' : 'ar.create'),
        layout: resolvedForm.layout,
      },
    }
  }

  if (kind === 'expense_report') {
    if (!can(authz, 'expenses.read')) return null
    const report = await loadExpenseReport(id, authz.user.orgId)
    if (!report || !canSeeDocument(report.doc as Record<string, any>, partyId, authz)) return null
    const [employees, accounts, taxCodes, taxGroups, dimensions, headerDefs, lineDefs, segments] = await Promise.all([
      db.execute(sql`
        select p.id, p.display_name from parties p
         where p.org_id = ${authz.user.orgId} and p.is_active
           and exists (select 1 from employee_roles er where er.party_id = p.id and er.is_active)
         order by p.display_name limit 2000`) as any,
      db.execute(sql`select id, number, name from accounts where org_id = ${authz.user.orgId} and type in ('expense','expense_other','cogs') and is_active and not is_summary order by number nulls last`) as any,
      taxCodeOptions(),
      taxGroupOptions(),
      dimensionOptions(),
      loadFieldDefs('documents', 'expense_report'),
      loadFieldDefs('document_lines', 'expense_report'),
      customSegmentOptions(authz.user.orgId),
    ])
    const resolvedForm = await resolveFormLayout({
      orgId: authz.user.orgId,
      userId: authz.user.id,
      recordType: kind,
      userRoles: authz.user.roles.map(({ key }) => key),
      headerDefs: headerDefs as any,
      lineDefs: lineDefs as any,
      explicitLayoutId: formLayoutId,
    })
    return {
      type: 'expense',
      props: {
        report: report as any,
        employees: employees.rows,
        accounts: accounts.rows,
        taxCodes: taxCodes as any,
        taxGroups: taxGroups as any,
        departments: dimensions.departments as any,
        projects: dimensions.projects as any,
        segments: segments as any,
        headerDefs: headerDefs as any,
        lineDefs: lineDefs as any,
        canSubmit: can(authz, 'expenses.create'),
        canPost: can(authz, 'ap.post'),
        layout: resolvedForm.layout,
      },
    }
  }

  if (kind === 'journal') {
    if (!can(authz, 'gl.read')) return null
    const journal = await loadJournalDoc(id)
    if (!journal || !canSeeDocument(journal.doc as Record<string, any>, partyId, authz)) return null
    const [parties, accounts, dimensions, headerDefs, lineDefs, subsidiaries, segments] = await Promise.all([
      db.execute(sql`select id, display_name from parties where org_id = ${authz.user.orgId} and is_active order by display_name limit 2000`) as any,
      db.execute(sql`select id, number, name from accounts where org_id = ${authz.user.orgId} and is_active and not is_summary order by number nulls last`) as any,
      dimensionOptions(),
      loadFieldDefs('documents', 'journal'),
      loadFieldDefs('document_lines', 'journal'),
      visibleSubsidiaries(authz),
      customSegmentOptions(authz.user.orgId),
    ])
    const resolvedForm = await resolveFormLayout({
      orgId: authz.user.orgId,
      userId: authz.user.id,
      recordType: kind,
      userRoles: authz.user.roles.map(({ key }) => key),
      headerDefs: headerDefs as any,
      lineDefs: lineDefs as any,
      explicitLayoutId: formLayoutId,
    })
    return {
      type: 'journal',
      props: {
        journal: journal as any,
        parties: parties.rows,
        accounts: accounts.rows,
        departments: dimensions.departments as any,
        projects: dimensions.projects as any,
        subsidiaries,
        segments: segments as any,
        headerDefs: headerDefs as any,
        lineDefs: lineDefs as any,
        layout: resolvedForm.layout,
      },
    }
  }

  const config = DOC_KINDS[kind]
  const readPerm = kind === 'project_charge' ? 'projects.read' : readPermission(kind)
  if (!config || !can(authz, readPerm)) return null
  const payload = await loadDocument(id)
  if (!payload || !canSeeDocument(payload.doc as Record<string, any>, partyId, authz)) return null
  const [headerDefs, lineDefs] = await Promise.all([
    loadFieldDefs('documents', kind),
    loadFieldDefs('document_lines', kind),
  ])
  const [parties, accounts, taxCodes, dimensions, items, cards, banks, subsidiaries, resolvedForm] = await Promise.all([
    config.partyRole ? partyOptions(config.partyRole) : Promise.resolve(undefined),
    accountOptions(config),
    config.hasTax ? taxCodeOptions() : Promise.resolve(undefined),
    dimensionOptions(),
    itemOptions(),
    config.fundingSource === 'card' ? cardOptions() : Promise.resolve(undefined),
    config.fundingSource === 'bank' || kind === 'transfer' ? bankAccountOptions() : Promise.resolve(undefined),
    visibleSubsidiaries(authz),
    resolveFormLayout({
      orgId: authz.user.orgId,
      userId: authz.user.id,
      recordType: kind,
      userRoles: authz.user.roles.map(({ key }) => key),
      headerDefs: headerDefs as any,
      lineDefs: lineDefs as any,
      explicitLayoutId: formLayoutId,
    }),
  ])
  return {
    type: 'document',
    props: {
      payload: payload as any,
      config,
      basePath: config.family === 'ap' ? '/ap' : config.family === 'ar' ? '/ar' : '/banking/transactions',
      parties: parties as any,
      accounts: accounts as any,
      taxCodes: taxCodes as any,
      cards: cards as any,
      bankAccounts: banks as any,
      departments: dimensions.departments as any,
      projects: dimensions.projects as any,
      locations: dimensions.locations as any,
      classes: dimensions.classes as any,
      segments: dimensions.segments as any,
      builtinSegments: dimensions.builtinSegments as any,
      items: items as any,
      subsidiaries,
      headerDefs: headerDefs as any,
      lineDefs: lineDefs as any,
      // A project charge uses the same explicit Edit cycle as every native
      // transaction. Its rate-aware line snapshot remains read-only in the
      // universal drawer; governed header amendments preserve that evidence.
      canCreate: kind === 'project_charge' ? can(authz, 'projects.manage') : can(authz, createPermission(kind)),
      canPost: kind === 'project_charge' ? false : can(authz, postPermission(kind)),
      layout: resolvedForm.layout,
      availableLayouts: resolvedForm.available,
      currentLayoutId: resolvedForm.row?.id ?? null,
      recordType: kind,
      canCustomize: can(authz, 'admin.customization.manage'),
    },
  }
}

export async function RelatedTransactionDrawer(
  props: Parameters<typeof loadRelatedTransactionDrawerData>[0],
) {
  const data = await loadRelatedTransactionDrawerData(props)
  return data ? <RelatedTransactionDrawerClient data={data} /> : null
}
