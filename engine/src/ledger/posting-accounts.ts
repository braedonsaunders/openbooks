import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { revenueRecognitionFeatureEnabled } from "../revenue/recognition.ts";
import { type Doc, type KernelLine, type PostingDeps, type TaxPostingComponent, PostingError } from "./posting-rules.ts";
/** document_line id → deferred-revenue account for rev-rec invoice lines. */
export async function resolveDeferralAccounts(
  runner: Pick<typeof db, "execute">,
  documentId: string,
  orgId: string,
): Promise<Map<string, string>> {
  if (!(await revenueRecognitionFeatureEnabled(runner, orgId))) return new Map();
  const r = (await runner.execute<{ line_id: string; deferred_account_id: string }>(sql`
    select dl.id as line_id,
           coalesce(it.deferred_account_id, r.deferred_account_id) as deferred_account_id
      from document_lines dl
      join items it on it.id = dl.item_id and it.org_id = dl.org_id and it.recognition_rule_id is not null
      join recognition_rules r on r.id = it.recognition_rule_id and r.org_id = it.org_id
     where dl.document_id = ${documentId}
       and dl.org_id = ${orgId}
       and coalesce(it.deferred_account_id, r.deferred_account_id) is not null`));
  const map = new Map<string, string>();
  for (const row of r.rows) map.set(row.line_id, row.deferred_account_id);
  return map;
}

/** tax code id → its own collected/paid control accounts, when configured. */
export async function resolveTaxAccounts(
  runner: Pick<typeof db, "execute">,
  orgId: string,
): Promise<{ collected: Map<string, string>; paid: Map<string, string> }> {
  const r = (await runner.execute<{
      id: string;
      collected_account_id: string | null;
      paid_account_id: string | null;
    }>(sql`
    select id, collected_account_id, paid_account_id from tax_codes
     where org_id = ${orgId} and (collected_account_id is not null or paid_account_id is not null)`));
  const collected = new Map<string, string>();
  const paid = new Map<string, string>();
  for (const row of r.rows) {
    if (row.collected_account_id)
      collected.set(row.id, row.collected_account_id);
    if (row.paid_account_id) paid.set(row.id, row.paid_account_id);
  }
  return { collected, paid };
}

/**
 * The employee-receivable control for personal expense lines (0171), loaded at
 * the posting boundary like the tax fallbacks. Only read when a personal line
 * actually posts — orgs that never file one need not configure it — and
 * validated against the account's type here, so a misconfigured mapping fails
 * closed at the boundary instead of debiting a random account.
 */
async function resolveEmployeeReceivable(
  runner: Pick<typeof db, "execute">,
  orgId: string,
): Promise<string | undefined> {
  // The regex gate keeps a malformed stored id from dying as a raw 22P02
  // cast error: it surfaces as a domain refusal instead. Same UUID shape the
  // control-accounts reader enforces.
  const r = await runner.execute<{
    raw: string | null; id: string | null; type: string | null;
    isActive: boolean | null; isSummary: boolean | null;
  }>(sql`
    select (o.settings->'controlAccounts'->>'employeeReceivable') as raw,
           a.id::text as id, a.type as type,
           a.is_active as "isActive", a.is_summary as "isSummary"
      from orgs o
      left join accounts a on a.org_id = o.id
       and coalesce(o.settings->'controlAccounts'->>'employeeReceivable', '') ~
           '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       and a.id = (o.settings->'controlAccounts'->>'employeeReceivable')::uuid
     where o.id = ${orgId}`);
  const row = r.rows[0];
  if (!row?.raw) return undefined;
  if (!row.id) {
    throw new PostingError("employee-receivable control account does not exist in this organization");
  }
  if (row.isActive !== true) throw new PostingError("employee-receivable control account is inactive");
  if (row.isSummary === true) throw new PostingError("employee-receivable control account is a summary account");
  if (row.type !== "asset_receivable" && row.type !== "asset_current_other") {
    throw new PostingError(
      `employee-receivable control account type ${row.type} is incompatible; expected asset_receivable, asset_current_other`,
    );
  }
  return row.id;
}

