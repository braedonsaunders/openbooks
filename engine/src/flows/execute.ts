import { and, eq, inArray, sql } from "drizzle-orm";
import {
  interpolateTemplate,
  resolveDefaultValue,
  type ActionData,
  type AutomationPlan,
  type EvalContext,
  type GateData,
} from "@openbooks/forms-core";
import { db, schema } from "../db.ts";
import type { FlowExecCtx, FlowSubjectAdapter } from "./types.ts";
import {
  resolveAssigneeUsers,
  resolveRecipientEmails,
  resolveRecipientUsers,
  supervisorOf,
} from "./targets.ts";
import { emailActionUrls } from "./email-tokens.ts";
import { lockRecord, unlockRecord } from "./locks.ts";
import { renderFlowPdf } from "./pdf-hook.ts";

/**
 * The ONE flows executor — subject-agnostic, ported from beaconhs-platform's
 * lib/flows/execute-flow-plan.ts. Runs a planned graph (actions + gates)
 * against any FlowSubjectAdapter; everything record-specific is an adapter
 * call. Differences from beaconhs:
 *
 *   • Checkpoints live in flow_run_effects keyed `${flowId}:action:${nodeId}`
 *     (beaconhs reused its domain-event effects table) — re-executing a run
 *     (a resume after a gate, or a retry after a failure) skips completed
 *     effects instead of double-sending.
 *   • Gates fan out to MULTIPLE flow_gates rows (one per resolved assignee,
 *     shared groupKey, quorum any/all) with reminder/escalation timestamps —
 *     beaconhs gates were single-assignee.
 *   • Per-action try/catch preserved: a failure records itself and BREAKS the
 *     chain (later actions in this plan do not run; effects let a future
 *     retry resume from the failed node).
 */

export interface ExecuteFlowPlanParams {
  flow: { id: string; name: string; subjectKind: string; graph: Record<string, unknown> };
  runId: string;
  subjectId: string;
  plan: AutomationPlan;
  evalCtx: EvalContext;
  submitterUserId?: string | null;
}

export interface ExecuteFlowPlanResult {
  /** Node-effect descriptions that completed this pass. */
  completed: string[];
  /** `${action} (${reason})` entries; non-empty ⇒ the chain broke. */
  failed: string[];
  gatesCreated: number;
}

/** Org display name for email shells (best-effort). */
async function orgName(orgId: string): Promise<string> {
  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, orgId));
  return org?.name ?? "OpenBooks";
}

/**
 * Org control accounts for post_document. Same source as web/lib/documents.ts
 * controlDeps + payments.ts paymentControlDeps: orgs.settings.controlAccounts.
 */
