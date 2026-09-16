import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context) } })
const { sql } = await import('drizzle-orm')
const { db, withBypassContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/test-fixtures.ts'
)
type ScratchOrg = { orgId: string }
const { applyFeatureChanges } = await import('../features-admin.ts')
const { getAgentsOverview, listAgentRuns, runSetupAgentNow, saveSetupAgentPolicy } = await import(
  './agents.ts'
)

/**
 * DB proofs for the Agents setup adapters (web/lib/setup/agents.ts): toggling
 * a pack writes the policy row plus the setup audit row through the shared
 * command, reads stay inside the requesting org, and enabling is fenced on
 * the Continuous Close feature switch.
 *
 * New pack keys (collections/…) persist once the agent_key CHECK widening
 * lands; until then the write path is proved on `accounting` (accepted by the
 * current storage CHECK) while reads cover all six registry packs.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

const ENABLE_ACCOUNTING = {
  enabled: true,
  automaticRuns: false,
  cadence: 'daily',
  materialityThreshold: '500',
  detectors: [],
  analysis: {
    rootCauseAnalysis: false,
    recommendations: false,
    narrative: false,
    modelTier: 'fast',
    maxToolSteps: 4,
  },
}

async function policyRow(orgId: string, agentKey: string) {
  return withBypassContext(async () =>
    (
      await db.execute<{ enabled: boolean; materiality_threshold: string }>(sql`
        select enabled, materiality_threshold::text
          from ai_agent_policies
         where org_id = ${orgId} and agent_key = ${agentKey}
      `)
    ).rows[0],
  )
}

async function auditRows(orgId: string, agentKey: string) {
  return withBypassContext(async () =>
    (
      await db.execute<{ action: string; changes: Record<string, unknown> }>(sql`
        select action, changes from audit_log
         where org_id = ${orgId} and table_name = 'ai_agent_policies'
           and changes->>'agentKey' = ${agentKey}
         order by id desc
      `)
    ).rows,
  )
}

test(
  'toggling a pack writes the policy row and the setup audit row',
  { skip: !DB },
  async () => {
    const org = await createScratchOrg()
    try {
      const userId = await createScratchUser(org.orgId, 'Agent Admin', 'admin')
      const policy = await withBypassContext(() =>
        saveSetupAgentPolicy(org.orgId, userId, 'accounting', ENABLE_ACCOUNTING),
      )
      assert.equal(policy.agentKey, 'accounting')
      assert.equal(policy.enabled, true)
      assert.equal(policy.materialityThreshold, '500.0000')

      const row = await policyRow(org.orgId, 'accounting')
      assert.ok(row, 'policy row must exist')
      assert.equal(row.enabled, true)

      const audits = await auditRows(org.orgId, 'accounting')
      assert.ok(audits.length >= 1, 'every policy change must leave audit evidence')
      assert.equal(audits[0]!.action, 'update')
      assert.equal((audits[0]!.changes as { enabled: boolean }).enabled, true)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  },
)

test(
  'overview reads stay inside the requesting org',
  { skip: !DB },
  async (t) => {
    const orgA = await createScratchOrg()
    const orgB = await createScratchOrg()
    t.after(async () => {
      await dropScratchOrg(orgA.orgId)
      await dropScratchOrg(orgB.orgId)
    })
    const userId = await createScratchUser(orgA.orgId, 'Agent Admin', 'admin')
    await withBypassContext(() =>
      saveSetupAgentPolicy(orgA.orgId, userId, 'accounting', ENABLE_ACCOUNTING),
    )

    const [rowsA, rowsB] = await withBypassContext(() =>
      Promise.all([getAgentsOverview(orgA.orgId), getAgentsOverview(orgB.orgId)]),
    )
    // One row per registered pack, even never-configured ones (defaults).
    assert.equal(rowsA.length, 6)
    assert.equal(rowsB.length, 6)
    const accountingA = rowsA.find((row) => row.agentKey === 'accounting')!
    assert.equal(accountingA.policy.enabled, true)
    assert.equal(accountingA.openFindings, 0)
    assert.equal(accountingA.lastRun, null)
    for (const row of rowsB) {
      assert.equal(row.policy.enabled, false, `org B must not see org A's ${row.agentKey} policy`)
      assert.equal(row.openFindings, 0)
    }
  },
)

test(
  'run-now records a manual run the activity read model returns',
  { skip: !DB },
  async () => {
    const org = await createScratchOrg()
    try {
      const userId = await createScratchUser(org.orgId, 'Agent Admin', 'admin')
      await withBypassContext(() =>
        saveSetupAgentPolicy(org.orgId, userId, 'accounting', ENABLE_ACCOUNTING),
      )
      const result = await withBypassContext(() => runSetupAgentNow(org.orgId, userId, 'accounting'))
      assert.equal(result.status, 'completed')

      const activity = await withBypassContext(() => listAgentRuns(org.orgId, {}))
      assert.equal(activity.total, 1)
      assert.equal(activity.truncated, false)
      assert.equal(activity.runs[0]!.agentKey, 'accounting')
      assert.equal(activity.runs[0]!.trigger, 'manual')
      assert.equal(activity.runs[0]!.status, 'completed')
      assert.ok(activity.runs[0]!.durationMs !== null)

      const overview = await withBypassContext(() => getAgentsOverview(org.orgId))
      const lastRun = overview.find((row) => row.agentKey === 'accounting')!.lastRun
      assert.ok(lastRun, 'overview must surface the latest run')
      assert.equal(lastRun.status, 'completed')
    } finally {
      await dropScratchOrg(org.orgId)
    }
  },
)

test(
  'enabling a pack while the module is off is refused',
  { skip: !DB },
  async (t) => {
    const org: ScratchOrg = await createScratchOrg()
    t.after(async () => {
      await dropScratchOrg(org.orgId)
    })
    const userId = await createScratchUser(org.orgId, 'Agent Admin', 'admin')
    const toggled = await applyFeatureChanges(org.orgId, userId, { continuousClose: false })
    assert.equal(toggled.ok, true, 'the module switch itself must work on a scratch org')
    await assert.rejects(
      withBypassContext(() => saveSetupAgentPolicy(org.orgId, userId, 'accounting', ENABLE_ACCOUNTING)),
      /feature_disabled/,
      'a pack whose module is off cannot be enabled',
    )
    assert.equal(await policyRow(org.orgId, 'accounting'), undefined)
  },
)

test(
  'unknown agent keys are rejected before any write',
  { skip: !DB },
  async () => {
    const org = await createScratchOrg()
    try {
      const userId = await createScratchUser(org.orgId, 'Agent Admin', 'admin')
      await assert.rejects(
        withBypassContext(() => saveSetupAgentPolicy(org.orgId, userId, 'nope', ENABLE_ACCOUNTING)),
        /invalid_agent/,
      )
      assert.throws(() => runSetupAgentNow(org.orgId, userId, 'nope'), /invalid_agent/)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  },
)
