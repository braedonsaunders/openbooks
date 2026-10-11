import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { createDocument } from "@openbooks/engine/src/ledger/document-write.ts";
import { loadDocument } from "@openbooks/engine/src/ledger/document-service.ts";
import { DocumentEditError } from "@openbooks/engine/src/records/document-edit-policy.ts";
import { runRecordFlows } from "@openbooks/engine/src/flows/run.ts";
import { DocumentCreateConflict } from "../../../../lib/documents.ts";
import type { DocumentEditInput } from "../../../../../engine/src/ledger/document-input.ts";
import { getAuthz, can, guardSubsidiaryScope, subsidiariesInScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { isDocKindEnabled } from "../../../../lib/documents.ts";
import { notFound } from "@/lib/api/responses";
import { apiErrorResponse } from "@/lib/api/error-response";

const SummaryLineSchema = z.object({
  accountId: z.string().uuid(),
  amount: z.string().min(1),
  description: z.string().max(500).nullable().optional(),
  quantity: z.string().nullable().optional(),
  unitPrice: z.string().nullable().optional(),
  taxCodeId: z.string().uuid().nullable().optional(),
  taxGroupId: z.string().uuid().nullable().optional(),
});

const SummaryTenderSchema = z.object({
  kind: z.enum(['cash', 'card', 'bank_transfer', 'wallet', 'gateway', 'stored_value', 'other']),
  methodLabel: z.string().max(120).nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  storedValueAccountId: z.string().uuid().nullable().optional(),
  amount: z.string().min(1),
  reference: z.string().max(120).nullable().optional(),
  externalRef: z.string().max(120).nullable().optional(),
  tipAmount: z.string().nullable().optional(),
  feeAmount: z.string().nullable().optional(),
});

const POSTBodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  partyId: z.string().uuid().nullable().optional(),
  subsidiaryId: z.string().uuid().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
  lines: z.array(SummaryLineSchema).min(1).max(500),
  tenders: z.array(SummaryTenderSchema).min(1).max(60),
  closeout: z.object({
    overShort: z.string().nullable().optional(),
    serverPartyId: z.string().uuid().nullable().optional(),
  }).nullable().optional(),
});

export const runtime = 'nodejs'

/**
 * Daily summary entry: one form (date, totals by tax code and category,
 * tenders, tips, fees, over/short) creating the day's cash sale as a draft
 * through the native document path — line tax from the named tax codes
 * (per-line, like the drawer), tenders into document_tenders, the close-out
 * onto custom.closeout. The cashier reviews and posts it from the drawer.
 */
export const POST = defineRoute({
  public: 'session',
  body: POSTBodySchema,
  handler: async ({ request: req , body: routeBody }) => {
    const authz = await getAuthz()
    if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const user = authz.user
    if (!can(authz, 'cash_sales.create')) {
      return NextResponse.json({ error: 'missing permission: cash_sales.create' }, { status: 403 })
    }
    if (!(await isDocKindEnabled(user.orgId, 'cash_sale'))) {
      return notFound("record")
    }
    if (routeBody.subsidiaryId !== undefined &&
        routeBody.subsidiaryId !== null &&
        !subsidiariesInScope(authz, [routeBody.subsidiaryId])) {
      return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
    }
    const headerKey = req.headers.get('Idempotency-Key')?.trim() ?? ''
    if (headerKey !== '' && !isUuid(headerKey)) {
      return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 400 })
    }
    let subsidiaryId: string | null = null
    if (routeBody.subsidiaryId !== undefined) {
      subsidiaryId = routeBody.subsidiaryId
    } else {
      const roots = (await db.execute<{ id: string }>(sql`
        select id from subsidiaries
         where org_id = ${user.orgId} and is_active and not is_elimination
         order by (parent_id is null) desc, name`)).rows.map((r) => r.id)
      subsidiaryId = roots.find((id) => !authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(id)) ?? null
      if (!subsidiaryId) {
        return NextResponse.json({ error: 'no_available_subsidiary' }, { status: 409 })
      }
    }
    const body: DocumentEditInput = {
      documentDate: routeBody.date,
      partyId: routeBody.partyId ?? undefined,
      memo: routeBody.memo ?? undefined,
      ...(routeBody.currency ? { currency: routeBody.currency } : {}),
      subsidiaryId,
      custom: {
        tenders: routeBody.tenders.map((tender) => ({
          kind: tender.kind,
          ...(tender.methodLabel ? { methodLabel: tender.methodLabel } : {}),
          ...(tender.accountId ? { accountId: tender.accountId } : {}),
          ...(tender.storedValueAccountId ? { storedValueAccountId: tender.storedValueAccountId } : {}),
          amount: tender.amount,
          ...(tender.reference ? { reference: tender.reference } : {}),
          ...(tender.externalRef ? { externalRef: tender.externalRef } : {}),
          ...(tender.tipAmount ? { tipAmount: tender.tipAmount } : {}),
          ...(tender.feeAmount ? { feeAmount: tender.feeAmount } : {}),
        })),
        ...(routeBody.closeout
          ? {
              closeout: {
                ...(routeBody.closeout.overShort ? { overShort: routeBody.closeout.overShort } : {}),
                ...(routeBody.closeout.serverPartyId ? { serverPartyId: routeBody.closeout.serverPartyId } : {}),
              },
            }
          : {}),
      },
      lines: routeBody.lines.map((line) => ({
        accountId: line.accountId,
        amount: line.amount,
        ...(line.description ? { description: line.description } : {}),
        ...(line.quantity ? { quantity: line.quantity } : {}),
        ...(line.unitPrice ? { unitPrice: line.unitPrice } : {}),
        ...(line.taxCodeId ? { taxCodeId: line.taxCodeId } : {}),
        ...(line.taxGroupId ? { taxGroupId: line.taxGroupId } : {}),
      })),
    }
    let created: Awaited<ReturnType<typeof createDocument>>
    try {
      created = await createDocument({
        orgId: user.orgId,
        userId: user.id,
        kind: 'cash_sale',
        key: headerKey !== '' ? headerKey : randomUUID(),
        body,
        subsidiaryId,
        requestBody: { kind: 'cash_sale', ...body },
      })
    } catch (e) {
      if (e instanceof DocumentCreateConflict) {
        return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 409 })
      }
      if (e instanceof DocumentEditError) {
        if (e.status === 404 && e.message === 'not found') return notFound("record")
        return apiErrorResponse(e, { details: e.fieldErrors ? { fieldErrors: e.fieldErrors } : undefined })
      }
      throw e
    }
    if (created.status === 'replayed') {
      const doc = await loadDocument(created.id, user.orgId)
      if (!doc) return notFound("record")
      const replayDenied = guardSubsidiaryScope(authz, doc.doc.subsidiary_id as string | null)
      if (replayDenied) return replayDenied
      return NextResponse.json(doc)
    }
    await runRecordFlows({ kind: 'on_create', source: 'ui' }, 'cash_sale', created.id, { orgId: user.orgId, userId: user.id })
    if (created.deferredUpdate) {
      await runRecordFlows(created.deferredUpdate, 'cash_sale', created.id, { orgId: user.orgId, userId: user.id })
    }
    const doc = await loadDocument(created.id, user.orgId)
    if (!doc) return notFound("record")
    const createdDenied = guardSubsidiaryScope(authz, doc.doc.subsidiary_id as string | null)
    if (createdDenied) return createdDenied
    return NextResponse.json(doc, { status: 201 })
  },
});
