import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { env } from "@openbooks/engine/src/db.ts";

/**
 * Live two-subsidiary regression for subsidiary-scoped payroll access
 * (fnd_mt9ck222_msy30x): every payroll run surface — the collection, run
 * detail, every run mutation, the stub and cheque PDFs, and bank-file
 * generate/release — used to scope by org alone, so a caller restricted to
 * subsidiary A could read subsidiary B's wage PII and operate B's payroll by
 * UUID.
 *
 * The route gates read `gate.allowedSubsidiaryIds`; this file supplies that
 * set directly through the same authz seam the routes consume (the mock on
 * lib/feature-gates) and proves, against real routes and a real database:
 *
 *   - an A-only actor's collection excludes B's run;
 *   - an A-only actor's run detail, mutations, stub PDF, cheque PDF, bank-file
 *     panel, generate and release on B's run all answer the SAME 404 body a
 *     nonexistent run answers (indistinguishable — zero read disclosure);
 *   - creating a run on B's schedule fails exactly like a missing schedule;
 *   - the denial battery writes NOTHING anywhere in the org (atomic zero-write
 *     denial: table counts identical before and after);
 *   - the same A-only actor still reads and mutates A's own run, and an
 *     unrestricted actor still sees and operates both.
 */

const stateKey = Symbol.for("openbooks.payroll-subsidiary-scope-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.payroll-subsidiary-scope-test')]
  export async function guardFeaturePermission() {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

// This file lives at web/app/api/payroll/runs/ — four levels up is web/.
const webRoot = new URL("../../../../", import.meta.url);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as platform.test.ts).
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // Forward Next.js-style aliases to the real modules they point at.
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`.${specifier.slice(1)}.ts`, webRoot).href, context);
    }
    if (specifier.endsWith("/lib/feature-gates")) {
      return { url: "mock:feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

// Fresh module instances via a query string, with the mock seam active only
// for these imports.
const collectionUrl = "./route.ts?payroll-scope";
const runUrl = "./[id]/route.ts?payroll-scope";
const stubsPdfUrl = "./[id]/stubs-pdf/route.ts?payroll-scope";
const chequesPdfUrl = "./[id]/cheques-pdf/route.ts?payroll-scope";
const bankFileUrl = "./[id]/bank-file/route.ts?payroll-scope";
const bankFileReleaseUrl = "./[id]/bank-file/[fileId]/route.ts?payroll-scope";
const { GET: getRuns, POST: postRuns } = (await import(collectionUrl)) as typeof import("./route.ts");
const { GET: getRun, POST: postRun } = (await import(runUrl)) as typeof import("./[id]/route.ts");
const { GET: getStubsPdf } = (await import(stubsPdfUrl)) as typeof import("./[id]/stubs-pdf/route.ts");
const { POST: postChequesPdf } = (await import(chequesPdfUrl)) as typeof import("./[id]/cheques-pdf/route.ts");
const { GET: getBankFilePanel, POST: postBankFileGenerate } = (await import(bankFileUrl)) as typeof import("./[id]/bank-file/route.ts");
const { POST: postBankFileRelease } = (await import(bankFileReleaseUrl)) as typeof import("./[id]/bank-file/[fileId]/route.ts");
hooks.deregister();

const { db, withBypass } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);

const NOT_FOUND = JSON.stringify({ error: "not found" });

function get(): Promise<Response> {
  return getRuns();
}
function runGet(id: string, url = `/api/payroll/runs/${id}`): Promise<Response> {
  return getRun(new Request(`http://openbooks.test${url}`), { params: Promise.resolve({ id }) });
}
function runPost(id: string, body: Record<string, unknown>): Promise<Response> {
  return postRun(
    new Request(`http://openbooks.test/api/payroll/runs/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}
function createRun(body: Record<string, unknown>): Promise<Response> {
  return postRuns(
    new Request("http://openbooks.test/api/payroll/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
function stubsPdf(id: string): Promise<Response> {
  return getStubsPdf(new Request(`http://openbooks.test/api/payroll/runs/${id}/stubs-pdf`), {
    params: Promise.resolve({ id }),
  });
}
function chequesPdf(id: string): Promise<Response> {
  return postChequesPdf(new Request(`http://openbooks.test/api/payroll/runs/${id}/cheques-pdf`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}
function bankPanel(id: string): Promise<Response> {
  return getBankFilePanel(new Request(`http://openbooks.test/api/payroll/runs/${id}/bank-file`), {
    params: Promise.resolve({ id }),
  });
}
function bankGenerate(id: string, profileId: string): Promise<Response> {
  return postBankFileGenerate(
    new Request(`http://openbooks.test/api/payroll/runs/${id}/bank-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentBankProfileId: profileId }),
    }),
    { params: Promise.resolve({ id }) },
  );
}
function bankRelease(id: string, fileId: string): Promise<Response> {
  return postBankFileRelease(
    new Request(`http://openbooks.test/api/payroll/runs/${id}/bank-file/${fileId}`, { method: "POST" }),
    { params: Promise.resolve({ id, fileId }) },
  );
}

/** Every org-scoped table a payroll write could touch. */
const WRITE_SURFACES = [
  "documents", "pay_runs", "pay_run_adjustments", "pay_stubs", "pay_stub_lines",
  "pay_components", "pay_run_bank_files", "number_sequences",
  "folders", "files", "file_versions", "file_blobs", "audit_log",
] as const;

async function writeSnapshot(orgId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of WRITE_SURFACES) {
    // file_versions and file_blobs carry no org_id — they hang off the org's
    // files, so they are counted through it.
    const where = table === "file_versions"
      ? sql`where file_id in (select id from files where org_id = ${orgId})`
      : table === "file_blobs"
        ? sql`where version_id in (
                select v.id from file_versions v
                join files f on f.id = v.file_id where f.org_id = ${orgId})`
        : sql`where org_id = ${orgId}`;
    const r = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${sql.identifier(table)} ${where}`,
    );
    out[table] = Number(r.rows[0]!.n);
  }
  return out;
}

test(
  "payroll surfaces enforce the caller's subsidiary scope with indistinguishable 404s and zero writes",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const orgId = org.orgId;
    const rootId = org.subsidiaryId;
    try {
      const actors = await seedFlowActors(orgId);
      const adminId = actors.adminId; // unrestricted caller
      const actorAId = actors.submitterId; // subsidiary-A-restricted caller

      // Payroll on, and a second legal entity (US/USD beside the root CA/CAD).
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ payroll: true })}::jsonb)
         where id = ${orgId}`);
      const subBId = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, name, base_currency, country, parent_id, is_elimination, is_active, custom)
        values (${subBId}, ${orgId}, 'Entity B', 'USD', 'US', ${rootId}, false, true, '{}'::jsonb)`);

      // One schedule per entity: A on the root, B on Entity B.
      const scheduleA = randomUUID();
      const scheduleB = randomUUID();
      for (const [id, name, subId] of [[scheduleA, "A Biweekly", rootId], [scheduleB, "B Biweekly", subBId]] as const) {
        await db.execute(sql`
          insert into pay_schedules (org_id, id, name, frequency, periods_per_year,
                                     anchor_period_end, pay_date_offset_days, subsidiary_id)
          values (${orgId}, ${id}, ${name}, 'biweekly', 26, '2026-08-14', 4, ${subId})`);
      }

      // One employee per entity, with A's employee payable through the route's
      // own mutation path (profile on schedule A + an adjustable component).
      const empA = randomUUID();
      const empB = randomUUID();
      await db.execute(sql`
        insert into parties (org_id, id, kind, display_name, subsidiary_id)
        values (${orgId}, ${empA}, 'person', 'Employee A', ${rootId}),
               (${orgId}, ${empB}, 'person', 'Employee B', ${subBId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province)
        values (${orgId}, ${empA}, ${scheduleA}, 'ON')`);
      const componentId = randomUUID();
      await db.execute(sql`
        insert into pay_components (org_id, id, code, name, kind, basis, sequence)
        values (${orgId}, ${componentId}, 'COMMISSION', 'Commission', 'earning', 'fixed_amount', 90)`);

      // Runs created through the engine: run A inside A's scope, run B outside it.
      const { createPayRun } = await import("@openbooks/engine/src/payroll-run.ts");
      const runA = await createPayRun({ orgId, actorId: adminId, payScheduleId: scheduleA });
      const runB = await createPayRun({ orgId, actorId: adminId, payScheduleId: scheduleB });

      // Wage PII on each run, so a pre-fix 200 would disclose real stub rows.
      for (const [run, emp, province] of [[runA, empA, "ON"], [runB, empB, "ON"]] as const) {
        await db.execute(sql`
          insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, province,
                                 periods_per_year, pay_date, tax_year, currency_code, gross, net_pay)
          select ${orgId}, ${run.documentId}, ${emp}, ${province}, 26, r.pay_date, r.tax_year, d.currency,
                 '2500.00', '1900.00'
            from pay_runs r join documents d on d.id = r.document_id and d.org_id = r.org_id
           where r.org_id = ${orgId} and r.document_id = ${run.documentId}`);
      }

      // An EFT profile for the org, and a bank-file artifact owned by run B,
      // so the release route's ownership query passes and only the subsidiary
      // gate can deny it. The artifact's bytes live in the File Cabinet, so
      // the real storage rows are seeded too.
      const profileId = randomUUID();
      const formatId = randomUUID();
      await db.execute(sql`
        insert into payment_formats (org_id, id, code, name, rail, currency)
        values (${orgId}, ${formatId}, 'CPA005', 'CPA-005', 'eft', 'CAD')`);
      await db.execute(sql`
        insert into payment_bank_profiles (org_id, id, name, bank_account_id, payment_format_id, currency)
        values (${orgId}, ${profileId}, 'Root EFT', ${org.accounts.bank}, ${formatId}, 'CAD')`);
      const folderId = randomUUID();
      const fileIdB = randomUUID();
      const versionIdB = randomUUID();
      const artifactB = randomUUID();
      await db.execute(sql`
        insert into folders (org_id, id, name, is_system, system_kind, is_private, owner_id)
        values (${orgId}, ${folderId}, 'Payroll bank files', true, 'payroll_bank_files', true, null)`);
      await db.execute(sql`
        insert into files (org_id, id, folder_id, name, extension, file_type, content_type,
                           size_bytes, storage_kind, content_hash)
        values (${orgId}, ${fileIdB}, ${folderId}, 'B-0001.txt', 'txt', 'text', 'text/plain',
                9, 'db', 'deadbeef')`);
      await db.execute(sql`
        insert into file_versions (id, file_id, version_number, size_bytes, content_type,
                                   storage_kind, content_hash)
        values (${versionIdB}, ${fileIdB}, 1, 9, 'text/plain', 'db', 'deadbeef')`);
      await db.execute(sql`
        update files set current_version_id = ${versionIdB} where id = ${fileIdB} and org_id = ${orgId}`);
      await db.execute(sql`
        insert into file_blobs (version_id, bytes) values (${versionIdB}, '0102030405'::bytea)`);
      await db.execute(sql`
        insert into pay_run_bank_files (org_id, pay_run_document_id, payment_bank_profile_id, format,
                                        sequence_number, file_number, sequence_value, filename, content_type,
                                        content_hash, size_bytes, file_id, file_version_id, entry_count,
                                        control_total, currency)
        values (${orgId}, ${runB.documentId}, ${profileId}, 'cpa005', 1, 'PBF-0001', 1,
                'B-0001.txt', 'text/plain', 'deadbeef', 9, ${fileIdB}, ${versionIdB},
                1, 100.00, 'CAD')`);

      const asA = (allowed: Set<string> | null, actorId: string) => {
        routeState.authz = {
          user: { orgId, id: actorId },
          permissions: new Set(["*"]),
          allowedSubsidiaryIds: allowed,
        };
      };
      const aOnly = () => asA(new Set([rootId]), actorAId);
      const unrestricted = () => asA(null, adminId);

      // Authorized same-subsidiary paths still work for an A-only actor.
      {
        aOnly();

        // Mint a second run through the POST route on A's own schedule.
        const minted = await createRun({ payScheduleId: scheduleA });
        const mintedBody = (await minted.json()) as { ok: boolean; documentId: string };
        assert.equal(minted.status, 200, JSON.stringify(mintedBody));

        // Collection shows A-entity runs only (the B run never appears).
        const list = await get();
        assert.equal(list.status, 200);
        const listed = (await list.json()) as { runs: { document_id: string }[] };
        const listedIds = listed.runs.map((r) => r.document_id);
        assert.ok(listedIds.includes(runA.documentId), "A's run is listed");
        assert.ok(listedIds.includes(mintedBody.documentId), "the minted A run is listed");
        assert.ok(!listedIds.includes(runB.documentId), "B's run is excluded from the collection");

        // Detail returns the run with its stub (wage data inside A's scope).
        const detail = await runGet(runA.documentId);
        const detailBody = (await detail.json()) as {
          run: { subsidiaryId: string | null };
          stubs: unknown[];
        };
        assert.equal(detail.status, 200, JSON.stringify(detailBody));
        assert.equal(detailBody.run.subsidiaryId, rootId);
        assert.equal(detailBody.stubs.length, 1);

        // Mutation on A's own run writes an audited adjustment.
        const adjusted = await runPost(runA.documentId, {
          action: "add-adjustment",
          employeePartyId: empA,
          componentId,
          amount: "100.00",
        });
        assert.equal(adjusted.status, 200, await adjusted.text());
        const adjCount = (await db.execute<{ n: string }>(sql`
          select count(*)::text as n from pay_run_adjustments
           where org_id = ${orgId} and pay_run_document_id = ${runA.documentId}
             and adjustment_type = 'line'`)).rows[0]!.n;
        assert.equal(adjCount, "1");

        // The PDF and bank-file surfaces reach their REAL logic (their own
        // business 404s / refusal codes) instead of the scope 404: the gate
        // passed an authorized caller through.
        const stubs = await stubsPdf(runA.documentId);
        assert.equal(stubs.status, 404);
        assert.equal(await stubs.text(), JSON.stringify({ error: "no stubs to print" }));
        const cheques = await chequesPdf(runA.documentId);
        assert.equal(cheques.status, 409, "cheque printing refused on lifecycle, not scope");
        assert.equal(
          await cheques.text(),
          JSON.stringify({ error: "commit the pay run before printing its cheques" }),
        );
        const panel = await bankPanel(runA.documentId);
        const panelBody = (await panel.json()) as { entitlement: { refusal: { code: string } } };
        assert.equal(panel.status, 200, JSON.stringify(panelBody));
        assert.equal(panelBody.entitlement.refusal?.code, "notCommitted");
        const generate = await bankGenerate(runA.documentId, profileId);
        assert.equal(generate.status, 409, "generation refused on entitlement, not scope");
      }

      // An A-only actor is denied B's run everywhere, with 404s
      // indistinguishable from a missing run.
      {
        aOnly();
        const missingRun = randomUUID();

        // Detail: same body as a run that does not exist at all.
        const detail = await runGet(runB.documentId);
        const detailBody = await detail.text();
        assert.equal(detail.status, 404, detailBody);
        assert.equal(detailBody, NOT_FOUND);
        const missing = await runGet(missingRun);
        assert.equal(await missing.text(), NOT_FOUND);

        // Mutations: commit and an adjustment write, both denied before any
        // engine call runs.
        for (const action of [
          { action: "commit" },
          { action: "add-adjustment", employeePartyId: empB, componentId, amount: "100.00" },
        ]) {
          const res = await runPost(runB.documentId, action);
          const resBody = await res.text();
          assert.equal(res.status, 404, `${action.action}: ${resBody}`);
          assert.equal(resBody, NOT_FOUND, `${action.action} body is indistinguishable`);
        }
        const missingCommit = await runPost(missingRun, { action: "commit" });
        assert.equal(missingCommit.status, 404);

        // Stub and cheque PDFs: byte surfaces denied with the same 404.
        const stubs = await stubsPdf(runB.documentId);
        assert.equal(stubs.status, 404);
        assert.equal(await stubs.text(), NOT_FOUND);
        const cheques = await chequesPdf(runB.documentId);
        assert.equal(cheques.status, 404);
        assert.equal(await cheques.text(), NOT_FOUND);

        // Bank-file panel: would have returned the operator metadata (200)
        // before the fix — now indistinguishable from a missing run.
        const panel = await bankPanel(runB.documentId);
        const panelBody = await panel.text();
        assert.equal(panel.status, 404, panelBody);
        assert.equal(panelBody, NOT_FOUND);

        // Bank-file generate and release: denied before any artifact, audit
        // row or release counter moves.
        const generate = await bankGenerate(runB.documentId, profileId);
        const generateBody = await generate.text();
        assert.equal(generate.status, 404, generateBody);
        assert.equal(generateBody, NOT_FOUND);
        const release = await bankRelease(runB.documentId, artifactB);
        const releaseBody = await release.text();
        assert.equal(release.status, 404, releaseBody);
        assert.equal(releaseBody, NOT_FOUND);
        const missingRelease = await bankRelease(missingRun, randomUUID());
        assert.equal(missingRelease.status, 404);
        assert.equal(await missingRelease.text(), NOT_FOUND);
      }

      // Creating a run on B's schedule fails exactly like a missing schedule.
      {
        aOnly();
        const outOfScope = await createRun({ payScheduleId: scheduleB });
        const outOfScopeBody = await outOfScope.text();
        assert.equal(outOfScope.status, 404, outOfScopeBody);
        const missing = await createRun({ payScheduleId: randomUUID() });
        const missingBody = await missing.text();
        assert.equal(missing.status, 404, missingBody);
        // Indistinguishable: identical body to a schedule that does not exist.
        assert.equal(outOfScopeBody, missingBody);
      }

      // The whole denial battery is atomic: zero writes anywhere in the org.
      {
        aOnly();
        const before = await writeSnapshot(orgId);
        // Re-run every denied surface.
        await runGet(runB.documentId);
        await runPost(runB.documentId, { action: "commit" });
        await runPost(runB.documentId, { action: "add-adjustment", employeePartyId: empB, componentId, amount: "100.00" });
        await stubsPdf(runB.documentId);
        await chequesPdf(runB.documentId);
        await bankPanel(runB.documentId);
        await bankGenerate(runB.documentId, profileId);
        await bankRelease(runB.documentId, artifactB);
        await createRun({ payScheduleId: scheduleB });
        const after = await writeSnapshot(orgId);
        assert.deepEqual(after, before);

        // And B's stub — the wage PII the actor tried to reach — still
        // belongs to exactly the run it always did, untouched.
        const stubCount = (await db.execute<{ n: string }>(sql`
          select count(*)::text as n from pay_stubs
           where org_id = ${orgId} and pay_run_document_id = ${runB.documentId}`)).rows[0]!.n;
        assert.equal(stubCount, "1");
      }

      // Unrestricted actors still see and operate both runs.
      {
        unrestricted();
        const list = await get();
        const listed = (await list.json()) as { runs: { document_id: string }[] };
        const listedIds = listed.runs.map((r) => r.document_id);
        assert.ok(listedIds.includes(runA.documentId));
        assert.ok(listedIds.includes(runB.documentId));
        const detail = await runGet(runB.documentId);
        const detailBody = (await detail.json()) as { stubs: unknown[] };
        assert.equal(detail.status, 200, JSON.stringify(detailBody));
        assert.equal(detailBody.stubs.length, 1);
      }
    } finally {
      await withBypass(() => dropScratchOrg(orgId)).catch(() => {});
    }
  },
);
