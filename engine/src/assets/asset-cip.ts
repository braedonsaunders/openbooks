import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { add, cmp, neg } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ASSET_TYPES, PNL_COST_TYPES } from "../records/account-types.ts";
import { ASSET_DEPTH_FEATURES, assertAssetAccess } from "./asset-access.ts";
import {
  createDraftAsset,
  lockCategoryForCapitalization,
  placeDraftInService,
} from "./asset-drafts.ts";
import { refuse } from "./asset-refusal.ts";
import {
  CAPITALIZATION_ORIGIN,
  markCapitalizationEntryReversed,
  postCapitalizationEntry,
  postCapitalizationReversal,
} from "./capitalization-journal.ts";
import { buildCapitalizationLines, cipOpenBalance, planCapitalization } from "./cip-math.ts";
import { cipBalance, syncCipCarriedCost, type CipBalance } from "./cip-ledger.ts";

/**
 * Construction in progress (CIP).
 *
 * A CIP record is a register entry in the 'construction' status that never
 * depreciates. It accumulates cost by linking posted GL lines on its CIP
 * account — vendor bills, journals, expense reports, project costs, and
 * proposals accepted into it — one live link per GL line, so the CIP
 * subledger reconciles line by line to the CIP account. A governed
 * capitalization moves part or all of the open balance into new assets or
 * components (placed in service on the capitalization date when asked) and
 * expenses what is not capitalizable, through one reclassification journal
 * crediting the CIP account. A capitalization that emptied the record closes
 * it as 'capitalized'; reversing it reopens the record.
 */

/** Noncurrent asset types a CIP account may have. */
const CIP_ACCOUNT_TYPES = ASSET_TYPES.filter(
  (type) => type === "asset_fixed" || type === "asset_other",
);

type CipRow = {
  id: string;
  asset_number: string;
  name: string;
  status: string;
  subsidiary_id: string;
  asset_account_id: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
};

async function lockCip(
  tx: SqlExecutor,
  orgId: string,
  cipAssetId: string,
  allowed: readonly string[] | null | undefined,
): Promise<CipRow & { asset_account_id: string }> {
  const row = (
    await tx.execute<CipRow>(
      sql`
    select id, asset_number, name, status, subsidiary_id, asset_account_id, department_id, project_id, location_id
      from fixed_assets
     where org_id = ${orgId} and id = ${cipAssetId}
       ${allowed ? sql`and subsidiary_id = any(${uuidArray([...allowed])}::uuid[])` : sql``}
     for update`,
      "objects",
    )
  )[0];
  if (!row) refuse("cip_not_found", "construction-in-progress record not found", { status: 404 });
  if (row.status !== "construction" && row.status !== "capitalized") {
    refuse("not_cip", `asset ${row.asset_number} is not a construction-in-progress record`);
  }
  if (!row.asset_account_id)
    refuse(
      "cip_account_missing",
      `construction in progress ${row.asset_number} has no CIP account`,
    );
  return row as CipRow & { asset_account_id: string };
}

async function assertAccountType(
  tx: SqlExecutor,
  orgId: string,
  accountId: string,
  types: readonly string[],
  code: string,
  message: string,
): Promise<void> {
  const account = (
    await tx.execute<{ type: string; is_active: boolean; is_summary: boolean }>(
      sql`
    select type, is_active, is_summary from accounts where org_id = ${orgId} and id = ${accountId} for share`,
      "objects",
    )
  )[0];
  if (!account || !account.is_active || account.is_summary || !types.includes(account.type))
    refuse(code, message);
}

