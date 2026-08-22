import { and, eq, sql } from "drizzle-orm";
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
 * supertype, collapsed onto OpenBooks' single documents table.
 *
 * loadContext mirrors how engine/src/scripting.ts builds a ScriptContext:
 * header row + ordered lines. The header is flattened into `values` (the
 * curated DOCUMENT_FIELDS keys plus everything else on the row for template
 * use); lines ride in `rows.lines` so LogicRule/formula section rollups
 * (sum_section('lines', …)) work, with a scalar `lineCount` in values.
 */

type DocRow = typeof schema.documents.$inferSelect;

/**
 * Legal change_status transitions for flows. submit flips draft →
 * pending_approval (flows/submit.ts); a gate decision resumes the run, and the
 * flow's change_status action on the approve/reject branch flips
 * pending_approval → approved | draft; posting/voiding are PIPELINES
 * (posting.ts / payments.ts), not
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
  vendor_bill: (id) => `/ap/bills?doc=${id}`,
  vendor_credit: (id) => `/ap/bills?doc=${id}`,
  customer_invoice: (id) => `/ar/invoices?doc=${id}`,
  customer_credit: (id) => `/ar/invoices?doc=${id}`,
  card_charge: (id) => `/banking/transactions?doc=${id}`,
  card_refund: (id) => `/banking/transactions?doc=${id}`,
  check: (id) => `/banking/transactions?doc=${id}`,
  deposit: (id) => `/banking/transactions?doc=${id}`,
  transfer: (id) => `/banking/transactions?doc=${id}`,
  expense_report: (id) => `/expenses/reports?expense=${id}`,
  journal: (id) => `/journal?entry=${id}`,
  vendor_payment: (id) => `/payments?payment=${id}`,
  customer_payment: (id) => `/receipts?payment=${id}`,
  sales_order: (id) => `/sales-orders?order=${id}`,
  purchase_order: (id) => `/purchase-orders?order=${id}`,
  quote: (id) => `/estimates?estimate=${id}`,
};

async function loadDoc(subjectId: string, orgId?: string): Promise<DocRow | null> {
  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(
      orgId
        ? and(eq(schema.documents.id, subjectId), eq(schema.documents.orgId, orgId))
        : eq(schema.documents.id, subjectId),
    );
  return doc ?? null;
}

/**
 * The real document header fields, one key per built-in column. Kept as its
 * own unconditional literal so RESERVED_DOCUMENT_FIELD_KEYS can enumerate it —
 * add a column here and the reserved set follows automatically.
 */
function builtinHeaderValues(doc: DocRow, partyName: string | null): Record<string, unknown> {
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
  };
}

export function headerValues(doc: DocRow, partyName: string | null): Record<string, unknown> {
  return {
    // Registered custom jsonb keys ride along for interpolation and conditions;
    // the tenant-aware authoring profile exposes only active definitions.
    // Precedence invariant: customs spread FIRST and the built-ins are
    // re-asserted after, so a custom field can never shadow a real header
    // value (`total`, `status`, …) in a flow condition or {{token}} — that
    // would let record data override approval logic. Authoring rejects such
    // keys outright (RESERVED_DOCUMENT_FIELD_KEYS); this ordering is the
    // runtime backstop for definitions that predate the rule.
    ...(typeof doc.custom === "object" && doc.custom !== null
      ? (doc.custom as Record<string, unknown>)
      : {}),
    ...builtinHeaderValues(doc, partyName),
  };
}

/**
 * Custom-field keys that must never be registered against `documents`: they
 * name a real header field (or a flow-writable column) and would either shadow
 * it in condition evaluation or be silently unreachable. Derived 1:1 from
 * builtinHeaderValues + WRITABLE_DOCUMENT_FIELDS so it cannot drift from what
 * headerValues actually exposes; enforced at custom-field registration.
 */
export const RESERVED_DOCUMENT_FIELD_KEYS: ReadonlySet<string> = new Set([
  // Keyless probe: enumerates the built-in header keys without a row (every
  // key above is read unconditionally).
  ...Object.keys(builtinHeaderValues({} as DocRow, null)),
  ...WRITABLE_DOCUMENT_FIELDS,
]);

