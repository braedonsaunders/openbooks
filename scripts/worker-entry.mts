/**
 * Worker process composition entry (HR-16).
 *
 * The worker boot (engine/src/worker/index.ts) cannot import the
 * automations engine module: worker sits inside the pinned engine
 * dependency cycle and automations reaches back into it through flows,
 * so that edge would grow the pinned cycle the boundary check refuses.
 * Composition therefore lives HERE, outside the engine module graph
 * (like web/instrumentation.node.ts for the web process): this file
 * registers process duties into the engine/src/worker duty registry and
 * then boots the worker. No engine file imports automations; the
 * dependency points from this entry into automations only.
 *
 * Run directly (`tsx scripts/worker-entry.ts`, the `worker` npm script,
 * the Dockerfile worker bundle source). Importing without running (tests)
 * registers duties without booting: the worker boot below runs only when
 * this file IS the process entry point.
 */
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { registerWorkerDuty } from "../engine/src/worker/duties.ts";
import { AUTOMATION_TICK_LOCK_KEY, runAutomationTickClaimed } from "../engine/src/automations/tick.ts";
import { runQualificationAlertScan } from "../engine/src/hrm/qualifications/alerts.ts";
import { db, withBypassContext, withOrgTransaction } from "../engine/src/platform/db.ts";
import { businessToday } from "../engine/src/platform/business-date.ts";
import { runRetentionTick } from "../engine/src/hrm/documents/retention.ts";
import { drainExportQueue } from "../engine/src/hrm/documents/dsar.ts";
import {
  dueReminderSigners,
  recordDocumentReminded,
} from "../engine/src/hrm/documents/documents.ts";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransport,
} from "../engine/src/delivery/email-config.ts";
import { writeNotification } from "../engine/src/inbox/adapters/notification.ts";
import {
  deriveEmailDeliveryKey,
  hrmSignatureRequestEmail,
  sendVia,
} from "@openbooks/emails";

/**
 * HR-19 duties (one scanner per key; the registry refuses duplicates).
 *
 * hrm-retention-tick: the daily retention job — expire stale sends, start
 * clocks, flag due documents, execute past-grace actions unless held.
 * hrm-dsar-exports: drain queued subject-access exports (the zip builds
 * in the worker, never inline). hrm-document-reminders: nudge open
 * signers past the reminder threshold through the org transport, then
 * record the reminded event. Every duty scans only orgs with the parent
 * switch on, claims one org at a time on its own advisory key, and logs
 * instead of throwing — a duty that throws aborts its siblings.
 */
async function orgsWithFeature(feature: string): Promise<string[]> {
  const rows = await withBypassContext(() =>
    db.execute<{ id: string }>(sql`
      select id from orgs
       where coalesce((settings->'features'->>${feature})::boolean, false)
    `),
  );
  return rows.rows.map((r) => r.id);
}

/**
 * Claim one org-day for a duty on its own advisory key, run, and ALWAYS
 * unlock: a session-level lock left held on a pooled connection would
 * skip every later tick on that connection — the scan would run once
 * and then silently never again.
 */
async function withOrgClaim(
  key: string,
  orgId: string,
  today: string,
  fn: () => Promise<void>,
): Promise<void> {
  const lockSql = sql`select pg_try_advisory_lock(hashtextextended(${`${key}:${orgId}:${today}`}, 0)) as locked`;
  const row = (await withBypassContext(() => db.execute<{ locked: boolean }>(lockSql))).rows[0];
  if (row?.locked !== true) return;
  try {
    await fn();
  } finally {
    await withBypassContext(() =>
      db.execute(sql`select pg_advisory_unlock(hashtextextended(${`${key}:${orgId}:${today}`}, 0))`),
    ).catch((e: unknown) => console.error(`[worker] ${key} unlock failed:`, (e as Error).message));
  }
}

async function runRetentionDuty(now: Date): Promise<void> {
  for (const orgId of await orgsWithFeature("hrmDocumentRetention")) {
    const today = await businessToday(orgId);
    await withOrgClaim("hrm-retention-tick", orgId, today, async () => {
    try {
      const result = await runRetentionTick(orgId, today);
      console.log(`[worker] hrm-retention-tick ${orgId}: ${JSON.stringify(result)}`);
    } catch (e) {
      console.error(`[worker] hrm-retention-tick ${orgId} failed:`, (e as Error).message);
    }
    });
  }
  void now;
}

async function runDsarDuty(): Promise<void> {
  for (const orgId of await orgsWithFeature("hrmDataSubjectExport")) {
    const today = await businessToday(orgId);
    await withOrgClaim("hrm-dsar-exports", orgId, today, async () => {
    try {
      const done = await drainExportQueue(orgId, 5);
      if (done > 0) console.log(`[worker] hrm-dsar-exports ${orgId}: built ${done}`);
    } catch (e) {
      console.error(`[worker] hrm-dsar-exports ${orgId} failed:`, (e as Error).message);
    }
    });
  }
}