/** Open a construction-in-progress record on a CIP (noncurrent asset) account. */
export async function createCipRecord(
  orgId: string,
  args: {
    actorId: string;
    subsidiaryId: string;
    categoryId: string;
    name: string;
    description?: string | null;
    cipAccountId: string;
    startedOn?: string | null;
    departmentId?: string | null;
    projectId?: string | null;
    locationId?: string | null;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<{ id: string; assetNumber: string }> {
  if (args.allowedSubsidiaryIds && !args.allowedSubsidiaryIds.includes(args.subsidiaryId)) {
    refuse("subsidiary_scope", "this legal entity is outside your authorization", { status: 404 });
  }
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.capitalize",
      feature: "constructionInProgress",
      subsidiaryIds: [args.subsidiaryId],
    });
    const subsidiary = (
      await tx.execute<{ id: string }>(
        sql`
      select id from subsidiaries where org_id = ${orgId} and id = ${args.subsidiaryId} and is_active and not is_elimination`,
        "objects",
      )
    )[0];
    if (!subsidiary) refuse("subsidiary_invalid", "choose an active legal entity");
    await assertAccountType(
      tx,
      orgId,
      args.cipAccountId,
      CIP_ACCOUNT_TYPES,
      "cip_account_invalid",
      "the construction-in-progress account must be an active, postable fixed or other noncurrent asset account",
    );
    const created = await createDraftAsset(tx, {
      orgId,
      actorId: args.actorId,
      subsidiaryId: args.subsidiaryId,
      categoryId: args.categoryId,
      name: args.name,
      description: args.description ?? null,
      acquisitionCost: "0",
      acquiredOn: args.startedOn ?? null,
      departmentId: args.departmentId ?? null,
      projectId: args.projectId ?? null,
      locationId: args.locationId ?? null,
      provenance: { kind: "construction_in_progress" },
    });
    await tx.execute(sql`select set_config('openbooks.asset_cip_ledger', 'on', true)`);
    const converted = (
      await tx.execute<{ id: string }>(
        sql`
      update fixed_assets set status = 'construction', asset_account_id = ${args.cipAccountId},
             updated_at = clock_timestamp(), updated_by = ${args.actorId}
       where org_id = ${orgId} and id = ${created.id} and status = 'draft'
       returning id`,
        "objects",
      )
    )[0];
    await tx.execute(sql`select set_config('openbooks.asset_cip_ledger', 'off', true)`);
    if (!converted)
      throw new Error(
        `construction in progress ${created.assetNumber} was not opened; no row changed`,
      );
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'fixed_assets', ${created.id}, 'update',
              ${JSON.stringify({ before: { status: "draft" }, after: { status: "construction", asset_account_id: args.cipAccountId } })}::jsonb, ${args.actorId})`);
    return { id: created.id, assetNumber: created.assetNumber };
  });
}

export interface CipCandidateLine {
  journalLineId: string;
  entryId: string;
  entryNumber: string;
  origin: string;
  postingDate: string;
  amount: string;
  memo: string | null;
  projectId: string | null;
  documentNumber: string | null;
}

/** Posted, unlinked GL lines on the record's CIP account and legal entity. */
export async function listCipCandidateLines(
  orgId: string,
  args: {
    cipAssetId: string;
    from?: string | null;
    to?: string | null;
    allowedSubsidiaryIds?: readonly string[] | null;
    limit?: number;
  },
): Promise<CipCandidateLine[]> {
  const cip = (
    await db.execute<CipRow>(
      sql`
    select id, asset_number, name, status, subsidiary_id, asset_account_id, department_id, project_id, location_id
      from fixed_assets where org_id = ${orgId} and id = ${args.cipAssetId}
       ${args.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${uuidArray([...args.allowedSubsidiaryIds])}::uuid[])` : sql``}`,
      "objects",
    )
  )[0];
  if (!cip || !cip.asset_account_id) return [];
  const rows = await db.execute<{
    id: string;
    entry_id: string;
    entry_number: string;
    origin: string;
    posting_date: string;
    amount: string;
    memo: string | null;
    project_id: string | null;
    document_number: string | null;
  }>(
    sql`
    select jl.id, jl.entry_id, je.entry_number, je.origin, je.posting_date::text as posting_date, jl.amount::text as amount,
           jl.memo, jl.project_id, d.document_number
      from journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
      join accounting_books b on b.org_id = je.org_id and b.id = je.book_id and b.is_primary and b.is_active and b.posts_gl
      left join documents d on d.org_id = je.org_id and d.id = je.source_document_id
     where jl.org_id = ${orgId} and jl.account_id = ${cip.asset_account_id} and jl.subsidiary_id = ${cip.subsidiary_id}
       and je.status = 'posted' and je.reverses_entry_id is null and je.origin <> ${CAPITALIZATION_ORIGIN} -- Live entries only: reversed costs cannot become new CIP sources.
       and jl.amount <> 0
       and not exists (select 1 from asset_cip_costs c where c.org_id = jl.org_id and c.source_line_id = jl.id and c.status = 'linked')
       ${args.from ? sql`and je.posting_date >= ${args.from}` : sql``}
       ${args.to ? sql`and je.posting_date <= ${args.to}` : sql``}
     order by je.posting_date, je.entry_number, jl.line_number
     limit ${Math.min(Math.max(args.limit ?? 200, 1), 500)}`,
    "objects",
  );
  return rows.map((row) => ({
    journalLineId: row.id,
    entryId: row.entry_id,
    entryNumber: row.entry_number,
    origin: row.origin,
    postingDate: row.posting_date,
    amount: add(row.amount, "0"),
    memo: row.memo,
    projectId: row.project_id,
    documentNumber: row.document_number,
  }));
}

