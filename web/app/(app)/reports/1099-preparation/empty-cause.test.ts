import assert from "node:assert/strict";
import test from "node:test";
import { necEmptyCause } from "./empty-cause";

test("named vendors come first with at most three", () => {
  const cause = necEmptyCause({
    exceptions: [
      { kind: "unflagged_over_threshold", partyId: "a", partyName: "Alpha", amount: "9000.00" },
      { kind: "missing_tin", partyId: "b", partyName: "Beta", amount: "100.00" },
      { kind: "missing_form_assignment", partyId: "c", partyName: "Gamma", amount: "50.00" },
      { kind: "unflagged_over_threshold", partyId: "d", partyName: "Delta", amount: "10.00" },
    ],
    unposted: { count: 2, total: "5.00" },
  });
  assert.deepEqual(cause, {
    kind: "vendors",
    vendors: [
      { partyId: "a", name: "Alpha", total: "9000.00" },
      { partyId: "b", name: "Beta", total: "100.00" },
      { partyId: "c", name: "Gamma", total: "50.00" },
    ],
  });
});

test("unposted payments surface only with no named vendor", () => {
  assert.deepEqual(necEmptyCause({ exceptions: [], unposted: { count: 2, total: "300.00" } }), {
    kind: "unposted",
    count: 2,
    total: "300.00",
  });
});

test("a quiet year stays generic", () => {
  assert.equal(necEmptyCause({ exceptions: [], unposted: null }), null);
  assert.equal(necEmptyCause({ exceptions: [], unposted: { count: 0, total: "0" } }), null);
  assert.equal(
    necEmptyCause({
      exceptions: [
        { kind: "corporation_flagged", partyId: "a", partyName: "Alpha", amount: "1.00" },
      ],
      unposted: null,
    }),
    null,
  );
});
