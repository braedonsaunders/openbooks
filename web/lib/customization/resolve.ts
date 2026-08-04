import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  defaultFormLayout,
  defaultListView,
  getRecordType,
  mergeRegisteredFieldsIntoLayout,
  type FormLayoutConfig,
  type HeaderFieldPlacement,
  type LineColumnPlacement,
  type ListViewConfig,
  type ListColumnPlacement,
  type RecordTypeKey,
  isCustomFieldKey,
  customFieldDefKey,
} from "@openbooks/customization";
import type { CustomFieldDef } from "../custom-fields";

/**
 * Effective-resolution layer for transaction form layouts + saved list views.
 *
 * Precedence (source platform "Preferred Form" + saved-search model):
 *   form layout: user's preferred form → org default → system default
 *   list view:    ?view=<id> → user's default → org default → system default
 *
 * Custom fields (custom_field_defs) are merged in at resolve time so a field
 * created after a layout was saved still appears: every active def for the
 * record type that the stored layout doesn't explicitly place is auto-appended
 * (visible, default label). Placements whose def no longer exists are kept but
 * the renderer skips them — so deactivating a custom field never breaks a form.
 */

export interface FormLayoutRow {
  id: string;
  name: string;
  recordType: string;
  isDefault: boolean;
  isActive: boolean;
  allowedRoles: string[] | null;
}

export interface ResolvedFormLayout {
  layout: FormLayoutConfig;
  source: "user" | "org" | "system";
  row: FormLayoutRow | null;
  /** All form layouts available to this user (for the "preferred form" picker). */
  available: FormLayoutRow[];
}

export interface ListViewRow {
  id: string;
  name: string;
  recordType: string;
  scope: "org" | "user";
  ownerId: string | null;
  isDefault: boolean;
  isActive: boolean;
}

