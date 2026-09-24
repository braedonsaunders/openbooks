import { NextResponse } from 'next/server'
import { db, schema, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { resolveDraftSubsidiary } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { guardPermission } from '../../../../lib/authz'
import { guardProjectsFeature } from '../../../../lib/projects-gate'
import { acquireFeatureGateLock, isFeatureEnabled } from '../../../../lib/features'

export const runtime = 'nodejs'

/**
 * Instant-into-draft: create an inactive placeholder project and return its id.
 * The flyout edits it in place; activation requires a real name.
 *
 * The insert joins the org's feature-gate fence with the gate re-checked
 * inside the same transaction: the entry guard's read is unlocked, so without
 * the fence a concurrent `projects` disable could commit between it and the
 * insert. Creation and activation must serialize against feature toggles the
 * same way, or a disable and a create could both apply.
 */
export async function POST() {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const feature = await guardProjectsFeature(user.orgId)
  if (feature) return feature

  // A NULL-subsidiary project is denied by projects/[id] even to its
  // creator, so the draft must land in the actor's subsidiary — or refuse
  // by name when no single one can be assigned.
  const resolved = resolveDraftSubsidiary(gate.allowedSubsidiaryIds)
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 422 })

  let created: { id: string } | undefined
  let featureRefused = false
  await withOrgTransaction(user.orgId, async () => {
    await acquireFeatureGateLock(user.orgId)
    if (!(await isFeatureEnabled(user.orgId, 'projects'))) {
      featureRefused = true
      return
    }
    const rows = await db
      .insert(schema.projects)
      .values({
        orgId: user.orgId,
        subsidiaryId: resolved.subsidiaryId,
        name: 'New project',
        status: 'active',
        isActive: false,
        createdBy: user.id,
        updatedBy: user.id,
      })
      .returning({ id: schema.projects.id })
    created = rows[0]
  })
  if (featureRefused || !created) {
    return NextResponse.json({ error: 'projects feature is disabled' }, { status: 404 })
  }

  return NextResponse.json(created)
}
