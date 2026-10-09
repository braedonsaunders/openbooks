import test from "node:test";
import assert from "node:assert/strict";
import { setupParentRecordVisible } from "./types";
import { SETUP_ENTITY_BY_KEY } from "./registry";
test("declared resource delivery contacts are visible only for resource-board parents with native camel/snake field shapes", () => {
  const child = SETUP_ENTITY_BY_KEY.get("schedule-resource-recipients")!;
  const binding = child.parentRecords!.find(
    (owner) => owner.entityKey === "schedule-boards",
  )!;
  assert.equal(
    setupParentRecordVisible(binding, { row_kind: "resources" }),
    true,
  );
  assert.equal(
    setupParentRecordVisible(binding, { rowKind: "resources" }),
    true,
  );
  for (const rowKind of ["people", "tasks", ""])
    assert.equal(setupParentRecordVisible(binding, { rowKind }), false);
  assert.equal(setupParentRecordVisible({}, {}), true);
  assert.equal(
    setupParentRecordVisible(
      {
        showWhen: {
          all: [
            { field: "rowKind", in: ["resources"] },
            { field: "id", present: true },
          ],
        },
      },
      { row_kind: "resources" },
    ),
    false,
  );
});
