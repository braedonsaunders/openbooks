import { lockActorIdentity } from "../organization/actor-permissions.ts";
import { bomQuantityPolicy, type BomQuantityPolicy } from "./bom-scrap.ts";
import { kitComponentMovesStock } from "./kits.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { fitsLedgerRange } from "../money/money.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { isUuid } from "../platform/uuid.ts";
import { businessTodayInTx, isIsoCalendarDate } from "../platform/business-date.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  assertFinancialChangeApproved,
  completeFinancialChange,
  existingFinancialChange,
  loadFinancialChange,
  proposeFinancialChange,
  MANUFACTURING_BOM_APPROVAL_OPERATION,
  MANUFACTURING_STANDARD_ROLLUP_OPERATION,
} from "../platform/financial-changes.ts";
import type { FinancialChange } from "../platform/financial-changes.ts";

export class BomPolicyError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly code = "bom_policy_refused",
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export { isAssemblyCapableKind } from "./public-contracts.ts";
export type BomPolicyLine = { [Field in keyof BomQuantityPolicy]: BomQuantityPolicy[Field] } & {
  componentItemId: string;
  quantityPer: string;
  sortOrder: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  operationSeq: number | null;
  scrapPct: string | null;
  isByproduct: boolean;
  outputCostWeight?: string | null;
};
export interface BomPolicyInput {
  assemblyItemId: string;
  expectedVersion: string | null;
  reason: string;
  components: Array<Omit<BomPolicyLine, "sortOrder">>;
  subsidiaryId?: string;
  requestKey?: string;
}
type StoredLine = BomPolicyLine & { id: string };

/** The editor, approval and replacement command share this concurrency token. */
export async function readBomPolicyVersion(tx: SqlExecutor, orgId: string, assemblyItemId: string) {
  return (
    (
      await tx.execute<{ version: string | null }>(
        sql`
    select md5(string_agg(id::text || ':' || updated_at::text || ':' || component_item_id::text || ':' ||
      quantity_per::text || ':' || sort_order::text || ':' || coalesce(effective_from::text,'') || ':' ||
      coalesce(effective_to::text,'') || ':' || coalesce(operation_seq::text,'') || ':' || coalesce(scrap_pct::text,'') || ':' || is_byproduct::text || ':' || quantity_basis || ':' || formula_output_quantity::text || ':' || coalesce(output_cost_weight::text,''),
      ',' order by sort_order,component_item_id,operation_seq nulls first,is_byproduct,effective_from nulls first,effective_to nulls first)) as version
    from bom_components where org_id=${orgId} and assembly_item_id=${assemblyItemId}`,
        "objects",
      )
    )[0]?.version ?? null
  );
}

