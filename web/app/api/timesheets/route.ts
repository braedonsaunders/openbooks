import { authorizeTimeWorkspace, refuseOthersTime, timeWorkFamily } from "@/lib/time-workspace";
import { lockSharedTimeAuthority, TimeWorkTargetError } from "@openbooks/engine/src/projects/time-work-target.ts";
import { z } from "zod";
import { isoDate, uuidId } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { notFound, unprocessable } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import {
  lockScopeRow,
  lockScopeRows,
  ScopeNotFoundError,
} from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import {
  checkProjectsWriteEnabled,
  isFeatureEnabled,
} from "../../../lib/features";
import { isUuid } from "../../../lib/list-params";
import { can } from "../../../lib/authz";
import {
  findUnownedCustomReferences,
  loadFieldDefs,
  validateCustomValues,
} from "../../../lib/custom-fields";
import { initialEntryStatus, loadTimePolicy } from "../../../lib/time-policy";
import { runTimeApprovalEffects } from "../../../lib/time-approval";
import { TimeApprovalRefusal } from "../../../lib/time-approval-refusal";
import { apiErrorResponse } from "@/lib/api/error-response";
import { canonicalDecimal, compareDecimal } from "../../../lib/exact-decimal";
import { canonicalJson } from "@openbooks/engine/src/platform/canonical-json.ts";
import { lockTimeWorkOrderTarget } from "@openbooks/engine/src/projects/time-work-target.ts";
import {
  isIsoDate,
  loadWeek,
  pinTimekeeper,
  pinTimesheetLineRefs,
  weekStart,
  weekWindow,
} from "./_lib";
const saveBodySchema = z.strictObject({
  employee: uuidId,
  week: isoDate("week must be a valid calendar date"),
  rows: z.array(z.strictObject({
    projectId: uuidId.nullable().optional(),
    workOrderId: uuidId.nullable().optional(),
    woOperationId: uuidId.nullable().optional(),
    itemId: uuidId.nullable().optional(),
    timeTypeId: uuidId.nullable().optional(),
    departmentId: uuidId.nullable().optional(),
    isBillable: z.boolean().optional(),
    memo: z.string().max(2000).nullable().optional(),
    hours: z.array(z.union([z.string(), z.number().finite(), z.null()])).length(7),
    custom: z.record(z.string().min(1), z.json()).default({}),
  })).max(1000),
  expectedRevision: z.string().min(1, "expectedRevision is required"),
});

export const runtime = "nodejs";

const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 });
}

/** The named refusal for a save over a moved week. The caller reloads and
 *  re-enters; nothing was saved or overwritten. */
const STALE_WEEK_ERROR =
  "This week changed since you opened it — another editor saved first. " +
  "Reload the week and re-enter your hours; nothing was saved or overwritten.";

class TimeLineEntityRefusal extends Error {}

interface SaveRow {
  projectId?: string | null;
  workOrderId?: string | null;
  woOperationId?: string | null;
  itemId?: string | null;
  timeTypeId?: string | null;
  departmentId?: string | null;
  isBillable?: boolean;
  memo?: string | null;
  hours?: (string | number | null)[];
  custom?: Record<string, unknown>;
}
interface SaveBody {
  employee: string;
  week: string;
  rows: SaveRow[];
  /**
   * The revision the client loaded (loadWeek returns it). When present and
   * stale, the save is refused with a named 409 instead of silently
   * overwriting another editor's hours. The grid sends it on every save;
   * requests without one are refused at the body boundary.
   */
  expectedRevision: string;
}

function uuidOrNull(v: unknown): string | null | "invalid" {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !isUuid(v)) return "invalid";
  return v;
}

/** Parse an hours cell → non-negative money string, or null (blank/zero). */
function hoursOrNull(v: unknown): string | null | "invalid" {
  if (v == null || v === "") return null;
  const exact = canonicalDecimal(v, 4);
  if (exact === null) return "invalid";
  let hours: string;
  try {
    hours = normalizeMoney(exact);
  } catch {
    return "invalid";
  }
  if (compareDecimal(hours, "0") < 0) return "invalid";
  if (compareDecimal(hours, "0") === 0) return null;
  // time_entries.hours is numeric(19,4): fifteen whole digits. The format
  // check admits any magnitude, so a pasted 20-digit cell died in Postgres
  // with a storage error. Fail closed with the same named refusal.
  if (hours.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15)
    return "invalid";
  return hours;
}

