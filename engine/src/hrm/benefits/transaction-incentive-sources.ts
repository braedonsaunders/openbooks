import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { documentKindPermissions } from "../../records/document-kind-permissions.ts";
import { DOC_KIND_FEATURE } from "../../records/document-kind-features.ts";
import { requireAggregateBenefitsRead } from "../authorization.ts";
import { isUuid } from "../../platform/uuid.ts";
import { BenefitsError } from "./errors.ts";
import { assertHrmEnabled, db, requireActorId, requireOrgId, withOrgTransaction } from "./shared.ts";

/** Explicit native sources, independent of vendor item categories or company titles. */
export interface TransactionIncentiveSourceQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly legalEntityId: string;
  readonly currency: string;
  readonly documentKind: "sales_order" | "customer_invoice" | "field_ticket" | "quote";
  readonly itemIds: readonly string[];
  readonly lineIds: readonly string[];
  /** Null means the owning company; otherwise name a native built-in or custom segment. */
  readonly groupingSegmentId: string | null;
}

export interface TransactionIncentiveSourceLine {
  readonly sourceId: string;
  readonly documentId: string;
  readonly documentNumber: string;
  readonly documentRevision: string;
  readonly documentDate: string;
  readonly status: string;
  readonly itemId: string;
  readonly amount: string;
  readonly quantity: string;
  readonly currency: string;
  readonly legalEntityId: string;
  readonly groupId: string;
}

export interface TransactionIncentiveSourceSnapshot {
  readonly documentKind: TransactionIncentiveSourceQuery["documentKind"];
  readonly legalEntityId: string;
  readonly currency: string;
  readonly selectedItemIds: readonly string[];
  readonly grouping: { readonly id: string; readonly key: string; readonly sourceKind: string; readonly storageColumn: string | null } | null;
  readonly lines: readonly TransactionIncentiveSourceLine[];
  readonly digest: string;
}

const GROUP_COLUMNS: Readonly<Record<string, SQL>> = {
  subsidiary_id: sql`d.subsidiary_id::text`,
  department_id: sql`coalesce(l.department_id, d.department_id)::text`,
  project_id: sql`coalesce(l.project_id, d.project_id)::text`,
  location_id: sql`coalesce(l.location_id, d.location_id)::text`,
  class_id: sql`coalesce(l.class_id, d.class_id)::text`,
};

function nativeId(value: unknown, label: string): string {
  if (!isUuid(value)) throw new BenefitsError("INVALID_INPUT", `${label} must be a native record UUID — reload the selection and retry`);
  return value.toLowerCase();
}

function checkedIds(ids: readonly string[], label: string): string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new BenefitsError("INVALID_INPUT", `${label} is empty — select explicit native records before measuring an incentive`);
  }
  const checked = ids.map((id) => nativeId(id, label));
  if (new Set(checked).size !== checked.length) {
    throw new BenefitsError("INVALID_INPUT", `${label} includes a duplicate — select each source record once`);
  }
  return [...checked].sort();
}

/**
 * Read an explicitly selected source set on one native transaction. The
 * parent and line locks freeze document revisions and lifecycle decisions
 * through the caller's transaction; the standalone preview holds them until
 * its snapshot completes. A caller settling awards must keep measurement and
 * award creation on its enclosing transaction, not reuse an old preview.
 *
 * A document date is evidence, not an inferred work/occurrence date. Dated
 * responsibilities and any reviewed occurrence-date evidence are resolved by
 * the program's settlement loader before valuation. This read never invents
 * either from current project managers, item names, or vendor custom fields.
 */
