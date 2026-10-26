import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  assertHistoricalTranslationSource,
  assertHistoricalTranslationCorrectionParent,
  historicalTranslationEvidenceHash,
  readHistoricalTranslationInstruction,
  translateHistoricalTranslationLayers,
  sumHistoricalTranslationExactAmounts,
  type HistoricalTranslationSourceFingerprint,
  type AppliedHistoricalTranslationParent,
} from "./historical-translation-contract.ts";
import { divideDecimal } from "../money/exact-decimal.ts";
import { fromUnits, toUnits } from "../money/money.ts";

const source: HistoricalTranslationSourceFingerprint = {
  orgId: randomUUID(),
  lineId: randomUUID(),
  entryId: randomUUID(),
  bookId: randomUUID(),
  accountId: randomUUID(),
  subsidiaryId: randomUUID(),
  amount: "-200.0000",
  transactionCurrency: "USD",
  transactionAmount: "-200.0000",
  transactionRate: "1.0000000000",
  postingDate: "2026-08-31",
  origin: "opening",
  reversesEntryId: null,
};
const retained = { fileId: randomUUID(), versionId: randomUUID(), contentHash: "a".repeat(64) };
const layer = (amount: string, rate: string, historicalDate: string) => ({
  amount,
  rate,
  historicalDate,
  provenance: "Original dated shareholder contribution statement",
  source: retained,
  originalLayerId: null,
});
const opening = () => ({
  sourceLineId: source.lineId,
  measurementCurrency: "USD",
  presentationCurrency: "CAD",
  kind: "opening",
  layers: [layer("-100", "1.20", "2026-07-01"), layer("-100", "1.40", "2026-08-01")],
});

test("historical contributions preserve genuine signed rates rather than reprice a capital balance", () => {
  const instruction = readHistoricalTranslationInstruction(opening());
  assertHistoricalTranslationSource(instruction, source);
  assert.equal(translateHistoricalTranslationLayers(instruction.layers), "-260.00000000000000");
});
test("exact layer equality refuses incomplete or rounded opening amounts", () => {
  const instruction = readHistoricalTranslationInstruction({
    ...opening(),
    layers: [layer("-199.9999", "1.2", "2026-07-01")],
  });
  assert.throws(
    () => assertHistoricalTranslationSource(instruction, source),
    /sum to the physical source/,
  );
  assert.throws(
    () =>
      readHistoricalTranslationInstruction({
        ...opening(),
        layers: [layer("-200.00001", "1.2", "2026-07-01")],
      }),
    /four decimal places/,
  );
});
test("ordinary contributions do not conceal multiple opening layers", () => {
  assert.throws(
    () => readHistoricalTranslationInstruction({ ...opening(), kind: "contribution" }),
    /ordinary contribution/,
  );
  assert.throws(
    () =>
      assertHistoricalTranslationSource(readHistoricalTranslationInstruction(opening()), {
        ...source,
        origin: "manual",
      }),
    /native opening/,
  );
});
test("future dates and opposite signed layers cannot supply historical equity", () => {
  const future = readHistoricalTranslationInstruction({
    ...opening(),
    layers: [layer("-200", "1.2", "2026-09-01")],
  });
  assert.throws(() => assertHistoricalTranslationSource(future, source), /historical dates/);
  const mixed = readHistoricalTranslationInstruction({
    ...opening(),
    layers: [layer("-300", "1.2", "2026-07-01"), layer("100", "1.4", "2026-08-01")],
  });
  assert.throws(() => assertHistoricalTranslationSource(mixed, source), /share its sign/);
});
test("reversals require explicit original physical layer binding", () => {
  assert.throws(
    () =>
      assertHistoricalTranslationSource(readHistoricalTranslationInstruction(opening()), {
        ...source,
        reversesEntryId: randomUUID(),
      }),
    /explicitly bind/,
  );
  assert.throws(
    () => readHistoricalTranslationInstruction({ ...opening(), kind: "correction" }),
    /exact applied parent layer/,
  );
  const originalLayerId = randomUUID();
  assert.throws(
    () =>
      readHistoricalTranslationInstruction({
        ...opening(),
        kind: "correction",
        layers: opening().layers.map((layer) => ({ ...layer, originalLayerId })),
      }),
    /once/,
  );
});
test("rates and amounts reject numeric coercion, exponent input and separators", () => {
  for (const amount of [200, "-2e2", "-200,00", null])
    assert.throws(
      () =>
        readHistoricalTranslationInstruction({
          ...opening(),
          layers: [{ ...opening().layers[0], amount }],
        }),
      /exact signed layer amounts/,
    );
  for (const rate of [1.2, "0", "-1.2", "1.20000000001", "1,2", "1000000000"])
    assert.throws(
      () =>
        readHistoricalTranslationInstruction({
          ...opening(),
          layers: [{ ...opening().layers[0], rate }],
        }),
      /genuine positive historical rate/,
    );
});
test("documented same-currency identity requires an exact unit rate", () => {
  const input = {
    ...opening(),
    presentationCurrency: "USD",
    layers: [layer("-200", "1", "2026-07-01")],
  };
  const instruction = readHistoricalTranslationInstruction(input);
  assertHistoricalTranslationSource(instruction, source);
  assert.equal(translateHistoricalTranslationLayers(instruction.layers), "-200.00000000000000");
  assert.throws(
    () =>
      readHistoricalTranslationInstruction({
        ...input,
        layers: [layer("-200", "1.2", "2026-07-01")],
      }),
    /identity rate/,
  );
});
test("no empty composition or unspecified source version becomes a zero basis", () => {
  assert.throws(() => translateHistoricalTranslationLayers([]), /No approved/);
  assert.throws(
    () => readHistoricalTranslationInstruction({ ...opening(), layers: [] }),
    /exact historical layers/,
  );
  assert.throws(
    () =>
      readHistoricalTranslationInstruction({
        ...opening(),
        layers: [{ ...opening().layers[0], source: { fileId: retained.fileId } }],
      }),
    /retained source/,
  );
});
test("raw layer products retain every decimal until the report boundary", () => {
  assert.equal(
    translateHistoricalTranslationLayers([{ amount: "-0.0001", rate: "0.5" }]),
    "-0.00005000000000",
  );
  assert.equal(
    translateHistoricalTranslationLayers([{ amount: "0.0001", rate: "0.5" }]),
    "0.00005000000000",
  );
});
test("evidence hashes survive JSON storage and bind every rate, currency, date and physical identity", () => {
  const evidence = {
    instruction: readHistoricalTranslationInstruction(opening()),
    sourceFingerprint: source,
    retainedSources: opening().layers.map(() => ({ ...retained, versionNumber: 1 })),
    translatedAmounts: ["-120.00000000000000", "-140.00000000000000"],
    originalLayerStates: [],
  };
  assert.equal(
    historicalTranslationEvidenceHash(evidence),
    historicalTranslationEvidenceHash(JSON.parse(JSON.stringify(evidence))),
  );
  for (const key of ["bookId", "accountId", "subsidiaryId", "lineId", "entryId"] as const)
    assert.notEqual(
      historicalTranslationEvidenceHash(evidence),
      historicalTranslationEvidenceHash({
        ...evidence,
        sourceFingerprint: { ...source, [key]: randomUUID() },
      }),
    );
  assert.notEqual(
    historicalTranslationEvidenceHash(evidence),
    historicalTranslationEvidenceHash({
      ...evidence,
      instruction: {
        ...evidence.instruction,
        layers: [
          { ...evidence.instruction.layers[0]!, rate: "1.2100000000" },
          evidence.instruction.layers[1]!,
        ],
      },
    }),
  );
});

