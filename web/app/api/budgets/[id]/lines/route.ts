import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { BudgetMutationError, saveBudgetCells, type BudgetCellInput } from '../../../../../lib/budget-mutations'

export const runtime = 'nodejs'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('budgets.manage', 'budgets')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { expectedRevision?: number; cells?: Record<string, unknown>[] }
  if (!Array.isArray(body.cells)) return NextResponse.json({ error: 'cells_required' }, { status: 422 })

  const nullableUuid = (value: unknown) => value === null || value === undefined || value === ''
    ? null
    : typeof value === 'string' && isUuid(value)
      ? value
      : 'invalid'
  const cells: BudgetCellInput[] = []
  for (const raw of body.cells) {
    if (typeof raw.accountId !== 'string' || !isUuid(raw.accountId) || typeof raw.periodId !== 'string' || !isUuid(raw.periodId)) {
      return NextResponse.json({ error: 'invalid_account_or_period' }, { status: 422 })
    }
    const departmentId = nullableUuid(raw.departmentId)
    const projectId = nullableUuid(raw.projectId)
    const locationId = nullableUuid(raw.locationId)
    const classId = nullableUuid(raw.classId)
    if ([departmentId, projectId, locationId, classId].includes('invalid')) {
      return NextResponse.json({ error: 'invalid_dimension' }, { status: 422 })
    }
    cells.push({
      accountId: raw.accountId,
      periodId: raw.periodId,
      amount: String(raw.amount ?? ''),
      note: typeof raw.note === 'string' ? raw.note : null,
      departmentId: departmentId as string | null,
      projectId: projectId as string | null,
      locationId: locationId as string | null,
      classId: classId as string | null,
    })
  }
  try {
    return NextResponse.json(await saveBudgetCells({
      scenarioId: id,
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      expectedRevision: Number(body.expectedRevision),
      cells,
    }))
  } catch (error) {
    if (error instanceof BudgetMutationError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
}
