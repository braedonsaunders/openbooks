import { sql } from 'drizzle-orm'
import type { SqlExecutor } from '../platform/db.ts'
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts'
import { actorHasPermission } from '../organization/actor-permissions.ts'
import { grantsConferring } from '../organization/permissions.ts'
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts'
import { ScopeNotFoundError, subsidiaryScopeAllows } from '../organization/subsidiary-scope.ts'
import { orderResourcesVisible,pinProductionOrderResources } from '../organization/production-resource-scope.ts'
import { subsidiaryVisibleFilter } from '../organization/subsidiary-scope.ts'
import { isUuid } from '../platform/uuid.ts'
import { isIsoCalendarDate } from '../platform/business-date.ts'

export class TimeWorkTargetError extends Error {
  constructor(message: string, readonly status = 422, readonly code = 'time_work_target_refused', readonly remedy = 'Choose an available released production order and an open operation, or record project time separately.') { super(message); this.name = 'TimeWorkTargetError' }
}
/** Shared time references the production record; it never creates a second job or posts production WIP. */
export async function lockTimeWorkOrderTarget(tx: SqlExecutor, orgId: string, actorId: string, input: { workOrderId: string; operationId?: string | null; requestedScope: ReadonlySet<string> | null; permission?: 'time.read' | 'time.manage' | 'time.approve' | 'time.reopen' | 'time.self' | 'time.clock'; requireOpen?: boolean; lockMode?: 'share' | 'update' }) {
  if(!isUuid(input.workOrderId)||(input.operationId!=null&&!isUuid(input.operationId))) throw new ScopeNotFoundError()
  await acquireOrgFeatureGateLock(tx, orgId)
  if (!await lockAndCheckOrgFeature(tx, orgId, 'manufacturing')) throw new TimeWorkTargetError('Production time is unavailable while Manufacturing is turned off.', 404)
  const actor = (await tx.execute(sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows[0]
  if (!actor) throw new ScopeNotFoundError()
  const order = (await tx.execute<{ subsidiaryId: string | null; status: string; issueLocationId: string | null; receiptLocationId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId",status,issue_location_id as "issueLocationId",receipt_location_id as "receiptLocationId"
    from mfg_work_orders where org_id=${orgId} and id=${input.workOrderId}`)).rows[0]
  if (!order?.subsidiaryId || !subsidiaryScopeAllows(input.requestedScope, order.subsidiaryId)) throw new ScopeNotFoundError()
  let actualScope = await lockActorCommandAuthority(tx, orgId, actorId, order.subsidiaryId, input.permission ?? 'time.manage')
  const manufacturingScope=await lockActorCommandAuthority(tx, orgId, actorId, order.subsidiaryId, 'manufacturing.read')
  if(manufacturingScope!==null) actualScope=actualScope===null?manufacturingScope:new Set([...actualScope].filter(id=>manufacturingScope.has(id)))
  const scope=actualScope===null?input.requestedScope:input.requestedScope===null?actualScope:new Set([...actualScope].filter(id=>input.requestedScope!.has(id)))
  const pinned=(await tx.execute<{status:string}>(sql`select status from mfg_work_orders where org_id=${orgId} and id=${input.workOrderId} and subsidiary_id=${order.subsidiaryId}
    ${input.lockMode==='update'?sql`for update`:sql`for share`}`)).rows[0]
  if(!pinned)throw new ScopeNotFoundError()
  order.status=pinned.status
  await pinProductionOrderResources(tx,orgId,input.workOrderId)
  if(!(await tx.execute(sql`select work.id from mfg_work_orders work where work.org_id=${orgId} and work.id=${input.workOrderId} ${subsidiaryVisibleFilter(sql`work.subsidiary_id`,scope)} ${orderResourcesVisible(scope,'work')}`)).rows.length) throw new ScopeNotFoundError()
  const operations = (await tx.execute<{ id: string; status: string; subsidiaryId: string | null; departmentId: string | null }>(sql`
    select o.id,o.status,c.subsidiary_id as "subsidiaryId",c.department_id as "departmentId"
    from mfg_wo_operations o join mfg_work_centers c on c.org_id=o.org_id and c.id=o.work_center_id
    where o.org_id=${orgId} and o.work_order_id=${input.workOrderId} order by o.sequence for share of o,c`)).rows
  const visible = (id: string | null) => id === null || (subsidiaryScopeAllows(actualScope,id) && subsidiaryScopeAllows(input.requestedScope,id))
  if (operations.some(o => !subsidiaryScopeAllows(actualScope,o.subsidiaryId) || !subsidiaryScopeAllows(input.requestedScope,o.subsidiaryId))) throw new ScopeNotFoundError()
  const ids = [order.issueLocationId, order.receiptLocationId].filter((id): id is string => id !== null)
  const locations = ids.length ? (await tx.execute<{ id: string; subsidiaryId: string | null }>(sql`
    select s.id,l.subsidiary_id as "subsidiaryId" from stock_locations s join locations l on l.org_id=s.org_id and l.id=s.location_id
    where s.org_id=${orgId} and s.id=any(${`{${ids.join(',')}}`}::uuid[]) order by s.id for share of s,l`)).rows : []
  if (locations.length !== new Set(ids).size || locations.some(l => !visible(l.subsidiaryId))) throw new ScopeNotFoundError()
  const operation = input.operationId ? operations.find(o => o.id === input.operationId) : null
  if (input.operationId && !operation) throw new ScopeNotFoundError()
  if (input.requireOpen !== false && (!['released','in_progress'].includes(order.status) || (operation && operation.status === 'done'))) throw new TimeWorkTargetError('This production work is not open for new time. Correct consumed time through an amendment; resume held work before adding time.', 409)
  return { subsidiaryId: order.subsidiaryId, departmentId: operation?.departmentId ?? null }
}

export type TimeWorkFamily = 'project' | 'production'
export type TimeCommandPermission = 'time.read' | 'time.manage' | 'time.approve' | 'time.reopen'

/** The grant an actor holds for a time command, and whether it reaches only their own weeks. */
export type HeldTimeGrant = { grant: TimeGrant; selfOnly: boolean }
export type TimeGrant = 'time.read' | 'time.manage' | 'time.approve' | 'time.reopen' | 'time.self' | 'time.clock'

/**
 * Resolve the grant behind a time command from the declared permission
 * implications (PERMISSION_IMPLICATIONS): a supervisory grant over everyone's
 * weeks first (time.manage also reads), otherwise a grant over the actor's
 * own weeks (time.self reads and enters; time.clock reads). Approving and
 * reopening have no own-scope grant. Null when the actor holds none.
 */
export async function resolveTimeGrant(tx: SqlExecutor, orgId: string, actorId: string, permission: TimeCommandPermission): Promise<HeldTimeGrant | null> {
  for (const grant of grantsConferring(permission, 'all')) {
    if (await actorHasPermission(tx, orgId, actorId, grant)) return { grant: grant as TimeGrant, selfOnly: false }
  }
  for (const grant of grantsConferring(permission, 'own')) {
    if (await actorHasPermission(tx, orgId, actorId, grant)) return { grant: grant as TimeGrant, selfOnly: true }
  }
  return null
}

/** The refusal a self-service time user meets on anyone else's time. */
export function selfServiceTimeRefusal(): TimeWorkTargetError {
  return new TimeWorkTargetError(
    "You can only see and change your own timesheet.",
    403,
    'time_self_only',
    "To work with a coworker's time, ask an administrator for a role that views or enters everyone's time; your own weeks stay available under Timesheets.",
  )
}
/** Pin a shared week and every actual target before its lifecycle changes. A workspace selector never grants access to another family's records. */
export async function lockSharedTimeAuthority(tx: SqlExecutor, orgId: string, actorId: string, input: {
  employeeId: string; from: string; through: string; requestedScope: ReadonlySet<string> | null;
  permission: TimeCommandPermission; workFamily?: TimeWorkFamily;
}) {
  if(!isUuid(input.employeeId)||!isIsoCalendarDate(input.from)||!isIsoCalendarDate(input.through)||input.through<input.from) throw new TimeWorkTargetError('Choose a valid employee and time window.')
  await acquireOrgFeatureGateLock(tx, orgId)
  const projectOn = await lockAndCheckOrgFeature(tx, orgId, 'timeTracking')
  const productionOn = await lockAndCheckOrgFeature(tx, orgId, 'manufacturing')
  if (input.workFamily === 'production' ? !productionOn : input.workFamily === 'project' ? !projectOn : !projectOn && !productionOn)
    throw new TimeWorkTargetError('This time workspace is turned off. Enable its feature in Company Settings → Features.', 404)
  const actor = (await tx.execute(sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows[0]
  if (!actor) throw new ScopeNotFoundError()
  // Saves and lifecycle commands serialize discovery before locking targets. A peer cannot add an unseen target between the authority read and the week write.
  if(input.permission!=='time.read') await tx.execute(sql`select pg_advisory_xact_lock(hashtext('shared.employee.time'),hashtext(${orgId+input.employeeId}))`)
  // A week belongs to a timekeeper: an active person party, or an employee
  // party holding an active employment. Payroll admits only employments, so
  // partner and contractor time never reaches a pay run; vendors, customers
  // and contacts hold no time. A former employee's party alone reopens
  // nothing until the employment is restored.
  const employee = (await tx.execute<{ subsidiaryId: string | null }>(sql`
    select p.subsidiary_id as "subsidiaryId" from parties p where p.org_id=${orgId} and p.id=${input.employeeId} and p.is_active
    and p.kind in ('person','employee')
    and (p.kind = 'person' or exists(select 1 from employee_roles r where r.org_id=p.org_id and r.party_id=p.id and r.is_active)) for share of p`)).rows[0]
  if (!employee || !subsidiaryScopeAllows(input.requestedScope,employee.subsidiaryId)) throw new ScopeNotFoundError()
  // Supervisory grants act on anyone's week inside the actor's scope. Without
  // one, an own-scope grant (time.self, or time.clock for reading) acts only
  // on the person linked to the actor's own login — never a coworker,
  // whatever the request names.
  const held = await resolveTimeGrant(tx, orgId, actorId, input.permission)
  if (!held) throw new ScopeNotFoundError()
  const selfOnly = held.selfOnly
  if (selfOnly) {
    const own = (await tx.execute<{ partyId: string | null }>(sql`
      select party_id as "partyId" from users where id=${actorId} and org_id=${orgId} for share`)).rows[0]?.partyId ?? null
    if (own !== input.employeeId) throw selfServiceTimeRefusal()
  }
  const actualScope = await lockActorCommandAuthority(tx,orgId,actorId,employee.subsidiaryId,held.grant)
  const entries = (await tx.execute<{ projectId: string | null; workOrderId: string | null; operationId: string | null }>(sql`
    select distinct project_id as "projectId", work_order_id as "workOrderId", wo_operation_id as "operationId"
    from time_entries where org_id=${orgId} and employee_party_id=${input.employeeId} and worked_on>=${input.from}::date and worked_on<=${input.through}::date
    order by "workOrderId", "operationId", "projectId"`)).rows
  let projectsOn: boolean | null = null
  for (const entry of entries) {
    if (entry.projectId && entry.workOrderId) throw new TimeWorkTargetError('Split project and production work into separate time lines.')
    if (entry.workOrderId) {
      await lockTimeWorkOrderTarget(tx,orgId,actorId,{ workOrderId:entry.workOrderId,operationId:entry.operationId,requestedScope:input.requestedScope,permission:held.grant,requireOpen:false,lockMode:input.permission==='time.read' ? 'share' : 'update' })
    } else if (entry.projectId) {
      // The project dimension needs Projects: a week naming project time
      // refuses while it is off, with the remedy, while non-project weeks
      // stay readable. Preserved project history is never deleted by this.
      projectsOn ??= await lockAndCheckOrgFeature(tx, orgId, 'projects')
      if (!projectOn || !projectsOn) throw new TimeWorkTargetError('This week contains project time. Enable Projects and Time Tracking before changing or reading the complete week.',404)
      const project = (await tx.execute<{ subsidiaryId: string | null }>(sql`select subsidiary_id as "subsidiaryId" from projects where org_id=${orgId} and id=${entry.projectId} for share`)).rows[0]
      if (!project || !subsidiaryScopeAllows(actualScope,project.subsidiaryId) || !subsidiaryScopeAllows(input.requestedScope,project.subsidiaryId)) throw new ScopeNotFoundError()
      // Reading another person's project time needs project visibility; a
      // person's own week shows the projects they booked to.
      if (!selfOnly) await lockActorCommandAuthority(tx,orgId,actorId,project.subsidiaryId,'projects.read')
    }
  }
  return { actualScope, employeeSubsidiaryId: employee.subsidiaryId, selfOnly }
}
