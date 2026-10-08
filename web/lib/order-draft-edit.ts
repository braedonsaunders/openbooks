import { isDocumentRevisionToken } from "@openbooks/engine/src/records/revision.ts";
import { NextResponse } from 'next/server';
import { ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts';
import type { Authz } from './authz';
import type { SqlExecutor } from '@openbooks/engine/platform/database';
import { isUuid } from './list-params';
import { overallItemQuantities, resolveLinePriceBasis, selectPostableOrderLines, type OrderLineInput } from '../app/api/_order/line-selection';
import { cmp } from '@openbooks/engine/src/money/money.ts';
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts';
import { documentWorkDatesRefusal } from '@openbooks/engine/records/work-period';
import { listScopedAccountOptions, listScopedDepartmentOptions, listScopedPartyOptions, listScopedProjectOptions } from './scoped-options';
import { notFound } from './api/responses';
import type { OrderKind } from './order-cycle';
import { findDocumentByExternalRef, isExternalRefConflict, resolveExternalRefPair } from './external-ref';

export interface OrderHandlerConfig {
  kind: OrderKind;
  readPerm: string;
  createPerm: string;
}

export interface OrderEditContext {
  orgId: string;
  userId: string;
  user: Authz['user'];
  allowedSubsidiaryIds: Authz['allowedSubsidiaryIds'];
  permissions: Authz['permissions'];
  services: OrderEditServices;
}

export interface OrderEditServices {
  platform: {
    db: typeof import('@openbooks/engine/src/platform/db.ts').db;
    withOrgTransaction: typeof import('@openbooks/engine/src/platform/db.ts').withOrgTransaction;
    sql: typeof import('drizzle-orm').sql;
    documentRevisionCounterSql: typeof import('@openbooks/engine/src/records/revision.ts').documentRevisionCounterSql;
  };
  authz: Pick<typeof import('./authz'), 'guardSubsidiaryScope'>;
  order: Pick<typeof import('../app/api/_order/lib'), 'computeOrderTotals' | 'exactOrderMoney' | 'loadOrder' | 'orderTaxProfileMap'>;
  bills: Pick<typeof import('./bills'), 'persistLineTaxComponents'>;
  stockLocations: Pick<typeof import('./stock-locations'), 'activeStockLocations' | 'profiledItemIds' | 'resolveLineStockLocation'>;
  segments: Pick<typeof import('./segments'), 'segmentRegistry' | 'validateExtraDims'>;
  crm: Pick<typeof import('@openbooks/engine/src/crm/crm.ts'), 'promoteCrmAccount'>;
  features: Pick<typeof import('./features'), 'isFeatureEnabled' | 'subsidiaryFeatureEnabled'>;
  flows: Pick<typeof import('@openbooks/engine/src/flows/index.ts'), 'submitAndReleaseIfUngated'>;
  sales: Pick<typeof import('@openbooks/engine/src/sales/sales-orders.ts'), 'issueSalesOrder' | 'SalesOrderIssueError'>;
  documentVoid: Pick<typeof import('@openbooks/engine/src/ledger/document-void.ts'), 'DocumentVoidError' | 'requestDocumentVoid'>;
  signing: Pick<typeof import('@openbooks/engine/billing/quote-to-cash'), 'voidSignatureRequestsForSubject' | 'QUOTE_SUBJECT_TABLE'>;
}

export interface OrderPatchBody {
  expectedUpdatedAt?: string;
  partyId?: string | null;
  documentDate?: string;
  dueDate?: string | null;
  /** When the ordered work was completed (sales orders). */
  workCompletedOn?: string | null;
  /**
   * The originating external system's id for this order and which system
   * minted it. Both or neither; the v1 API stamps the storefront reference
   * here so the header write and the dedupe claim commit together.
   */
  externalRef?: string | null;
  externalSource?: string | null;
  memo?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  subsidiaryId?: string | null;
  extraDims?: Record<string, string | null>;
  lines?: OrderLineInput[];
  status?: 'approved' | 'voided';
  reason?: string;
  creditOverrideReason?: string;
  reversalDate?: string | null;
}

export class OrderEditError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : 'Order edit refused');
    this.name = 'OrderEditError';
  }
}

