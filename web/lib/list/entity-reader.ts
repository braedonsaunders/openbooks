import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { isUuid } from "@openbooks/engine/src/platform/uuid.ts";
import {
  defaultListView,
  getRecordType,
  isCustomFieldKey,
  listColumnMeta,
  parseListView,
  recordTypeFeatureKey,
  recordTypeForFeatureState,
  type FilterClause,
  type ListViewConfig,
} from "@openbooks/customization";
import { can, resolveAuthzByUserId, type Authz } from "../authz-core";
import { loadFieldDefs } from "../custom-fields.ts";
import { isFeatureEnabled } from "../features.ts";
import { clamp } from "../list-params.ts";
import { columnDescriptors } from "../customization/list-query.ts";
import {
  customerBaseJoins,
  customerBuiltInExpr,
  customerSorts,
  employeeBaseJoins,
  employeeBuiltInExpr,
  employeeSorts,
  type EntityAdhoc,
} from "../customization/entity-list-query.ts";
import { entityListSource, entityOrderClause, plannedPageClauses } from "./entity-sources.ts";
import { readExportWindow, type ExportPage } from '../data-io/export-page';

/**
 * The single bounded server reader for entity lists. `EntityListView` and
 * future assistant list tools consume this function instead of composing
 * their own row queries: the registry (`entity-sources.ts`) stays the only
 * place that defines which table, joins, columns, sorts, and predicates a
 * record type has. Two wrappers, one executor:
 *
 * - `readEntityListPage` (safe): re-resolves the actor, compares scope,
 *   derives visibility internally. No raw SQL, table, alias, or column
 *   identifier is accepted from the caller.
 * - `readResolvedEntityListPageForView` (trusted, UI-only): EntityListView
 *   passes its already-resolved view, visibility triple, trusted narrowing
 *   predicate, and the accepted quick-filter sets it loaded once for
 *   rendering. Never imported by tool code.
 */

export type EntityReaderScope = ReadonlySet<string> | null;

/** Safe input: the actor is re-resolved; capabilities are derived, never passed. */
export type RegisteredEntityListQuery = {
  /** Worker keyset scan; totals are not computed and totalKnown is false. */
  cursor?: { afterId: string | null };
  recordType: string;
  orgId: string;
  actorId: string;
  /** Required own property. Explicit null is unrestricted; an empty set reads nothing. */
  allowedSubsidiaryIds: EntityReaderScope;
  filters?: readonly FilterClause[];
  q?: string;
  showInactive?: boolean;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  perPage?: number;
};

/** Effective registry shaping, minted only inside this module or passed exact by the trusted caller. */
export type ResolvedListFeatures = {
  readonly inventory: boolean;
  readonly crm: boolean;
  readonly hrm: boolean;
};

export type EntityReaderRow = Record<string, unknown>;

export type EntityReaderSuccess = {
  ok: true;
  rows: EntityReaderRow[];
  /** Count under the identical WHERE as the page SELECT (never the id-restricted page). */
  filteredTotal: number;
  totalKnown?: boolean;
  cursorHasMore?: boolean;
  page: number;
  perPage: number;
  sort: string;
  dir: "asc" | "desc";
};

export type EntityReaderRefusal = {
  ok: false;
  /** Stable code the caller branches on. */
  error: string;
  /** Usable remedy shown to the operator alongside the code. */
  remedy: string;
  field?: string;
};

export type EntityReaderResult = EntityReaderSuccess | EntityReaderRefusal;

const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100;
const MIN_PER_PAGE = 5;
const MAX_PAGE = 10_000;

/**
 * Source-pinned trusted wrapper: only EntityListView imports this, passing
 * the view it resolved, the visibility triple it computed, and the accepted
 * quick-filter sets it already loaded once for rendering. Every other
 * caller — assistant tools, data-io resources, NP-13 tools — uses the safe
 * `readEntityListPage` and never touches the executor.
 */
export async function readResolvedEntityListPageForView(
  input: ExecutorInput,
  features: ResolvedListFeatures,
  scopePredicate?: SQL,
  acceptedFilters?: ReadonlyMap<string, readonly string[]>,
): Promise<EntityReaderResult> {
  return executeEntityListPage(
    acceptedFilters === undefined ? input : { ...input, acceptedFilters },
    features,
    scopePredicate,
  );
}