test("tiny split corrections exhaust the unrounded original product exactly", () => {
  const original = translateHistoricalTranslationLayers([{ amount: "-0.0002", rate: "0.5" }]);
  const partial = translateHistoricalTranslationLayers([{ amount: "0.0001", rate: "0.5" }]);
  assert.equal(
    sumHistoricalTranslationExactAmounts([original, partial, partial]),
    "0.00000000000000",
  );
});
test("small independent contributions aggregate before rounding at the report boundary", () => {
  const exact = translateHistoricalTranslationLayers([
    { amount: "0.0001", rate: "0.4" },
    { amount: "0.0001", rate: "0.4" },
  ]);
  assert.equal(exact, "0.00008000000000");
  assert.equal(divideDecimal(exact, "1", 4), "0.0001");
});

function appliedParent(
  amount: string,
  rate: string,
  kind: AppliedHistoricalTranslationParent["kind"],
): AppliedHistoricalTranslationParent {
  return {
    id: randomUUID(),
    amount,
    rate,
    historicalDate: "2026-07-01",
    provenance: "Original dated shareholder contribution statement",
    sourceFileId: retained.fileId,
    sourceVersionId: retained.versionId,
    sourceHash: retained.contentHash,
    sourceVersionNumber: 1,
    bookId: source.bookId,
    accountId: source.accountId,
    subsidiaryId: source.subsidiaryId,
    measurementCurrency: "USD",
    presentationCurrency: "CAD",
    entryId: randomUUID(),
    postingDate: "2026-07-01",
    kind,
    consumed: "0.0000",
  };
}
function correctionOf(parent: AppliedHistoricalTranslationParent, amount: string) {
  const physical = {
    ...source,
    lineId: randomUUID(),
    entryId: randomUUID(),
    amount,
    origin: "manual",
    reversesEntryId: parent.entryId,
  };
  const instruction = readHistoricalTranslationInstruction({
    sourceLineId: physical.lineId,
    measurementCurrency: parent.measurementCurrency,
    presentationCurrency: parent.presentationCurrency,
    kind: "correction",
    layers: [
      {
        amount,
        rate: parent.rate,
        historicalDate: parent.historicalDate,
        provenance: parent.provenance,
        originalLayerId: parent.id,
        source: {
          fileId: parent.sourceFileId,
          versionId: parent.sourceVersionId,
          contentHash: parent.sourceHash,
        },
      },
    ],
  });
  return { physical, instruction, correction: instruction.layers[0]! };
}

