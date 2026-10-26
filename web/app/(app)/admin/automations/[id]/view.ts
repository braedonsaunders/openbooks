import "server-only";

import { sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { frame, page, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { db } from "@openbooks/engine/platform/db";
import { can, requirePermission } from "../../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../../lib/feature-gates";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { listAutomations, listAutomationRuns } from "@openbooks/engine/automations/services";
import type { BuilderAutomation, BuilderRun } from "./AutomationBuilder";

/**
 * The automation recipe builder page, split into a loader and a spec.
 *
 * One linear-recipe client island over loader-resolved props (the
 * brief-sanctioned recipe mode beside the graph-based flows builder):
 * Trigger, Who and When, and Actions panels, a Simulate card, and the
 * Runs tab. No org id, user id, or Authz crosses into the spec.
 */

export interface AutomationBuilderData {
  automation: BuilderAutomation;
  runs: BuilderRun[];
  scopeOptions: {
    subsidiaries: { value: string; label: string }[];
    departments: { value: string; label: string }[];
    locations: { value: string; label: string }[];
    positions: { value: string; label: string }[];
    users: { value: string; label: string; hint: string }[];
    roles: { value: string; label: string }[];
    processTemplates: { value: string; label: string; kind: string }[];
  };
  canSimulate: boolean;
  canManage: boolean;
  saveFailed: string;
  title: string;
  description: string;
  backHref: string;
  backLabel: string;
}

export async function loadAutomationBuilder(id: string): Promise<AutomationBuilderData> {
  const authz = await requirePermission("automations.read");
  await requireFeatureEnabled(authz.user.orgId, "automations");
  if (!isUuid(id)) notFound();
  const t = await getTranslations("admin.automations");
  const automations = await listAutomations(authz.user.orgId, authz.user.id);
  const automation = automations.find((a) => a.id === id);
  if (!automation) notFound();
  const canManage = can(authz, "automations.manage");
  const canReadProcessTemplates =
    can(authz, "hrm.process.read") && (await isFeatureEnabled(authz.user.orgId, "hrm"));
  const [runs, optionRows] = await Promise.all([
    listAutomationRuns(authz.user.orgId, authz.user.id, id),
    canManage
      ? Promise.all([
          db.execute<{ id: string; name: string }>(sql`
            select id::text as id, name from subsidiaries
             where org_id = ${authz.user.orgId} and is_active and not is_elimination
             order by name, id`),
          db.execute<{ id: string; name: string }>(sql`
            select id::text as id, name from departments
             where org_id = ${authz.user.orgId} and is_active
             order by name, id`),
          db.execute<{ id: string; name: string }>(sql`
            select id::text as id, name from locations
             where org_id = ${authz.user.orgId} and is_active
             order by name, id`),
          db.execute<{ id: string; name: string }>(sql`
            select v.position_id::text as id,
                   coalesce(nullif(trim(v.title), ''), p.position_code) as name
              from position_versions v
              join positions p on p.org_id = v.org_id and p.id = v.position_id
             where v.org_id = ${authz.user.orgId}
               and v.recorded_until is null
               and v.effective_from <= current_date
               and (v.effective_to is null or v.effective_to > current_date)
               and v.status not in ('frozen', 'closed')
             order by name, id`),
          db.execute<{ id: string; name: string; email: string }>(sql`
            select id::text as id, name, email from users
             where org_id = ${authz.user.orgId} and is_active
             order by name, id`),
          db.execute<{ key: string; name: string }>(sql`
            select key, name from app_roles
             where org_id = ${authz.user.orgId}
             order by name, key`),
          canReadProcessTemplates
            ? db.execute<{ id: string; name: string; kind: string }>(sql`
                select id::text as id, name, kind from hrm_process_templates
                 where org_id = ${authz.user.orgId} and is_active
                   and published_version > 0 and kind = 'onboarding'
                 order by name, id`)
            : Promise.resolve({ rows: [] as { id: string; name: string; kind: string }[] }),
        ])
      : Promise.resolve(null),
  ]);
  const [subsidiaries, departments, locations, positions, users, roles, processTemplates] =
    optionRows ?? [
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ];
  return {
    automation: {
      id: automation.id,
      name: automation.name,
      description: automation.description,
      status: automation.status,
      version: automation.version,
      trigger: (automation.trigger ?? {}) as Record<string, unknown>,
      rules: (automation.rules ?? {}) as Record<string, unknown>,
      conditions: (automation.conditions ?? {}) as Record<string, unknown>,
      actions: (Array.isArray(automation.actions) ? automation.actions : []) as Record<
        string,
        unknown
      >[],
      errorMessage: automation.errorMessage,
    },
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      version: r.version,
      subjectKind: r.subjectKind,
      createdAt: String(r.createdAt),
    })),
    scopeOptions: {
      subsidiaries: subsidiaries.rows.map((row) => ({
        value: String(row.id),
        label: String(row.name),
      })),
      departments: departments.rows.map((row) => ({
        value: String(row.id),
        label: String(row.name),
      })),
      locations: locations.rows.map((row) => ({ value: String(row.id), label: String(row.name) })),
      positions: positions.rows.map((row) => ({ value: String(row.id), label: String(row.name) })),
      users: users.rows.map((row) => ({
        value: String(row.id),
        label: String(row.name),
        hint: String(row.email),
      })),
      roles: roles.rows.map((row) => ({ value: String(row.key), label: String(row.name) })),
      processTemplates: processTemplates.rows.map((row) => ({
        value: String(row.id),
        label: String(row.name),
        kind: String(row.kind),
      })),
    },
    canSimulate: await isFeatureEnabled(authz.user.orgId, "automationSimulator"),
    // automations.read opens the page; only automations.manage may change the
    // recipe. The builder island renders its mutating controls from this.
    canManage,
    saveFailed: t("builder.saveFailed"),
    title: automation.name,
    description: t("builder.description"),
    backHref: "/admin/automations",
    backLabel: t("backToList"),
  };
}

export function automationBuilderSpec(data: AutomationBuilderData): PageSpec {
  return page({
    route: "/admin/automations/[id]",
    layout: "bare",
    header: [],
    body: [
      frame("padded", [
        widgetBlock("automation-builder", {
          automation: data.automation,
          runs: data.runs,
          scopeOptions: data.scopeOptions,
          canSimulate: data.canSimulate,
          canManage: data.canManage,
          saveFailed: data.saveFailed,
          backHref: data.backHref,
          backLabel: data.backLabel,
        }),
      ]),
    ],
  });
}