function normalize(input: BomPolicyInput): BomPolicyLine[] {
  if (!isUuid(input.assemblyItemId) || !input.reason?.trim())
    throw new BomPolicyError("Choose an assembly and explain the recipe change.");
  if (
    !Array.isArray(input.components) ||
    input.components.length < 1 ||
    input.components.length > 500
  )
    throw new BomPolicyError("A bill of materials requires between 1 and 500 component lines.");
  const lines = input.components.map((line, index) => {
    if (!line || typeof line !== "object")
      throw new BomPolicyError(`Choose a valid recipe line ${index + 1}.`);
    const quantityPolicy = bomQuantityPolicy(line);
    if (line.isByproduct && quantityPolicy.quantityBasis === "per_batch")
      throw new BomPolicyError(
        "By-product output must scale with finished quantity; choose unit or formula quantities.",
      );
    const quantityPer = canonicalDecimal(line.quantityPer, 4);
    const outputCostWeight =
      line.outputCostWeight == null ? null : canonicalDecimal(line.outputCostWeight, 4);
    if (
      line.outputCostWeight != null &&
      (!line.isByproduct ||
        outputCostWeight === null ||
        !fitsLedgerRange(outputCostWeight) ||
        compareDecimal(outputCostWeight, "0") <= 0)
    )
      throw new BomPolicyError(
        "A joint output needs a positive exact cost weight relative to one unit of the primary output.",
      );
    const scrapPct = line.scrapPct === null ? null : canonicalDecimal(line.scrapPct, 4);
    if (!isUuid(line.componentItemId) || line.componentItemId === input.assemblyItemId)
      throw new BomPolicyError(
        `Choose a valid component other than the assembly on line ${index + 1}.`,
      );
    if (
      quantityPer === null ||
      !fitsLedgerRange(quantityPer) ||
      compareDecimal(quantityPer, "0") <= 0
    )
      throw new BomPolicyError(
        `Component quantity on line ${index + 1} must be positive with at most four decimal places.`,
      );
    if (
      line.scrapPct !== null &&
      (scrapPct === null ||
        compareDecimal(scrapPct, "0") < 0 ||
        compareDecimal(scrapPct, "100") >= 0)
    )
      throw new BomPolicyError(
        `Scrap on line ${index + 1} must be at least zero and less than 100 percent.`,
      );
    if (
      [line.effectiveFrom, line.effectiveTo].some(
        (date) => date !== null && !isIsoCalendarDate(date),
      ) ||
      (line.effectiveFrom !== null &&
        line.effectiveTo !== null &&
        line.effectiveTo <= line.effectiveFrom)
    )
      throw new BomPolicyError(`Choose a valid half-open effectivity window on line ${index + 1}.`);
    if (
      (line.operationSeq !== null &&
        (!Number.isSafeInteger(line.operationSeq) ||
          line.operationSeq <= 0 ||
          line.operationSeq > 2_147_483_647)) ||
      typeof line.isByproduct !== "boolean"
    )
      throw new BomPolicyError(
        `Choose a positive operation sequence and a valid by-product designation on line ${index + 1}.`,
      );
    return {
      ...line,
      ...quantityPolicy,
      quantityPer,
      scrapPct,
      outputCostWeight,
      sortOrder: index,
    };
  });
  for (let left = 0; left < lines.length; left++)
    for (let right = left + 1; right < lines.length; right++) {
      const a = lines[left]!,
        b = lines[right]!;
      // The editor names the offending component and windows from the refusal
      // body, so the overlap carries that structured evidence on the error for
      // the route boundary to answer with.
      const window = (line: BomPolicyLine) =>
        `[${line.effectiveFrom ?? "unbounded start"}, ${line.effectiveTo ?? "unbounded end"})`;
      if (
        a.componentItemId === b.componentItemId &&
        a.operationSeq === b.operationSeq &&
        a.isByproduct === b.isByproduct &&
        (a.effectiveTo === null || b.effectiveFrom === null || a.effectiveTo > b.effectiveFrom) &&
        (b.effectiveTo === null || a.effectiveFrom === null || b.effectiveTo > a.effectiveFrom)
      )
        throw new BomPolicyError(
          `Component ${a.componentItemId} has overlapping effectivity windows ${window(a)} and ${window(b)}; adjust the dates so the same operation and by-product designation do not overlap.`,
          422,
          "bom_effectivity_overlap",
          { componentItemId: a.componentItemId, windows: [window(a), window(b)] },
        );
    }
  return lines;
}

/** Recipe revisions require setup management, manufacturing revisions manufacturing management too. */
export async function assertBomRevisionAuthority(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  manufacturing: boolean,
) {
  if (!(await lockActorIdentity(tx, orgId, actorId))) throw new ScopeNotFoundError();
  if ((await lockActorCommandAuthority(tx, orgId, actorId, null, "admin.setup.manage")) !== null)
    throw new ScopeNotFoundError();
  if (
    manufacturing &&
    (await lockActorCommandAuthority(tx, orgId, actorId, null, "manufacturing.manage")) !== null
  )
    throw new ScopeNotFoundError();
}

