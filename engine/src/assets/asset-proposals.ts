import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { add, cmp } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { ASSET_DEPTH_FEATURES, assertAssetAccess } from "./asset-access.ts";
import { orgsWithAssetFeature } from "./asset-alerts.ts";
import {
  createDraftAsset,
  lockCategoryForCapitalization,
  placeDraftInService,
} from "./asset-drafts.ts";
import { refuse } from "./asset-refusal.ts";
import { proposalMergeScopeIssue } from "./asset-proposal-merge.ts";
import { matchCapitalizationRule, type CapitalizationRule } from "./capitalization-rules.ts";
import {
  markCapitalizationEntryReversed,
  postCapitalizationEntry,
  postCapitalizationReversal,
} from "./capitalization-journal.ts";
import { cipBalance, syncCipCarriedCost } from "./cip-ledger.ts";
import {
  ACCEPTANCE_OPERATIONS,
  buildReclassLines,
  planAllocations,
  type AcceptanceOperation,
  type PlannedProposal,
} from "./proposal-math.ts";

/**
 * Asset proposals from purchases.
 *
 * A posted purchase line — a vendor bill, expense report or journal debit in
 * the primary posting book — that matches a capitalization rule becomes one
 * proposal, keyed by its journal line so re-running generation never
 * duplicates it. The queue's operator accepts a proposal as one asset, splits
 * it into several, merges several into one, adds it to an existing asset as a
 * component or to construction in progress, or rejects it with a reason.
 *
 * The purchase already debited the GL. Acceptance only moves that amount
 * from the account the purchase debited to the resulting asset's cost
 * account (or the CIP account) through one reclassification journal; when
 * they are the same account nothing posts. Reversing an acceptance posts
 * the mirror journal, removes the draft assets it created and returns the
 * proposals to the queue. A source transaction cannot be reversed while an
 * accepted proposal depends on it; pending proposals on a reversed source
 * are voided by the database fence.
 */

/** Journal origins whose debits are purchases an asset could come from. */
const PROPOSAL_SOURCE_ORIGINS = ["document", "manual", "intercompany"] as const;

type RuleRow = {
  id: string;
  name: string;
  subsidiary_id: string | null;
  match_kind: CapitalizationRule["matchKind"];
  account_id: string | null;
  item_id: string | null;
  item_category: string | null;
  asset_category_id: string | null;
  minimum_amount: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
};

export async function loadCapitalizationRules(
  tx: SqlExecutor,
  orgId: string,
): Promise<CapitalizationRule[]> {
  const rows = await tx.execute<RuleRow>(
    sql`
    select id, name, subsidiary_id, match_kind, account_id, item_id, item_category, asset_category_id,
           minimum_amount::text as minimum_amount, effective_from::text as effective_from,
           effective_to::text as effective_to, is_active
      from asset_capitalization_rules
     where org_id = ${orgId} and is_active`,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    subsidiaryId: row.subsidiary_id,
    matchKind: row.match_kind,
    accountId: row.account_id,
    itemId: row.item_id,
    itemCategory: row.item_category,
    assetCategoryId: row.asset_category_id,
    minimumAmount: row.minimum_amount,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    isActive: row.is_active,
  }));
}

type CandidateRow = {
  journal_line_id: string;
  entry_id: string;
  account_id: string;
  subsidiary_id: string;
  amount: string;
  memo: string | null;
  party_id: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  posting_date: string;
  source_document_id: string | null;
  base_currency: string;
  document_line_id: string | null;
  item_id: string | null;
  item_category: string | null;
  quantity: string | null;
  description: string | null;
};

/**
 * Positive debits of the given posted primary-book entries with their
 * document line, when the entry came from a document. A document posts one
 * debit per line in line order, so the k-th debit with a given account,
 * memo and dimensions is the k-th document line with the same account,
 * description and dimensions.
 */
async function candidateLines(
  tx: SqlExecutor,
  orgId: string,
  entryIds: readonly string[],
): Promise<CandidateRow[]> {
  if (entryIds.length === 0) return [];
  return await tx.execute<CandidateRow>(
    sql`
    with entries as (
      select je.id, je.source_document_id, je.posting_date
        from journal_entries je
        join accounting_books b on b.org_id = je.org_id and b.id = je.book_id
         and b.is_primary and b.is_active and b.posts_gl
       where je.org_id = ${orgId} and je.id = any(${uuidArray([...entryIds])}::uuid[])
         and je.status = 'posted' and je.reverses_entry_id is null -- Live entries only: reversed source debits cannot authorize a new capitalization proposal.
         and je.origin = any(${textArrayLiteral(PROPOSAL_SOURCE_ORIGINS)}::text[])
    ), debits as (
      select jl.id, jl.entry_id, jl.account_id, jl.subsidiary_id, jl.amount::text as amount, jl.memo,
             jl.party_id, jl.department_id, jl.project_id, jl.location_id,
             e.posting_date::text as posting_date, e.source_document_id,
             row_number() over (
               partition by jl.entry_id, jl.account_id, coalesce(jl.memo, ''), jl.project_id, jl.department_id, jl.location_id
               order by jl.line_number) as rn
        from journal_lines jl
        join entries e on e.id = jl.entry_id
       where jl.org_id = ${orgId} and jl.amount > 0 and not jl.is_open_item and jl.contributor_kind is null
    ), document_lines_ranked as (
      select dl.id, dl.document_id, dl.account_id, dl.item_id, i.category as item_category,
             case when dl.quantity > 0 then dl.quantity::text end as quantity, dl.description,
             coalesce(dl.description, '') as memo_key,
             coalesce(dl.project_id, d.project_id) as project_id,
             coalesce(dl.department_id, d.department_id) as department_id,
             coalesce(dl.location_id, d.location_id) as location_id,
             row_number() over (
               partition by dl.document_id, dl.account_id, coalesce(dl.description, ''),
                            coalesce(dl.project_id, d.project_id), coalesce(dl.department_id, d.department_id),
                            coalesce(dl.location_id, d.location_id)
               order by dl.line_number) as rn
        from document_lines dl
        join documents d on d.org_id = dl.org_id and d.id = dl.document_id
        left join items i on i.org_id = dl.org_id and i.id = dl.item_id
       where dl.org_id = ${orgId}
         and dl.document_id in (select source_document_id from entries where source_document_id is not null)
         and (dl.amount <> 0 or coalesce(dl.tax_amount, 0) <> 0)
    )
    select d.id as journal_line_id, d.entry_id, d.account_id, d.subsidiary_id, d.amount, d.memo, d.party_id,
           d.department_id, d.project_id, d.location_id, d.posting_date, d.source_document_id,
           s.base_currency, l.id as document_line_id, l.item_id, l.item_category, l.quantity, l.description
      from debits d
      join subsidiaries s on s.org_id = ${orgId} and s.id = d.subsidiary_id
      left join document_lines_ranked l
        on l.document_id = d.source_document_id and l.account_id = d.account_id
       and l.memo_key = coalesce(d.memo, '') and l.rn = d.rn
       and l.project_id is not distinct from d.project_id
       and l.department_id is not distinct from d.department_id
       and l.location_id is not distinct from d.location_id
     order by d.entry_id, d.id`,
    "objects",
  );
}

