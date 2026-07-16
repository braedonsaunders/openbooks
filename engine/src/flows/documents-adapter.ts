import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import {
  DOCUMENT_FIELDS,
  WRITABLE_DOCUMENT_FIELDS,
  documentSubjectProfile,
} from "./subject-profiles.ts";

/**
 * The documents FlowSubjectAdapter — one adapter instance per document kind
 * (subjectKind = the kind string, 'vendor_bill' …), all sharing the documents
 * supertype. Ported from beaconhs-platform's lib/flows/adapters/journals.ts
 * (the cleanest module adapter there), collapsed onto openbooks' single
 * documents table.
 *
 * loadContext mirrors how engine/src/scripting.ts builds a ScriptContext:
 * header row + ordered lines. The header is flattened into `values` (the
 * curated DOCUMENT_FIELDS keys plus everything else on the row for template
 * use); lines ride in `rows.lines` so LogicRule/formula section rollups
 * (sum_section('lines', …)) work, with a scalar `lineCount` in values.
 */

type DocRow = typeof schema.documents.$inferSelect;

/**
 * Legal change_status transitions for flows. Mirrors what the existing
 * engines do today: submit flips draft → pending_approval (approvals.ts),
 * approve/reject flips pending_approval → approved | draft (approvals.ts
 * decide), and posting/voiding are PIPELINES (posting.ts / payments.ts), not
 * bare status writes — a flow reaches 'posted' via the post_document action,
 * never via change_status.
 */
const STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  pending_approval: ["draft"],
  approved: ["draft", "pending_approval"],
  draft: ["pending_approval"], // reject path: back to draft for edits
};

/**
 * kind → record deep link (the list page whose drawer searchParam opens the
 * record flyout). Static map because the engine cannot import the web
 * package: these mirror web/lib/documents.ts DOC_KINDS + each list page's
 * flyout param (/ap + /ar + /banking/transactions use ?doc=, /expenses uses
 * ?expense=, /journal uses ?entry=, /payments + /receipts use ?payment=, the
 * order pages use ?order= / ?estimate=). Keep in sync when a list page's
 * route or drawer param changes.
 */
const RECORD_ROUTES: Record<string, (id: string) => string> = {
  vendor_bill: (id) => `/ap?doc=${id}`,
  vendor_credit: (id) => `/ap?doc=${id}`,
  customer_invoice: (id) => `/ar?doc=${id}`,
  customer_credit: (id) => `/ar?doc=${id}`,
  card_charge: (id) => `/banking/transactions?doc=${id}`,
  card_refund: (id) => `/banking/transactions?doc=${id}`,
  check: (id) => `/banking/transactions?doc=${id}`,
  deposit: (id) => `/banking/transactions?doc=${id}`,
  transfer: (id) => `/banking/transactions?doc=${id}`,
  expense_report: (id) => `/expenses?expense=${id}`,
  journal: (id) => `/journal?entry=${id}`,
  vendor_payment: (id) => `/payments?payment=${id}`,
  customer_payment: (id) => `/receipts?payment=${id}`,
  sales_order: (id) => `/sales-orders?order=${id}`,
  purchase_order: (id) => `/purchase-orders?order=${id}`,
  quote: (id) => `/estimates?estimate=${id}`,
};

async function loadDoc(subjectId: string): Promise<DocRow | null> {
  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, subjectId));
  return doc ?? null;
}