async function postingDeps(orgId: string): Promise<{
  control: { ar: string; ap: string; bank: string; taxCollected?: string; taxPaid?: string; employeePayable?: string };
}> {
  const r = (await db.execute(
    sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`,
  )) as unknown as { rows: { c: Record<string, string> | null }[] };
  const c = r.rows[0]?.c ?? {};
  if (!c.ap || !c.ar || !c.bank) {
    throw new Error("org control accounts are not configured (orgs.settings.controlAccounts)");
  }
  return {
    control: {
      ar: c.ar,
      ap: c.ap,
      bank: c.bank,
      taxCollected: c.taxCollected,
      taxPaid: c.taxPaid,
      employeePayable: c.employeePayable,
    },
  };
}

export async function executeFlowPlan(
  ctx: FlowExecCtx,
  adapter: FlowSubjectAdapter,
  params: ExecuteFlowPlanParams,
): Promise<ExecuteFlowPlanResult> {
  const { flow, runId, subjectId, plan } = params;
  // Strip inherited properties — special keys ("__proto__", …) become plain
  // own data properties before any lookup (beaconhs hardening, preserved).
  const values = Object.fromEntries(Object.entries(params.evalCtx.values));
  const evalCtx: EvalContext = { values, rows: params.evalCtx.rows ?? {} };
  const targetCtx = { orgId: ctx.orgId, submitterUserId: params.submitterUserId, values };

  const completed: string[] = [];
  const failed: string[] = [];
  let gatesCreated = 0;

  // --- Effect checkpoints ---------------------------------------------------
  const completedEffects = new Set<string>();
  {
    const rows = await db
      .select({ effectKey: schema.flowRunEffects.effectKey })
      .from(schema.flowRunEffects)
      .where(eq(schema.flowRunEffects.runId, runId));
    for (const row of rows) completedEffects.add(row.effectKey);
  }
  const markEffectComplete = async (effectKey: string, detail: Record<string, unknown>) => {
    await db
      .insert(schema.flowRunEffects)
      .values({ orgId: ctx.orgId, runId, effectKey, detail })
      .onConflictDoNothing();
    completedEffects.add(effectKey);
  };

  const brand = await orgName(ctx.orgId);

  // --- Action handlers --------------------------------------------------------

  const runAction = async (nodeId: string, action: ActionData): Promise<string> => {
    switch (action.action) {
      case "send_email": {
        const to = await resolveRecipientEmails(action.to, targetCtx);
        if (to.length === 0) throw new Error("no recipients resolved");
        const subject = interpolateTemplate(action.subject, evalCtx) || "Notification";
        const body = interpolateTemplate(action.body, evalCtx);
        // attachPdf: render the record's PDF via the hook the web process
        // registers at boot; a process without a renderer (standalone worker)
        // still sends the email, minus the attachment, with a warning noted
        // on the effect. A renderer FAILURE also degrades the same way — a
        // remittance email without its PDF beats no email.
        let attachments: Array<{ filename: string; content: string; contentType: string }> = [];
        let pdfNote = "";
        if (action.attachPdf) {
          try {
            const pdf = await renderFlowPdf({
              orgId: ctx.orgId,
              subjectKind: flow.subjectKind,
              subjectId,
            });
            // The email queue's attachment payload is base64 (JSON-safe for Redis).
            if (pdf) {
              attachments = [
                {
                  filename: pdf.filename,
                  content: pdf.content.toString("base64"),
                  contentType: pdf.contentType,
                },
              ];
            } else pdfNote = " (pdf unavailable in this process, sent without attachment)";
          } catch (e) {
            console.error(`[flows] attachPdf render failed (run ${runId}):`, e);
            pdfNote = " (pdf render failed, sent without attachment)";
          }
        }
        try {
          const [{ enqueueEmail }, { flowNotificationEmail }] = await Promise.all([
            import("@openbooks/jobs"),
            import("@openbooks/emails"),
          ]);
          const mail = flowNotificationEmail({ orgName: brand, subject, body });
          await enqueueEmail({
            orgId: ctx.orgId,
            to,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
            ...(attachments.length > 0 ? { attachments } : {}),
            meta: { category: "flows" },
          });
        } catch (e) {
          // The queue is the durable transport; when Redis is down we record
          // the skip on the effect rather than failing the whole run — the
          // rest of the flow (status changes, gates) matters more than one
          // notification (same posture as scheduler.ts's inline fallback).
          console.error(`[flows] send_email enqueue failed (run ${runId}):`, e);
          await markEffectComplete(`${flow.id}:action:${nodeId}`, {
            action: "send_email",
            skipped: "email queue unavailable",
            to: to.length,
          });
          return `send_email→${to.length} (queue unavailable, skipped)`;
        }
        return `send_email→${to.length}${pdfNote}`;
      }

      case "notify": {
        const users = await resolveRecipientUsers(action.to, targetCtx);
        if (users.length === 0) throw new Error("no users resolved");
        const title = interpolateTemplate(action.title, evalCtx) || "Notification";
        const body = action.body ? interpolateTemplate(action.body, evalCtx) : null;
        const href = action.href ? interpolateTemplate(action.href, evalCtx) : adapter.deepLink(subjectId);
        await db.insert(schema.notifications).values(
          users.map((u) => ({
            orgId: ctx.orgId,
            userId: u.id,
            kind: "flow",
            title,
            body,
            href,
          })),
        );
        return `notify→${users.length}`;
      }

      case "set_field": {
        const v = resolveDefaultValue(action.value, evalCtx);
        await adapter.setField(subjectId, action.field, v ?? null, ctx);
        // Later nodes in this run see the new value.
        Object.defineProperty(values, action.field, {
          value: v ?? null,
          configurable: true,
          enumerable: true,
          writable: true,
        });
        return `set_field:${action.field}`;
      }

      case "change_status": {
        await adapter.changeStatus(subjectId, action.to, ctx);
        Object.defineProperty(values, "status", {
          value: action.to,
          configurable: true,
          enumerable: true,
          writable: true,
        });
        return `change_status→${action.to}`;
      }

      case "post_document": {
        let entryId: string;
        if (
          adapter.subjectKind === "vendor_payment" ||
          adapter.subjectKind === "customer_payment"
        ) {
          // Payment posting is a larger accounting unit than its GL entry:
          // applications, realized FX and provenance links must commit with it.
          const { postPaymentWithApplications } = await import("../payments.ts");
          entryId = (
            await postPaymentWithApplications(
              subjectId,
              undefined,
              ctx.userId ?? undefined,
            )
          ).entryId;
        } else {
          // Break the static import cycle (posting.ts dispatches flows).
          const { postDocument } = await import("../posting.ts");
          const deps = await postingDeps(ctx.orgId);
          entryId = await postDocument(subjectId, deps, {
            audit: { actorId: ctx.userId ?? null, source: "flows" },
          });
        }
        Object.defineProperty(values, "status", {
          value: "posted",
          configurable: true,
          enumerable: true,
          writable: true,
        });
        return `post_document→${entryId}`;
      }

      case "lock_record": {
        await lockRecord({
          orgId: ctx.orgId,
          subjectKind: flow.subjectKind,
          subjectId,
          flowId: flow.id,
          reason: action.reason ? interpolateTemplate(action.reason, evalCtx) : null,
          exemptRoles: action.exemptRoles ?? [],
          userId: ctx.userId ?? null,
        });
        return `lock_record${action.exemptRoles?.length ? ` (exempt: ${action.exemptRoles.join(", ")})` : ""}`;
      }

      case "unlock_record": {
        await unlockRecord(flow.subjectKind, subjectId);
        return "unlock_record";
      }
    }
  };

  for (const { nodeId, action } of plan.actionNodes) {
    const effectKey = `${flow.id}:action:${nodeId}`;
    if (completedEffects.has(effectKey)) continue;
    try {
      const desc = await runAction(nodeId, action);
      completed.push(desc);
      if (!completedEffects.has(effectKey)) {
        await markEffectComplete(effectKey, { action: action.action, detail: desc });
      }
    } catch (e) {
      // beaconhs semantics: record the failure and STOP the chain — later
      // actions likely depend on this one; effects allow resuming here.
      const reason = e instanceof Error ? e.message : String(e);
      failed.push(`${action.action} (${reason})`);
      break;
    }
  }

  // --- Gates → pending approvals ---------------------------------------------
  // Only reached when the action chain didn't break (parity with beaconhs,
  // where a failed chain returned to the outbox for retry before gates).
  if (failed.length === 0) {
    for (const { nodeId, gate } of plan.gates) {
      const effectKey = `${flow.id}:gate:${nodeId}`;
      if (completedEffects.has(effectKey)) continue;
      try {
        const n = await createGate(ctx, adapter, {
          flow,
          runId,
          subjectId,
          nodeId,
          gate,
          evalCtx,
          submitterUserId: params.submitterUserId,
          brand,
        });
        gatesCreated += n;
        await markEffectComplete(effectKey, { gate: gate.title, assignees: n });
        completed.push(`gate "${gate.title}"→${n}`);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        failed.push(`gate (${reason})`);
        break;
      }
    }
  }

  return { completed, failed, gatesCreated };
}

/**
 * Persist one gate node as flow_gates rows (one per resolved assignee, shared
 * groupKey `${runId}:${nodeId}`) + notify/email each assignee. Zero resolved
 * assignees is an ERROR — a silently-passing approval would be worse than a
 * failed run.
 */
async function createGate(
  ctx: FlowExecCtx,
  adapter: FlowSubjectAdapter,
  args: {
    flow: ExecuteFlowPlanParams["flow"];
    runId: string;
    subjectId: string;
    nodeId: string;
    gate: GateData;
    evalCtx: EvalContext;
    submitterUserId?: string | null;
    brand: string;
  },
): Promise<number> {
  const { flow, runId, subjectId, nodeId, gate, evalCtx } = args;
  let assignees = await resolveAssigneeUsers(gate.assignees, {
    orgId: ctx.orgId,
    submitterUserId: args.submitterUserId,
    values: evalCtx.values,
  });

  // preventSelfApproval (or an adapter-level accounting invariant): the
  // record's submitter may not sit on their own gate. Drop them; if that
  // empties the gate, route to their
  // supervisor instead; if THAT resolves nothing, fail the run loudly — a
  // silently self-approvable gate would be worse than a failed run.
  const preventSelfApproval =
    gate.preventSelfApproval === true || adapter.selfApprovalPolicy === "forbidden";
  if (preventSelfApproval && args.submitterUserId) {
    const hadSubmitter = assignees.some((u) => u.id === args.submitterUserId);
    assignees = assignees.filter((u) => u.id !== args.submitterUserId);
    if (hadSubmitter && assignees.length === 0) {
      const sup = await supervisorOf(ctx.orgId, args.submitterUserId);
      if (sup) assignees = [sup];
      else {
        throw new Error(
          `gate "${gate.title}" only resolved to the submitter (self-approval is prevented) and no supervisor was found`,
        );
      }
    }
  }
  if (assignees.length === 0) {
    throw new Error(`gate "${gate.title}" resolved to zero assignees`);
  }

  const title = interpolateTemplate(gate.title, evalCtx) || gate.title;
  const now = Date.now();
  const remindAt = gate.reminderAfterHours ? new Date(now + gate.reminderAfterHours * 3_600_000) : null;
  const escalateAt = gate.escalateAfterHours ? new Date(now + gate.escalateAfterHours * 3_600_000) : null;

  await db
    .insert(schema.flowGates)
    .values(
      assignees.map((u) => ({
        orgId: ctx.orgId,
        flowId: flow.id,
        runId,
        nodeId,
        subjectKind: flow.subjectKind,
        subjectId,
        title,
        assigneeUserId: u.id,
        groupKey: `${runId}:${nodeId}`,
        quorum: gate.mode,
        status: "pending" as const,
        signatureRequired: !!gate.signatureRequired,
        remindAt,
        escalateAt,
        createdBy: ctx.userId ?? null,
      })),
    )
    // Idempotent replays: unique (run_id, node_id, assignee_user_id).
    .onConflictDoNothing();

  const subjectLabel = adapter.label(subjectId, evalCtx.values);
  await db.insert(schema.notifications).values(
    assignees.map((u) => ({
      orgId: ctx.orgId,
      userId: u.id,
      kind: "approval",
      title: `Approval requested: ${title}`,
      body: subjectLabel,
      href: adapter.deepLink(subjectId),
    })),
  );

  try {
    const [{ enqueueEmail }, { flowApprovalRequestEmail }] = await Promise.all([
      import("@openbooks/jobs"),
      import("@openbooks/emails"),
    ]);
    // One-click decision links are bound to a specific gate ROW (gateId +
    // assignee), so read the inserted rows back (this also covers rows
    // skipped by onConflictDoNothing on replay) and send one email per
    // assignee instead of a shared blast.
    const rows = await db
      .select({ id: schema.flowGates.id, assigneeUserId: schema.flowGates.assigneeUserId })
      .from(schema.flowGates)
      .where(
        and(
          eq(schema.flowGates.runId, runId),
          eq(schema.flowGates.nodeId, nodeId),
          eq(schema.flowGates.status, "pending"),
          inArray(schema.flowGates.assigneeUserId, assignees.map((u) => u.id)),
        ),
      );
    const gateRowByAssignee = new Map(rows.map((r) => [r.assigneeUserId, r.id]));
    for (const u of assignees) {
      if (!u.email.includes("@")) continue;
      const gateRowId = gateRowByAssignee.get(u.id);
      const mail = flowApprovalRequestEmail({
        orgName: args.brand,
        gateTitle: title,
        subjectLabel,
        flowName: flow.name,
        ...(gateRowId ? emailActionUrls(gateRowId, u.id) : {}),
      });
      await enqueueEmail({
        orgId: ctx.orgId,
        to: u.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        meta: { category: "approvals" },
      });
    }
  } catch (e) {
    // In-app gate + notification already exist; a down queue only costs the
    // email nudge.
    console.error(`[flows] gate email enqueue failed (run ${runId}):`, e);
  }

  return assignees.length;
}
