import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { documentRevisionSql } from "@openbooks/engine/records/revision";
import {
  loadCustomFieldAccessDefs,
  loadFieldDefs,
  redactHiddenCustomValues,
  visibleCustomFieldDefs,
  type CustomFieldDef,
  type CustomFieldViewer,
} from "../../../lib/custom-fields";
import { subsidiaryVisibleFilter } from "../../../lib/subsidiaries";

/**
 * Project payload for the flyout + cockpit header: the project row (with the
 * native contract value, resolved display
 * names for the linked customer / foreman / manager parties, and the WBS
 * tasks that make up the cost budget.
 */
export type ProjectTaskRow = {
  id: string;
  code: string | null;
  name: string;
  status: string;
  estimated_hours: string | null;
  estimated_cost: string | null;
  estimated_price: string | null;
  budget_quantity: string | null;
  budget_unit: string | null;
  updated_at: string;
};

/** Client-safe custom field definition (drops server-only bits). */
export interface ProjectCustomFieldDef {
  key: string;
  label: string;
  fieldType: CustomFieldDef["fieldType"];
  config: CustomFieldDef["config"];
  isRequired: boolean;
}

export interface ProjectPayload {
  project: Record<string, unknown>;
  contractValue: string | null;
  customerName: string | null;
  foremanName: string | null;
  managerName: string | null;
  tasks: ProjectTaskRow[];
  customFieldDefs: ProjectCustomFieldDef[];
}

/**
 * Load one project for the flyout / cockpit. The caller's subsidiary scope is
 * applied HERE, so a project outside it is a missing project for every
 * surface built on this loader — pages cannot forget to check. Unrestricted
 * callers (null) see the whole org.
 */
const UNATTRIBUTED_CUSTOM_FIELD_VIEWER: CustomFieldViewer = {
  roleKeys: [],
  canManageCustomFields: false,
};

/**
 * Project payload. The custom bag and the custom-field definitions are limited
 * to what the viewer may see; omitted viewer keeps only fields open to every role.
 */
export async function loadProject(
  id: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
  options: { customFieldViewer?: CustomFieldViewer } = {},
): Promise<ProjectPayload | null> {
  // One transaction for the whole bundle, locking the header first (READ
  // COMMITTED, like loadAsset): a concurrent project rehome blocks on the
  // lock instead of moving rows between the header read and the
  // task/customer reads of one response. Linked party names carry the party
  // lens (org-wide nulls stay visible); a linked party outside scope
  // resolves to no name rather than disclosing the row. (A REPEATABLE READ
  // snapshot cannot take the lock: a locking read that meets a concurrent
  // update errors with 40001 instead of waiting.)
  const [bundle, fieldDefs] = await Promise.all([
    withOrgTransaction(orgId, async () => {
      const proj = await db.execute<Record<string, unknown>>(
        sql`
        select * from projects where id = ${id} and org_id = ${orgId}
          ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)}
          for share
      `,
        "objects",
      );
      if (!proj[0]) return null;
      const row = proj[0];
      const partyName = (partyId: unknown) =>
        partyId
          ? db.execute<Record<string, unknown>>(sql`
              select display_name from parties
               where id = ${partyId} and org_id = ${orgId}
                 ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
               for share`)
          : Promise.resolve({ rows: [] as Record<string, unknown>[] });
      const customer = await partyName(row.customer_id);
      const foreman = await partyName(row.foreman_id);
      const manager = await partyName(row.manager_id);
      // updated_at doubles as the optimistic-concurrency token: project it
      // in the lossless six-digit revision form, never raw, so the editor
      // can echo it back as expectedUpdatedAt (a 3-digit ISO round-trip
      // fails the revision pattern and every edit 422s).
      const tasks = await db.execute<ProjectTaskRow>(sql`
        select id, code, name, status, estimated_hours, estimated_cost, estimated_price, budget_quantity, budget_unit, ${documentRevisionSql(sql`updated_at`)} as updated_at
          from project_tasks
         where project_id = ${id} and org_id = ${orgId}
         order by code nulls last, name
      `);
      return { row, customer, foreman, manager, tasks };
    }),
    loadFieldDefs("projects"),
  ]);
  if (!bundle) return null;
  const { row, customer, foreman, manager, tasks } = bundle;

  const name = (r?: Record<string, unknown>) => (r ? ((r.display_name as string) ?? null) : null);
  const contractValue = row.contract_value == null ? null : String(row.contract_value);

  const viewer = options.customFieldViewer ?? UNATTRIBUTED_CUSTOM_FIELD_VIEWER;
  const accessDefs = await loadCustomFieldAccessDefs("projects");
  return {
    project: {
      ...row,
      custom: redactHiddenCustomValues(
        accessDefs,
        viewer,
        row.custom as Record<string, unknown> | null,
      ),
    },
    contractValue,
    customerName: name(customer.rows[0]),
    foremanName: name(foreman.rows[0]),
    managerName: name(manager.rows[0]),
    tasks: tasks.rows,
    customFieldDefs: visibleCustomFieldDefs(fieldDefs, viewer).map((d) => ({
      key: d.key,
      label: d.label,
      fieldType: d.fieldType,
      config: d.config,
      isRequired: d.isRequired,
    })),
  };
}
