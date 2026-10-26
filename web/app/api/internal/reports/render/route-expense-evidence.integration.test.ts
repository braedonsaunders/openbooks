import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";

// A scheduled render reads with the schedule owner's expense authority as it
// stands at render time, and each render appends evidence of the authority
// it used. Narrowed access narrows the output, widened access widens it, and
// losing expense read entirely refuses with a remedy.
const repo = process.cwd();
const root = pathToFileURL(repo + "/").href;
registerHooks({
  resolve(s, c, next) {
    if (s === "next-intl/server")
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function getTranslations(){const t=(s)=>s;t.has=()=>false;return t;}" +
              'export async function getLocale(){return "en";}',
          ),
      };
    return next(s, c);
  },
});

const { db, withBypassContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import(root + "node_modules/drizzle-orm/index.js");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { GET } = await import(root + "web/app/api/internal/reports/render/route.ts");
const { reportArtifactAccessDetail, EXPENSE_READ_REVOKED_REMEDY } = await import(
  root + "web/lib/report-execution-context.ts"
);

const TOKEN = "render-evidence-test-token";

type Reach = { scope: "all" } | { scope: "own"; userId: string } | { scope: "none" };
type Snapshot = {
  expenseRows?: Reach;
  requiredPermissions?: string[];
  renders?: { renderedAt: string; expenseRows: Reach | null; contentHash: string }[];
};

/** Every text a rendered workbook carries. */
function workbookText(bytes: Uint8Array): string {
  return Object.values(unzipSync(bytes))
    .map((entry) => strFromU8(entry))
    .join("\n");
}

test("each scheduled render reads with the owner's current expense authority and records it", async () => {
  process.env.OPENBOOKS_INTERNAL_TOKEN = TOKEN;
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const owner = await withBypassContext(() =>
      createScratchUser(org.orgId, "Schedule owner", "schedule_owner"),
    );
    const employee = randomUUID();
    const coworker = randomUUID();
    const definitionId = randomUUID();
    const query = { entity: "documents", mode: "rows", columns: ["document_number", "kind"] };
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employee}, ${org.orgId}, 'employee', 'Riley Fieldworker', true, '{}'::jsonb),
               (${coworker}, ${org.orgId}, 'employee', 'Sam Coworker', true, '{}'::jsonb)`);
      await db.execute(
        sql`update users set party_id = ${employee} where id = ${owner} and org_id = ${org.orgId}`,
      );
      await db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom)
        values (${randomUUID()}, ${org.orgId}, 'expense_report', 'draft', 'EXP-OWNER-1', ${org.date}, ${employee}, ${org.subsidiaryId}, 'CAD', 0, 0, 0, '{}'::jsonb),
               (${randomUUID()}, ${org.orgId}, 'expense_report', 'draft', 'EXP-COWORKER-1', ${org.date}, ${coworker}, ${org.subsidiaryId}, 'CAD', 0, 0, 0, '{}'::jsonb),
               (${randomUUID()}, ${org.orgId}, 'vendor_bill', 'draft', 'BILL-VENDOR-1', ${org.date}, ${org.vendorId}, ${org.subsidiaryId}, 'CAD', 0, 0, 0, '{}'::jsonb)`);
      await db.execute(sql`
        insert into report_definitions (id, org_id, kind, report_type, slug, name, query, created_by, updated_by)
        values (${definitionId}, ${org.orgId}, 'custom', 'query', 'expense-register', 'Expense register',
                ${JSON.stringify(query)}::jsonb, ${owner}, ${owner})`);
    });
    const grant = (permissions: string[]) =>
      withBypassContext(() =>
        db.execute(sql`
      update app_roles set permissions = ${JSON.stringify(["reports.read", "reports.schedule", ...permissions])}::jsonb,
                           subsidiary_restriction = '{"mode":"all"}'::jsonb
       where org_id = ${org.orgId} and key = 'schedule_owner'`),
      );
    // A scheduled run carries the schedule's authorization as minted.
    const mintRun = async (authorized: Reach) => {
      const runId = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
        insert into report_runs (id, org_id, definition_id, trigger, status, recipient_emails, filters, authorization_snapshot, created_by)
        values (${runId}, ${org.orgId}, ${definitionId}, 'scheduled', 'running', '[]'::jsonb, null,
                ${JSON.stringify({
                  version: 1,
                  userId: owner,
                  allowedSubsidiaryIds: null,
                  expenseRows: authorized,
                  definition: {
                    report_type: "query",
                    query,
                    statement: null,
                    name: "Expense register",
                    slug: "expense-register",
                    kind: "custom",
                  },
                })}::jsonb, ${owner})`),
      );
      return runId;
    };
    const render = async (runId: string) => {
      const params = new URLSearchParams({
        orgId: org.orgId,
        definitionId,
        runId,
        format: "xlsx",
        period: "custom",
        from: org.date,
        to: org.date,
      });
      return GET(
        new Request(`http://test.local/api/internal/reports/render?${params}`, {
          headers: { "x-internal-token": TOKEN },
        }),
      );
    };
    const snapshotOf = async (runId: string) =>
      (
        await withBypassContext(() =>
          db.execute<{ authorization_snapshot: Snapshot }>(sql`
      select authorization_snapshot from report_runs where id = ${runId} and org_id = ${org.orgId}`),
        )
      ).rows[0]!.authorization_snapshot;
    const reader = (permissions: string[], id = owner) =>
      ({
        user: { id, orgId: org.orgId, roles: [], isSuperAdmin: false },
        permissions: new Set(["reports.read", ...permissions]),
        allowedSubsidiaryIds: null,
      }) as unknown as Parameters<typeof reportArtifactAccessDetail>[0];

    // Narrowing: authorized for every report, the owner now holds self-service only.
    await grant(["expenses.self"]);
    const narrowRun = await mintRun({ scope: "all" });
    const narrowed = await render(narrowRun);
    assert.equal(narrowed.status, 200, await narrowed.clone().text());
    const narrowText = workbookText(new Uint8Array(await narrowed.arrayBuffer()));
    assert.ok(narrowText.includes("EXP-OWNER-1") && narrowText.includes("BILL-VENDOR-1"));
    assert.equal(
      narrowText.includes("EXP-COWORKER-1"),
      false,
      "narrowed access narrows the output",
    );
    const narrowEvidence = await snapshotOf(narrowRun);
    assert.deepEqual(
      narrowEvidence.renders?.map((entry) => entry.expenseRows),
      [{ scope: "own", userId: owner }],
    );
    assert.deepEqual(
      narrowEvidence.expenseRows,
      { scope: "all" },
      "the minted authorization is never rewritten",
    );

    // Widening: authorized for the owner's own reports, the owner now reads every report.
    await grant(["expenses.read"]);
    const wideRun = await mintRun({ scope: "own", userId: owner });
    const widened = await render(wideRun);
    assert.equal(widened.status, 200, await widened.clone().text());
    const wideText = workbookText(new Uint8Array(await widened.arrayBuffer()));
    assert.ok(
      wideText.includes("EXP-OWNER-1") && wideText.includes("EXP-COWORKER-1"),
      "widened access widens the output",
    );
    const wideEvidence = await snapshotOf(wideRun);
    assert.deepEqual(
      wideEvidence.renders?.map((entry) => entry.expenseRows),
      [{ scope: "all" }],
    );
    const wideHash = wideEvidence.renders![0]!.contentHash;
    assert.match(wideHash, /^[0-9a-f]{64}$/);
    // Downloads answer from the render that produced the bytes.
    assert.deepEqual(
      await reportArtifactAccessDetail(reader(["expenses.self"]), wideEvidence, {
        contentHash: wideHash,
      }),
      { ok: false, missingPermissions: ["expenses.read"] },
    );
    assert.equal(
      (
        await reportArtifactAccessDetail(reader(["expenses.read"]), wideEvidence, {
          contentHash: wideHash,
        })
      ).ok,
      true,
    );

    // A retried render appends its own evidence; the earlier entry is kept as recorded.
    await grant(["expenses.self"]);
    const retried = await render(wideRun);
    assert.equal(retried.status, 200, await retried.clone().text());
    const retriedEvidence = await snapshotOf(wideRun);
    assert.equal(retriedEvidence.renders?.length, 2);
    assert.deepEqual(retriedEvidence.renders![0], wideEvidence.renders![0]);
    assert.deepEqual(retriedEvidence.renders![1]!.expenseRows, { scope: "own", userId: owner });
    const narrowHash = retriedEvidence.renders![1]!.contentHash;
    assert.equal(
      (
        await reportArtifactAccessDetail(reader(["expenses.self"]), retriedEvidence, {
          contentHash: narrowHash,
        })
      ).ok,
      true,
    );
    assert.equal(
      (await reportArtifactAccessDetail(reader(["expenses.self"]), retriedEvidence)).ok,
      false,
      "unidentified bytes need every render's reach",
    );

    // Render evidence is append-only at the database.
    for (const [label, change] of [
      [
        "rewrite an earlier render",
        sql`jsonb_set(authorization_snapshot, '{renders,0,expenseRows}', '{"scope":"none"}'::jsonb)`,
      ],
      ["drop the render list", sql`authorization_snapshot - 'renders'`],
      [
        "append two renders at once",
        sql`jsonb_set(authorization_snapshot, '{renders}', (authorization_snapshot->'renders') || '[{"renderedAt":"x","expenseRows":null},{"renderedAt":"y","expenseRows":null}]'::jsonb)`,
      ],
      [
        "append a malformed render",
        sql`jsonb_set(authorization_snapshot, '{renders}', (authorization_snapshot->'renders') || '[{"renderedAt":"x","expenseRows":{"scope":"everyone"}}]'::jsonb)`,
      ],
      [
        "rewrite the minted authorization",
        sql`jsonb_set(authorization_snapshot, '{expenseRows}', '{"scope":"all"}'::jsonb)`,
      ],
    ] as const) {
      await assert.rejects(
        withBypassContext(() =>
          db.execute(
            sql`update report_runs set authorization_snapshot = ${change} where id = ${wideRun} and org_id = ${org.orgId}`,
          ),
        ),
        (error: unknown) =>
          /immutable|append-only|malformed/.test(
            String(
              (error as { cause?: { message?: string } }).cause?.message ??
                (error as Error).message,
            ),
          ),
        label,
      );
    }

    // Revocation: the owner holds no expense read at all on a schedule set up to deliver expense reports.
    await grant([]);
    const revokedRun = await mintRun({ scope: "all" });
    const revoked = await render(revokedRun);
    assert.equal(revoked.status, 422);
    assert.deepEqual(await revoked.json(), { error: EXPENSE_READ_REVOKED_REMEDY });
    assert.equal(
      (await snapshotOf(revokedRun)).renders,
      undefined,
      "a refused render records nothing",
    );
    // A schedule that never delivered expense reports keeps rendering without them.
    const plainRun = await mintRun({ scope: "none" });
    const plain = await render(plainRun);
    assert.equal(plain.status, 200, await plain.clone().text());
    assert.equal(
      workbookText(new Uint8Array(await plain.arrayBuffer())).includes("EXP-OWNER-1"),
      false,
    );
    assert.deepEqual(
      (await snapshotOf(plainRun)).renders?.map((entry) => entry.expenseRows),
      [{ scope: "none" }],
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
