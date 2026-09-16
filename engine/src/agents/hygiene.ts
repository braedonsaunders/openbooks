import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import type { ContinuousCloseDetectorPolicy } from "../continuous-close-config.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Data-hygiene pack — control-account/type mismatches, duplicate party
 * identities, items without tax codes, projects without cost budgets, budget
 * scenarios with no lines, and unmapped payroll components.
 *
 * Every detector is a deterministic master-data invariant; severities are
 * warnings and materialities are zero (supportsMateriality false) because a
 * hygiene gap is a review task, not a measured exposure.
 *
 * Proposals are deliberately absent: each fix needs human judgment (which
 * type is right, which party survives, which tax code applies, which account
 * a component maps to), and a proposed command must carry exact input — a
 * guessed account id or tax code would be worse than no proposal. Findings
 * name the exact review path instead (the `pay-components` setup entity and
 * its expenseAccountId/liabilityAccountId/remittancePartyId fields in
 * `web/lib/setup/registry.ts` back the payroll fix; the enrichment agent
 * turns that into an `update_setup_record` card once the user picks values).
 * The pack never writes.
 */

export const HYGIENE_DETECTOR_KEYS = [
  "control_account_type_mismatch",
  "duplicate_party_identity",
  "item_missing_tax_code",
  "project_missing_cost_budget",
  "budget_scenario_without_lines",
  "unmapped_payroll_component",
] as const;

/**
 * Vendor-neutral name/type expectations keyed on whole-word account-name
 * keywords. Families are the account-type prefix (`asset_bank` → `asset`).
 * Deliberately narrow: a keyword fires only when the name states a nature
 * the type contradicts (a provision is never an asset; cash is never an
 * income account).
 */
const NAME_TYPE_EXPECTATIONS: { pattern: RegExp; families: string[]; label: string }[] = [
  { pattern: /\bbank\b|\bcash\b/, families: ["asset"], label: "bank/cash" },
  { pattern: /\breceivable\b/, families: ["asset"], label: "receivable" },
  { pattern: /\bpayable\b/, families: ["liability"], label: "payable" },
  { pattern: /\bincome\b|\brevenue\b/, families: ["income"], label: "income/revenue" },
  { pattern: /\bexpense\b/, families: ["expense", "cogs"], label: "expense" },
  { pattern: /\bprovision\b/, families: ["liability"], label: "provision" },
];

export function accountTypeFamily(type: string): string {
  const head = type.split("_")[0]!;
  return head === "" ? type : head;
}

/** Pure keyword check over one account; unit-tested below. */
export function nameTypeMismatch(args: { name: string; type: string }): string | null {
  const name = args.name.toLowerCase();
  const family = accountTypeFamily(args.type.toLowerCase());
  for (const expectation of NAME_TYPE_EXPECTATIONS) {
    if (expectation.pattern.test(name) && !expectation.families.includes(family)) {
      return expectation.label;
    }
  }
  return null;
}

/** Pure party-name canonicalization for duplicate detection. */
export function normalizePartyName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export type ControlMismatchRow = {
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  accountType: string;
  reason: "open_item_misuse" | "name_type";
  detail: string;
  sampleDocId: string | null;
};

export type DuplicatePartyRow = {
  key: string;
  matchOn: "name" | "tax_id";
  partyIds: string[];
  displayNames: string[];
  taxIds: string[];
};

export type UntaxedItemRow = {
  itemId: string;
  code: string | null;
  name: string;
  kind: string;
};

export type UnbudgetedProjectRow = {
  projectId: string;
  code: string | null;
  name: string;
};

export type EmptyScenarioRow = {
  scenarioId: string;
  name: string;
  fiscalYear: number;
  status: string;
};

export type UnmappedComponentRow = {
  componentId: string;
  code: string;
  name: string;
  kind: string;
  missing: string[];
};

export type HygieneLoaders = {
  controlMismatches: (orgId: string) => Promise<ControlMismatchRow[]>;
  duplicateParties: (orgId: string) => Promise<DuplicatePartyRow[]>;
  untaxedItems: (orgId: string) => Promise<UntaxedItemRow[]>;
  unbudgetedProjects: (orgId: string) => Promise<UnbudgetedProjectRow[]>;
  emptyScenarios: (orgId: string) => Promise<EmptyScenarioRow[]>;
  unmappedComponents: (orgId: string) => Promise<UnmappedComponentRow[]>;
};