/** The recipe state a revision proposes from: parent kind, concurrency version and stored lines. */
export async function readBomRecipe(tx: SqlExecutor, orgId: string, assemblyItemId: string) {
  const parent = (
    await tx.execute<{ kind: string }>(
      sql`select kind from items where org_id=${orgId} and id=${assemblyItemId} for no key update`,
      "objects",
    )
  )[0];
  if (!parent) throw new ScopeNotFoundError();
  const lines = await tx.execute<StoredLine>(
    sql`select id,component_item_id as "componentItemId",quantity_per::text as "quantityPer",sort_order as "sortOrder",
    effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo",operation_seq as "operationSeq",scrap_pct::text as "scrapPct",is_byproduct as "isByproduct",quantity_basis as "quantityBasis",formula_output_quantity::text as "formulaOutputQuantity",output_cost_weight::text as "outputCostWeight"
    from bom_components where org_id=${orgId} and assembly_item_id=${assemblyItemId}
    order by sort_order,component_item_id,operation_seq nulls first,is_byproduct,effective_from nulls first,effective_to nulls first`,
    "objects",
  );
  return {
    kind: parent.kind,
    version: await readBomPolicyVersion(tx, orgId, assemblyItemId),
    lines,
  };
}

async function validateReferences(
  tx: SqlExecutor,
  orgId: string,
  assemblyItemId: string,
  parentKind: string,
  lines: BomPolicyLine[],
) {
  const ids = [...new Set([assemblyItemId, ...lines.map((line) => line.componentItemId)])].sort();
  const items = await tx.execute<{ id: string; kind: string }>(
    sql`
    select id, kind from items
     where org_id=${orgId} and is_active
       and id in (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     order by id for share`,
    "objects",
  );
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== ids.length) {
    throw new BomPolicyError(
      parentKind === "kit"
        ? "The kit and every component must be active items in this organization."
        : "Every assembly and component must be an active inventory item with a costing profile in this organization.",
    );
  }
  if (
    parentKind === "kit" &&
    lines.some((line) => byId.get(line.componentItemId)?.kind === "kit")
  ) {
    throw new BomPolicyError(
      "A kit cannot contain another kit; choose a stocked item or a commercial-only component.",
    );
  }
  const profileRequiredIds =
    parentKind === "kit"
      ? lines
          .filter((line) => kitComponentMovesStock(byId.get(line.componentItemId)!.kind))
          .map((line) => line.componentItemId)
      : ids;
  if (profileRequiredIds.length === 0) return;
  const profiles = await tx.execute<{ itemId: string }>(
    sql`
    select item_id as "itemId" from item_inventory_profiles
     where org_id=${orgId}
       and item_id in (${sql.join(
         [...new Set(profileRequiredIds)].map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     order by item_id for share`,
    "objects",
  );
  const profiled = new Set(profiles.map((profile) => profile.itemId));
  if ([...new Set(profileRequiredIds)].some((id) => !profiled.has(id))) {
    throw new BomPolicyError(
      parentKind === "kit"
        ? "Each inventory or assembly component in a kit needs a costing profile; configure the component profile before saving."
        : "Every assembly and component must be an active inventory item with a costing profile in this organization.",
    );
  }
}

/** Earlier effectivity remains readable after a successor takes effect. A
 * back-dated revision is admitted for a first recipe or a later revision
 * alike whenever no production has posted on or after its start; anything
 * posted keeps the back-date refused, naming it. */
