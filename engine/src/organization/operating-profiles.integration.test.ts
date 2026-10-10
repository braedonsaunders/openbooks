import {readWorkListPresentation,saveWorkListPresentation} from './list-presentation.ts'
import {readWorkListFilters,workProfileFilter,workDepartmentFilter} from './work-list-filters.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, type SqlExecutor } from '../platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '../testing/fixtures.ts'
import { createWorkOperator } from '../testing/manufacturing.ts'
import { errorChainMatches } from '../testing/error-chain.ts'
import { createProject } from '../projects/project-create.ts'
import { OPERATING_PRESETS, type OperatingProfileDefinition } from './operating-profile-model.ts'
import { listOperatingProfileChoices, publishOperatingProfile, readPinnedOperatingProfile, resolveOperatingProfileForCreate, saveOperatingProfileScope } from './operating-profiles.ts'
const DB = Boolean(process.env.OPENBOOKS_DB_URL)
const transaction = <T>(work: (tx: SqlExecutor) => Promise<T>) => withBypassContext(() => db.transaction(work))
const shop = OPERATING_PRESETS.find(p => p.key === 'shop_jobs')!
const services = OPERATING_PRESETS.find(p => p.key === 'professional_services')!

test('operating compositions keep native work and historical versions while department defaults govern new work', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actorId = await withBypassContext(() => createWorkOperator(org.orgId, 'Operations administrator', ['admin.setup.manage','projects.read','projects.manage']))
    const first = await transaction(tx => publishOperatingProfile(tx, org.orgId, actorId, { id: randomUUID(), code: 'shop', name: 'Shop jobs', definition: shop.definition, expectedVersion: 0, reason: 'Offer simple shop jobs.' }))
    const engagement = await transaction(tx => publishOperatingProfile(tx, org.orgId, actorId, { id: randomUUID(), code: 'services', name: 'Engagements', definition: services.definition, expectedVersion: 0, reason: 'Offer professional engagements.' }))
    const department = (await transaction(tx => tx.execute<{ id: string }>(sql`insert into departments(org_id,name,subsidiary_id) values(${org.orgId},'Delivery',${org.subsidiaryId}) returning id`))).rows[0]!
    const scope = { id: randomUUID(), departmentId: department.id, family: 'project' as const, profileIds: [first.id, engagement.id], defaultProfileId: first.id, expectedRevision: 0, reason: 'Shop is the default for new delivery work.' }
    await transaction(tx => saveOperatingProfileScope(tx, org.orgId, actorId, scope))
    const resolved = await transaction(tx => resolveOperatingProfileForCreate(tx, org.orgId, actorId, { family: 'project', subsidiaryId: org.subsidiaryId, departmentId: department.id }))
    assert.equal(resolved.versionId, first.versionId)
    const request = { name: 'Customer weldment', subsidiaryId: org.subsidiaryId, operatingDepartmentId: department.id }
    const context = { orgId: org.orgId, actorId, allowedSubsidiaryIds: null }
    const id = randomUUID()
    assert.equal((await withBypassContext(() => createProject(context, id, request))).created, true)
    const revised: OperatingProfileDefinition = structuredClone(shop.definition); revised.capture = 'tasks'
    const next = await transaction(tx => publishOperatingProfile(tx, org.orgId, actorId, { id: first.id, code: 'shop', name: 'Shop jobs', definition: revised, expectedVersion: 1, reason: 'Offer optional detailed job planning.' }))
    assert.equal(next.version, 2)
    const secondId=randomUUID();
    await withBypassContext(()=>createProject(context,secondId,{...request,name:'Another customer weldment'}));
    const filters=await transaction(tx=>readWorkListFilters(tx,org.orgId,actorId,'project'));
    assert(filters.profiles.some(row=>row.value===first.id));assert(filters.departments.some(row=>row.value===department.id));
    const matching=await transaction(tx=>tx.execute<{id:string}>(sql`select id from projects where org_id=${org.orgId} and ${workProfileFilter(sql`org_id`,sql`operating_profile_version_id`,first.id)} and ${workDepartmentFilter(sql`operating_department_id`,department.id)} order by id`));
    assert.deepEqual(matching.rows.map(row=>row.id).sort(),[id,secondId].sort(),'one workflow queue includes pinned older and newer revisions');
    assert.equal((await transaction(tx=>tx.execute(sql`select id from projects where org_id=${org.orgId} and ${workProfileFilter(sql`org_id`,sql`operating_profile_version_id`,engagement.id)}`))).rows.length,0);

    assert.equal((await withBypassContext(() => createProject(context, id, request))).created, false, 'replay keeps the original default version')
    const saved = (await transaction(tx => tx.execute<{ operating_profile_version_id: string; project_type_id: string | null }>(sql`select operating_profile_version_id,project_type_id from projects where org_id=${org.orgId} and id=${id}`))).rows[0]!
    assert.equal(saved.operating_profile_version_id, first.versionId)
    assert.equal(saved.project_type_id, null, 'operating composition does not invent a financial project type')
    assert.equal((await transaction(tx => readPinnedOperatingProfile(tx, org.orgId, first.versionId, 'project')))?.capture, 'job')
    assert.equal((await transaction(tx => resolveOperatingProfileForCreate(tx, org.orgId, actorId, { family: 'project', subsidiaryId: org.subsidiaryId, departmentId: department.id }))).versionId, next.versionId)
    await assert.rejects(transaction(tx => resolveOperatingProfileForCreate(tx, org.orgId, actorId, { family: 'production', subsidiaryId: org.subsidiaryId, selection: engagement.versionId })))
    await assert.rejects(transaction(tx => tx.execute(sql`update operating_profile_versions set definition='{}'::jsonb where org_id=${org.orgId} and id=${first.versionId}`)), error => errorChainMatches(error, /Published operating profiles are immutable; publish a new version/))
    const counts = async () => (await transaction(tx => tx.execute(sql`select (select count(*) from projects where org_id=${org.orgId}) as projects,(select count(*) from audit_log where org_id=${org.orgId}) as audits`))).rows[0]
    const before = await counts()
    await transaction(tx => tx.execute(sql`update app_roles set permissions='["projects.read"]'::jsonb where org_id=${org.orgId} returning id`))
    await assert.rejects(withBypassContext(() => createProject(context, id, request)), /not found/i)
    await assert.rejects(transaction(tx => resolveOperatingProfileForCreate(tx, org.orgId, actorId, { family: 'project', subsidiaryId: org.subsidiaryId, selection: next.versionId })), /not found/i)
    assert.deepEqual(await counts(), before, 'revoked grants refuse replay and new work without effects')
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})