type DeferredOrderEditError = { orderEditError: OrderEditError };

class OrderApprovalRoutingError extends Error {
  constructor(readonly flowError: string) {
    super(`approval could not be routed: ${flowError}`)
  }
}

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])
export const STALE_REVISION = 'this order changed after you opened it; reload and review the latest revision'

/** Compare the opaque counter revision returned by the order reader. */
export function staleRevision(expected: unknown, actual: unknown): boolean {
  return !isDocumentRevisionToken(expected) || expected !== actual
}

/**
 * Which subsidiary predicate failed, diagnosed on the failure path only: a
 * missing row, an inactive subsidiary, and an elimination entity refuse
 * separately, each naming the id (and the name when the row exists) — never
 * one sentence for all three.
 */
async function subsidiaryProblem(platform: OrderEditServices['platform'], orgId: string, subsidiaryId: string): Promise<string> {
  const row = (await platform.db.execute<{ name: string; isActive: boolean; isElimination: boolean }>(platform.sql`
    select name, is_active as "isActive", is_elimination as "isElimination"
      from subsidiaries
     where org_id = ${orgId} and id = ${subsidiaryId}`)).rows[0]
  if (!row) return `no subsidiary "${subsidiaryId}" in this organization — check the id and try again`
  if (!row.isActive) return `subsidiary "${row.name}" is inactive — reactivate it or choose an active subsidiary`
  return `subsidiary "${row.name}" is an elimination entity — choose an operating subsidiary`
}

