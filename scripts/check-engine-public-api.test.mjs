import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetViolations } from './check-engine-public-api.mjs';

test('implementation imports require an existing exact consumer budget in every supported syntax', () => {
  const file = 'web/lib/consumer.ts';
  const internal = '@openbooks/engine/src/ledger/document-service.ts';
  for (const source of [
    `import { loadDocument } from '${internal}'`,
    `export { loadDocument } from '${internal}'`,
    `const service = import('${internal}')`,
    `const service = require('${internal}')`,
    `type Document = import('${internal}').Document`,
    "import { loadDocument } from '../../engine/src/ledger/document-service.ts'",
  ]) {
    assert.match(budgetViolations(file, source, {}).join(), /consumer.ts: engine\/src\/ledger\/document-service.ts/);
    const budget = { [file]: { 'engine/src/ledger/document-service.ts': 1 } };
    assert.deepEqual(budgetViolations(file, source, budget), []);
    assert.equal(budgetViolations(file, `${source};\n${source}`, budget).length, 1);
  }
  assert.deepEqual(budgetViolations(file, "import { loadDocument } from '@openbooks/engine/documents'", {}), []);
  assert.deepEqual(budgetViolations(file, `// import '${internal}'`, {}), []);
});
