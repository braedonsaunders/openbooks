import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}

test("every project commercial query follows canonical dimension inheritance", () => {
  for (const file of [
    "engine/src/project-financials.ts",
    "web/lib/project-costing.ts",
    "web/lib/billing.ts",
  ]) {
    const contents = source(file);
    assert.match(
      contents,
      /coalesce\(dl\.project_id, d\.project_id\)/,
      `${file} does not inherit the document project`,
    );
  }

  // The not-to-exceed cap has ONE definition of claimed contract capacity,
  // shared by billing-request invoicing and WIP prebilling; it must inherit
  // the document project like every other commercial query.
  const billing = source("web/lib/billing.ts");
  assert.match(billing, /projectContractCapacityUsed\(/);
  assert.doesNotMatch(
    billing,
    /sum\(subtotal\)[\s\S]*project_id = \$\{req\.project_id\}/,
  );
  const wip = source("web/lib/wip-billing.ts");
  assert.match(
    wip,
    /export async function projectContractCapacityUsed[\s\S]*sum\(case when document\.kind[\s\S]*coalesce\(line\.project_id, document\.project_id\) = \$\{projectId\}/,
  );

  const certificate = source(
    "engine/src/validation/project-parity-certificate.ts",
  );
  assert.match(
    certificate,
    /project\.id = coalesce\(dl\.project_id, d\.project_id\)/,
  );
});
