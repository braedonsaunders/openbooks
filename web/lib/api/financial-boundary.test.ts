import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Financial-write API boundary contract.
 *
 * Every route below moves money or mutates a financial document. Each one
 * must parse its JSON body exclusively through the shared zod boundary
 * (`parseJsonBody` from web/lib/api/json.ts) so no handler ever sees an
 * unvalidated request shape. A bare `req.json()` cast in these files fails
 * this contract.
 */
const FINANCIAL_WRITE_ROUTES = [
  "web/app/api/journals/[id]/route.ts",
  "web/app/api/journals/actions/route.ts",
  "web/app/api/payments/[id]/route.ts",
  "web/app/api/payments/draft/route.ts",
  "web/app/api/payments/links/route.ts",
  "web/app/api/payments/post-with-applications/route.ts",
  "web/app/api/payments/runs/route.ts",
  "web/app/api/payments/runs/[id]/decision/route.ts",
  "web/app/api/payments/runs/[id]/deliver/route.ts",
  "web/app/api/payments/runs/[id]/rollback/route.ts",
  "web/app/api/payments/runs/[id]/files/[fileId]/decision/route.ts",
  "web/app/api/payments/runs/[id]/instructions/[instructionId]/settlement/route.ts",
  "web/app/api/receipts/runs/route.ts",
  "web/app/api/revenue/run-recognition/route.ts",
] as const;

test("every financial-write route parses its body through the shared zod boundary", () => {
  const failures: string[] = [];
  for (const file of FINANCIAL_WRITE_ROUTES) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      failures.push(`${file}: route missing (inventory out of date)`);
      continue;
    }
    if (!source.includes("parseJsonBody(")) {
      failures.push(`${file}: does not use parseJsonBody`);
    }
    if (source.includes("req.json()")) {
      failures.push(`${file}: reads req.json() outside the shared zod boundary`);
    }
  }
  assert.deepEqual(failures, []);
});
