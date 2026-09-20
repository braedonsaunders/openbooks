import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { computeTaxReturn, TaxReturnError } from "@openbooks/engine/src/tax-returns/return.ts";
import { can } from "../authz";
import { isDocKindEnabled } from "../documents";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import type { AssistantToolDef, ToolResult } from "./types";
import { rangeInputFields, resolveToolRange, type RangeArgs } from "./tools-shared";

/**
 * Indirect-tax tools. The return is computed by the SAME engine the /tax
 * filing screen and the export route use (`computeTaxReturn`: clamped to the
 * form's filing window, registration-aware, one repeatable-read snapshot), so
 * the assistant can never quote a box the filer would not see. Restricted
 * callers get one filing entity — their own allowed subsidiary set — never an
 * org-wide blend they may not read.
 */

const money = (v: unknown) => normalizeMoney(v == null ? "0" : String(v));

const listTaxReturnForms: AssistantToolDef = {
  name: "list_tax_return_forms",
  description:
    "Indirect-tax return forms for this org, with country, channel, registration status. Call before tax_return for form codes. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select f.code, f.name, f.country, f.submission_channel, f.is_active,
             (select count(*)::int from tax_registrations r
               where r.org_id = f.org_id and r.return_form_code = f.code) as registrations
        from tax_return_forms f
       where f.org_id = ${authz.user.orgId}
       order by f.is_active desc, f.country, f.code
    `));
    return {
      ok: true,
      data: {
        forms: rows.rows.map((r) => ({
          code: r.code,
          name: r.name,
          country: r.country,
          submissionChannel: r.submission_channel,
          active: r.is_active,
          registrations: r.registrations,
        })),
        href: "/tax",
      },
    };
  },
};

const taxReturn: AssistantToolDef = {
  name: "tax_return",
  description:
    "Indirect-tax return for a period (GST/HST, VAT, sales tax): every form box as the filing screen computes it; window clamped to the filing calendar, period stated. Needs a form code from list_tax_return_forms. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({
    formCode: z.string().max(40).describe("Form code from list_tax_return_forms, e.g. CA_GST34"),
    ...rangeInputFields,
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as RangeArgs & { formCode: string };
    const range = await resolveToolRange(authz.user.orgId, a);
    if ("error" in range) return { ok: false, error: range.error };
    const allowed = authz.allowedSubsidiaryIds;
    if (allowed !== null && allowed.size === 0) return { ok: false, error: "forbidden" };
    try {
      const result = await computeTaxReturn(
        authz.user.orgId,
        a.formCode,
        range.from,
        range.to,
        {},
        allowed === null ? {} : { filingEntity: { subsidiaryIds: [...allowed] } },
      );
      const clamped = result.from !== range.from || result.to !== range.to;
      return {
        ok: true,
        note: clamped
          ? `Requested ${range.from} – ${range.to}; the form's filing calendar clamped the return to ${result.from} – ${result.to}.`
          : undefined,
        data: {
          formCode: result.formCode,
          formName: result.formName,
          requestedPeriod: { label: range.label, from: range.from, to: range.to },
          from: result.from,
          to: result.to,
          currency: result.functionalCurrency,
          registrationNumber: result.registrationNumber,
          submissionChannel: result.submissionChannel,
          boxes: result.boxes.map((b) => ({
            lineCode: b.lineCode,
            label: b.label,
            value: b.value,
            computed: b.computed,
            adjustment: b.editable,
          })),
          href: `/tax?form=${encodeURIComponent(result.formCode)}&from=${result.from}&to=${result.to}`,
        },
      };
    } catch (error) {
      if (error instanceof TaxReturnError) return { ok: false, error: `tax_return: ${error.message}` };
      throw error;
    }
  },
};

/** Document kinds whose lines carry a tax code, with the page permission that reads them. */
const TAXABLE_KIND_PERM: Record<string, string> = {
  customer_invoice: "ar.read",
  customer_credit: "ar.read",
  vendor_bill: "ap.read",
  vendor_credit: "ap.read",
  expense_report: "expenses.read",
  card_charge: "ap.read",
};

