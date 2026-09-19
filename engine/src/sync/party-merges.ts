import { sql } from "drizzle-orm";
import { db, withTransactionSavepoint, type SqlExecutor } from "../db.ts";

/**
 * Source-asserted party merges in the mirror.
 *
 * When an adapter exposes a merge/successor signal (see `mergedIntoRef` on
 * `SourceEntity`), the mirror re-points the absorbed party's documents, open
 * items, applications, and references to the survivor inside ONE transaction,
 * keeps history and audit, and records the merge on the survivor. The
 * absorbed row is deactivated with a `merged_into` pointer in `custom`, never
 * deleted; the survivor gains a `merged_from` entry. No migration: both
 * markers live in the existing `custom` JSONB (the project-merge precedent).
 *
 * A source party that disappears with NO signal while still referenced is NOT
 * handled here — the loader holds it for controller review as a named row
 * failure (never silently duplicated, never deleted).
 *
 * Collision rule: most party columns carry no uniqueness beyond their own
 * row, so they move wholesale. Role/profile rows keyed bare-unique on the
 * party move only when the survivor lacks one; composite-unique tables move
 * row-by-row past conflicts. Retained rows stay on the absorbed party,
 * counted in the audit — history is kept, never dropped.
 */

export class PartyMergeError extends Error {
  readonly name = "PartyMergeError";
}

export interface PartyMergeMove {
  table: string;
  rows: number;
}

/**
 * Merge/hold outcomes one parties-stream reconciliation produced, collected
 * for the run summary. Holds are also named row failures in the stream stats.
 */
export interface PartyMirrorOutcome {
  merges: { absorbedRef: string; survivorRef: string }[];
  holds: string[];
}

export interface PartyMergeResult {
  survivorId: string;
  duplicateId: string;
  absorbedRef: string;
  survivorRef: string;
  moved: PartyMergeMove[];
  retained: PartyMergeMove[];
  alreadyMerged: boolean;
  auditId: string | null;
}

/**
 * Every typed party column that follows a source-asserted merge with a plain
 * wholesale move (no uniqueness on the party column beyond the row itself).
 * Catalog-verified: party-merge-catalog.test asserts this list plus
 * ROLE_PARTY_REFS and GUARDED_PARTY_REFS cover every FK to parties(id).
 */
const SIMPLE_PARTY_REFS: readonly (readonly [table: string, column: string])[] = [
  ["addresses", "party_id"],
  ["ap_capture_items", "vendor_candidate_id"],
  ["compliance_records", "party_id"],
  ["compliance_release_checks", "party_id"],
  ["compliance_waivers", "party_id"],
  ["contacts", "party_id"],
  ["crm_opportunities", "party_id"],
  ["customer_roles", "sales_rep_id"],
  ["document_lines", "employee_id"],
  ["document_lines", "party_id"],
  ["documents", "party_id"],
  ["employee_pay_components", "employee_party_id"],
  ["employee_roles", "supervisor_id"],
  ["field_ticket_labor_lines", "employee_party_id"],
  ["field_ticket_policies", "customer_party_id"],
  ["field_tickets", "foreman_party_id"],
  ["fixed_assets", "custodian_party_id"],
  ["item_rate_book_assignments", "customer_id"],
  ["lien_waivers", "party_id"],
  ["party_bank_accounts", "party_id"],
  ["pay_components", "remittance_party_id"],
  ["payment_cards", "holder_party_id"],
  ["payment_instructions", "payee_party_id"],
  ["payment_links", "party_id"],
  ["payment_mandates", "party_id"],
  ["projects", "customer_id"],
  ["projects", "foreman_id"],
  ["projects", "manager_id"],
  ["property_leases", "tenant_id"],
  ["revenue_contracts", "customer_id"],
  ["subcontract_payment_controls", "joint_payee_party_id"],
  ["subcontracts", "vendor_id"],
  ["time_entries", "employee_party_id"],
  ["union_agreements", "remittance_party_id"],
  ["wip_prebill_lines", "employee_party_id"],
];

/**
 * Role/profile rows keyed bare-unique on the party column: the row moves
 * only when the survivor has none; otherwise the absorbed row is retained
 * (deactivated) as history.
 */
const ROLE_PARTY_REFS: readonly (readonly [table: string, column: string])[] = [
  ["crm_account_profiles", "party_id"],
  ["customer_roles", "party_id"],
  ["employee_roles", "party_id"],
  ["vendor_roles", "party_id"],
];

