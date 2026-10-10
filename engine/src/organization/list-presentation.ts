import {sql} from 'drizzle-orm';
import type {SqlExecutor} from '../platform/db.ts';
import {lockActorCommandAuthority} from './actor-command-authority.ts';
import {lockAndCheckOrgFeature} from './org-feature-lock.ts';
import {ScopeNotFoundError} from './subsidiary-scope.ts';
import {isUuid} from '../platform/uuid.ts';
export type WorkListContext='project'|'manufacturing_work_order';
export type WorkListPresentation='list'|'board';
async function authorize(tx:SqlExecutor,orgId:string,actorId:string,context:WorkListContext) {
  if(!isUuid(actorId)||!['project','manufacturing_work_order'].includes(context))throw new ScopeNotFoundError();
  if(!(await tx.execute(sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows.length)throw new ScopeNotFoundError();
  const project=context==='project';
  if(!await lockAndCheckOrgFeature(tx,orgId,project?'projects':'manufacturing'))throw new ScopeNotFoundError();
  await lockActorCommandAuthority(tx,orgId,actorId,null,project?'projects.read':'manufacturing.read');
}
/** Presentation shares the native personal list preference without replacing its saved-view selection. */
export async function readWorkListPresentation(tx:SqlExecutor,orgId:string,actorId:string,context:WorkListContext):Promise<WorkListPresentation|null> {
  await authorize(tx,orgId,actorId,context);
  const row=(await tx.execute<{presentation:WorkListPresentation|null}>(sql`select presentation from user_list_preferences where org_id=${orgId} and user_id=${actorId} and record_type=${context}`)).rows[0];
  return row?.presentation??null;
}
export async function saveWorkListPresentation(tx:SqlExecutor,orgId:string,actorId:string,context:WorkListContext,presentation:WorkListPresentation|null) {
  await authorize(tx,orgId,actorId,context);
  if(presentation!==null&&!['list','board'].includes(presentation))throw new ScopeNotFoundError();
  const result=(await tx.execute<{presentation:WorkListPresentation|null}>(sql`insert into user_list_preferences(org_id,user_id,record_type,presentation,view_selection_explicit,created_by,updated_by)
    values(${orgId},${actorId},${context},${presentation},false,${actorId},${actorId})
    on conflict(org_id,user_id,record_type) do update set presentation=excluded.presentation,updated_at=now(),updated_by=excluded.updated_by
    where user_list_preferences.org_id=${orgId} and user_list_preferences.user_id=${actorId} returning presentation`)).rows[0];
  if(!result)throw new ScopeNotFoundError();return result;
}