async function runReminderDuty(): Promise<void> {
  for (const orgId of await orgsWithFeature("hrmDocuments")) {
    const today = await businessToday(orgId);
    await withOrgClaim("hrm-document-reminders", orgId, today, async () => {
    try {
      await withOrgTransaction(orgId, async () => {
        const due = await dueReminderSigners(db, orgId, 3);
        for (const signer of due) {
          const user = (await db.execute<{ id: string; email: string }>(sql`
            select id, email from users where org_id = ${orgId} and party_id = ${signer.partyId} limit 1
          `)).rows[0];
          const org = (await db.execute<{ name: string }>(sql`
            select name from orgs where id = ${orgId}
          `)).rows[0];
          const person = (await db.execute<{ name: string; email: string | null }>(sql`
            select coalesce(display_name, legal_name, 'Unnamed') as name, email
              from parties where org_id = ${orgId} and id = ${signer.partyId}
          `)).rows[0];
          const email = user?.email ?? person?.email ?? null;
          const appBase = (process.env.OPENBOOKS_APP_URL ?? "").trim().replace(/\/+$/, "");
          let delivered = false;
          const transport = email ? await resolveOrgEmailTransport(orgId) : null;
          if (email && transport && appBase) {
            // The reminder reuses the signer's live link intent: resolve
            // the token is impossible (only its hash is stored), so the
            // email points at the document list — the in-app notification
            // carries the actionable path. A reminder never mints a new
            // token: one token per signer, always.
            const tpl = hrmSignatureRequestEmail({
              orgName: org?.name ?? "Your organization",
              docTitle: `${signer.title} (reminder)`,
              signerName: person?.name ?? undefined,
              signUrl: `${appBase}/me/documents`,
            });
            const logId = await insertEmailLog({
              orgId,
              recipients: [email],
              subject: tpl.subject,
              status: "queued",
              categoryKey: "hrm.reminder",
              meta: { signerId: signer.signerId, documentId: signer.documentId },
            });
            try {
              const outcome = await sendVia(
                transport,
                { to: email, subject: tpl.subject, html: tpl.html, text: tpl.text },
                {
                  deliveryKey: deriveEmailDeliveryKey({
                    orgId,
                    scope: `reminder:${logId}`,
                    to: email,
                  }),
                },
              );
              if (outcome.kind === "sent") {
                await markEmailSent(orgId, logId, outcome.providerMessageId);
                delivered = true;
              } else {
                await markEmailUncertain(orgId, logId, outcome.reason);
              }
            } catch (e) {
              await markEmailFailed(orgId, logId, e instanceof Error ? e.message : String(e));
            }
          }
          if (user) {
            await writeNotification(db, {
              orgId,
              userId: user.id,
              kind: "hrm.document.reminder",
              title: `Reminder: sign ${signer.title}`,
              body: `${org?.name ?? "Your organization"} is still waiting for your signature on ${signer.title}, sent ${signer.sentAt}.`,
              href: "/me/documents",
              createdBy: null,
              updatedBy: null,
            });
            delivered = true;
          }
          // The event witnesses an actual send, never an attempt.
          if (delivered) await recordDocumentReminded(db, orgId, signer.signerId);
        }
      });
    } catch (e) {
      console.error(`[worker] hrm-document-reminders ${orgId} failed:`, (e as Error).message);
    }
    });
  }
}

export function registerWorkerDuties(): void {
  // One scanner per key (the registry refuses duplicates): the automation
  // tick covers schedule, date-relative, and queued field-change / event /
  // document triggers, claimed across replicas on its own advisory key.
  console.log(`[worker] duty registered: automation-tick (${AUTOMATION_TICK_LOCK_KEY})`);
  registerWorkerDuty({
    key: "automation-tick",
    run: async (now: Date) => {
      await runAutomationTickClaimed(now);
    },
  });
  // HR-14 begin: the daily qualification-expiry scan. Idempotent per
  // (qualification, lead_days) and self-serializing per org on its own
  // advisory key, so the 60-second tick simply re-runs it: off-schedule
  // days change nothing and a second replica changes nothing.
  console.log(`[worker] duty registered: qualification-alerts`);
  registerWorkerDuty({
    key: "qualification-alerts",
    run: async (now: Date) => {
      await runQualificationAlertScan(now);
    },
  });
  // HR-14 end
  console.log("[worker] duty registered: hrm-retention-tick");
  registerWorkerDuty({
    key: "hrm-retention-tick",
    run: async (now: Date) => {
      await runRetentionDuty(now);
    },
  });
  console.log("[worker] duty registered: hrm-dsar-exports");
  registerWorkerDuty({
    key: "hrm-dsar-exports",
    run: async () => {
      await runDsarDuty();
    },
  });
  console.log("[worker] duty registered: hrm-document-reminders");
  registerWorkerDuty({
    key: "hrm-document-reminders",
    run: async () => {
      await runReminderDuty();
    },
  });
}

registerWorkerDuties();

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // Boot the worker (queues, schedulers, heartbeat). Imported lazily so a
  // test import of this entry registers duties without starting the world:
  // engine/src/worker/index.ts self-starts on import. No top-level await:
  // tsx compiles scripts-adjacent files as CJS, where TLA is unsupported.
  void import("../engine/src/worker/index.ts").catch((error: unknown) => {
    console.error("[worker] startup failed:", error);
    process.exit(1);
  });
}
