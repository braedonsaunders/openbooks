import { NextResponse } from 'next/server'
import { deletePriorRegister } from '@openbooks/engine/src/payroll-parallel-run-store.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Discard an imported register.
 *
 * A prior register is not accounting data — it is somebody else's report, held
 * so we can check ours against it — so it is genuinely deletable rather than
 * voidable. Its comparisons go with it, because a reconciliation whose prior
 * side no longer exists cannot be re-derived and would be unverifiable
 * evidence. The audit log records the discard.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  await deletePriorRegister(gate.user.orgId, id, gate.user.id)
  return NextResponse.json({ ok: true })
}