interface GuardedPartyRef {
  table: string;
  column: string;
  /**
   * Conflict predicate between the candidate survivor row (`s`) and the
   * absorbed row being moved (`d`): true where moving `d` would violate the
   * table's uniqueness. Rows with a conflict stay on the absorbed party.
   */
  conflict: string;
}

/**
 * Tables whose uniqueness spans the party column plus other key columns.
 * Each guard mirrors the constrained key exactly (nullable parts compare
 * with IS NOT DISTINCT FROM); partial-index predicates are restated so only
 * rows the index actually constrains can conflict.
 */
const GUARDED_PARTY_REFS: readonly GuardedPartyRef[] = [
  {
    table: "employee_payroll_profiles",
    column: "employee_party_id",
    conflict: "s.org_id = d.org_id",
  },
  {
    table: "employee_tax_certificates",
    column: "employee_party_id",
    conflict:
      "s.org_id = d.org_id and s.certificate_key = d.certificate_key" +
      " and s.region is not distinct from d.region and s.sub_region is not distinct from d.sub_region" +
      " and s.superseded_on is null and d.superseded_on is null",
  },
  {
    table: "entitlement_ledger",
    column: "employee_party_id",
    conflict:
      "((d.kind = 'opening' and s.kind = 'opening' and s.org_id = d.org_id and s.plan_id = d.plan_id)" +
      " or (d.pay_run_document_id is not null and s.pay_run_document_id is not distinct from d.pay_run_document_id" +
      " and s.plan_id = d.plan_id and s.kind = d.kind))",
  },
  {
    table: "entitlement_plan_limits",
    column: "employee_party_id",
    conflict:
      "s.plan_id = d.plan_id and coalesce(lower(s.job_title), '') = coalesce(lower(d.job_title), '')" +
      " and s.trade_id is not distinct from d.trade_id and s.department_id is not distinct from d.department_id" +
      " and s.subsidiary_id is not distinct from d.subsidiary_id and s.effective_from = d.effective_from",
  },
  {
    table: "information_return_recipients",
    column: "party_id",
    conflict: "s.filing_id = d.filing_id",
  },
  {
    table: "labor_cost_rates",
    column: "employee_party_id",
    conflict:
      "s.org_id = d.org_id and coalesce(lower(s.job_title), '') = coalesce(lower(d.job_title), '')" +
      " and s.trade_id is not distinct from d.trade_id and s.department_id is not distinct from d.department_id" +
      " and s.subsidiary_id is not distinct from d.subsidiary_id and s.effective_from = d.effective_from",
  },
  {
    table: "party_subsidiaries",
    column: "party_id",
    conflict: "s.subsidiary_id = d.subsidiary_id",
  },
  {
    table: "pay_run_adjustments",
    column: "employee_party_id",
    conflict:
      "s.pay_run_document_id = d.pay_run_document_id and s.adjustment_type = 'exclude' and d.adjustment_type = 'exclude'",
  },
  {
    table: "pay_run_holiday_assertions",
    column: "employee_party_id",
    // One assertion per (run, employee, holiday occurrence) — the table's own
    // unique key minus the party being merged. Two rows collide only when both
    // parties answered the SAME occurrence on the SAME run.
    conflict:
      "s.pay_run_document_id = d.pay_run_document_id and s.holiday_key = d.holiday_key" +
      " and s.holiday_date = d.holiday_date",
  },
  {
    table: "pay_stubs",
    column: "employee_party_id",
    conflict: "s.pay_run_document_id = d.pay_run_document_id",
  },
  {
    table: "payroll_opening_balances",
    column: "employee_party_id",
    conflict: "s.org_id = d.org_id and s.tax_year = d.tax_year",
  },
  {
    table: "payroll_parallel_findings",
    column: "employee_party_id",
    conflict:
      "s.comparison_id = d.comparison_id and s.kind = d.kind and s.slot is not distinct from d.slot",
  },
  {
    table: "payroll_prior_stubs",
    column: "employee_party_id",
    conflict: "s.register_id = d.register_id",
  },
  {
    table: "payroll_retro_settlements",
    column: "employee_party_id",
    conflict:
      "s.retro_pay_run_document_id = d.retro_pay_run_document_id" +
      " and s.source_pay_run_document_id = d.source_pay_run_document_id",
  },
  {
    table: "work_schedules",
    column: "employee_party_id",
    conflict:
      "s.org_id = d.org_id and coalesce(lower(s.job_title), '') = coalesce(lower(d.job_title), '')" +
      " and s.trade_id is not distinct from d.trade_id and s.department_id is not distinct from d.department_id" +
      " and s.subsidiary_id is not distinct from d.subsidiary_id and s.effective_from = d.effective_from",
  },
];