async function loadControlMismatches(orgId: string): Promise<ControlMismatchRow[]> {
  const [accounts, misuse] = await Promise.all([
    db.execute<{ account_id: string; number: string | null; name: string; type: string }>(sql`
      select id as account_id, number, name, type
        from accounts
       where org_id = ${orgId} and is_active and not is_summary
    `),
    db.execute<{ account_id: string; sample_doc_id: string | null }>(sql`
      select jl.account_id, max(d.id::text) as sample_doc_id
        from journal_lines jl
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
        left join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        left join documents d on d.posted_entry_id = je.id and d.org_id = je.org_id
       where jl.org_id = ${orgId} and jl.is_open_item
         and a.type not in ('asset_receivable', 'liability_payable')
       group by jl.account_id
    `),
  ]);
  const misuseByAccount = new Map(misuse.rows.map((row) => [row.account_id, row.sample_doc_id]));
  const out: ControlMismatchRow[] = [];
  for (const account of accounts.rows) {
    const sampleDocId = misuseByAccount.get(account.account_id) ?? null;
    if (sampleDocId !== undefined && misuseByAccount.has(account.account_id)) {
      out.push({
        accountId: account.account_id,
        accountNumber: account.number,
        accountName: account.name,
        accountType: account.type,
        reason: "open_item_misuse",
        detail: `open-item postings sit on a ${account.type} account; only asset_receivable / liability_payable controls may carry open items`,
        sampleDocId,
      });
      continue;
    }
    const label = nameTypeMismatch({ name: account.name, type: account.type });
    if (label !== null) {
      out.push({
        accountId: account.account_id,
        accountNumber: account.number,
        accountName: account.name,
        accountType: account.type,
        reason: "name_type",
        detail: `named like ${label} but typed ${account.type}`,
        sampleDocId: null,
      });
    }
  }
  return out;
}

async function loadDuplicateParties(orgId: string): Promise<DuplicatePartyRow[]> {
  const [byName, byTax] = await Promise.all([
    db.execute<{ key: string; party_ids: string[]; display_names: string[]; tax_ids: string[] }>(sql`
      select lower(regexp_replace(trim(display_name), '\\s+', ' ', 'g')) as key,
             array_agg(id) as party_ids,
             array_agg(display_name) as display_names,
             array_agg(coalesce(tax_ids::text, '{}')) as tax_ids
        from parties
       where org_id = ${orgId} and is_active
       group by 1
      having count(*) > 1
       order by 1
       limit 50
    `),
    db.execute<{ key: string; party_ids: string[]; display_names: string[] }>(sql`
      select tax_ids::text as key,
             array_agg(id) as party_ids,
             array_agg(display_name) as display_names
        from parties
       where org_id = ${orgId} and is_active
         and tax_ids is not null and tax_ids::text <> '{}'
       group by tax_ids::text
      having count(*) > 1
       order by 1
       limit 50
    `),
  ]);
  return [
    ...byName.rows.map((row) => ({
      key: row.key,
      matchOn: "name" as const,
      partyIds: row.party_ids,
      displayNames: row.display_names,
      taxIds: row.tax_ids,
    })),
    ...byTax.rows.map((row) => ({
      key: `tax:${row.key}`,
      matchOn: "tax_id" as const,
      partyIds: row.party_ids,
      displayNames: row.display_names,
      taxIds: [row.key],
    })),
  ];
}

async function loadUntaxedItems(orgId: string): Promise<UntaxedItemRow[]> {
  const rows = (await db.execute<{ item_id: string; code: string | null; name: string; kind: string }>(sql`
    select id as item_id, code, name, kind
      from items
     where org_id = ${orgId} and is_active and tax_code_id is null
     order by code nulls last, name
     limit 50
  `));
  return rows.rows.map((row) => ({ itemId: row.item_id, code: row.code, name: row.name, kind: row.kind }));
}

async function loadUnbudgetedProjects(orgId: string): Promise<UnbudgetedProjectRow[]> {
  const rows = (await db.execute<{ project_id: string; code: string | null; name: string }>(sql`
    select p.id as project_id, p.code, p.name
      from projects p
     where p.org_id = ${orgId} and p.is_active
       and not exists (select 1 from budget_lines bl where bl.org_id = ${orgId} and bl.project_id = p.id)
     order by p.code nulls last, p.name
     limit 50
  `));
  return rows.rows.map((row) => ({ projectId: row.project_id, code: row.code, name: row.name }));
}

