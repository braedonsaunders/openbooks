import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { add, cmp } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { disposeAsset } from "./asset-lifecycle.ts";
import { assertAssetAccess } from "./asset-access.ts";
import { createDraftAsset } from "./asset-drafts.ts";
import { refuse } from "./asset-refusal.ts";
import {
  apportionProceeds,
  assertComponentAttachable,
  rollUpCompound,
  type BookRollup,
  type ComponentCandidate,
} from "./compound-math.ts";

/**
 * Compound assets. A parent asset owns component assets one level deep in
 * the same legal entity. Every component is a full asset — its own cost,
 * life, method and per-book schedules — so it is depreciated, disposed,
 * written off or transferred on its own; the parent's register view rolls
 * the family up per book. Disposing the parent disposes every remaining
 * component in the same transaction.
 */

type AssetRow = {
  id: string;
  asset_number: string;
  name: string;
  subsidiary_id: string;
  status: string;
  parent_asset_id: string | null;
};

const scopeSql = (allowed: readonly string[] | null | undefined) =>
  allowed ? sql`and subsidiary_id = any(${uuidArray([...allowed])}::uuid[])` : sql``;

async function candidate(
  tx: SqlExecutor,
  orgId: string,
  row: AssetRow,
): Promise<ComponentCandidate> {
  const [children, books] = await Promise.all([
    tx.execute<{ id: string }>(
      sql`select id from fixed_assets where org_id = ${orgId} and parent_asset_id = ${row.id}`,
      "objects",
    ),
    tx.execute<{ book_id: string }>(
      sql`select distinct book_id from depreciation_schedules where org_id = ${orgId} and asset_id = ${row.id}`,
      "objects",
    ),
  ]);
  return {
    id: row.id,
    assetNumber: row.asset_number,
    subsidiaryId: row.subsidiary_id,
    status: row.status,
    parentAssetId: row.parent_asset_id,
    childIds: children.map((child) => child.id),
    scheduledBookIds: books.map((book) => book.book_id),
  };
}

