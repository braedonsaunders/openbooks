import { test } from "node:test";
import assert from "node:assert/strict";
import { toUnits } from "../../money/money.ts";
import { computeTransactionIncentive, type IncentiveTransactionFact, type TransactionIncentivePolicy, type TransactionIncentiveGroup } from "./transaction-incentive-math.ts";

const policy: TransactionIncentivePolicy = { currency: "CAD", minorUnits: 2, periodFrom: "2026-01-01", periodTo: "2026-01-31", valuation: "percent_of_amount", rate: "7.5", recipientShares: [{ key: "lead", weight: "3" }, { key: "support", weight: "1" }] };
const fact = (sourceId: string, amount: string, lead = "employee-a"): IncentiveTransactionFact => ({ sourceId, groupId: "project-a", occurredOn: "2026-01-15", currency: "CAD", amount, quantity: "2", recipients: [{ shareKey: "lead", employmentId: lead }, { shareKey: "support", employmentId: "employee-b" }] });
const unlimited: TransactionIncentiveGroup[] = [{ groupId: "project-a", limit: { kind: "none" } }];

test("transaction incentives use configured rates and shares with deterministic payable residuals", () => {
  const facts = [fact("line-b", "20.03", "employee-c"), fact("line-a", "10.01")];
  const result = computeTransactionIncentive(policy, facts, unlimited);
  assert.equal(result.totalAwarded, "2.2500");
  assert.deepEqual(result.recipients, [{ employmentId: "employee-a", value: "0.5600" }, { employmentId: "employee-b", value: "0.5600" }, { employmentId: "employee-c", value: "1.1300" }]);
  assert.deepEqual(computeTransactionIncentive(policy, [...facts].reverse(), unlimited), result);
  assert.equal(result.groups[0]!.measuredValue, "30.0400");
  assert.deepEqual(result.groups[0]!.sourceIds, ["line-a", "line-b"]);
  assert.equal(result.recipients.reduce((sum, row) => sum + toUnits(row.value), 0n), toUnits(result.totalAwarded));
});

test("cumulative limits use recorded consumption and floor percentage ceilings to the payable quantum", () => {
  const limit = { groupId: "project-a", limit: { kind: "percent_of_base" as const, base: "10.07", rate: "7.5", previouslyAwarded: "0.50" } };
  const result = computeTransactionIncentive(policy, [fact("line-a", "100")], [limit]);
  assert.equal(result.totalAwarded, "0.2500");
  assert.equal(result.groups[0]!.potentialAward, "7.5000");
  assert.equal(result.groups[0]!.availableLimit, "0.2500");
  assert.equal(computeTransactionIncentive(policy, [fact("line-a", "100")], [{ ...limit, limit: { ...limit.limit, previouslyAwarded: "1" } }]).totalAwarded, "0.0000");
  assert.equal(computeTransactionIncentive(policy, [fact("line-a", "100")], [{ groupId: "project-a", limit: { kind: "amount", amount: "2", previouslyAwarded: "1.25" } }]).totalAwarded, "0.7500");
});

test("quantity valuation and recipient positions are independent of item names and employer titles", () => {
  const configured = { ...policy, valuation: "amount_per_unit" as const, rate: "1.25", minorUnits: 3, recipientShares: [{ key: "account-owner", weight: "1" }] };
  const result = computeTransactionIncentive(configured, [{ ...fact("line-a", "999"), quantity: "2.002", recipients: [{ shareKey: "account-owner", employmentId: "employee-z" }] }], unlimited);
  assert.equal(result.totalAwarded, "2.5030");
  assert.deepEqual(result.recipients, [{ employmentId: "employee-z", value: "2.5030" }]);
  const precise = computeTransactionIncentive({ ...configured, minorUnits: 4 }, [{ ...fact("line-precise", "999"), quantity: "2.00200001", recipients: [{ shareKey: "account-owner", employmentId: "employee-z" }] }], unlimited);
  assert.equal(precise.groups[0]!.measuredValue, "2.00200001");
  assert.equal(precise.totalAwarded, "2.5025");
  const zero = computeTransactionIncentive(policy, [{ ...fact("line-zero", "0"), recipients: [] }], unlimited);
  assert.equal(zero.totalAwarded, "0.0000");
  assert.match(zero.excluded[0]!.reason, /base is zero/);
});

test("missing source decisions and malformed financial inputs refuse by identity without redistributed shares", () => {
  const cases: [IncentiveTransactionFact[], TransactionIncentiveGroup[], RegExp][] = [
    [[fact("line-a", "10"), fact("line-a", "10")], unlimited, /transaction line-a.*more than once/],
    [[{ ...fact("line-a", "10"), recipients: [{ shareKey: "lead", employmentId: "employee-a" }] }], unlimited, /line-a.*no recipient for support/],
    [[fact("line-a", "10")], [], /project-a.*no limit decision/],
    [[{ ...fact("line-a", "10"), currency: "USD" }], unlimited, /line-a.*USD.*CAD/],
    [[{ ...fact("line-a", "10"), occurredOn: "2026-02-01" }], unlimited, /line-a.*outside/],
    [[{ ...fact("line-a", "10"), occurredOn: "2026-02-30" }], unlimited, /date for line-a.*real YYYY-MM-DD/],
    [[fact("credit-a", "-1")], unlimited, /credit-a.*adjusting award/],
    [[fact("line-a", "1,234")], unlimited, /amount for line-a.*ambiguous.*1234.*1\.234/],
    [[{ ...fact("line-a", "1"), quantity: "12,34" }], unlimited, /quantity for line-a.*decimal point.*12,34.*12\.34/],
  ];
  for (const [facts, groups, message] of cases) assert.throws(() => computeTransactionIncentive(policy, facts, groups), message);
  assert.throws(() => computeTransactionIncentive({ ...policy, minorUnits: Number.NaN }, [], []), /registered.*minor units/);
  assert.throws(() => computeTransactionIncentive(policy, [], [{ groupId: "project-a", limit: { kind: "amount", amount: "0.001", previouslyAwarded: "0" } }]), /ceiling finer than payable precision/);
});
