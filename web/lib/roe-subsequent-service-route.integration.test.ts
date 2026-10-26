import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";
const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("openbooks.roe-return-route")
] = state;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/feature-gates")
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.roe-return-route')].gate}",
          ),
      };
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { seedAdoption, seedRoeIssuanceFixture } =
  await import("@openbooks/engine/testing/payroll/filing-test-fixtures");
const { dropScratchOrgReporting, seedPayrollSettings, grantScratchPermissions } =
  await import("@openbooks/engine/testing/fixtures");
const { GET, POST } = await import("../app/api/payroll/separations/subsequent-service/route");
async function setup() {
  const f = await seedAdoption();
  await seedPayrollSettings(f.orgId, { features: { payroll: true } });
  await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
  await seedRoeIssuanceFixture(f.orgId, f.employeeId);
  const events = await db.execute<{ id: string }>(
    sql`select id from payroll_roe_separation_events
    where org_id=${f.orgId} and employee_party_id=${f.employeeId}`,
    "objects",
  );
  assert.equal(events.length, 1);
  const file = randomUUID(),
    version = randomUUID(),
    folder = randomUUID();
  const bytes = Buffer.from("Original employee return-to-work declaration, 2026-08-11");
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    (
      await db.execute(
        sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
    values(${folder},${f.orgId},'Original return evidence',true,${f.actorId},${f.actorId},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
    values(${file},${f.orgId},${folder},'return.txt','text/plain',${bytes.length},${f.actorId},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
    values(${version},${file},1,${bytes.length},'text/plain',${hash},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_blobs(version_id,bytes) values(${version},${bytes}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update files set current_version_id=${version} where org_id=${f.orgId} and id=${file} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  return { ...f, file, version, hash, eventId: events[0]!.id };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function gate(f: Fixture, scope: Set<string> | null = null) {
  state.gate = {
    user: { orgId: f.orgId, id: f.actorId },
    permissions: new Set(["payroll.read", "payroll.run"]),
    allowedSubsidiaryIds: scope,
  } as Authz;
}
function subject(f: Fixture) {
  return {
    employeePartyId: f.employeeId,
    employmentId: f.employmentId,
    subsidiaryId: f.subsidiaryId,
    precedingEventId: f.eventId,
  };
}
function request(body: unknown) {
  return new Request("https://openbooks.test/api/payroll/separations/subsequent-service", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const DB = !!process.env.OPENBOOKS_DB_URL;
test(
  "selected-event return API saves and reads exact retained evidence, replays once and refuses stale corrections",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        gate(f);
        const query = new URLSearchParams({ ...subject(f), sourceFileId: f.file });
        const loaded = await GET(
          new Request("https://openbooks.test/api/payroll/separations/subsequent-service?" + query),
        );
        assert.equal(loaded.status, 200);
        const context = await loaded.json();
        assert.equal(context.record, null);
        assert.deepEqual(context.source, {
          id: f.file,
          versionId: f.version,
          sha256: f.hash,
          name: "return.txt",
        });
        const input = {
          ...subject(f),
          firstDayWorked: "2026-08-11",
          sourceFileId: f.file,
          sourceVersionId: f.version,
          sourceSha256: f.hash,
          sourceReference: "Original signed return declaration",
          reason: "Retain actual later service",
          expectedId: null,
          expectedUpdatedAt: null,
        };
        const saved = await POST(request(input));
        assert.equal(saved.status, 200);
        const record = (await saved.json()).record;
        const replay = await POST(request(input));
        assert.equal(replay.status, 200);
        assert.deepEqual((await replay.json()).record, record);
        const read = await GET(
          new Request(
            "https://openbooks.test/api/payroll/separations/subsequent-service?" +
              new URLSearchParams(subject(f)),
          ),
        );
        assert.equal(read.status, 200);
        assert.deepEqual((await read.json()).record, record);
        const stale = await POST(request({ ...input, firstDayWorked: "2026-08-12" }));
        assert.equal(stale.status, 422);
        assert.match((await stale.json()).error, /changed.*reload/i);
        const rows = await db.execute<{ id: string; first: string }>(
          sql`select id,first_day_worked::text as first
      from payroll_roe_subsequent_service_sources where org_id=${f.orgId}`,
          "objects",
        );
        assert.deepEqual(rows, [{ id: record.id, first: "2026-08-11" }]);
        const audit = await db.execute(
          sql`select id from audit_log where org_id=${f.orgId}
      and table_name='payroll_roe_subsequent_service_sources' and row_id=${record.id}`,
          "objects",
        );
        assert.equal(audit.length, 1, "exact API replay creates no second certificate or audit");
      });
    } finally {
      state.gate = null;
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
test(
  "return API refuses entity/event substitution, inactive source and malformed hashes without authoring evidence",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        gate(f, new Set());
        const denied = await GET(
          new Request(
            "https://openbooks.test/api/payroll/separations/subsequent-service?" +
              new URLSearchParams(subject(f)),
          ),
        );
        assert.equal(denied.status, 422);
        gate(f);
        const input = {
          ...subject(f),
          firstDayWorked: "2026-08-11",
          sourceFileId: f.file,
          sourceVersionId: f.version,
          sourceSha256: f.hash,
          sourceReference: "Original return declaration",
          reason: "Retain actual service",
          expectedId: null,
          expectedUpdatedAt: null,
        };
        for (const altered of [
          { ...input, employmentId: randomUUID() },
          { ...input, sourceSha256: "bad" },
          { ...input, firstDayWorked: "2026-08-10" },
          { ...input, firstDayWorked: "2026-02-30" },
          { ...input, sourceVersionId: randomUUID() },
        ]) {
          const refused = await POST(request(altered));
          assert.equal(refused.status, 422);
        }
        assert.equal(
          (
            await db.execute(
              sql`update files set is_inactive=true where org_id=${f.orgId} and id=${f.file} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const inactive = await GET(
          new Request(
            "https://openbooks.test/api/payroll/separations/subsequent-service?" +
              new URLSearchParams({ ...subject(f), sourceFileId: f.file }),
          ),
        );
        assert.equal(inactive.status, 422);
        assert.match((await inactive.json()).error, /original.*Cabinet/);
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_roe_subsequent_service_sources where org_id=${f.orgId}`,
              "objects",
            )
          ).length,
          0,
        );
      });
    } finally {
      state.gate = null;
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