/** Lock assets in id order so concurrent attachments cannot deadlock or interleave. */
async function lockAssets(
  tx: SqlExecutor,
  orgId: string,
  ids: readonly string[],
  allowed: readonly string[] | null | undefined,
): Promise<Map<string, AssetRow>> {
  const rows = await tx.execute<AssetRow>(
    sql`
    select id, asset_number, name, subsidiary_id, status, parent_asset_id
      from fixed_assets
     where org_id = ${orgId} and id = any(${uuidArray([...new Set(ids)])}::uuid[]) ${scopeSql(allowed)}
     order by id
     for update`,
    "objects",
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function audit(
  tx: SqlExecutor,
  orgId: string,
  assetId: string,
  actorId: string,
  before: unknown,
  after: unknown,
  reason: string | null,
) {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'fixed_assets', ${assetId}, 'update',
            ${JSON.stringify({ before, after, reason })}::jsonb, ${actorId})`);
}

/** Attach an existing asset to a parent as one of its components. */
export async function attachAssetComponent(
  orgId: string,
  args: {
    parentAssetId: string;
    componentAssetId: string;
    actorId: string;
    reason?: string | null;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<{ parentAssetId: string; componentAssetId: string }> {
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const locked = await lockAssets(
      tx,
      orgId,
      [args.parentAssetId, args.componentAssetId],
      args.allowedSubsidiaryIds,
    );
    const parent = locked.get(args.parentAssetId);
    const child = locked.get(args.componentAssetId);
    if (!parent || !child) refuse("asset_not_found", "asset not found", { status: 404 });
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.manage",
      feature: "assetComponents",
      subsidiaryIds: [parent.subsidiary_id, child.subsidiary_id],
    });
    assertComponentAttachable(
      await candidate(tx, orgId, parent),
      await candidate(tx, orgId, child),
    );
    if (child.parent_asset_id === parent.id)
      return { parentAssetId: parent.id, componentAssetId: child.id };
    const updated = (
      await tx.execute<{ id: string }>(
        sql`
      update fixed_assets set parent_asset_id = ${parent.id}, updated_at = clock_timestamp(), updated_by = ${args.actorId}
       where org_id = ${orgId} and id = ${child.id} and parent_asset_id is null
       returning id`,
        "objects",
      )
    )[0];
    if (!updated) throw new Error(`asset ${child.asset_number} was not attached; no row changed`);
    await audit(
      tx,
      orgId,
      child.id,
      args.actorId,
      { parent_asset_id: null },
      { parent_asset_id: parent.id },
      args.reason?.trim() || null,
    );
    return { parentAssetId: parent.id, componentAssetId: child.id };
  });
}

/** Detach a component so it stands alone in the register again. */
export async function detachAssetComponent(
  orgId: string,
  args: {
    componentAssetId: string;
    actorId: string;
    reason: string;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<{ componentAssetId: string; formerParentAssetId: string }> {
  const reason = args.reason.trim();
  if (!reason) refuse("reason_required", "state why the component is being detached");
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const locked = await lockAssets(tx, orgId, [args.componentAssetId], args.allowedSubsidiaryIds);
    const child = locked.get(args.componentAssetId);
    if (!child) refuse("asset_not_found", "asset not found", { status: 404 });
    if (!child.parent_asset_id)
      refuse("not_a_component", `asset ${child.asset_number} is not a component`);
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.manage",
      feature: "assetComponents",
      subsidiaryIds: [child.subsidiary_id],
    });
    const formerParentAssetId = child.parent_asset_id;
    const updated = (
      await tx.execute<{ id: string }>(
        sql`
      update fixed_assets set parent_asset_id = null, updated_at = clock_timestamp(), updated_by = ${args.actorId}
       where org_id = ${orgId} and id = ${child.id} and parent_asset_id = ${formerParentAssetId}
       returning id`,
        "objects",
      )
    )[0];
    if (!updated) throw new Error(`asset ${child.asset_number} was not detached; no row changed`);
    await audit(
      tx,
      orgId,
      child.id,
      args.actorId,
      { parent_asset_id: formerParentAssetId },
      { parent_asset_id: null },
      reason,
    );
    return { componentAssetId: child.id, formerParentAssetId };
  });
}

/** Create a new draft component under a parent (its own category, cost and life). */
export async function createAssetComponent(
  orgId: string,
  args: {
    parentAssetId: string;
    actorId: string;
    name: string;
    categoryId: string;
    acquisitionCost: string;
    acquiredOn?: string | null;
    inServiceOn?: string | null;
    description?: string | null;
    serialNumber?: string | null;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<{ id: string; assetNumber: string }> {
  const cost = canonicalDecimal(args.acquisitionCost, 4);
  if (cost === null || cmp(cost, "0") < 0)
    refuse("amount_invalid", "component cost must be a non-negative exact amount");
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const locked = await lockAssets(tx, orgId, [args.parentAssetId], args.allowedSubsidiaryIds);
    const parent = locked.get(args.parentAssetId);
    if (!parent) refuse("asset_not_found", "parent asset not found", { status: 404 });
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.manage",
      feature: "assetComponents",
      subsidiaryIds: [parent.subsidiary_id],
    });
    if (parent.parent_asset_id)
      refuse(
        "component_nesting",
        `asset ${parent.asset_number} is itself a component; add the new component to its parent`,
      );
    if (!["draft", "in_service", "fully_depreciated"].includes(parent.status)) {
      refuse(
        "component_parent_status",
        `asset ${parent.asset_number} is ${parent.status} and cannot take components`,
      );
    }
    const created = await createDraftAsset(tx, {
      orgId,
      actorId: args.actorId,
      subsidiaryId: parent.subsidiary_id,
      categoryId: args.categoryId,
      name: args.name,
      description: args.description ?? null,
      serialNumber: args.serialNumber ?? null,
      acquisitionCost: cost,
      acquiredOn: args.acquiredOn ?? null,
      inServiceOn: args.inServiceOn ?? null,
      parentAssetId: parent.id,
      provenance: { kind: "component", parentAssetId: parent.id },
    });
    return { id: created.id, assetNumber: created.assetNumber };
  });
}

export interface CompoundMember {
  id: string;
  assetNumber: string;
  name: string;
  status: string;
  categoryName: string | null;
  isParent: boolean;
  books: { bookId: string; cost: string; accumulated: string; carryingValue: string }[];
}

export interface CompoundView {
  parent: { id: string; assetNumber: string; name: string; parentAssetId: string | null };
  members: CompoundMember[];
  rollup: (BookRollup & { bookName: string; isPrimary: boolean })[];
}

/**
 * The compound view of an asset: itself, its components (or, for a
 * component, its parent and siblings) and the per-book roll-up of cost,
 * accumulated depreciation and carrying value across the family.
 */
export async function loadCompoundAsset(
  orgId: string,
  assetId: string,
  options: { allowedSubsidiaryIds?: readonly string[] | null } = {},
): Promise<CompoundView | null> {
  const self = (
    await db.execute<AssetRow>(
      sql`
    select id, asset_number, name, subsidiary_id, status, parent_asset_id from fixed_assets
     where org_id = ${orgId} and id = ${assetId} ${scopeSql(options.allowedSubsidiaryIds)}`,
      "objects",
    )
  )[0];
  if (!self) return null;
  const rootId = self.parent_asset_id ?? self.id;
  const members = await db.execute<{
    id: string;
    asset_number: string;
    name: string;
    status: string;
    parent_asset_id: string | null;
    category_name: string | null;
  }>(
    sql`
    select a.id, a.asset_number, a.name, a.status, a.parent_asset_id, c.name as category_name
      from fixed_assets a
      left join asset_categories c on c.org_id = a.org_id and c.id = a.category_id
     where a.org_id = ${orgId} and (a.id = ${rootId} or a.parent_asset_id = ${rootId})
     order by (a.id = ${rootId}) desc, a.asset_number`,
    "objects",
  );
  const root = members.find((member) => member.id === rootId);
  if (!root) return null;
  const values = await db.execute<{
    asset_id: string;
    book_id: string;
    book_name: string;
    is_primary: boolean;
    cost: string;
    accumulated: string;
    carrying_value: string;
  }>(
    sql`
    select v.asset_id, v.book_id, b.name as book_name, b.is_primary,
           v.cost::text as cost, v.accumulated::text as accumulated, v.carrying_value::text as carrying_value
      from asset_book_carrying_values v
      join accounting_books b on b.org_id = v.org_id and b.id = v.book_id and b.is_active
     where v.org_id = ${orgId} and v.asset_id = any(${uuidArray(members.map((member) => member.id))}::uuid[])
     order by b.is_primary desc, b.code`,
    "objects",
  );
  const books = new Map(
    values.map((row) => [row.book_id, { name: row.book_name, isPrimary: row.is_primary }]),
  );
  return {
    parent: {
      id: root.id,
      assetNumber: root.asset_number,
      name: root.name,
      parentAssetId: root.parent_asset_id,
    },
    members: members.map((member) => ({
      id: member.id,
      assetNumber: member.asset_number,
      name: member.name,
      status: member.status,
      categoryName: member.category_name,
      isParent: member.id === rootId,
      books: values
        .filter((row) => row.asset_id === member.id)
        .map((row) => ({
          bookId: row.book_id,
          cost: add(row.cost, "0"),
          accumulated: add(row.accumulated, "0"),
          carryingValue: add(row.carrying_value, "0"),
        })),
    })),
    rollup: rollUpCompound(
      values.map((row) => ({
        assetId: row.asset_id,
        bookId: row.book_id,
        cost: row.cost,
        accumulated: row.accumulated,
        carryingValue: row.carrying_value,
      })),
    )
      .map((entry) => ({
        ...entry,
        bookName: books.get(entry.bookId)?.name ?? "",
        isPrimary: books.get(entry.bookId)?.isPrimary ?? false,
      }))
      .sort(
        (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.bookName.localeCompare(b.bookName),
      ),
  };
}

/**
 * Assets that could join a family as components: the parent's legal entity,
 * top level, owning no components of their own, and not yet disposed.
 */
export async function listComponentCandidates(
  orgId: string,
  parentAssetId: string,
): Promise<{ id: string; label: string }[]> {
  return await db.execute<{ id: string; label: string }>(
    sql`
    select a.id, concat_ws(' · ', a.asset_number, a.name) as label
      from fixed_assets a
      join fixed_assets root on root.org_id = a.org_id and root.id = ${parentAssetId}
     where a.org_id = ${orgId} and a.subsidiary_id = root.subsidiary_id
       and a.parent_asset_id is null and a.id <> root.id
       and a.status in ('draft', 'in_service', 'fully_depreciated')
       and not exists (select 1 from fixed_assets c where c.org_id = a.org_id and c.parent_asset_id = a.id)
     order by a.asset_number limit 500`,
    "objects",
  );
}

export interface CompoundDisposalResult {
  parentAssetId: string;
  disposals: {
    assetId: string;
    assetNumber: string;
    entryId: string | null;
    proceeds: string;
    nbv: string;
    gainLoss: string;
    status: string;
  }[];
}

/**
 * Dispose a parent and every remaining live component in one transaction.
 * Each asset derecognizes through the native disposal (its own journal,
 * schedule tie and period fence), and the sale price is apportioned across
 * them by primary-book carrying value. Components already disposed or
 * written off stay as they are; a draft component refuses the whole
 * operation, because a draft has no recognized cost to derecognize.
 */
export async function disposeCompoundAsset(
  orgId: string,
  args: {
    parentAssetId: string;
    date: string;
    proceeds?: string;
    proceedsAccountId?: string | null;
    writeOff?: boolean;
    reason: string;
    actorId: string;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<CompoundDisposalResult> {
  const reason = args.reason.trim();
  if (!reason) refuse("reason_required", "state why the compound asset is being disposed");
  const proceeds = canonicalDecimal(args.proceeds ?? "0", 4);
  if (proceeds === null || cmp(proceeds, "0") < 0)
    refuse("proceeds_invalid", "proceeds must be a non-negative exact amount");
  if (args.writeOff && cmp(proceeds, "0") !== 0)
    refuse(
      "write_off_with_proceeds",
      "a write-off takes no proceeds; record a sale disposal instead",
    );
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const family = await tx.execute<AssetRow>(
      sql`
      select id, asset_number, name, subsidiary_id, status, parent_asset_id from fixed_assets
       where org_id = ${orgId} and (id = ${args.parentAssetId} or parent_asset_id = ${args.parentAssetId})
         ${scopeSql(args.allowedSubsidiaryIds)}
       order by id for update`,
      "objects",
    );
    const parent = family.find((row) => row.id === args.parentAssetId);
    if (!parent) refuse("asset_not_found", "asset not found", { status: 404 });
    if (parent.parent_asset_id)
      refuse(
        "not_a_parent",
        `asset ${parent.asset_number} is a component; dispose it on its own or dispose its parent`,
      );
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.manage",
      feature: "assetComponents",
      subsidiaryIds: [parent.subsidiary_id],
    });
    const components = family.filter((row) => row.id !== parent.id);
    if (components.length === 0) {
      refuse("no_components", `asset ${parent.asset_number} has no components`, {
        remedy: "Use Dispose on the asset itself.",
      });
    }
    const drafts = family.filter((row) => row.status === "draft");
    if (drafts.length > 0) {
      refuse(
        "component_draft",
        `draft ${drafts.map((row) => row.asset_number).join(", ")} cannot be disposed`,
        {
          remedy:
            "Place each draft in service, or detach and delete it, before disposing the compound asset.",
        },
      );
    }
    const live = family.filter(
      (row) => row.status === "in_service" || row.status === "fully_depreciated",
    );
    if (!live.some((row) => row.id === parent.id)) {
      refuse(
        "parent_not_live",
        `asset ${parent.asset_number} is ${parent.status} and cannot be disposed`,
      );
    }
    // Remaining components first, the parent last, so a refusal on any
    // member rolls back the whole family.
    const ordered = [...live.filter((row) => row.id !== parent.id), parent];
    const carrying = await tx.execute<{ asset_id: string; cost: string; carrying_value: string }>(
      sql`
      select v.asset_id, v.cost::text as cost, v.carrying_value::text as carrying_value
        from asset_book_carrying_values v
        join accounting_books b on b.org_id = v.org_id and b.id = v.book_id and b.is_primary and b.is_active and b.posts_gl
       where v.org_id = ${orgId} and v.asset_id = any(${uuidArray(ordered.map((row) => row.id))}::uuid[])`,
      "objects",
    );
    const values = new Map(carrying.map((row) => [row.asset_id, row]));
    // The parent leads the apportionment so it absorbs the price when nothing carries value.
    const shares = new Map(
      apportionProceeds(
        proceeds,
        [parent, ...ordered.filter((row) => row.id !== parent.id)].map((row) => ({
          assetId: row.id,
          carryingValue: values.get(row.id)?.carrying_value ?? "0",
          cost: values.get(row.id)?.cost ?? "0",
        })),
      ).map((share) => [share.assetId, share.proceeds]),
    );
    const disposals: CompoundDisposalResult["disposals"] = [];
    for (const row of ordered) {
      const share = shares.get(row.id) ?? "0.0000";
      const value = values.get(row.id);
      if (
        row.id === parent.id &&
        cmp(value?.cost ?? "0", "0") === 0 &&
        cmp(value?.carrying_value ?? "0", "0") === 0 &&
        cmp(share, "0") === 0
      ) {
        // A parent that carries no cost of its own is only the family's
        // container: nothing sits in the ledger for it to derecognize, so it
        // closes with its components and posts no journal.
        const status = args.writeOff ? "written_off" : "disposed";
        const closed = (
          await tx.execute<{ id: string }>(
            sql`
          update fixed_assets set status = ${status}, updated_at = clock_timestamp(), updated_by = ${args.actorId}
           where org_id = ${orgId} and id = ${row.id} and status in ('in_service', 'fully_depreciated')
           returning id`,
            "objects",
          )
        )[0];
        if (!closed) throw new Error(`asset ${row.asset_number} was not closed; no row changed`);
        disposals.push({
          assetId: row.id,
          assetNumber: row.asset_number,
          entryId: null,
          proceeds: share,
          nbv: "0.0000",
          gainLoss: "0.0000",
          status,
        });
        continue;
      }
      const result = await disposeAsset(orgId, row.id, {
        date: args.date,
        actorId: args.actorId,
        writeOff: args.writeOff === true || cmp(share, "0") === 0,
        proceeds: share,
        proceedsAccountId: cmp(share, "0") === 0 ? null : (args.proceedsAccountId ?? null),
        allowedSubsidiaryIds: args.allowedSubsidiaryIds ?? null,
      });
      disposals.push({
        assetId: row.id,
        assetNumber: row.asset_number,
        entryId: result.entryId,
        proceeds: share,
        nbv: result.nbv,
        gainLoss: result.gainLoss,
        status: result.status,
      });
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'fixed_assets', ${parent.id}, 'update',
              ${JSON.stringify({ operation: "compound_disposal", reason, date: args.date, proceeds, disposals })}::jsonb, ${args.actorId})`);
    return { parentAssetId: parent.id, disposals };
  });
}