export function createDocumentsFlowAdapter(kind: string): FlowSubjectAdapter {
  return {
    subjectKind: kind,
    profile: documentSubjectProfile(kind),
    writableFields: WRITABLE_DOCUMENT_FIELDS,

    async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
      const doc = await loadDoc(subjectId);
      if (!doc) return null;
      let partyName: string | null = null;
      let vendorEftEmail: string | null = null;
      if (doc.partyId) {
        const r = (await db.execute<{ display_name: string; eft_notification_email: string | null }>(sql`
          select p.display_name, vr.eft_notification_email
            from parties p
            left join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
           where p.id = ${doc.partyId} and p.org_id = ${doc.orgId}
        `));
        partyName = r.rows[0]?.display_name ?? null;
        vendorEftEmail = r.rows[0]?.eft_notification_email ?? null;
      }
      const lines = await db
        .select()
        .from(schema.documentLines)
        .where(and(eq(schema.documentLines.documentId, subjectId), eq(schema.documentLines.orgId, doc.orgId)))
        .orderBy(schema.documentLines.lineNumber);
      const values = headerValues(doc, partyName);
      values.lineCount = lines.length;
      // The vendor's remittance address (vendor_roles.eft_notification_email)
      // — a `field` recipient target delivers to it directly (EFT emails).
      values.vendorEftEmail = vendorEftEmail;
      return {
        values,
        rows: { lines: lines as unknown as Array<Record<string, unknown>> },
        submitterUserId: doc.submittedBy ?? doc.createdBy ?? null,
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
      const doc = await loadDoc(subjectId, ctx.orgId);
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
        .where(and(eq(schema.documents.id, subjectId), eq(schema.documents.orgId, ctx.orgId)));
    },

    async releaseApproval(
      subjectId: string,
      outcome: "approved" | "rejected",
      ctx: FlowExecCtx,
      detail?: { comment?: string | null },
    ): Promise<void> {
      // Deterministic, engine-owned release — independent of any authored
      // change_status node. Only acts while the record is awaiting approval, so
      // it is idempotent and never fights a status a later action set.
      const doc = await loadDoc(subjectId, ctx.orgId);
      if (
        doc?.voidRequestedAt &&
        (doc.status === "posted" || doc.status === "approved")
      ) {
        const { completeRequestedDocumentVoid, rejectRequestedDocumentVoid } =
          await import("../document-void.ts");
        if (outcome === "approved") {
          await completeRequestedDocumentVoid(subjectId, ctx.orgId);
        } else {
          await rejectRequestedDocumentVoid(
            subjectId,
            ctx.orgId,
            ctx.userId ?? null,
            detail?.comment ?? null,
          );
        }
        return;
      }
      if (!doc || doc.status !== "pending_approval") return;
      const to = outcome === "approved" ? "approved" : "draft";
      await db
        .update(schema.documents)
        .set({
          status: to as DocRow["status"],
          ...(outcome === "rejected" ? { submittedBy: null, submittedAt: null } : {}),
          updatedBy: ctx.userId ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.documents.id, subjectId), eq(schema.documents.orgId, ctx.orgId)));
    },

    async setField(subjectId: string, field: string, value: unknown, ctx: FlowExecCtx): Promise<void> {
      if (!WRITABLE_DOCUMENT_FIELDS.has(field)) {
        const customField = (await db.execute(sql`
          select 1 from custom_field_defs
           where org_id = ${ctx.orgId} and target_table = 'documents'
             and (target_kind is null or target_kind = ${kind})
             and key = ${field} and is_active
           limit 1
        `));
        if (customField.rows.length === 0) {
          throw new Error(`field "${field}" is not writable by flows`);
        }
        await db.execute(sql`
          update documents
             set custom = jsonb_set(coalesce(custom, '{}'::jsonb), array[${field}]::text[], ${JSON.stringify(value ?? null)}::jsonb),
                 updated_by = ${ctx.userId ?? null}, updated_at = now()
           where id = ${subjectId} and org_id = ${ctx.orgId}
        `);
        return;
      }
      await db
        .update(schema.documents)
        .set({ [field]: value, updatedBy: ctx.userId ?? null, updatedAt: new Date() })
        .where(and(eq(schema.documents.id, subjectId), eq(schema.documents.orgId, ctx.orgId)));
    },

    async findCandidateIds(limit: number): Promise<string[]> {
      // Coarse newest-first fetch for scheduled fan-out; the select rule does
      // the real filtering in JS against each record's loaded context. Runs
      // inside withOrg(flow.orgId), so RLS scopes the org. Voided docs are
      // terminal and never candidates.
      const r = (await db.execute<{ id: string }>(sql`
        select id from documents
         where kind = ${kind} and status <> 'voided'
         order by created_at desc
         limit ${limit}
      `));
      return r.rows.map((row) => row.id);
    },
  };
}

export { DOCUMENT_FIELDS };
