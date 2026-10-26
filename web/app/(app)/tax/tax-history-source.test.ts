import assert from "node:assert/strict";
import test from "node:test";
import { preparedListSource, preparedPageState } from "../../../lib/list/prepared-sources";

test("tax filing history uses its authorized server window and stable filing identity", () => {
  const source = preparedListSource("tax_filings_history");
  assert.equal(source.route, "/tax?tab=history");
  assert.equal(source.mode, "server");
  assert.equal(source.rowsField, "history.rows");
  assert.equal(source.rowKeyField, "id");
  assert.deepEqual(preparedPageState(source, { history: { total: 21, page: 2, perPage: 20 } }), {
    total: 21,
    page: 2,
    perPage: 20,
  });
});
