import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { issuePayRunCheques, payRunCheques } from "./cheques.ts";
import { commitPayRun } from "./run-commit.ts";
import {
  calculatedRun,
  seedAdoption,
} from "./filing-test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Cheque stock is physical: a number that has left the printer cannot be
 * recalled. Issuing for a run the caller only partly owns would put
 * negotiable instruments for out-of-scope employees into the world, so a
 * scoped caller must own the complete population — the same opacity every
 * other run action enforces.
 */
test(
  "cheque issue refuses a run carrying employees outside the caller's subsidiary scope",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    await db.execute(sql`update parties set subsidiary_id = ${fx.subsidiaryId}
      where org_id = ${fx.orgId} and id = ${fx.employeeId}`);
    const { input } = await calculatedRun(fx);
    await commitPayRun(input);
    // The fixture hire holds no bank details, so the stub settles on paper.
    assert.equal((await payRunCheques(fx.orgId, input.documentId)).cheques.length, 1);

    const hidden = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${hidden}, ${fx.orgId}, ${fx.subsidiaryId}, 'Hidden cheque employer', 'CAD', 'CA')`);
    await db.execute(sql`update parties set subsidiary_id = ${hidden}
      where org_id = ${fx.orgId} and id = ${fx.employeeId}`);

    const scoped = new Set([fx.subsidiaryId]);
    await assert.rejects(
      issuePayRunCheques({
        orgId: fx.orgId,
        documentId: input.documentId,
        actorId: fx.actorId,
        allowedSubsidiaryIds: scoped,
      }),
      /pay run not found/,
    );
    const stamped = (await db.execute<{ count: string }>(sql`
      select count(*) as count from pay_stubs
       where org_id = ${fx.orgId} and pay_run_document_id = ${input.documentId}
         and cheque_number is not null`)).rows[0]!.count;
    assert.equal(stamped, "0", "a refused issue must not burn cheque stock");
    // Unrestricted payroll still issues the complete batch.
    assert.equal(
      (await issuePayRunCheques({ orgId: fx.orgId, documentId: input.documentId, actorId: fx.actorId })).issued,
      1,
    );
  },
);
