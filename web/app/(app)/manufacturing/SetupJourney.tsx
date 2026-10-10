import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { listOperatingProfileChoices } from "@openbooks/engine/src/organization/operating-profiles.ts";
import { lockActorCommandAuthority } from "@openbooks/engine/src/organization/actor-command-authority.ts";
import { getAuthz, can } from "@/lib/authz";
import { isFeatureEnabled } from "@/lib/features";
import { SetupJourneyContent } from "./SetupJourneyContent";

/** The selected workflow diagnoses native prerequisites; this surface owns no setup state. */
export async function WorkSetupJourney() {
  const authz=await getAuthz();
  if (!authz || !can(authz,"admin.setup.manage") || authz.allowedSubsidiaryIds!==null) return null;
  const orgId=authz.user.orgId;
  const project=can(authz,"projects.read") && await isFeatureEnabled(orgId,"projects");
  const production=can(authz,"manufacturing.read") && can(authz,"items.read") && await isFeatureEnabled(orgId,"manufacturing");
  const data=await withOrgTransaction(orgId,async()=>{
    if (await lockActorCommandAuthority(db,orgId,authz.user.id,null,"admin.setup.manage")!==null) return null;
    const choices=[...(project?await listOperatingProfileChoices(db,orgId,authz.user.id,"project"):[]),...(production?await listOperatingProfileChoices(db,orgId,authz.user.id,"production"):[])];
    const entities=production?(await db.execute<{value:string;label:string}>(sql`select id as value,name as label from subsidiaries where org_id=${orgId} and is_active and not is_elimination order by name,id limit 500`)).rows:[];
    return {choices,entities};
  });
  return data?<SetupJourneyContent {...data} canCreateProject={can(authz,"projects.manage")} canCreateProduction={can(authz,"manufacturing.manage")}/>:null;
}
export const ManufacturingSetupJourney=WorkSetupJourney;