const documentsMissingTaxCode: AssistantToolDef = {
  name: "documents_missing_tax_code",
  description:
    "Pre-filing review: posted documents in a period with non-zero lines lacking a tax code. Per-kind counts, untaxed amount, capped document list. Some lines are legitimately tax-free — a review list, not errors. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["ar.read", "ap.read", "expenses.read"] },
  inputSchema: z.object({
    kinds: z.array(z.string().max(40)).max(6).optional()
      .describe("Subset of customer_invoice, customer_credit, vendor_bill, vendor_credit, expense_report, card_charge; default all the caller may read"),
    status: z.enum(["posted", "approved", "pending_approval", "draft"]).optional().describe("Default posted"),
    ...rangeInputFields,
    limit: z.number().int().min(1).max(100).optional().describe("Default 25 documents"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as RangeArgs & { kinds?: string[]; status?: string; limit?: number };
    const range = await resolveToolRange(authz.user.orgId, a);
    if ("error" in range) return { ok: false, error: range.error };
    const readable: string[] = [];
    for (const kind of Object.keys(TAXABLE_KIND_PERM)) {
      if (!can(authz, TAXABLE_KIND_PERM[kind]!)) continue;
      if (!(await isDocKindEnabled(authz.user.orgId, kind))) continue;
      readable.push(kind);
    }
    const kinds = a.kinds?.length ? a.kinds.filter((k) => readable.includes(k)) : readable;
    if (kinds.length === 0) return { ok: false, error: "forbidden" };
    const status = a.status ?? "posted";
    const limit = Math.min(a.limit ?? 25, 100);
    const scope = subsidiaryVisibleFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds);
    const kindSet = sql.join(kinds.map((k) => sql`${k}`), sql`, `);
    const where = sql`
      d.org_id = ${authz.user.orgId}
      and d.kind in (${kindSet})
      and d.status = ${status}
      and d.document_date between ${range.from} and ${range.to}
      ${scope}
    `;
    const docs = (await db.execute<Record<string, unknown>>(sql`
      with hits as (
        select d.id, d.kind, d.document_number, d.document_date, d.status, d.total, d.party_id,
               count(dl.id)::int as untaxed_lines,
               coalesce(sum(dl.amount), 0) as untaxed_amount
          from documents d
          join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id
         where ${where}
           and dl.tax_code_id is null and dl.amount <> 0
         group by d.id, d.kind, d.document_number, d.document_date, d.status, d.total, d.party_id
      )
      select h.*, p.display_name as party, count(*) over () as total_docs
        from hits h
        left join parties p on p.id = h.party_id and p.org_id = ${authz.user.orgId}
       order by h.untaxed_amount desc, h.document_date desc
       limit ${limit}
    `));
    const byKind = (await db.execute<Record<string, unknown>>(sql`
      select d.kind, count(distinct d.id)::int as documents, coalesce(sum(dl.amount), 0) as untaxed_amount
        from documents d
        join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id
       where ${where}
         and dl.tax_code_id is null and dl.amount <> 0
       group by d.kind
       order by d.kind
    `));
    const total = Number(docs.rows[0]?.total_docs ?? 0);
    return {
      ok: true,
      data: {
        periodLabel: range.label,
        fromDate: range.from,
        toDate: range.to,
        status,
        kinds,
        totalDocuments: total,
        returned: docs.rows.length,
        truncated: total > docs.rows.length,
        byKind: byKind.rows.map((r) => ({ kind: r.kind, documents: r.documents, untaxedAmount: money(r.untaxed_amount) })),
        documents: docs.rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          documentNumber: r.document_number,
          documentDate: r.document_date,
          status: r.status,
          party: r.party,
          total: money(r.total),
          untaxedLines: r.untaxed_lines,
          untaxedAmount: money(r.untaxed_amount),
        })),
      },
    };
  },
};

export const TAX_TOOLS: AssistantToolDef[] = [listTaxReturnForms, taxReturn, documentsMissingTaxCode];
