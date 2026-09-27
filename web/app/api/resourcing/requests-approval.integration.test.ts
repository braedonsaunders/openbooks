import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

const session: { user: unknown } = { user: null }
Object.assign(globalThis, { __resourceRequestApprovalSession: session })
const sessionStub = {
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent(`
    export async function currentUser() { return globalThis.__resourceRequestApprovalSession.user }
  `),
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return sessionStub
    return next(specifier, context)
  },
})

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrgReporting, seedApprovalFlow, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { installEngineSeams } = await import('@openbooks/engine/src/composition/install.ts')
const { POST: createRequest } = await import('./requests/route.ts')
const { PATCH: updateRequest } = await import('./requests/[id]/route.ts')
const { POST: submitRequest } = await import('./requests/[id]/submit/route.ts')
const { GET: recordState } = await import('../flows/record-state/route.ts')
const { GET: worklist } = await import('../flows/gates/route.ts')
const { POST: decide } = await import('../flows/gates/decide/route.ts')

type Handler = (request: Request, context?: { params?: Promise<unknown> }) => Promise<Response>
const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

test('resource requests submit and resolve through subsidiary-scoped Flows', enabled, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  let foreignOrg: Awaited<ReturnType<typeof createScratchOrg>> | null = null
  try {
    foreignOrg = await withBypassContext(() => createScratchOrg())
    const setup = await withBypassContext(async () => {
      const actors = await seedFlowActors(org.orgId)
      const secondSubsidiary = randomUUID(), projectA = randomUUID(), projectB = randomUUID(), employeeId = randomUUID(), offDraftId = randomUUID()
      const subsidiary = await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom) values (${secondSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Other Company', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb) returning id`)
      assert.equal(subsidiary.rowCount, 1)
      const employee = await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${employeeId}, ${org.orgId}, 'person', 'Consultant', ${org.subsidiaryId}, true, '{}'::jsonb) returning id`)
      assert.equal(employee.rowCount, 1)
      const role = await db.execute(sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${org.orgId}, ${employeeId}, 'Consultant', '2026-01-01', true) returning party_id`)
      assert.equal(role.rowCount, 1)
      const field = await db.execute(sql`insert into custom_field_defs (org_id, target_table, key, label, field_type, config, is_required, sort_order, is_active, created_by, updated_by) values (${org.orgId}, 'res_requests', 'engagement_code', 'Engagement code', 'text', '{}'::jsonb, true, 0, true, ${actors.submitterId}, ${actors.submitterId}) returning id`)
      assert.equal(field.rowCount, 1)
      const referenceField = await db.execute(sql`insert into custom_field_defs (org_id, target_table, key, label, field_type, config, is_required, sort_order, is_active, created_by, updated_by) values (${org.orgId}, 'res_requests', 'stakeholder', 'Stakeholder', 'reference', '{"referenceTable":"parties"}'::jsonb, false, 1, true, ${actors.submitterId}, ${actors.submitterId}) returning id`)
      assert.equal(referenceField.rowCount, 1)
      const features = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true,"resourceRequests":true,"flows":true}'::jsonb) where id = ${org.orgId} returning id`)
      assert.equal(features.rowCount, 1)
      const submitterRole = await db.execute(sql`update app_roles set permissions = permissions || '["resourcing.manage","resourcing.read"]'::jsonb where org_id = ${org.orgId} and key = 'accountant' returning id`)
      assert.equal(submitterRole.rowCount, 1)
      const approverRole = await db.execute(sql`update app_roles set permissions = permissions || '["resourcing.read"]'::jsonb, subsidiary_restriction = jsonb_build_object('mode', 'list', 'subsidiaryIds', ${JSON.stringify([org.subsidiaryId])}::jsonb) where org_id = ${org.orgId} and key = 'approver' returning id`)
      assert.equal(approverRole.rowCount, 1)
      for (const [id, subsidiary, code] of [[projectA, org.subsidiaryId, 'A'], [projectB, secondSubsidiary, 'B']] as const) {
        const result = await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom) values (${id}, ${org.orgId}, ${subsidiary}, ${`RQ-${code}-${id.slice(0, 6)}`}, ${`Request project ${code}`}, ${org.customerId}, 'active', true, '{}'::jsonb) returning id`)
        assert.equal(result.rowCount, 1)
      }
      const offDraft = await db.execute(sql`insert into res_requests (id, org_id, project_id, employee_party_id, first_week, last_week, hours_per_week, status, created_by, updated_by) values (${offDraftId}, ${org.orgId}, ${projectA}, ${employeeId}, '2026-10-04', '2026-10-04', '8.0000', 'draft', ${actors.submitterId}, ${actors.submitterId}) returning id`)
      assert.equal(offDraft.rowCount, 1)
      return { ...actors, secondSubsidiary, projectA, projectB, employeeId, offDraftId }
    })
    await withBypassContext(() => seedApprovalFlow(org.orgId, { subjectKind: 'resourcing_request', assignees: [{ type: 'user', userId: setup.approver1Id }], mode: 'any' }))
    installEngineSeams()
    const setSessionUser = (userId: string, role: string) => {
      session.user = {
        id: userId, email: `${role}@resource.test`, name: role, orgId: org.orgId,
        roles: [{ key: role, name: role }], envKind: 'production', productionOrgId: org.orgId,
        isSuperAdmin: false, homeUserId: userId, homeOrgId: org.orgId,
      }
    }
    const call = async (handler: Handler, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, id?: string) => {
      const request = new Request(`http://resource.test${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
      const response = await withOrgContext(org.orgId, () => handler(request, id ? { params: Promise.resolve({ id }) } : { params: Promise.resolve({}) }))
      const text = await response.text()
      return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> }
    }
    const requestBody = (projectId: string, target: { employeePartyId: string } | { jobTitle: string }, custom?: Record<string, unknown>) => ({
      projectId, ...target, firstWeek: '2026-10-04', lastWeek: '2026-10-11', hoursPerWeek: '8.0000', isBillable: true, reason: 'project staffing', ...(custom ? { custom } : {}),
    })

    setSessionUser(setup.submitterId, 'accountant')
    await withBypassContext(() => db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,resourceRequests}', 'false'::jsonb) where id = ${org.orgId} returning id`))
    const disabled = await call(submitRequest, `/api/resourcing/requests/${setup.offDraftId}/submit`, 'POST', undefined, {}, setup.offDraftId)
    assert.deepEqual({ status: disabled.status, json: disabled.json }, { status: 404, json: { error: 'not_found' } })
    await withBypassContext(() => db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,resourceRequests}', 'true'::jsonb) where id = ${org.orgId} returning id`))

    const missingCustom = await call(createRequest, '/api/resourcing/requests', 'POST', requestBody(setup.projectA, { employeePartyId: setup.employeeId }), { 'Idempotency-Key': randomUUID() })
    assert.equal(missingCustom.status, 422)
    assert.deepEqual(missingCustom.json.fieldErrors, { engagement_code: ['Engagement code is required'] })
    const unknownCustomCreate = await call(createRequest, '/api/resourcing/requests', 'POST', requestBody(setup.projectA, { employeePartyId: setup.employeeId }, { engagement_code: 'VALID', undeclared_field: 'value' }), { 'Idempotency-Key': randomUUID() })
    assert.equal(unknownCustomCreate.status, 422)
    assert.equal(unknownCustomCreate.json.error, 'unknown custom field: undeclared_field')
    const foreignReferenceCreate = await call(createRequest, '/api/resourcing/requests', 'POST', requestBody(setup.projectA, { employeePartyId: setup.employeeId }, { engagement_code: 'FOREIGN', stakeholder: foreignOrg.customerId }), { 'Idempotency-Key': randomUUID() })
    assert.equal(foreignReferenceCreate.status, 422)
    assert.deepEqual(foreignReferenceCreate.json.fieldErrors, { stakeholder: ['Stakeholder references a record that is not available in this organization'] })
    const key = randomUUID()
    const created = await call(createRequest, '/api/resourcing/requests', 'POST', requestBody(setup.projectA, { employeePartyId: setup.employeeId }, { engagement_code: 'INIT' }), { 'Idempotency-Key': key })
    assert.equal(created.status, 201, JSON.stringify(created.json))
    const requestId = String(created.json.id)
    const changedReplay = await call(createRequest, '/api/resourcing/requests', 'POST', requestBody(setup.projectA, { employeePartyId: setup.employeeId }, { engagement_code: 'DIFFERENT' }), { 'Idempotency-Key': key })
    assert.equal(changedReplay.status, 409)
    assert.equal(changedReplay.json.code, 'idempotency_key_conflict')
    const unknownCustomPatch = await call(updateRequest, `/api/resourcing/requests/${requestId}`, 'PATCH', requestBody(setup.projectA, { employeePartyId: setup.employeeId }, { undeclared_field: 'value' }), {}, requestId)
    assert.equal(unknownCustomPatch.status, 422)
    assert.equal(unknownCustomPatch.json.error, 'unknown custom field: undeclared_field')
    const foreignReferencePatch = await call(updateRequest, `/api/resourcing/requests/${requestId}`, 'PATCH', requestBody(setup.projectA, { employeePartyId: setup.employeeId }, { engagement_code: 'UPDATED', stakeholder: foreignOrg.customerId }), {}, requestId)
    assert.equal(foreignReferencePatch.status, 422)
    assert.deepEqual(foreignReferencePatch.json.fieldErrors, { stakeholder: ['Stakeholder references a record that is not available in this organization'] })
    const patched = await call(updateRequest, `/api/resourcing/requests/${requestId}`, 'PATCH', requestBody(setup.projectA, { employeePartyId: setup.employeeId }, { engagement_code: 'UPDATED' }), {}, requestId)
    assert.equal(patched.status, 200, JSON.stringify(patched.json))
    const partialPatch = await call(updateRequest, `/api/resourcing/requests/${requestId}`, 'PATCH', requestBody(setup.projectA, { employeePartyId: setup.employeeId }, { stakeholder: org.customerId }), {}, requestId)
    assert.equal(partialPatch.status, 200, JSON.stringify(partialPatch.json))
    const customValue = await withBypassContext(() => db.execute<{ engagement_code: string; stakeholder: string }>(sql`select custom->>'engagement_code' as engagement_code, custom->>'stakeholder' as stakeholder from res_requests where org_id = ${org.orgId} and id = ${requestId}`))
    assert.deepEqual(customValue.rows[0], { engagement_code: 'UPDATED', stakeholder: org.customerId })
    const submitted = await call(submitRequest, `/api/resourcing/requests/${requestId}/submit`, 'POST', undefined, {}, requestId)
    assert.equal(submitted.status, 200, JSON.stringify(submitted.json))
    assert.equal(submitted.json.status, 'submitted')
    const gateId = String((await withBypassContext(() => db.execute<{ id: string }>(sql`select id from flow_gates where org_id = ${org.orgId} and subject_kind = 'resourcing_request' and subject_id = ${requestId} and status = 'pending'`))).rows[0]?.id)

    setSessionUser(setup.approver1Id, 'approver')
    const history = await call(recordState, `/api/flows/record-state?subjectKind=resourcing_request&subjectId=${requestId}`)
    assert.equal(history.status, 200, JSON.stringify(history.json))
    const visible = await call(worklist, '/api/flows/gates')
    assert.equal(visible.status, 200)
    assert.ok((visible.json.gates as { id: string }[]).some((gate) => gate.id === gateId))
    const decision = await call(decide, '/api/flows/gates/decide', 'POST', { gateId, decision: 'approved', comment: 'Approved for staffing' })
    assert.equal(decision.status, 200, JSON.stringify(decision.json))
    const booked = await withBypassContext(() => db.execute<{ week_start: string; booking: string; source: string; count: string }>(sql`select week_start::text, min(booking) as booking, min(source) as source, count(*)::text as count from res_assignments where org_id = ${org.orgId} and request_id = ${requestId} group by week_start order by week_start`))
    assert.deepEqual(booked.rows, [
      { week_start: '2026-10-04', booking: 'hard', source: 'request', count: '1' },
      { week_start: '2026-10-11', booking: 'hard', source: 'request', count: '1' },
    ])

    setSessionUser(setup.submitterId, 'accountant')
    const outsideCreated = await call(createRequest, '/api/resourcing/requests', 'POST', requestBody(setup.projectB, { jobTitle: 'Consultant' }, { engagement_code: 'OTHER' }), { 'Idempotency-Key': randomUUID() })
    assert.equal(outsideCreated.status, 201, JSON.stringify(outsideCreated.json))
    const outsideId = String(outsideCreated.json.id)
    const outsideSubmitted = await call(submitRequest, `/api/resourcing/requests/${outsideId}/submit`, 'POST', undefined, {}, outsideId)
    assert.equal(outsideSubmitted.status, 200, JSON.stringify(outsideSubmitted.json))
    const outsideGate = String((await withBypassContext(() => db.execute<{ id: string }>(sql`select id from flow_gates where org_id = ${org.orgId} and subject_id = ${outsideId} and status = 'pending'`))).rows[0]?.id)
    setSessionUser(setup.approver1Id, 'approver')
    const restrictedList = await call(worklist, '/api/flows/gates')
    assert.equal(restrictedList.status, 200)
    assert.ok(!(restrictedList.json.gates as { id: string }[]).some((gate) => gate.id === outsideGate))
    const refusedDecision = await call(decide, '/api/flows/gates/decide', 'POST', { gateId: outsideGate, decision: 'approved' })
    assert.equal(refusedDecision.status, 404)
  } finally {
    session.user = null
    await dropScratchOrgReporting(org.orgId)
    if (foreignOrg) await dropScratchOrgReporting(foreignOrg.orgId)
  }
})
