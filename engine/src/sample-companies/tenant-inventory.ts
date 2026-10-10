import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction } from "../platform/db.ts";
import { SAMPLE_COMPANY_PROFILES } from "./catalog.ts";

/** Metadata-only inventory for reviewing population and retirement scope before maintenance. */
export async function sampleTenantInventory() {
  return withMaintenanceTransaction(null, async () => {
    await db.execute(sql`set transaction read only`);
    await db.execute(sql`set local statement_timeout = '45000ms'`);
    const rows = (await db.execute<{
      database: string; serverAddress: string; serverPort: number; clusterName: string; id: string; name: string; environment: string; createdAt: string; sourceOrgId: string | null;
      simHarness: boolean; simProfile: string | null; template: Record<string, unknown> | null;
      member: Record<string, unknown> | null; version: number; documents: number; postedEntries: number;
      users: number; childCompanies: number; memberAccess: number; sandboxId: string | null; sandboxStatus: string | null;
    }>(sql`select current_database() as database,inet_server_addr()::text as "serverAddress",inet_server_port() as "serverPort",current_setting('cluster_name') as "clusterName",o.id,o.name,o.env_kind as environment,o.created_at::text as "createdAt",o.sandbox_of as "sourceOrgId",
      coalesce(o.settings->>'simHarness','false')='true' as "simHarness",o.settings->>'simProfile' as "simProfile",
      o.settings->'sampleTemplate' as template,o.settings->'sampleCompany' as member,
      coalesce((o.settings->'demoData'->>'version')::int,0) as version,
      (select count(*)::int from documents d where d.org_id=o.id) as documents,
      (select count(*)::int from journal_entries e where e.org_id=o.id and e.status in ('posted','reversed')) as "postedEntries",
      (select count(*)::int from users u where u.org_id=o.id and u.is_active) as users,
      (select count(*)::int from orgs child where child.sandbox_of=o.id) as "childCompanies",
      (select count(*)::int from user_org_access access where access.org_id=o.id and access.is_active) as "memberAccess",
      (select id from sandboxes s where s.org_id=o.id) as "sandboxId",
      (select status from sandboxes s where s.org_id=o.id) as "sandboxStatus"
      from orgs o order by o.name,o.id`)).rows;
    return rows.map(row => {
      const profileId = row.member?.profileId ?? row.template?.profileId ?? row.simProfile;
      const profile = SAMPLE_COMPANY_PROFILES.find(profile => profile.profileId === profileId);
      const classification = row.member ? "exploration-company" : row.template ? "registered-master"
        : row.simHarness ? "unregistered-simulation" : "ordinary-company";
      return { database: row.database, serverAddress: row.serverAddress, serverPort: row.serverPort, clusterName: row.clusterName, orgId: row.id, name: row.name, environment: row.environment, createdAt: row.createdAt,
        classification, packagedIndustry: profile?.industryKey ?? null, profileId: profileId ?? null,
        templateEnabled: row.template?.enabled ?? null, installedVersion: row.version, sourceOrgId: row.sourceOrgId,
        sandboxId: row.sandboxId, sandboxStatus: row.sandboxStatus, activeMemberAccess: row.memberAccess,
        ownerUserId: row.member?.ownerUserId ?? null, stage: row.member?.provisioningStage ?? null,
        documents: row.documents, postedEntries: row.postedEntries, activeUsers: row.users, childCompanies: row.childCompanies,
        disposition: classification === "ordinary-company" ? "preserve" : profile ? "review-native-refresh" : "review-provenance-before-retirement" };
    });
  });
}
