import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { PoolClient, QueryResult } from "pg";
import { db, pool } from "../engine/src/db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "../engine/src/test-fixtures.ts";

/** Drizzle wraps driver errors (DrizzleQueryError), hiding the PostgreSQL
 * message in `cause`; match the whole rendered chain so a trigger rejection
 * stays assertable. */
function pgMessage(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)}\n${cause === undefined ? "" : String(cause)}`;
}

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type TreeUpdateResult = PromiseSettledResult<QueryResult>;

const settleTreeUpdate = (promise: Promise<QueryResult>): Promise<TreeUpdateResult> =>
  promise.then(
    (value): TreeUpdateResult => ({ status: "fulfilled", value }),
    (reason): TreeUpdateResult => ({ status: "rejected", reason }),
  );

async function openTreeTransaction(): Promise<{ client: PoolClient; pid: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    const backend = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    return { client, pid: Number(backend.rows[0]!.pid) };
  } catch (error) {
    client.release(error as Error);
    throw error;
  }
}

async function observeTreeFence(
  blockerPid: number,
  waiterPid: number,
  update: Promise<TreeUpdateResult>,
): Promise<{ blocked: boolean; result?: TreeUpdateResult }> {
  let result: TreeUpdateResult | undefined;
  void update.then((settled) => {
    result = settled;
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (result) return { blocked: false, result };
    const lockState = await pool.query<{ blocked: boolean }>(
      "select $1::int = any(pg_blocking_pids($2::int)) as blocked",
      [blockerPid, waiterPid],
    );
    if (lockState.rows[0]?.blocked) return { blocked: true };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out observing segment-value tree fence for backend ${waiterPid}`);
}

async function raceTreeReparents(
  orgId: string,
  first: { valueId: string; parentId: string },
  second: { valueId: string; parentId: string },
): Promise<{ blocked: boolean; second: TreeUpdateResult }> {
  const transactionA = await openTreeTransaction();
  const transactionB = await openTreeTransaction();
  let openA = true;
  let openB = true;
  try {
    await transactionA.client.query(
      "update segment_values set parent_id = $1 where org_id = $2 and id = $3",
      [first.parentId, orgId, first.valueId],
    );
    const secondUpdate = settleTreeUpdate(
      transactionB.client.query(
        "update segment_values set parent_id = $1 where org_id = $2 and id = $3",
        [second.parentId, orgId, second.valueId],
      ),
    );
    const observation = await observeTreeFence(transactionA.pid, transactionB.pid, secondUpdate);
    await transactionA.client.query("commit");
    openA = false;
    const secondResult = observation.result ?? await secondUpdate;
    if (secondResult.status === "fulfilled") await transactionB.client.query("commit");
    else await transactionB.client.query("rollback");
    openB = false;
    return { blocked: observation.blocked, second: secondResult };
  } finally {
    if (openA) await transactionA.client.query("rollback").catch(() => undefined);
    if (openB) await transactionB.client.query("rollback").catch(() => undefined);
    transactionA.client.release();
    transactionB.client.release();
  }
}

function assertCycleRejected(result: TreeUpdateResult): void {
  assert.equal(result.status, "rejected", "one incompatible reparent must be rejected");
  if (result.status === "rejected") {
    assert.match(String(result.reason), /segment value hierarchy contains a cycle/);
  }
}