async function loadEmptyScenarios(orgId: string): Promise<EmptyScenarioRow[]> {
  const rows = (await db.execute<{ scenario_id: string; name: string; fiscal_year: number; status: string }>(sql`
    select bs.id as scenario_id, bs.name, bs.fiscal_year, bs.status::text as status
      from budget_scenarios bs
     where bs.org_id = ${orgId} and bs.status in ('approved', 'pending_approval')
       and not exists (select 1 from budget_lines bl where bl.org_id = ${orgId} and bl.scenario_id = bs.id)
     order by bs.fiscal_year desc, bs.name
     limit 50
  `));
  return rows.rows.map((row) => ({
    scenarioId: row.scenario_id,
    name: row.name,
    fiscalYear: Number(row.fiscal_year),
    status: row.status,
  }));
}

async function loadUnmappedComponents(orgId: string): Promise<UnmappedComponentRow[]> {
  const rows = (await db.execute<{
    component_id: string;
    code: string;
    name: string;
    kind: string;
    missing: string[];
  }>(sql`
    select id as component_id, code, name, kind::text as kind,
           array_remove(array[
             case when kind = 'earning' and expense_account_id is null then 'expenseAccountId' end,
             case when kind in ('deduction', 'employer_contribution') and liability_account_id is null then 'liabilityAccountId' end,
             case when kind in ('deduction', 'employer_contribution') and remittance_party_id is null then 'remittancePartyId' end
           ], null) as missing
      from pay_components
     where org_id = ${orgId} and is_active and kind in ('earning', 'deduction', 'employer_contribution')
  `));
  return rows.rows
    .filter((row) => row.missing.length > 0)
    .map((row) => ({
      componentId: row.component_id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      missing: row.missing,
    }));
}

export const productionHygieneLoaders: HygieneLoaders = {
  controlMismatches: loadControlMismatches,
  duplicateParties: loadDuplicateParties,
  untaxedItems: loadUntaxedItems,
  unbudgetedProjects: loadUnbudgetedProjects,
  emptyScenarios: loadEmptyScenarios,
  unmappedComponents: loadUnmappedComponents,
};

const ZERO = "0.0000";

