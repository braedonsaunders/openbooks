import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/testing/fixtures";
import { createSetupRecord, updateSetupRecord } from "../setup/write";
import { getResource, listResources } from "./resources";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test(
  "usage setup delegates to the engine and imported records remain idempotent evidence",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const actorId = randomUUID();
    try {
      await withOrgContext(org.orgId, async () => {
        await db.execute(
          sql`update orgs set settings = jsonb_set(settings, '{features}', '{"subscriptionBilling":true,"usageBilling":true,"saasMetrics":true}'::jsonb) where id = ${org.orgId}`,
        );
        await db.execute(
          sql`insert into customer_roles (org_id, party_id, is_active) values (${org.orgId}, ${org.customerId}, true)`,
        );
        const customer = await db.execute(
          sql`update parties set subsidiary_id = ${org.subsidiaryId}
        where org_id = ${org.orgId} and id = ${org.customerId} returning id`,
          "objects",
        );
        assert.equal(
          customer.length,
          1,
          "the import customer belongs to a subsidiary for the scope refusal",
        );
      });
      const created = await withOrgContext(org.orgId, () =>
        createSetupRecord(
          { orgId: org.orgId, id: actorId, permissions: ["admin.setup.manage"] },
          "usage-meters",
          { key: "api_calls", name: "API calls", unit: "call", aggregation: "sum", isActive: true },
        ),
      );
      assert.equal(created.status, 200);
      const meterId = String(created.body.id);
      assert.equal(
        (
          await withOrgContext(org.orgId, () =>
            updateSetupRecord(
              { orgId: org.orgId, id: actorId, permissions: ["admin.setup.manage"] },
              "usage-meters",
              {
                id: meterId,
                key: "api_calls",
                name: "API requests",
                unit: "call",
                aggregation: "sum",
                isActive: true,
              },
            ),
          )
        ).status,
        200,
      );

      const resource = await withOrgContext(org.orgId, () =>
        getResource(org.orgId, "usage-records"),
      );
      assert.ok(resource);
      const row = {
        meterKey: "api_calls",
        customer: "Acme Customer",
        subscription: "",
        occurredOn: "2026-07-20",
        quantity: "2",
        distinctKey: "",
        sourceRef: "batch-1",
        idempotencyKey: "import-1",
      };
      const ctx = { orgId: org.orgId, actorId, dryRun: true, allowedSubsidiaryIds: null };
      const preview = await withOrgContext(org.orgId, () => resource.write([row], "insert", ctx));
      assert.deepEqual(
        [preview.created, preview.failed],
        [1, 0],
        `preview result: ${JSON.stringify(preview)}`,
      );
      const committed = await withOrgContext(org.orgId, () =>
        resource.write([row], "insert", { ...ctx, dryRun: false }),
      );
      assert.deepEqual(
        [committed.created, committed.failed],
        [1, 0],
        `commit result: ${JSON.stringify(committed)}`,
      );
      const outsideScope = await withOrgContext(org.orgId, () =>
        resource.write([{ ...row, idempotencyKey: "import-outside-scope" }], "insert", {
          ...ctx,
          dryRun: false,
          allowedSubsidiaryIds: new Set<string>(),
        }),
      );
      assert.deepEqual(
        [outsideScope.created, outsideScope.failed],
        [0, 1],
        `out-of-scope result: ${JSON.stringify(outsideScope)}`,
      );
      const hiddenImport = await withOrgContext(org.orgId, () =>
        db.execute(
          sql`
      select id from usage_records
       where org_id = ${org.orgId} and meter_id = ${meterId} and idempotency_key = 'import-outside-scope'`,
          "objects",
        ),
      );
      assert.equal(hiddenImport.length, 0);
      const stored = await withOrgContext(org.orgId, () =>
        db.execute<{ source: string }>(
          sql`select source from usage_records where org_id = ${org.orgId} and meter_id = ${meterId} and idempotency_key = 'import-1'`,
          "objects",
        ),
      );
      assert.equal(stored[0]?.source, "import");
      const replay = await withOrgContext(org.orgId, () =>
        resource.write([row], "upsert", { ...ctx, dryRun: false }),
      );
      assert.deepEqual(
        [replay.created, replay.updated, replay.failed],
        [0, 0, 0],
        `replay result: ${JSON.stringify(replay)}`,
      );
      const missingKey = await withOrgContext(org.orgId, () =>
        resource.write([{ ...row, idempotencyKey: "" }], "insert", { ...ctx, dryRun: false }),
      );
      assert.match(missingKey.errors[0]?.message ?? "", /idempotency_key/i);
      const distinctMismatch = await withOrgContext(org.orgId, () =>
        resource.write(
          [{ ...row, distinctKey: "tenant-a", idempotencyKey: "import-distinct" }],
          "insert",
          { ...ctx, dryRun: false },
        ),
      );
      assert.match(distinctMismatch.errors[0]?.message ?? "", /does not accept distinct_key/i);
      const exported = await withOrgContext(org.orgId, () => resource.read());
      const exportedRow = exported.rows.find((item) => item.idempotencyKey === "import-1");
      assert.equal(exportedRow?.quantity, "2.00000000");
      const roundTrip = await withOrgContext(org.orgId, () =>
        resource.write([exportedRow!], "upsert", { ...ctx, dryRun: false }),
      );
      assert.deepEqual(
        [roundTrip.created, roundTrip.updated, roundTrip.failed],
        [0, 0, 0],
        `round-trip result: ${JSON.stringify(roundTrip)}`,
      );
      const keyChange = await withOrgContext(org.orgId, () =>
        updateSetupRecord(
          { orgId: org.orgId, id: actorId, permissions: ["admin.setup.manage"] },
          "usage-meters",
          {
            id: meterId,
            key: "renamed_calls",
            name: "API requests",
            unit: "call",
            aggregation: "sum",
            isActive: true,
          },
        ),
      );
      assert.equal(keyChange.body.code, "usage_meter_identity_locked");

      const facts = await withOrgContext(org.orgId, () =>
        getResource(org.orgId, "saas-metrics-facts"),
      );
      assert.ok(facts);
      assert.equal(facts.descriptor.supportsImport, false);
      assert.equal(
        (await facts.write([{ month: "2026-07-01" }], "insert", { ...ctx, dryRun: false })).failed,
        1,
      );
      await withOrgContext(org.orgId, () =>
        db.execute(
          sql`update orgs set settings = jsonb_set(settings, '{features}', '{"subscriptionBilling":true,"usageBilling":false,"saasMetrics":false}'::jsonb) where id = ${org.orgId}`,
        ),
      );
      const keys = (await listResources(org.orgId)).map(({ key }) => key);
      assert.equal(
        keys.some((key) => key.startsWith("usage-") || key === "saas-metrics-facts"),
        false,
      );
      assert.equal(await getResource(org.orgId, "usage-records"), null);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
