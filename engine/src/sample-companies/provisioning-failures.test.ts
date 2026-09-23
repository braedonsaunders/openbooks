import assert from "node:assert/strict";
import test from "node:test";
import {
  SAMPLE_COMPANY_STAGE_CODES,
  SampleCompanyError,
  SampleCompanyProvisioningError,
  runProvisioningStage,
  sampleCompanyStageMessage,
  type SampleCompanyProvisioningStage,
} from "./provisioning-failures.ts";

// OM-14: a failed provisioning step must come back as a named stage refusal
// whose body carries no SQL or internal detail — the full cause stays in the
// server logs and on `cause`, never in the message the API returns.

const STAGES: SampleCompanyProvisioningStage[] = [
  "template",
  "clone",
  "finalize",
  "numbering",
];

const SQL_LADEN_DB_ERROR = new Error(
  "duplicate key value violates unique constraint \"journal_entries_org_id_doc_no_key\" " +
    "DETAIL: Key (org_id, doc_no)=(abc, INV-0001) already exists. " +
    "STATEMENT: INSERT INTO journal_entries (org_id, doc_no) SELECT $1, $2",
);

test("every stage has a stable code and an operator-facing retry message", () => {
  assert.deepEqual(SAMPLE_COMPANY_STAGE_CODES, {
    template: "sample-company-template-failed",
    clone: "sample-company-clone-failed",
    finalize: "sample-company-finalize-failed",
    numbering: "sample-company-numbering-failed",
  });
  for (const stage of STAGES) {
    const message = sampleCompanyStageMessage(stage);
    assert.match(message, /^Sample company could not be created: /);
    assert.match(message, /Nothing was created; you can retry\./);
  }
  assert.match(sampleCompanyStageMessage("clone"), /copying the template's posted history failed/);
});

test("runProvisioningStage passes successful results through untouched", async () => {
  const result = await runProvisioningStage("clone", async () => ({ orgId: "org-1" }));
  assert.deepEqual(result, { orgId: "org-1" });
});

test("a clone-stage database failure becomes the named clone refusal without SQL text", async () => {
  await assert.rejects(
    runProvisioningStage("clone", async () => {
      throw SQL_LADEN_DB_ERROR;
    }),
    (error: unknown) => {
      assert.ok(error instanceof SampleCompanyProvisioningError);
      assert.ok(error instanceof SampleCompanyError);
      assert.equal(error.stage, "clone");
      assert.equal(error.code, "sample-company-clone-failed");
      assert.equal(error.message, sampleCompanyStageMessage("clone"));
      for (const leak of [
        "duplicate key",
        "unique constraint",
        "journal_entries",
        "INSERT",
        "SELECT",
        "STATEMENT",
        "DETAIL",
      ]) {
        assert.doesNotMatch(
          error.message,
          new RegExp(leak.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
          `the refusal message must not leak ${JSON.stringify(leak)}`,
        );
      }
      assert.equal(
        (error as { cause?: unknown }).cause,
        SQL_LADEN_DB_ERROR,
        "the full cause must stay available server-side",
      );
      return true;
    },
  );
});

test("an already-staged refusal is never relabelled by an outer stage", async () => {
  const inner = new SampleCompanyProvisioningError("numbering", {
    cause: new Error("connection terminated"),
  });
  await assert.rejects(
    runProvisioningStage("finalize", async () => {
      throw inner;
    }),
    (error: unknown) => {
      assert.equal(error, inner);
      assert.equal(
        (error as SampleCompanyProvisioningError).code,
        "sample-company-numbering-failed",
      );
      return true;
    },
  );
});

test("a known validation refusal raised inside a stage is still reported by stage", async () => {
  await assert.rejects(
    runProvisioningStage("template", async () => {
      throw new SampleCompanyError(
        "sample template sim-atlas did not pass its simulator oracle",
      );
    }),
    (error: unknown) => {
      assert.ok(error instanceof SampleCompanyProvisioningError);
      assert.equal(
        (error as SampleCompanyProvisioningError).code,
        "sample-company-template-failed",
      );
      assert.doesNotMatch(
        (error as Error).message,
        /simulator oracle/,
        "internal detail stays in the cause, not the refusal",
      );
      return true;
    },
  );
});