async function preserveHistory(
  tx: SqlExecutor,
  orgId: string,
  assemblyItemId: string,
  before: StoredLine[],
  next: BomPolicyLine[],
  today: string,
) {
  const semantic = (line: BomPolicyLine) => ({
    componentItemId: line.componentItemId,
    quantityPer: canonicalDecimal(line.quantityPer, 4),
    operationSeq: line.operationSeq,
    scrapPct: canonicalDecimal(line.scrapPct ?? "0", 4),
    isByproduct: line.isByproduct,
    quantityBasis: line.quantityBasis ?? "per_unit",
    formulaOutputQuantity: canonicalDecimal(line.formulaOutputQuantity ?? "1", 4),
    effectiveFrom: line.effectiveFrom,
  });
  const matched = new Set<number>();
  for (const old of before) {
    if (old.effectiveFrom !== null && old.effectiveFrom >= today) continue;
    const index = next.findIndex(
      (line, i) =>
        !matched.has(i) &&
        canonicalJson(semantic(line)) === canonicalJson(semantic(old)) &&
        (line.effectiveTo === old.effectiveTo ||
          ((old.effectiveTo === null || old.effectiveTo > today) &&
            line.effectiveTo !== null &&
            line.effectiveTo >= today &&
            (old.effectiveTo === null || line.effectiveTo <= old.effectiveTo))),
    );
    if (index < 0)
      throw new BomPolicyError(
        "Retain earlier component quantities and effectivity. End the current line today or later and add its successor with a new effective start.",
        409,
        "bom_history_immutable",
      );
    matched.add(index);
  }
  const backdated = next
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line, index }) =>
        !matched.has(index) && (line.effectiveFrom === null || line.effectiveFrom < today),
    );
  if (backdated.length > 0) {
    const starts = backdated
      .map(({ line }) => line.effectiveFrom)
      .filter((from): from is string => from !== null)
      .sort();
    await assertBackdateWindowClear(tx, orgId, assemblyItemId, starts[0] ?? "0001-01-01");
  }
}

/** Operation-sequence defaulting for manufacturing recipe lines. A blank
 * sequence is ambiguous only when several routing operations consume
 * material: with exactly one backflushing operation on the assembly's
 * active routing the line can only be consumed there, so the revision
 * carries that sequence instead of a blank. With several consuming
 * operations the operator names the operation explicitly; without a single
 * active routing the blank stands and release-time checks govern. */
async function defaultOperationSequences(
  tx: SqlExecutor,
  orgId: string,
  assemblyItemId: string,
  lines: BomPolicyLine[],
  asOf: string,
): Promise<BomPolicyLine[]> {
  if (!lines.some((line) => line.operationSeq === null)) return lines;
  const routings = await tx.execute<{ id: string; code: string }>(
    sql`
    select id, code from mfg_routings where org_id=${orgId} and produced_item_id=${assemblyItemId} and status='active'
      and effective_from <= ${asOf}::date and (effective_to is null or ${asOf}::date < effective_to)
     order by version desc, id`,
    "objects",
  );
  if (routings.length !== 1) return lines;
  const routing = routings[0]!;
  const consuming = await tx.execute<{ sequence: number }>(
    sql`
    select sequence from mfg_routing_operations where org_id=${orgId} and routing_id=${routing.id}
      and backflush_at in ('start','finish') order by sequence`,
    "objects",
  );
  if (consuming.length === 0) return lines;
  if (consuming.length === 1) {
    const only = consuming[0]!.sequence;
    return lines.map((line) =>
      line.operationSeq === null ? { ...line, operationSeq: only } : line,
    );
  }
  const blank = lines.findIndex((line) => line.operationSeq === null);
  throw new BomPolicyError(
    `Choose the consuming operation for recipe line ${blank + 1}: routing ${routing.code} consumes material at operations ${consuming.map((op) => op.sequence).join(", ")}, so a blank operation sequence cannot be placed. Enter the operation sequence explicitly.`,
    422,
    "bom_operation_seq_required",
  );
}

/** Production evidence for a back-dated recipe: released or completed
 * work orders, posted finished builds, and applied standard-cost roll-ups
 * on or after the requested start each refuse the back-date, naming what
 * posted. A release freezes the effective recipe into the order's material
 * snapshot and a roll-up freezes it into its costing evidence, so re-dating
 * the recipe underneath either would reinterpret posted history. Routing
 * operations carry no recipe history of their own — the release snapshot
 * above already freezes the routing version and operation each order ran. */
