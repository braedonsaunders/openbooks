import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

function runIntegrationSource(source: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--import",
      "./engine/src/test-database-bypass.ts",
      "--input-type=module",
      "-e",
      source,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test(
  "a failed mid-department overhead publish commits nothing, not a mixed-generation rate card",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    const source = `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import {
        createScratchOrg,
        dropScratchOrg,
        seedFlowActors,
      } from "./engine/src/test-fixtures.ts";
      import { publishOverheadRates } from "./web/lib/overhead-publish.ts";

      installTrustedTestDatabaseBypass();
      const org = await createScratchOrg();
      try {
        const actorId = (await seedFlowActors(org.orgId)).adminId;
        const deptA = randomUUID();
        const deptB = randomUUID();

        await db.execute(sql\`
          insert into departments (id, org_id, code, name)
          values
            (\${deptA}, \${org.orgId}, 'FAB-OVERHEAD', 'Fabrication'),
            (\${deptB}, \${org.orgId}, 'FIN-OVERHEAD', 'Finishing')
        \`);
        // Existing generation-one card: an open per-hour row per department and
        // a future-dated row past the new start (delete-future input).
        await db.execute(sql\`
          insert into overhead_rates
            (id, org_id, department_id, category, method, rate_kind, rate_percent, effective_from)
          values
            (\${randomUUID()}, \${org.orgId}, \${deptA}, 'Baseline', 'standard', 'per_hour', '10.0000', '2026-01-01'),
            (\${randomUUID()}, \${org.orgId}, \${deptA}, 'Planned', 'standard', 'per_hour', '99.0000', '2027-01-01'),
            (\${randomUUID()}, \${org.orgId}, \${deptB}, 'Baseline', 'standard', 'per_hour', '20.0000', '2026-02-01')
        \`);

        // Department A publishes cleanly; department B then fails on its insert
        // (nonexistent department id violates the FK) AFTER A's statements ran.
        // Drizzle wraps the driver error, so match through the cause chain.
        await assert.rejects(
          publishOverheadRates(org.orgId, actorId, '2026-09-01', [
            { departmentId: deptA, ratePerHour: '42.00' },
            { departmentId: randomUUID(), ratePerHour: '50.00' },
          ]),
          (error) => {
            const message = String(error?.cause?.message ?? error);
            return /overhead_rates_department_id_fkey/.test(message);
          },
        );

        // Nothing may stick: no closed rows, no deleted future row, no new
        // Published rows, no audit — the previous card is fully intact.
        const card = await db.execute(sql\`
          select department_id, category, rate_percent, effective_from, effective_to
            from overhead_rates
           where org_id = \${org.orgId}
        \`);
        // Department ids are random UUIDs; never rely on their sort order.
        card.rows.sort((a, b) =>
          (a.effective_from + a.category).localeCompare(b.effective_from + b.category));
        assert.deepEqual(card.rows, [
          { department_id: deptA, category: 'Baseline', rate_percent: '10.0000', effective_from: '2026-01-01', effective_to: null },
          { department_id: deptB, category: 'Baseline', rate_percent: '20.0000', effective_from: '2026-02-01', effective_to: null },
          { department_id: deptA, category: 'Planned', rate_percent: '99.0000', effective_from: '2027-01-01', effective_to: null },
        ]);
        const audits = await db.execute(sql\`
          select count(*)::int as count from audit_log
           where org_id = \${org.orgId} and table_name = 'overhead_rates'
        \`);
        assert.equal(audits.rows[0].count, 0);
      } finally {
        await dropScratchOrg(org.orgId);
      }
    `;
    runIntegrationSource(source);
  },
);

test(
  "a successful overhead publish closes, replaces and audits all departments in one unit",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    const source = `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db } from "./engine/src/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
      import {
        createScratchOrg,
        dropScratchOrg,
        seedFlowActors,
      } from "./engine/src/test-fixtures.ts";
      import { publishOverheadRates } from "./web/lib/overhead-publish.ts";

      installTrustedTestDatabaseBypass();
      const org = await createScratchOrg();
      try {
        const actorId = (await seedFlowActors(org.orgId)).adminId;
        const deptA = randomUUID();
        const deptB = randomUUID();

        await db.execute(sql\`
          insert into departments (id, org_id, code, name)
          values
            (\${deptA}, \${org.orgId}, 'FAB-OVERHEAD', 'Fabrication'),
            (\${deptB}, \${org.orgId}, 'FIN-OVERHEAD', 'Finishing')
        \`);
        await db.execute(sql\`
          insert into overhead_rates
            (id, org_id, department_id, category, method, rate_kind, rate_percent, effective_from)
          values
            (\${randomUUID()}, \${org.orgId}, \${deptA}, 'Baseline', 'standard', 'per_hour', '10.0000', '2026-01-01'),
            (\${randomUUID()}, \${org.orgId}, \${deptA}, 'Planned', 'standard', 'per_hour', '99.0000', '2027-01-01'),
            (\${randomUUID()}, \${org.orgId}, \${deptB}, 'Baseline', 'standard', 'per_hour', '20.0000', '2026-02-01')
        \`);

        const result = await publishOverheadRates(org.orgId, actorId, '2026-09-01', [
          { departmentId: deptA, ratePerHour: '42.00' },
          { departmentId: deptB, ratePerHour: '55.25' },
        ]);
        assert.equal(result.published, 2);

        // Open rows close the day before the new start; future rows vanish;
        // exactly one new standard row per department begins at the start date.
        const card = await db.execute(sql\`
          select department_id, category, method, rate_kind, rate_percent,
                 effective_from, effective_to
            from overhead_rates
           where org_id = \${org.orgId}
        \`);
        // Department ids are random UUIDs; never rely on their sort order.
        const byRow = (a, b) =>
          (a.effective_from + a.category).localeCompare(b.effective_from + b.category);
        card.rows.sort(byRow);
        assert.deepEqual(card.rows, [
          { department_id: deptA, category: 'Baseline', method: 'standard', rate_kind: 'per_hour', rate_percent: '10.0000', effective_from: '2026-01-01', effective_to: '2026-08-31' },
          { department_id: deptB, category: 'Baseline', method: 'standard', rate_kind: 'per_hour', rate_percent: '20.0000', effective_from: '2026-02-01', effective_to: '2026-08-31' },
          { department_id: deptA, category: 'Published', method: 'standard', rate_kind: 'per_hour', rate_percent: '42.0000', effective_from: '2026-09-01', effective_to: null },
          { department_id: deptB, category: 'Published', method: 'standard', rate_kind: 'per_hour', rate_percent: '55.2500', effective_from: '2026-09-01', effective_to: null },
        ]);

        // One canonical publish audit covering BOTH departments, written by the
        // same transaction — never missing while rows already moved.
        const audits = await db.execute(sql\`
          select changes, actor_id from audit_log
           where org_id = \${org.orgId} and table_name = 'overhead_rates'
        \`);
        assert.equal(audits.rows.length, 1);
        assert.deepEqual(audits.rows[0].changes, {
          publish: {
            effectiveFrom: '2026-09-01',
            rates: [
              { departmentId: deptA, ratePerHour: '42.00' },
              { departmentId: deptB, ratePerHour: '55.25' },
            ],
            actor: actorId,
          },
        });
        assert.equal(audits.rows[0].actor_id, actorId);
      } finally {
        await dropScratchOrg(org.orgId);
      }
    `;
    runIntegrationSource(source);
  },
);