/** Link posted GL lines on the CIP account to a record; each line feeds one record. */
export async function linkCipCosts(
  orgId: string,
  args: {
    cipAssetId: string;
    journalLineIds: string[];
    actorId: string;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<{ linked: number; balance: CipBalance }> {
  const ids = [...new Set(args.journalLineIds)];
  if (ids.length === 0) refuse("lines_required", "choose at least one GL line to link");
  if (ids.length > 500) refuse("lines_too_many", "link at most 500 lines at a time");
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const cip = await lockCip(tx, orgId, args.cipAssetId, args.allowedSubsidiaryIds);
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.capitalize",
      feature: "constructionInProgress",
      subsidiaryIds: [cip.subsidiary_id],
    });
    if (cip.status !== "construction")
      refuse("cip_closed", `construction in progress ${cip.asset_number} is closed`, {
        remedy: "Reverse its last capitalization to reopen it.",
      });
    const lines = await tx.execute<{
      id: string;
      entry_id: string;
      account_id: string;
      subsidiary_id: string;
      amount: string;
      memo: string | null;
      project_id: string | null;
      status: string;
      reverses_entry_id: string | null;
      origin: string;
      posting_date: string;
      source_document_id: string | null;
      primary_book: boolean;
      linked: boolean;
    }>(
      sql`
      select jl.id, jl.entry_id, jl.account_id, jl.subsidiary_id, jl.amount::text as amount, jl.memo, jl.project_id,
             je.status, je.reverses_entry_id, je.origin, je.posting_date::text as posting_date, je.source_document_id,
             (b.is_primary and b.is_active and b.posts_gl) as primary_book,
             exists (select 1 from asset_cip_costs c where c.org_id = jl.org_id and c.source_line_id = jl.id and c.status = 'linked') as linked
        from journal_lines jl
        join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
        join accounting_books b on b.org_id = je.org_id and b.id = je.book_id
       where jl.org_id = ${orgId} and jl.id = any(${uuidArray(ids)}::uuid[])
       order by jl.id
       for share of je`,
      "objects",
    );
    if (lines.length !== ids.length)
      refuse("source_line_not_found", "a selected GL line was not found", { status: 404 });
    for (const line of lines) {
      if (line.status !== "posted" || line.reverses_entry_id)
        refuse("source_not_posted", "only lines of posted, unreversed journals can be linked");
      if (!line.primary_book)
        refuse("source_not_primary_book", "only primary-book lines can be linked");
      if (line.origin === CAPITALIZATION_ORIGIN)
        refuse(
          "source_is_capitalization",
          "capitalization journals cannot feed construction in progress",
        );
      if (line.account_id !== cip.asset_account_id)
        refuse(
          "source_wrong_account",
          "a selected line is not on this record's construction-in-progress account",
        );
      if (line.subsidiary_id !== cip.subsidiary_id)
        refuse("source_wrong_subsidiary", "a selected line belongs to a different legal entity");
      if (line.linked)
        refuse(
          "source_already_linked",
          "a selected line is already linked to construction in progress",
          { status: 409 },
        );
      if (cmp(line.amount, "0") === 0) refuse("source_zero", "a selected line has no amount");
    }
    for (const line of lines) {
      await tx.execute(sql`
        insert into asset_cip_costs
          (org_id, cip_asset_id, subsidiary_id, source_entry_id, source_line_id, source_document_id, account_id,
           project_id, amount, posting_date, memo, linked_by)
        values
          (${orgId}, ${cip.id}, ${cip.subsidiary_id}, ${line.entry_id}, ${line.id}, ${line.source_document_id},
           ${line.account_id}, ${line.project_id}, ${line.amount}, ${line.posting_date}, ${line.memo}, ${args.actorId})`);
    }
    const balance = await syncCipCarriedCost(tx, {
      orgId,
      cipAssetId: cip.id,
      actorId: args.actorId,
      closeWhenEmpty: false,
    });
    return { linked: lines.length, balance };
  });
}

/** Unlink a cost; refused when the record's capitalizations already consumed it. */
export async function unlinkCipCost(
  orgId: string,
  args: {
    costId: string;
    reason: string;
    actorId: string;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<{ balance: CipBalance }> {
  const reason = args.reason.trim();
  if (!reason) refuse("reason_required", "state why the cost is unlinked");
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const cost = (
      await tx.execute<{ cip_asset_id: string; status: string }>(
        sql`
      select cip_asset_id, status from asset_cip_costs where org_id = ${orgId} and id = ${args.costId}`,
        "objects",
      )
    )[0];
    if (!cost)
      refuse("cip_cost_not_found", "construction-in-progress cost not found", { status: 404 });
    const cip = await lockCip(tx, orgId, cost.cip_asset_id, args.allowedSubsidiaryIds);
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.capitalize",
      feature: "constructionInProgress",
      subsidiaryIds: [cip.subsidiary_id],
    });
    const fromAcceptance = (
      await tx.execute(
        sql`
      select 1 from asset_proposal_allocations al
        join asset_proposal_acceptances ac on ac.org_id = al.org_id and ac.id = al.acceptance_id and ac.status = 'posted'
       where al.org_id = ${orgId} and al.cip_cost_id = ${args.costId} limit 1`,
        "objects",
      )
    )[0];
    if (fromAcceptance) {
      refuse("cip_cost_from_acceptance", "this cost was added by an accepted asset proposal", {
        status: 409,
        remedy: "Reverse the acceptance from Fixed Assets → Proposals instead.",
      });
    }
    const updated = (
      await tx.execute<{ id: string }>(
        sql`
      update asset_cip_costs
         set status = 'unlinked', unlinked_at = clock_timestamp(), unlinked_by = ${args.actorId}, unlink_reason = ${reason}
       where org_id = ${orgId} and id = ${args.costId} and status = 'linked'
       returning id`,
        "objects",
      )
    )[0];
    if (!updated) refuse("cip_cost_not_linked", "the cost is not linked", { status: 409 });
    const balance = await syncCipCarriedCost(tx, {
      orgId,
      cipAssetId: cip.id,
      actorId: args.actorId,
      closeWhenEmpty: false,
    });
    return { balance };
  });
}