async function assertBackdateWindowClear(
  tx: SqlExecutor,
  orgId: string,
  assemblyItemId: string,
  earliestFrom: string,
): Promise<void> {
  const order = (
    await tx.execute<{ number: string; posted: string }>(
      sql`
    select number, greatest(released_at::date, coalesce(completed_at::date, released_at::date))::text as posted
      from mfg_work_orders
     where org_id=${orgId} and produced_item_id=${assemblyItemId} and released_at is not null
       and (released_at::date >= ${earliestFrom}::date or completed_at::date >= ${earliestFrom}::date)
     order by released_at, number limit 1`,
      "objects",
    )
  )[0];
  if (order)
    throw new BomPolicyError(
      `A back-dated recipe revision is refused: work order ${order.number} already posts production for this assembly (posted ${order.posted}). Propose the revision with an effective start of today or later.`,
      409,
      "bom_backdated_revision",
    );
  const build = (
    await tx.execute<{ moved: string }>(
      sql`
    select moved_at::date::text as moved from inventory_movements
     where org_id=${orgId} and item_id=${assemblyItemId} and kind='assembly_build' and status='posted'
       and moved_at::date >= ${earliestFrom}::date
     order by moved_at limit 1`,
      "objects",
    )
  )[0];
  if (build)
    throw new BomPolicyError(
      `A back-dated recipe revision is refused: finished production of this assembly already posted on ${build.moved}. Propose the revision with an effective start of today or later.`,
      409,
      "bom_backdated_revision",
    );
  const rollup = (
    await tx.execute<{ onDate: string }>(
      sql`
    select effective_on::text as "onDate" from financial_changes
     where org_id=${orgId} and subject_id=${assemblyItemId} and domain='manufacturing' and operation=${MANUFACTURING_STANDARD_ROLLUP_OPERATION}
       and status='applied' and effective_on >= ${earliestFrom}::date
     order by effective_on limit 1`,
      "objects",
    )
  )[0];
  if (rollup)
    throw new BomPolicyError(
      `A back-dated recipe revision is refused: an applied standard-cost roll-up for this assembly already freezes the recipe effective on ${rollup.onDate}. Propose the revision with an effective start of today or later.`,
      409,
      "bom_backdated_revision",
    );
}