test("segment-value tree writes serialize per tenant and segment before cycle checks", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const otherOrg = await createScratchOrg();
  try {
    const segmentId = randomUUID();
    const otherSegmentId = randomUUID();
    const otherOrgSegmentId = randomUUID();
    await db.execute(sql`
      insert into segment_definitions (id, org_id, key, name, plural_name, source_kind, is_hierarchical)
      values
        (${segmentId}, ${org.orgId}, 'region_tree', 'Region', 'Regions', 'custom', true),
        (${otherSegmentId}, ${org.orgId}, 'channel_tree', 'Channel', 'Channels', 'custom', true),
        (${otherOrgSegmentId}, ${otherOrg.orgId}, 'region_tree', 'Region', 'Regions', 'custom', true)`);

    const ids = Array.from({ length: 14 }, () => randomUUID());
    const [twoA, twoB, longA, longB, longC, validA, validB, validC, validD,
      otherSegmentValue, otherOrgValue, directParent, directChild, rejectedDirect] = ids as string[];
    await db.execute(sql`
      insert into segment_values (id, org_id, segment_id, parent_id, code, name)
      values
        (${twoA}, ${org.orgId}, ${segmentId}, null, 'TWO-A', 'Two A'),
        (${twoB}, ${org.orgId}, ${segmentId}, null, 'TWO-B', 'Two B'),
        (${longA}, ${org.orgId}, ${segmentId}, null, 'LONG-A', 'Long A'),
        (${longB}, ${org.orgId}, ${segmentId}, ${longA}, 'LONG-B', 'Long B'),
        (${longC}, ${org.orgId}, ${segmentId}, null, 'LONG-C', 'Long C'),
        (${validA}, ${org.orgId}, ${segmentId}, null, 'VALID-A', 'Valid A'),
        (${validB}, ${org.orgId}, ${segmentId}, null, 'VALID-B', 'Valid B'),
        (${validC}, ${org.orgId}, ${segmentId}, null, 'VALID-C', 'Valid C'),
        (${validD}, ${org.orgId}, ${segmentId}, null, 'VALID-D', 'Valid D'),
        (${otherSegmentValue}, ${org.orgId}, ${otherSegmentId}, null, 'OTHER', 'Other segment'),
        (${otherOrgValue}, ${otherOrg.orgId}, ${otherOrgSegmentId}, null, 'OTHER-ORG', 'Other organization'),
        (${directParent}, ${org.orgId}, ${segmentId}, null, 'DIRECT-PARENT', 'Direct parent')`);

    const twoNode = await raceTreeReparents(
      org.orgId,
      { valueId: twoA, parentId: twoB },
      { valueId: twoB, parentId: twoA },
    );
    assert.equal(twoNode.blocked, true, "the reciprocal reparent must wait on the tree fence");
    assertCycleRejected(twoNode.second);

    const longer = await raceTreeReparents(
      org.orgId,
      { valueId: longA, parentId: longC },
      { valueId: longC, parentId: longB },
    );
    assert.equal(longer.blocked, true, "the longer-cycle reparent must wait on the tree fence");
    assertCycleRejected(longer.second);

    const valid = await raceTreeReparents(
      org.orgId,
      { valueId: validA, parentId: validB },
      { valueId: validC, parentId: validD },
    );
    assert.equal(valid.blocked, true, "same-segment valid moves still serialize at storage");
    assert.equal(valid.second.status, "fulfilled", "independent valid moves must both commit");

    await assert.rejects(
      db.execute(sql`
        insert into segment_values (id, org_id, segment_id, parent_id, code, name)
        values (${rejectedDirect}, ${org.orgId}, ${segmentId}, ${otherSegmentValue}, 'BAD-SEGMENT', 'Bad segment parent')`),
      (error: unknown) => pgMessage(error).includes("segment value parent is invalid"),
    );
    await assert.rejects(
      db.execute(sql`
        insert into segment_values (id, org_id, segment_id, parent_id, code, name)
        values (${rejectedDirect}, ${org.orgId}, ${segmentId}, ${otherOrgValue}, 'BAD-ORG', 'Bad organization parent')`),
      (error: unknown) => pgMessage(error).includes("segment value parent is invalid"),
    );
    await db.execute(sql`
      insert into segment_values (id, org_id, segment_id, parent_id, code, name)
      values (${directChild}, ${org.orgId}, ${segmentId}, ${directParent}, 'DIRECT-CHILD', 'Direct child')`);

    const parents = await db.execute<{ id: string; parent_id: string | null }>(sql`
      select id::text as id, parent_id::text as parent_id from segment_values
       where org_id = ${org.orgId}
         and id in (${twoA}, ${twoB}, ${longA}, ${longC}, ${validA}, ${validC}, ${directChild})`);
    assert.deepEqual(
      new Map(parents.rows.map((row) => [row.id, row.parent_id])),
      new Map([
        [twoA, twoB],
        [twoB, null],
        [longA, longC],
        [longC, null],
        [validA, validB],
        [validC, validD],
        [directChild, directParent],
      ]),
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
    await dropScratchOrgReporting(otherOrg.orgId);
  }
});