/** GET ?employee=&week= → the week's grid rows + status. */
export const GET = defineRoute({
  authorize: authorizeTimeWorkspace("time.read"),
  feature: { none: "The explicit workspace pins Time Tracking or Manufacturing; native commands fence every actual target." },
  handler: async ({ request, authz }) => {
    const orgId = authz.user.orgId;

    const url = new URL(request.url);
    const employee = url.searchParams.get("employee");
    const weekParam = url.searchParams.get("week");
    if (!employee || !isUuid(employee))
      return unprocessable("Invalid employee");
    if (!weekParam || !isIsoDate(weekParam))
      return unprocessable("Invalid week");

    const ownedEmployee = await pinTimekeeper(
      orgId,
      employee,
      authz.allowedSubsidiaryIds,
    );
    if (!ownedEmployee) return unprocessable("Employee not found");
    // A self-service caller reads only their own week.
    const othersRefused = await refuseOthersTime(authz, "time.read", ownedEmployee);
    if (othersRefused) return othersRefused;
    try {
      return await withOrgTransaction(orgId, async () => {
        const days = weekWindow(weekStart(weekParam));
        await lockSharedTimeAuthority(db, orgId, authz.user.id, { employeeId: ownedEmployee, from: days[0]!, through: days[6]!, requestedScope: authz.allowedSubsidiaryIds, permission: "time.read", workFamily: timeWorkFamily(request) });
        await lockScopeRow(
          db,
          orgId,
          "party",
          ownedEmployee,
          authz.allowedSubsidiaryIds,
          "share",
        );
        const payload = await loadWeek(
          orgId,
          ownedEmployee,
          weekStart(weekParam),
          authz.allowedSubsidiaryIds,
        );
        return NextResponse.json(payload);
      });
    } catch (error) {
      if (error instanceof ScopeNotFoundError)
        return notFound("timesheet week");
      throw error;
    }
  },
});

/**
 * Save the week: replace this employee+week's editable time_entries from the
 * submitted grid. For each grid row × day with hours > 0 we upsert one entry;
 * entries in the week no longer represented are deleted. Only draft/rejected
 * entries are ever touched — approved and submitted entries are left intact so
 * a save never silently overwrites an approval (or an in-flight submission).
 */