type PartyRow = {
  id: string;
  display_name: string;
  is_active: boolean;
  custom: Record<string, unknown>;
};

async function loadParty(
  runner: SqlExecutor,
  orgId: string,
  id: string,
): Promise<PartyRow | null> {
  const found = (await runner.execute<PartyRow>(sql`
    select id, display_name, is_active, custom from parties
     where id = ${id} and org_id = ${orgId} limit 1`));
  return found.rows[0] ?? null;
}

/** Survivor party id recorded by a previous merge, if this row was merged away. */
export function storedMergeSurvivor(custom: Record<string, unknown> | null): string | null {
  if (!custom || typeof custom !== "object") return null;
  const marker = (custom as Record<string, unknown>)["merged_into"];
  if (typeof marker === "object" && marker !== null) {
    const survivor = (marker as Record<string, unknown>)["survivor"];
    if (typeof survivor === "string" && survivor) return survivor;
  }
  return null;
}

/** `reference`-type custom values pointing at parties (tenant config, dynamic). */
async function customPartyRefs(
  runner: SqlExecutor,
  orgId: string,
): Promise<{ targetTable: string; key: string }[]> {
  const defs = (await runner.execute<{ target_table: string; key: string }>(sql`
    select target_table, key from custom_field_defs
     where org_id = ${orgId} and field_type = 'reference'
       and config ->> 'referenceTable' = 'parties' and is_active`)).rows;
  const valid: { targetTable: string; key: string }[] = [];
  for (const def of defs) {
    if (!/^[a-z_]+$/.test(def.target_table) || !/^[a-z_][a-z0-9_]*$/.test(def.key)) continue;
    const exists = (await runner.execute<{ n: string }>(sql`
      select count(*)::text as n from information_schema.columns
       where table_schema = 'public' and table_name = ${def.target_table}
         and column_name = 'custom'`)).rows[0]?.n;
    const orgScoped = (await runner.execute<{ n: string }>(sql`
      select count(*)::text as n from information_schema.columns
       where table_schema = 'public' and table_name = ${def.target_table}
         and column_name = 'org_id'`)).rows[0]?.n;
    if (exists === "1" && orgScoped === "1") valid.push({ targetTable: def.target_table, key: def.key });
  }
  return valid;
}

async function moveSimple(
  tx: SqlExecutor,
  orgId: string,
  table: string,
  column: string,
  absorbedId: string,
  survivorId: string,
  moved: Record<string, number>,
): Promise<void> {
  const updated = (await tx.execute(sql`
    update ${sql.identifier(table)} set ${sql.identifier(column)} = ${survivorId}
     where org_id = ${orgId} and ${sql.identifier(column)} = ${absorbedId}
    returning 1`)).rows;
  if (updated.length > 0) moved[`${table}.${column}`] = updated.length;
}

