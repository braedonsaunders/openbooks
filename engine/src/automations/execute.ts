import { sql } from "drizzle-orm";
import { businessToday } from "../platform/business-date.ts";
import { db, schema, withOrg, withTransactionSavepoint } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { getFlowAdapter } from "../flows/registry.ts";
import { enqueueFlowEmail } from "../scheduling/outbox.ts";
import { openProcessInTx } from "../hrm/processes.ts";
import { automationsFeatureOn } from "./services.ts";
import {
  assertWritableField,
  loadSubjectSnapshot,
  registryEntity,
} from "./registry.ts";
import {
  evaluateAutomation,
  type SubjectSnapshot,
} from "./evaluate.ts";
import { renderAutomationEmailTemplate } from "./email-templates.ts";
import {
  parseAutomationActions,
  parseAutomationConditions,
  parseAutomationRules,
  unsupportedAutomationActionRefusal,
  type AutomationAction,
} from "./triggers.ts";

/**
 * HR-16 automation executor — runs a recipe's ordered actions.
 *
 * One run = one automation_runs row + one transaction for the run's DB
 * writes (notification inserts, process starts, field updates through the
 * Flows subject adapter's setField — the adapter owns the write
 * allowlist, so update_field can never become an arbitrary write).
 * External effects (email, webhook) leave as durable outbox jobs in the
 * SAME transaction: they commit with the run's writes or roll back with
 * them. A failed step fails the run, rolls back the run's DB writes, and
 * records the error ON the run row — errors surface as a run row the
 * inbox shows (HR-15 adapter kind automation_error), never as silence.
 *
 * The executor takes a mode flag: 'live' writes, 'simulated' builds the
 * step list with NO writes (the simulator proves it by counting rows
 * before and after). Idempotency: the insert carries the
 * (org, automation, subject, fingerprint) key with ON CONFLICT DO NOTHING
 * — the conflict IS the expected benign case (a re-fired trigger), so the
 * row is re-read and returned, never double-run. Justification recorded
 * here per the repository rule.
 */

export type ExecuteMode = "live" | "simulated";

export type AutomationRow = {
  id: string;
  orgId: string;
  name: string;
  status: string;
  trigger: unknown;
  rules: unknown;
  conditions: unknown;
  actions: unknown;
  version: number;
};

export type RunStep = {
  index: number;
  kind: string;
  status: "succeeded" | "failed" | "skipped" | "simulated";
  output?: string;
  error?: string;
};

export type AutomationRunResult = {
  runId: string;
  status: string;
  steps: RunStep[];
};

export class AutomationExecuteError extends Error {}

export async function loadAutomation(orgId: string, automationId: string): Promise<AutomationRow | null> {
  const rows = await db.execute<AutomationRow>(sql`
    select id, org_id as "orgId", name, status, trigger, rules, conditions, actions, version
      from automations
     where org_id = ${orgId} and id = ${automationId}
     limit 1
  `);
  return rows.rows[0] ?? null;
}

async function requireAutomationsPermission(
  orgId: string,
  actorId: string,
  permission: "automations.read" | "automations.manage" | "automations.run",
): Promise<void> {
  const ok = await actorHasPermission(db, orgId, actorId, permission);
  if (!ok) {
    throw new AutomationExecuteError(
      `automation access requires the ${permission} permission — ask an administrator to grant it in /admin/roles`,
    );
  }
}

