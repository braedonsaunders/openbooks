import assert from "node:assert/strict";
import test from "node:test";
import {
  statementBatchEmailScope,
  statementBatchJobId,
  type StatementBatchJobData,
} from "./statement-batch";

const RUN = "018f6b2a-7c1d-7d3e-9f4a-2b8c4d5e6f70";
const OTHER_RUN = "018f6b2a-0000-7000-8000-000000000001";
const PARTY = "118f6b2a-7c1d-7d3e-9f4a-2b8c4d5e6f70";
const OTHER_PARTY = "118f6b2a-0000-7000-8000-000000000002";

test("job ids are deterministic per (run, customer) and distinct otherwise", () => {
  const first = statementBatchJobId({ runId: RUN, partyId: PARTY });
  assert.equal(first, statementBatchJobId({ runId: RUN, partyId: PARTY }));
  assert.notEqual(first, statementBatchJobId({ runId: RUN, partyId: OTHER_PARTY }));
  assert.notEqual(first, statementBatchJobId({ runId: OTHER_RUN, partyId: PARTY }));

  const job: StatementBatchJobData = { orgId: RUN, runId: RUN, partyId: PARTY, senderId: "user-1" };
  assert.equal(statementBatchJobId(job), first);
});

test("job ids refuse non-uuid scope so a retry can never misaddress", () => {
  assert.throws(() => statementBatchJobId({ runId: "not-a-run", partyId: PARTY }), /valid run id/);
  assert.throws(
    () => statementBatchJobId({ runId: RUN, partyId: "not-a-party" }),
    /valid customer id/,
  );
  assert.throws(() => statementBatchEmailScope("not-a-run"), /valid run id/);
});

test("email scopes are stable per run so retries share one delivery row", () => {
  assert.equal(statementBatchEmailScope(RUN), statementBatchEmailScope(RUN));
  assert.notEqual(statementBatchEmailScope(RUN), statementBatchEmailScope(OTHER_RUN));
});