async function moveRoleIfAbsent(
  tx: SqlExecutor,
  orgId: string,
  table: string,
  column: string,
  absorbedId: string,
  survivorId: string,
  moved: Record<string, number>,
  retained: Record<string, number>,
): Promise<void> {
  const survivorHas = (await tx.execute<{ n: string }>(sql`
    select count(*)::text as n from ${sql.identifier(table)}
     where org_id = ${orgId} and ${sql.identifier(column)} = ${survivorId}`)).rows[0]?.n;
  if (survivorHas !== "0") {
    const left = (await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from ${sql.identifier(table)}
       where org_id = ${orgId} and ${sql.identifier(column)} = ${absorbedId}`)).rows[0]?.n;
    if (left !== "0" && left != null) {
      await tx.execute(sql`
        update ${sql.identifier(table)} set is_active = false
         where org_id = ${orgId} and ${sql.identifier(column)} = ${absorbedId}`);
      retained[`${table}.${column}`] = Number(left);
    }
    return;
  }
  await moveSimple(tx, orgId, table, column, absorbedId, survivorId, moved);
}

/**
 * Journal-line attribution follows the merge except where a
 * controller-owned close blocks GL writes: the journal guard admits posted
 * attribution moves through the amend path, but a closed period still
 * refuses. Blocked lines stay on the absorbed party (retained with cause),
 * never forced — the same fail-closed rule as source-deletion mirroring.
 * Draft-entry lines always move.
 */
async function moveJournalLines(
  tx: SqlExecutor,
  orgId: string,
  absorbedId: string,
  survivorId: string,
  moved: Record<string, number>,
  retained: Record<string, number>,
): Promise<void> {
  const combos = (await tx.execute<{ period_id: string; book_id: string; subsidiary_id: string }>(sql`
    select distinct e.period_id, e.book_id, jl.subsidiary_id
      from journal_lines jl
      join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id
     where jl.org_id = ${orgId} and jl.party_id = ${absorbedId}
       and e.status in ('posted', 'reversed')`)).rows;
  const blocked: { period_id: string; book_id: string; subsidiary_id: string }[] = [];
  for (const combo of combos) {
    const check = (await tx.execute<{ blocked: boolean }>(sql`
      select period_module_blocks_write(
        ${orgId}, ${combo.period_id}, ${combo.book_id}, ${combo.subsidiary_id}, 'gl', true
      ) as blocked`)).rows[0];
    if (check?.blocked) blocked.push(combo);
  }
  const tuples = blocked.map(
    (combo) => sql`(${combo.period_id}, ${combo.book_id}, ${combo.subsidiary_id})`,
  );
  const updated = (await tx.execute(
    blocked.length === 0
      ? sql`
        update journal_lines set party_id = ${survivorId}
         where org_id = ${orgId} and party_id = ${absorbedId}
        returning 1`
      : sql`
        update journal_lines jl set party_id = ${survivorId}
          from journal_entries e
         where jl.org_id = ${orgId} and jl.party_id = ${absorbedId}
           and e.id = jl.entry_id and e.org_id = jl.org_id
           and (e.status = 'draft'
             or (e.period_id, e.book_id, jl.subsidiary_id) not in (${sql.join(tuples, sql`, `)}))
        returning 1`,
  )).rows;
  if (updated.length > 0) moved["journal_lines.party_id"] = updated.length;
  const left = (await tx.execute<{ n: string }>(sql`
    select count(*)::text as n from journal_lines
     where org_id = ${orgId} and party_id = ${absorbedId}`)).rows[0]?.n;
  if (left !== "0" && left != null) retained["journal_lines.party_id"] = Number(left);
}

async function moveGuarded(
  tx: SqlExecutor,
  orgId: string,
  ref: GuardedPartyRef,
  absorbedId: string,
  survivorId: string,
  moved: Record<string, number>,
  retained: Record<string, number>,
): Promise<void> {
  const updated = (await tx.execute(sql`
    update ${sql.identifier(ref.table)} as d set ${sql.identifier(ref.column)} = ${survivorId}
     where d.org_id = ${orgId} and d.${sql.identifier(ref.column)} = ${absorbedId}
       and not exists (
         select 1 from ${sql.identifier(ref.table)} as s
          where s.org_id = d.org_id and s.${sql.identifier(ref.column)} = ${survivorId}
            and ${sql.raw(ref.conflict)}
       )
    returning 1`)).rows;
  if (updated.length > 0) moved[`${ref.table}.${ref.column}`] = updated.length;
  const left = (await tx.execute<{ n: string }>(sql`
    select count(*)::text as n from ${sql.identifier(ref.table)}
     where org_id = ${orgId} and ${sql.identifier(ref.column)} = ${absorbedId}`)).rows[0]?.n;
  if (left !== "0" && left != null) retained[`${ref.table}.${ref.column}`] = Number(left);
}

export interface SourcePartyMergeInput {
  orgId: string;
  sourceName: string;
  absorbedRef: string;
  survivorRef: string;
  absorbedId: string;
  survivorId: string;
  actorId: string | null;
  runId: string | null;
}

/**
 * Merge one absorbed party into its survivor in a single transaction. Every
 * typed reference moves (or is retained-with-cause on uniqueness conflicts);
 * the absorbed row is deactivated with a `merged_into` pointer; the survivor
 * records the merge in `merged_from`; one audit row carries the per-table
 * counts. Re-running an already-merged pair is a no-op.
 */
export async function applySourcePartyMerge(
  input: SourcePartyMergeInput,
): Promise<PartyMergeResult> {
  const { absorbedId, survivorId } = input;
  if (absorbedId === survivorId) {
    throw new PartyMergeError("a party cannot merge into itself");
  }
  return db.transaction(async (tx) =>
    withTransactionSavepoint(tx, async () => {
      // Re-pointing posted history runs through the governed amend path, the
      // same paired transaction-local authority historical replay uses:
      // document_line_immutability admits non-draft line writes, the posted
      // document guard admits financial-identity (party) changes, and the
      // journal guard admits posted-line attribution moves (controller-closed
      // periods still block — those rows are retained, never forced). Either
      // setting alone is deliberately not a bypass. Previous values are
      // restored before returning so an ambient transaction never inherits
      // trusted-replay authority from a merge.
      const prior = (await tx.execute<{ name: string; value: string }>(sql`
        select 'openbooks.amend' as name, coalesce(current_setting('openbooks.amend', true), 'off') as value
         union all
        select 'openbooks.migration', coalesce(current_setting('openbooks.migration', true), 'off')`)).rows;
      const restore = new Map(prior.map((r) => [r.name, r.value]));
      await tx.execute(sql`set local openbooks.amend = on`);
      await tx.execute(sql`set local openbooks.migration = on`);
      // Restore on success only: after a failed statement the transaction is
      // aborted and only rollback is legal — restoring there would mask the
      // real error. The savepoint still discards the merge's row writes; the
      // settings themselves last only until the transaction ends.
      const result = await applyMergeTx(tx, input);
      await tx.execute(
        sql`select set_config('openbooks.amend', ${restore.get("openbooks.amend") ?? "off"}, true)`,
      );
      await tx.execute(
        sql`select set_config('openbooks.migration', ${restore.get("openbooks.migration") ?? "off"}, true)`,
      );
      return result;
    }),
  );
}

async function applyMergeTx(
  tx: SqlExecutor,
  input: SourcePartyMergeInput,
): Promise<PartyMergeResult> {
  const { orgId, absorbedId, survivorId } = input;
  const [absorbed, survivor] = await Promise.all([
    loadParty(tx, orgId, absorbedId),
    loadParty(tx, orgId, survivorId),
  ]);
  if (!absorbed || !survivor) {
    throw new PartyMergeError("both parties must exist in this organization");
  }
  {
    const prior = storedMergeSurvivor(absorbed.custom);
    if (prior) {
      if (prior === survivorId) {
        return {
          survivorId,
          duplicateId: absorbedId,
          absorbedRef: input.absorbedRef,
          survivorRef: input.survivorRef,
          moved: [],
          retained: [],
          alreadyMerged: true,
          auditId: null,
        };
      }
      throw new PartyMergeError("this party already merged into another party");
    }
    if (storedMergeSurvivor(survivor.custom)) {
      throw new PartyMergeError("a merged-away party cannot survive another merge");
    }
  }

  {
    const moved: Record<string, number> = {};
    const retained: Record<string, number> = {};
    for (const [table, column] of SIMPLE_PARTY_REFS) {
      await moveSimple(tx, orgId, table, column, absorbedId, survivorId, moved);
    }
    for (const [table, column] of ROLE_PARTY_REFS) {
      await moveRoleIfAbsent(tx, orgId, table, column, absorbedId, survivorId, moved, retained);
    }
    for (const ref of GUARDED_PARTY_REFS) {
      await moveGuarded(tx, orgId, ref, absorbedId, survivorId, moved, retained);
    }
    await moveJournalLines(tx, orgId, absorbedId, survivorId, moved, retained);
    const customRefs: { table: string; key: string; rows: number }[] = [];
    for (const ref of await customPartyRefs(tx, orgId)) {
      const updated = (await tx.execute(sql`
        update ${sql.identifier(ref.targetTable)}
           set custom = jsonb_set(custom, array[${ref.key}], to_jsonb(${survivorId}::text))
         where org_id = ${orgId} and custom ->> ${ref.key} = ${absorbedId}
        returning 1`)).rows;
      if (updated.length > 0) {
        moved[`custom:${ref.targetTable}.${ref.key}`] = updated.length;
        customRefs.push({ table: ref.targetTable, key: ref.key, rows: updated.length });
      }
    }

    const mergedCustom = {
      ...(absorbed.custom ?? {}),
      merged_into: {
        survivor: survivorId,
        at: new Date().toISOString(),
        by: input.actorId,
        source: { system: input.sourceName, absorbedRef: input.absorbedRef, survivorRef: input.survivorRef },
      },
    };
    await tx.execute(sql`
      update parties
         set is_active = false, custom = ${JSON.stringify(mergedCustom)}::jsonb, updated_at = now()
       where org_id = ${orgId} and id = ${absorbedId}`);

    const priorFrom = Array.isArray((survivor.custom as Record<string, unknown>)?.["merged_from"])
      ? ((survivor.custom as Record<string, unknown>)["merged_from"] as unknown[])
      : [];
    const alreadyRecorded = priorFrom.some(
      (entry) =>
        typeof entry === "object" && entry !== null &&
        (entry as Record<string, unknown>)["absorbedRef"] === input.absorbedRef,
    );
    if (!alreadyRecorded) {
      priorFrom.push({
        absorbedRef: input.absorbedRef,
        absorbedId,
        at: new Date().toISOString(),
        by: input.actorId,
      });
    }
    await tx.execute(sql`
      update parties
         set custom = jsonb_set(coalesce(custom, '{}'::jsonb), '{merged_from}', ${JSON.stringify(priorFrom)}::jsonb),
             updated_at = now()
       where org_id = ${orgId} and id = ${survivorId}`);

    const audit = (await tx.execute<{ id: string }>(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${orgId}, 'parties', ${absorbedId}, 'merge',
              ${JSON.stringify({
                survivor: survivorId,
                source: input.sourceName,
                absorbedRef: input.absorbedRef,
                survivorRef: input.survivorRef,
                moved,
                retained,
                customRefs,
                reason: "source-asserted party merge",
              })}::jsonb, ${input.actorId}, ${input.runId})
      returning id`)).rows[0];
    const toMoves = (record: Record<string, number>): PartyMergeMove[] =>
      Object.entries(record).map(([table, rows]) => ({ table, rows }));
    return {
      survivorId,
      duplicateId: absorbedId,
      absorbedRef: input.absorbedRef,
      survivorRef: input.survivorRef,
      moved: toMoves(moved),
      retained: toMoves(retained),
      alreadyMerged: false,
      auditId: audit?.id ?? null,
    };
  }
}