export type CapitalizeLineInput =
  | {
      kind: "asset";
      name: string;
      categoryId: string;
      amount: string;
      description?: string | null;
      placeInService?: boolean;
    }
  | {
      kind: "component";
      parentAssetId: string;
      name: string;
      categoryId: string;
      amount: string;
      description?: string | null;
      placeInService?: boolean;
    }
  | { kind: "expense"; expenseAccountId: string; amount: string; memo?: string | null };

export interface CapitalizeCipInput {
  idempotencyKey: string;
  cipAssetId: string;
  capitalizedOn: string;
  reason: string;
  /** Close the record when the capitalization empties it (default true). */
  closeWhenEmpty?: boolean;
  lines: CapitalizeLineInput[];
}

export interface CapitalizeCipResult {
  capitalizationId: string;
  entryId: string;
  assets: { id: string; assetNumber: string; amount: string }[];
  capitalized: string;
  expensed: string;
  remaining: string;
  replayed: boolean;
}

function capitalizationHash(input: CapitalizeCipInput): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        cipAssetId: input.cipAssetId,
        capitalizedOn: input.capitalizedOn,
        reason: input.reason.trim(),
        closeWhenEmpty: input.closeWhenEmpty !== false,
        lines: input.lines.map((line) => ({ ...line, amount: canonicalDecimal(line.amount, 4) })),
      }),
    )
    .digest("hex");
}

/**
 * Capitalize construction in progress into new assets, components and an
 * expensed remainder. Only cost linked from GL lines posted on or before the
 * capitalization date can be capitalized on that date.
 */
