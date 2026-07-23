import 'server-only'
import { laborCostingSettings, snapshotLaborCostRates } from '@openbooks/engine/src/labor-costing.ts'
import { applyOverheadForTime } from '@openbooks/engine/src/overhead-apply.ts'
import { postProjectLaborCost } from '@openbooks/engine/src/project-recognition.ts'
import { snapshotTimeBillRates } from './item-rates'
import { isFeatureEnabled } from './features'

/**
 * The ONE set of side-effects that fire when time becomes approved — shared by
 * the personal weekly timesheet approval and field-ticket approval so hours
 * are costed identically no matter how they were captured:
 *   1. cost-rate snapshot (wage × time-type multiplier + estimate components)
 *   2. bill-rate snapshot (rate books, per-time-type tiers)
 *   3. standard labor posting (DR labor WIP / CR clearing) when mode is on
 *   4. the overhead net-zero pair (rides with the hours)
 * Everything is inert-until-configured; callers should treat failures as
 * non-blocking (entries stay re-postable).
 */
export async function runTimeApprovalEffects(orgId: string, actorId: string, timeEntryIds: string[]): Promise<void> {
  if (timeEntryIds.length === 0) return
  if (!(await isFeatureEnabled(orgId, 'projects'))) return
  const settings = await laborCostingSettings(orgId)
  await snapshotLaborCostRates(orgId, timeEntryIds)
  await snapshotTimeBillRates(orgId, timeEntryIds)
  if (settings.mode === 'post') await postProjectLaborCost(orgId, actorId, timeEntryIds)
  await applyOverheadForTime(orgId, actorId, timeEntryIds)
}