export async function applyOrderEdit(context: OrderEditContext, cfg: OrderHandlerConfig, id: string, input: OrderPatchBody): Promise<NextResponse> {
  const user = { id: context.userId, orgId: context.orgId };
  const services = context.services;
  const gate: Authz = {
    user: { ...context.user, id: context.userId, orgId: context.orgId },
    permissions: context.permissions,
    allowedSubsidiaryIds: context.allowedSubsidiaryIds,
  };
  const existing = (await services.platform.db.execute<{ status: string; document_date: string; currency: string; party_id: string | null; subsidiaryId: string | null; updated_at: string }>(
    services.platform.sql`select status, document_date, currency, party_id, subsidiary_id as "subsidiaryId", ${services.platform.documentRevisionCounterSql(services.platform.sql`revision_seq`)} as updated_at from documents where id = ${id} and kind = ${cfg.kind} and org_id = ${user.orgId}`,
  ))
  if (!existing.rows[0]) return notFound("record")
  const recordDenied = services.authz.guardSubsidiaryScope(gate, existing.rows[0].subsidiaryId)
  if (recordDenied) return recordDenied
  const status = existing.rows[0].status

  const body = input

  // Header dates land in DATE columns: an impossible calendar date
  // (2026-02-30) trips a raw storage 22008 failure instead of a domain
  // error, so refuse it here with the shared ISO calendar policy before
  // any further read or write. A null due date clears the field.
  if (body.documentDate !== undefined && !isIsoCalendarDate(body.documentDate)) {
    throw new OrderEditError(422, { error: 'Document date must be a valid calendar date (YYYY-MM-DD)' })
  }
  if (body.dueDate !== undefined && body.dueDate !== null && !isIsoCalendarDate(body.dueDate)) {
    throw new OrderEditError(422, { error: 'Due date must be a valid calendar date (YYYY-MM-DD)' })
  }

  // --- body shapes ------------------------------------------------------
  // OrderPatchBody is cast, never schema-parsed: reject malformed shapes
  // before they reach the totals math or storage as raw 500s — or worse, a
  // truthy non-array `lines` that iterates characters, drops every line,
  // and zeroes the order totals with a 200.
  if (body.status !== undefined && body.status !== 'approved' && body.status !== 'voided') {
    throw new OrderEditError(422, { error: 'Invalid order status' })
  }
  for (const [label, value] of [
    ['party', body.partyId],
    ['department', body.departmentId],
    ['project', body.projectId],
  ] as const) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !isUuid(value))) {
      throw new OrderEditError(422, { error: `Invalid order ${label}` })
    }
  }
  if (body.subsidiaryId !== undefined && body.subsidiaryId !== null && typeof body.subsidiaryId !== 'string') {
    throw new OrderEditError(422, { error: `order subsidiary must be a subsidiary id string — received ${typeof body.subsidiaryId}` })
  }
  if (body.memo !== undefined && body.memo !== null && typeof body.memo !== 'string') {
    throw new OrderEditError(422, { error: 'Invalid order memo' })
  }
  if (body.lines !== undefined) {
    if (!Array.isArray(body.lines)) {
      throw new OrderEditError(422, { error: 'Order lines must be an array' })
    }
    for (let index = 0; index < body.lines.length; index++) {
      const line = body.lines[index]! as Record<string, unknown>
      if (typeof line !== 'object' || line === null || Array.isArray(line)) {
        throw new OrderEditError(422, { error: `Order line ${index + 1} is invalid` })
      }
      for (const [label, value] of [
        ['item', line.itemId],
        ['account', line.accountId],
        ['tax code', line.taxCodeId],
        ['tax group', line.taxGroupId],
        ['department', line.departmentId],
        ['project', line.projectId],
      ] as const) {
        if (value !== undefined && value !== null && (typeof value !== 'string' || !isUuid(value as string))) {
          throw new OrderEditError(422, { error: `Order line ${index + 1} has an invalid ${label}` })
        }
      }
      for (const [label, value] of [['description', line.description], ['unit', line.unit]] as const) {
        if (value !== undefined && value !== null && typeof value !== 'string') {
          throw new OrderEditError(422, { error: `Order line ${index + 1} has an invalid ${label}` })
        }
      }
    }
  }

  const workDatesRefusal = documentWorkDatesRefusal(cfg.kind, body.workCompletedOn, body.lines)
  if (workDatesRefusal) throw new OrderEditError(422, { error: workDatesRefusal })

  const suppliedLineRefs = body.lines ?? []
  const [partyOptions, departmentOptions, projectOptions, accountOptions] = await Promise.all([
    body.partyId ? listScopedPartyOptions(user.orgId, gate.allowedSubsidiaryIds, { activeOnly: true }) : Promise.resolve([]),
    body.departmentId || suppliedLineRefs.some((line) => line.departmentId)
      ? listScopedDepartmentOptions(user.orgId, gate.allowedSubsidiaryIds)
      : Promise.resolve([]),
    body.projectId || suppliedLineRefs.some((line) => line.projectId)
      ? listScopedProjectOptions(user.orgId, gate.allowedSubsidiaryIds)
      : Promise.resolve([]),
    suppliedLineRefs.some((line) => line.accountId)
      ? listScopedAccountOptions(user.orgId, gate.allowedSubsidiaryIds, { activeOnly: true, postingOnly: true })
      : Promise.resolve([]),
  ])
  const visibleParties = new Set(partyOptions.map((row) => row.id))
  const visibleDepartments = new Set(departmentOptions.map((row) => row.id))
  const visibleProjects = new Set(projectOptions.map((row) => row.id))
  const visibleAccounts = new Set(accountOptions.map((row) => row.id))
  if (body.partyId && !visibleParties.has(body.partyId)) {
    throw new OrderEditError(422, { error: `order party "${body.partyId}" is not visible in your subsidiary scope` })
  }
  if (body.departmentId && !visibleDepartments.has(body.departmentId)) {
    throw new OrderEditError(422, { error: `order department "${body.departmentId}" is not visible in your subsidiary scope` })
  }
  if (body.projectId && !visibleProjects.has(body.projectId)) {
    throw new OrderEditError(422, { error: `order project "${body.projectId}" is not visible in your subsidiary scope` })
  }
  for (let index = 0; index < suppliedLineRefs.length; index++) {
    const line = suppliedLineRefs[index]!
    if (line.accountId && !visibleAccounts.has(line.accountId)) {
      throw new OrderEditError(422, { error: `Order line ${index + 1}: account is not visible in your subsidiary scope` })
    }
    if (line.departmentId && !visibleDepartments.has(line.departmentId)) {
      throw new OrderEditError(422, { error: `Order line ${index + 1}: department is not visible in your subsidiary scope` })
    }
    if (line.projectId && !visibleProjects.has(line.projectId)) {
      throw new OrderEditError(422, { error: `Order line ${index + 1}: project is not visible in your subsidiary scope` })
    }
  }

  // A restricted caller may re-home a draft only within their visible
  // subsidiaries; clearing the header subsidiary entirely is also denied
  // (the resolved root would sit outside their scope just as often).
  if (body.subsidiaryId !== undefined && body.subsidiaryId !== null) {
    if (!(await services.features.subsidiaryFeatureEnabled(user.orgId))) {
      throw new OrderEditError(422, { error: 'Subsidiaries are not enabled' })
    }
    if (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(body.subsidiaryId)) {
      throw new OrderEditError(422, { error: `subsidiary "${body.subsidiaryId}" is outside your visible subsidiaries — choose a subsidiary in scope or ask an administrator for access` })
    }
    const subsidiary = (await services.platform.db.execute(services.platform.sql`
      select 1 from subsidiaries
       where id = ${body.subsidiaryId} and org_id = ${user.orgId}
         and is_active and not is_elimination
    `))
    if (!subsidiary.rows[0]) {
      throw new OrderEditError(422, { error: await subsidiaryProblem(services.platform, user.orgId, body.subsidiaryId) })
    }
  } else if (body.subsidiaryId === null && gate.allowedSubsidiaryIds) {
    throw new OrderEditError(422, { error: 'clearing the order subsidiary is not available with restricted subsidiary scope — choose a visible subsidiary instead' })
  }

  // --- status transitions ------------------------------------------------
  if (body.status) {
    if (body.status === 'voided') {
      if (status === 'voided') {
        throw new OrderEditError(422, { error: 'already voided' })
      }
      if (status !== 'approved') {
        throw new OrderEditError(422, { error: 'only an issued order can be voided; discard a draft instead' })
      }
      // Fence before the engine's claim: a stale view must not even enter
      // the void pipeline. requestDocumentVoid re-checks the same token
      // inside its claim transaction, so a row that changes after this
      // probe still cannot be voided from the stale view.
      if (staleRevision(body.expectedUpdatedAt, existing.rows[0].updated_at)) {
        throw new OrderEditError(409, { error: STALE_REVISION })
      }
      try {
        const result = await services.documentVoid.requestDocumentVoid({
          documentId: id,
          orgId: user.orgId,
          actorId: user.id,
          reason: body.reason ?? '',
          reversalDate: body.reversalDate,
          source: 'ui',
          expectedUpdatedAt: body.expectedUpdatedAt,
          // Recheck scope on the engine's locked source row — the
          // route pre-check above ran unlocked, so a rehome landing
          // between the two must deny inside the claim transaction.
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        })
        if (result.status === 'pending_approval') {
          const order = await services.order.loadOrder(id, user.orgId, cfg.kind, gate.allowedSubsidiaryIds)
          return NextResponse.json(
            { ...order, voidPending: true, requestId: result.runId },
            { status: 202 },
          )
        }
        const order = await services.order.loadOrder(id, user.orgId, cfg.kind, gate.allowedSubsidiaryIds)
        return NextResponse.json(order)
      } catch (error) {
        if (error instanceof ScopeNotFoundError) {
          return notFound("record")
        }
        if (error instanceof services.documentVoid.DocumentVoidError) {
          throw new OrderEditError(error.status, { error: error.message })
        }
        throw error
      }
    }

    // A refused routing throws: the submission already wrote its
    // before_submit script effects, and answering 422 from inside the
    // transaction would commit them alongside the refusal. The mapper
    // below answers the same 422 after the rollback.
    const issuance = services.platform.withOrgTransaction(user.orgId, async () => {
      // Serialize issuing with draft replacement at the aggregate root. A
      // late draft PATCH must not rewrite an order after issuance commits.
      // Void owns its transaction internally so it can reserve the aggregate
      // before before_void effects. Script queries use the separate governed
      // READ ONLY pool while script writes join that atomic reservation.
      const locked = (await services.platform.db.execute<{
        status: string
        party_id: string | null
        subsidiaryId: string | null
        total: string
        updated_at: string
      }>(services.platform.sql`
        select status, party_id, subsidiary_id as "subsidiaryId", total, ${services.platform.documentRevisionCounterSql(services.platform.sql`revision_seq`)} as updated_at
          from documents
         where id = ${id} and kind = ${cfg.kind} and org_id = ${user.orgId}
         for update
      `))
      const current = locked.rows[0]
      if (!current) return notFound("record")
      // The aggregate lock is held: recheck scope against the locked row —
      // the route pre-check ran unlocked, so a rehome landing between the
      // two must deny here rather than issue into the new subsidiary.
      const issuanceDenied = services.authz.guardSubsidiaryScope(gate, current.subsidiaryId)
      if (issuanceDenied) return issuanceDenied

      // The aggregate lock is held: an exact token mismatch here is a stale
      // caller, refused before the issuance side effects.
      if (staleRevision(body.expectedUpdatedAt, current.updated_at)) {
        return { orderEditError: new OrderEditError(409, { error: STALE_REVISION }) } satisfies DeferredOrderEditError
      }

      if (body.status === 'approved') {
        if (current.status !== 'draft') {
          return { orderEditError: new OrderEditError(422, { error: 'only a draft can be issued' }) } satisfies DeferredOrderEditError
        }
        if (!current.party_id || cmp(current.total, '0') <= 0) {
          return { orderEditError: new OrderEditError(422, { error: 'Add a party and at least one line before issuing' }) } satisfies DeferredOrderEditError
        }
        let submission: Awaited<ReturnType<typeof services.flows.submitAndReleaseIfUngated>>
        if (cfg.kind === 'sales_order') {
          try {
            const issued = await services.sales.issueSalesOrder({
              orgId: user.orgId,
              salesOrderId: id,
              actorId: user.id,
              expectedUpdatedAt: body.expectedUpdatedAt!,
              creditOverrideReason: body.creditOverrideReason,
            })
            submission = issued.submission
          } catch (error) {
            if (error instanceof services.sales.SalesOrderIssueError) {
              throw new OrderEditError(error.status, { error: error.message, code: error.code, credit: error.details })
            }
            throw error
          }
        } else {
          submission = await services.flows.submitAndReleaseIfUngated(cfg.kind, id, user.id)
        }
        if (submission.flowError) {
          throw new OrderApprovalRoutingError(submission.flowError)
        }
        if (submission.gated) {
          const order = await services.order.loadOrder(id, user.orgId, cfg.kind, gate.allowedSubsidiaryIds)
          return NextResponse.json(
            { ...order, approvalPending: true, requestId: submission.runId },
            { status: 202 },
          )
        }
      }
      const order = await services.order.loadOrder(id, user.orgId, cfg.kind, gate.allowedSubsidiaryIds)
      return NextResponse.json(order)
    })
    let issuanceResult: Awaited<typeof issuance>
    try {
      issuanceResult = await issuance
    } catch (error) {
      if (error instanceof OrderApprovalRoutingError) {
        throw new OrderEditError(422, { error: error.message })
      }
      throw error
    }
    if ('orderEditError' in issuanceResult) throw issuanceResult.orderEditError
    return issuanceResult
  }

  // --- draft autosave ----------------------------------------------------
  if (status !== 'draft') {
    throw new OrderEditError(422, { error: 'only draft orders can be edited' })
  }

  // The external (source, ref) pair is all or nothing: a lone half would
  // slip the dedupe index, so refuse it here with the remedy instead of
  // letting storage answer with a bare constraint code.
  const external = resolveExternalRefPair({ externalRef: body.externalRef, externalSource: body.externalSource })
  if (external.action === 'refuse') {
    throw new OrderEditError(422, { error: external.message })
  }

  const segments = await services.segments.segmentRegistry(user.orgId)
  const headerDims = body.extraDims === undefined ? null : services.segments.validateExtraDims(body.extraDims, segments)
  if (headerDims && !headerDims.ok) {
    throw new OrderEditError(422, { error: headerDims.error })
  }

  let totals: { subtotal: string; taxTotal: string; total: string } | null = null
  let preparedLines: (ReturnType<OrderEditServices['order']['computeOrderTotals']>['lines'][number] & { extraDims: Record<string, string | null> })[] | null = null
  if (body.lines) {
    // Same save shape as create: blank grid rows never persist, while any
    // populated row that cannot post refuses by line number.
    const selected = selectPostableOrderLines(body.lines)
    if ('error' in selected) {
      throw new OrderEditError(422, { error: selected.error })
    }
    const valid: OrderLineInput[] = selected.valid
    // Line warehouses resolve here, before totals: an explicit choice must
    // name an active warehouse of this org, while a blank stocked line
    // silently takes the org's only active location.
    if (valid.length > 0) {
      const scope = {
        active: await services.stockLocations.activeStockLocations(user.orgId),
        profiled: await services.stockLocations.profiledItemIds(
          user.orgId,
          valid.map((line) => line.itemId).filter((id): id is string => typeof id === 'string' && id.length > 0),
        ),
      }
      for (let i = 0; i < valid.length; i++) {
        const line = valid[i]!
        const resolved = services.stockLocations.resolveLineStockLocation(i + 1, line.itemId ?? null, line.stockLocationId, scope)
        if ('error' in resolved) {
          throw new OrderEditError(422, { error: resolved.error })
        }
        line.stockLocationId = resolved.locationId
      }
    }
    const computed = services.order.computeOrderTotals(
      valid,
      await services.order.orderTaxProfileMap(user.orgId, body.documentDate ?? existing.rows[0].document_date),
    )
    const subtotal = services.order.exactOrderMoney(computed.subtotal)
    if (subtotal === 'invalid') {
      throw new OrderEditError(422, { error: 'Order totals contain an invalid amount' })
    }
    const taxTotal = services.order.exactOrderMoney(computed.taxTotal)
    if (taxTotal === 'invalid') {
      throw new OrderEditError(422, { error: 'Order totals contain an invalid amount' })
    }
    const total = services.order.exactOrderMoney(computed.total)
    if (total === 'invalid') {
      throw new OrderEditError(422, { error: 'Order totals contain an invalid amount' })
    }
    totals = {
      subtotal,
      taxTotal,
      total,
    }
    preparedLines = []
    const itemQuantities = overallItemQuantities(valid)
    for (let i = 0; i < computed.lines.length; i++) {
      const l = computed.lines[i]!
      const lineDims = services.segments.validateExtraDims(l.extraDims, segments)
      if (!lineDims.ok) {
        throw new OrderEditError(422, { error: `Line ${i + 1}: ${lineDims.error}` })
      }
      const amount = services.order.exactOrderMoney(l.amount)
      if (amount === 'invalid') {
        throw new OrderEditError(422, { error: 'Order totals contain an invalid amount' })
      }
      const taxInputAmount = services.order.exactOrderMoney(l.taxInputAmount)
      if (taxInputAmount === 'invalid') {
        throw new OrderEditError(422, { error: 'Order totals contain an invalid amount' })
      }
      const taxAmount = services.order.exactOrderMoney(l.taxAmount)
      if (taxAmount === 'invalid') {
        throw new OrderEditError(422, { error: 'Order totals contain an invalid amount' })
      }
      // The client basis is only a signal; the server resolves and stores
      // its own provenance against the effective draft header and lines.
      const priceBasis = await resolveLinePriceBasis({
        lineNumber: i + 1,
        orgId: user.orgId,
        customerId: body.partyId !== undefined ? body.partyId : existing.rows[0].party_id,
        currency: existing.rows[0].currency,
        documentDate: body.documentDate ?? existing.rows[0].document_date,
        line: l,
        overallItemQuantity: itemQuantities.get(l.itemId ?? '') ?? (l.quantity ?? '0'),
      })
      if (priceBasis !== null && 'error' in priceBasis) {
        throw new OrderEditError(400, { error: priceBasis.error })
      }
      preparedLines.push({
        ...l,
        quantity: l.quantity ?? '0',
        unitPrice: l.unitPrice ?? '0',
        amount,
        taxInputAmount,
        taxAmount,
        extraDims: lineDims.cleaned,
        priceBasis,
      })
    }
    // Stored inventory / assembly / kit lines stay. Turning Inventory off
    // must 404 a write that would persist a new one of those kinds.
    if (!(await services.features.isFeatureEnabled(user.orgId, 'inventory'))) {
      const stored = (await services.platform.db.execute<{ item_id: string }>(services.platform.sql`
        select item_id from document_lines
         where org_id = ${user.orgId} and document_id = ${id} and item_id is not null`))
      const storedIds = new Set(stored.rows.map((row) => row.item_id))
      for (const l of preparedLines) {
        if (!l.itemId || storedIds.has(l.itemId)) continue
        const item = (await services.platform.db.execute<{ kind: string }>(services.platform.sql`
          select kind from items where id = ${l.itemId} and org_id = ${user.orgId}`))
        if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
          return notFound("record")
        }
      }
    }
  }

  // Composite org-scoped storage keys make cross-tenant references
  // unrepresentable; map their FK refusal to a domain 422 instead of a
  // raw 500. The whole autosave (lines + header + totals) rolls back.
  const isTenantReferenceViolation = (error: unknown): boolean => {
    let cursor: unknown = error;
    for (let depth = 0; depth < 4 && cursor !== null && typeof cursor === 'object'; depth++) {
      if ((cursor as { code?: unknown }).code === '23503') return true;
      cursor = (cursor as { cause?: unknown }).cause;
    }
    return false;
  };
  let mutation: 'not_found' | 'stale' | 'not_editable' | 'saved' | NextResponse;
  try {
    mutation = await services.platform.db.transaction(async (tx) => {
    const locked = (await tx.execute<{ status: string; subsidiaryId: string | null; updated_at: string }>(services.platform.sql`
      select status, subsidiary_id as "subsidiaryId", ${services.platform.documentRevisionCounterSql(services.platform.sql`revision_seq`)} as updated_at
        from documents
       where id = ${id} and kind = ${cfg.kind} and org_id = ${user.orgId}
       for update
    `))
    if (!locked.rows[0]) return 'not_found' as const
    // The aggregate lock is held: recheck scope against the locked row —
    // the pre-check above ran unlocked, so a rehome landing between the
    // two must deny here rather than save into the new subsidiary.
    const lockedDenied = services.authz.guardSubsidiaryScope(gate, locked.rows[0].subsidiaryId)
    if (lockedDenied) return lockedDenied
    if (staleRevision(body.expectedUpdatedAt, locked.rows[0].updated_at)) return 'stale' as const
    if (locked.rows[0].status !== 'draft') return 'not_editable' as const

    if (preparedLines) {
      await tx.execute(services.platform.sql`delete from document_lines where document_id = ${id} and org_id = ${user.orgId}`)
      for (let i = 0; i < preparedLines.length; i++) {
        const l = preparedLines[i]!
        const inserted = (await tx.execute<{ id: string }>(services.platform.sql`
          insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
                                      quantity, unit, unit_price, amount, tax_code_id, tax_group_id,
                                      tax_input_amount, tax_amount,
                                      department_id, project_id, stock_location_id, extra_dims, price_basis,
                                      work_from, work_to)
          values (${user.orgId}, ${id}, ${i + 1}, ${l.itemId ?? null}, ${l.accountId ?? null},
                  ${l.description ?? null}, ${l.quantity ?? '0'}, ${l.unit ?? null}, ${l.unitPrice ?? '0'},
                  ${l.amount}, ${l.taxCodeId ?? null}, ${l.taxGroupId ?? null}, ${l.taxInputAmount}, ${l.taxAmount},
                  ${l.departmentId ?? null}, ${l.projectId ?? null}, ${l.stockLocationId ?? null}, ${JSON.stringify(l.extraDims)}::jsonb,
                  ${l.priceBasis == null ? null : JSON.stringify(l.priceBasis)}::jsonb,
                  ${l.workFrom ?? null}, ${l.workTo ?? null})
          returning id
        `))
        await services.bills.persistLineTaxComponents(tx, {
          orgId: user.orgId,
          documentLineId: inserted.rows[0]!.id,
          components: l.taxComponents,
          actorId: user.id,
        })
      }
    }

    await tx.execute(services.platform.sql`
      update documents set
        party_id = ${body.partyId !== undefined ? body.partyId : services.platform.sql`party_id`},
        document_date = coalesce(${body.documentDate ?? null}, document_date),
        due_date = ${body.dueDate !== undefined ? body.dueDate : services.platform.sql`due_date`},
        work_completed_on = ${body.workCompletedOn !== undefined ? body.workCompletedOn : services.platform.sql`work_completed_on`},
        external_ref = ${external.action === 'set' ? external.ref : external.action === 'clear' ? null : services.platform.sql`external_ref`},
        external_source = ${external.action === 'set' ? external.source : external.action === 'clear' ? null : services.platform.sql`external_source`},
        memo = ${body.memo !== undefined ? body.memo : services.platform.sql`memo`},
        department_id = ${body.departmentId !== undefined ? body.departmentId : services.platform.sql`department_id`},
        project_id = ${body.projectId !== undefined ? body.projectId : services.platform.sql`project_id`},
        subsidiary_id = ${body.subsidiaryId !== undefined ? body.subsidiaryId : services.platform.sql`subsidiary_id`},
        extra_dims = ${headerDims ? JSON.stringify(headerDims.cleaned) : services.platform.sql`extra_dims`}::jsonb,
        subtotal = coalesce(${totals?.subtotal ?? null}, subtotal),
        tax_total = coalesce(${totals?.taxTotal ?? null}, tax_total),
        total = coalesce(${totals?.total ?? null}, total),
        updated_at = now(), updated_by = ${user.id}
      where id = ${id} and org_id = ${user.orgId}
    `)
    const nextPartyId = body.partyId !== undefined ? body.partyId : null
    if (nextPartyId && (cfg.kind === 'quote' || cfg.kind === 'sales_order')) {
      const promotion = await services.crm.promoteCrmAccount(tx, {
        orgId: user.orgId,
        partyId: nextPartyId,
        actorId: user.id,
        toStage: cfg.kind === 'quote' ? 'prospect' : 'customer',
        sourceKind: cfg.kind,
        sourceId: id,
      })
      // A sales order makes the party a customer: core AR state the credit
      // checks downstream depend on. A quote only touches CRM lifecycle,
      // which is legitimately absent with CRM off.
      if (cfg.kind === 'sales_order' && !promotion.customerRoleActive) {
        throw new Error('customer role was not established while saving the sales order')
      }
    }
    // A sent quote's signature covers its exact presentation: any content
    // edit voids open requests so the quote must be re-sent, never signed
    // stale. Pure touches (revision pings without content) keep the link.
    const contentChanged = body.lines !== undefined
      || body.partyId !== undefined
      || body.documentDate !== undefined
      || body.dueDate !== undefined
      || body.workCompletedOn !== undefined
      || body.memo !== undefined
      || body.departmentId !== undefined
      || body.projectId !== undefined
      || body.subsidiaryId !== undefined
      || body.extraDims !== undefined
    if (cfg.kind === 'quote' && contentChanged) {
      await services.signing.voidSignatureRequestsForSubject(
        tx as unknown as SqlExecutor, user.orgId, services.signing.QUOTE_SUBJECT_TABLE, id,
      )
    }
    return 'saved' as const
  })
  } catch (error) {
    if (isTenantReferenceViolation(error)) {
      throw new OrderEditError(422, { error: 'Referenced party, account, tax profile, or dimension must belong to this organization' })
    }
    // The pre-write duplicate check passed, then a concurrent write claimed
    // the same external pair: name the winning document instead of
    // surfacing a bare unique violation.
    if (external.action === 'set' && isExternalRefConflict(error)) {
      const winner = await findDocumentByExternalRef(services.platform.db, user.orgId, external.ref, external.source)
      throw new OrderEditError(409, {
        error: winner
          ? `externalRef "${external.ref}" from "${external.source}" already exists on document ${winner.documentNumber} — send a new reference or update the existing document`
          : `externalRef "${external.ref}" from "${external.source}" already exists — send a new reference or update the existing document`,
        ...(winner ? { existingId: winner.id } : {}),
      })
    }
    throw error
  }

  if (mutation instanceof NextResponse) return mutation
  if (mutation === 'not_found') {
    return notFound("record")
  }
  if (mutation === 'stale') {
    throw new OrderEditError(409, { error: STALE_REVISION })
  }
  if (mutation === 'not_editable') {
    throw new OrderEditError(422, { error: 'only draft orders can be edited' })
  }

  const order = await services.order.loadOrder(id, user.orgId, cfg.kind, gate.allowedSubsidiaryIds)
  return NextResponse.json(order)
}