export async function hygieneFindings(
  orgId: string,
  _agentThreshold: string,
  detectors: ContinuousCloseDetectorPolicy[],
  loaders: HygieneLoaders = productionHygieneLoaders,
): Promise<AgentFinding[]> {
  if (!detectors.some((detector) => detector.enabled && (HYGIENE_DETECTOR_KEYS as readonly string[]).includes(detector.detectorKey))) {
    return [];
  }
  const findings: AgentFinding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));

  if (byKey.get("control_account_type_mismatch")?.enabled) {
    for (const row of await loaders.controlMismatches(orgId)) {
      findings.push({
        agentKey: "hygiene",
        findingType: "control_account_type_mismatch",
        fingerprint: `hygiene-control:${row.accountId}`,
        severity: "warning",
        confidence: "1.0000",
        materiality: ZERO,
        subjectType: "account",
        subjectId: row.accountId,
        summary: {
          accountNumber: row.accountNumber,
          accountName: row.accountName,
          accountType: row.accountType,
          reason: row.reason,
          detail: row.detail,
          review: "Rename the account or retype it in the chart of accounts, then re-run.",
          href: "/accounts",
        },
        evidence: [
          {
            kind: "account_mismatch",
            sourceType: "account",
            sourceId: row.accountId,
            data: {
              accountNumber: row.accountNumber,
              accountName: row.accountName,
              accountType: row.accountType,
              reason: row.reason,
              sampleDocumentId: row.sampleDocId,
            },
          },
        ],
      });
    }
  }

  if (byKey.get("duplicate_party_identity")?.enabled) {
    for (const row of await loaders.duplicateParties(orgId)) {
      findings.push({
        agentKey: "hygiene",
        findingType: "duplicate_party_identity",
        fingerprint: `hygiene-party:${row.matchOn}:${row.key}`.slice(0, 200),
        severity: "warning",
        confidence: row.matchOn === "tax_id" ? "0.9500" : "0.8000",
        materiality: ZERO,
        subjectType: "party",
        subjectId: row.partyIds[0] ?? null,
        summary: {
          matchOn: row.matchOn,
          partyCount: row.partyIds.length,
          displayNames: row.displayNames.slice(0, 5),
          review: "Merge the duplicates or deactivate the superseded records in Entities.",
          href: "/entities",
        },
        evidence: row.partyIds.slice(0, 10).map((partyId, index) => ({
          kind: "duplicate_party",
          sourceType: "party",
          sourceId: partyId,
          data: {
            displayName: row.displayNames[index] ?? null,
            taxIds: row.taxIds[index] ?? null,
          },
        })),
      });
    }
  }

  if (byKey.get("item_missing_tax_code")?.enabled) {
    for (const row of await loaders.untaxedItems(orgId)) {
      findings.push({
        agentKey: "hygiene",
        findingType: "item_missing_tax_code",
        fingerprint: `hygiene-item:${row.itemId}`,
        severity: "warning",
        confidence: "1.0000",
        materiality: ZERO,
        subjectType: "item",
        subjectId: row.itemId,
        summary: {
          code: row.code,
          name: row.name,
          kind: row.kind,
          review: "Assign the statutory tax code on the item record before it prices another document.",
          href: "/items",
        },
        evidence: [
          {
            kind: "untaxed_item",
            sourceType: "item",
            sourceId: row.itemId,
            data: { code: row.code, name: row.name, kind: row.kind },
          },
        ],
      });
    }
  }

  if (byKey.get("project_missing_cost_budget")?.enabled) {
    for (const row of await loaders.unbudgetedProjects(orgId)) {
      findings.push({
        agentKey: "hygiene",
        findingType: "project_missing_cost_budget",
        fingerprint: `hygiene-project:${row.projectId}`,
        severity: "warning",
        confidence: "1.0000",
        materiality: ZERO,
        subjectType: "project",
        subjectId: row.projectId,
        summary: {
          code: row.code,
          name: row.name,
          review: "Create the cost budget so margin watch has a baseline to measure against.",
          href: "/projects",
        },
        evidence: [
          {
            kind: "unbudgeted_project",
            sourceType: "project",
            sourceId: row.projectId,
            data: { code: row.code, name: row.name },
          },
        ],
      });
    }
  }

  if (byKey.get("budget_scenario_without_lines")?.enabled) {
    for (const row of await loaders.emptyScenarios(orgId)) {
      findings.push({
        agentKey: "hygiene",
        findingType: "budget_scenario_without_lines",
        fingerprint: `hygiene-scenario:${row.scenarioId}`,
        severity: "warning",
        confidence: "1.0000",
        materiality: ZERO,
        subjectType: "budget_scenario",
        subjectId: row.scenarioId,
        summary: {
          name: row.name,
          fiscalYear: row.fiscalYear,
          status: row.status,
          review: "Fill the scenario with budget lines or archive it so variance checks measure something real.",
          href: "/budgets",
        },
        evidence: [
          {
            kind: "empty_scenario",
            sourceType: "budget_scenario",
            sourceId: row.scenarioId,
            data: { name: row.name, fiscalYear: row.fiscalYear, status: row.status },
          },
        ],
      });
    }
  }

  if (byKey.get("unmapped_payroll_component")?.enabled) {
    for (const row of await loaders.unmappedComponents(orgId)) {
      findings.push({
        agentKey: "hygiene",
        findingType: "unmapped_payroll_component",
        fingerprint: `hygiene-pay-component:${row.componentId}`,
        severity: "warning",
        confidence: "1.0000",
        materiality: ZERO,
        subjectType: "pay_component",
        subjectId: row.componentId,
        summary: {
          code: row.code,
          name: row.name,
          kind: row.kind,
          missing: row.missing,
          review: "Map the missing posting accounts on the pay component (Setup → Payroll workspace, pay-components) before the next pay run.",
          href: "/admin/setup/payroll",
        },
        evidence: [
          {
            kind: "unmapped_component",
            sourceType: "pay_component",
            sourceId: row.componentId,
            data: { code: row.code, name: row.name, kind: row.kind, missing: row.missing },
          },
        ],
      });
    }
  }

  return findings;
}
