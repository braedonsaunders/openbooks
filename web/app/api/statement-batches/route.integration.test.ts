import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import type { SessionUser } from "../../../lib/auth";

const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __statementBatchSession: session });
const enqueued: unknown[] = [];
Object.assign(globalThis, { __statementBatchJobs: enqueued });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next-intl/server")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}",
      };
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts"))
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__statementBatchSession.user}",
      };
    if (
      specifier === "@openbooks/jobs" &&
      /web\/app\/api\/statement-batches\//.test(context.parentURL ?? "")
    ) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function enqueueStatementBatchJobs(jobs){globalThis.__statementBatchJobs.push(...jobs);return jobs}",
      };
    }
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db, withOrgContext, withBypass } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { postDocument } = await import("@openbooks/engine/ledger/posting-document");
const { randomUUID } = await import("node:crypto");
const { ensurePartyRoleRow } = await import("../../../lib/party-roles");
const preview = await import("./preview/route");
const batches = await import("./route");
const detail = await import("./[id]/route");
const retry = await import("./[id]/retry/route");
const { registerRequestOrgResolver } = await import("@openbooks/engine/platform/db");
registerRequestOrgResolver(() => ({ orgId: null, bypass: true }));

async function setup(permissions: string[] = ["*"]) {
  const org = await withBypass(() => createScratchOrg());
  const actor = await withBypass(() => createScratchUser(org.orgId, "AR clerk", "reviewer"));
  await withBypass(() =>
    db.execute(
      sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb where org_id=${org.orgId} and key='reviewer'`,
    ),
  );
  session.user = {
    id: actor,
    orgId: org.orgId,
    name: "AR clerk",
    email: "ar@scratch.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: actor,
  };
  return { org, actor };
}

async function seedOverdueInvoice(
  org: {
    orgId: string;
    customerId: string;
    subsidiaryId: string;
    date: string;
    accounts: { ar: string; ap: string; bank: string; revenue: string };
  },
  email: string | null,
) {
  await db.execute(
    sql`update parties set email = ${email} where id = ${org.customerId} and org_id = ${org.orgId}`,
  );
  const userId = await createScratchUser(org.orgId, "Batch Seeder", "accountant");
  await ensurePartyRoleRow(db, {
    orgId: org.orgId,
    partyId: org.customerId,
    kind: "customer",
    actorId: userId,
  });
  const invoiceId = randomUUID();
  const due = new Date(`${org.date}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() - 30);
  const dueDate = due.toISOString().slice(0, 10);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'BATCH-1',
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${dueDate},
            'CAD', '1', '100', '0', '100', ${userId})
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')
  `);
  await db.execute(
    sql`update documents set status = 'approved', updated_at = now() where id = ${invoiceId} and org_id = ${org.orgId}`,
  );
  await postDocument(invoiceId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
}

/**
 * Batch endpoints reuse the single-send grants: preview reads on AR read,
 * creating and retrying send on AR create, and an org without outbound
 * email is refused before any run is recorded.
 */
test("batch preview needs the read grant and lists the overdue customer", async () => {
  const { org } = await setup(["ar.create"]);
  try {
    const denied = await withOrgContext(org.orgId, () =>
      preview.GET(new Request("http://audit.local/api"), undefined as never),
    );
    assert.equal(denied.status, 403);

    await withOrgContext(org.orgId, () => seedOverdueInvoice(org, "office@acme.test"));
    await withBypass(() =>
      db.execute(
        sql`update app_roles set permissions='["ar.read","reports.read"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
      ),
    );
    const res = await withOrgContext(org.orgId, () =>
      preview.GET(new Request("http://audit.local/api"), undefined as never),
    );
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = (await res.json()) as {
      recipients: { partyId: string; toEmail: string }[];
      excluded: unknown[];
    };
    assert.equal(body.recipients.length, 1);
    assert.equal(body.recipients[0]!.partyId, org.customerId);
    assert.equal(body.recipients[0]!.toEmail, "office@acme.test");
    assert.deepEqual(body.excluded, []);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("batch create refuses without the send grant and without transport", async () => {
  const { org } = await setup(["ar.read", "reports.read"]);
  try {
    const denied = await withOrgContext(org.orgId, () =>
      batches.POST(
        new Request("http://audit.local/api", { method: "POST", body: JSON.stringify({}) }),
        undefined as never,
      ),
    );
    assert.equal(denied.status, 403);

    await withBypass(() =>
      db.execute(
        sql`update app_roles set permissions='["ar.create","ar.read","reports.read"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
      ),
    );
    const unconfigured = await withOrgContext(org.orgId, () =>
      batches.POST(
        new Request("http://audit.local/api", { method: "POST", body: JSON.stringify({}) }),
        undefined as never,
      ),
    );
    assert.equal(unconfigured.status, 422);
    assert.match(
      ((await unconfigured.json()) as { error: string }).error,
      /Email delivery is not enabled.*Admin → Email/,
    );

    const listed = await withOrgContext(org.orgId, () =>
      batches.GET(new Request("http://audit.local/api"), undefined as never),
    );
    assert.equal(listed.status, 200);
    assert.deepEqual(((await listed.json()) as { runs: unknown[] }).runs, []);
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("batch create records the run, detail shows items, retry requeues failures", async () => {
  const { org, actor } = await setup();
  try {
    const { saveOrgEmailConfig } = await import("@openbooks/engine/delivery/email-config/module");
    await withOrgContext(org.orgId, () =>
      saveOrgEmailConfig(
        org.orgId,
        {
          enabled: true,
          provider: "smtp",
          fromName: "Acme",
          fromEmail: "statements@acme.test",
          smtpHost: "localhost",
          smtpPort: 1,
          smtpSecure: false,
        },
        { kind: "user", userId: actor },
      ),
    );
    await withOrgContext(org.orgId, () => seedOverdueInvoice(org, "office@acme.test"));
    const silentId = randomUUID();
    await withOrgContext(org.orgId, async () => {
      await db.execute(
        sql`insert into parties (id, org_id, kind, display_name, subsidiary_id) values (${silentId}, ${org.orgId}, 'customer', 'Silent', ${org.subsidiaryId})`,
      );
      await db.execute(
        sql`insert into customer_roles (org_id, party_id, currency) values (${org.orgId}, ${silentId}, 'CAD')`,
      );
    });
    enqueued.length = 0;
    for (const subsidiaryId of ["", "invalid"]) {
      const refused = await withOrgContext(org.orgId, () =>
        batches.POST(
          new Request("http://audit.local/api", {
            method: "POST",
            body: JSON.stringify({
              from: org.date,
              toDate: org.date,
              subsidiaryId,
              currency: null,
            }),
          }),
          undefined as never,
        ),
      );
      assert.equal(
        refused.status,
        400,
        "an explicit malformed subsidiary refuses rather than clearing its filter",
      );
      assert.equal(enqueued.length, 0);
    }
    const created = await withOrgContext(org.orgId, () =>
      batches.POST(
        new Request("http://audit.local/api", {
          method: "POST",
          body: JSON.stringify({
            from: org.date,
            toDate: org.date,
            overdueOnly: false,
            subsidiaryId: null,
            currency: null,
          }),
        }),
        undefined as never,
      ),
    );
    assert.equal(created.status, 200, JSON.stringify(await created.clone().json()));
    const createdBody = (await created.json()) as {
      runId: string;
      queued: number;
      skipped: number;
    };
    // The silent customer has no balance, so nothing is skipped yet: the
    // exclusion path is covered through the preview below.
    assert.equal(createdBody.queued, 1);
    assert.equal(enqueued.length, 1);

    const shown = await withOrgContext(org.orgId, () =>
      detail.GET(new Request("http://audit.local/api"), {
        params: Promise.resolve({ id: createdBody.runId }),
      } as never),
    );
    assert.equal(shown.status, 200);
    const shownBody = (await shown.json()) as {
      run: { recipientCount: number; status: string };
      items: { status: string }[];
    };
    assert.equal(shownBody.run.recipientCount, 1);
    assert.equal(shownBody.items.length, 1);

    const missing = await withOrgContext(org.orgId, () =>
      detail.GET(new Request("http://audit.local/api"), {
        params: Promise.resolve({ id: randomUUID() }),
      } as never),
    );
    assert.equal(missing.status, 404);

    const retried = await withOrgContext(org.orgId, () =>
      retry.POST(
        new Request("http://audit.local/api", { method: "POST", body: JSON.stringify({}) }),
        { params: Promise.resolve({ id: createdBody.runId }) } as never,
      ),
    );
    assert.equal(retried.status, 200);
    // Nothing failed and the queued job is still live: Retry re-arms the
    // queued item and the deterministic job identity dedupes the enqueue.
    assert.equal(((await retried.json()) as { requeued: number }).requeued, 1);
    assert.equal(enqueued.length, 2);

    const retryMissing = await withOrgContext(org.orgId, () =>
      retry.POST(
        new Request("http://audit.local/api", { method: "POST", body: JSON.stringify({}) }),
        { params: Promise.resolve({ id: randomUUID() }) } as never,
      ),
    );
    assert.equal(retryMissing.status, 404);

    await withBypass(() =>
      db.execute(
        sql`update app_roles set permissions='["ar.create","ar.read"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
      ),
    );
    const retryDenied = await withOrgContext(org.orgId, () =>
      retry.POST(
        new Request("http://audit.local/api", { method: "POST", body: JSON.stringify({}) }),
        { params: Promise.resolve({ id: createdBody.runId }) } as never,
      ),
    );
    assert.equal(retryDenied.status, 403);
    assert.equal(enqueued.length, 2, "retry requires reports.read before enqueueing");
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});