/** The posted debit a document line produced, or null when it has none. */
export async function journalLineForDocumentLine(
  tx: SqlExecutor,
  orgId: string,
  documentLineId: string,
): Promise<string | null> {
  const entry = (
    await tx.execute<{ posted_entry_id: string | null }>(
      sql`
    select d.posted_entry_id from document_lines dl
      join documents d on d.org_id = dl.org_id and d.id = dl.document_id
     where dl.org_id = ${orgId} and dl.id = ${documentLineId} and d.status = 'posted'`,
      "objects",
    )
  )[0]?.posted_entry_id;
  if (!entry) return null;
  const lines = await candidateLines(tx, orgId, [entry]);
  return lines.find((line) => line.document_line_id === documentLineId)?.journal_line_id ?? null;
}

/**
 * Create proposals for every matching debit of the given entries. Idempotent
 * per journal line: a line already proposed (pending, accepted, rejected or
 * voided) is never proposed again. Returns the number created.
 */
export async function generateAssetProposalsForEntries(
  tx: SqlExecutor,
  args: { orgId: string; entryIds: readonly string[]; actorId: string | null },
): Promise<number> {
  const rules = await loadCapitalizationRules(tx, args.orgId);
  if (rules.length === 0) return 0;
  let created = 0;
  for (const line of await candidateLines(tx, args.orgId, args.entryIds)) {
    const rule = matchCapitalizationRule(rules, {
      subsidiaryId: line.subsidiary_id,
      accountId: line.account_id,
      itemId: line.item_id,
      itemCategory: line.item_category,
      amount: line.amount,
      postingDate: line.posting_date,
    });
    if (!rule) continue;
    const inserted = (
      await tx.execute<{ id: string }>(
        sql`
      insert into asset_proposals
        (org_id, subsidiary_id, origin, rule_id, source_entry_id, source_line_id, source_document_id,
         source_document_line_id, account_id, item_id, vendor_party_id, department_id, project_id, location_id,
         description, quantity, amount, currency, posting_date, suggested_category_id, created_by, updated_by)
      values
        (${args.orgId}, ${line.subsidiary_id}, 'rule', ${rule.id}, ${line.entry_id}, ${line.journal_line_id},
         ${line.source_document_id}, ${line.document_line_id}, ${line.account_id}, ${line.item_id}, ${line.party_id},
         ${line.department_id}, ${line.project_id}, ${line.location_id}, ${line.description ?? line.memo},
         ${line.quantity}, ${line.amount}, ${line.base_currency}, ${line.posting_date}, ${rule.assetCategoryId},
         ${args.actorId}, ${args.actorId})
      -- One proposal per source journal line: a line proposed by an earlier
      -- run (or by a concurrent posting drain) keeps its first proposal.
      on conflict (org_id, source_line_id) do nothing
      returning id`,
        "objects",
      )
    )[0];
    if (inserted) created += 1;
  }
  return created;
}

/**
 * The posting hook: propose assets for a just-posted entry when the
 * organization has asset proposals switched on. A no-op otherwise.
 */
export async function proposeAssetsForPostedEntry(
  orgId: string,
  entryId: string,
  actorId: string | null,
): Promise<number> {
  if (!(await orgFeatureEnabled(orgId, "assetProposals"))) return 0;
  return withOrgTransaction(orgId, () =>
    generateAssetProposalsForEntries(db, { orgId, entryIds: [entryId], actorId }),
  );
}

/** A Postgres text[] literal with every element quoted and escaped. */
function textArrayLiteral(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;
}

/** Entries in a posting-date window carrying a debit any active rule could match. */
async function entriesInWindow(
  tx: SqlExecutor,
  orgId: string,
  window: { from?: string; to?: string; postedSince?: string },
): Promise<string[]> {
  const rules = await loadCapitalizationRules(tx, orgId);
  if (rules.length === 0) return [];
  const accounts = rules.flatMap((rule) => (rule.accountId ? [rule.accountId] : []));
  const items = rules.flatMap((rule) => (rule.itemId ? [rule.itemId] : []));
  const categories = rules.flatMap((rule) =>
    rule.itemCategory ? [rule.itemCategory.trim().toLowerCase()] : [],
  );
  const rows = await tx.execute<{ id: string }>(
    sql`
    select distinct je.id
      from journal_entries je
      join accounting_books b on b.org_id = je.org_id and b.id = je.book_id and b.is_primary and b.is_active and b.posts_gl
      join journal_lines jl on jl.org_id = je.org_id and jl.entry_id = je.id and jl.amount > 0
     where je.org_id = ${orgId} and je.status = 'posted' and je.reverses_entry_id is null -- Live entries only: reversed source debits cannot authorize a new capitalization proposal.
       and je.origin = any(${textArrayLiteral(PROPOSAL_SOURCE_ORIGINS)}::text[])
       ${window.from ? sql`and je.posting_date >= ${window.from}` : sql``}
       ${window.to ? sql`and je.posting_date <= ${window.to}` : sql``}
       ${window.postedSince ? sql`and je.posted_at >= ${window.postedSince}::timestamptz` : sql``}
       and (jl.account_id = any(${uuidArray(accounts)}::uuid[])
         or exists (
           select 1 from document_lines dl
             left join items i on i.org_id = dl.org_id and i.id = dl.item_id
            where dl.org_id = je.org_id and dl.document_id = je.source_document_id
              and (dl.item_id = any(${uuidArray(items)}::uuid[])
                or lower(btrim(i.category)) = any(${textArrayLiteral(categories)}::text[]))))
     order by je.id`,
    "objects",
  );
  return rows.map((row) => row.id);
}

