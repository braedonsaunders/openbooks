/**
 * Testdb proof for 0757_equity_close_steps_on_default_checklists.
 *
 * An organization whose standard close checklist predates the equity period
 * steps gains both steps, after its prepaid amortization step, with their
 * standard dependencies; a custom checklist is left as its owner keeps it;
 * applying the backfill again changes nothing; and the standard defaults
 * reconcile cleanly with the backfilled rows.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { ensureCloseDefaults } from "@openbooks/engine/testing/close/defaults";
import { withBypassContext } from "@openbooks/engine/platform/db";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/testing/fixtures";

const migration = readFileSync("schema/migrations/generated/0757_equity_close_steps_on_default_checklists.sql", "utf8");
const EQUITY_STEPS = ["equity-compensation-posted", "equity-interest-accrued"];

test("existing standard close checklists gain the equity period steps; custom checklists keep the owner's choice", {
  skip: !process.env.OPENBOOKS_TEST_ADMIN_DB_URL,
}, async () => {
  const adminUrl = process.env.OPENBOOKS_TEST_ADMIN_DB_URL!;
  assert.match(new URL(adminUrl).pathname, /^\/ob_/);
  const admin = new pg.Client({ connectionString: adminUrl });
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await admin.connect();
    const { blueprintId } = await withBypassContext(() => ensureCloseDefaults(org.orgId));
    // The checklist as it stood before the equity steps were standard.
    await admin.query(`delete from close_blueprint_dependencies where org_id = $1 and (step_id in (select id from close_blueprint_steps where org_id = $1 and key = any($2))
      or depends_on_step_id in (select id from close_blueprint_steps where org_id = $1 and key = any($2)))`, [org.orgId, EQUITY_STEPS]);
    await admin.query("delete from close_blueprint_steps where org_id = $1 and key = any($2)", [org.orgId, EQUITY_STEPS]);
    const custom = (await admin.query<{ id: string }>(`insert into close_blueprints (org_id, name, description, period_type, is_default, is_active, version)
      values ($1, 'Month-end close (controller)', 'Our own checklist', 'any', false, true, 1) returning id`, [org.orgId])).rows[0]!.id;
    await admin.query(`insert into close_blueprint_steps (org_id, blueprint_id, key, title, workstream, sort_order) values ($1, $2, 'prepaid-amortized', 'Amortize prepaids', 'gl', 10)`, [org.orgId, custom]);

    await admin.query(migration);
    const steps = (await admin.query<{ key: string; sort_order: number; title: string; completion_mode: string; gate_type: string; task_type: string; workstream: string }>(`
      select key, sort_order, title, completion_mode, gate_type, task_type, workstream from close_blueprint_steps
       where blueprint_id = $1 and key = any($2::text[]) order by sort_order`, [blueprintId, ["prepaid-amortized", ...EQUITY_STEPS]])).rows;
    assert.deepEqual(steps.map((row) => row.key), ["prepaid-amortized", ...EQUITY_STEPS], "the equity steps follow prepaid amortization");
    assert.deepEqual(steps.slice(1).map((row) => row.sort_order), [steps[0]!.sort_order + 1, steps[0]!.sort_order + 2]);
    for (const row of steps.slice(1)) {
      assert.equal(row.title, `close.defaultSteps.${row.key}.title`);
      assert.deepEqual([row.workstream, row.task_type, row.completion_mode, row.gate_type], ["gl", "journal", "computed", "hard"]);
    }
    const edges = async () => (await admin.query<{ edge: string }>(`
      select s.key || ' > ' || d.key as edge from close_blueprint_dependencies e
        join close_blueprint_steps s on s.id = e.step_id join close_blueprint_steps d on d.id = e.depends_on_step_id
       where e.blueprint_id = $1 and (s.key = any($2::text[]) or d.key = any($2::text[])) order by 1`, [blueprintId, EQUITY_STEPS])).rows.map((row) => row.edge);
    assert.deepEqual(await edges(), [
      "equity-compensation-posted > drafts-cleared",
      "equity-interest-accrued > drafts-cleared",
      "period-end-journals > equity-compensation-posted",
      "period-end-journals > equity-interest-accrued",
      "variance-review > equity-compensation-posted",
      "variance-review > equity-interest-accrued",
    ]);
    assert.equal((await admin.query("select count(*)::int as n from close_blueprint_steps where blueprint_id = $1", [custom])).rows[0].n, 1, "a custom checklist is not changed");

    await admin.query(migration);
    assert.equal((await admin.query("select count(*)::int as n from close_blueprint_steps where blueprint_id = $1 and key = any($2::text[])", [blueprintId, EQUITY_STEPS])).rows[0].n, 2, "a second application adds nothing");
    await withBypassContext(() => ensureCloseDefaults(org.orgId));
    assert.equal((await edges()).length, 6, "the standard defaults reconcile with the backfilled rows");
  } finally {
    await admin.end();
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
