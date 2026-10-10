import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts';
import { saveCompanyWorkCalendar } from '@openbooks/engine/src/organization/work-calendars.ts';
import { WorkCalendarBody } from './contract';
export const POST = defineRoute({ permission: 'admin.setup.manage', scope: 'unrestricted',
  feature: { none: 'The native command checks Manufacturing or Project Scheduling in its transaction.' }, body: WorkCalendarBody,
  handler: async ({ request, authz, body }) => withOrgTransaction(authz.user.orgId, async () => Response.json(
    await saveCompanyWorkCalendar(db, authz.user.orgId, authz.user.id, { ...body, id: z.string().uuid().parse(request.headers.get('Idempotency-Key')) }), { status: 201 })),
});