/**
 * Every typed party column the merge follows, for the catalog test: plain
 * moves plus role moves plus guarded moves plus the period-aware journal move.
 */
export const PARTY_MERGE_REF_COVERAGE: readonly (readonly [table: string, column: string])[] = [
  ...SIMPLE_PARTY_REFS,
  ...ROLE_PARTY_REFS,
  ...GUARDED_PARTY_REFS.map((ref) => [ref.table, ref.column] as const),
  ["journal_lines", "party_id"] as const,
];

/** Count live references to one party, per table — the hold detector's evidence. */
export async function findPartyReferences(
  runner: SqlExecutor,
  orgId: string,
  partyId: string,
): Promise<PartyMergeMove[]> {
  const branches = [
    ...SIMPLE_PARTY_REFS,
    ...ROLE_PARTY_REFS,
    ...GUARDED_PARTY_REFS.map((ref) => [ref.table, ref.column] as const),
    ["journal_lines", "party_id"] as const,
  ].map(
    ([table, column]) => sql`
      select ${table}::text as tbl, count(*)::text as n from ${sql.identifier(table)}
       where org_id = ${orgId} and ${sql.identifier(column)} = ${partyId}`,
  );
  const counts = (await runner.execute<{ tbl: string; n: string }>(
    sql`${sql.join(branches, sql` union all `)}`,
  )).rows;
  const hits: PartyMergeMove[] = [];
  for (const row of counts) {
    if (row.n !== "0") hits.push({ table: row.tbl, rows: Number(row.n) });
  }
  for (const ref of await customPartyRefs(runner, orgId)) {
    const n = (await runner.execute<{ n: string }>(sql`
      select count(*)::text as n from ${sql.identifier(ref.targetTable)}
       where org_id = ${orgId} and custom ->> ${ref.key} = ${partyId}`)).rows[0]?.n;
    if (n !== "0" && n != null) hits.push({ table: `custom:${ref.targetTable}.${ref.key}`, rows: Number(n) });
  }
  return hits.sort((a, b) => b.rows - a.rows || (a.table < b.table ? -1 : 1));
}
