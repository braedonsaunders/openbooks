import { NextRequest, NextResponse } from 'next/server'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { guardProjectsFeature } from '../../../../lib/projects-gate'

export const runtime = 'nodejs'

/**
 * Instant-into-draft: create an inactive placeholder project and return its id.
 * The flyout edits it in place; activation requires a real name.
 */
export async function POST(_req: NextRequest) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const feature = await guardProjectsFeature(user.orgId)
  if (feature) return feature

  const [project] = await db
    .insert(schema.projects)
    .values({
      orgId: user.orgId,
      name: 'New project',
      status: 'active',
      isActive: false,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: schema.projects.id })

  return NextResponse.json(project)
}
