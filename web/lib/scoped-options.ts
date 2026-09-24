import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { subsidiaryVisibleFilter } from '@openbooks/engine/src/organization/subsidiary-scope.ts'

export interface ScopedAccountOption extends Record<string, unknown> {
  id: string
  number: string | null
  name: string
  type: string
  subsidiaryId: string | null
  is_summary: boolean
}

/** Account references visible to one reader, using the same scope as direct account reads. */
export async function listScopedAccountOptions(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  options: { activeOnly?: boolean; postingOnly?: boolean; summaryOnly?: boolean } = {},
): Promise<ScopedAccountOption[]> {
  const rows = await db.execute<ScopedAccountOption>(sql`
    select a.id, a.number, a.name, a.type, a.subsidiary_id as "subsidiaryId", a.is_summary
      from accounts a
     where a.org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, allowedSubsidiaryIds)}
       ${options.activeOnly ? sql`and a.is_active` : sql``}
       ${options.postingOnly ? sql`and not a.is_summary` : sql``}
       ${options.summaryOnly ? sql`and a.is_summary` : sql``}
     order by a.number nulls last, a.name, a.id
  `)
  return rows.rows
}
