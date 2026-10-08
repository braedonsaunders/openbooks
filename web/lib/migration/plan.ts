import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import {
  applyMigrationPlanChange,
  normalizeMigrationPlan,
  requiredCutoverCheckKeys,
  OTHER_SOURCE,
  SPREADSHEET_SOURCE,
  type CutoverCheck,
  type MigrationPlan,
  type MigrationPlanChange,
} from './plan-model'
import { SOURCE_TYPES } from '@openbooks/engine/sync'

/**
 * The migration plan lives in `orgs.settings.migrationPlan`, beside the
 * onboarding record it continues. Every write locks the organization row,
 * replaces only this key, and records before/after state with a reason in
 * the audit log.
 */

export class MigrationPlanRefusal extends Error {
  readonly name = 'MigrationPlanRefusal'
  constructor(message: string, readonly status = 422, readonly field: string | null = null) { super(message) }
}

export async function readMigrationPlan(orgId: string): Promise<MigrationPlan> {
  const row = (await db.execute<{ plan: unknown }>(sql`select settings->'migrationPlan' as plan from orgs where id = ${orgId}`)).rows[0]
  return normalizeMigrationPlan(row?.plan)
}

async function writePlan(orgId: string, actorId: string, reason: string, mutate: (current: MigrationPlan) => Promise<MigrationPlan> | MigrationPlan): Promise<{ before: MigrationPlan; after: MigrationPlan }> {
  return withOrgTransaction(orgId, async () => {
    const locked = (await db.execute<{ plan: unknown }>(sql`select settings->'migrationPlan' as plan from orgs where id = ${orgId} for update`)).rows[0]
    if (!locked) throw new MigrationPlanRefusal('The organization was not found.', 404)
    const before = normalizeMigrationPlan(locked.plan)
    const draft = await mutate(before)
    const after: MigrationPlan = { ...draft, updatedAt: new Date().toISOString(), updatedBy: actorId }
    const updated = await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{migrationPlan}', ${JSON.stringify(after)}::jsonb, true),
             updated_at = now(), updated_by = ${actorId}::uuid
       where id = ${orgId}
       returning id`)
    if (updated.rows.length !== 1) throw new Error('Migration plan update did not persist')
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({ migrationPlan: { before, after }, reason })}::jsonb, ${actorId})`)
    return { before, after }
  })
}

const KNOWN_SOURCES = new Set([...SOURCE_TYPES.map((type) => type.source), SPREADSHEET_SOURCE, OTHER_SOURCE])

/** Apply an operator change after checking every reference against this organization. */
export async function updateMigrationPlan(actor: { orgId: string; id: string }, change: MigrationPlanChange, reason: string) {
  return writePlan(actor.orgId, actor.id, reason, async (current) => {
    const result = applyMigrationPlanChange(current, change)
    if (!result.ok) throw new MigrationPlanRefusal(result.reason, result.field === 'goLive' ? 409 : 422, result.field)
    const plan = result.plan
    if (plan.sourceSystem && !KNOWN_SOURCES.has(plan.sourceSystem)) {
      throw new MigrationPlanRefusal(`Unknown source system "${plan.sourceSystem}" — use a connector key from list_migration_sources, "spreadsheet" or "other".`, 422, 'sourceSystem')
    }
    if (plan.connectionId) {
      const connection = (await db.execute<{ source: string }>(sql`select source from connections where org_id = ${actor.orgId} and id = ${plan.connectionId}`)).rows[0]
      if (!connection) throw new MigrationPlanRefusal('That connection does not exist in this organization — create it on the Migration & Sync page first.', 404, 'connectionId')
      if (plan.sourceSystem && plan.sourceSystem !== connection.source && KNOWN_SOURCES.has(plan.sourceSystem) && plan.sourceSystem !== OTHER_SOURCE) {
        throw new MigrationPlanRefusal(`The connection is a ${connection.source} connection but the plan names ${plan.sourceSystem} as the source.`, 422, 'connectionId')
      }
      plan.sourceSystem = connection.source
    }
    if (plan.openingBalanceAccountId) {
      const account = (await db.execute<{ is_active: boolean; is_summary: boolean }>(sql`
        select is_active, is_summary from accounts where org_id = ${actor.orgId} and id = ${plan.openingBalanceAccountId}`)).rows[0]
      if (!account) throw new MigrationPlanRefusal('That account does not exist in this organization.', 404, 'openingBalanceAccountId')
      if (!account.is_active || account.is_summary) throw new MigrationPlanRefusal('The opening-balance clearing account must be an active posting account, not a summary account.', 422, 'openingBalanceAccountId')
    }
    return plan
  })
}

/** Remember the opening-balance journal the migration command drafted. */
export async function recordOpeningJournal(actor: { orgId: string; id: string }, documentId: string) {
  return writePlan(actor.orgId, actor.id, 'opening-balance journal drafted by the migration assistant', (current) => ({ ...current, openingJournalId: documentId }))
}

/**
 * Record go-live with the exact checks measured for it. The caller measures
 * the checks inside the same organization transaction so the evidence and
 * the record describe one state.
 */
export async function recordGoLive(actor: { orgId: string; id: string }, measure: (plan: MigrationPlan) => Promise<CutoverCheck[]>, reason: string) {
  return writePlan(actor.orgId, actor.id, reason, async (current) => {
    if (current.goLive) throw new MigrationPlanRefusal(`These books went live on ${current.goLive.cutoverDate}; go-live is recorded once.`, 409, 'goLive')
    if (!current.path || current.path === 'mirror') {
      throw new MigrationPlanRefusal(current.path === 'mirror'
        ? 'A mirror keeps the previous system as the system of record. Change the plan path to cutover before going live.'
        : 'Choose a migration path before going live.', 409, 'path')
    }
    if (!current.cutoverDate) throw new MigrationPlanRefusal('Set the cutover date before going live.', 409, 'cutoverDate')
    const checks = await measure(current)
    const missing = requiredCutoverCheckKeys(current).filter((key) => !checks.some((check) => check.key === key && check.required))
    if (missing.length) throw new MigrationPlanRefusal(`Go-live needs measured required checks. Missing: ${missing.join(', ')}. Run the cutover checks again.`, 409, 'goLive')
    const blockers = checks.filter((check) => check.required && check.state !== 'pass')
    if (blockers.length) {
      throw new MigrationPlanRefusal(`Go-live needs every required check to pass. Open: ${blockers.map((check) => check.key).join(', ')}.`, 409, 'goLive')
    }
    return {
      ...current,
      goLive: {
        at: new Date().toISOString(),
        by: actor.id,
        cutoverDate: current.cutoverDate,
        path: current.path,
        checks: checks.map((check) => ({ key: check.key, state: check.state })),
      },
    }
  })
}