/**
 * Attach the employee-receivable control when an expense report actually has
 * personal lines (0171). One probe, only for expense reports missing the dep:
 * orgs that never file a personal line pay no query and need no configuration.
 * Explicit caller values still win. Shared by postDocument and
 * regenerateGlImpactTx — the two sites that default posting deps.
 */
export async function resolveExpenseReceivableDeps(
  runner: Pick<typeof db, "execute">,
  doc: Doc,
  deps: PostingDeps,
): Promise<PostingDeps> {
  if (doc.kind !== "expense_report" || deps.control.employeeReceivable) return deps;
  const probe = await runner.execute<{ one: number }>(sql`
    select 1 as one from document_lines
     where org_id = ${doc.orgId} and document_id = ${doc.id}
       and settlement_type = 'personal'
     limit 1`);
  if (!probe.rows[0]) return deps;
  const employeeReceivable = await resolveEmployeeReceivable(runner, doc.orgId);
  return { ...deps, control: { ...deps.control, employeeReceivable } };
}

/** Org-level tax fallbacks are loaded at the posting boundary, not trusted to
 * every caller to copy from settings. Explicit caller values still win. */
export async function resolveOrgTaxAccounts(
  runner: Pick<typeof db, "execute">,
  orgId: string,
): Promise<{ taxCollected: string | undefined; taxPaid: string | undefined }> {
  const r = await runner.execute<{
    tax_collected: string | null;
    tax_paid: string | null;
  }>(sql`
    select settings->'controlAccounts'->>'taxCollected' as tax_collected,
           settings->'controlAccounts'->>'taxPaid' as tax_paid
      from orgs
     where id = ${orgId}`);
  return {
    taxCollected: r.rows[0]?.tax_collected ?? undefined,
    taxPaid: r.rows[0]?.tax_paid ?? undefined,
  };
}

export async function resolveTaxComponents(
  runner: Pick<typeof db, "execute">,
  documentId: string,
  orgId: string,
): Promise<Map<string, TaxPostingComponent[]>> {
  const result = (await runner.execute<{
    document_line_id: string;
    tax_code_id: string;
    sequence: number;
    rate_percent: string;
    taxable_amount: string;
    tax_amount: string;
    recoverable_amount: string;
    nonrecoverable_amount: string;
    calculation_type: "standard" | "withholding" | "reverse_charge";
    price_includes_tax: boolean;
    compound_on_previous: boolean;
    rounding_scale: number;
    collected_account_id: string | null;
    paid_account_id: string | null;
    withholding_account_id: string | null;
    recoverable_percent: string | null;
  }>(sql`
    select c.document_line_id, c.tax_code_id, c.sequence, c.rate_percent::text,
           c.taxable_amount::text, c.tax_amount::text,
           c.recoverable_amount::text, c.nonrecoverable_amount::text,
           c.calculation_type, c.price_includes_tax, c.compound_on_previous,
           c.rounding_scale, c.collected_account_id, c.paid_account_id,
           c.withholding_account_id,
           case when c.tax_amount = 0 then tc.recoverable_percent::text
                else (c.recoverable_amount / c.tax_amount * 100)::text end as recoverable_percent
      from document_line_tax_components c
      join tax_codes tc on tc.id = c.tax_code_id and tc.org_id = c.org_id
      join document_lines dl on dl.id = c.document_line_id and dl.org_id = c.org_id
     where dl.document_id = ${documentId}
       and dl.org_id = ${orgId}
     order by c.document_line_id, c.sequence
  `));
  const byLine = new Map<string, TaxPostingComponent[]>();
  for (const row of result.rows) {
    const lineId = String(row.document_line_id);
    const components = byLine.get(lineId) ?? [];
    components.push({
      taxCodeId: String(row.tax_code_id),
      sequence: Number(row.sequence),
      ratePercent: String(row.rate_percent),
      taxableAmount: String(row.taxable_amount),
      taxAmount: String(row.tax_amount),
      recoverableAmount: String(row.recoverable_amount),
      nonrecoverableAmount: String(row.nonrecoverable_amount),
      calculationType: row.calculation_type,
      priceIncludesTax: Boolean(row.price_includes_tax),
      compoundOnPrevious: Boolean(row.compound_on_previous),
      roundingScale: Number(row.rounding_scale),
      collectedAccountId: row.collected_account_id,
      paidAccountId: row.paid_account_id,
      withholdingAccountId: row.withholding_account_id,
      recoverablePercent: row.recoverable_percent == null ? undefined : String(row.recoverable_percent),
    });
    byLine.set(lineId, components);
  }
  return byLine;
}

