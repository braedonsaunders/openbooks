import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BUILT_IN_REPORT_DEFINITION_MAP } from "./built-ins";
import { compileCustomQuery } from "./custom-query";
import { REPORT_ENTITY_MAP } from "./entities";
import { validateCustomQuery } from "./validate";

const ORG = "00000000-0000-4000-8000-000000000001";
const ENTITY = "00000000-0000-4000-8000-0000000000e1";

// Register reports read the register subledger directly: drawer sessions for
// the Z history and cash over/short, register sales and refunds for sales by
// register and cashier. Both are gated by the register feature, scoped to the
// session's legal entity, pinned to the organization on every join, and carry
// amounts in the session currency.
describe("register report entities", () => {
  it("gates each source by the register feature and its read permission, inside the organization", () => {
    const expected = { pos_sessions: "pos.drawer", pos_transactions: "cash_sales.read" } as const;
    for (const [key, permission] of Object.entries(expected)) {
      const entity = REPORT_ENTITY_MAP[key];
      assert.ok(entity, `${key} is in the report catalog`);
      assert.equal(entity.featureKey, "posRegister");
      assert.equal(entity.requiredPermission, permission);
      assert.deepEqual(entity.subsidiaryScope, { column: "s.subsidiary_id" });
      assert.equal(entity.currencyColumn, "currency");
      // A lateral subquery pins its organization in its own WHERE clause.
      for (const join of entity.from
        .split("\n")
        .filter((line) => /\bJOIN\b/i.test(line) && !/\bLATERAL\b/i.test(line))) {
        assert.match(join, /org_id/i, `${key} join leaves the organization: ${join.trim()}`);
      }
      if (/\bLATERAL\b/i.test(entity.from))
        assert.match(entity.from, /WHERE pt\.org_id = s\.org_id AND pt\.session_id = s\.id/);
      for (const column of entity.columns.filter((c) => c.kind === "money")) {
        assert.equal(column.txnCurrency, true, `${key}.${column.key} is in the session currency`);
        assert.match(
          column.expr,
          /::numeric \/ 10000\)/,
          `${key}.${column.key} converts ledger units exactly`,
        );
      }
    }
  });

  it("compiles the Z history inside the caller legal entities and refuses an empty scope", () => {
    const definition = BUILT_IN_REPORT_DEFINITION_MAP["register-z-report-history"];
    assert.ok(definition);
    const query = validateCustomQuery(definition.query);
    const entity = REPORT_ENTITY_MAP.pos_sessions!;
    const compiled = compileCustomQuery(entity, query, ORG, { allowedSubsidiaryIds: [ENTITY] });
    assert.match(compiled.text, /WHERE s\.org_id = \$1/);
    assert.match(compiled.text, /s\.subsidiary_id = ANY\(\$2::uuid\[\]\)/);
    assert.deepEqual(compiled.values.slice(0, 2), [ORG, [ENTITY]]);
    assert.ok(compiled.values.includes("closed"), "the history lists closed sessions only");
    assert.match(
      compileCustomQuery(entity, query, ORG, { allowedSubsidiaryIds: [] }).text,
      /FALSE/,
    );
  });

  it("compiles sales by register and cashier over posted documents, with refunds netted", () => {
    const definition = BUILT_IN_REPORT_DEFINITION_MAP["register-sales-by-register-and-cashier"];
    assert.ok(definition);
    const query = validateCustomQuery(definition.query);
    const entity = REPORT_ENTITY_MAP.pos_transactions!;
    const compiled = compileCustomQuery(entity, query, ORG);
    assert.match(compiled.text, /WHERE pt\.org_id = \$1/);
    assert.ok(compiled.values.includes("posted"), "voided or draft documents never count as sales");
    const net = entity.columns.find((column) => column.key === "net_sales")!;
    assert.match(net.expr, /WHEN pt\.kind = 'refund' THEN -\(pt\.total_minor::numeric \/ 10000\)/);
  });
});
