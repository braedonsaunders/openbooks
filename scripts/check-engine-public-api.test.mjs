import assert from "node:assert/strict";
import test from "node:test";
import { contractViolations, exportViolations } from "./check-engine-public-api.mjs";

const exports = {
  "./documents": "./src/ledger/public.ts",
  "./testing/fixtures": "./src/testing/fixtures.ts",
};

test("every module-loading syntax refuses implementation paths without a budget", () => {
  const internal = "@openbooks/engine/src/ledger/document-service.ts";
  for (const source of [
    `import { loadDocument } from '${internal}'`,
    `export { loadDocument } from '${internal}'`,
    `const service = import('${internal}')`,
    `const service = import(\`${internal}\`)`,
    `const service = require('${internal}')`,
    `const service = require.resolve('${internal}')`,
    `const service = import.meta.resolve('${internal}')`,
    `import service = require('${internal}')`,
    `type Document = import('${internal}').Document`,
    "import { loadDocument } from '../../engine/src/ledger/document-service.ts'",
    "import { loadDocument } from '../../engine/src/ledger/public.ts'",
  ])
    assert.equal(contractViolations("web/lib/consumer.ts", source, exports).length, 1, source);
});

test("contracts must exist in the package exports; comments are not imports", () => {
  assert.deepEqual(
    contractViolations(
      "web/lib/consumer.ts",
      "import { loadDocument } from '@openbooks/engine/documents'",
      exports,
    ),
    [],
  );
  assert.deepEqual(
    contractViolations(
      "web/lib/consumer.ts",
      "// import '@openbooks/engine/src/ledger/document-service.ts'",
      exports,
    ),
    [],
  );
  assert.equal(
    contractViolations("scripts/worker.ts", "import '@openbooks/engine/not-exported'", exports)
      .length,
    1,
  );
  assert.equal(
    contractViolations(
      "packages/analytics/src/index.ts",
      "import '../../../engine/src/platform/db.ts'",
      exports,
    ).length,
    1,
  );
});

test("test consumers also use package contracts; test support cannot enter application code", () => {
  const source = "import '@openbooks/engine/testing/fixtures'";
  assert.deepEqual(contractViolations("web/lib/consumer.test.ts", source, exports), []);
  assert.deepEqual(contractViolations("web/testing/fixture.ts", source, exports), []);
  assert.equal(contractViolations("web/lib/consumer.ts", source, exports).length, 1);
  assert.equal(
    contractViolations(
      "web/lib/consumer.test.ts",
      "import '@openbooks/engine/src/testing/fixtures.ts'",
      exports,
    ).length,
    1,
  );
});

test("export patterns and disguised source paths cannot reopen the implementation tree", () => {
  for (const key of ["./src/*", "./src/platform/db.ts", "./platform/*"]) {
    assert.ok(exportViolations({ [key]: "./src/platform/db.ts" }).length);
  }
  assert.ok(exportViolations({ "./escape": "../web/lib/auth.ts" }).length);
  assert.ok(exportViolations({ "./missing": "./src/platform/nonexistent-contract.ts" }).length);
  assert.ok(exportViolations({ "./fixtures": "./src/testing/fixtures.ts" }).length);
  assert.deepEqual(exportViolations(exports), []);
});

test("computed source paths cannot bypass the contract boundary", () => {
  for (const source of [
    `const service = import(root + 'engine/src/platform/db.ts')`,
    `const service = import(new URL('../../engine/src/platform/db.ts', import.meta.url).href)`, // source-path: synthetic
    `const service = import('@openbooks/engine/' + moduleName)`,
  ])
    assert.match(
      contractViolations("web/lib/consumer.ts", source, exports).join(),
      /computed engine import/,
    );
});