export async function validateRequiredDimensions(
  runner: Pick<typeof db, "execute">,
  orgId: string,
  lines: KernelLine[],
): Promise<void> {
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const rows = (await runner.execute<{
      id: string;
      number: string | null;
      name: string;
      required_dimensions: string[];
      segment_names: Record<string, string>;
    }>(sql`
    select a.id, a.number, a.name, a.required_dimensions,
           coalesce(jsonb_object_agg(sd.key, sd.name) filter (where sd.key is not null), '{}'::jsonb) as segment_names
      from accounts a
      left join segment_definitions sd on sd.org_id = a.org_id and sd.is_active
     where a.org_id = ${orgId}
       and a.id = any(${`{${accountIds.join(",")}}`}::uuid[])
     group by a.id
  `));
  const byAccount = new Map(rows.rows.map((row) => [row.id, row]));
  const builtin: Record<string, keyof KernelLine> = {
    subsidiary: "subsidiaryId",
    department: "departmentId",
    project: "projectId",
    location: "locationId",
    class: "classId",
    party: "partyId",
  };
  for (const line of lines) {
    const account = byAccount.get(line.accountId);
    for (const key of account?.required_dimensions ?? []) {
      const present = builtin[key]
        ? Boolean(line[builtin[key]!])
        : Boolean(line.extraDims?.[key]);
      if (!present) {
        const label =
          account?.segment_names?.[key] ?? (key === "party" ? "Party" : key);
        throw new PostingError(
          `${label} is required for account ${account?.number ? `${account.number} · ` : ""}${account?.name ?? line.accountId}`,
        );
      }
    }
  }
}

/**
 * Accounts whose lines are open items on a journal (all AR/AP-typed accounts
 * of the org). One indexed select; called for journal, deposit, expense report
 * and check documents.
 */
export async function resolveOpenItemAccounts(
  runner: Pick<typeof db, "execute">,
  orgId: string,
): Promise<Set<string>> {
  // Open-item capability follows from control designation, not only from
  // account type: the industry presets wire the employee-reimbursements
  // control (settings.controlAccounts.employeePayable) to a
  // liability_current_other account, and an expense report's control line
  // must still be an open item there or it can never be settled through the
  // payment-application engine. The employee-receivable control (0171) joins
  // it for the same reason: personal lines debit it, and the balance must be
  // collectible through the application engine rather than stranded as a
  // non-open GL balance nobody can settle.
  const r = (await runner.execute<{ id: string }>(sql`
    select id from accounts
     where org_id = ${orgId} and type in ('asset_receivable', 'liability_payable')
    union
    select (settings->'controlAccounts'->>'employeePayable')::uuid as id
      from orgs
     where id = ${orgId}
       and settings->'controlAccounts'->>'employeePayable' is not null
    union
    select (settings->'controlAccounts'->>'employeeReceivable')::uuid as id
      from orgs
     where id = ${orgId}
       and settings->'controlAccounts'->>'employeeReceivable' is not null`));
  return new Set(r.rows.map((x) => x.id));
}