const save = defineRoute({
  authorize: authorizeTimeWorkspace("time.manage"),
  feature: { none: "The explicit workspace pins Time Tracking or Manufacturing; native commands fence every actual target." },
  body: saveBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ request: workspaceRequest, authz: gate, body: requestBody }) => {
    const { user } = gate;
    const orgId = user.orgId;

    const body = requestBody as SaveBody;
    const employee = uuidOrNull(body.employee);
    if (employee === "invalid" || employee === null)
      return bad("Invalid employee");
    if (!body.week || !isIsoDate(body.week)) return bad("Invalid week");
    const week = weekStart(body.week);
    const days = weekWindow(week);
    if (!Array.isArray(body.rows)) return bad("Rows must be a list");

    const ownedEmployee = await pinTimekeeper(
      orgId,
      employee,
      gate.allowedSubsidiaryIds,
    );
    if (!ownedEmployee) return bad("Employee not found");
    // A self-service caller enters only their own week; refused before any
    // of the named employee's entries are read.
    const othersRefused = await refuseOthersTime(gate, "time.manage", ownedEmployee);
    if (othersRefused) return othersRefused;
    // The grant production targets are fenced with: the supervisory grant,
    // or time.self for a caller entering their own week.
    const timeEntryPermission = can(gate, "time.manage") ? "time.manage" : "time.self";

    // Normalize each grid row × day into a flat list of entries to persist.
    interface Persist {
      workedOn: string;
      hours: string;
      projectId: string | null;
      workOrderId: string | null;
      woOperationId: string | null;
      itemId: string | null;
      timeTypeId: string | null;
      departmentId: string | null;
      isBillable: boolean;
      memo: string | null;
      custom: Record<string, unknown>;
    }
    // Org-defined line fields live on time_entries.custom; validate + strip
    // unknown keys exactly as every other record does.
    const lineDefs = await loadFieldDefs("time_entries");
    // When the org does not require approval, saved hours are usable at once
    // rather than sitting in a draft nobody will ever submit.
    const policy = await loadTimePolicy(orgId);
    const newStatus = initialEntryStatus(policy);
    const toPersist: Persist[] = [];
    for (const r of body.rows) {
      if (r == null || typeof r !== "object" || Array.isArray(r))
        return bad("Each row must be an object");
      if (!Array.isArray(r.hours) || r.hours.length > 7) {
        return bad("Hours must be a list of at most seven day cells");
      }
      if (r.isBillable != null && typeof r.isBillable !== "boolean")
        return bad("Invalid billable flag");
      const projectId = uuidOrNull(r.projectId);
      if (projectId === "invalid") return bad("Invalid project");
      const workOrderId = uuidOrNull(r.workOrderId), woOperationId = uuidOrNull(r.woOperationId);
      if (workOrderId === 'invalid' || woOperationId === 'invalid' || (projectId && workOrderId) || (woOperationId && !workOrderId)) return bad('Choose one project or production order; an operation must belong to that production order.');
      const itemId = uuidOrNull(r.itemId);
      if (itemId === "invalid") return bad("Invalid item");
      const timeTypeId = uuidOrNull(r.timeTypeId);
      if (timeTypeId === "invalid") return bad("Invalid time type");
      const departmentId = uuidOrNull(r.departmentId);
      if (departmentId === "invalid") return bad("Invalid department");
      const memo =
        typeof r.memo === "string" && r.memo.trim() !== ""
          ? r.memo.trim()
          : null;
      const isBillable = r.isBillable === true;
      const validated = validateCustomValues(lineDefs, r.custom);
      if (!validated.ok)
        return bad(
          Object.values(validated.errors)[0] ?? "Invalid custom field",
        );
      // Reference custom values are uuid-SHAPED at this point but nothing
      // proves the referenced row belongs to the caller: refuse foreign or
      // dangling ids instead of persisting a cross-tenant pointer.
      const unowned = await findUnownedCustomReferences(
        orgId,
        lineDefs,
        validated.cleaned,
      );
      if (unowned.length > 0)
        return bad(`${unowned[0]!.label} not found in this organization`);
      const custom = validated.cleaned;
      const cells = Array.isArray(r.hours) ? r.hours : [];
      let ownedRefs:
        Awaited<ReturnType<typeof pinTimesheetLineRefs>> | undefined;

      for (let i = 0; i < 7; i++) {
        const h = hoursOrNull(cells[i]);
        if (h === "invalid") return bad("Hours must be a non-negative number");
        if (h === null) continue;
        if (projectId === null && isBillable)
          return bad("Billable hours need a project; select the customer project or mark this work nonbillable");
        if (ownedRefs === undefined) {
          ownedRefs = await pinTimesheetLineRefs(
            orgId,
            {
              projectId,
              itemId,
              timeTypeId,
              departmentId,
            },
            gate.allowedSubsidiaryIds,
          );
          if (!ownedRefs) {
            return bad("Invalid project, item, time type, or department");
          }
        }
        if (!ownedRefs) {
          return bad("Invalid project, item, time type, or department");
        }
        toPersist.push({
          workedOn: days[i]!,
          hours: h,
          projectId: ownedRefs.projectId,
          workOrderId,
          woOperationId,
          itemId: ownedRefs.itemId,
          timeTypeId: ownedRefs.timeTypeId,
          departmentId: ownedRefs.departmentId,
          isBillable,
          memo,
          custom,
        });
      }
    }

    // Stored time entries stay. Turning Inventory off must 404 a write that
    // would persist a new inventory / assembly / kit item. Amendments that only
    // reverse an existing locked row copy the original item and are not refused.
    if (!(await isFeatureEnabled(orgId, "inventory"))) {
      const stored = await db.execute<{ item_id: string }>(sql`
      select item_id from time_entries
       where org_id = ${orgId}
         and employee_party_id = ${ownedEmployee}
         and worked_on >= ${days[0]} and worked_on <= ${days[6]}
         and item_id is not null`);
      const storedIds = new Set(stored.rows.map((row) => row.item_id));
      for (const p of toPersist) {
        if (!p.itemId || storedIds.has(p.itemId)) continue;
        const item = await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${p.itemId} and org_id = ${orgId}`);
        if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
          return notFound("record");
        }
      }
    }
    // Stored time entries stay. Turning Equipment off must 404 a write that
    // would persist a new equipment_charge item. Amendments that only reverse
    // an existing locked row copy the original item and are not refused.
    if (!(await isFeatureEnabled(orgId, "equipment"))) {
      const stored = await db.execute<{ item_id: string }>(sql`
      select item_id from time_entries
       where org_id = ${orgId}
         and employee_party_id = ${ownedEmployee}
         and worked_on >= ${days[0]} and worked_on <= ${days[6]}
         and item_id is not null`);
      const storedIds = new Set(stored.rows.map((row) => row.item_id));
      for (const p of toPersist) {
        if (!p.itemId || storedIds.has(p.itemId)) continue;
        const item = await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${p.itemId} and org_id = ${orgId}`);
        if (item.rows[0] && item.rows[0].kind === "equipment_charge") {
          return notFound("record");
        }
      }
    }

    // Reconcile-in-place, keyed by line identity (day × hours × refs × memo ×
    // billable × custom). A replayed grid resolves to the stored rows instead of
    // inserting a second copy of the week's hours with fresh financial effects:
    // lines already held by surviving (immutable or consumed) entries are
    // dropped, lines matching a replaceable entry keep that row, and only
    // genuinely new lines insert. Only editable (draft/rejected) entries are
    // ever deleted — approved and submitted entries are left intact so a save
    // never silently overwrites an approval (or an in-flight submission).
    // Set when the revision fence below refuses the save; answered as a 409
    // after the transaction (which wrote nothing) commits empty.
    let staleRevision: string | null = null;
    let projectsRefused: boolean;
    try {
      projectsRefused = await withOrgTransaction(orgId, async () => {
        const tx = db;
        await lockSharedTimeAuthority(tx, orgId, user.id, { employeeId: ownedEmployee, from: days[0]!, through: days[6]!, requestedScope: gate.allowedSubsidiaryIds, permission: "time.manage", workFamily: timeWorkFamily(workspaceRequest) });
        // Canonical lock order is department, party, project. Shared locks
        // pin legal-entity attribution through save and automatic approval.
        const departmentScopes = await lockScopeRows(
          tx, orgId,
          toPersist.flatMap((p) => p.departmentId ? [{ kind: "department" as const, id: p.departmentId }] : []),
          gate.allowedSubsidiaryIds, "share", { orgWideNull: true },
        );
        const employeeScope = await lockScopeRow(
          tx,
          orgId,
          "party",
          ownedEmployee,
          gate.allowedSubsidiaryIds,
          "share",
        );
        const projectScopes = await lockScopeRows(
          tx, orgId,
          toPersist.flatMap((p) => p.projectId ? [{ kind: "project" as const, id: p.projectId }] : []),
          gate.allowedSubsidiaryIds, "share",
        );
        for (const p of toPersist) {
          const production = p.workOrderId ? await lockTimeWorkOrderTarget(tx, orgId, user.id, { workOrderId: p.workOrderId, operationId: p.woOperationId, requestedScope: gate.allowedSubsidiaryIds, requireOpen: false, permission: timeEntryPermission }) : null;
          const projectEntity = production?.subsidiaryId ?? projectScopes.find((row) => row.id === p.projectId)?.subsidiaryId;
          if (employeeScope.subsidiaryId != null && projectEntity != null && employeeScope.subsidiaryId !== projectEntity) {
            throw new TimeLineEntityRefusal("The project belongs to a different legal entity than the employee");
          }
          const departmentEntity = departmentScopes.find((row) => row.id === p.departmentId)?.subsidiaryId;
          const workEntity = projectEntity ?? employeeScope.subsidiaryId;
          if (departmentEntity != null && workEntity != null && departmentEntity !== workEntity) {
            throw new TimeLineEntityRefusal("The department belongs to a different legal entity than this work; select a department in the employee or project legal entity");
          }
        }
        // When approval is not required, saved entries land already approved, so
        // the replaceable set has to include those too — otherwise every save
        // would insert a second copy of the week's hours alongside the first.
        // Entries any downstream document has consumed stay put regardless: they
        // are evidence for an invoice, pay run or ledger entry that already
        // exists.
        //
        // An amendment offset points at its original by id, so a referenced
        // original stays put even when it would otherwise be deletable: removing
        // it — through a direct or stale save — orphans the offset into phantom
        // negative hours. Amendment history is append-only; correct such weeks
        // with a new amendment instead.
        //
        // The row lock serializes concurrent saves of this week so two writers
        // cannot interleave their diffs.
        const stored = (
          await tx.execute<{
            id: string;
            worked_on: string;
            hours: string;
            project_id: string | null;
            work_order_id: string | null;
            wo_operation_id: string | null;
            item_id: string | null;
            time_type_id: string | null;
            department_id: string | null;
            memo: string | null;
            is_billable: boolean;
            status: string;
            custom: Record<string, unknown> | null;
            invoiced_by_line_id: string | null;
            payroll_batch_ref: string | null;
            cost_journal_entry_id: string | null;
          production_consumed_operation_id: string | null;
            overhead_journal_entry_id: string | null;
            field_ticket_id: string | null;
            billing_status: "unbilled" | "billed";
            amends_entry_id: string | null;
            corrects_entry_id: string | null;
            has_contra: boolean;
          }>(sql`
      select id, worked_on, hours::text as hours, project_id, work_order_id, wo_operation_id, item_id,
             time_type_id, department_id, memo, is_billable, status, custom,
             invoiced_by_line_id, payroll_batch_ref, cost_journal_entry_id,
             overhead_journal_entry_id, production_consumed_operation_id, field_ticket_id, billing_status,
             amends_entry_id, corrects_entry_id,
             exists (
               select 1 from time_entries contra
                where contra.org_id = time_entries.org_id
                  and contra.amends_entry_id = time_entries.id
             ) as has_contra
        from time_entries
       where org_id = ${orgId}
         and employee_party_id = ${ownedEmployee}
         and worked_on >= ${days[0]} and worked_on <= ${days[6]}
       for update
    `)
        ).rows;
        // Lost-update fence: the client names the revision it loaded,
        // refuse a save over a week that moved since. The lock above is held,
        // so the re-read sees the latest committed state; no write has
        // happened yet, so recording the refusal and returning persists
        // nothing — the other editor's hours stand and this save lands
        // nowhere. (The refusal travels out-of-band: any truthy callback
        // value is read as the projects-refused flag.)
        const current = await loadWeek(
          orgId,
          ownedEmployee,
          week,
          gate.allowedSubsidiaryIds,
        );
        if (current.revision !== body.expectedRevision) {
          staleRevision = current.revision;
          return false;
        }
        const replaceable = (row: (typeof stored)[number]): boolean => {
          if (row.amends_entry_id != null || row.corrects_entry_id != null || row.has_contra) return false;
          if (row.status === "draft" || row.status === "rejected") return true;
          return (
            !policy.requireApproval &&
            row.status === "approved" &&
            row.invoiced_by_line_id == null &&
            row.payroll_batch_ref == null &&
            row.cost_journal_entry_id == null && row.production_consumed_operation_id == null &&
            row.overhead_journal_entry_id == null &&
            row.field_ticket_id == null &&
            row.billing_status === "unbilled"
          );
        };
        const lineKey = (v: {
          workedOn: string;
          hours: string;
          projectId: string | null;
          workOrderId: string | null;
          woOperationId: string | null;
          itemId: string | null;
          timeTypeId: string | null;
          departmentId: string | null;
          memo: string | null;
          isBillable: boolean;
          custom: Record<string, unknown>;
        }): string =>
          [
            v.workedOn,
            normalizeMoney(v.hours),
            v.projectId ?? "",
            v.workOrderId ?? "",
            v.woOperationId ?? "",
            v.itemId ?? "",
            v.timeTypeId ?? "",
            v.departmentId ?? "",
            v.memo ?? "",
            v.isBillable ? "1" : "0",
            canonicalJson(v.custom ?? {}),
          ].join("|");
        // Multiset of replaceable row ids by line identity; survivors are dropped
        // from the payload before they can duplicate immutable hours.
        const survivorCounts = new Map<string, number>();
        const replaceableIds = new Map<string, string[]>();
        for (const row of stored) {
          const key = lineKey({
            workedOn: row.worked_on,
            hours: row.hours,
            projectId: row.project_id,
            workOrderId: row.work_order_id,
            woOperationId: row.wo_operation_id,
            itemId: row.item_id,
            timeTypeId: row.time_type_id,
            departmentId: row.department_id,
            memo: row.memo,
            isBillable: row.is_billable,
            custom: row.custom ?? {},
          });
          if (replaceable(row)) {
            const ids = replaceableIds.get(key) ?? [];
            ids.push(row.id);
            replaceableIds.set(key, ids);
          } else {
            survivorCounts.set(key, (survivorCounts.get(key) ?? 0) + 1);
          }
        }
        const toInsert: Persist[] = [];
        for (const p of toPersist) {
          const key = lineKey(p);
          const survivors = survivorCounts.get(key) ?? 0;
          if (survivors > 0) {
            // Already stored on an entry this save must not touch: a replay of
            // the original result, not a new line.
            survivorCounts.set(key, survivors - 1);
            continue;
          }
          const kept = replaceableIds.get(key);
          if (kept && kept.length > 0) {
            // The stored row already carries this line: keep it (and its effects)
            // instead of churning it into a new id.
            kept.pop();
            continue;
          }
          toInsert.push(p);
        }
        // Project-carrying lines are Projects disable-blockers (open project
        // time), so a disable racing this save must refuse one side or the
        // other. Fenced inside the write transaction, and only when the save
        // actually inserts project lines: replays and deletions need no gate.
        // True escapes the transaction as a refusal; the route answers below.
        if (
          toInsert.some((p) => p.projectId != null) &&
          !(await checkProjectsWriteEnabled(orgId, tx))
        ) {
          return true;
        }
        const deleteIds = Array.from(replaceableIds.values()).flat();
        for (const row of stored.filter(row => deleteIds.includes(row.id) && row.work_order_id)) {
          await lockTimeWorkOrderTarget(tx, orgId, user.id, { workOrderId: row.work_order_id!, operationId: row.wo_operation_id, requestedScope: gate.allowedSubsidiaryIds, permission: timeEntryPermission });
        }
        if (deleteIds.length > 0) {
          const deleted = await tx.execute(sql`
        delete from time_entries
         where org_id = ${orgId}
           and id = any(${`{${deleteIds.join(",")}}`}::uuid[]) returning id
      `);
          if (deleted.rows.length !== deleteIds.length) throw new TimeLineEntityRefusal("The time lines changed while saving. Reload before trying again.");
        }
        const savedIds: string[] = [];
        for (const p of toInsert) {
          if (p.workOrderId) await lockTimeWorkOrderTarget(tx, orgId, user.id, { workOrderId: p.workOrderId, operationId: p.woOperationId, requestedScope: gate.allowedSubsidiaryIds, permission: timeEntryPermission });
          const saved = await tx.execute<{ id: string }>(sql`
        insert into time_entries
          (org_id, employee_party_id, worked_on, hours, time_type_id, item_id,
           project_id, work_order_id, wo_operation_id, department_id, memo, is_billable, status, custom,
           created_by, updated_by)
        values
          (${orgId}, ${ownedEmployee}, ${p.workedOn}, ${p.hours}, ${p.timeTypeId},
           ${p.itemId}, ${p.projectId}, ${p.workOrderId}, ${p.woOperationId}, ${p.departmentId}, ${p.memo},
           ${p.isBillable}, ${newStatus}, ${JSON.stringify(p.custom)}::jsonb,
           ${user.id}, ${user.id})
        returning id
      `);
          savedIds.push(saved.rows[0]!.id);
        }
        // Disabling the manual sign-off changes who authorizes availability, not
        // the rate evidence or accounting required when hours become usable.
        // Effects run only for freshly inserted lines: replayed lines already
        // carry theirs.
        if (newStatus === "approved")
          await runTimeApprovalEffects(orgId, user.id, savedIds, 'time.manage');
        return false;
      });
    } catch (error) {
      if (error instanceof TimeLineEntityRefusal) return bad(error.message);
      if (error instanceof ScopeNotFoundError)
        return notFound("record");
      // A designed approval refusal inside auto-approve answers typed, not
      // as an unexpected failure: the save wrote nothing, by transaction.
      if (error instanceof TimeApprovalRefusal || error instanceof TimeWorkTargetError)
        return apiErrorResponse(error);
      throw error;
    }
    if (staleRevision !== null) {
      return NextResponse.json(
        {
          error: STALE_WEEK_ERROR,
          code: "timesheet_stale_revision",
          revision: staleRevision,
        },
        { status: 409 },
      );
    }
    if (projectsRefused) return bad("Projects feature is disabled");

    const payload = await loadWeek(
      orgId,
      ownedEmployee,
      week,
      gate.allowedSubsidiaryIds,
    );
    return NextResponse.json(payload);
  },
});

export const PUT = save;
export const POST = save;