async function replace(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  input: BomPolicyInput,
  before: Awaited<ReturnType<typeof readBomRecipe>>,
  lines: BomPolicyLine[],
  approvalChangeId?: string,
) {
  if (approvalChangeId)
    await tx.execute(sql`select set_config('openbooks.production_bom_changes',
    (coalesce(nullif(current_setting('openbooks.production_bom_changes',true),''),'{}')::jsonb||jsonb_build_object(${orgId + ":" + input.assemblyItemId}::text,${approvalChangeId}::text))::text,true)`);
  const deleted = await tx.execute(
    sql`delete from bom_components where org_id=${orgId} and assembly_item_id=${input.assemblyItemId} returning id`,
    "objects",
  );
  if (deleted.length !== before.lines.length)
    throw new BomPolicyError(
      "The prior recipe was not fully replaced; retry the transaction.",
      409,
    );
  for (const line of lines) {
    const inserted = await tx.execute(
      sql`insert into bom_components(org_id,assembly_item_id,component_item_id,quantity_per,sort_order,effective_from,effective_to,operation_seq,scrap_pct,is_byproduct,quantity_basis,formula_output_quantity,output_cost_weight,created_by,updated_by)
      values(${orgId},${input.assemblyItemId},${line.componentItemId},${line.quantityPer},${line.sortOrder},${line.effectiveFrom},${line.effectiveTo},${line.operationSeq},${line.scrapPct},${line.isByproduct},${line.quantityBasis},${line.formulaOutputQuantity},${line.outputCostWeight},${actorId},${actorId}) returning id`,
      "objects",
    );
    if (inserted.length !== 1)
      throw new BomPolicyError("A component was not stored; retry the transaction.", 409);
  }
  if (
    (
      await tx.execute(
        sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${orgId},'bom_components',${input.assemblyItemId},${before.lines.length ? "update" : "insert"},${JSON.stringify({ reason: input.reason.trim(), approvalChangeId: approvalChangeId ?? null, before: before.lines, after: lines })}::jsonb,${actorId}) returning id`,
        "objects",
      )
    ).length !== 1
  )
    throw new BomPolicyError("The recipe audit could not be stored; retry the transaction.", 409);
  return {
    assemblyItemId: input.assemblyItemId,
    version: await readBomPolicyVersion(tx, orgId, input.assemblyItemId),
    componentCount: lines.length,
  };
}

/** Inventory and virtual kits retain their native direct save; manufacturing proposes a revision. */
export async function saveBomPolicy(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  input: BomPolicyInput,
) {
  const lines = normalize(input);
  await tx.execute(sql`lock table bom_components in row exclusive mode`);
  if (!(await lockAndCheckOrgFeature(tx, orgId, "inventory"))) throw new ScopeNotFoundError();
  const manufacturingEnabled = await lockAndCheckOrgFeature(tx, orgId, "manufacturing");
  await assertBomRevisionAuthority(tx, orgId, actorId, false);
  // Request-key lock precedes subject locks, matching the approval apply order.
  if (input.requestKey)
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`financial-change:${orgId}:${input.requestKey}`}))`,
    );
  const before = await readBomRecipe(tx, orgId, input.assemblyItemId);
  if (
    !manufacturingEnabled &&
    before.kind !== "kit" &&
    (
      await tx.execute(
        sql`select 1 from financial_changes where org_id=${orgId} and subject_id=${input.assemblyItemId} and domain='manufacturing' and operation=${MANUFACTURING_BOM_APPROVAL_OPERATION}
    union all select 1 from mfg_work_orders where org_id=${orgId} and produced_item_id=${input.assemblyItemId} and released_at is not null limit 1`,
        "objects",
      )
    ).length
  )
    throw new ScopeNotFoundError();
  const manufacturing = manufacturingEnabled && before.kind !== "kit";
  if (
    !manufacturingEnabled &&
    [...before.lines, ...lines].some(
      (line) =>
        line.operationSeq !== null ||
        line.isByproduct ||
        (line.quantityBasis ?? "per_unit") !== "per_unit",
    )
  )
    throw new ScopeNotFoundError();
  if (
    before.kind === "kit" &&
    lines.some(
      (line) =>
        line.operationSeq !== null ||
        line.isByproduct ||
        compareDecimal(line.scrapPct ?? "0", "0") !== 0 ||
        line.quantityBasis !== "per_unit",
    )
  )
    throw new BomPolicyError(
      "A kit ships the quantities named; remove operation, by-product and scrap settings.",
    );
  if (manufacturing) {
    await assertBomRevisionAuthority(tx, orgId, actorId, true);
    if (
      !input.subsidiaryId ||
      !isUuid(input.subsidiaryId) ||
      !input.requestKey ||
      input.requestKey.length > 120 ||
      input.reason.trim().length < 8 ||
      input.reason.trim().length > 1000
    )
      throw new BomPolicyError(
        "Choose a booking entity, provide a request key and enter an approval reason between 8 and 1,000 characters.",
      );
    if (
      !(
        await tx.execute(
          sql`select id from subsidiaries where org_id=${orgId} and id=${input.subsidiaryId} and is_active and not is_elimination for share`,
          "objects",
        )
      ).length
    )
      throw new ScopeNotFoundError();
    const retained = (
      await tx.execute<{ effective_on: string }>(
        sql`select effective_on::text from financial_changes where org_id=${orgId} and idempotency_key=${input.requestKey}`,
        "objects",
      )
    )[0];
    const effectiveOn = retained?.effective_on ?? (await businessTodayInTx(tx, orgId));
    // A re-added line carries a blank sequence until the routing places it;
    // defaulting precedes the history match so a retained line still matches.
    const routed = await defaultOperationSequences(
      tx,
      orgId,
      input.assemblyItemId,
      lines,
      effectiveOn,
    );
    const proposal = {
      orgId,
      actorId,
      subsidiaryId: input.subsidiaryId,
      domain: "manufacturing" as const,
      subjectId: input.assemblyItemId,
      operation: MANUFACTURING_BOM_APPROVAL_OPERATION,
      effectiveOn,
      reason: input.reason,
      idempotencyKey: input.requestKey,
      payload: {
        assemblyItemId: input.assemblyItemId,
        expectedVersion: input.expectedVersion,
        components: routed,
        requiredSubsidiaryIds: [input.subsidiaryId],
      },
    };
    // Replays remain available after application, with current authority still required.
    const prior = await existingFinancialChange(tx, proposal);
    if (prior) return { changeId: prior, approvalRequired: true as const };
    if (before.version !== input.expectedVersion)
      throw new BomPolicyError(
        "This recipe changed after you opened it; reopen it and use its current revision.",
        409,
        "bom_revision_changed",
      );
    await preserveHistory(
      tx,
      orgId,
      input.assemblyItemId,
      before.lines,
      routed,
      proposal.effectiveOn,
    );
    await validateReferences(tx, orgId, input.assemblyItemId, before.kind, routed);
    return {
      changeId: await proposeFinancialChange(tx, { ...proposal, beforeState: before }),
      approvalRequired: true as const,
    };
  }
  if (before.version !== input.expectedVersion)
    throw new BomPolicyError(
      "This recipe changed after you opened it; reopen it and use its current revision.",
      409,
      "bom_revision_changed",
    );
  await validateReferences(tx, orgId, input.assemblyItemId, before.kind, lines);
  return replace(tx, orgId, actorId, input, before, lines);
}

export async function applyBomRevision(orgId: string, actorId: string, changeId: string) {
  return withOrgTransaction(orgId, async () => {
    await db.execute(sql`lock table bom_components in row exclusive mode`);
    if (!(await lockAndCheckOrgFeature(db, orgId, "manufacturing"))) throw new ScopeNotFoundError();
    await assertBomRevisionAuthority(db, orgId, actorId, true);
    const change = await loadFinancialChange(db, orgId, changeId);
    if (
      change.domain !== "manufacturing" ||
      change.operation !== MANUFACTURING_BOM_APPROVAL_OPERATION
    )
      throw new ScopeNotFoundError();
    if (change.status === "applied") {
      if (!change.result)
        throw new BomPolicyError(
          "The applied revision has no retained result; contact an administrator.",
          409,
        );
      return change.result;
    }
    const before = await readBomRecipe(db, orgId, change.subject_id);
    assertFinancialChangeApproved(change, {
      domain: "manufacturing",
      subjectId: change.subject_id,
      beforeState: before,
    });
    return applyApprovedBomRevision(db, orgId, actorId, change, before);
  });
}

/** Replace the stored lines with an approved revision's frozen payload, audited with the applying actor recorded. */
export async function applyApprovedBomRevision(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  change: FinancialChange,
  before: Awaited<ReturnType<typeof readBomRecipe>>,
) {
  const input = {
    assemblyItemId: change.subject_id,
    expectedVersion: change.payload.expectedVersion as string | null,
    reason: change.reason,
    components: change.payload.components as BomPolicyLine[],
  };
  const today = await businessTodayInTx(tx, orgId);
  const lines = await defaultOperationSequences(
    tx,
    orgId,
    change.subject_id,
    normalize(input),
    today,
  );
  if (before.kind === "kit")
    throw new BomPolicyError(
      "Virtual kit recipes use the inventory editor, not manufacturing revision approval.",
    );
  await preserveHistory(tx, orgId, change.subject_id, before.lines, lines, today);
  await validateReferences(tx, orgId, change.subject_id, before.kind, lines);
  const result = await replace(tx, orgId, actorId, input, before, lines, change.id);
  await completeFinancialChange(tx, orgId, change.id, actorId, result);
  return result;
}

/** BOM revision submission lives with the Flows policy engine (see
 * submitBomRevision in the financial-changes adapter): routing a revision
 * through approval gates is orchestration, and subledgers never import
 * orchestration back. */
