import {sql,type SQL} from 'drizzle-orm';
import type {SqlExecutor} from '../platform/db.ts';
import {isUuid} from '../platform/uuid.ts';
import {subsidiaryVisibleFilter} from './subsidiary-scope.ts';
import {lockActorCommandAuthority} from './actor-command-authority.ts';
import {lockAndCheckOrgFeature} from './org-feature-lock.ts';
import {ScopeNotFoundError} from './subsidiary-scope.ts';
import type {WorkFamily} from './operating-profile-model.ts';

/** Historical work is filtered by its pinned profile's identity, across all retained revisions. */
export function workProfileFilter(org:SQL,version:SQL,selection:string|undefined):SQL {
  if(!selection||selection==='all')return sql`true`;
  if(selection==='legacy')return sql`${version} is null`;
  if(!isUuid(selection))return sql`false`;
  return sql`exists(select 1 from operating_profile_versions selected where selected.org_id=${org} and selected.id=${version} and selected.profile_id=${selection}::uuid)`;
}
export function workDepartmentFilter(department:SQL,selection:string|undefined):SQL {
  if(!selection||selection==='all')return sql`true`;
  if(selection==='unassigned')return sql`${department} is null`;
  if(!isUuid(selection))return sql`false`;
  return sql`${department}=${selection}::uuid`;
}
/** Queue filters are retained metadata, independent of which optional capture tools are enabled today. */
export async function readWorkListFilters(tx:SqlExecutor,orgId:string,actorId:string,family:WorkFamily) {
  if(!isUuid(actorId)||!['project','production'].includes(family))throw new ScopeNotFoundError();
  if(!(await tx.execute(sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows.length)throw new ScopeNotFoundError();
  if(!await lockAndCheckOrgFeature(tx,orgId,family==='project'?'projects':'manufacturing'))throw new ScopeNotFoundError();
  const scope=await lockActorCommandAuthority(tx,orgId,actorId,null,family==='project'?'projects.read':'manufacturing.read');
  const profiles=(await tx.execute<{value:string;label:string}>(sql`select profile.id as value,profile.name as label from operating_profiles profile
    where profile.org_id=${orgId} and profile.family=${family} order by profile.name,profile.id`)).rows;
  const departments=(await tx.execute<{value:string;label:string}>(sql`select department.id as value,department.name as label from departments department
    where department.org_id=${orgId} ${subsidiaryVisibleFilter(sql`department.subsidiary_id`,scope,{orgWideNull:true})} order by department.name,department.id`)).rows;
  return {profiles,departments};
}
