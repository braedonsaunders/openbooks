import assert from "node:assert/strict";
import test from "node:test";
import { equityActionDeepLink } from "./equity-actions-adapter.ts";

const SUB = "a0000000-0000-4000-8000-000000000001";
const SUBJECT = "s0000000-0000-4000-8000-000000000001";

test("an equity action's link opens the view of the record it concerns, on the reader's own date", () => {
  const link = (action: string) => {
    const url = new URL(
      equityActionDeepLink({ action, subject_id: SUBJECT, subsidiary_id: SUB }),
      "http://localhost",
    );
    return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
  };
  assert.deepEqual(link("void"), {
    path: "/equity",
    params: { sub: SUB, view: "securities", security: SUBJECT },
  });
  assert.deepEqual(link("mfn_election"), {
    path: "/equity",
    params: { sub: SUB, view: "securities", security: SUBJECT },
  });
  assert.deepEqual(link("round_amendment"), {
    path: "/equity",
    params: { sub: SUB, view: "rounds", round: SUBJECT },
  });
  assert.deepEqual(link("reserve_change"), {
    path: "/equity",
    params: { sub: SUB, view: "plans" },
  });
  assert.deepEqual(link("split"), { path: "/equity", params: { sub: SUB, view: "classes" } });
  assert.deepEqual(link("interest_run"), {
    path: "/equity",
    params: { sub: SUB, view: "compensation", run: "interest" },
  });
  assert.equal(link("account_policy").path, "/admin/setup/equity-account-policies");
  for (const action of [
    "void",
    "round_void",
    "reserve_change",
    "class_amendment",
    "compensation_run",
  ]) {
    assert.equal(link(action).params.asOf, undefined, `${action} does not pin an as-of date`);
  }
});
