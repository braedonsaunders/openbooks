import { db } from '@openbooks/engine/src/platform/db.ts';
import { readOperatingSetupJourney } from '@openbooks/engine/src/manufacturing/setup-journey.ts';
import { defineRoute } from '@/lib/api/route';
import { SetupJourneyBody } from './contract';
import { manufacturingTransaction } from '../../manufacturing/_transaction';

export const POST=defineRoute({permission:'admin.setup.manage',scope:'unrestricted',feature:{none:'Native readiness checks pin the selected Projects or Manufacturing feature and its dependencies.'},body:SetupJourneyBody,
  handler:({authz,body})=>manufacturingTransaction(authz.user.orgId,async()=>Response.json(await readOperatingSetupJourney(db,authz.user.orgId,authz.user.id,body))),
});
