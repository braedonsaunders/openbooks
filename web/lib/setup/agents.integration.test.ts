import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context) } })
const { sql } = await import('drizzle-orm')
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
type ScratchOrg = { orgId: string }
const { applyFeatureChanges } = await import('../features-admin.ts')
const {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  getAgentsOverview,
  getSetupAgentNotification,
  listAgentRuns,
  runSetupAgentNow,
  saveSetupAgentPolicy,
} = await import('./agents.ts')
const { saveOrgAiSettings } = await import('../assistant/ai-config.ts')
const { getOrgAiSettings, normalizeAgentSettingsInput, saveOrgAiAgentSettings } = await import(
  '../assistant/ai-config.ts'
)

/**
 * DB proofs for the Agents setup adapters (web/lib/setup/agents.ts): toggling
 * a pack writes the policy row plus the setup audit row through the shared
 * command, reads stay inside the requesting org, and enabling is fenced on
 * the Continuous Close feature switch.
 *
 * New pack keys (collections/…) persist once the agent_key CHECK widening
 * lands; until then the write path is proved on `accounting` (accepted by the
 * current storage CHECK) while reads cover every registry pack.
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
    // Derived from the registry, never a hardcoded count: the next pack must
    // not break this test.
    assert.equal(rowsA.length, CONTINUOUS_CLOSE_AGENT_KEYS.length)
    assert.equal(rowsB.length, CONTINUOUS_CLOSE_AGENT_KEYS.length)
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
  'the activity list contract pages and sorts server-side',
  { skip: !DB },
  async () => {
    const org = await createScratchOrg()
    try {
      const userId = await createScratchUser(org.orgId, 'Agent Admin', 'admin')
      await withBypassContext(() =>
        saveSetupAgentPolicy(org.orgId, userId, 'accounting', ENABLE_ACCOUNTING),
      )
      for (let i = 0; i < 3; i++) {
        await withBypassContext(() => runSetupAgentNow(org.orgId, userId, 'accounting'))
      }
      const first = await withBypassContext(() => listAgentRuns(org.orgId, { limit: 2 }))
      assert.equal(first.total, 3)
      assert.equal(first.truncated, true)
      assert.equal(first.runs.length, 2)

      const second = await withBypassContext(() => listAgentRuns(org.orgId, { limit: 2, offset: 2 }))
      assert.equal(second.total, 3)
      assert.equal(second.truncated, false)
      assert.equal(second.runs.length, 1)
      assert.ok(!first.runs.some((run) => run.id === second.runs[0]!.id), 'pages must not overlap')

      const desc = await withBypassContext(() => listAgentRuns(org.orgId, {}))
      const asc = await withBypassContext(() => listAgentRuns(org.orgId, { sort: 'started', dir: 'asc' }))
      assert.deepEqual(
        asc.runs.map((run) => run.id),
        [...desc.runs.map((run) => run.id)].reverse(),
        'started asc must reverse started desc',
      )

      const fallback = await withBypassContext(() =>
        listAgentRuns(org.orgId, { sort: 'nope' as never }),
      )
      assert.deepEqual(
        fallback.runs.map((run) => run.id),
        desc.runs.map((run) => run.id),
        'an unknown sort falls back to started desc',
      )
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

function bulkAiInput() {
  return {
    enabled: true,
    provider: 'anthropic' as const,
    modelFast: '',
    modelSmart: '',
    baseUrl: '',
    agents: normalizeAgentSettingsInput([{ agentKey: 'accounting', ...ENABLE_ACCOUNTING }]),
    documentCapture: {
      enabled: false,
      provider: 'azure_document_intelligence' as const,
      endpoint: '',
      model: 'prebuilt-invoice',
      confidenceThreshold: '0.9000',
      autoCreatePoMatchedDrafts: false,
    },
  }
}

test(
  'the legacy pack APIs refuse to enable while the module is off',
  { skip: !DB },
  async (t) => {
    // C3: the two legacy AI admin APIs (per-agent PUT and bulk PUT) used to
    // persist enabled/automaticRuns through the shared ai-config commands
    // without checking the switch. The ONE check now lives in those shared
    // commands, so both refuse by name and persist nothing while off.
    const org: ScratchOrg = await createScratchOrg()
    t.after(async () => {
      await dropScratchOrg(org.orgId)
    })
    const userId = await createScratchUser(org.orgId, 'Agent Admin', 'admin')
    const toggled = await applyFeatureChanges(org.orgId, userId, { continuousClose: false })
    assert.equal(toggled.ok, true, 'the module switch itself must work on a scratch org')

    await assert.rejects(
      withBypassContext(() =>
        saveOrgAiAgentSettings(org.orgId, userId, { agentKey: 'accounting', ...ENABLE_ACCOUNTING }),
      ),
      /feature_disabled/,
      'the per-agent legacy API refuses to enable the pack by name',
    )
    await assert.rejects(
      withBypassContext(() => saveOrgAiSettings(org.orgId, userId, bulkAiInput())),
      /feature_disabled/,
      'the bulk legacy API refuses to enable the pack by name',
    )
    assert.equal(await policyRow(org.orgId, 'accounting'), undefined, 'a refused enable persists nothing')

    // Disabling while off stays allowed — operators can still clean up.
    const disabled = await withBypassContext(() =>
      saveOrgAiAgentSettings(org.orgId, userId, { agentKey: 'accounting', ...ENABLE_ACCOUNTING, enabled: false }),
    )
    assert.equal(disabled.enabled, false)
  },
)

test(
  'a pre-enabled pack does not block provider saves while the module is off',
  { skip: !DB },
  async (t) => {
    // C4: the bulk provider form resubmits every pack's current state, so
    // refusing on ANY submitted enabled flag locked an org with a
    // pre-enabled pack out of unrelated provider settings. Only the
    // TRANSITION to enabled refuses — resubmitting the stored state saves.
    const org: ScratchOrg = await createScratchOrg()
    t.after(async () => {
      await dropScratchOrg(org.orgId)
    })
    const userId = await createScratchUser(org.orgId, 'Agent Admin', 'admin')
    await withBypassContext(() =>
      saveOrgAiAgentSettings(org.orgId, userId, { agentKey: 'accounting', ...ENABLE_ACCOUNTING }),
    )
    assert.equal((await applyFeatureChanges(org.orgId, userId, { continuousClose: false })).ok, true)

    // Single-pack resubmit of the stored enabled state: no transition.
    const resubmitted = await withBypassContext(() =>
      saveOrgAiAgentSettings(org.orgId, userId, { agentKey: 'accounting', ...ENABLE_ACCOUNTING }),
    )
    assert.equal(resubmitted.enabled, true)

    // Bulk provider save with the pack resubmitted unchanged: the provider
    // change persists and the pack stays enabled.
    await withBypassContext(() =>
      saveOrgAiSettings(org.orgId, userId, { ...bulkAiInput(), modelFast: 'x-new-model' }),
    )
    const settings = await withBypassContext(() => getOrgAiSettings(org.orgId))
    assert.equal(settings.modelFast, 'x-new-model', 'the provider change persists while off')
    const row = await policyRow(org.orgId, 'accounting')
    assert.ok(row, 'the pre-enabled pack survives the provider save')
    assert.equal(row.enabled, true)
  },
)

test(
  'switching a pack off then on while the module is off refuses the switch-on',
  { skip: !DB },
  async (t) => {
    // The transition gate in the other direction: disabling while off stays
    // allowed (cleanup), but the subsequent enable is a transition and must
    // refuse by name with nothing persisted.
    const org: ScratchOrg = await createScratchOrg()
    t.after(async () => {
      await dropScratchOrg(org.orgId)
    })
    const userId = await createScratchUser(org.orgId, 'Agent Admin', 'admin')
    await withBypassContext(() =>
      saveOrgAiAgentSettings(org.orgId, userId, { agentKey: 'accounting', ...ENABLE_ACCOUNTING }),
    )
    assert.equal((await applyFeatureChanges(org.orgId, userId, { continuousClose: false })).ok, true)

    const disabled = await withBypassContext(() =>
      saveOrgAiAgentSettings(org.orgId, userId, { agentKey: 'accounting', ...ENABLE_ACCOUNTING, enabled: false }),
    )
    assert.equal(disabled.enabled, false)

    await assert.rejects(
      withBypassContext(() =>
        saveOrgAiAgentSettings(org.orgId, userId, { agentKey: 'accounting', ...ENABLE_ACCOUNTING }),
      ),
      /feature_disabled/,
      're-enabling a disabled pack while off refuses by name',
    )
    await assert.rejects(
      withBypassContext(() => saveOrgAiSettings(org.orgId, userId, bulkAiInput())),
      /feature_disabled/,
      'the bulk form refuses the same transition by name',
    )
    const row = await policyRow(org.orgId, 'accounting')
    assert.ok(row)
    assert.equal(row.enabled, false, 'a refused enable persists nothing')
  },
)

test(
  'the legacy pack APIs save once the module is back on',
  { skip: !DB },
  async (t) => {
    const org: ScratchOrg = await createScratchOrg()
    t.after(async () => {
      await dropScratchOrg(org.orgId)
    })
    const userId = await createScratchUser(org.orgId, 'Agent Admin', 'admin')
    assert.equal((await applyFeatureChanges(org.orgId, userId, { continuousClose: false })).ok, true)
    assert.equal((await applyFeatureChanges(org.orgId, userId, { continuousClose: true })).ok, true)

    const single = await withBypassContext(() =>
      saveOrgAiAgentSettings(org.orgId, userId, { agentKey: 'accounting', ...ENABLE_ACCOUNTING }),
    )
    assert.equal(single.enabled, true, 'the per-agent legacy API saves while on')
    await withBypassContext(() => saveOrgAiSettings(org.orgId, userId, bulkAiInput()))
    const row = await policyRow(org.orgId, 'accounting')
    assert.ok(row, 'the bulk legacy API saves while on')
    assert.equal(row.enabled, true)
  },
)

test(
  'notification routing persists, is left alone when absent, and clears on null',
  { skip: !DB },
  async () => {
    const org = await createScratchOrg()
    try {
      const userId = await createScratchUser(org.orgId, 'Agent Admin', 'admin')
      const roleId = (
        await withBypassContext(
          async () =>
            (
              await db.execute<{ id: string }>(sql`
                select id::text as id from app_roles where org_id = ${org.orgId} order by name limit 1
              `)
            ).rows[0]?.id,
        )
      )!
      assert.ok(roleId, 'scratch org must have a role to route to')
      const routing = { mode: 'digest', roleIds: [roleId], userIds: [userId] }

      await withBypassContext(() =>
        saveSetupAgentPolicy(org.orgId, userId, 'accounting', { ...ENABLE_ACCOUNTING, notification: routing }),
      )
      const stored = await withBypassContext(() => getSetupAgentNotification(org.orgId, 'accounting'))
      assert.deepEqual(stored, { mode: 'digest', roleIds: [roleId.toLowerCase()], userIds: [userId.toLowerCase()] })
      const audits = await auditRows(org.orgId, 'accounting')
      assert.deepEqual((audits[0]!.changes as { notification: unknown }).notification, stored)

      // A save without a notification section must not wipe stored routing
      // (the provider drawer saves agents without one).
      await withBypassContext(() => saveSetupAgentPolicy(org.orgId, userId, 'accounting', ENABLE_ACCOUNTING))
      assert.deepEqual(await withBypassContext(() => getSetupAgentNotification(org.orgId, 'accounting')), stored)
      const auditsAfter = await auditRows(org.orgId, 'accounting')
      assert.ok(!('notification' in (auditsAfter[0]!.changes as Record<string, unknown>)))

      // Explicit null clears back to findings-only.
      await withBypassContext(() =>
        saveSetupAgentPolicy(org.orgId, userId, 'accounting', { ...ENABLE_ACCOUNTING, notification: null }),
      )
      assert.equal(await withBypassContext(() => getSetupAgentNotification(org.orgId, 'accounting')), null)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  },
)

test(
  'invalid notification routing is rejected before any write',
  { skip: !DB },
  async () => {
    const org = await createScratchOrg()
    try {
      const userId = await createScratchUser(org.orgId, 'Agent Admin', 'admin')
      for (const notification of [
        { mode: 'smoke_signals' },
        { mode: 'digest', roleIds: ['not-a-uuid'] },
        { mode: 'immediate', userIds: ['00000000-0000-0000-0000-000000000000', 'x'.repeat(101)] },
      ]) {
        await assert.rejects(
          withBypassContext(() =>
            saveSetupAgentPolicy(org.orgId, userId, 'accounting', { ...ENABLE_ACCOUNTING, notification }),
          ),
          /invalid agent notification/,
        )
      }
      assert.equal(await policyRow(org.orgId, 'accounting'), undefined)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  },
)

test(
  'a provider save without agents leaves pack policies alone',
  { skip: !DB },
  async () => {
    const org = await createScratchOrg()
    try {
      const userId = await createScratchUser(org.orgId, 'Agent Admin', 'admin')
      const roleId = (
        await withBypassContext(
          async () =>
            (
              await db.execute<{ id: string }>(sql`
                select id::text as id from app_roles where org_id = ${org.orgId} order by name limit 1
              `)
            ).rows[0]?.id,
        )
      )!
      await withBypassContext(() =>
        saveSetupAgentPolicy(org.orgId, userId, 'accounting', {
          ...ENABLE_ACCOUNTING,
          notification: { mode: 'digest', roleIds: [roleId], userIds: [] },
        }),
      )
      // The slimmed provider form sends no `agents` array; the provider save
      // must not reset, disable, or re-route a single pack.
      await withBypassContext(() =>
        saveOrgAiSettings(org.orgId, userId, {
          enabled: true,
          provider: 'anthropic',
          modelFast: 'fast-model',
          modelSmart: 'smart-model',
          baseUrl: '',
          agents: [],
          documentCapture: {
            enabled: false,
            provider: 'azure_document_intelligence',
            endpoint: '',
            model: 'prebuilt-invoice',
            confidenceThreshold: '0.9000',
            autoCreatePoMatchedDrafts: false,
          },
        }),
      )
      const row = await policyRow(org.orgId, 'accounting')
      assert.ok(row, 'policy row must survive a provider save')
      assert.equal(row.enabled, true)
      assert.deepEqual(await withBypassContext(() => getSetupAgentNotification(org.orgId, 'accounting')), {
        mode: 'digest',
        roleIds: [roleId.toLowerCase()],
        userIds: [],
      })
    } finally {
      await dropScratchOrg(org.orgId)
    }
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