export async function measureTransactionIncentiveSources(
  query: TransactionIncentiveSourceQuery,
): Promise<TransactionIncentiveSourceSnapshot> {
  const orgId = requireOrgId(query.orgId), actorId = requireActorId(query.actorId);
  const legalEntityId = nativeId(query.legalEntityId, "legalEntityId");
  const itemIds = checkedIds(query.itemIds, "itemIds"), lineIds = checkedIds(query.lineIds, "lineIds");
  if (!/^[A-Z]{3}$/.test(query.currency)) throw new BenefitsError("INVALID_INPUT", "select the program's ISO currency before measuring transactions");
  const permittedKinds = new Set(["sales_order", "customer_invoice", "field_ticket", "quote"]);
  if (!permittedKinds.has(query.documentKind)) throw new BenefitsError("INVALID_INPUT", "select a supported native commercial document kind before measuring transactions");
  const permission = documentKindPermissions(query.documentKind)?.read;
  if (!permission) throw new BenefitsError("REFUSED", "the source document kind has no native read contract — select a supported source");
  return withOrgTransaction(orgId, async () => {
    const scope = await requireAggregateBenefitsRead(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    if (!(await actorHasPermission(db, orgId, actorId, permission))) {
      throw new BenefitsError("REFUSED", `reading this incentive's transaction evidence requires ${permission} — ask an administrator to grant source access in Roles`);
    }
    if (scope !== null && !scope.has(legalEntityId)) throw new BenefitsError("NOT_FOUND", "transaction sources are not visible in this organization and legal-entity scope");
    const entity = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id = ${orgId} and id = ${legalEntityId} for share`)).rows[0];
    if (!entity) throw new BenefitsError("NOT_FOUND", "transaction sources are not visible in this organization and legal-entity scope");
    const sourceFeature = DOC_KIND_FEATURE[query.documentKind];
    if (sourceFeature && !(await lockAndCheckOrgFeature(db, orgId, sourceFeature))) {
      throw new BenefitsError("REFUSED", `${sourceFeature} is off — enable the source capability in Company Settings → Features before measuring transactions`);
    }
    const knownItems = (await db.execute<{ id: string }>(sql`
      select id from items where org_id = ${orgId} and id = any(${`{${itemIds.join(",")}}`}::uuid[]) order by id for share
    `)).rows;
    if (knownItems.length !== itemIds.length) throw new BenefitsError("NOT_FOUND", "one or more selected items are not available in this organization — reselect the program items");

    let grouping: TransactionIncentiveSourceSnapshot["grouping"] = null;
    let groupExpression = sql`${legalEntityId}::text`;
    if (query.groupingSegmentId !== null) {
      const segmentId = nativeId(query.groupingSegmentId, "groupingSegmentId");
      const segment = (await db.execute<{ id: string; key: string; source_kind: string; storage_column: string | null; feature_key: string | null }>(sql`
        select id, key, source_kind, storage_column, feature_key from segment_definitions
         where org_id = ${orgId} and id = ${segmentId} for share
      `)).rows[0];
      if (!segment) throw new BenefitsError("NOT_FOUND", "the grouping dimension is not available in this organization — reselect the native dimension");
      const feature = segment.storage_column === "project_id" ? "projects" : segment.feature_key;
      if (feature && !(await lockAndCheckOrgFeature(db, orgId, feature))) {
        throw new BenefitsError("REFUSED", `${feature} is off — enable the grouping capability in Company Settings → Features; recorded dimensions are preserved`);
      }
      if (segment.source_kind === "custom" && segment.storage_column === null) {
        // JSON concatenation respects an explicit null line override; coalesce
        // would resurrect the header value and charge the wrong group.
        groupExpression = sql`(d.extra_dims || l.extra_dims)->>${segment.key}`;
      } else if (segment.source_kind === "builtin" && segment.storage_column && GROUP_COLUMNS[segment.storage_column]) {
        groupExpression = GROUP_COLUMNS[segment.storage_column]!;
      } else throw new BenefitsError("REFUSED", "the selected dimension has no supported native storage mapping — correct its definition before measuring");
      grouping = { id: segment.id, key: segment.key, sourceKind: segment.source_kind, storageColumn: segment.storage_column };
    }
    const rows = (await db.execute<TransactionIncentiveSourceLine & Record<string, unknown>>(sql`
      select l.id::text as "sourceId", d.id::text as "documentId", d.document_number as "documentNumber",
             d.revision_seq::text as "documentRevision", d.document_date::text as "documentDate", d.status,
             l.item_id::text as "itemId", l.amount::text as amount, l.quantity::text as quantity,
             d.currency, d.subsidiary_id::text as "legalEntityId", ${groupExpression} as "groupId"
        from documents d join document_lines l on l.org_id = d.org_id and l.document_id = d.id
       where d.org_id = ${orgId} and d.subsidiary_id = ${legalEntityId} and d.kind = ${query.documentKind}
         and l.id = any(${`{${lineIds.join(",")}}`}::uuid[])
       order by d.id, l.id for share of d, l
    `)).rows;
    if (rows.length !== lineIds.length) throw new BenefitsError("NOT_FOUND", "one or more transaction lines are missing or outside the selected organization, legal entity or document kind — reselect the source set");
    const requiredStatus = query.documentKind === "customer_invoice" ? "posted" : "approved";
    for (const row of rows) {
      if (row.status !== requiredStatus) throw new BenefitsError("REFUSED", `document ${row.documentNumber} is ${row.status} — select ${requiredStatus} sources; drafts, pending approvals and voided history never create fresh incentives`);
      if (!itemIds.includes(row.itemId)) throw new BenefitsError("REFUSED", `document ${row.documentNumber} includes a line outside the program's selected items — reconcile source selection before valuation`);
      if (row.currency !== query.currency) throw new BenefitsError("REFUSED", `document ${row.documentNumber} uses ${row.currency}, not ${query.currency} — select a program in that currency; transaction incentives never invent an exchange rate`);
      if (!isUuid(row.groupId)) throw new BenefitsError("REFUSED", `document ${row.documentNumber} line ${row.sourceId} has no valid ${grouping?.key ?? "company"} assignment — record the required dimension on the source before approving it, or select the appropriate reviewed source`);
    }
    if (grouping?.sourceKind === "custom") {
      const groupIds = [...new Set(rows.map((row) => row.groupId))];
      const values = (await db.execute<{ id: string }>(sql`
        select id from segment_values where org_id = ${orgId} and segment_id = ${grouping.id}
          and id = any(${`{${groupIds.join(",")}}`}::uuid[]) order by id for share
      `)).rows;
      // Inactive historical values still identify their recorded group. The
      // active editor registry is not a reason to erase old transaction facts.
      if (values.length !== groupIds.length) throw new BenefitsError("REFUSED", "a recorded grouping value belongs to another dimension or organization — reconcile the original source assignment before settlement");
    }
    const lines = [...rows].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
    const snapshot = { documentKind: query.documentKind, legalEntityId, currency: query.currency, selectedItemIds: itemIds, grouping, lines };
    return { ...snapshot, digest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
  });
}
