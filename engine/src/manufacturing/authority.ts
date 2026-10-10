import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import {
  ScopeNotFoundError,
  subsidiaryScopeAllows,
} from "../organization/subsidiary-scope.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";
import { isUuid } from "../platform/uuid.ts";
import { orderResourcesVisible, routingResourcesVisible,centerResourcesVisible } from "./resource-scope.ts";
import { pinProductionOrderResources } from "../organization/production-resource-scope.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";

/** A supplied scope is a narrowing filter, never a substitute for live authority. */
export async function lockManufacturingExecutionAuthority(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  subsidiaryId: string | null,
  requestedScope: ReadonlySet<string> | null,
): Promise<ReadonlySet<string> | null> {
  if (!subsidiaryId || !isUuid(actorId) || !isUuid(subsidiaryId)) throw new ManufacturingNotFoundError();
  const actor = (
    await tx.execute(
      sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`,
    )
  ).rows[0];
  if (!actor) throw new ManufacturingNotFoundError();
  let derived: ReadonlySet<string> | null;
  try {
    derived = await lockActorCommandAuthority(
      tx,
      orgId,
      actorId,
      subsidiaryId,
      "manufacturing.manage",
    );
    const posting = await lockActorCommandAuthority(
      tx,
      orgId,
      actorId,
      subsidiaryId,
      "items.post",
    );
    if (posting!==null) derived=derived===null?posting:new Set([...derived].filter(id=>posting.has(id)));
  } catch (error) {
    if (error instanceof ScopeNotFoundError)
      throw new ManufacturingNotFoundError();
    throw error;
  }
  const scope =
    derived === null
      ? requestedScope
      : requestedScope === null
        ? derived
        : new Set([...derived].filter((id) => requestedScope.has(id)));
  if (!subsidiaryScopeAllows(scope, subsidiaryId))
    throw new ManufacturingNotFoundError();
  return scope;
}

/** Draft management has no inventory posting authority; each eventual posting checks its own grant. */
export async function lockManufacturingManageAuthority(tx: SqlExecutor, orgId: string, actorId: string, subsidiaryId: string | null, requestedScope: ReadonlySet<string> | null = null) {
  if(!isUuid(actorId)||(subsidiaryId!==null&&!isUuid(subsidiaryId))) throw new ManufacturingNotFoundError();
  const actor = (await tx.execute(sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows[0];
  if (!actor) throw new ManufacturingNotFoundError();
  const derived = await lockActorCommandAuthority(tx,orgId,actorId,subsidiaryId,'manufacturing.manage');
  const scope = derived === null ? requestedScope : requestedScope === null ? derived : new Set([...derived].filter(id=>requestedScope.has(id)));
  if (subsidiaryId !== null && !subsidiaryScopeAllows(scope,subsidiaryId)) throw new ManufacturingNotFoundError();
  return scope;
}

/** An organization-wide policy cannot be changed through a narrower entity grant. */
export async function lockManufacturingPolicyAuthority(tx: SqlExecutor, orgId: string, actorId: string) {
  if (await lockManufacturingManageAuthority(tx, orgId, actorId, null) !== null)
    throw new ManufacturingError("Organization-wide manufacturing policy requires access to every legal entity.", {
      status:403, code:"manufacturing_policy_scope_required",
      remedy:"Ask a manufacturing manager with access to every legal entity to change this shared policy.",
    });
}

export async function assertManufacturingStockLocationScope(tx: SqlExecutor, orgId: string, id: string | null | undefined, scope: ReadonlySet<string> | null) {
  if (id == null) return;
  if (!isUuid(id)) throw new ManufacturingNotFoundError();
  if (!(await tx.execute(sql`select stock.id from stock_locations stock join locations location
    on location.org_id=stock.org_id and location.id=stock.location_id
    where stock.org_id=${orgId} and stock.id=${id}
    ${subsidiaryVisibleFilter(sql`location.subsidiary_id`, scope, {orgWideNull:true})}
    for share of stock, location`)).rows.length) throw new ManufacturingNotFoundError();
}

export async function lockManufacturingCenterAuthority(tx: SqlExecutor, orgId: string, actorId: string, id: string) {
  if (!isUuid(id)) throw new ManufacturingNotFoundError();
  const scope = await lockManufacturingManageAuthority(tx, orgId, actorId, null);
  if (!(await tx.execute(sql`select center.id from mfg_work_centers center left join departments department on department.org_id=center.org_id and department.id=center.department_id
    where center.org_id=${orgId} and center.id=${id}
    ${centerResourcesVisible(scope)} for share of center`)).rows.length) throw new ManufacturingNotFoundError();
  await tx.execute(sql`select department.id from departments department join mfg_work_centers center on center.org_id=department.org_id and center.department_id=department.id where center.org_id=${orgId} and center.id=${id} for share of department`);
  await tx.execute(sql`select calendar.id from schedule_calendars calendar join mfg_work_centers center on center.org_id=calendar.org_id and center.calendar_id=calendar.id where center.org_id=${orgId} and center.id=${id} for share of calendar`);
  await tx.execute(sql`select project.id from projects project join schedule_calendars calendar on calendar.org_id=project.org_id and calendar.project_id=project.id join mfg_work_centers center on center.org_id=calendar.org_id and center.calendar_id=calendar.id where center.org_id=${orgId} and center.id=${id} for share of project`);
  if(!(await tx.execute(sql`select center.id from mfg_work_centers center where center.org_id=${orgId} and center.id=${id} ${centerResourcesVisible(scope)}`)).rows.length)throw new ManufacturingNotFoundError();
  return scope;
}

/** A routing command owns its complete composition, including newly selected resources. */
export async function lockManufacturingRoutingAuthority(tx: SqlExecutor, orgId: string, actorId: string, id: string) {
  if (!isUuid(id)) throw new ManufacturingNotFoundError();
  const scope = await lockManufacturingManageAuthority(tx, orgId, actorId, null);
  if (!(await tx.execute(sql`select r.id from mfg_routings r where r.org_id=${orgId} and r.id=${id}
    ${routingResourcesVisible(scope,'r')} for update`)).rows.length) throw new ManufacturingNotFoundError();
  const header = (await tx.execute<{issue:string|null;receipt:string|null}>(sql`select default_issue_location_id as issue, default_receipt_location_id as receipt from mfg_routings where org_id=${orgId} and id=${id}`)).rows[0];
  if (!header) throw new ManufacturingNotFoundError();
  await assertManufacturingStockLocationScope(tx,orgId,header.issue,scope);
  await assertManufacturingStockLocationScope(tx,orgId,header.receipt,scope);
  await tx.execute(sql`select center.id from mfg_work_centers center join mfg_routing_operations operation
    on operation.org_id=center.org_id and operation.work_center_id=center.id
    where operation.org_id=${orgId} and operation.routing_id=${id} order by center.id for share of center`);
  await tx.execute(sql`select department.id from departments department where department.org_id=${orgId} and department.id in(
    select center.department_id from mfg_work_centers center join mfg_routing_operations operation on operation.org_id=center.org_id and operation.work_center_id=center.id where operation.org_id=${orgId} and operation.routing_id=${id}
  ) order by department.id for share`);
  await tx.execute(sql`select calendar.id from schedule_calendars calendar where calendar.org_id=${orgId} and calendar.id in (
    select center.calendar_id from mfg_work_centers center join mfg_routing_operations operation on operation.org_id=center.org_id and operation.work_center_id=center.id where operation.org_id=${orgId} and operation.routing_id=${id}
  ) order by calendar.id for share`);
  await tx.execute(sql`select project.id from projects project join schedule_calendars calendar on calendar.org_id=project.org_id and calendar.project_id=project.id where project.org_id=${orgId} and calendar.id in (
    select center.calendar_id from mfg_work_centers center join mfg_routing_operations operation on operation.org_id=center.org_id and operation.work_center_id=center.id where operation.org_id=${orgId} and operation.routing_id=${id}
  ) order by project.id for share of project`);
  // Recheck after pinning centers: a scope change while acquiring locks must refuse.
  if (!(await tx.execute(sql`select r.id from mfg_routings r where r.org_id=${orgId} and r.id=${id}
    ${routingResourcesVisible(scope,'r')}`)).rows.length) throw new ManufacturingNotFoundError();
  return scope;
}

export async function lockManufacturingOrderManageAuthority(tx: SqlExecutor, orgId: string, actorId: string, id: string, requestedScope: ReadonlySet<string> | null = null) {
  if (!isUuid(id)) throw new ManufacturingNotFoundError();
  const subject = (await tx.execute<{subsidiaryId:string|null}>(sql`select subsidiary_id as "subsidiaryId" from mfg_work_orders where org_id=${orgId} and id=${id}`)).rows[0];
  if (!subject) throw new ManufacturingNotFoundError();
  const scope = await lockManufacturingManageAuthority(tx,orgId,actorId,subject.subsidiaryId,requestedScope);
  if (!(await tx.execute(sql`select work.id from mfg_work_orders work where work.org_id=${orgId} and work.id=${id}
    ${subsidiaryVisibleFilter(sql`work.subsidiary_id`,scope)} ${orderResourcesVisible(scope,'work')} for update`)).rows.length) throw new ManufacturingNotFoundError();
  await pinProductionOrderResources(tx,orgId,id);
  if(!(await tx.execute(sql`select work.id from mfg_work_orders work where work.org_id=${orgId} and work.id=${id}
    ${subsidiaryVisibleFilter(sql`work.subsidiary_id`,scope)} ${orderResourcesVisible(scope,'work')}`)).rows.length)throw new ManufacturingNotFoundError();
  return scope;
}

/** Read projections derive live authority before applying a caller's narrower filter. */
export async function lockManufacturingReadAuthority(
  tx: SqlExecutor, orgId: string, actorId: string,
  requestedScope: ReadonlySet<string> | null = null,
  permissions: readonly string[] = ["manufacturing.read"],
): Promise<ReadonlySet<string> | null> {
  if(!isUuid(actorId)) throw new ManufacturingNotFoundError();
  const actor = (await tx.execute(sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows[0];
  if (!actor) throw new ManufacturingNotFoundError();
  let scope = requestedScope;
  for (const permission of permissions) {
    const derived = await lockActorCommandAuthority(tx, orgId, actorId, null, permission);
    if (derived !== null) scope = scope === null ? derived : new Set([...scope].filter(id => derived.has(id)));
  }
  return scope;
}

/** Direct services and imported commands use the same whole-order authority as the app. */
export async function lockManufacturingOrderExecutionAuthority(
  tx: SqlExecutor, orgId: string, actorId: string, workOrderId: string,
  requestedScope: ReadonlySet<string> | null = null,
  receiptLocationId?: string | null,
) {
  if (!isUuid(workOrderId)) throw new ManufacturingNotFoundError();
  const order = (await tx.execute<{subsidiaryId:string|null}>(sql`select subsidiary_id as "subsidiaryId" from mfg_work_orders where org_id=${orgId} and id=${workOrderId}`)).rows[0];
  if (!order) throw new ManufacturingNotFoundError();
  const scope=await lockManufacturingExecutionAuthority(tx,orgId,actorId,order.subsidiaryId,requestedScope);
  if (!(await tx.execute(sql`select work.id from mfg_work_orders work where work.org_id=${orgId} and work.id=${workOrderId}
    ${subsidiaryVisibleFilter(sql`work.subsidiary_id`,scope)} ${orderResourcesVisible(scope,"work")} for update`)).rows.length) throw new ManufacturingNotFoundError();
  await pinProductionOrderResources(tx,orgId,workOrderId);
  if (!(await tx.execute(sql`select work.id from mfg_work_orders work where work.org_id=${orgId} and work.id=${workOrderId}
    ${subsidiaryVisibleFilter(sql`work.subsidiary_id`,scope)} ${orderResourcesVisible(scope,"work")}`)).rows.length) throw new ManufacturingNotFoundError();
  await assertManufacturingStockLocationScope(tx,orgId,receiptLocationId,scope);
  return scope;
}