test('operating profile catalogs hide disabled captures and refuse cross-tenant versions without materializing presets', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg()), foreign = await withBypassContext(() => createScratchOrg())
  try {
    const actorId = await withBypassContext(() => createWorkOperator(org.orgId, 'Operations administrator', ['admin.setup.manage','projects.read','projects.manage']))
    const otherActor = await withBypassContext(() => createWorkOperator(foreign.orgId, 'Other administrator', ['admin.setup.manage','projects.read','projects.manage']))
    const choices = await transaction(tx => listOperatingProfileChoices(tx, org.orgId, actorId, 'project'))
    assert(choices.some(c => c.value === 'shop_jobs'))
    assert(!choices.some(c => c.value === 'field_work'))
    assert.equal((await transaction(tx => tx.execute<{ n: number }>(sql`select count(*)::int as n from operating_profiles where org_id=${org.orgId}`))).rows[0]?.n, 0, 'opening cards writes nothing')
    const other = await transaction(tx => publishOperatingProfile(tx, foreign.orgId, otherActor, { id: randomUUID(), code: 'other', name: 'Other', definition: shop.definition, expectedVersion: 0, reason: 'Configure another company.' }))
    await assert.rejects(transaction(tx => resolveOperatingProfileForCreate(tx, org.orgId, actorId, { family: 'project', subsidiaryId: org.subsidiaryId, selection: other.versionId })))
    await assert.rejects(transaction(tx => resolveOperatingProfileForCreate(tx, org.orgId, actorId, { family: 'project', subsidiaryId: org.subsidiaryId, selection: 'field_work' })))
    const first = await transaction(tx => resolveOperatingProfileForCreate(tx, org.orgId, actorId, { family: 'project', subsidiaryId: org.subsidiaryId, selection: 'shop_jobs' }))
    assert.equal(first.definition?.capture, 'job')
    await transaction(tx => tx.execute(sql`update orgs set settings=jsonb_set(settings,'{features,projects}','false'::jsonb,true) where id=${org.orgId} returning id`))
    await assert.rejects(transaction(tx => resolveOperatingProfileForCreate(tx, org.orgId, actorId, { family: 'project', subsidiaryId: org.subsidiaryId, selection: first.versionId })))
    assert.equal((await transaction(tx => readPinnedOperatingProfile(tx, org.orgId, first.versionId, 'project')))?.capture, 'job', 'disabling preserves configuration and historical definitions')
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); await withBypassContext(() => dropScratchOrg(foreign.orgId)) }
})

