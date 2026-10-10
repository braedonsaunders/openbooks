import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The guided cutover drives the opening trial balance without the
// assistant: preview shows exactly what would post (row-level refusals
// travel in the body), and draft creates the native draft journal through
// the same writer. These tests drive the REAL handlers (only the session
// gate is stubbed) against a scratch organization.

const stateKey = Symbol.for("openbooks.migration-opening-routes-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const module_ = (source: string): { shortCircuit: true; format: "module"; url: string } => ({
  shortCircuit: true,
  format: "module",
  url: `data:text/javascript,${encodeURIComponent(source)}`,
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/authz") {
      const real = nextResolve(specifier, context).url;
      const nextServer = nextResolve("next/server", context).url;
      return module_(`
        export * from ${JSON.stringify(real)};
        const state = globalThis[Symbol.for('openbooks.migration-opening-routes-test')];
        const { NextResponse } = await import(${JSON.stringify(nextServer)});
        export async function guardPermission(_permission) {
          if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
          return { permissions: new Set(), allowedSubsidiaryIds: null, ...state.authz };
        }
      `);
    }
    return nextResolve(specifier, context);
  },
});

const { POST: previewPOST } = (await import("./preview/route.ts?migration-opening-preview")) as typeof import("./preview/route.ts");
const { POST: draftPOST } = (await import("./draft/route.ts?migration-opening-draft")) as typeof import("./draft/route.ts");

const { withBypassContext, withOrgTransaction, db, env } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { resolveAuthzByUserId } = await import("@/lib/authz");
const { createTransfer, loadTransfer } = await import("@/lib/data-io/transfer-store");
const { commandTransfer, uploadTransferPart } = await import("@/lib/data-io/transfer-commands");
const { processTransfer } = await import("@/lib/data-io/transfer-worker");
const { updateMigrationPlan } = await import("@/lib/migration/plan");

const skip = !env.OPENBOOKS_DB_URL;

function postRequest(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("opening-balance preview and draft run the native writer through the guided-cutover routes", { skip, timeout: 180_000 }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId));
    await withOrgTransaction(org.orgId, () => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`));
    const authz = await withOrgTransaction(org.orgId, () => resolveAuthzByUserId(org.orgId, adminId));
    assert.ok(authz);
    routeState.authz = authz;
    const inOrg = <T>(fn: () => Promise<T>) => withOrgTransaction(org.orgId, fn);
    await inOrg(() => updateMigrationPlan({ orgId: org.orgId, id: adminId }, { path: "spreadsheet", sourceSystem: "spreadsheet", cutoverDate: "2026-10-01" }, "test plan"));

    const numbers = await inOrg(async () => Object.fromEntries((await db.execute<{ id: string; number: string }>(sql`
      select id, number from accounts where org_id=${org.orgId} and id in (${org.accounts.bank}, ${org.accounts.revenue}, ${org.accounts.clearing})`)).rows.map((row) => [row.id, row.number])));
    const bank = numbers[org.accounts.bank]!;
    const revenue = numbers[org.accounts.revenue]!;
    assert.ok(bank && revenue, "fixture accounts carry numbers");

    const stage = async (filename: string, text: string) => {
      const bytes = Buffer.from(text);
      let job = await inOrg(() => createTransfer(authz, { requestKey: randomUUID(), kind: "import", resource: "items", format: "csv", filename, bytes: bytes.length }));
      job = await inOrg(() => uploadTransferPart(authz, job.id, 0, bytes));
      job = await inOrg(() => commandTransfer(authz, job.id, { action: "finish-upload", revision: job.revision }));
      const token = randomUUID();
      await withOrgTransaction(org.orgId, () => db.execute(sql`update data_transfer_jobs set claim_token=${token},claim_until=now()+interval '10 minutes' where org_id=${org.orgId} and id=${job.id}`));
      await processTransfer(org.orgId, job.id, token);
      job = await inOrg(() => loadTransfer(org.orgId, job.id));
      assert.equal(job.state, "mapping", job.error ?? "");
      return job;
    };

    const columns = { account: "Account", debit: "Debit", credit: "Credit" };
    const off = await stage("tb-off.csv", `Account,Debit,Credit\n${bank},1000.00,\n${revenue},,999.99\n`);
    const refused = await previewPOST(postRequest("/api/migration/opening-balances/preview", {
      transferId: off.id, columns, documentDate: "2026-09-30",
    }));
    assert.equal(refused.status, 422);
    const refusedBody = await refused.json() as { error: string; issues: { rowNo: number; message: string }[] };
    assert.match(refusedBody.error, /does not balance/);
    assert.match(refusedBody.error, /difference 0\.0100/);
    assert.ok(Array.isArray(refusedBody.issues), "the refusal carries its row-level issues");

    const bad = await stage("tb-bad.csv", `Account,Debit,Credit\nNo Such Account,100.00,\n${revenue},,100.00\n`);
    const badPreview = await previewPOST(postRequest("/api/migration/opening-balances/preview", {
      transferId: bad.id, columns, documentDate: "2026-09-30",
    }));
    assert.equal(badPreview.status, 422);
    const badBody = await badPreview.json() as { error: string; issues: { rowNo: number; message: string }[] };
    assert.ok(badBody.issues.length > 0, "row-level refusals travel in the body");
    assert.equal(typeof badBody.issues[0]!.rowNo, "number");
    assert.match(badBody.issues[0]!.message, /No Such Account/);

    const job = await stage("tb.csv", `Account,Debit,Credit\n${bank},1000.00,\n${revenue},,1000.00\n`);
    const previewed = await previewPOST(postRequest("/api/migration/opening-balances/preview", {
      transferId: job.id, columns, documentDate: "2026-09-30",
    }));
    assert.equal(previewed.status, 200);
    const previewBody = await previewed.json() as { preview: { lines: unknown[]; net: string; totalDebits: string } };
    assert.equal(previewBody.preview.net, "0.0000");
    assert.equal(previewBody.preview.lines.length, 2);

    const key = `cutover-${randomUUID()}`;
    const drafted = await draftPOST(postRequest("/api/migration/opening-balances/draft", {
      transferId: job.id, columns, documentDate: "2026-09-30", idempotencyKey: key,
    }));
    assert.equal(drafted.status, 200);
    const draftBody = await drafted.json() as { draft: { journalId: string; status: string; href: string } };
    assert.equal(draftBody.draft.status, "draft");
    assert.match(draftBody.draft.href, /\/journal\?journalTab=drafts&entry=/);

    const replay = await draftPOST(postRequest("/api/migration/opening-balances/draft", {
      transferId: job.id, columns, documentDate: "2026-09-30", idempotencyKey: key,
    }));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as typeof draftBody).draft.journalId, draftBody.draft.journalId);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});