/**
 * Operator-run scan over a posting-date window: proposes every matching
 * line posted while the feature was off, or before a rule was added.
 */
export async function scanAssetProposals(
  orgId: string,
  args: { from: string; to: string; actorId: string },
): Promise<{ entriesScanned: number; created: number }> {
  if (!isIsoCalendarDate(args.from) || !isIsoCalendarDate(args.to) || args.from > args.to) {
    refuse("window_invalid", "choose a valid posting-date window (from on or before to)");
  }
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.capitalize",
      feature: "assetProposals",
      subsidiaryIds: [],
    });
    // Scans serialize per organization so two operators cannot interleave.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"asset-proposal-scan:" + orgId}, 0))`,
    );
    const entryIds = await entriesInWindow(tx, orgId, { from: args.from, to: args.to });
    const created = await generateAssetProposalsForEntries(tx, {
      orgId,
      entryIds,
      actorId: args.actorId,
    });
    return { entriesScanned: entryIds.length, created };
  });
}

/**
 * The daily catch-up for every organization with proposals on: entries
 * posted in the last three days, in case a posting drain was interrupted.
 */
export async function runAssetProposalScanDuty(
  now: Date,
): Promise<{ orgId: string; created: number }[]> {
  const orgIds = await orgsWithAssetFeature("assetProposals");
  const since = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const results: { orgId: string; created: number }[] = [];
  for (const orgId of orgIds) {
    const created = await withOrgTransaction(orgId, async () => {
      const tx: SqlExecutor = db;
      if (!(await lockAndCheckOrgFeature(tx, orgId, "assetProposals"))) return 0;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"asset-proposal-scan:" + orgId}, 0))`,
      );
      const entryIds = await entriesInWindow(tx, orgId, { postedSince: since });
      return generateAssetProposalsForEntries(tx, { orgId, entryIds, actorId: null });
    });
    results.push({ orgId, created });
  }
  return results;
}

/**
 * Propose one posted GL line by hand — a purchase no rule covers, or a
 * maintenance betterment to capitalize. Returns the existing proposal when
 * the line was already proposed.
 */
export async function proposeJournalLine(
  orgId: string,
  args: {
    journalLineId: string;
    actorId: string;
    categoryId?: string | null;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<{ proposalId: string; created: boolean }> {
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const existing = (
      await tx.execute<{ id: string; subsidiary_id: string }>(
        sql`
      select id, subsidiary_id from asset_proposals where org_id = ${orgId} and source_line_id = ${args.journalLineId}`,
        "objects",
      )
    )[0];
    const line = (
      await tx.execute<{ entry_id: string; subsidiary_id: string }>(
        sql`
      select jl.entry_id, jl.subsidiary_id from journal_lines jl where jl.org_id = ${orgId} and jl.id = ${args.journalLineId}`,
        "objects",
      )
    )[0];
    if (!line) refuse("source_line_not_found", "the GL line was not found", { status: 404 });
    if (args.allowedSubsidiaryIds && !args.allowedSubsidiaryIds.includes(line.subsidiary_id)) {
      refuse("source_line_not_found", "the GL line was not found", { status: 404 });
    }
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.capitalize",
      feature: "assetProposals",
      subsidiaryIds: [line.subsidiary_id],
    });
    if (existing) return { proposalId: existing.id, created: false };
    const candidate = (await candidateLines(tx, orgId, [line.entry_id])).find(
      (row) => row.journal_line_id === args.journalLineId,
    );
    if (!candidate) {
      refuse(
        "source_line_not_proposable",
        "only a posted, unreversed debit of a purchase, expense or journal in the primary book can be proposed",
      );
    }
    if (args.categoryId) await lockCategoryForCapitalization(tx, orgId, args.categoryId);
    const inserted = (
      await tx.execute<{ id: string }>(
        sql`
      insert into asset_proposals
        (org_id, subsidiary_id, origin, rule_id, source_entry_id, source_line_id, source_document_id,
         source_document_line_id, account_id, item_id, vendor_party_id, department_id, project_id, location_id,
         description, quantity, amount, currency, posting_date, suggested_category_id, created_by, updated_by)
      values
        (${orgId}, ${candidate.subsidiary_id}, 'manual', null, ${candidate.entry_id}, ${candidate.journal_line_id},
         ${candidate.source_document_id}, ${candidate.document_line_id}, ${candidate.account_id}, ${candidate.item_id},
         ${candidate.party_id}, ${candidate.department_id}, ${candidate.project_id}, ${candidate.location_id},
         ${candidate.description ?? candidate.memo}, ${candidate.quantity}, ${candidate.amount}, ${candidate.base_currency},
         ${candidate.posting_date}, ${args.categoryId ?? null}, ${args.actorId}, ${args.actorId})
      -- A concurrent proposal of the same line wins; the caller reads it back below.
      on conflict (org_id, source_line_id) do nothing
      returning id`,
        "objects",
      )
    )[0];
    if (inserted) return { proposalId: inserted.id, created: true };
    const raced = (
      await tx.execute<{ id: string }>(
        sql`
      select id from asset_proposals where org_id = ${orgId} and source_line_id = ${args.journalLineId}`,
        "objects",
      )
    )[0];
    if (!raced) throw new Error("the proposal was neither created nor found");
    return { proposalId: raced.id, created: false };
  });
}

type ProposalRow = {
  id: string;
  subsidiary_id: string;
  status: string;
  source_entry_id: string;
  source_document_line_id: string | null;
  source_document_id: string | null;
  account_id: string;
  amount: string;
  currency: string;
  posting_date: string;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  description: string | null;
  quantity: string | null;
};

async function lockProposals(
  tx: SqlExecutor,
  orgId: string,
  ids: readonly string[],
  allowed: readonly string[] | null | undefined,
): Promise<ProposalRow[]> {
  const rows = await tx.execute<ProposalRow>(
    sql`
    select id, subsidiary_id, status, source_entry_id, source_document_line_id, source_document_id, account_id,
           amount::text as amount, currency, posting_date::text as posting_date, department_id, project_id,
           location_id, description, quantity::text as quantity
      from asset_proposals
     where org_id = ${orgId} and id = any(${uuidArray([...new Set(ids)])}::uuid[])
       ${allowed ? sql`and subsidiary_id = any(${uuidArray([...allowed])}::uuid[])` : sql``}
     order by id for update`,
    "objects",
  );
  if (rows.length !== new Set(ids).size)
    refuse("proposal_not_found", "a selected proposal was not found", { status: 404 });
  const order = new Map(ids.map((id, index) => [id, index]));
  return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export interface AcceptTargetInput {
  name: string;
  categoryId: string;
  amount: string;
  quantity?: string | null;
  description?: string | null;
  serialNumber?: string | null;
  inServiceOn?: string | null;
  placeInService?: boolean;
}

export interface AcceptProposalsInput {
  idempotencyKey: string;
  operation: AcceptanceOperation;
  proposalIds: string[];
  acceptedOn: string;
  reason?: string | null;
  targets: AcceptTargetInput[];
  parentAssetId?: string | null;
  cipAssetId?: string | null;
}

export interface AcceptProposalsResult {
  acceptanceId: string;
  reclassEntryId: string | null;
  assets: { id: string | null; assetNumber: string; amount: string }[];
  replayed: boolean;
}

function requestHash(input: AcceptProposalsInput): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        operation: input.operation,
        proposalIds: [...input.proposalIds].sort(),
        acceptedOn: input.acceptedOn,
        reason: input.reason?.trim() || null,
        parentAssetId: input.parentAssetId ?? null,
        cipAssetId: input.cipAssetId ?? null,
        targets: input.targets.map((target) => ({
          name: target.name.trim(),
          categoryId: target.categoryId,
          amount: canonicalDecimal(target.amount, 4),
          quantity: target.quantity ?? null,
          description: target.description ?? null,
          serialNumber: target.serialNumber ?? null,
          inServiceOn: target.inServiceOn ?? null,
          placeInService: target.placeInService === true,
        })),
      }),
    )
    .digest("hex");
}

async function acceptanceResult(
  tx: SqlExecutor,
  orgId: string,
  acceptanceId: string,
  reclassEntryId: string | null,
): Promise<AcceptProposalsResult> {
  const rows = await tx.execute<{ asset_id: string | null; asset_number: string; amount: string }>(
    sql`
    select asset_id, asset_number, sum(amount)::text as amount
      from asset_proposal_allocations where org_id = ${orgId} and acceptance_id = ${acceptanceId}
     group by asset_id, asset_number order by asset_number`,
    "objects",
  );
  return {
    acceptanceId,
    reclassEntryId,
    assets: rows.map((row) => ({
      id: row.asset_id,
      assetNumber: row.asset_number,
      amount: add(row.amount, "0"),
    })),
    replayed: true,
  };
}

/**
 * Accept one or more pending proposals as assets, a component, or
 * construction in progress, under an idempotency key. Replaying the same
 * request returns the original acceptance; reusing the key for a different
 * request is refused.
 */
export async function acceptAssetProposals(
  orgId: string,
  input: AcceptProposalsInput,
  options: { actorId: string; allowedSubsidiaryIds?: readonly string[] | null },
): Promise<AcceptProposalsResult> {
  if (!(ACCEPTANCE_OPERATIONS as readonly string[]).includes(input.operation))
    refuse("operation_invalid", "choose how to accept the proposal");
  if (!isIsoCalendarDate(input.acceptedOn))
    refuse("date_invalid", "the acceptance date must be a calendar date (YYYY-MM-DD)");
  const hash = requestHash(input);
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"asset-proposal-acceptance:" + orgId + ":" + input.idempotencyKey}, 0))`,
    );
    if (input.proposalIds.length === 0)
      refuse("proposal_not_found", "select at least one proposal", { status: 404 });
    const proposals = await lockProposals(
      tx,
      orgId,
      input.proposalIds,
      options.allowedSubsidiaryIds,
    );
    const subsidiaryId = proposals[0]!.subsidiary_id;
    await assertAssetAccess(tx, {
      orgId,
      actorId: options.actorId,
      permission: "assets.capitalize",
      feature: "assetProposals",
      subsidiaryIds: [...new Set(proposals.map((proposal) => proposal.subsidiary_id))],
    });
    if (input.operation === "merge") {
      const scopeIssue = proposalMergeScopeIssue(
        proposals.map((proposal) => ({
          currency: proposal.currency,
          subsidiaryId: proposal.subsidiary_id,
        })),
      );
      if (scopeIssue === "currency") {
        refuse("proposal_merge_currency_mismatch", "proposals to merge must use one currency", {
          remedy: "Select proposals in the same currency before merging them.",
        });
      }
      if (scopeIssue === "subsidiary") {
        refuse(
          "proposal_merge_subsidiary_mismatch",
          "proposals to merge must belong to one legal entity",
          {
            remedy: "Select proposals from a single legal entity before merging them.",
          },
        );
      }
      if (scopeIssue === "missing_scope") {
        refuse(
          "proposal_merge_scope_missing",
          "each proposal must have a currency and legal entity before merging",
          {
            remedy:
              "Refresh the proposal list and resolve missing proposal currency or legal entity data.",
          },
        );
      }
    }
    const prior = (
      await tx.execute<{
        id: string;
        request_hash: string;
        reclass_entry_id: string | null;
        status: string;
      }>(
        sql`
      select id, request_hash, reclass_entry_id, status from asset_proposal_acceptances
       where org_id = ${orgId} and idempotency_key = ${input.idempotencyKey}`,
        "objects",
      )
    )[0];
    if (prior) {
      if (prior.request_hash !== hash) {
        refuse(
          "idempotency_conflict",
          "this request key was already used for a different acceptance",
          {
            status: 409,
            remedy: "Reopen the proposal to start a fresh acceptance.",
          },
        );
      }
      if (prior.status === "reversed") {
        refuse("acceptance_reversed", "this acceptance has already been reversed", {
          status: 409,
          remedy: "Refresh the proposal queue and use a new request key for a new acceptance.",
        });
      }
      return acceptanceResult(tx, orgId, prior.id, prior.reclass_entry_id);
    }

    for (const proposal of proposals) {
      if (proposal.status !== "pending") {
        refuse("proposal_not_pending", `a selected proposal is already ${proposal.status}`, {
          status: 409,
          remedy: "Refresh the queue.",
        });
      }
    }
    const sources = await tx.execute<{ id: string; status: string; entry_number: string }>(
      sql`
      select id, status, entry_number from journal_entries
       where org_id = ${orgId} and id = any(${uuidArray(proposals.map((proposal) => proposal.source_entry_id))}::uuid[])
       for share`,
      "objects",
    );
    const reversed = sources.find((entry) => entry.status !== "posted");
    if (reversed)
      refuse("source_reversed", `source journal ${reversed.entry_number} is no longer posted`, {
        status: 409,
      });
    const latestSource = proposals.reduce(
      (latest, proposal) => (proposal.posting_date > latest ? proposal.posting_date : latest),
      proposals[0]!.posting_date,
    );
    if (input.acceptedOn < latestSource) {
      refuse(
        "acceptance_before_source",
        `the acceptance date cannot precede the purchase posting date ${latestSource}`,
      );
    }
    const planned: PlannedProposal[] = proposals.map((proposal) => ({
      id: proposal.id,
      amount: proposal.amount,
      subsidiaryId: proposal.subsidiary_id,
      currency: proposal.currency,
      accountId: proposal.account_id,
      postingDate: proposal.posting_date,
      departmentId: proposal.department_id,
      projectId: proposal.project_id,
      locationId: proposal.location_id,
    }));

    // Resolve each target's cost account before anything posts.
    let targetAccounts: string[];
    let parent: { id: string; asset_number: string } | null = null;
    let cip: { id: string; asset_number: string; asset_account_id: string } | null = null;
    if (input.operation === "cip") {
      if (!input.cipAssetId)
        refuse("cip_required", "choose the construction-in-progress record to add the cost to");
      if (!(await lockAndCheckOrgFeature(tx, orgId, "constructionInProgress"))) {
        refuse(
          "feature_disabled",
          `${ASSET_DEPTH_FEATURES.constructionInProgress} is switched off for this organization`,
          {
            status: 409,
            remedy: `Turn on ${ASSET_DEPTH_FEATURES.constructionInProgress} under Fixed Assets in Company Settings → Features.`,
          },
        );
      }
      const row = (
        await tx.execute<{
          id: string;
          asset_number: string;
          status: string;
          subsidiary_id: string;
          asset_account_id: string | null;
        }>(
          sql`
        select id, asset_number, status, subsidiary_id, asset_account_id from fixed_assets
         where org_id = ${orgId} and id = ${input.cipAssetId} for update`,
          "objects",
        )
      )[0];
      if (!row || row.subsidiary_id !== subsidiaryId)
        refuse("cip_not_found", "construction-in-progress record not found in this legal entity", {
          status: 404,
        });
      if (row.status !== "construction")
        refuse("cip_closed", `construction in progress ${row.asset_number} is ${row.status}`);
      if (!row.asset_account_id)
        refuse(
          "cip_account_missing",
          `construction in progress ${row.asset_number} has no CIP account`,
        );
      cip = { id: row.id, asset_number: row.asset_number, asset_account_id: row.asset_account_id };
      targetAccounts = [row.asset_account_id];
    } else {
      if (input.targets.length === 0) refuse("targets_required", "describe the resulting asset");
      if (input.operation === "component") {
        if (!input.parentAssetId)
          refuse("parent_required", "choose the asset to add the component to");
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
        const row = (
          await tx.execute<{
            id: string;
            asset_number: string;
            status: string;
            subsidiary_id: string;
            parent_asset_id: string | null;
          }>(
            sql`
          select id, asset_number, status, subsidiary_id, parent_asset_id from fixed_assets
           where org_id = ${orgId} and id = ${input.parentAssetId} for update`,
            "objects",
          )
        )[0];
        if (!row) refuse("asset_not_found", "parent asset not found", { status: 404 });
        if (row.subsidiary_id !== subsidiaryId) {
          refuse(
            "component_cross_subsidiary",
            `asset ${row.asset_number} belongs to a different legal entity than the proposal`,
          );
        }
        if (row.parent_asset_id)
          refuse(
            "component_nesting",
            `asset ${row.asset_number} is itself a component; choose its parent`,
          );
        if (!["draft", "in_service", "fully_depreciated"].includes(row.status)) {
          refuse(
            "component_parent_status",
            `asset ${row.asset_number} is ${row.status} and cannot take components`,
          );
        }
        parent = { id: row.id, asset_number: row.asset_number };
      }
      targetAccounts = [];
      for (const target of input.targets) {
        targetAccounts.push(
          (await lockCategoryForCapitalization(tx, orgId, target.categoryId)).assetAccountId,
        );
      }
    }

    const targets =
      input.operation === "cip"
        ? [{ amount: proposals.reduce((sum, proposal) => add(sum, proposal.amount), "0") }]
        : input.targets.map((target) => {
            const amount = canonicalDecimal(target.amount, 4);
            if (amount === null)
              refuse("amount_invalid", "each asset cost must be an exact decimal amount");
            return { amount, quantity: target.quantity ?? null };
          });
    const allocations = planAllocations(input.operation, planned, targets);
    const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const acceptanceId = randomUUID();
    const reclass = buildReclassLines(
      allocations.map((allocation) => {
        const proposal = byId.get(allocation.proposalId)!;
        return {
          sourceAccountId: proposal.account_id,
          targetAccountId: targetAccounts[allocation.targetIndex]!,
          amount: allocation.amount,
          departmentId: proposal.department_id,
          projectId: proposal.project_id,
          locationId: proposal.location_id,
          memo: `Capitalize ${proposal.description ?? "purchase"}`.slice(0, 500),
        };
      }),
    );
    const posted = await postCapitalizationEntry(tx, {
      orgId,
      actorId: options.actorId,
      subsidiaryId,
      date: input.acceptedOn,
      entryNumber: `CAPX-${acceptanceId}`,
      memo: input.reason?.trim()
        ? `Asset proposal acceptance — ${input.reason.trim()}`
        : "Asset proposal acceptance",
      idempotencyKey: `asset-proposal-acceptance:${acceptanceId}`,
      lines: reclass,
    });
    await tx.execute(sql`
      insert into asset_proposal_acceptances
        (id, org_id, subsidiary_id, operation, accepted_on, reclass_entry_id, reason, idempotency_key, request_hash, created_by)
      values
        (${acceptanceId}, ${orgId}, ${subsidiaryId}, ${input.operation}, ${input.acceptedOn}, ${posted?.entryId ?? null},
         ${input.reason?.trim() || null}, ${input.idempotencyKey}, ${hash}, ${options.actorId})`);

    // buildReclassLines emits a debit/credit pair per moving allocation, in
    // allocation order, and the kernel keeps that order as line numbers: the
    // debit of the k-th moving allocation is posted line 2k + 1.
    const debitLineIds = new Map<number, string>();
    {
      let next = 0;
      allocations.forEach((allocation, index) => {
        const proposal = byId.get(allocation.proposalId)!;
        if (proposal.account_id === targetAccounts[allocation.targetIndex]) return;
        const line = posted?.lines[next];
        if (
          !line ||
          line.accountId !== targetAccounts[allocation.targetIndex] ||
          cmp(line.amount, allocation.amount) !== 0
        ) {
          throw new Error("the reclassification lines do not match the planned allocations");
        }
        debitLineIds.set(index, line.id);
        next += 2;
      });
    }

    const created: { id: string; assetNumber: string; amount: string }[] = [];
    if (cip) {
      // The CIP cost is the reclass debit on the CIP account, or the source
      // line itself when the purchase already debited the CIP account.
      for (const [index, allocation] of allocations.entries()) {
        const proposal = byId.get(allocation.proposalId)!;
        const viaReclass = proposal.account_id !== cip.asset_account_id;
        const sourceEntryId = viaReclass ? posted!.entryId : proposal.source_entry_id;
        const sourceLineId = viaReclass
          ? debitLineIds.get(index)
          : (
              await tx.execute<{ source_line_id: string }>(
                sql`select source_line_id from asset_proposals where org_id = ${orgId} and id = ${proposal.id}`,
                "objects",
              )
            )[0]?.source_line_id;
        if (!sourceLineId)
          throw new Error("the construction-in-progress cost line could not be resolved");
        const cost = (
          await tx.execute<{ id: string }>(
            sql`
          insert into asset_cip_costs
            (org_id, cip_asset_id, subsidiary_id, source_entry_id, source_line_id, source_document_id, account_id,
             project_id, amount, posting_date, memo, linked_by)
          values
            (${orgId}, ${cip.id}, ${subsidiaryId}, ${sourceEntryId}, ${sourceLineId}, ${proposal.source_document_id},
             ${cip.asset_account_id}, ${proposal.project_id}, ${allocation.amount},
             ${viaReclass ? input.acceptedOn : proposal.posting_date}, ${proposal.description}, ${options.actorId})
          returning id`,
            "objects",
          )
        )[0];
        if (!cost) throw new Error("the construction-in-progress cost was not linked");
        created.push({
          id: sourceLineId,
          assetNumber: cip.asset_number,
          amount: allocation.amount,
        });
        await tx.execute(sql`
          insert into asset_proposal_allocations
            (org_id, acceptance_id, proposal_id, asset_id, asset_number, cip_cost_id, target_account_id, amount)
          values (${orgId}, ${acceptanceId}, ${proposal.id}, ${cip.id}, ${cip.asset_number}, ${cost.id}, ${cip.asset_account_id}, ${allocation.amount})`);
      }
      await syncCipCarriedCost(tx, {
        orgId,
        cipAssetId: cip.id,
        actorId: options.actorId,
        closeWhenEmpty: false,
      });
    } else {
      const assets: { id: string; assetNumber: string }[] = [];
      for (const [index, target] of input.targets.entries()) {
        const sources = allocations
          .filter((allocation) => allocation.targetIndex === index)
          .map((allocation) => byId.get(allocation.proposalId)!);
        const first = sources[0]!;
        const same = <K extends "department_id" | "project_id" | "location_id">(key: K) =>
          sources.every((source) => source[key] === first[key]) ? first[key] : null;
        const asset = await createDraftAsset(tx, {
          orgId,
          actorId: options.actorId,
          subsidiaryId,
          categoryId: target.categoryId,
          name: target.name,
          description: target.description ?? first.description,
          serialNumber: target.serialNumber ?? null,
          acquisitionCost: targets[index]!.amount,
          acquiredOn: sources.reduce(
            (latest, source) => (source.posting_date > latest ? source.posting_date : latest),
            first.posting_date,
          ),
          inServiceOn: target.inServiceOn ?? null,
          parentAssetId: parent?.id ?? null,
          // A merged asset keeps its first source line here; every source
          // line stays recorded in the acceptance's allocations.
          sourceDocumentLineId: first.source_document_line_id,
          departmentId: same("department_id"),
          projectId: same("project_id"),
          locationId: same("location_id"),
          provenance: {
            kind: "asset_proposal_acceptance",
            acceptanceId,
            operation: input.operation,
            proposalIds: sources.map((source) => source.id),
          },
        });
        assets.push(asset);
        created.push({
          id: asset.id,
          assetNumber: asset.assetNumber,
          amount: targets[index]!.amount,
        });
      }
      for (const allocation of allocations) {
        const asset = assets[allocation.targetIndex]!;
        await tx.execute(sql`
          insert into asset_proposal_allocations
            (org_id, acceptance_id, proposal_id, asset_id, asset_number, target_account_id, amount, quantity)
          values (${orgId}, ${acceptanceId}, ${allocation.proposalId}, ${asset.id}, ${asset.assetNumber},
                  ${targetAccounts[allocation.targetIndex]!}, ${allocation.amount}, ${input.targets[allocation.targetIndex]?.quantity ?? null})`);
      }
      for (const [index, target] of input.targets.entries()) {
        if (target.placeInService)
          await placeDraftInService(tx, {
            orgId,
            assetId: assets[index]!.id,
            actorId: options.actorId,
          });
      }
    }

    const accepted = await tx.execute<{ id: string }>(
      sql`
      update asset_proposals
         set status = 'accepted', acceptance_id = ${acceptanceId}, resolved_at = clock_timestamp(),
             resolved_by = ${options.actorId}, resolution_reason = ${input.reason?.trim() || null},
             updated_at = clock_timestamp(), updated_by = ${options.actorId}
       where org_id = ${orgId} and id = any(${uuidArray(proposals.map((proposal) => proposal.id))}::uuid[]) and status = 'pending'
       returning id`,
      "objects",
    );
    if (accepted.length !== proposals.length)
      throw new Error("not every proposal was marked accepted");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'asset_proposal_acceptances', ${acceptanceId}, 'insert',
              ${JSON.stringify({ before: null, after: { operation: input.operation, proposalIds: input.proposalIds, acceptedOn: input.acceptedOn, reclassEntryId: posted?.entryId ?? null, assets: created } })}::jsonb,
              ${options.actorId})`);
    return {
      acceptanceId,
      reclassEntryId: posted?.entryId ?? null,
      assets: cip
        ? [{ id: cip.id, assetNumber: cip.asset_number, amount: targets[0]!.amount }]
        : created.map((entry) => ({
            id: entry.id,
            assetNumber: entry.assetNumber,
            amount: entry.amount,
          })),
      replayed: false,
    };
  });
}

/** Reject a pending proposal with a reason; it leaves the queue but stays on record. */
export async function rejectAssetProposal(
  orgId: string,
  args: {
    proposalId: string;
    reason: string;
    actorId: string;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<void> {
  const reason = args.reason.trim();
  if (!reason) refuse("reason_required", "state why the proposal is rejected");
  if (reason.length > 2000) refuse("reason_too_long", "reasons are limited to 2,000 characters");
  await withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const [proposal] = await lockProposals(tx, orgId, [args.proposalId], args.allowedSubsidiaryIds);
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.capitalize",
      feature: "assetProposals",
      subsidiaryIds: [proposal!.subsidiary_id],
    });
    if (proposal!.status !== "pending")
      refuse("proposal_not_pending", `the proposal is already ${proposal!.status}`, {
        status: 409,
      });
    const updated = (
      await tx.execute<{ id: string }>(
        sql`
      update asset_proposals
         set status = 'rejected', resolved_at = clock_timestamp(), resolved_by = ${args.actorId},
             resolution_reason = ${reason}, updated_at = clock_timestamp(), updated_by = ${args.actorId}
       where org_id = ${orgId} and id = ${args.proposalId} and status = 'pending'
       returning id`,
        "objects",
      )
    )[0];
    if (!updated) throw new Error("the proposal was not rejected; no row changed");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'asset_proposals', ${args.proposalId}, 'update',
              ${JSON.stringify({ before: { status: "pending" }, after: { status: "rejected" }, reason })}::jsonb, ${args.actorId})`);
  });
}

