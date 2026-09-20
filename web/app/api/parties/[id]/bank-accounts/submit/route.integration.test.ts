import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../../../lib/auth'

/**
 * F-t04-004 residual: vendor bank accounts that have NO flow run at all —
 * created before the 'Vendor bank details' flow existed — sit at
 * 'Pending approval' forever. The engine never saw them (no run, no gate),
 * so they never appear in the approvals centre; the Approvals dialog claims
 * 'No approvals required'; and Edit-then-Save 409s because the party payload
 * returns a millisecond-truncated updated_at the OCC guard cannot accept.
 *
 * A record whose status claims it is awaiting approval must have exactly one
 * truthful path forward: submit it into the current flow (POST .../submit),
 * which re-drives the creation-side trigger against current values. When no
 * enabled flow listens, the submit refuses with a typed message instead of
 * silently leaving the record pending.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __bankSubmitUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__bankSubmitUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { isDocumentRevisionToken } = await import('@openbooks/engine/src/records/revision.ts')
const { encryptAccountNumber } = await import('@openbooks/engine/src/payments/payments.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg, seedFlowActors, seedApprovalFlow } =
  await import('@openbooks/engine/src/testing/fixtures.ts')
const { decideGate } = await import('@openbooks/engine/src/flows/gates.ts')
const { POST: submit } = await import('./route')
const { GET: getParty } = await import('../../route')
const { PATCH: patchAccount } = await import('../route')

const paramsFor = (partyId: string): { params: Promise<{ id: string }> } => ({
  params: Promise.resolve({ id: partyId }),
})
const submitRequest = (partyId: string, accountId: string) =>
  new Request(`http://bank.local/api/parties/${partyId}/bank-accounts/submit?accountId=${accountId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })

function asUser(id: string, orgId: string, name: string): SessionUser {
  return {
    id, orgId, name, email: `${name}@scratch.test`, roles: [], isSuperAdmin: false,
    envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: id,
  }
}

async function runCount(orgId: string, accountId: string): Promise<number> {
  return withBypassContext(async () =>
    Number(
      (await db.execute<{ count: string }>(
        sql`select count(*)::text as count from flow_runs where org_id = ${orgId} and subject_id = ${accountId}`,
      )).rows[0]!.count,
    ),
  )
}

test('a pre-flow bank account submits into the current flow exactly once', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId))
    const manager = actors.submitterId
    const approver = actors.approver1Id
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions = '["parties.read","parties.manage"]'::jsonb where org_id = ${org.orgId} and key = 'accountant'`)
    })
    const accountId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into party_bank_accounts
          (id, org_id, party_id, bank_name, country, currency, routing,
           account_number_encrypted, account_last_four,
           approval_status, is_active, approved_at, approved_by,
           submitted_by, submitted_at, created_by, updated_by)
        values (${accountId}, ${org.orgId}, ${org.vendorId}, 'Pre-flow Bank', 'CA', 'CAD', '{}'::jsonb,
                ${encryptAccountNumber('123456789')}, '6789',
                'pending', false, null, null,
                ${manager}, now(), ${manager}, ${manager})`)
    })
    const params = paramsFor(org.vendorId)
    state.user = asUser(manager, org.orgId, 'manager')

    // The stranded precondition: pending, and the engine has never seen it.
    assert.equal(await runCount(org.orgId, accountId), 0)

    // With no enabled flow, submit refuses truthfully — no phantom run.
    const noFlow = await withOrgContext(org.orgId, () =>
      submit(submitRequest(org.vendorId, accountId), params))
    assert.equal(noFlow.status, 422, JSON.stringify(await noFlow.clone().json()))
    assert.match(((await noFlow.json()) as { error: string }).error, /no enabled approval flow/)
    assert.equal(await runCount(org.orgId, accountId), 0)

    // The tenant authors the creation-side flow; submit drives it now.
    await withBypassContext(() =>
      seedApprovalFlow(org.orgId, {
        subjectKind: 'party_bank_account',
        trigger: 'on_create',
        assignees: [{ type: 'user', userId: approver }],
        mode: 'any',
      }),
    )
    const submitted = await withOrgContext(org.orgId, () =>
      submit(submitRequest(org.vendorId, accountId), params))
    assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()))
    const submittedBody = (await submitted.json()) as { id: string; approvalStatus: string; runId: string; gatesCreated: number }
    assert.equal(submittedBody.id, accountId)
    assert.equal(submittedBody.approvalStatus, 'pending')
    assert.equal(submittedBody.gatesCreated, 1)

    // The record is now genuinely in a flow: exactly one live gate.
    const gates = await withBypassContext(async () =>
      (await db.execute<{ id: string; status: string }>(
        sql`select id, status from flow_gates where org_id = ${org.orgId} and subject_id = ${accountId} order by created_at`,
      )).rows,
    )
    assert.equal(gates.length, 1)
    assert.equal(gates[0]!.status, 'pending')

    // A second submit is a lifecycle refusal, not a second gate.
    const resubmit = await withOrgContext(org.orgId, () =>
      submit(submitRequest(org.vendorId, accountId), params))
    assert.equal(resubmit.status, 409, JSON.stringify(await resubmit.clone().json()))
    assert.match(((await resubmit.json()) as { error: string }).error, /already awaiting approval/)
    assert.equal(
      (await withBypassContext(async () =>
        (await db.execute<{ count: string }>(
          sql`select count(*)::text as count from flow_gates where org_id = ${org.orgId} and subject_id = ${accountId} and status = 'pending'`,
        )).rows[0]!.count,
      )),
      '1',
    )

    // The submitted gate approves cleanly through the engine release.
    state.user = asUser(approver, org.orgId, 'approver')
    const decision = await withBypassContext(() =>
      decideGate({ gateId: gates[0]!.id, decision: 'approved', userId: approver }),
    )
    assert.equal(decision.runStatus, 'completed')
    const released = await withBypassContext(async () =>
      (await db.execute<{ approvalStatus: string; isActive: boolean }>(
        sql`select approval_status as "approvalStatus", is_active as "isActive" from party_bank_accounts where id = ${accountId} and org_id = ${org.orgId}`,
      )).rows[0]!,
    )
    assert.equal(released.approvalStatus, 'approved')
    assert.equal(released.isActive, true)

    // An approved record is no longer submittable.
    state.user = asUser(manager, org.orgId, 'manager')
    const afterApproval = await withOrgContext(org.orgId, () =>
      submit(submitRequest(org.vendorId, accountId), params))
    assert.equal(afterApproval.status, 422, JSON.stringify(await afterApproval.clone().json()))
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('the party payload carries a submittable revision token for bank accounts', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const manager = await withBypassContext(() => createScratchUser(org.orgId, 'Token manager', 'bank_token_manager'))
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions = '["parties.read","parties.manage"]'::jsonb where org_id = ${org.orgId} and key = 'bank_token_manager'`)
      await db.execute(sql`
        insert into party_bank_accounts
          (id, org_id, party_id, bank_name, country, currency, routing,
           account_number_encrypted, account_last_four,
           approval_status, is_active, approved_at, approved_by,
           submitted_by, submitted_at, created_by, updated_by)
        values (${randomUUID()}, ${org.orgId}, ${org.vendorId}, 'Token Bank', 'CA', 'CAD', '{}'::jsonb,
                ${encryptAccountNumber('987654321')}, '4321',
                'pending', false, null, null,
                ${manager}, now(), ${manager}, ${manager})`)
    })
    state.user = asUser(manager, org.orgId, 'manager')

    // The drawer edits with the token the party payload publishes: the two
    // sides must agree, or every Edit-then-Save 409s beyond any reload.
    const party = await withOrgContext(org.orgId, () =>
      getParty(
        new Request(`http://bank.local/api/parties/${org.vendorId}`),
        { params: Promise.resolve({ id: org.vendorId }) },
      ),
    )
    assert.equal(party.status, 200)
    const payload = (await party.json()) as { bankAccounts: Array<{ id: string; updated_at: string }> }
    const published = payload.bankAccounts[0]?.updated_at
    assert.ok(published, 'the party payload must publish a bank-account revision')
    assert.ok(
      isDocumentRevisionToken(published),
      `bank-account revision must be submittable, got ${JSON.stringify(published)}`,
    )

    const saved = await withOrgContext(org.orgId, () =>
      patchAccount(
        new Request(`http://bank.local/api/parties/${org.vendorId}/bank-accounts?accountId=${payload.bankAccounts[0]!.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bankName: 'Token Bank Updated',
            changeReason: 'correct the bank name',
            expectedUpdatedAt: published,
          }),
        }),
        { params: Promise.resolve({ id: org.vendorId }) },
      ),
    )
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()))
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
