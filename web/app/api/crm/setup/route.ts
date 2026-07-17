import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { ensureCrmDefaults } from "@openbooks/engine/src/crm.ts";
import { guardPermission } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export async function GET() {
  const gate = await guardPermission("crm.setup.manage");
  if (gate instanceof NextResponse) return gate;
  await ensureCrmDefaults(gate.user.orgId, gate.user.id);
  const [
    accountStatuses,
    opportunityStatuses,
    territories,
    sources,
    teams,
    members,
    quotas,
    users,
  ] = (await Promise.all([
    db.execute(
      sql`select * from crm_account_statuses where org_id = ${gate.user.orgId} order by lifecycle_stage, sequence, name`,
    ),
    db.execute(
      sql`select * from crm_opportunity_statuses where org_id = ${gate.user.orgId} order by sequence, name`,
    ),
    db.execute(
      sql`select t.*, mu.name as manager_name, ou.name as owner_name from crm_sales_territories t left join users mu on mu.id=t.manager_user_id left join users ou on ou.id=t.default_owner_user_id where t.org_id=${gate.user.orgId} order by t.priority,t.name`,
    ),
    db.execute(
      sql`select * from crm_lead_sources where org_id=${gate.user.orgId} order by name`,
    ),
    db.execute(
      sql`select t.*, u.name as manager_name from crm_sales_teams t left join users u on u.id=t.manager_user_id where t.org_id=${gate.user.orgId} order by t.name`,
    ),
    db.execute(
      sql`select m.*,u.name as user_name from crm_sales_team_members m join users u on u.id=m.user_id where m.org_id=${gate.user.orgId} order by u.name`,
    ),
    db.execute(
      sql`select q.*,u.name as owner_name,t.name as team_name from crm_sales_quotas q left join users u on u.id=q.owner_user_id left join crm_sales_teams t on t.id=q.sales_team_id where q.org_id=${gate.user.orgId} order by q.period_start desc`,
    ),
    db.execute(
      sql`select id,name,email from users where org_id=${gate.user.orgId} and is_active order by name`,
    ),
  ])) as any[];
  return NextResponse.json({
    accountStatuses: accountStatuses.rows,
    opportunityStatuses: opportunityStatuses.rows,
    territories: territories.rows,
    sources: sources.rows,
    teams: teams.rows,
    members: members.rows,
    quotas: quotas.rows,
    users: users.rows,
  });
}