test('personal work presentation preserves saved-view selection and requires fresh tenant authority', {skip:!DB},async()=>{
  const org=await withBypassContext(()=>createScratchOrg()),foreign=await withBypassContext(()=>createScratchOrg());
  try {
    const actor=await withBypassContext(()=>createWorkOperator(org.orgId,'Work operator',['admin.setup.manage','projects.read','projects.manage']));
    const other=await withBypassContext(()=>createWorkOperator(foreign.orgId,'Other operator',['admin.setup.manage','projects.read','projects.manage']));
    assert.equal(await transaction(tx=>readWorkListPresentation(tx,org.orgId,actor,'project')),null);
    await transaction(tx=>saveWorkListPresentation(tx,org.orgId,actor,'project','board'));
    const preference=async()=> (await transaction(tx=>tx.execute<{view_id:string|null;presentation:string|null;view_selection_explicit:boolean}>(sql`select view_id,presentation,view_selection_explicit from user_list_preferences where org_id=${org.orgId} and user_id=${actor} and record_type='project'`))).rows[0];
    assert.deepEqual(await preference(),{view_id:null,presentation:'board',view_selection_explicit:false},'presentation alone does not override a personal default');
    const view=randomUUID();
    await transaction(tx=>tx.execute(sql`insert into list_views(id,org_id,record_type,name,scope,owner_id,config,is_default) values(${view},${org.orgId},'project','My jobs','user',${actor},'{}'::jsonb,true) returning id`));
    await transaction(tx=>tx.execute(sql`update user_list_preferences set view_id=${view},view_selection_explicit=true where org_id=${org.orgId} and user_id=${actor} and record_type='project' returning id`));
    await transaction(tx=>saveWorkListPresentation(tx,org.orgId,actor,'project','list'));
    assert.deepEqual(await preference(),{view_id:view,presentation:'list',view_selection_explicit:true});
    await transaction(tx=>saveWorkListPresentation(tx,org.orgId,actor,'project',null));
    assert.deepEqual(await preference(),{view_id:view,presentation:null,view_selection_explicit:true});
    await assert.rejects(transaction(tx=>saveWorkListPresentation(tx,org.orgId,other,'project','board')));
    await assert.rejects(transaction(tx=>saveWorkListPresentation(tx,org.orgId,randomUUID(),'project','board')));
    await transaction(tx=>tx.execute(sql`update app_roles set permissions='[]'::jsonb where org_id=${org.orgId} returning id`));
    await assert.rejects(transaction(tx=>saveWorkListPresentation(tx,org.orgId,actor,'project','board')));
    await assert.rejects(transaction(tx=>readWorkListPresentation(tx,org.orgId,actor,'project')));
    assert.deepEqual(await preference(),{view_id:view,presentation:null,view_selection_explicit:true},'refused saves leave the native preference intact');
  }finally{await withBypassContext(()=>dropScratchOrg(org.orgId));await withBypassContext(()=>dropScratchOrg(foreign.orgId))}
})
