import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { loadDashboard, normalizeAllowedRoles, normalizeLayout, strOrNull } from '../../_lib'

export const runtime = 'nodejs'

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 })
}

/**
 * PostgreSQL keeps six fractional digits on timestamptz values while the
 * node-postgres Date mapping does not. Dashboards use this exact wire token as
 * their optimistic-concurrency revision, so callers can safely echo it back
 * without losing precision between a read and a save.
 */
function dashboardRevisionSql(column: SQL): SQL<string> {
  return sql<string>`to_char(
    ${column} at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )`
}

const DASHBOARD_REVISION_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const DASHBOARD_REVISION_REQUIRED = 'the dashboard revision is required; reload and review the latest revision'
const DASHBOARD_REVISION_CONFLICT = 'this dashboard changed after you opened it; reload and review the latest revision'

class DashboardRevisionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DashboardRevisionError'
  }
}

function requireDashboardRevision(value: unknown): string {
  if (typeof value !== 'string' || !DASHBOARD_REVISION_PATTERN.test(value)) {
    throw new DashboardRevisionError(409, DASHBOARD_REVISION_REQUIRED)
  }
  return value
}

function assertDashboardRevision(expected: string, actual: unknown): void {
  if (typeof actual !== 'string' || expected !== actual) {
    throw new DashboardRevisionError(409, DASHBOARD_REVISION_CONFLICT)
  }
}

async function withExactDashboardRevision<T extends Record<string, unknown>>(dashboard: T, id: string, orgId: string): Promise<T | null> {
  const row = await db.execute<{ updatedAt: string }>(sql`
    select ${dashboardRevisionSql(sql.raw('updated_at'))} as "updatedAt"
      from insight_dashboards
     where id = ${id} and org_id = ${orgId}
  `)
  const revision = row.rows[0]?.updatedAt
  return typeof revision === 'string' ? ({ ...dashboard, updated_at: revision } as T) : null
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('insights.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const dashboard = await loadDashboard(id, gate.user.orgId)
  if (!dashboard) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const exact = await withExactDashboardRevision(dashboard, id, gate.user.orgId)
  return exact ? NextResponse.json(exact) : NextResponse.json({ error: 'not found' }, { status: 404 })
}

interface PatchBody {
  /** Exact `updated_at` token returned by GET; required for every autosave. */
  expectedUpdatedAt?: unknown
  name?: string
  description?: string | null
  layout?: unknown
  allowedRoles?: unknown
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('insights.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const existing = await loadDashboard(id, user.orgId)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as PatchBody

  let expectedRevision: string
  try {
    expectedRevision = requireDashboardRevision(body.expectedUpdatedAt)
  } catch (e) {
    if (e instanceof DashboardRevisionError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }

  if (body.name !== undefined && typeof body.name !== 'string') return bad('Dashboard name must be a string')
  const name = body.name !== undefined ? body.name.trim() : undefined
  if (name !== undefined && name === '') return bad('Dashboard name cannot be empty')

  let layout: unknown = undefined
  if (body.layout !== undefined) {
    try {
      layout = normalizeLayout(body.layout)
    } catch (e) {
      return bad(e instanceof Error ? e.message : 'invalid layout')
    }
  }

  let allowedRoles: string[] | null | undefined = undefined
  if (body.allowedRoles !== undefined) {
    try {
      allowedRoles = normalizeAllowedRoles(body.allowedRoles)
    } catch (e) {
      return bad(e instanceof Error ? e.message : 'invalid roles')
    }
  }

  try {
    await db.transaction(async (tx) => {
      // Lock and compare in the same transaction as the replacement. A slow
      // request can therefore never commit over a newer save that advanced
      // the exact revision while this request was in flight.
      const locked = (
        await tx.execute<{ updatedAt: string }>(sql`
        select ${dashboardRevisionSql(sql.raw('updated_at'))} as "updatedAt"
          from insight_dashboards
         where id = ${id} and org_id = ${user.orgId}
         for update
      `)
      ).rows[0]
      if (!locked) throw new DashboardRevisionError(404, 'not found')
      assertDashboardRevision(expectedRevision, locked.updatedAt)

      await tx.execute(sql`
        update insight_dashboards set
          name = ${name !== undefined ? name : sql`name`},
          description = ${body.description !== undefined ? strOrNull(body.description) : sql`description`},
          layout = ${layout !== undefined ? sql`${JSON.stringify(layout)}::jsonb` : sql`layout`},
          allowed_roles = ${allowedRoles !== undefined ? sql`${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb` : sql`allowed_roles`},
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
          updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId}
      `)
    })
  } catch (e) {
    if (e instanceof DashboardRevisionError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }

  const dashboard = await loadDashboard(id, user.orgId)
  return dashboard ? NextResponse.json(await withExactDashboardRevision(dashboard, id, user.orgId)) : NextResponse.json({ error: 'not found' }, { status: 404 })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('insights.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await db.execute(sql`delete from insight_dashboard_pins where dashboard_id = ${id} and org_id = ${user.orgId}`)
  await db.execute(sql`delete from insight_dashboards where id = ${id} and org_id = ${user.orgId}`)
  return NextResponse.json({ ok: true })
}