export async function capitalizeCip(
  orgId: string,
  input: CapitalizeCipInput,
  options: { actorId: string; allowedSubsidiaryIds?: readonly string[] | null },
): Promise<CapitalizeCipResult> {
  const reason = input.reason.trim();
  if (!reason) refuse("reason_required", "state the basis for this capitalization");
  if (reason.length > 2000) refuse("reason_too_long", "reasons are limited to 2,000 characters");
  if (!isIsoCalendarDate(input.capitalizedOn))
    refuse("date_invalid", "the capitalization date must be a calendar date (YYYY-MM-DD)");
  const hash = capitalizationHash(input);
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"asset-cip-capitalization:" + orgId + ":" + input.idempotencyKey}, 0))`,
    );
    const cip = await lockCip(tx, orgId, input.cipAssetId, options.allowedSubsidiaryIds);
    await assertAssetAccess(tx, {
      orgId,
      actorId: options.actorId,
      permission: "assets.capitalize",
      feature: "constructionInProgress",
      subsidiaryIds: [cip.subsidiary_id],
    });
    const prior = (
      await tx.execute<{
        id: string;
        request_hash: string;
        entry_id: string;
        capitalized_amount: string;
        expensed_amount: string;
        status: string;
      }>(
        sql`
      select id, request_hash, entry_id, capitalized_amount::text as capitalized_amount,
             expensed_amount::text as expensed_amount, status
        from asset_cip_capitalizations where org_id = ${orgId} and idempotency_key = ${input.idempotencyKey}`,
        "objects",
      )
    )[0];
    if (prior) {
      if (prior.request_hash !== hash) {
        refuse(
          "idempotency_conflict",
          "this request key was already used for a different capitalization",
          { status: 409, remedy: "Reopen the record to start a fresh capitalization." },
        );
      }
      if (prior.status === "reversed") {
        refuse("capitalization_reversed", "this capitalization has already been reversed", {
          status: 409,
          remedy: "Use a new request key to capitalize the reopened construction balance.",
        });
      }
      const assets = await tx.execute<{
        asset_id: string | null;
        asset_number: string;
        amount: string;
      }>(
        sql`
        select asset_id, asset_number, amount::text as amount from asset_cip_capitalization_lines
         where org_id = ${orgId} and capitalization_id = ${prior.id} and kind <> 'expense' order by line_number`,
        "objects",
      );
      const balance = await cipBalance(tx, orgId, input.cipAssetId);
      return {
        capitalizationId: prior.id,
        entryId: prior.entry_id,
        assets: assets.map((row) => ({
          id: row.asset_id ?? "",
          assetNumber: row.asset_number,
          amount: add(row.amount, "0"),
        })),
        capitalized: add(prior.capitalized_amount, "0"),
        expensed: add(prior.expensed_amount, "0"),
        remaining: balance.open,
        replayed: true,
      };
    }

    if (cip.status !== "construction")
      refuse("cip_closed", `construction in progress ${cip.asset_number} is closed`);

    // The as-of balance: costs posted by the capitalization date, less every
    // posted capitalization.
    const asOf = cipOpenBalance(
      await tx.execute<{ amount: string; status: "linked" | "unlinked" }>(
        sql`
        select amount::text as amount, status from asset_cip_costs
         where org_id = ${orgId} and cip_asset_id = ${cip.id} and posting_date <= ${input.capitalizedOn}`,
        "objects",
      ),
      (
        await tx.execute<{
          capitalized_amount: string;
          expensed_amount: string;
          status: "posted" | "reversed";
        }>(
          sql`
        select capitalized_amount::text as capitalized_amount, expensed_amount::text as expensed_amount, status
          from asset_cip_capitalizations where org_id = ${orgId} and cip_asset_id = ${cip.id}`,
          "objects",
        )
      ).map((row) => ({
        capitalizedAmount: row.capitalized_amount,
        expensedAmount: row.expensed_amount,
        status: row.status,
      })),
    );
    const amounts = input.lines.map((line, index) => {
      const amount = canonicalDecimal(line.amount, 4);
      if (amount === null)
        refuse("amount_invalid", `line ${index + 1} amount must be an exact decimal`);
      return amount;
    });
    const plan = planCapitalization(
      asOf.open,
      input.lines.map((line, index) => ({ kind: line.kind, amount: amounts[index]! })),
    );

    // Resolve every target account before anything posts.
    const targets: { targetAccountId: string; parentAssetId: string | null }[] = [];
    for (const line of input.lines) {
      if (line.kind === "expense") {
        await assertAccountType(
          tx,
          orgId,
          line.expenseAccountId,
          PNL_COST_TYPES,
          "expense_account_invalid",
          "the write-off account must be an active, postable expense or cost account",
        );
        targets.push({ targetAccountId: line.expenseAccountId, parentAssetId: null });
        continue;
      }
      const category = await lockCategoryForCapitalization(tx, orgId, line.categoryId);
      if (category.assetAccountId === cip.asset_account_id) {
        refuse(
          "capitalization_target_is_cip",
          `category ${category.name} uses the construction-in-progress account as its asset account`,
        );
      }
      let parentAssetId: string | null = null;
      if (line.kind === "component") {
        if (!(await lockAndCheckOrgFeature(tx, orgId, "assetComponents"))) {
          refuse(
            "feature_disabled",
            `${ASSET_DEPTH_FEATURES.assetComponents} is switched off for this organization`,
            {
              status: 409,
              remedy: `Turn on ${ASSET_DEPTH_FEATURES.assetComponents} under Fixed Assets in Company Settings → Features.`,
            },
          );
        }
        const parent = (
          await tx.execute<{
            id: string;
            asset_number: string;
            status: string;
            subsidiary_id: string;
            parent_asset_id: string | null;
          }>(
            sql`
          select id, asset_number, status, subsidiary_id, parent_asset_id from fixed_assets
           where org_id = ${orgId} and id = ${line.parentAssetId} for update`,
            "objects",
          )
        )[0];
        if (!parent) refuse("asset_not_found", "parent asset not found", { status: 404 });
        if (parent.subsidiary_id !== cip.subsidiary_id)
          refuse(
            "component_cross_subsidiary",
            `asset ${parent.asset_number} belongs to a different legal entity`,
          );
        if (parent.parent_asset_id)
          refuse(
            "component_nesting",
            `asset ${parent.asset_number} is itself a component; choose its parent`,
          );
        if (!["draft", "in_service", "fully_depreciated"].includes(parent.status)) {
          refuse(
            "component_parent_status",
            `asset ${parent.asset_number} is ${parent.status} and cannot take components`,
          );
        }
        parentAssetId = parent.id;
      }
      targets.push({ targetAccountId: category.assetAccountId, parentAssetId });
    }

    const capitalizationId = randomUUID();
    const memo = `Capitalize ${cip.asset_number} — ${reason}`.slice(0, 500);
    const lines = buildCapitalizationLines(
      cip.asset_account_id,
      input.lines.map((line, index) => ({
        targetAccountId: targets[index]!.targetAccountId,
        amount: amounts[index]!,
        memo: (line.kind === "expense"
          ? line.memo?.trim() || `Expense ${cip.asset_number}`
          : `Capitalize ${cip.asset_number} → ${line.name.trim()}`
        ).slice(0, 500),
      })),
      memo,
    );
    const posted = await postCapitalizationEntry(tx, {
      orgId,
      actorId: options.actorId,
      subsidiaryId: cip.subsidiary_id,
      date: input.capitalizedOn,
      entryNumber: `CIPX-${capitalizationId}`,
      memo,
      idempotencyKey: `asset-cip-capitalization:${capitalizationId}`,
      lines: lines.map((line) => ({
        ...line,
        departmentId: cip.department_id,
        projectId: cip.project_id,
        locationId: cip.location_id,
      })),
    });
    if (!posted) throw new Error("the capitalization journal posted no lines");
    await tx.execute(sql`
      insert into asset_cip_capitalizations
        (id, org_id, cip_asset_id, subsidiary_id, capitalized_on, entry_id, capitalized_amount, expensed_amount,
         reason, idempotency_key, request_hash, created_by)
      values
        (${capitalizationId}, ${orgId}, ${cip.id}, ${cip.subsidiary_id}, ${input.capitalizedOn}, ${posted.entryId},
         ${plan.capitalized}, ${plan.expensed}, ${reason}, ${input.idempotencyKey}, ${hash}, ${options.actorId})`);

    const assets: CapitalizeCipResult["assets"] = [];
    const assetByLine = new Map<number, string>();
    for (const [index, line] of input.lines.entries()) {
      let assetId: string | null = null;
      let assetNumber: string | null = null;
      if (line.kind !== "expense") {
        const asset = await createDraftAsset(tx, {
          orgId,
          actorId: options.actorId,
          subsidiaryId: cip.subsidiary_id,
          categoryId: line.categoryId,
          name: line.name,
          description: line.description ?? null,
          acquisitionCost: amounts[index]!,
          acquiredOn: input.capitalizedOn,
          inServiceOn: input.capitalizedOn,
          parentAssetId: targets[index]!.parentAssetId,
          departmentId: cip.department_id,
          projectId: cip.project_id,
          locationId: cip.location_id,
          provenance: { kind: "cip_capitalization", capitalizationId, cipAssetId: cip.id },
        });
        assetId = asset.id;
        assetNumber = asset.assetNumber;
        assetByLine.set(index, asset.id);
        assets.push({ id: asset.id, assetNumber: asset.assetNumber, amount: amounts[index]! });
      }
      await tx.execute(sql`
        insert into asset_cip_capitalization_lines
          (org_id, capitalization_id, line_number, kind, asset_id, asset_number, parent_asset_id, target_account_id, amount, memo)
        values
          (${orgId}, ${capitalizationId}, ${index + 1}, ${line.kind}, ${assetId}, ${assetNumber}, ${targets[index]!.parentAssetId},
           ${targets[index]!.targetAccountId}, ${amounts[index]!}, ${line.kind === "expense" ? line.memo?.trim() || null : (line.description ?? null)})`);
    }
    for (const [index, line] of input.lines.entries()) {
      const assetId = assetByLine.get(index);
      if (line.kind !== "expense" && line.placeInService && assetId) {
        await placeDraftInService(tx, { orgId, assetId, actorId: options.actorId });
      }
    }
    const balance = await syncCipCarriedCost(tx, {
      orgId,
      cipAssetId: cip.id,
      actorId: options.actorId,
      closeWhenEmpty: input.closeWhenEmpty !== false,
    });
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'asset_cip_capitalizations', ${capitalizationId}, 'insert',
              ${JSON.stringify({ before: null, after: { cipAssetId: cip.id, capitalizedOn: input.capitalizedOn, entryId: posted.entryId, capitalized: plan.capitalized, expensed: plan.expensed, assets }, reason })}::jsonb,
              ${options.actorId})`);
    return {
      capitalizationId,
      entryId: posted.entryId,
      assets,
      capitalized: plan.capitalized,
      expensed: plan.expensed,
      remaining: balance.open,
      replayed: false,
    };
  });
}