export interface ResolvedListView {
  view: ListViewConfig;
  source: "explicit" | "user" | "org" | "system";
  row: ListViewRow | null;
  /** Saved views this user can pick from (org-shared + own personal). */
  available: ListViewRow[];
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Merge live custom field defs into a stored layout (auto-append unplaced). */
function mergeCustomFieldsIntoLayout(
  layout: FormLayoutConfig,
  headerDefs: CustomFieldDef[],
  lineDefs: CustomFieldDef[],
): FormLayoutConfig {
  mergeRegisteredFieldsIntoLayout(layout);
  // Header: ensure every active header def has a placement. Unplaced custom
  // fields land in a distinct trailing group (renders as a separate section,
  // matching the pre-customization layout); a saved layout that explicitly
  // places them is honoured as-is.
  const placedHeader = new Set<string>();
  for (const g of layout.header.groups)
    for (const f of g.fields) if (isCustomFieldKey(f.key)) placedHeader.add(f.key);
  const unplacedHeader = headerDefs.filter((d) => !placedHeader.has(`cf_${d.key}`));
  if (unplacedHeader.length > 0) {
    layout.header.groups.push({
      id: "custom",
      label: null,
      fields: unplacedHeader.map((def) => ({
        key: `cf_${def.key}`,
        visible: true,
        required: def.isRequired ? true : null,
        labelOverride: null,
        colSpan: null,
      })),
    });
  }
  // Drop header placements whose def is gone (rendered skipped either way, but
  // keep tidy so the designer reflects reality).
  const liveHeaderKeys = new Set(headerDefs.map((d) => `cf_${d.key}`));
  for (const g of layout.header.groups)
    g.fields = g.fields.filter((f) => !isCustomFieldKey(f.key) || liveHeaderKeys.has(f.key));

  // Lines: same treatment, but unplaced custom columns insert before `amount`
  // (preserving the pre-customization column order: …tax, [custom], amount, tax).
  const placedLine = new Set<string>();
  for (const c of layout.lines.columns) if (isCustomFieldKey(c.key)) placedLine.add(c.key);
  const unplacedLine = lineDefs.filter((d) => !placedLine.has(`cf_${d.key}`));
  if (unplacedLine.length > 0) {
    const customCols: LineColumnPlacement[] = unplacedLine.map((def) => ({
      key: `cf_${def.key}`,
      visible: true,
      width: null,
      labelOverride: null,
    }));
    const amountIdx = layout.lines.columns.findIndex((c) => c.key === "amount");
    if (amountIdx >= 0) layout.lines.columns.splice(amountIdx, 0, ...customCols);
    else layout.lines.columns.push(...customCols);
  }
  const liveLineKeys = new Set(lineDefs.map((d) => `cf_${d.key}`));
  layout.lines.columns = layout.lines.columns.filter(
    (c) => !isCustomFieldKey(c.key) || liveLineKeys.has(c.key),
  );

  return layout;
}

function rowIsAccessible(row: { allowedRoles: string[] | null }, userRoles: string[]): boolean {
  if (!row.allowedRoles || row.allowedRoles.length === 0) return true;
  return row.allowedRoles.some((r) => userRoles.includes(r));
}

/**
 * Resolve the effective transaction form layout for a user + record type.
 * Pass the live custom-field defs (header + line) so they merge in.
 */
export const resolveFormLayout = cache(
  async (args: {
    orgId: string;
    userId: string;
    recordType: RecordTypeKey;
    userRoles: string[];
    headerDefs: CustomFieldDef[];
    lineDefs: CustomFieldDef[];
    /** Explicit layout (?form=<id>) — e.g. the per-record "Custom Form" picker. */
    explicitLayoutId?: string | null;
  }): Promise<ResolvedFormLayout> => {
    const { orgId, userId, recordType, userRoles, headerDefs, lineDefs, explicitLayoutId } = args;

    const rows = (await db.execute(sql`
      select id, name, record_type as "recordType", is_default as "isDefault",
             is_active as "isActive", allowed_roles as "allowedRoles", layout
        from form_layouts
       where org_id = ${orgId} and record_type = ${recordType} and is_active
       order by is_default desc, name
    `)) as unknown as { rows: (FormLayoutRow & { layout: unknown })[] };

    const accessible = rows.rows.filter((r) => rowIsAccessible(r, userRoles) || userRoles.includes("admin"));
    const available = accessible.map(({ layout: _layout, ...r }) => r);

    // user preference
    const pref = (await db.execute(sql`
      select layout_id as "layoutId" from user_form_preferences
       where org_id = ${orgId} and user_id = ${userId} and record_type = ${recordType}
    `)) as unknown as { rows: { layoutId: string | null }[] };
    const prefId = pref.rows[0]?.layoutId;

    let chosen: (FormLayoutRow & { layout: unknown }) | undefined;
    // 0. explicit ?form=<id>
    if (explicitLayoutId && isUuid(explicitLayoutId)) {
      chosen = rows.rows.find((r) => r.id === explicitLayoutId);
      if (chosen && !accessible.includes(chosen)) chosen = undefined;
    }
    // 1. user preference
    if (!chosen && prefId && isUuid(prefId)) {
      chosen = rows.rows.find((r) => r.id === prefId);
      if (chosen && !accessible.includes(chosen)) chosen = undefined;
    }
    // 2. org default
    if (!chosen) chosen = rows.rows.find((r) => r.isDefault && accessible.includes(r));
    // 3. first accessible — never leave a user formless
    if (!chosen) chosen = accessible[0];

    if (!chosen) {
      const sys = defaultFormLayout(recordType);
      return {
        layout: mergeCustomFieldsIntoLayout(sys, headerDefs, lineDefs),
        source: "system",
        row: null,
        available,
      };
    }

    const layout = (chosen.layout ?? defaultFormLayout(recordType)) as FormLayoutConfig;
    const source: ResolvedFormLayout["source"] =
      explicitLayoutId && chosen.id === explicitLayoutId
        ? "user"
        : prefId === chosen.id
          ? "user"
          : chosen.isDefault
            ? "org"
            : "user";
    return {
      layout: mergeCustomFieldsIntoLayout(layout, headerDefs, lineDefs),
      source,
      row: { ...chosen, layout: undefined } as unknown as FormLayoutRow,
      available,
    };
  },
);

/** Merge live custom-field columns (showInList) into a stored list view. */
function mergeCustomFieldsIntoView(
  view: ListViewConfig,
  showInListDefs: CustomFieldDef[],
): ListViewConfig {
  const placed = new Set(view.columns.map((c) => c.key));
  const meta = getRecordType(view.recordType);
  for (const column of meta?.listColumns ?? []) {
    if (!placed.has(column.key)) {
      view.columns.push({
        key: column.key,
        visible: !column.defaultHidden,
        width: column.defaultWidth ?? null,
        labelOverride: null,
      });
      placed.add(column.key);
    }
  }
  for (const def of showInListDefs) {
    const cfKey = `cf_${def.key}`;
    if (!placed.has(cfKey)) {
      view.columns.push({ key: cfKey, visible: true, width: null, labelOverride: null });
    }
  }
  const live = new Set(showInListDefs.map((d) => `cf_${d.key}`));
  view.columns = view.columns.filter((c) => !isCustomFieldKey(c.key) || live.has(c.key));
  // Keep the actions column last — appended custom columns must not push past it.
  const actionsIdx = view.columns.findIndex((c) => c.key === "_actions");
  if (actionsIdx !== -1 && actionsIdx !== view.columns.length - 1) {
    const [actions] = view.columns.splice(actionsIdx, 1);
    view.columns.push(actions);
  }
  return view;
}

/**
 * Resolve the effective saved list view for a user + record type. Pass an
 * optional explicit `viewId` (from ?view=<id>) to load a specific view.
 */
export const resolveListView = cache(
  async (args: {
    orgId: string;
    userId: string;
    recordType: RecordTypeKey;
    viewId?: string | null;
    showInListDefs: CustomFieldDef[];
  }): Promise<ResolvedListView> => {
    const { orgId, userId, recordType, viewId, showInListDefs } = args;

    const rows = (await db.execute(sql`
      select id, name, record_type as "recordType", scope, owner_id as "ownerId",
             is_default as "isDefault", is_active as "isActive", config
        from list_views
       where org_id = ${orgId} and record_type = ${recordType} and is_active
         and (scope = 'org' or owner_id = ${userId})
       order by scope asc, is_default desc, name
    `)) as unknown as { rows: (ListViewRow & { config: unknown })[] };

    const available = rows.rows.map(({ config: _config, ...r }) => r);

    const byId = (id: string) => rows.rows.find((r) => r.id === id);

    // 1. explicit ?view=<id>
    let chosen: (ListViewRow & { config: unknown }) | undefined;
    if (viewId && isUuid(viewId)) chosen = byId(viewId);
    // 2. user default
    if (!chosen) {
      const pref = (await db.execute(sql`
        select view_id as "viewId" from user_list_preferences
         where org_id = ${orgId} and user_id = ${userId} and record_type = ${recordType}
      `)) as unknown as { rows: { viewId: string | null }[] };
      const pid = pref.rows[0]?.viewId;
      if (pid && isUuid(pid)) chosen = byId(pid);
    }
    // 3. org default
    if (!chosen) chosen = rows.rows.find((r) => r.scope === "org" && r.isDefault);
    // 4. first available
    if (!chosen) chosen = rows.rows[0];

    if (!chosen) {
      return {
        view: mergeCustomFieldsIntoView(defaultListView(recordType), showInListDefs),
        source: "system",
        row: null,
        available,
      };
    }

    const config = (chosen.config ?? defaultListView(recordType)) as ListViewConfig;
    const source: ResolvedListView["source"] =
      viewId && chosen.id === viewId ? "explicit" : chosen.scope === "user" ? "user" : "org";
    return {
      view: mergeCustomFieldsIntoView(config, showInListDefs),
      source,
      row: { ...chosen, config: undefined } as unknown as ListViewRow,
      available,
    };
  },
);

/** Translate a resolved header field's effective label (override or default i18n key). */
export function effectiveHeaderFieldLabel(
  placement: HeaderFieldPlacement,
  defLabel: string,
): string {
  return placement.labelOverride?.trim() ? placement.labelOverride.trim() : defLabel;
}

/** Translate a resolved line column's effective label. */
export function effectiveLineColumnLabel(
  placement: LineColumnPlacement | undefined,
  defLabel: string,
): string {
  return placement?.labelOverride?.trim() ? placement.labelOverride.trim() : defLabel;
}

/** Translate a resolved list column's effective label. */
export function effectiveListColumnLabel(
  placement: ListColumnPlacement | undefined,
  defLabel: string,
): string {
  return placement?.labelOverride?.trim() ? placement.labelOverride.trim() : defLabel;
}

export { customFieldDefKey, isCustomFieldKey };