const SAFE_QUERY_KEYS = new Set(["cursor",
  "recordType", "orgId", "actorId", "allowedSubsidiaryIds", "filters",
  "q", "showInactive", "sort", "dir", "page", "perPage",
]);

function refuse(error: string, remedy: string, field?: string): EntityReaderRefusal {
  return field === undefined ? { ok: false, error, remedy } : { ok: false, error, remedy, field };
}

function sameScope(left: EntityReaderScope, right: EntityReaderScope): boolean {
  if (left === null || right === null) return left === null && right === null;
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/**
 * Safe wrapper: every authority is re-resolved from orgId+actorId. A caller
 * scope that no longer matches the actor's live grants is stale and refused;
 * execution always uses the re-resolved scope, so a tool cannot widen its
 * caller. Visibility (inventory/CRM/HRM) is derived from the feature reader
 * plus the resolved grants — no caller-authored capability booleans exist on
 * this input.
 */
export async function readEntityListPage(query: RegisteredEntityListQuery): Promise<EntityReaderResult> {
  if (!query || !Object.hasOwn(query, "allowedSubsidiaryIds") || query.allowedSubsidiaryIds === undefined) {
    return refuse(
      "missing_scope",
      "pass allowedSubsidiaryIds explicitly with every call; use null only when the caller is unrestricted",
      "allowedSubsidiaryIds",
    );
  }
  for (const key of Object.keys(query)) {
    if (!SAFE_QUERY_KEYS.has(key)) {
      return refuse(
        "unknown_property",
        `unknown query property "${key}"; pass only registered filters, sort, and page fields`,
        key,
      );
    }
  }
  if (query.allowedSubsidiaryIds !== null && !(query.allowedSubsidiaryIds instanceof Set)) {
    return refuse(
      "invalid_scope",
      "pass allowedSubsidiaryIds as a Set of subsidiary ids or null, never an array or object",
      "allowedSubsidiaryIds",
    );
  }
  if (query.cursor && (typeof query.cursor !== 'object' || !Object.hasOwn(query.cursor, 'afterId') || (query.cursor.afterId !== null && !isUuid(query.cursor.afterId)))) {
    return refuse('invalid_cursor', 'pass a null starting cursor or the UUID of the last returned row', 'cursor');
  }
  const authz = await resolveAuthzByUserId(query.orgId, query.actorId);
  if (!authz) {
    return refuse(
      "actor_unresolvable",
      "sign in with an active organization member; deactivated users and unknown ids read nothing",
      "actorId",
    );
  }
  if (!sameScope(query.allowedSubsidiaryIds, authz.allowedSubsidiaryIds)) {
    return refuse(
      "stale_scope",
      "re-resolve the caller's subsidiaries and retry; never reuse a cached scope across grant changes",
      "allowedSubsidiaryIds",
    );
  }
  // Feature state is authoritative only when it resolves: a resolved false
  // refuses by name in the executor, while an outage rejects this read — the
  // throw propagates instead of refusing as disabled, so nothing is ever
  // assumed enabled.
  const [inventory, crmFeature, hrmFeature] = await Promise.all([
    isFeatureEnabled(query.orgId, "inventory"),
    query.recordType === "customer" ? isFeatureEnabled(query.orgId, "crm") : Promise.resolve(true),
    query.recordType === "employee" ? isFeatureEnabled(query.orgId, "hrm") : Promise.resolve(true),
  ]);
  const features: ResolvedListFeatures = {
    inventory,
    crm: query.recordType === "customer" ? crmFeature && can(authz, "crm.accounts.read") : crmFeature,
    hrm: query.recordType === "employee" ? hrmFeature && can(authz, "hrm.employment.read") : hrmFeature,
  };
  let view: ListViewConfig;
  try {
    const defaults = defaultListView(query.recordType);
    view = { ...defaults, filters: [...defaults.filters, ...(query.filters ?? [])] };
  } catch {
    return refuse(
      "unknown_record_type",
      `no entity list source is registered for "${query.recordType}"; list a registered record type`,
      "recordType",
    );
  }
  return executeEntityListPage(
    {
      recordType: query.recordType,
      orgId: query.orgId,
      actorId: query.actorId,
      authz,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      view,
      adhoc: { q: query.q, filters: {}, showInactive: query.showInactive },
      sort: query.sort ?? null,
      dir: query.dir ?? null,
      cursor: query.cursor,
      page: query.page,
      perPage: query.perPage,
    },
    features,
  );
}

type ExecutorInput = {
  cursor?: { afterId: string | null };
  recordType: string;
  orgId: string;
  /** Present on the safe path (re-resolved grants checked); absent on the trusted UI path (its page owns the permission). */
  actorId?: string;
  /** The safe wrapper's re-resolved snapshot, bound to this execution so Authz resolves exactly once per safe read. */
  authz?: Authz;
  /** Live set only: the safe wrapper passes the re-resolved scope, the trusted caller its server-resolved one. */
  allowedSubsidiaryIds: Set<string> | null;
  view: ListViewConfig;
  adhoc?: { q?: string; filters?: Record<string, string | undefined>; showInactive?: boolean };
  sort?: string | null;
  dir?: "asc" | "desc" | null;
  page?: number;
  perPage?: number;
  labels?: Record<string, string>;
  /**
   * Accepted quick-filter values the trusted caller already loaded once.
   * The safe path passes none and each loader runs at most once per read.
   */
  acceptedFilters?: ReadonlyMap<string, readonly string[]>;
};

/**
 * Trusted executor: the single compiler/execution path. The server-rendered
 * list passes its already-resolved view, visibility triple, and trusted
 * narrowing predicate. Saved views go through the same `parseListView`
 * authority as constructed ones; only two bounded membership checks live
 * here because no current authority covers them (active custom-field defs,
 * registered quick-filter keys).
 */
async function executeEntityListPage(
  input: ExecutorInput,
  features: ResolvedListFeatures,
  scopePredicate?: SQL,
): Promise<EntityReaderResult> {
  const source = entityListSource(input.recordType);
  const meta = getRecordType(input.recordType);
  if (!source || !meta) {
    return refuse(
      "unknown_record_type",
      `no entity list source is registered for "${input.recordType}"; list a registered record type`,
      "recordType",
    );
  }
  // The source's canonical read grant is checked before any compiler work
  // and fails closed: a source with no registered grant refuses instead of
  // compiling. The safe wrapper always threads the actor through, so an
  // actor without the grant compiles nothing; the trusted UI path arrives
  // with an already-authorized caller (its page owns the permission) and the
  // source-pinned wrapper is the only other entry to this executor.
  if (input.actorId !== undefined) {
    if (!source.readPermission) {
      return refuse(
        "entity_list_read_permission_unregistered",
        `no canonical read grant is registered for "${input.recordType}"; register one before listing`,
        "recordType",
      );
    }
    // The safe wrapper binds its re-resolved snapshot, so Authz resolves
    // exactly once per safe read; only a caller that bypassed the wrapper
    // re-resolves here, and the page-owned trusted path never resolves.
    const grantAuthz = input.authz ?? (await resolveAuthzByUserId(input.orgId, input.actorId));
    if (!grantAuthz || !can(grantAuthz, source.readPermission)) {
      return refuse(
        "forbidden",
        `this list requires the ${source.readPermission} grant`,
      );
    }
  }
  // The record type's Features switch refuses by name before compiling: a
  // list whose module is off reads nothing, exactly like its page.
  const featureKey = recordTypeFeatureKey(input.recordType);
  if (featureKey && !(await isFeatureEnabled(input.orgId, featureKey))) {
    return refuse(
      "feature_disabled",
      `turn on ${featureKey} on Company Settings → Features to list ${input.recordType} records`,
      "recordType",
    );
  }
  if (input.view.recordType !== input.recordType) {
    return refuse(
      "view_record_type_mismatch",
      `the view belongs to "${input.view.recordType}" but the list reads "${input.recordType}"; resolve the view for the listed record type`,
      "view",
    );
  }
  const parsed = parseListView(input.view);
  if (!parsed.success) {
    const first = parsed.issues[0]!;
    return refuse("invalid_view", `${first.path}: ${first.message}`, "view");
  }
  const view = parsed.data;
  // Bounded check one: every cf_* column/filter names an active authoritative
  // field definition. `lintListView` proves syntax/operator/value but not that
  // the key still names a live definition — a stale key refuses here instead
  // of silently disappearing from the query.
  if (source.customFieldTable) {
    const defs = await loadFieldDefs(source.customFieldTable, source.customFieldKind);
    const known = new Set(defs.map((def) => def.key));
    const cfKeys = [
      ...view.columns.filter((c) => isCustomFieldKey(c.key)).map((c) => c.key),
      ...view.filters.filter((f) => isCustomFieldKey(f.key)).map((f) => f.key),
    ];
    for (const key of cfKeys) {
      const defKey = key.startsWith("cf_") ? key.slice(3) : key;
      if (!known.has(defKey) && !known.has(key)) {
        return refuse(
          "invalid_view",
          `custom field "${key}" has no active definition; define it in Customization or remove the clause`,
          "view",
        );
      }
    }
  } else {
    const stray = [
      ...view.columns.filter((c) => isCustomFieldKey(c.key)).map((c) => c.key),
      ...view.filters.filter((f) => isCustomFieldKey(f.key)).map((f) => f.key),
    ][0];
    if (stray) {
      return refuse(
        "invalid_view",
        `custom field "${stray}" is not backed by this list; remove the clause`,
        "view",
      );
    }
  }
  const effectiveMeta = recordTypeForFeatureState(meta, {
    inventory: features.inventory,
    crm: features.crm,
    hrm: features.hrm,
  });
  const allowedSorts = effectiveMeta.listColumns
    .filter((c) => c.sortable && c.sortKey)
    .map((c) => c.sortKey!);
  // An explicit unknown sort refuses; the UI's URL fallback runs before the
  // trusted wrapper, so this refusal is unreachable from parsed list params.
  if (input.sort !== undefined && input.sort !== null && !allowedSorts.includes(input.sort)) {
    return refuse(
      "unknown_sort",
      `"${input.sort}" is not a sortable column for ${input.recordType}; choose a sortable column from the list view`,
      "sort",
    );
  }
  if (input.dir !== undefined && input.dir !== null && input.dir !== "asc" && input.dir !== "desc") {
    return refuse("invalid_dir", `direction must be "asc" or "desc"`, "dir");
  }
  const viewSortKey = view.sort ? listColumnMeta(input.recordType, view.sort.column)?.sortKey : undefined;
  const viewSort = viewSortKey && allowedSorts.includes(viewSortKey) && view.sort
    ? { sortKey: viewSortKey, dir: view.sort.dir }
    : undefined;
  const metaDefault = effectiveMeta.defaultSort && allowedSorts.includes(effectiveMeta.defaultSort.sortKey)
    ? effectiveMeta.defaultSort
    : undefined;
  const sort = input.sort ?? viewSort?.sortKey ?? metaDefault?.sortKey ?? allowedSorts[0] ?? "name";
  const dir = input.dir ?? viewSort?.dir ?? metaDefault?.dir ?? "asc";
  if (input.page !== undefined && !Number.isInteger(input.page)) {
    return refuse("invalid_page", "page must be a whole number starting at 1", "page");
  }
  if (input.perPage !== undefined && !Number.isInteger(input.perPage)) {
    return refuse("invalid_per_page", "perPage must be a whole number", "perPage");
  }
  const page = clamp(input.page ?? 1, 1, MAX_PAGE);
  const perPage = clamp(input.perPage ?? DEFAULT_PER_PAGE, MIN_PER_PAGE, MAX_PER_PAGE);
  const adhocFilters = input.adhoc?.filters ?? {};
  // Bounded check two: every ad-hoc quick-filter key is one of the source's
  // registered quickFilters. Values for entity_ref filters must be
  // well-formed UUIDs (shared `isUuid`); malformed values refuse instead of
  // silently matching nothing. Well-formed but foreign ids match nothing.
  const quickKeys = new Set(source.quickFilters.map((quick) => quick.filterKey));
  const filterMetaByKey = new Map(effectiveMeta.listFilters.map((filter) => [filter.key, filter]));
  const filterKindByKey = new Map([...filterMetaByKey].map(([key, filter]) => [key, filter.kind]));
  // One quick-option authority per path, memoized per read: the trusted UI
  // caller seeds this with the accepted sets it already loaded once, while
  // the safe path seeds nothing and each tenant loader runs at most once.
  const acceptedCache = new Map<string, readonly string[]>();
  if (input.acceptedFilters) {
    for (const [key, values] of input.acceptedFilters) acceptedCache.set(key, values);
  }
  for (const [key, value] of Object.entries(adhocFilters)) {
    if (value === undefined) continue;
    if (!quickKeys.has(key)) {
      return refuse(
        "unknown_filter",
        `unknown filter "${key}" for ${input.recordType}; use one of: ${[...quickKeys].join(", ") || "none"}`,
        "filters",
      );
    }
    // Values are checked against the exact accepted set the native filter
    // renders: an explicitly passed set wins (the UI loaded it once), then
    // registry statics, then the tenant loader the picker uses. Keys with
    // none of the three accept the value untouched, as today.
    const statics = filterMetaByKey.get(key)?.options?.map((option) => option.value) ?? [];
    const loader = source.quickFilters.find((quick) => quick.filterKey === key)?.loadOptions;
    let accepted = acceptedCache.get(key);
    let backed = statics.length > 0 || loader !== undefined;
    if (accepted === undefined) {
      accepted = statics.length > 0
        ? statics
        : loader
          ? (await loader(input.orgId, input.allowedSubsidiaryIds)).map((option) => option.value)
          : [];
      acceptedCache.set(key, accepted);
    } else {
      backed = true;
    }
    // A backed key refuses every supplied value its accepted set does not
    // name — including an empty accepted set, which still reads nothing
    // instead of silently matching everything.
    if (backed && !accepted.includes(value)) {
      return refuse(
        "invalid_filter_value",
        statics.length > 0
          ? `filter "${key}" accepts: ${statics.join(", ")}`
          : `filter "${key}" accepts one of the listed options; reload the list view to see them`,
        "filters",
      );
    }
    if (filterKindByKey.get(key) === "entity_ref") {
      const members = Array.isArray(value) ? value : [value];
      for (const member of members) {
        if (!isUuid(member)) {
          return refuse(
            "invalid_filter_value",
            `filter "${key}" must be a UUID; "${member}" is not a well-formed id`,
            "filters",
          );
        }
      }
    }
  }
  // Entity_ref members inside saved/constructed view filters get the same
  // shared-UUID gate; the predicate layer stays fail-closed regardless.
  for (const clause of view.filters) {
    const kind = filterKindByKey.get(clause.key);
    if (kind !== "entity_ref" || clause.value === undefined || clause.value === null) continue;
    const members = Array.isArray(clause.value) ? clause.value : [clause.value];
    for (const member of members) {
      if (!isUuid(String(member))) {
        return refuse(
          "invalid_filter_value",
          `filter "${clause.key}" must be a UUID; "${String(member)}" is not a well-formed id`,
          "filters",
        );
      }
    }
  }
  const labels = input.labels ?? {};
  const headerDefs = source.customFieldTable
    ? (await loadFieldDefs(source.customFieldTable, source.customFieldKind)).filter((d) => d.config.showInList)
    : [];
  const builtInExpr = input.recordType === "customer"
    ? customerBuiltInExpr(features.crm)
    : input.recordType === "employee"
      ? employeeBuiltInExpr(features.hrm)
      : source.builtInExpr;
  const sorts = input.recordType === "customer"
    ? customerSorts(features.crm)
    : input.recordType === "employee"
      ? employeeSorts(features.hrm)
      : source.sorts;
  const cols = columnDescriptors(
    input.recordType, view, headerDefs, builtInExpr, labels, source.customFieldAlias ?? source.alias,
  );
  const selectCols = sql.join(
    cols.filter((c) => c.expr).map((c) => sql`${c.expr} as ${sql.raw(`"${c.key}"`)}`),
    sql`, `,
  );
  const today = await businessToday(input.orgId);
  const adhoc: EntityAdhoc = {
    q: input.adhoc?.q,
    filters: adhocFilters,
    showInactive: input.adhoc?.showInactive,
    crmEnabled: input.recordType === "customer" ? features.crm : undefined,
    hrmEnabled: input.recordType === "employee" ? features.hrm : undefined,
  };
  const narrow = (predicate: SQL) => scopePredicate ? sql`(${predicate}) and (${scopePredicate})` : predicate;
  const where = narrow(source.where(view, adhoc, input.orgId, input.allowedSubsidiaryIds));
  const orderExpr = sorts[sort] ?? source.defaultSort;
  const aliasSql = sql.raw(source.alias);
  const idExpr = source.idExpr ?? sql`${aliasSql}.id`;
  const tableSql = typeof source.table === "function"
    ? sql`${source.table(input.orgId)} ${sql.raw(source.alias)}`
    : sql.raw(`${source.table} ${source.alias}`);
  const baseJoins = input.recordType === "customer"
    ? customerBaseJoins(features.crm)
    : input.recordType === "employee"
      ? employeeBaseJoins(features.hrm, today, input.allowedSubsidiaryIds)
      : (typeof source.baseJoins === "function" ? source.baseJoins(input.allowedSubsidiaryIds, today) : source.baseJoins);
  const countJoinsSource = source.countJoins ?? source.baseJoins;
  const countJoins = input.recordType === "customer"
    ? customerBaseJoins(features.crm)
    : input.recordType === "employee"
      ? employeeBaseJoins(features.hrm, today, input.allowedSubsidiaryIds)
      : (typeof countJoinsSource === "function" ? countJoinsSource(input.allowedSubsidiaryIds, today) : countJoinsSource);
  const plannedIds = !input.cursor && source.orderedPageIds
    ? await source.orderedPageIds({ orgId: input.orgId, sort, dir, tableSql, baseJoins, where })
    : null;
  const planned = plannedIds ? plannedPageClauses(plannedIds, idExpr) : null;
  const pageWhere = input.cursor?.afterId ? sql`(${where}) and ${idExpr}>${input.cursor.afterId}::uuid` : planned ? planned.where : where;
  const pageOrder = input.cursor ? sql`${idExpr} asc` : planned ? planned.order : entityOrderClause(source, orderExpr, dir);
  const earlyPage = !input.cursor && source.pageBeforeJoins?.sorts.includes(sort) && !planned;
  const select = sql`${idExpr} as id${source.extraSelect ? sql`, ${source.extraSelect}` : sql``}, ${selectCols}`;
  // Header sorts need only the visibility/filter joins. Hydrate aggregates
  // after the bounded page; aggregate sorts retain their global SQL order.
  const rowQuery = earlyPage
    ? sql`with list_page as materialized (
        select ${idExpr} as id from ${tableSql} ${countJoins}
         where ${where} order by ${pageOrder}
         limit ${perPage} offset ${input.cursor ? 0 : (page - 1) * perPage}
      )
      select ${select} from ${sql.raw(`${source.pageBeforeJoins!.table} ${source.alias}`)}
        join list_page on list_page.id = ${idExpr} ${baseJoins}
       where ${where} order by ${pageOrder}`
    : sql`select ${select} from ${tableSql} ${baseJoins}
       where ${pageWhere} order by ${pageOrder}
       limit ${perPage} offset ${input.cursor ? 0 : (page - 1) * perPage}`;
  const exportPage: ExportPage | undefined = input.cursor ? { size: perPage, after: input.cursor.afterId, next: null, done: false } : undefined;
  const [rowsRes, totalRow] = await Promise.all([
    readExportWindow(db, rowQuery, exportPage ? { page: exportPage, allowedSubsidiaryIds: input.allowedSubsidiaryIds, actorId: input.actorId } : undefined, 'id'),
    input.cursor ? Promise.resolve({ rows: [{ n: "0" }] }) : db.execute<{ n: string }>(sql`
      select count(*) as n from ${tableSql}
        ${countJoins}
       where ${where}`),
  ]);
  const rows = rowsRes.rows as EntityReaderRow[];
  // Server-computed display values run only on returned page rows; SQL serves
  // the total, so enrichment never widens the read.
  if (source.enrichRows) await source.enrichRows(input.orgId, rows);
  return {
    ok: true,
    rows,
    filteredTotal: Number(totalRow.rows[0]?.n ?? 0),
    totalKnown: !input.cursor,
    ...(exportPage ? { cursorHasMore: !!exportPage.truncated || rows.length === perPage } : {}),
    page,
    perPage,
    sort,
    dir,
  };
}