export async function POST(req: NextRequest) {
  const gate = await guardPermission("crm.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  await ensureCrmDefaults(user.orgId, user.id);
  const body = (await req.json()) as Record<string, any>;
  const action = String(body.action ?? "");
  const recordId = body.id ? String(body.id) : null;
  if (recordId && !isUuid(recordId))
    return NextResponse.json({ error: "invalid record id" }, { status: 422 });
  let row: unknown;
  if (action === "save-account-status") {
    const name = String(body.name ?? "").trim();
    if (
      !name ||
      !["lead", "prospect", "customer"].includes(body.lifecycleStage)
    )
      return NextResponse.json(
        { error: "name and lifecycle stage are required" },
        { status: 422 },
      );
    row = recordId
      ? await db.execute(
          sql`update crm_account_statuses set name=${name},description=${body.description ?? null},lifecycle_stage=${body.lifecycleStage},sequence=${Number(body.sequence) || 0},is_qualified=${body.isQualified === true},is_closed=${body.isClosed === true},is_default=${body.isDefault === true},is_active=${body.isActive !== false},updated_at=now(),updated_by=${user.id} where id=${recordId} and org_id=${user.orgId} returning *`,
        )
      : await db.execute(
          sql`insert into crm_account_statuses (org_id,key,name,description,lifecycle_stage,sequence,is_qualified,is_closed,is_default,is_active,created_by,updated_by) values (${user.orgId},${slug(body.key || name)},${name},${body.description ?? null},${body.lifecycleStage},${Number(body.sequence) || 0},${body.isQualified === true},${body.isClosed === true},${body.isDefault === true},${body.isActive !== false},${user.id},${user.id}) returning *`,
        );
  } else if (action === "save-opportunity-status") {
    const name = String(body.name ?? "").trim();
    const probability = Number(body.probability);
    if (
      !name ||
      !Number.isInteger(probability) ||
      probability < 0 ||
      probability > 100
    )
      return NextResponse.json(
        { error: "name and probability from 0 to 100 are required" },
        { status: 422 },
      );
    if (
      !["omitted", "worst_case", "most_likely", "upside"].includes(
        body.defaultForecastCategory,
      )
    )
      return NextResponse.json(
        { error: "invalid forecast category" },
        { status: 422 },
      );
    if (body.isWon === true && body.isClosed !== true)
      return NextResponse.json(
        { error: "a won stage must be closed" },
        { status: 422 },
      );
    row = recordId
      ? await db.execute(
          sql`update crm_opportunity_statuses set name=${name},description=${body.description ?? null},sequence=${Number(body.sequence) || 0},probability=${probability},default_forecast_category=${body.defaultForecastCategory},is_closed=${body.isClosed === true},is_won=${body.isWon === true},is_default=${body.isDefault === true},is_active=${body.isActive !== false},updated_at=now(),updated_by=${user.id} where id=${recordId} and org_id=${user.orgId} returning *`,
        )
      : await db.execute(
          sql`insert into crm_opportunity_statuses (org_id,key,name,description,sequence,probability,default_forecast_category,is_closed,is_won,is_default,is_active,created_by,updated_by) values (${user.orgId},${slug(body.key || name)},${name},${body.description ?? null},${Number(body.sequence) || 0},${probability},${body.defaultForecastCategory},${body.isClosed === true},${body.isWon === true},${body.isDefault === true},${body.isActive !== false},${user.id},${user.id}) returning *`,
        );
  } else if (action === "save-lead-source") {
    const name = String(body.name ?? "").trim();
    if (!name)
      return NextResponse.json({ error: "name is required" }, { status: 422 });
    row = recordId
      ? await db.execute(
          sql`update crm_lead_sources set name=${name},description=${body.description ?? null},is_active=${body.isActive !== false},updated_at=now(),updated_by=${user.id} where id=${recordId} and org_id=${user.orgId} returning *`,
        )
      : await db.execute(
          sql`insert into crm_lead_sources (org_id,key,name,description,is_active,created_by,updated_by) values (${user.orgId},${slug(body.key || name)},${name},${body.description ?? null},${body.isActive !== false},${user.id},${user.id}) returning *`,
        );
  } else if (action === "save-territory") {
    const name = String(body.name ?? "").trim();
    if (
      !name ||
      !Array.isArray(body.rules) ||
      !["all", "any"].includes(body.matchMode ?? "all")
    )
      return NextResponse.json(
        { error: "valid territory name and rules are required" },
        { status: 422 },
      );
    for (const id of [body.managerUserId, body.defaultOwnerUserId].filter(
      Boolean,
    ))
      if (
        !isUuid(id) ||
        !(
          (await db.execute(
            sql`select 1 from users where id=${id} and org_id=${user.orgId}`,
          )) as any
        ).rows[0]
      )
        return NextResponse.json(
          { error: "invalid territory user" },
          { status: 422 },
        );
    row = recordId
      ? await db.execute(
          sql`update crm_sales_territories set name=${name},description=${body.description ?? null},priority=${Number(body.priority) || 100},manager_user_id=${body.managerUserId || null},default_owner_user_id=${body.defaultOwnerUserId || null},match_mode=${body.matchMode ?? "all"},rules=${JSON.stringify(body.rules)}::jsonb,is_active=${body.isActive !== false},updated_at=now(),updated_by=${user.id} where id=${recordId} and org_id=${user.orgId} returning *`,
        )
      : await db.execute(
          sql`insert into crm_sales_territories (org_id,key,name,description,priority,manager_user_id,default_owner_user_id,match_mode,rules,is_active,created_by,updated_by) values (${user.orgId},${slug(body.key || name)},${name},${body.description ?? null},${Number(body.priority) || 100},${body.managerUserId || null},${body.defaultOwnerUserId || null},${body.matchMode ?? "all"},${JSON.stringify(body.rules)}::jsonb,${body.isActive !== false},${user.id},${user.id}) returning *`,
        );
  } else if (action === "save-team") {
    const name = String(body.name ?? "").trim();
    if (!name || !Array.isArray(body.members))
      return NextResponse.json(
        { error: "team name and members are required" },
        { status: 422 },
      );
    const members = [...body.members];
    if (
      body.managerUserId &&
      !members.some((member: any) => member.userId === body.managerUserId)
    )
      members.push({ userId: body.managerUserId, role: "manager" });
    for (const member of members)
      if (
        !isUuid(member.userId) ||
        !["manager", "member"].includes(member.role ?? "member") ||
        !(
          (await db.execute(
            sql`select 1 from users where id=${member.userId} and org_id=${user.orgId}`,
          )) as any
        ).rows[0]
      )
        return NextResponse.json(
          { error: "invalid team member" },
          { status: 422 },
        );
    row = await db.transaction(async (tx) => {
      const team = (
        recordId
          ? await tx.execute(
              sql`update crm_sales_teams set name=${name},manager_user_id=${body.managerUserId || null},is_active=${body.isActive !== false},updated_at=now(),updated_by=${user.id} where id=${recordId} and org_id=${user.orgId} returning *`,
            )
          : await tx.execute(
              sql`insert into crm_sales_teams (org_id,key,name,manager_user_id,is_active,created_by,updated_by) values (${user.orgId},${slug(body.key || name)},${name},${body.managerUserId || null},${body.isActive !== false},${user.id},${user.id}) returning *`,
            )
      ) as any;
      const teamRow = team.rows[0];
      if (!teamRow) return team;
      await tx.execute(
        sql`delete from crm_sales_team_members where team_id=${teamRow.id} and org_id=${user.orgId}`,
      );
      for (const member of members)
        await tx.execute(
          sql`insert into crm_sales_team_members (org_id,team_id,user_id,role,created_by,updated_by) values (${user.orgId},${teamRow.id},${member.userId},${member.role ?? "member"},${user.id},${user.id})`,
        );
      return team;
    });
  } else if (action === "save-quota") {
    const ownerUserId = body.ownerUserId || null;
    const salesTeamId = body.salesTeamId || null;
    if (
      (ownerUserId ? 1 : 0) + (salesTeamId ? 1 : 0) !== 1 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.periodStart ?? "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.periodEnd ?? "") ||
      body.periodEnd < body.periodStart ||
      !/^[A-Z]{3}$/.test(String(body.currency ?? "").toUpperCase()) ||
      !/^\d+(\.\d{0,4})?$/.test(String(body.amount ?? ""))
    )
      return NextResponse.json(
        {
          error:
            "quota needs one target, a valid period, currency, and a non-negative amount",
        },
        { status: 422 },
      );
    if (
      ownerUserId &&
      !(
        (await db.execute(
          sql`select 1 from users where id=${ownerUserId} and org_id=${user.orgId}`,
        )) as any
      ).rows[0]
    )
      return NextResponse.json(
        { error: "invalid quota owner" },
        { status: 422 },
      );
    if (
      salesTeamId &&
      !(
        (await db.execute(
          sql`select 1 from crm_sales_teams where id=${salesTeamId} and org_id=${user.orgId}`,
        )) as any
      ).rows[0]
    )
      return NextResponse.json(
        { error: "invalid quota team" },
        { status: 422 },
      );
    row = recordId
      ? await db.execute(
          sql`update crm_sales_quotas set owner_user_id=${ownerUserId},sales_team_id=${salesTeamId},period_start=${body.periodStart},period_end=${body.periodEnd},currency=${String(body.currency).toUpperCase()},amount=${String(body.amount)},filters=${JSON.stringify(body.filters ?? {})}::jsonb,updated_at=now(),updated_by=${user.id} where id=${recordId} and org_id=${user.orgId} returning *`,
        )
      : await db.execute(
          sql`insert into crm_sales_quotas (org_id,owner_user_id,sales_team_id,period_start,period_end,currency,amount,filters,created_by,updated_by) values (${user.orgId},${ownerUserId},${salesTeamId},${body.periodStart},${body.periodEnd},${String(body.currency).toUpperCase()},${String(body.amount)},${JSON.stringify(body.filters ?? {})}::jsonb,${user.id},${user.id}) returning *`,
        );
  } else {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  const result = row as { rows?: unknown[] };
  const first = result.rows ? result.rows[0] : row;
  if (!first)
    return NextResponse.json({ error: "record not found" }, { status: 404 });
  await db.execute(
    sql`insert into audit_log (org_id,table_name,row_id,action,changes,actor_id) values (${user.orgId},'crm_setup',${(first as any).id ?? null},${recordId ? "update" : "insert"},${JSON.stringify({ action, body })}::jsonb,${user.id})`,
  );
  return NextResponse.json(first);
}
