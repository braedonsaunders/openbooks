import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { MIGRATION_PATHS } from '@/lib/migration/plan-model'
import { updateMigrationPlan } from '@/lib/migration/plan'

export const runtime = 'nodejs'

const body = z.object({
  path: z.enum(MIGRATION_PATHS).nullable().optional(),
  sourceSystem: z.string().max(40).nullable().optional(),
  sourceLabel: z.string().max(120).nullable().optional(),
  connectionId: z.uuid().nullable().optional(),
  cutoverDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  openingBalanceAccountId: z.uuid().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
}).strict()

/** PATCH /api/migration/plan — the same audited plan writer the assistant's command uses. */
export const PATCH = defineRoute({
  permission: 'admin.setup.manage',
  scope: 'unrestricted',
  feature: { none: 'Migration planning is organization-wide setup governed by the setup permission.' },
  body,
  handler: async ({ authz, body: change }) => {
    // A MigrationPlanRefusal is a typed 4xx business refusal: the route
    // factory answers it with its message and field.
    const { after } = await updateMigrationPlan({ orgId: authz.user.orgId, id: authz.user.id }, change, 'migration plan updated in the migration workspace')
    return NextResponse.json({ plan: after })
  },
})