function headerValues(doc: DocRow, partyName: string | null): Record<string, unknown> {
  return {
    id: doc.id,
    kind: doc.kind,
    documentNumber: doc.documentNumber,
    status: doc.status,
    partyId: doc.partyId,
    partyName,
    documentDate: doc.documentDate,
    postingDate: doc.postingDate,
    dueDate: doc.dueDate,
    expectedPayDate: doc.expectedPayDate,
    currency: doc.currency,
    fxRate: doc.fxRate,
    subtotal: doc.subtotal,
    taxTotal: doc.taxTotal,
    total: doc.total,
    openBalance: doc.openBalance,
    memo: doc.memo,
    internalNotes: doc.internalNotes,
    referenceNumber: doc.referenceNumber,
    paymentHoldReason: doc.paymentHoldReason,
    billingMethod: doc.billingMethod,
    isFinalInvoice: doc.isFinalInvoice,
    departmentId: doc.departmentId,
    projectId: doc.projectId,
    locationId: doc.locationId,
    classId: doc.classId,
    createdBy: doc.createdBy,
    // Custom jsonb keys ride along for {{interpolation}} / conditions; they
    // are NOT in the curated profile field list, so the lint flags authored
    // references — authors opt in knowingly (same posture as scripts).
    ...(typeof doc.custom === "object" && doc.custom !== null
      ? (doc.custom as Record<string, unknown>)
      : {}),
  };
}

export function createDocumentsFlowAdapter(kind: string): FlowSubjectAdapter {
  return {
    subjectKind: kind,
    profile: documentSubjectProfile(kind),
    writableFields: WRITABLE_DOCUMENT_FIELDS,

    async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
      const doc = await loadDoc(subjectId);
      if (!doc) return null;
      let partyName: string | null = null;
      if (doc.partyId) {
        const r = (await db.execute(
          sql`select display_name from parties where id = ${doc.partyId}`,
        )) as unknown as { rows: { display_name: string }[] };
        partyName = r.rows[0]?.display_name ?? null;
      }
      const lines = await db
        .select()
        .from(schema.documentLines)
        .where(eq(schema.documentLines.documentId, subjectId))
        .orderBy(schema.documentLines.lineNumber);
      const values = headerValues(doc, partyName);
      values.lineCount = lines.length;
      return {
        values,
        rows: { lines: lines as unknown as Array<Record<string, unknown>> },
        submitterUserId: doc.createdBy ?? null,
      };
    },

    label(subjectId: string, values: Record<string, unknown>): string {
      const kindLabel = String(values.kind ?? kind).replace(/_/g, " ");
      const num = values.documentNumber ? ` ${String(values.documentNumber)}` : "";
      const party = values.partyName ? ` — ${String(values.partyName)}` : "";
      return `${kindLabel}${num}${party}` || subjectId;
    },

    deepLink(subjectId: string): string {
      const build = RECORD_ROUTES[kind];
      return build ? build(subjectId) : "/approvals";
    },

    async getStatus(subjectId: string): Promise<string | null> {
      const doc = await loadDoc(subjectId);
      return doc?.status ?? null;
    },

    async changeStatus(subjectId: string, to: string, ctx: FlowExecCtx): Promise<void> {
      const doc = await loadDoc(subjectId);
      if (!doc) throw new Error(`document ${subjectId} not found`);
      const legalFrom = STATUS_TRANSITIONS[to];
      if (!legalFrom) {
        throw new Error(
          `change_status to "${to}" is not allowed from a flow` +
            (to === "posted" ? " — use the post_document action" : ""),
        );
      }
      if (doc.status === to) return; // idempotent no-op (replays)
      if (!legalFrom.includes(doc.status)) {
        throw new Error(`illegal status transition ${doc.status} → ${to} for ${doc.documentNumber}`);
      }
      await db
        .update(schema.documents)
        .set({ status: to as DocRow["status"], updatedBy: ctx.userId ?? null, updatedAt: new Date() })
        .where(eq(schema.documents.id, subjectId));
    },

    async setField(subjectId: string, field: string, value: unknown, ctx: FlowExecCtx): Promise<void> {
      if (!WRITABLE_DOCUMENT_FIELDS.has(field)) {
        throw new Error(`field "${field}" is not writable by flows`);
      }
      await db
        .update(schema.documents)
        .set({ [field]: value, updatedBy: ctx.userId ?? null, updatedAt: new Date() })
        .where(eq(schema.documents.id, subjectId));
    },
  };
}

export { DOCUMENT_FIELDS };