/** Return a rejected proposal to the queue. */
export async function restoreAssetProposal(
  orgId: string,
  args: {
    proposalId: string;
    reason: string;
    actorId: string;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<void> {
  const reason = args.reason.trim();
  if (!reason) refuse("reason_required", "state why the proposal returns to the queue");
  await withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const [proposal] = await lockProposals(tx, orgId, [args.proposalId], args.allowedSubsidiaryIds);
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.capitalize",
      feature: "assetProposals",
      subsidiaryIds: [proposal!.subsidiary_id],
    });
    if (proposal!.status !== "rejected")
      refuse(
        "proposal_not_rejected",
        `only a rejected proposal can return to the queue (this one is ${proposal!.status})`,
        { status: 409 },
      );
    const source = (
      await tx.execute<{ status: string }>(
        sql`
      select status from journal_entries where org_id = ${orgId} and id = ${proposal!.source_entry_id} for share`,
        "objects",
      )
    )[0];
    if (source?.status !== "posted")
      refuse("source_reversed", "the source transaction is no longer posted", { status: 409 });
    const updated = (
      await tx.execute<{ id: string }>(
        sql`
      update asset_proposals
         set status = 'pending', resolved_at = null, resolved_by = null, resolution_reason = null,
             updated_at = clock_timestamp(), updated_by = ${args.actorId}
       where org_id = ${orgId} and id = ${args.proposalId} and status = 'rejected'
       returning id`,
        "objects",
      )
    )[0];
    if (!updated) throw new Error("the proposal was not restored; no row changed");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'asset_proposals', ${args.proposalId}, 'update',
              ${JSON.stringify({ before: { status: "rejected" }, after: { status: "pending" }, reason })}::jsonb, ${args.actorId})`);
  });
}

/**
 * Reverse an acceptance: post the mirror of its reclassification, remove the
 * draft assets it created (or unlink its construction-in-progress cost) and
 * return its proposals to the queue. Refused once any created asset has left
 * draft, carries history or is referenced elsewhere — reverse that first.
 */
export async function reverseAssetProposalAcceptance(
  orgId: string,
  args: {
    acceptanceId: string;
    date: string;
    reason: string;
    actorId: string;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<{
  acceptanceId: string;
  reversalEntryId: string | null;
  removedAssets: string[];
  replayed: boolean;
}> {
  const reason = args.reason.trim();
  if (!reason) refuse("reason_required", "state why the acceptance is reversed");
  if (!isIsoCalendarDate(args.date))
    refuse("date_invalid", "the reversal date must be a calendar date (YYYY-MM-DD)");
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const acceptance = (
      await tx.execute<{
        id: string;
        subsidiary_id: string;
        status: string;
        operation: string;
        reclass_entry_id: string | null;
        reversal_entry_id: string | null;
        accepted_on: string;
      }>(
        sql`
      select id, subsidiary_id, status, operation, reclass_entry_id, reversal_entry_id, accepted_on::text as accepted_on
        from asset_proposal_acceptances
       where org_id = ${orgId} and id = ${args.acceptanceId}
         ${args.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${uuidArray([...args.allowedSubsidiaryIds])}::uuid[])` : sql``}
       for update`,
        "objects",
      )
    )[0];
    if (!acceptance) refuse("acceptance_not_found", "acceptance not found", { status: 404 });
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.capitalize",
      feature: "assetProposals",
      subsidiaryIds: [acceptance.subsidiary_id],
    });
    if (acceptance.status === "reversed") {
      return {
        acceptanceId: acceptance.id,
        reversalEntryId: acceptance.reversal_entry_id,
        removedAssets: [],
        replayed: true,
      };
    }
    if (args.date < acceptance.accepted_on)
      refuse(
        "reversal_before_acceptance",
        `the reversal date cannot precede the acceptance date ${acceptance.accepted_on}`,
      );
    const allocations = await tx.execute<{
      id: string;
      asset_id: string | null;
      asset_number: string;
      cip_cost_id: string | null;
      amount: string;
    }>(
      sql`
      select id, asset_id, asset_number, cip_cost_id, amount::text as amount
        from asset_proposal_allocations where org_id = ${orgId} and acceptance_id = ${acceptance.id} order by id`,
      "objects",
    );

    const cipAssetIds = new Set<string>();
    const removable = [
      ...new Set(
        allocations.filter((row) => !row.cip_cost_id && row.asset_id).map((row) => row.asset_id!),
      ),
    ];
    for (const assetId of removable) {
      const asset = (
        await tx.execute<{ asset_number: string; status: string }>(
          sql`
        select asset_number, status from fixed_assets where org_id = ${orgId} and id = ${assetId} for update`,
          "objects",
        )
      )[0];
      if (!asset) continue;
      if (asset.status !== "draft") {
        refuse("asset_not_draft", `asset ${asset.asset_number} is ${asset.status}`, {
          status: 409,
          remedy:
            "Return the asset to draft (it must have no posted depreciation or lifecycle history) before reversing the acceptance.",
        });
      }
      const blockers = await tx.execute<{ blocker: string }>(
        sql`
        select 'lifecycle history' as blocker where exists (select 1 from asset_events where org_id = ${orgId} and asset_id = ${assetId})
        union all select 'components' where exists (select 1 from fixed_assets where org_id = ${orgId} and parent_asset_id = ${assetId})
        union all select 'an equipment unit' where exists (select 1 from equipment_units where org_id = ${orgId} and fixed_asset_id = ${assetId})
        union all select 'maintenance schedules' where exists (select 1 from asset_maintenance_schedules where org_id = ${orgId} and asset_id = ${assetId})
        union all select 'maintenance records' where exists (select 1 from asset_maintenance_records where org_id = ${orgId} and asset_id = ${assetId})
        union all select 'meter readings' where exists (select 1 from asset_usage_readings where org_id = ${orgId} and asset_id = ${assetId})
        union all select 'insurance coverage' where exists (select 1 from asset_insurance_coverages where org_id = ${orgId} and asset_id = ${assetId})
        union all select 'posted depreciation' where exists (
          select 1 from depreciation_schedule_lines l join depreciation_schedules s on s.org_id = l.org_id and s.id = l.schedule_id
           where s.org_id = ${orgId} and s.asset_id = ${assetId} and (l.posted_amount is not null or l.input_id is not null))`,
        "objects",
      );
      if (blockers.length > 0) {
        refuse(
          "asset_in_use",
          `asset ${asset.asset_number} has ${blockers.map((row) => row.blocker).join(", ")}`,
          {
            status: 409,
            remedy: "Remove or reverse those first, then reverse the acceptance.",
          },
        );
      }
    }
    for (const allocation of allocations.filter((row) => row.cip_cost_id)) {
      const cost = (
        await tx.execute<{ cip_asset_id: string; status: string }>(
          sql`
        update asset_cip_costs
           set status = 'unlinked', unlinked_at = clock_timestamp(), unlinked_by = ${args.actorId}, unlink_reason = ${reason}
         where org_id = ${orgId} and id = ${allocation.cip_cost_id} and status = 'linked'
         returning cip_asset_id, status`,
          "objects",
        )
      )[0];
      if (!cost)
        refuse(
          "cip_cost_not_linked",
          "the construction-in-progress cost from this acceptance is no longer linked",
          { status: 409 },
        );
      cipAssetIds.add(cost.cip_asset_id);
    }
    for (const cipAssetId of cipAssetIds) {
      const balance = await cipBalance(tx, orgId, cipAssetId);
      if (cmp(balance.open, "0") < 0) {
        refuse(
          "cip_already_capitalized",
          "part of this cost has already been capitalized out of construction in progress",
          {
            status: 409,
            remedy: "Reverse the construction-in-progress capitalization first.",
          },
        );
      }
      await syncCipCarriedCost(tx, {
        orgId,
        cipAssetId,
        actorId: args.actorId,
        closeWhenEmpty: false,
      });
    }

    const reversalEntryId = acceptance.reclass_entry_id
      ? await postCapitalizationReversal(tx, {
          orgId,
          actorId: args.actorId,
          entryId: acceptance.reclass_entry_id,
          date: args.date,
          reason,
        })
      : null;
    const flipped = (
      await tx.execute<{ id: string }>(
        sql`
      update asset_proposal_acceptances
         set status = 'reversed', reversal_entry_id = ${reversalEntryId}, reversed_at = clock_timestamp(),
             reversed_by = ${args.actorId}, reversal_reason = ${reason}
       where org_id = ${orgId} and id = ${acceptance.id} and status = 'posted'
       returning id`,
        "objects",
      )
    )[0];
    if (!flipped) throw new Error("the acceptance was not reversed; no row changed");
    if (acceptance.reclass_entry_id) {
      await markCapitalizationEntryReversed(tx, {
        orgId,
        actorId: args.actorId,
        entryId: acceptance.reclass_entry_id,
      });
    }

    const removed: string[] = [];
    for (const assetId of removable) {
      const before = (
        await tx.execute<Record<string, unknown>>(
          sql`
        select * from fixed_assets where org_id = ${orgId} and id = ${assetId}`,
          "objects",
        )
      )[0];
      if (!before) continue;
      await tx.execute(
        sql`update asset_proposal_allocations set asset_id = null where org_id = ${orgId} and asset_id = ${assetId}`,
      );
      await tx.execute(sql`
        delete from depreciation_schedule_lines
         where org_id = ${orgId} and schedule_id in (select id from depreciation_schedules where org_id = ${orgId} and asset_id = ${assetId})`);
      await tx.execute(
        sql`delete from depreciation_schedules where org_id = ${orgId} and asset_id = ${assetId}`,
      );
      const gone = (
        await tx.execute<{ id: string }>(
          sql`
        delete from fixed_assets where org_id = ${orgId} and id = ${assetId} and status = 'draft' returning id`,
          "objects",
        )
      )[0];
      if (!gone)
        throw new Error(`asset ${String(before.asset_number)} was not removed; no row changed`);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'fixed_assets', ${assetId}, 'delete',
                ${JSON.stringify({ before, after: null, reason, acceptanceId: acceptance.id })}::jsonb, ${args.actorId})`);
      removed.push(String(before.asset_number));
    }
    const reopened = await tx.execute<{ id: string }>(
      sql`
      update asset_proposals
         set status = 'pending', acceptance_id = null, resolved_at = null, resolved_by = null, resolution_reason = null,
             updated_at = clock_timestamp(), updated_by = ${args.actorId}
       where org_id = ${orgId} and acceptance_id = ${acceptance.id} and status = 'accepted'
       returning id`,
      "objects",
    );
    if (reopened.length === 0) throw new Error("no proposal returned to the queue");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'asset_proposal_acceptances', ${acceptance.id}, 'update',
              ${JSON.stringify({ before: { status: "posted" }, after: { status: "reversed", reversalEntryId, removedAssets: removed }, reason })}::jsonb,
              ${args.actorId})`);
    return {
      acceptanceId: acceptance.id,
      reversalEntryId,
      removedAssets: removed,
      replayed: false,
    };
  });
}