/**
 * Reverse a capitalization: post its mirror journal, remove the draft
 * assets it created and reopen the record. Refused once a created asset has
 * left draft or carries anything another record depends on.
 */
export async function reverseCipCapitalization(
  orgId: string,
  args: {
    capitalizationId: string;
    date: string;
    reason: string;
    actorId: string;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<{
  capitalizationId: string;
  reversalEntryId: string;
  removedAssets: string[];
  replayed: boolean;
}> {
  const reason = args.reason.trim();
  if (!reason) refuse("reason_required", "state why the capitalization is reversed");
  if (!isIsoCalendarDate(args.date))
    refuse("date_invalid", "the reversal date must be a calendar date (YYYY-MM-DD)");
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const capitalization = (
      await tx.execute<{
        id: string;
        cip_asset_id: string;
        status: string;
        entry_id: string;
        reversal_entry_id: string | null;
        capitalized_on: string;
      }>(
        sql`
      select id, cip_asset_id, status, entry_id, reversal_entry_id, capitalized_on::text as capitalized_on
        from asset_cip_capitalizations where org_id = ${orgId} and id = ${args.capitalizationId} for update`,
        "objects",
      )
    )[0];
    if (!capitalization)
      refuse("capitalization_not_found", "capitalization not found", { status: 404 });
    const cip = await lockCip(tx, orgId, capitalization.cip_asset_id, args.allowedSubsidiaryIds);
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.capitalize",
      feature: "constructionInProgress",
      subsidiaryIds: [cip.subsidiary_id],
    });
    if (capitalization.status === "reversed") {
      return {
        capitalizationId: capitalization.id,
        reversalEntryId: capitalization.reversal_entry_id!,
        removedAssets: [],
        replayed: true,
      };
    }
    if (args.date < capitalization.capitalized_on)
      refuse(
        "reversal_before_capitalization",
        `the reversal date cannot precede ${capitalization.capitalized_on}`,
      );
    const later = (
      await tx.execute(
        sql`
      select 1 from asset_cip_capitalizations
       where org_id = ${orgId} and cip_asset_id = ${cip.id} and status = 'posted' and id <> ${capitalization.id}
         and (capitalized_on > ${capitalization.capitalized_on} or (capitalized_on = ${capitalization.capitalized_on} and created_at > (select created_at from asset_cip_capitalizations where org_id = ${orgId} and id = ${capitalization.id})))
       limit 1`,
        "objects",
      )
    )[0];
    if (later)
      refuse(
        "later_capitalization_exists",
        "a later capitalization of this record is still posted",
        { status: 409, remedy: "Reverse the later capitalization first." },
      );
    const created = await tx.execute<{ asset_id: string; asset_number: string }>(
      sql`
      select asset_id, asset_number from asset_cip_capitalization_lines
       where org_id = ${orgId} and capitalization_id = ${capitalization.id} and asset_id is not null order by line_number`,
      "objects",
    );
    for (const line of created) {
      const asset = (
        await tx.execute<{ status: string }>(
          sql`
        select status from fixed_assets where org_id = ${orgId} and id = ${line.asset_id} for update`,
          "objects",
        )
      )[0];
      if (asset && asset.status !== "draft") {
        refuse("asset_not_draft", `asset ${line.asset_number} is ${asset.status}`, {
          status: 409,
          remedy:
            "Return the asset to draft (it must have no posted depreciation or lifecycle history) before reversing the capitalization.",
        });
      }
      const blockers = await tx.execute<{ blocker: string }>(
        sql`
        select 'lifecycle history' as blocker where exists (select 1 from asset_events where org_id = ${orgId} and asset_id = ${line.asset_id})
        union all select 'components' where exists (select 1 from fixed_assets where org_id = ${orgId} and parent_asset_id = ${line.asset_id})
        union all select 'an equipment unit' where exists (select 1 from equipment_units where org_id = ${orgId} and fixed_asset_id = ${line.asset_id})
        union all select 'maintenance records' where exists (select 1 from asset_maintenance_records where org_id = ${orgId} and asset_id = ${line.asset_id})
        union all select 'maintenance schedules' where exists (select 1 from asset_maintenance_schedules where org_id = ${orgId} and asset_id = ${line.asset_id})
        union all select 'meter readings' where exists (select 1 from asset_usage_readings where org_id = ${orgId} and asset_id = ${line.asset_id})
        union all select 'insurance coverage' where exists (select 1 from asset_insurance_coverages where org_id = ${orgId} and asset_id = ${line.asset_id})
        union all select 'proposal allocations' where exists (select 1 from asset_proposal_allocations where org_id = ${orgId} and asset_id = ${line.asset_id})`,
        "objects",
      );
      if (blockers.length > 0) {
        refuse(
          "asset_in_use",
          `asset ${line.asset_number} has ${blockers.map((row) => row.blocker).join(", ")}`,
          {
            status: 409,
            remedy: "Remove or reverse those first, then reverse the capitalization.",
          },
        );
      }
    }
    const reversalEntryId = await postCapitalizationReversal(tx, {
      orgId,
      actorId: args.actorId,
      entryId: capitalization.entry_id,
      date: args.date,
      reason,
    });
    const flipped = (
      await tx.execute<{ id: string }>(
        sql`
      update asset_cip_capitalizations
         set status = 'reversed', reversal_entry_id = ${reversalEntryId}, reversed_at = clock_timestamp(),
             reversed_by = ${args.actorId}, reversal_reason = ${reason}
       where org_id = ${orgId} and id = ${capitalization.id} and status = 'posted'
       returning id`,
        "objects",
      )
    )[0];
    if (!flipped) throw new Error("the capitalization was not reversed; no row changed");
    await markCapitalizationEntryReversed(tx, {
      orgId,
      actorId: args.actorId,
      entryId: capitalization.entry_id,
    });
    const removed: string[] = [];
    for (const line of created) {
      const before = (
        await tx.execute<Record<string, unknown>>(
          sql`select * from fixed_assets where org_id = ${orgId} and id = ${line.asset_id}`,
          "objects",
        )
      )[0];
      if (!before) continue;
      await tx.execute(
        sql`update asset_cip_capitalization_lines set asset_id = null where org_id = ${orgId} and asset_id = ${line.asset_id}`,
      );
      await tx.execute(sql`
        delete from depreciation_schedule_lines
         where org_id = ${orgId} and schedule_id in (select id from depreciation_schedules where org_id = ${orgId} and asset_id = ${line.asset_id})`);
      await tx.execute(
        sql`delete from depreciation_schedules where org_id = ${orgId} and asset_id = ${line.asset_id}`,
      );
      const gone = (
        await tx.execute<{ id: string }>(
          sql`
        delete from fixed_assets where org_id = ${orgId} and id = ${line.asset_id} and status = 'draft' returning id`,
          "objects",
        )
      )[0];
      if (!gone) throw new Error(`asset ${line.asset_number} was not removed; no row changed`);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'fixed_assets', ${line.asset_id}, 'delete',
                ${JSON.stringify({ before, after: null, reason, capitalizationId: capitalization.id })}::jsonb, ${args.actorId})`);
      removed.push(line.asset_number);
    }
    await syncCipCarriedCost(tx, {
      orgId,
      cipAssetId: cip.id,
      actorId: args.actorId,
      closeWhenEmpty: false,
    });
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'asset_cip_capitalizations', ${capitalization.id}, 'update',
              ${JSON.stringify({ before: { status: "posted" }, after: { status: "reversed", reversalEntryId, removedAssets: removed }, reason })}::jsonb,
              ${args.actorId})`);
    return {
      capitalizationId: capitalization.id,
      reversalEntryId,
      removedAssets: removed,
      replayed: false,
    };
  });
}

