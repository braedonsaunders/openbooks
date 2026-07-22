import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Read model for the rate-book-assignment sections embedded on the customer and
 * project records. Mutations go through the shared setup CRUD API
 * (/api/admin/setup/item-rate-book-assignments) with its overlap/scope
 * validation; this endpoint only lists the assignments for one scope plus the
 * rate books available to pick. Gated on admin.setup.manage — the section hides
 * itself when the caller lacks it.
 */
export async function GET(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { orgId } = gate.user
  const url = new URL(req.url)
  const customerId = url.searchParams.get('customerId')
  const projectId = url.searchParams.get('projectId')
  if ((customerId && projectId) || (!customerId && !projectId)) {
    return NextResponse.json({ error: 'Provide exactly one of customerId / projectId' }, { status: 400 })
  }
  const scopeId = (customerId ?? projectId)!
  if (!isUuid(scopeId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const scope = customerId ? sql`a.customer_id = ${scopeId}` : sql`a.project_id = ${scopeId}`

  const [rateBooks, assignments] = await Promise.all([
    db.execute(sql`
      select id, name, currency, is_default from item_rate_books
       where org_id = ${orgId} and is_active order by is_default desc, name`) as any,
    db.execute(sql`
      select a.id, a.rate_book_id, b.name as rate_book_name, b.currency,
             a.effective_from, a.effective_to, a.date_basis, a.is_active
        from item_rate_book_assignments a
        join item_rate_books b on b.id = a.rate_book_id
       where a.org_id = ${orgId} and ${scope}
       order by a.is_active desc, a.effective_from desc nulls last`) as any,
  ])
  return NextResponse.json({ rateBooks: rateBooks.rows, assignments: assignments.rows })
}