function fingerprintFor(trigger: unknown, payload: Record<string, unknown>): string {
  const kind = (trigger as { kind?: string } | null)?.kind ?? "manual";
  const stable = JSON.stringify({ kind, payload: sortKeys(payload) });
  let hash = 0;
  for (let i = 0; i < stable.length; i++) hash = (hash * 31 + stable.charCodeAt(i)) | 0;
  return `${kind}:${(hash >>> 0).toString(16)}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Resolve a `to` target to user ids: a user UUID, 'manager', 'initiator', or 'role:<key>'. */
export async function resolveActionRecipients(
  orgId: string,
  to: string,
  subject: SubjectSnapshot | null,
  initiatorUserId?: string | null,
): Promise<string[]> {
  if (to === "initiator") return initiatorUserId ? [initiatorUserId] : [];
  if (to === "manager") {
    const managerId = subject?.fields["manager_employment_id"];
    if (typeof managerId !== "string" || !managerId) return [];
    const rows = await db.execute<{ id: string }>(sql`
      select u.id
        from users u
        join worker_employments e on e.org_id = u.org_id and e.worker_party_id = u.party_id
       where u.org_id = ${orgId} and e.id = ${managerId} and u.is_active
       limit 5
    `);
    return rows.rows.map((r) => r.id);
  }
  if (to.startsWith("role:")) {
    const key = to.slice("role:".length);
    if (!key) {
      throw new AutomationExecuteError(
        "action recipient 'role:' names no role — use 'role:<key>' with an org role key, a user id, 'manager', or 'initiator'",
      );
    }
    const rows = await db.execute<{ id: string }>(sql`
      select u.id
        from users u
        join role_assignments a on a.org_id = u.org_id and a.user_id = u.id
        join app_roles r on r.org_id = a.org_id and r.id = a.role_id and r.key = ${key}
       where u.org_id = ${orgId} and u.is_active
    `);
    return rows.rows.map((r) => r.id);
  }
  const rows = await db.execute<{ id: string }>(sql`
    select id from users where org_id = ${orgId} and id = ${to} and is_active limit 1
  `);
  if (rows.rows.length === 0) {
    throw new AutomationExecuteError(
      `action recipient '${to}' resolves to no active user in this org — use a user id, 'role:<key>', 'manager', or 'initiator'`,
    );
  }
  return [rows.rows[0]!.id];
}

async function runActionLive(
  orgId: string,
  runId: string,
  index: number,
  action: AutomationAction,
  subject: SubjectSnapshot | null,
  subjectId: string | null,
  initiatorUserId: string | null,
  automationName: string,
): Promise<string> {
  switch (action.kind) {
    case "send_notification": {
      const users = await resolveActionRecipients(orgId, action.to, subject, initiatorUserId);
      if (users.length === 0) return "skipped: no recipients resolved";
      // The existing notifications insert path (same table, same drizzle
      // insert flows/execute.ts uses) — no new channel.
      await db.insert(schema.notifications).values(
        users.map((userId) => ({
          orgId,
          userId,
          kind: "automation",
          title: action.body.slice(0, 200),
          body: action.body,
          href: "/admin/automations",
        })),
      );
      return `notify→${users.length}`;
    }
    case "create_task": {
      const users = action.ownerKind === "person" && action.owner
        ? await resolveActionRecipients(orgId, action.owner, subject, initiatorUserId)
        : action.ownerKind === "role" && action.owner
          ? await resolveActionRecipients(orgId, `role:${action.owner}`, subject, initiatorUserId)
          : await resolveActionRecipients(
            orgId,
            action.ownerKind === "manager" ? "manager" : "initiator",
            subject,
            initiatorUserId,
          );
      if (users.length === 0) return "skipped: no owner resolved";
      const due = action.dueOffsetDays > 0
        ? ` Due in ${action.dueOffsetDays} day${action.dueOffsetDays === 1 ? "" : "s"}.`
        : "";
      await db.insert(schema.notifications).values(
        users.map((userId) => ({
          orgId,
          userId,
          kind: "automation_task",
          title: action.title.slice(0, 200),
          body: `${action.title}.${due}`,
          href: "/admin/automations",
        })),
      );
      // Tasks surface as actionable inbox notifications (the HR-15 inbox
      // shows the automation run log and these task notifications) until a
      // native task entity exists — never a parallel task table.
      return `task→${users.length}`;
    }
    case "send_email": {
      const users = await resolveActionRecipients(orgId, action.to, subject, initiatorUserId);
      if (users.length === 0) return "skipped: no recipients resolved";
      // Postgres array literal (the `{a,b}` house shape): a raw JS array
      // bind casts a scalar to uuid[] and every send_email run fails.
      const emails = await db.execute<{ email: string }>(sql`
        select email from users where org_id = ${orgId} and id = any(${`{${users.join(",")}}`}::uuid[])
      `);
      const to = emails.rows.map((r) => r.email);
      if (to.length === 0) return "skipped: no recipient emails";
      // The key resolves through the closed registry (unknown keys refuse
      // here for already-stored rows, and at publish for new ones) and
      // renders through the shared packages/emails shell — the same
      // builder flows/send_email uses — never a placeholder body.
      const draft = renderAutomationEmailTemplate(action.templateKey, {
        automationName,
        subjectEntity: subject?.entity ?? null,
      });
      const orgRows = await db.execute<{ name: string }>(sql`
        select name from orgs where id = ${orgId} limit 1
      `);
      const brand = orgRows.rows[0]?.name ?? "OpenBooks";
      const { flowNotificationEmail } = await import("@openbooks/emails");
      const mail = flowNotificationEmail({ orgName: brand, subject: draft.subject, body: draft.body });
      await enqueueFlowEmail({
        orgId,
        runId,
        occurrenceKey: `${runId}:automation:${index}`,
        payload: {
          to,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          meta: { category: "automation" },
        },
      });
      return `email→${to.length}`;
    }
    case "update_field": {
      assertWritableField(action.entity, action.field);
      // Writes ride the Flows subject adapter's setField — the adapter
      // owns the write vocabulary, so update_field can never become an
      // arbitrary write. Employment has no writable fields (its versions
      // change only through change requests), so employment writes are
      // refused at the allowlist with that remedy.
      const adapter = getFlowAdapter(action.entity);
      if (!adapter) {
        throw new AutomationExecuteError(
          `update_field on entity '${action.entity}' has no Flows subject adapter — only adapter-backed entities may be written`,
        );
      }
      if (!subjectId) {
        throw new AutomationExecuteError("update_field needs a subject — manual runs without a subject refuse field writes");
      }
      await adapter.setField(subjectId, action.field, action.value ?? null, { orgId, userId: initiatorUserId });
      return `update_field:${action.entity}.${action.field}`;
    }
    case "start_process": {
      const employmentId = subject?.entity === "employment" ? subjectId : null;
      if (!employmentId) {
        throw new AutomationExecuteError(
          "start_process needs an employment subject — run this automation from an employment trigger or pick the employment in simulate",
        );
      }
      await openProcessInTx(db, {
        orgId,
        actorId: initiatorUserId ?? "",
        employmentId,
        kind: "onboarding",
        // The opened process is effective on the org's business day, never the
        // UTC day (which is tomorrow in the evening for the Americas).
        effectiveDate: await businessToday(orgId),
        templateId: action.templateId,
        openedByChangeId: null,
      });
      return `process started`;
    }
    case "start_flow":
    case "approve_step":
    case "delay":
    case "webhook": {
      return await runDeferredAction(orgId, runId, index, action);
    }
  }
}

async function runDeferredAction(
  _orgId: string,
  _runId: string,
  _index: number,
  action: AutomationAction,
): Promise<string> {
  // Every formerly "deferred" kind refuses: delay has no continuation
  // store, approve_step cannot mint a gate, start_flow has no dispatch
  // entrypoint, webhook has no transport. Returning a success string
  // would stamp the step succeeded for work that never happened, so each
  // branch throws the same named remedy publish-time validation gives.
  if (action.kind === "delay" || action.kind === "approve_step" || action.kind === "start_flow") {
    throw new AutomationExecuteError(
      `${unsupportedAutomationActionRefusal(action)} — edit the automation to remove the action, then re-enable it`,
    );
  }
  if (action.kind === "webhook") {
    // No outbound webhook transport exists (no outbox kind, no worker, no
    // endpoint caller), so a stored webhook action can never send: refuse
    // by name instead of failing every run inside email validation. The
    // run fails, the recipe surfaces error, and the remedy names the
    // replacement — publish-time validation stops new rows from arriving.
    throw new AutomationExecuteError(
      `${unsupportedAutomationActionRefusal(action)} — edit the automation to replace the webhook action, then re-enable it`,
    );
  }
  throw new AutomationExecuteError(`action kind '${(action as { kind: string }).kind}' is not executable yet — remove it and save again`);
}

/**
 * Execute one automation firing. Live mode writes; simulated mode builds
 * the step list with no writes (the simulator wraps this and proves it).
 */
export async function executeAutomation(input: {
  orgId: string;
  actorId: string;
  automationId: string;
  subjectEntity?: string | null;
  subjectId?: string | null;
  previous?: Record<string, unknown> | null;
  triggerPayload?: Record<string, unknown>;
  mode?: ExecuteMode;
  fingerprint?: string;
  /** Subsidiaries the actor may act on; null = unrestricted (explicit sentinel, never omitted). */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<AutomationRunResult> {
  const mode = input.mode ?? "live";
  // Feature-off: triggers must not fire from any caller (the routes 404
  // first; this is the second fence for the tick and replays).
  const on = await automationsFeatureOn(input.orgId);
  if (!on) {
    throw new AutomationExecuteError(
      "automations are switched off for this organization — enable them in Company Settings → Features before running",
    );
  }
  if (mode === "live") {
    await requireAutomationsPermission(input.orgId, input.actorId, "automations.run");
  } else {
    await requireAutomationsPermission(input.orgId, input.actorId, "automations.read");
  }
  return withOrg(input.orgId, async () => {
    const automation = await loadAutomation(input.orgId, input.automationId);
    if (!automation) {
      throw new AutomationExecuteError("automation not found — it may have been deleted; reload the list and try again");
    }
    if (mode === "live" && automation.status !== "enabled") {
      throw new AutomationExecuteError(
        `automation '${automation.name}' is ${automation.status} — enable it before running; disabled automations never fire`,
      );
    }
    const rules = parseAutomationRules(automation.rules);
    const conditions = parseAutomationConditions(automation.conditions);
    const actions = parseAutomationActions(automation.actions);

    let subject: SubjectSnapshot | null = null;
    if (input.subjectEntity && input.subjectId) {
      if (!registryEntity(input.subjectEntity)) {
        throw new AutomationExecuteError(
          `unknown automation entity '${input.subjectEntity}' — use one the registry declares`,
        );
      }
      subject = await loadSubjectSnapshot(input.orgId, input.subjectEntity, input.subjectId, input.previous ?? null);
      // Subject scope: a subject whose snapshot carries subsidiary lineage
      // outside the actor's scope answers exactly like a deleted record —
      // the same gone-refusal in live mode, the same subject-less steps in
      // simulate — so a restricted caller can neither run against nor probe
      // another entity's employment or leave record. Entities without
      // subsidiary lineage keep their existing behavior.
      if (subject) {
        const subsidiaryId = subject.scope?.subsidiaryId;
        if (
          typeof subsidiaryId === "string" &&
          subsidiaryId !== "" &&
          !subsidiaryScopeAllows(input.allowedSubsidiaryIds, subsidiaryId)
        ) {
          subject = null;
        }
      }
      if (!subject && mode === "live") {
        throw new AutomationExecuteError("the automation subject is gone — the record was deleted; nothing fired");
      }
    }

    const fingerprint = input.fingerprint
      ?? fingerprintFor(automation.trigger, input.triggerPayload ?? {});
    const subjectKind = input.subjectEntity ?? null;
    const subjectId = input.subjectId ?? null;

    if (mode === "simulated") {
      // Simulate evaluates the same gate the live path uses: a subject that
      // matches nothing reports skipped_no_match with no steps, never a
      // pretend step list.
      if (subject) {
        const verdict = evaluateAutomation(rules, conditions, subject);
        if (verdict === "no_match") return { runId: "simulated", status: "simulated", steps: [] };
      }
      const steps = await simulateSteps(actions, subject);
      return { runId: "simulated", status: "simulated", steps };
    }

    // Idempotent run claim, serialized per fingerprint: NULL subjects never
    // match a UNIQUE (NULL <> NULL in Postgres), so the fence is an
    // advisory xact lock plus a null-safe re-read (IS NOT DISTINCT FROM) —
    // the UNIQUE stays as the backstop for subject-bound runs. ON CONFLICT
    // DO NOTHING below is justified: the conflict is the expected benign
    // case (a re-fired trigger) and the existing row is re-read and
    // returned, so a re-fire never double-runs.
    const lockKey = `${input.orgId}:${input.automationId}:${subjectKind ?? ""}:${subjectId ?? ""}:${fingerprint}`;
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const duplicate = await db.execute<{ id: string; status: string }>(sql`
      select id, status from automation_runs
       where org_id = ${input.orgId} and automation_id = ${input.automationId}
         and subject_kind is not distinct from ${subjectKind}::text
         and subject_id is not distinct from ${subjectId}::uuid
         and trigger_fingerprint = ${fingerprint}
       limit 1
    `);
    if (duplicate.rows[0]) {
      const row = duplicate.rows[0];
      return { runId: row.id, status: row.status, steps: [] };
    }
    const claimed = await db.execute<{ id: string }>(sql`
      insert into automation_runs
        (org_id, automation_id, version, trigger_payload, subject_kind, subject_id, status, started_at, trigger_fingerprint, created_by)
      values (${input.orgId}, ${input.automationId}, ${automation.version},
              ${JSON.stringify(input.triggerPayload ?? {})}::jsonb,
              ${subjectKind}, ${subjectId}, 'running', now(), ${fingerprint}, ${input.actorId})
      on conflict (org_id, automation_id, subject_kind, subject_id, trigger_fingerprint) do nothing
      returning id
    `);
    if (claimed.rows.length === 0) {
      const existing = await db.execute<{ id: string; status: string }>(sql`
        select id, status from automation_runs
         where org_id = ${input.orgId} and automation_id = ${input.automationId}
           and subject_kind is not distinct from ${subjectKind}::text
           and subject_id is not distinct from ${subjectId}::uuid
           and trigger_fingerprint = ${fingerprint}
         limit 1
      `);
      const row = existing.rows[0];
      if (!row) {
        throw new AutomationExecuteError("the run claim raced and vanished — retry the run");
      }
      return { runId: row.id, status: row.status, steps: [] };
    }
    const runId: string = claimed.rows[0]!.id;

    if (subject) {
      const verdict = evaluateAutomation(rules, conditions, subject);
      if (verdict === "no_match") {
        await db.execute(sql`
          update automation_runs set status = 'skipped_no_match', finished_at = now(), updated_at = now()
           where id = ${runId} and org_id = ${input.orgId}
        `);
        return { runId, status: "skipped_no_match", steps: [] };
      }
    }

    // The run's DB writes happen in ONE savepoint: a failed step throws,
    // the savepoint rolls the run's writes back (a bare throw cannot be
    // trusted to roll back under an ambient transaction the caller may
    // still commit — the flows decideGateCore savepoint exists for the same
    // swallowed-error topology), and the run row is then marked failed with
    // the error — the inbox shows the failure.
    const steps: RunStep[] = [];
    try {
      await withTransactionSavepoint(db, async () => {
        let i = 0;
        for (const action of actions) {
          i += 1;
          const output = await runActionLive(input.orgId, runId, i, action, subject, subjectId, input.actorId, automation.name);
          steps.push({ index: i, kind: action.kind, status: "succeeded", output });
        }
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await db.execute(sql`
        update automation_runs
           set status = 'failed', finished_at = now(), updated_at = now(),
               error = ${JSON.stringify({ message })}::jsonb,
               steps = ${JSON.stringify(steps)}::jsonb
         where id = ${runId} and org_id = ${input.orgId}
      `);
      // The automation itself surfaces the breakage until fixed.
      await db.execute(sql`
        update automations set status = 'error', error_message = ${message}, updated_at = now()
         where id = ${input.automationId} and org_id = ${input.orgId}
      `);
      // Owner visibility: a run row the inbox shows (HR-15 automation_error
      // adapter) plus a notification to the actor who fired it — same table,
      // same insert path as every other notification.
      await db.insert(schema.notifications).values({
        orgId: input.orgId,
        userId: input.actorId,
        kind: "automation_error",
        title: `Automation '${automation.name}' failed`,
        body: message,
        href: "/admin/automations",
      });
      return {
        runId,
        status: "failed",
        steps: [...steps, { index: steps.length + 1, kind: "run", status: "failed" as const, error: message }],
      };
    }

    await db.execute(sql`
      update automation_runs
         set status = 'succeeded', finished_at = now(), updated_at = now(),
             steps = ${JSON.stringify(steps)}::jsonb
       where id = ${runId} and org_id = ${input.orgId}
    `);
    await db.execute(sql`
      update automations set last_run_at = now(), updated_at = now()
       where id = ${input.automationId} and org_id = ${input.orgId}
    `);
    return { runId, status: "succeeded", steps };
  });
}

async function simulateSteps(actions: AutomationAction[], subject: SubjectSnapshot | null): Promise<RunStep[]> {
  return actions.map((action, i) => {
    // Simulate refuses what live refuses: a step that can never run must
    // never preview as "simulated" success.
    const refusal = unsupportedAutomationActionRefusal(action);
    if (refusal) {
      return { index: i + 1, kind: action.kind, status: "failed" as const, error: refusal };
    }
    if (action.kind === "update_field") {
      try {
        assertWritableField(action.entity, action.field);
      } catch (e) {
        return { index: i + 1, kind: action.kind, status: "failed" as const, error: e instanceof Error ? e.message : String(e) };
      }
    }
    if ((action.kind === "start_process" || action.kind === "update_field") && !subject) {
      return { index: i + 1, kind: action.kind, status: "skipped" as const, output: "needs a subject — pick one and simulate again" };
    }
    return { index: i + 1, kind: action.kind, status: "simulated" as const, output: "no writes in simulate mode" };
  });
}
