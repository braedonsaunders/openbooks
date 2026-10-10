import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { SqlExecutor } from '../platform/db.ts'
import { isUuid } from '../platform/uuid.ts'
import { lockActorCommandAuthority } from './actor-command-authority.ts'
import { subsidiaryScopeAllows } from './subsidiary-scope.ts'
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature } from './org-feature-lock.ts'
import { resolvedFeatureState } from './feature-state.ts'
import { loadSubsidiaryContext, restrictionAdmits } from './subsidiaries.ts'
import { OPERATING_PRESETS, operatingProfileAvailable, validateOperatingProfile, type OperatingProfileDefinition, type WorkFamily } from './operating-profile-model.ts'

export class OperatingProfileError extends Error {
  constructor(message: string, readonly status = 422, readonly code = 'operating_profile_refused', readonly remedy = 'Review Operating profiles in Setup and choose an available workflow.') { super(message); this.name = 'OperatingProfileError' }
}
export interface OperatingProfileChoice {
  value: string; profileId: string | null; name: string; description: string; version: number;
  definition: OperatingProfileDefinition
  isDefault?: boolean
}
async function lockAuthority(tx: SqlExecutor, orgId: string, actorId: string, permission: string, subsidiaryId: string | null, unrestricted = false) {
  if (!(await tx.execute(sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows[0]) throw new OperatingProfileError('Work not found.', 404)
  const allowed = await lockActorCommandAuthority(tx, orgId, actorId, subsidiaryId, permission)
  if (unrestricted && allowed !== null) throw new OperatingProfileError('Organization-wide setup requires unrestricted legal-entity authority.', 404)
  return allowed
}
async function checkDefinitionFeatures(tx: SqlExecutor, orgId: string, definition: OperatingProfileDefinition) {
  await acquireOrgFeatureGateLock(tx, orgId)
  for (const key of [definition.family === 'project' ? 'projects' : 'manufacturing', ...(definition.capture === 'field_tickets' ? ['fieldTickets'] : [])]) {
    if (!await lockAndCheckOrgFeature(tx, orgId, key)) throw new OperatingProfileError('This workflow needs a feature that is turned off.', 404, 'feature_disabled', 'Enable its required features in Company Settings → Features, or choose another workflow.')
  }
}
export async function listOperatingProfileChoices(tx: SqlExecutor, orgId: string, actorId: string, family: WorkFamily, departmentId: string | null = null): Promise<OperatingProfileChoice[]> {
  const allowed = await lockAuthority(tx,orgId,actorId,family === 'project' ? 'projects.read' : 'manufacturing.read',null)
  if (departmentId) {
    const department = isUuid(departmentId) ? (await tx.execute<{subsidiaryId:string|null}>(sql`select subsidiary_id as "subsidiaryId" from departments where org_id=${orgId} and id=${departmentId} and is_active for share`)).rows[0] : null
    if (!department || !subsidiaryScopeAllows(allowed,department.subsidiaryId,{orgWideNull:true})) throw new OperatingProfileError('Department not found.',404)
  }
  const scope=(await tx.execute<{profileIds:string[];defaultProfileId:string|null}>(sql`select profile_ids as "profileIds",default_profile_id as "defaultProfileId" from operating_profile_scopes where org_id=${orgId} and family=${family} and (department_id=${departmentId}::uuid or department_id is null) order by (department_id is not null) desc limit 1`)).rows[0]
  const features = await resolvedFeatureState(orgId, tx)
  const rows = (await tx.execute<{ id: string; code: string; name: string; versionId: string; version: number; definition: OperatingProfileDefinition }>(sql`
    select p.id,p.code,p.name,v.id as "versionId",v.version,v.definition from operating_profiles p
    join operating_profile_versions v on v.org_id=p.org_id and v.profile_id=p.id and v.id=p.current_version_id
    where p.org_id=${orgId} and p.family=${family} and p.is_active order by p.name`)).rows
  const choices = rows.filter(r => operatingProfileAvailable(validateOperatingProfile(r.definition), features)).map(r => ({ value: r.versionId, profileId: r.id, name: r.name, description: '', version: r.version, definition: r.definition }))
  for (const preset of OPERATING_PRESETS) {
    if (preset.definition.family === family && !rows.some(r => r.code === preset.key) && operatingProfileAvailable(preset.definition, features)) {
      // Built-in choices are materialized only when selected; no optional gate is enabled by a preset.
      const exists = (await tx.execute(sql`select id from operating_profiles where org_id=${orgId} and code=${preset.key}`)).rows[0]
      if (!exists) choices.push({ value: preset.key, profileId: null, name: preset.name, description: preset.description, version: 1, definition: preset.definition })
    }
  }
  return scope ? choices.filter(choice=>choice.profileId!==null && scope.profileIds.includes(choice.profileId)).map(choice=>({...choice,isDefault:choice.profileId===scope.defaultProfileId})) : choices
}
async function audit(tx: SqlExecutor, orgId: string, actorId: string, table: string, id: string, before: unknown, after: unknown, reason: string) {
  await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},${table},${id},${before === null ? 'insert' : 'update'},${JSON.stringify({ before, after, reason })}::jsonb,${actorId})`)
}
async function publish(tx: SqlExecutor, orgId: string, actorId: string, input: { id: string; code: string; name: string; definition: OperatingProfileDefinition; expectedVersion: number; reason: string; isActive?: boolean }) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:operating-profile:${orgId}:${input.code}`},0))`)
  let row = (await tx.execute<{ id: string; family: WorkFamily; current_version_id: string | null; name: string; is_active: boolean }>(sql`select id,family,current_version_id,name,is_active from operating_profiles where org_id=${orgId} and code=${input.code} for update`)).rows[0]
  if (row && row.id !== input.id) throw new OperatingProfileError('That workflow code already exists.', 409)
  if (row && row.family !== input.definition.family) throw new OperatingProfileError('A published workflow cannot change its native work family. Create another workflow.')
  const previous = row?.current_version_id ? (await tx.execute<{ version: number; definition: OperatingProfileDefinition }>(sql`select version,definition from operating_profile_versions where org_id=${orgId} and id=${row.current_version_id}`)).rows[0] : null
  if (row && input.expectedVersion === 0) {
    const replay = (await tx.execute<{ versionId: string }>(sql`
      select v.id as "versionId" from operating_profile_versions v
      join audit_log a on a.org_id=v.org_id and a.table_name='operating_profiles' and a.row_id=v.profile_id and a.action='insert'
      where v.org_id=${orgId} and v.profile_id=${input.id} and v.version=1
      and v.definition=${JSON.stringify(input.definition)}::jsonb and v.reason=${input.reason}
      and a.changes->'after'->>'name'=${input.name} and a.changes->'after'->>'code'=${input.code}
      and coalesce((a.changes->'after'->>'isActive')::boolean,true)=${input.isActive ?? true}`)).rows[0]
    if (replay) return { id: input.id, versionId: replay.versionId, version: 1 }
  }
  if ((previous?.version ?? 0) !== input.expectedVersion) throw new OperatingProfileError('This workflow changed while you were editing.', 409, 'operating_profile_version_conflict', 'Reload the current version before publishing your changes.')
  if (!row) {
    const inserted = await tx.execute(sql`insert into operating_profiles(id,org_id,code,name,family,created_by,updated_by) values(${input.id},${orgId},${input.code},${input.name},${input.definition.family},${actorId},${actorId}) returning id`)
    if (!inserted.rows[0]) throw new OperatingProfileError('The workflow was not created.', 409)
  }
  const isActive = input.isActive ?? row?.is_active ?? true
  const versionId = randomUUID(), version = input.expectedVersion + 1
  const inserted = await tx.execute(sql`insert into operating_profile_versions(id,org_id,profile_id,version,family,definition,published_by,reason) values(${versionId},${orgId},${input.id},${version},${input.definition.family},${JSON.stringify(input.definition)}::jsonb,${actorId},${input.reason}) returning id`)
  if (!inserted.rows[0]) throw new OperatingProfileError('The workflow version was not published.', 409)
  const updated = await tx.execute(sql`update operating_profiles set name=${input.name},current_version_id=${versionId},is_active=${isActive},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${input.id} returning id`)
  if (!updated.rows[0]) throw new OperatingProfileError('The workflow changed while publishing.', 409)
  await audit(tx, orgId, actorId, 'operating_profiles', input.id, row ?? null, { name: input.name, code: input.code, version, versionId, isActive, definition: input.definition }, input.reason)
  return { id: input.id, versionId, version }
}
export async function publishOperatingProfile(tx: SqlExecutor, orgId: string, actorId: string, input: { id: string; code: string; name: string; definition: unknown; expectedVersion: number; reason: string; isActive?: boolean }) {
  await lockAuthority(tx, orgId, actorId, 'admin.setup.manage', null, true)
  if ((input.isActive !== undefined && typeof input.isActive !== 'boolean') || !isUuid(input.id) || !/^[a-z][a-z0-9_-]{0,79}$/.test(input.code) || !input.name.trim() || input.name.trim().length > 120 || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0 || input.reason.trim().length < 5 || input.reason.trim().length > 500) throw new OperatingProfileError('Provide a code, name, current version and a reason of 5–500 characters.')
  let definition: OperatingProfileDefinition
  try { definition = validateOperatingProfile(input.definition) } catch (error) { throw new OperatingProfileError((error as Error).message) }
  await checkDefinitionFeatures(tx, orgId, definition)
  return publish(tx, orgId, actorId, { ...input, name: input.name.trim(), reason: input.reason.trim(), definition })
}

/** Resolve new work only. Existing records read their pinned version without consulting today's defaults. */
export async function resolveOperatingProfileForCreate(tx: SqlExecutor, orgId: string, actorId: string, input: { family: WorkFamily; subsidiaryId: string | null; departmentId?: string | null; selection?: string | null }) {
  const departmentId = input.departmentId ?? null
  await acquireOrgFeatureGateLock(tx, orgId)
  if (departmentId) {
    if (!isUuid(departmentId)) throw new OperatingProfileError('Department not found.', 404)
    const department = (await tx.execute<{ subsidiaryId: string | null; subsidiaryIncludeChildren: boolean }>(sql`select subsidiary_id as "subsidiaryId",subsidiary_include_children as "subsidiaryIncludeChildren" from departments where org_id=${orgId} and id=${departmentId} and is_active for share`)).rows[0]
    if (!department) throw new OperatingProfileError('Department not found.', 404)
    const context = await loadSubsidiaryContext(tx, orgId)
    if (department.subsidiaryId !== null && (input.subsidiaryId === null || !restrictionAdmits(context, department.subsidiaryId, department.subsidiaryIncludeChildren, input.subsidiaryId))) throw new OperatingProfileError('Department not found.', 404)
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:operating-assignment:${orgId}:org:${input.family}`},0))`)
  if (departmentId) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:operating-assignment:${orgId}:${departmentId}:${input.family}`},0))`)
  type ScopeChoices = { profileIds: string[]; defaultProfileId: string | null }
  let scope = (await tx.execute<ScopeChoices>(sql`select profile_ids as "profileIds",default_profile_id as "defaultProfileId" from operating_profile_scopes where org_id=${orgId} and family=${input.family} and department_id is not distinct from ${departmentId}::uuid for share`)).rows[0]
  if (!scope && departmentId !== null) scope = (await tx.execute<ScopeChoices>(sql`select profile_ids as "profileIds",default_profile_id as "defaultProfileId" from operating_profile_scopes where org_id=${orgId} and family=${input.family} and department_id is null for share`)).rows[0]
  const assignments = scope?.profileIds ?? []
  let selection = input.selection ?? null
  if (!selection) {
    if (!scope) return { versionId: null, departmentId, definition: null }
    if (!scope.defaultProfileId) throw new OperatingProfileError('Choose a workflow from the available department choices.')
    selection = (await tx.execute<{ id: string }>(sql`select current_version_id as id from operating_profiles where org_id=${orgId} and id=${scope.defaultProfileId} and is_active for share`)).rows[0]?.id ?? null
    if (!selection) throw new OperatingProfileError('The default workflow is unavailable. Choose another workflow.', 409)
  }

  await lockAuthority(tx, orgId, actorId, input.family === 'project' ? 'projects.manage' : 'manufacturing.manage', input.subsidiaryId)
  const preset = OPERATING_PRESETS.find(p => p.key === selection)
  if (preset) {
    if (preset.definition.family !== input.family) throw new OperatingProfileError('Choose a workflow for this kind of work.')
    await checkDefinitionFeatures(tx, orgId, preset.definition)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:operating-profile:${orgId}:${preset.key}`},0))`)
    const existing = (await tx.execute<{ id: string; currentVersionId: string | null; isActive: boolean }>(sql`select id,current_version_id as "currentVersionId",is_active as "isActive" from operating_profiles where org_id=${orgId} and code=${preset.key} for update`)).rows[0]
    if (existing) {
      if (!existing.isActive || !existing.currentVersionId) throw new OperatingProfileError('This workflow is unavailable. Choose another workflow.', 409)
      selection = existing.currentVersionId
    } else {
      if (assignments.length) throw new OperatingProfileError('This department does not offer that workflow. Choose an allowed workflow.')
      selection = (await publish(tx, orgId, actorId, { id: randomUUID(), code: preset.key, name: preset.name, expectedVersion: 0, definition: preset.definition, reason: 'Selected a built-in operating workflow for new work.' })).versionId
    }
  }
  if (!isUuid(selection)) throw new OperatingProfileError('Workflow not found.', 404)
  const version = (await tx.execute<{ id: string; profileId: string; definition: OperatingProfileDefinition }>(sql`select v.id,v.profile_id as "profileId",v.definition from operating_profile_versions v join operating_profiles p on p.org_id=v.org_id and p.id=v.profile_id and p.current_version_id=v.id where v.org_id=${orgId} and v.id=${selection} and v.family=${input.family} and p.is_active for share of p,v`)).rows[0]
  if (!version) throw new OperatingProfileError('This workflow version is no longer current. Refresh the choices before creating work.', 409)
  if (assignments.length && !assignments.includes(version.profileId)) throw new OperatingProfileError('This department does not offer that workflow. Choose an allowed workflow.')
  const definition = validateOperatingProfile(version.definition)
  await checkDefinitionFeatures(tx, orgId, definition)
  return { versionId: version.id, departmentId, definition }
}

export async function readPinnedOperatingProfile(tx: SqlExecutor, orgId: string, versionId: string | null, family: WorkFamily): Promise<OperatingProfileDefinition | null> {
  if (!versionId) return null
  const row = (await tx.execute<{ definition: OperatingProfileDefinition }>(sql`select definition from operating_profile_versions where org_id=${orgId} and id=${versionId} and family=${family}`)).rows[0]
  if (!row) throw new OperatingProfileError('Work not found.', 404)
  return validateOperatingProfile(row.definition)
}
/** A retry retains its create-time version while rechecking today's authority and gates. */
export async function checkPinnedOperatingProfileCommand(tx: SqlExecutor, orgId: string, actorId: string, input: { versionId: string; family: WorkFamily; subsidiaryId: string | null }) {
  await lockAuthority(tx, orgId, actorId, input.family === 'project' ? 'projects.manage' : 'manufacturing.manage', input.subsidiaryId)
  const definition = await readPinnedOperatingProfile(tx, orgId, input.versionId, input.family)
  if (!definition) throw new OperatingProfileError('Work not found.', 404)
  await checkDefinitionFeatures(tx, orgId, definition)
  return definition
}

export async function saveOperatingProfileScope(tx: SqlExecutor, orgId: string, actorId: string, input: { id: string; departmentId: string | null; family: WorkFamily; profileIds: string[]; defaultProfileId: string | null; expectedRevision: number; reason: string }) {
  await lockAuthority(tx, orgId, actorId, 'admin.setup.manage', null, true)
  await acquireOrgFeatureGateLock(tx, orgId)
  if (!await lockAndCheckOrgFeature(tx, orgId, input.family === 'project' ? 'projects' : 'manufacturing')) throw new OperatingProfileError('Work not found.', 404)
  if (!isUuid(input.id) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new OperatingProfileError('Reload the workflow scope before saving.', 409)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:operating-assignment:${orgId}:${input.departmentId ?? 'org'}:${input.family}`},0))`)
  const prior = (await tx.execute<{ id: string; revision: number; department_id: string | null; family: WorkFamily; profile_ids: string[]; default_profile_id: string | null }>(sql`select id,revision,department_id,family,profile_ids,default_profile_id from operating_profile_scopes where org_id=${orgId} and (id=${input.id} or (department_id is not distinct from ${input.departmentId}::uuid and family=${input.family})) order by id for update`)).rows
  if (prior.length > 1 || (prior[0] && prior[0].id !== input.id)) throw new OperatingProfileError('This department already has workflow choices for that work family.', 409)
  const row = prior[0]
  if (row && (row.family !== input.family || row.department_id !== input.departmentId)) throw new OperatingProfileError('Scope identity cannot change. Create another department or work-family scope.')
  if (!['project', 'production'].includes(input.family) || input.profileIds.length === 0 || input.profileIds.length > 100 || input.profileIds.some(id => !isUuid(id)) || new Set(input.profileIds).size !== input.profileIds.length || input.reason.trim().length < 5 || input.reason.trim().length > 500 || (input.defaultProfileId !== null && !input.profileIds.includes(input.defaultProfileId))) throw new OperatingProfileError('Choose distinct workflows, a default from the allowed choices and a reason of 5–500 characters.')
  if (input.departmentId && (!isUuid(input.departmentId) || !(await tx.execute(sql`select id from departments where org_id=${orgId} and id=${input.departmentId} and is_active for share`)).rows[0])) throw new OperatingProfileError('Department not found.', 404)
  for (const id of [...input.profileIds].sort()) {
    const profile = (await tx.execute<{ definition: OperatingProfileDefinition }>(sql`select v.definition from operating_profiles p join operating_profile_versions v on v.org_id=p.org_id and v.id=p.current_version_id where p.org_id=${orgId} and p.id=${id} and p.family=${input.family} and p.is_active for share of p,v`)).rows[0]
    if (!profile) throw new OperatingProfileError('Workflow not found.', 404)
    await checkDefinitionFeatures(tx, orgId, validateOperatingProfile(profile.definition))
  }
  if (row && input.expectedRevision === 0) {
    const replay = (await tx.execute(sql`select id from audit_log where org_id=${orgId} and table_name='operating_profile_scopes' and row_id=${input.id} and action='insert'
      and changes->'after'->'profileIds'=${JSON.stringify(input.profileIds)}::jsonb and changes->'after'->>'defaultProfileId' is not distinct from ${input.defaultProfileId}
      and changes->>'reason'=${input.reason}`)).rows[0]
    if (replay) return { id: row.id, revision: row.revision }
  }
  if ((row?.revision ?? 0) !== input.expectedRevision) throw new OperatingProfileError('Workflow choices changed while you were editing. Reload before saving.', 409)
  const result = row ? await tx.execute(sql`update operating_profile_scopes set profile_ids=${JSON.stringify(input.profileIds)}::jsonb,default_profile_id=${input.defaultProfileId},revision=revision+1,updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${input.id} and revision=${input.expectedRevision} returning id,revision`) :
    await tx.execute(sql`insert into operating_profile_scopes(id,org_id,department_id,family,profile_ids,default_profile_id,created_by,updated_by) values(${input.id},${orgId},${input.departmentId},${input.family},${JSON.stringify(input.profileIds)}::jsonb,${input.defaultProfileId},${actorId},${actorId}) returning id,revision`)
  if (!result.rows[0]) throw new OperatingProfileError('Workflow choices changed while saving.', 409)
  await audit(tx, orgId, actorId, 'operating_profile_scopes', input.id, row ?? null, { departmentId: input.departmentId, family: input.family, profileIds: input.profileIds, defaultProfileId: input.defaultProfileId, revision: Number(result.rows[0].revision) }, input.reason)
  return { id: input.id, revision: Number(result.rows[0].revision) }
}

export async function searchOperatingDepartments(tx:SqlExecutor,orgId:string,actorId:string,family:WorkFamily,q='',selected?:string) {
  const allowed=await lockAuthority(tx,orgId,actorId,family==='project'?'projects.read':'manufacturing.read',null)
  await acquireOrgFeatureGateLock(tx,orgId)
  if(!await lockAndCheckOrgFeature(tx,orgId,family==='project'?'projects':'manufacturing')) throw new OperatingProfileError('Work not found.',404)
  const scope=allowed===null ? sql`` : sql`and (subsidiary_id is null or subsidiary_id=any(${`{${[...allowed].join(',')}}`}::uuid[]))`
  return (await tx.execute<{value:string;label:string}>(sql`select id as value,name as label from departments where org_id=${orgId} and is_active ${scope}
    and (id=${selected ?? null} or name ilike ${'%'+q.trim()+'%'}) order by (id=${selected ?? null}) desc nulls last,name,id limit 50`)).rows
}
