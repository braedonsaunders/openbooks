import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { DOC_KINDS } from "../document-kinds.ts";

// distributionKey on transaction import/export rows. A line may
// stage one entry-rule key: the adapter resolves it against entry-mode rules
// in effect on the document date and stores the rule reference on the line.
// Explosion itself stays in the save path (gated there); the adapter never
// explodes. Unknown / wrong-mode / inactive keys fail the row closed, and the
// key round-trips through the line export.

const stateKey = Symbol.for("openbooks.transaction-distribution-test");

interface CapturedLine {
  accountId: string;
  amount: string;
  description: string | null;
  taxCodeId: string | null;
  distributionRuleId: string | null;
}

interface DistributionState {
  documents: Record<string, unknown>[];
  lines: CapturedLine[];
  ruleLookups: { key: string; asOf: string | undefined }[];
  docRows: Record<string, unknown>[];
  lineRows: Record<string, unknown>[];
}

const distState: DistributionState = {
  documents: [],
  lines: [],
  ruleLookups: [],
  docRows: [],
  lineRows: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = distState;

const mockSources = new Map<string, string>([
  [
    "mock:drizzle",
    `export { and, asc, desc, eq, inArray, isNull, or } from '${import.meta.resolve("drizzle-orm")}'
     export function sql(strings, ...values) { return { strings, values } }`,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.transaction-distribution-test')]
      const documents = Symbol.for('dist.documents')
      const documentLines = Symbol.for('dist.document-lines')
      export const schema = { documents, documentLines }
      function textOf(query) {
        return Array.isArray(query?.strings) ? query.strings.join(' ') : String(query?.strings ?? query ?? '')
      }
      async function execute(query, mode) {
        const inMode = (result) => (mode === 'objects' ? result.rows : result)
        const text = textOf(query)
        if (text.includes('base_currency')) return inMode({ rows: [{ base_currency: 'CAD' }] })
        if (text.includes('update document_lines')) {
          // The staged rule reference: values are [ruleId, orgId, documentId, lineNumber].
          const [ruleId, , , lineNumber] = query.values
          const line = state.lines.find((candidate) => candidate.lineNumber === lineNumber)
          if (line) line.distributionRuleId = ruleId
          return inMode({ rows: [] })
        }
        if (text.includes('from subsidiaries')) return inMode({ rows: [] })
        if (text.includes('from documents where')) return inMode({ rows: [] })
        if (text.includes('from documents d')) return inMode({ rows: state.docRows })
        if (text.includes('from document_lines l')) return inMode({ rows: state.lineRows })
        return inMode({ rows: [] })
      }
      function insertInto(target) {
        return {
          values(values) {
            const list = Array.isArray(values) ? values : [values]
            if (target === documents) {
              return { async returning() { state.documents.push(...list); return [{ id: 'document-1' }] } }
            }
            return (async () => { state.lines.push(...list) })()
          },
        }
      }
      export const db = {
        execute,
        insert(target) { return insertInto(target) },
        async transaction(callback) {
          return callback({ execute, insert(target) { return insertInto(target) } })
        },
      }
    `,
  ],
  [
    "mock:posting",
    `export async function postDocument() { throw new Error('postDocument is not expected here') }`,
  ],
  [
    "mock:documents",
    `export async function controlDeps() { throw new Error('controlDeps is not expected here') }
     export async function nextDocumentNumber() { return 'IMP-000001' }
     export async function loadDocumentEditCurrent() {
       return { kind: 'card_charge', status: 'draft', total: '0', taxTotal: '0', partyId: null,
         documentDate: '2026-09-01', updatedAt: 'revision-1', custom: {}, subsidiaryId: null }
     }`,
  ],
  [
    "mock:write",
    `// The native edit core writes the lines through the caller's transaction.
     const documentLines = Symbol.for('dist.document-lines')
     export async function precomputeDocumentTotalsForCreate() { return null }
     export async function applyDocumentEdit(id, current, body, ctx, scope) {
       const lines = (body.lines ?? []).map((line, index) => ({
         orgId: ctx.orgId, documentId: id, lineNumber: index + 1, accountId: line.accountId,
         description: line.description, amount: line.amount, taxCodeId: line.taxCodeId, createdBy: ctx.userId,
       }))
       await scope.tx.insert(documentLines).values(lines)
     }`,
  ],
  [
    "mock:resource-core",
    `// The pure cap/gate re-export the REAL ./export-cap.ts through this
     // double — never copied. Only impure surfaces are stubbed below.
     export * from '${new URL("./export-cap.ts", import.meta.url).href}'
     export { MAX_EXPORT_ROWS, enforceExportRowLimit } from '${new URL("./export-cap.ts", import.meta.url).href}'
     export { duplicateImportRowIndexes, importRowAction } from '${new URL("./resource-core.ts", import.meta.url).href}'
     export { subsidiaryReadFilter, subsidiaryReadFilterWithUnassigned } from '${new URL("./subsidiary-scope.ts", import.meta.url).href}'
     export async function orgFeatureEnabled() { return false }
     export class RefResolver {
       async resolveId(target, human) {
         if (target.resource === 'accounts' && String(human) === '5000') return 'account-1'
         if (target.resource === 'tax-codes' && String(human) === 'TAX') return 'tax-1'
         return null
       }
     }`,
  ],
  [
    "mock:entry",
    `export async function loadEntryRuleByKey(orgId, key, asOf) {
       const state = globalThis[Symbol.for('openbooks.transaction-distribution-test')]
       state.ruleLookups.push({ key, asOf })
       if (key === 'overhead-split') {
         return { status: 'ok', rule: { rule: { id: 'rule-1', key, name: 'Overhead split' } } }
       }
       if (key === 'retired-split') return { status: 'inactive' }
       if (key === 'period-sweep') return { status: 'wrong_mode', mode: 'period' }
       return { status: 'not_found' }
     }`,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mockUrl = new Map([
      ["drizzle-orm", "mock:drizzle"],
      ["@openbooks/engine/platform/db", "mock:db"],
      ["@openbooks/engine/ledger/posting-document", "mock:posting"],
      ["@openbooks/engine/allocations/entry", "mock:entry"],
      ["@openbooks/engine/documents/write", "mock:write"],
      ["@openbooks/engine/ledger/document-service", "mock:documents"],
      ["../../../engine/src/ledger/document-service.ts", "mock:documents"],
      ["../bills.ts", "mock:documents"],
      ["./resource-core", "mock:resource-core"],
    ]).get(specifier);
    if (mockUrl) return { url: mockUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const resourceUrl = "./transaction-resources.ts?distribution-test";
const { transactionResource } = (await import(
  resourceUrl
)) as typeof import("./transaction-resources.ts");
hooks.deregister();

function reset(): void {
  distState.documents.length = 0;
  distState.lines.length = 0;
  distState.ruleLookups.length = 0;
  distState.docRows.length = 0;
  distState.lineRows.length = 0;
}

function write(rows: Record<string, unknown>[]) {
  const cfg = DOC_KINDS.card_charge;
  assert.ok(cfg);
  return transactionResource(cfg, "org-1").write(rows, "insert", {
    orgId: "org-1",
    actorId: "actor-1",
    dryRun: false,
  });
}

test("a nested line distributionKey stages the entry rule reference on the line", async () => {
  reset();
  const outcome = await write([
    {
      documentDate: "2026-09-01",
      lines: JSON.stringify([
        { account: "5000", amount: "100.00", distributionKey: "overhead-split" },
      ]),
    },
  ]);
  assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] });
  assert.equal(distState.lines.length, 1);
  assert.equal(distState.lines[0]!.distributionRuleId, "rule-1");
  assert.deepEqual(distState.ruleLookups, [{ key: "overhead-split", asOf: "2026-09-01" }]);
});

test("the flat single-line columns accept distributionKey too", async () => {
  reset();
  const outcome = await write([
    {
      documentDate: "2026-09-01",
      account: "5000",
      amount: "50.00",
      distributionKey: "overhead-split",
    },
  ]);
  assert.equal(outcome.created, 1);
  assert.equal(distState.lines[0]!.distributionRuleId, "rule-1");
});

test("lines without a key never touch the rule lookup", async () => {
  reset();
  const outcome = await write([
    { documentDate: "2026-09-01", account: "5000", amount: "50.00", distributionKey: "" },
  ]);
  assert.equal(outcome.created, 1);
  assert.equal("distributionRuleId" in distState.lines[0]!, false);
  assert.equal(distState.ruleLookups.length, 0);
});

test("unknown, inactive, and wrong-mode keys fail the row closed with a named error", async () => {
  for (const [key, message] of [
    ["no-such-rule", 'distribution key "no-such-rule" not found'],
    ["retired-split", 'distribution key "retired-split" is not in effect on 2026-09-01'],
    ["period-sweep", 'distribution key "period-sweep" is not an entry rule'],
  ] as const) {
    reset();
    const outcome = await write([
      {
        documentDate: "2026-09-01",
        lines: JSON.stringify([{ account: "5000", amount: "10.00", distributionKey: key }]),
      },
    ]);
    assert.equal(outcome.created, 0, key);
    assert.equal(outcome.failed, 1, key);
    assert.equal(outcome.errors[0]!.message, message, key);
    assert.equal(distState.documents.length, 0, `no draft may persist for ${key}`);
  }
});

test("the line export carries distributionKey from the staged rule reference", async () => {
  reset();
  distState.docRows.push({
    id: "document-1",
    document_number: "IMP-000001",
    document_date: "2026-09-01",
    due_date: null,
    currency: "CAD",
    memo: null,
    reference_number: null,
    status: "draft",
    party: null,
    subsidiary: null,
  });
  distState.lineRows.push({
    amount: "100.0000",
    description: null,
    account: "5000",
    tax_code: null,
    distribution_key: "overhead-split",
  });
  const cfg = DOC_KINDS.card_charge;
  assert.ok(cfg);
  const exported = await transactionResource(cfg, "org-1").read();
  assert.equal(exported.rows.length, 1);
  const lines = JSON.parse(String(exported.rows[0]!["lines"])) as {
    distributionKey: string | null;
  }[];
  assert.deepEqual(
    lines.map((l) => l.distributionKey),
    ["overhead-split"],
  );
  const fieldKeys = exported.fields.map((f) => f.key);
  assert.ok(fieldKeys.includes("distributionKey"), "the mapping wizard must offer distributionKey");
});
