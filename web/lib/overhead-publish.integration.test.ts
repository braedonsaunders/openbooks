import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import test from "node:test";
import { env } from "@openbooks/engine/src/platform/db.ts";

function runIntegrationSource(source: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--import",
      "./engine/src/testing/database-bypass.ts",
      "--input-type=module",
      "-e",
      source,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const routeStateKey = Symbol.for("openbooks.overhead-publish-route-test");
const routeState: {
  authz: { user: { orgId: string; id: string } } | null;
  calls: Array<{
    orgId: string;
    actorId: string;
    effectiveFrom: string;
    rates: Array<{ departmentId: string; ratePerHour: string }> | undefined;
  }>;
} = { authz: null, calls: [] };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[routeStateKey] = routeState;

const routeHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../../../../../lib/authz" &&
      context.parentURL?.includes("setup/overhead/route.ts")
    ) {
      return { url: "mock:overhead-authz", shortCircuit: true };
    }
    // The factory authenticates through the `@/lib/authz` alias, which the
    // route-relative condition above never matches: without this edge the
    // factory loads the real cookie session instead of the test session.
    // The factory imports lazily at request time, so this edge must stay
    // registered while tests run (see the deregistration below).
    if (
      specifier === "@/lib/authz" &&
      context.parentURL?.includes("/lib/api/route")
    ) {
      return { url: "mock:overhead-authz", shortCircuit: true };
    }
    if (
      specifier === "../../../../../lib/projects-gate" &&
      context.parentURL?.includes("setup/overhead/route.ts")
    ) {
      return { url: "mock:overhead-projects-gate", shortCircuit: true };
    }
    if (
      specifier === "../../../../../lib/overhead-publish" &&
      context.parentURL?.includes("setup/overhead/route.ts")
    ) {
      return { url: "mock:overhead-publisher", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:overhead-authz") {
      return {
        format: "module",
        source: `
          const state = globalThis[Symbol.for('openbooks.overhead-publish-route-test')]
          export async function guardPermission() {
            if (!state.authz) return new Response(null, { status: 403 })
            return state.authz
          }
          export function guardUnrestrictedScope(authz) {
            if (!authz) return new Response(null, { status: 403 })
            return null
          }
          export function subsidiariesInScope() { return true }
        `,
        shortCircuit: true,
      };
    }
    if (url === "mock:overhead-projects-gate") {
      return {
        format: "module",
        source: "export async function guardProjectsFeature() { return null }",
        shortCircuit: true,
      };
    }
    if (url === "mock:overhead-publisher") {
      return {
        format: "module",
        source: `
          const state = globalThis[Symbol.for('openbooks.overhead-publish-route-test')]
          export async function publishOverheadRates(orgId, actorId, effectiveFrom, rates) {
            state.calls.push({ orgId, actorId, effectiveFrom, rates })
            return { published: rates?.length ?? 0 }
          }
        `,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const overheadRouteUrl = new URL(
  "../app/api/admin/setup/overhead/route.ts?overhead-publish-route-test",
  import.meta.url,
).href;
const { POST: overheadRoutePost } = (await import(overheadRouteUrl)) as typeof import(
  "../app/api/admin/setup/overhead/route.ts"
);
// The factory resolves its session import lazily at request time, so the
// hooks must stay registered while tests run: deregistering here would hand
// later requests the real cookie session instead of the test session.
// (Spawned subprocesses are separate processes and never observe the hooks.)
test.after(() => routeHooks.deregister());

test("manual overhead publishing preserves all four validated decimal places", async () => {
  routeState.authz = { user: { orgId: "org-test", id: "actor-test" } };
  routeState.calls.length = 0;

  const response = await overheadRoutePost(new Request("http://localhost/api/admin/setup/overhead", {
    method: "POST",
    body: JSON.stringify({
      action: "publish",
      effectiveFrom: "2026-09-01",
      rates: [{ departmentId: "department-test", ratePerHour: "1.2345" }],
    }),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(routeState.calls, [{
    orgId: "org-test",
    actorId: "actor-test",
    effectiveFrom: "2026-09-01",
    rates: [{ departmentId: "department-test", ratePerHour: "1.2345" }],
  }]);
  assert.deepEqual(await response.json(), { ok: true, published: 1 });
  routeState.authz = null;
});

test(
  "a failed mid-department overhead publish commits nothing, not a mixed-generation rate card",
  { skip: !env.OPENBOOKS_DB_URL },
  () => {
    const source = `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { sql } from "drizzle-orm";
      import { db } from "./engine/src/platform/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
      import {
        createScratchOrg,
        dropScratchOrg,
        seedFlowActors,
      } from "./engine/src/testing/fixtures.ts";
      import { stubModules } from "./web/testing/stub-modules.ts";
      import { ScopeNotFoundError } from "./engine/src/organization/subsidiary-scope.ts";

      installTrustedTestDatabaseBypass();
      // catalog-strings resolves its English catalog through bare next-intl
      // at module load, whose production ESM has no headless entry: stub the
      // UI-only translator seam before the publish module loads it. Real
      // publish transactions and all rollback/audit assertions are unchanged.
      stubModules({ intl: true, extra: { 'next-intl': 'export async function getTranslations(){return (key)=>key}export async function getMessages(){return {}}export async function getLocale(){return "en"}export function createTranslator(options){const messages=options.messages;const catalog=options.namespace?messages?.[options.namespace]:messages ?? {};return (key,values)=>{const parts=String(key).split(".");let template=catalog;for(const part of parts)template=template?.[part];if(typeof template!=="string")return String(key);if(!values)return template;let out=template;for(const name of Object.keys(values))out=out.split("{"+name+"}").join(String(values[name]));return out;}}' } });
      const { publishOverheadRates } = await import("./web/lib/overhead-publish.ts");
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

        // Department A locks cleanly; the unknown department id is refused by
        // the scope lock before any write, so nothing may stick.
        await assert.rejects(
          publishOverheadRates(org.orgId, actorId, '2026-09-01', [
            { departmentId: deptA, ratePerHour: '42.00' },
            { departmentId: randomUUID(), ratePerHour: '50.00' },
          ]),
          (error) => error instanceof ScopeNotFoundError,
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
      import { db } from "./engine/src/platform/db.ts";
      import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
      import {
        createScratchOrg,
        dropScratchOrg,
        seedFlowActors,
      } from "./engine/src/testing/fixtures.ts";
      import { stubModules } from "./web/testing/stub-modules.ts";
      import { ScopeNotFoundError } from "./engine/src/organization/subsidiary-scope.ts";

      installTrustedTestDatabaseBypass();
      // catalog-strings resolves its English catalog through bare next-intl
      // at module load, whose production ESM has no headless entry: stub the
      // UI-only translator seam before the publish module loads it. Real
      // publish transactions and all rollback/audit assertions are unchanged.
      stubModules({ intl: true, extra: { 'next-intl': 'export async function getTranslations(){return (key)=>key}export async function getMessages(){return {}}export async function getLocale(){return "en"}export function createTranslator(options){const messages=options.messages;const catalog=options.namespace?messages?.[options.namespace]:messages ?? {};return (key,values)=>{const parts=String(key).split(".");let template=catalog;for(const part of parts)template=template?.[part];if(typeof template!=="string")return String(key);if(!values)return template;let out=template;for(const name of Object.keys(values))out=out.split("{"+name+"}").join(String(values[name]));return out;}}' } });
      const { publishOverheadRates } = await import("./web/lib/overhead-publish.ts");
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
