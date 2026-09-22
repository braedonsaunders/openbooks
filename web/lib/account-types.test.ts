import assert from "node:assert/strict";
import test from "node:test";
import * as web from "./account-types.ts";
import * as engine from "@openbooks/engine/src/records/account-types.ts";

// The web module is a re-export: every universe must be identical to the
// engine source, so consolidation, postings and statements can never drift
// into two definitions of the P&L.
test("account-type universes are shared with the engine source", () => {
  assert.deepEqual(web.PNL_TYPES, engine.PNL_TYPES);
  assert.deepEqual(web.PNL_COST_TYPES, engine.PNL_COST_TYPES);
  assert.deepEqual(web.ASSET_TYPES, engine.ASSET_TYPES);
  assert.deepEqual(web.LIABILITY_TYPES, engine.LIABILITY_TYPES);
  assert.deepEqual(web.EQUITY_TYPES, engine.EQUITY_TYPES);
  assert.deepEqual(web.ACCOUNT_CLASS_TYPES, engine.ACCOUNT_CLASS_TYPES);
  assert.equal(web.accountClassTypes("income"), engine.accountClassTypes("income"));
  assert.equal(web.accountClassTypes("nope"), undefined);
});