export interface CipReconciliationRow {
  subsidiaryId: string;
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  subledger: string;
  ledger: string;
  difference: string;
}

/**
 * The CIP subledger against the GL, per legal entity and CIP account, as of
 * a date: linked costs posted by then less capitalizations dated by then,
 * against the primary-book balance of the account. A difference is GL
 * activity on the CIP account no record has linked (or unlinked cost still
 * sitting there) — link it or reclassify it.
 */
export async function cipReconciliation(
  orgId: string,
  args: { asOf: string; allowedSubsidiaryIds?: readonly string[] | null },
): Promise<CipReconciliationRow[]> {
  if (!isIsoCalendarDate(args.asOf))
    refuse("date_invalid", "the as-of date must be a calendar date (YYYY-MM-DD)");
  const scope = args.allowedSubsidiaryIds
    ? sql`and a.subsidiary_id = any(${uuidArray([...args.allowedSubsidiaryIds])}::uuid[])`
    : sql``;
  const rows = await db.execute<{
    subsidiary_id: string;
    account_id: string;
    account_number: string | null;
    account_name: string;
    subledger: string;
    ledger: string;
  }>(
    sql`
    with cip_accounts as (
      select distinct a.subsidiary_id, a.asset_account_id as account_id
        from fixed_assets a
       where a.org_id = ${orgId} and a.status in ('construction', 'capitalized') and a.asset_account_id is not null ${scope}
    ), subledger as (
      select a.subsidiary_id, a.asset_account_id as account_id,
             -- A cost counts while linked; a cost an acceptance reversal
             -- unlinked still counted until that reversal's posting date.
             coalesce((select sum(c.amount) from asset_cip_costs c
                        where c.org_id = a.org_id and c.cip_asset_id = a.id and c.posting_date <= ${args.asOf}
                          and (c.status = 'linked' or exists (
                            select 1 from asset_proposal_allocations al
                              join asset_proposal_acceptances ac on ac.org_id = al.org_id and ac.id = al.acceptance_id and ac.status = 'reversed'
                              join journal_entries rev on rev.org_id = ac.org_id and rev.id = ac.reversal_entry_id
                             where al.org_id = c.org_id and al.cip_cost_id = c.id and rev.posting_date > ${args.asOf}))), 0)
             -- A capitalization counts from its date until its reversal's date.
             - coalesce((select sum(k.capitalized_amount + k.expensed_amount) from asset_cip_capitalizations k
                          left join journal_entries rev on rev.org_id = k.org_id and rev.id = k.reversal_entry_id
                          where k.org_id = a.org_id and k.cip_asset_id = a.id and k.capitalized_on <= ${args.asOf}
                            and (k.status = 'posted' or rev.posting_date > ${args.asOf})), 0) as amount
        from fixed_assets a
       where a.org_id = ${orgId} and a.status in ('construction', 'capitalized') ${scope}
    )
    select ca.subsidiary_id, ca.account_id, acct.number as account_number, acct.name as account_name,
           coalesce((select sum(s.amount) from subledger s where s.subsidiary_id = ca.subsidiary_id and s.account_id = ca.account_id), 0)::text as subledger,
           coalesce((select sum(jl.amount) from journal_lines jl
                       join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id and je.status in ('posted', 'reversed')
                       join accounting_books b on b.org_id = je.org_id and b.id = je.book_id and b.is_primary and b.is_active and b.posts_gl
                      where jl.org_id = ${orgId} and jl.account_id = ca.account_id and jl.subsidiary_id = ca.subsidiary_id
                        and je.posting_date <= ${args.asOf}), 0)::text as ledger
      from cip_accounts ca
      join accounts acct on acct.org_id = ${orgId} and acct.id = ca.account_id
     order by acct.number nulls last, ca.subsidiary_id`,
    "objects",
  );
  return rows.map((row) => ({
    subsidiaryId: row.subsidiary_id,
    accountId: row.account_id,
    accountNumber: row.account_number,
    accountName: row.account_name,
    subledger: add(row.subledger, "0"),
    ledger: add(row.ledger, "0"),
    difference: add(row.ledger, neg(row.subledger)),
  }));
}
