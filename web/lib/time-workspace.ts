import 'server-only'
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from './feature-gates'
import { guardPermission } from './authz'
import type { TimeCommandPermission, TimeWorkFamily } from '@openbooks/engine/src/projects/time-work-target.ts'

export function timeWorkFamily(request: Request): TimeWorkFamily {
  const value = new URL(request.url).searchParams.get('workFamily')
  if (value !== null && value !== 'project' && value !== 'production') throw new InvalidTimeWorkspaceError()
  return value === 'production' ? 'production' : 'project'
}
class InvalidTimeWorkspaceError extends Error {
  readonly status = 422
  readonly code = 'invalid_time_workspace'
  constructor() { super('Choose the project or production time workspace.'); this.name = 'InvalidTimeWorkspaceError' }
}
/** Both workspaces use the same entries and lifecycle. Native commands separately fence every actual cost target. */
export function authorizeTimeWorkspace(permission: TimeCommandPermission) {
  return async ({ request }: { request: Request }) => {
    const family = timeWorkFamily(request)
    const gate = await guardFeaturePermission(permission, family === 'production' ? 'manufacturing' : 'timeTracking')
    if (gate instanceof NextResponse || family !== 'production') return gate
    const production = await guardPermission('manufacturing.read')
    return production instanceof NextResponse ? production : gate
  }
}
