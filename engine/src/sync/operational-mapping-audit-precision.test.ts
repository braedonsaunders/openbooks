import assert from "node:assert/strict";
import test from "node:test";
import { stableMappingSnapshotsMatch } from "./operational-entity-mappings.ts";

test("mapping audit comparisons preserve one-cent changes above floating-point precision", () => {
  assert.equal(
    stableMappingSnapshotsMatch('{"cost":999999999999998.99}', '{"cost":999999999999999.00}'),
    false,
  );
  assert.equal(
    stableMappingSnapshotsMatch(
      '{"cost":999999999999998.99,"updated_at":"old"}',
      '{"cost":999999999999998.99,"updated_at":"new"}',
    ),
    true,
  );
});

test("mapping audit comparisons retain source custom JSON types while ignoring extraction stamps", () => {
  assert.equal(
    stableMappingSnapshotsMatch(
      '{"custom":{"sourceOrdinal":9007199254740993}}',
      '{"custom":{"sourceOrdinal":"9007199254740993"}}',
    ),
    false,
  );
  assert.equal(
    stableMappingSnapshotsMatch(
      '{"custom":{"lastSyncedAt":null,"value":1}}',
      '{"custom":{"lastSyncedAt":"new","value":1}}',
    ),
    true,
  );
  assert.equal(
    stableMappingSnapshotsMatch('{"custom":{"value":true}}', '{"custom":{"value":"true"}}'),
    false,
  );
});
