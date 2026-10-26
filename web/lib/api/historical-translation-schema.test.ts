import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  historicalTranslationProposalBody,
  historicalTranslationSourceParams,
} from "./historical-translation-schema.ts";

function request() {
  return {
    instruction: {
      sourceLineId: randomUUID(),
      measurementCurrency: "USD",
      presentationCurrency: "CAD",
      kind: "contribution",
      layers: [
        {
          amount: "-123.4567",
          rate: "1.2345678901",
          historicalDate: "2024-02-29",
          provenance: "Original shareholder contribution statement",
          source: { fileId: randomUUID(), versionId: randomUUID(), contentHash: "a".repeat(64) },
          originalLayerId: null,
        },
      ],
    },
    reason: "Document the original shareholder contribution",
    idempotencyKey: randomUUID(),
  };
}

test("historical assessment boundary preserves exact signed money, rate and physical source identity", () => {
  const body = request();
  const parsed = historicalTranslationProposalBody.parse(body);
  assert.equal(parsed.instruction.sourceLineId, body.instruction.sourceLineId);
  assert.equal(parsed.instruction.layers[0]!.amount, "-123.4567");
  assert.equal(parsed.instruction.layers[0]!.rate, "1.2345678901");
  assert.deepEqual(parsed.instruction.layers[0]!.source, body.instruction.layers[0]!.source);
});

test("historical assessment boundary refuses JSON financial numbers and separator coercion", () => {
  for (const amount of [123.4567, "-123,4567", "-123 4567"]) {
    const body = request();
    assert.equal(
      historicalTranslationProposalBody.safeParse({
        ...body,
        instruction: { ...body.instruction, layers: [{ ...body.instruction.layers[0], amount }] },
      }).success,
      false,
    );
  }
  for (const rate of [1.2345678901, "0", "-1", "1.23456789012", "1,23"]) {
    const body = request();
    assert.equal(
      historicalTranslationProposalBody.safeParse({
        ...body,
        instruction: { ...body.instruction, layers: [{ ...body.instruction.layers[0], rate }] },
      }).success,
      false,
    );
  }
});

test("historical assessment boundary requires a real calendar date and complete retained version identity", () => {
  const body = request();
  const layer = body.instruction.layers[0]!;
  for (const historicalDate of ["2025-02-29", "2024-02-30", "2024-13-01"]) {
    assert.equal(
      historicalTranslationProposalBody.safeParse({
        ...body,
        instruction: { ...body.instruction, layers: [{ ...layer, historicalDate }] },
      }).success,
      false,
    );
  }
  for (const source of [
    { fileId: layer.source.fileId },
    { ...layer.source, versionId: "latest" },
    { ...layer.source, contentHash: "" },
  ]) {
    assert.equal(
      historicalTranslationProposalBody.safeParse({
        ...body,
        instruction: { ...body.instruction, layers: [{ ...layer, source }] },
      }).success,
      false,
    );
  }
  assert.equal(historicalTranslationSourceParams.safeParse({ sourceLineId: "1" }).success, false);
});

test("historical assessment boundary refuses supplied approvals and records original correction identity", () => {
  const body = request();
  assert.equal(
    historicalTranslationProposalBody.safeParse({ ...body, approvedBy: randomUUID() }).success,
    false,
  );
  assert.equal(
    historicalTranslationProposalBody.safeParse({
      ...body,
      instruction: { ...body.instruction, sourceEntryId: randomUUID() },
    }).success,
    false,
  );
  const originalLayerId = randomUUID();
  const parsed = historicalTranslationProposalBody.parse({
    ...body,
    instruction: {
      ...body.instruction,
      kind: "correction",
      layers: [{ ...body.instruction.layers[0], originalLayerId }],
    },
  });
  assert.equal(parsed.instruction.layers[0]!.originalLayerId, originalLayerId);
});
