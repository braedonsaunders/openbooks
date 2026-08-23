import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  createObligationsFromInvoice,
  revenueContractPostingEffectKey,
  revenueObligationPostingEffectKey,
} from "./revenue-recognition.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function postgresFailure(error: unknown): { code?: string; constraint?: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code) return candidate;
    current = candidate.cause;
  }
  return null;
}

async function rejectsUnique(
  work: () => Promise<unknown>,
  constraint: string,
): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    const failure = postgresFailure(error);
    assert.equal(failure?.code, "23505");
    assert.equal(failure?.constraint, constraint);
    return true;
  });
}

test("duplicate inventory, revenue-contract, and obligation effects violate their storage keys", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const movementKey = `posting-effect:test:movement:${randomUUID()}`;
    const insertMovement = (id: string) => db.execute(sql`
      insert into inventory_movements
        (id, org_id, item_id, kind, moved_at, stock_location_id, quantity,
         status, idempotency_key)
      values (${id}, ${org.orgId}, ${org.items.fifo}, 'receipt', ${org.date},
              ${org.stockLocationId}, '1', 'pending', ${movementKey})
    `);
    await insertMovement(randomUUID());
    await rejectsUnique(
      () => insertMovement(randomUUID()),
      "inventory_movements_org_idempotency",
    );

    const contractId = randomUUID();
    const contractKey = `posting-effect:test:contract:${randomUUID()}`;
    const insertContract = (id: string, number: string) => db.execute(sql`
      insert into revenue_contracts
        (id, org_id, customer_id, contract_number, idempotency_key, status,
         total_transaction_price)
      values (${id}, ${org.orgId}, ${org.customerId}, ${number}, ${contractKey},
              'active', '100')
    `);
    await insertContract(contractId, `CONTRACT-${contractId}`);
    await rejectsUnique(
      () => insertContract(randomUUID(), `CONTRACT-${randomUUID()}`),
      "revenue_contracts_org_idempotency",
    );

    const obligationKey = `posting-effect:test:obligation:${randomUUID()}`;
    const insertObligation = (id: string) => db.execute(sql`
      insert into performance_obligations
        (id, org_id, contract_id, idempotency_key, description,
         recognition_rule_id, allocated_price, status)
      values (${id}, ${org.orgId}, ${contractId}, ${obligationKey},
              'Storage-key obligation', ${org.recognitionRuleId}, '100', 'open')
    `);
    await insertObligation(randomUUID());
    await rejectsUnique(
      () => insertObligation(randomUUID()),
      "performance_obligations_org_idempotency",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("concurrent invoice obligation creation converges on one contract and one obligation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const documentId = randomUUID();
  const lineId = randomUUID();
  try {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, currency, status, custom)
      values (${documentId}, ${org.orgId}, 'customer_invoice', ${`REV-IDEM-${documentId}`},
              ${org.customerId}, ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, description,
         quantity, unit_price, amount, tax_amount, custom)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.items.service},
              'Concurrent subscription', '1', '120', '120', '0', '{}'::jsonb)
    `);

    const results = await Promise.all([
      createObligationsFromInvoice(documentId, org.orgId, null),
      createObligationsFromInvoice(documentId, org.orgId, null),
    ]);
    assert.equal(results.reduce((total, result) => total + result.created, 0), 1);

    const stored = await db.execute<{
      contracts: number;
      obligations: number;
      contract_key: string;
      obligation_key: string;
    }>(sql`
      select count(distinct contract.id)::int as contracts,
             count(obligation.id)::int as obligations,
             min(contract.idempotency_key) as contract_key,
             min(obligation.idempotency_key) as obligation_key
        from revenue_contracts contract
        join performance_obligations obligation on obligation.contract_id=contract.id
       where contract.org_id=${org.orgId}
         and contract.idempotency_key=${revenueContractPostingEffectKey(documentId)}
    `);
    assert.deepEqual(stored.rows, [{
      contracts: 1,
      obligations: 1,
      contract_key: revenueContractPostingEffectKey(documentId),
      obligation_key: revenueObligationPostingEffectKey(lineId),
    }]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