test("signed correction chains preserve exact products and never reclaim ancestor capacity", () => {
  for (const magnitude of [1n, 2n, 7n, 10000n, 123456789n])
    for (const rate of ["0.0000000001", "0.5000000000", "1.2000000000", "9.1234567890"])
      for (const initialSign of [-1n, 1n])
        for (const kind of ["contribution", "opening", "correction"] as const) {
          let parent = appliedParent(fromUnits(initialSign * magnitude), rate, kind);
          const originalProduct = translateHistoricalTranslationLayers([parent]);
          const products = [originalProduct];
          const exhaustedAncestors: AppliedHistoricalTranslationParent[] = [];
          for (let depth = 1; depth <= 8; depth++) {
            const amount = fromUnits(-toUnits(parent.amount));
            const { physical, instruction, correction } = correctionOf(parent, amount);
            const preserved = structuredClone(parent);
            assertHistoricalTranslationSource(instruction, physical);
            assertHistoricalTranslationCorrectionParent(
              instruction,
              physical,
              correction,
              1,
              parent,
            );
            assert.deepEqual(parent, preserved);
            products.push(translateHistoricalTranslationLayers(instruction.layers));
            assert.equal(
              sumHistoricalTranslationExactAmounts(products),
              depth % 2 ? "0.00000000000000" : originalProduct,
            );
            exhaustedAncestors.push({ ...parent, consumed: fromUnits(magnitude) });
            for (const ancestor of exhaustedAncestors) {
              const attempt = correctionOf(
                ancestor,
                fromUnits(toUnits(ancestor.amount) > 0n ? -1n : 1n),
              );
              assert.throws(
                () =>
                  assertHistoricalTranslationCorrectionParent(
                    attempt.instruction,
                    attempt.physical,
                    attempt.correction,
                    1,
                    ancestor,
                  ),
                /remaining applied parent layer/,
              );
            }
            parent = {
              ...parent,
              id: randomUUID(),
              entryId: physical.entryId,
              postingDate: physical.postingDate,
              amount,
              kind: "correction",
              consumed: "0.0000",
            };
          }
        }
});

test("partial opposite-signed allocations accept the exact remaining capacity and refuse one additional unit", () => {
  for (const magnitude of [2n, 3n, 19n, 1000000n])
    for (const sign of [-1n, 1n]) {
      const consumed = magnitude / 2n;
      const parent = {
        ...appliedParent(fromUnits(sign * magnitude), "1.2345678901", "correction"),
        consumed: fromUnits(consumed),
      };
      const remaining = magnitude - consumed;
      const exact = correctionOf(parent, fromUnits(-sign * remaining));
      assertHistoricalTranslationCorrectionParent(
        exact.instruction,
        exact.physical,
        exact.correction,
        1,
        parent,
      );
      const excess = correctionOf(parent, fromUnits(-sign * (remaining + 1n)));
      assert.throws(
        () =>
          assertHistoricalTranslationCorrectionParent(
            excess.instruction,
            excess.physical,
            excess.correction,
            1,
            parent,
          ),
        /remaining applied parent layer/,
      );
    }
});

test("correction parents retain every physical scope and protected evidence identity", () => {
  const parent = appliedParent("100.0000", "1.2000000000", "correction");
  const { physical, instruction, correction } = correctionOf(parent, "-100.0000");
  const substitutions: Partial<AppliedHistoricalTranslationParent>[] = [
    { id: randomUUID() },
    { bookId: randomUUID() },
    { accountId: randomUUID() },
    { subsidiaryId: randomUUID() },
    { measurementCurrency: "EUR" },
    { presentationCurrency: "GBP" },
    { rate: "1.4000000000" },
    { historicalDate: "2026-07-02" },
    { provenance: "A different documentary statement" },
    { sourceFileId: randomUUID() },
    { sourceVersionId: randomUUID() },
    { sourceHash: "b".repeat(64) },
    { sourceVersionNumber: 2 },
    { entryId: randomUUID() },
    { postingDate: "2026-09-01" },
    { amount: "-100.0000" },
  ];
  for (const substitute of substitutions)
    assert.throws(
      () =>
        assertHistoricalTranslationCorrectionParent(instruction, physical, correction, 1, {
          ...parent,
          ...substitute,
        }),
      /applied parent layer/,
    );
  assert.throws(
    () =>
      assertHistoricalTranslationCorrectionParent(instruction, physical, correction, 1, undefined),
    /applied parent layer/,
  );
  assertHistoricalTranslationCorrectionParent(
    instruction,
    { ...physical, reversesEntryId: null },
    correction,
    1,
    parent,
  );
});
