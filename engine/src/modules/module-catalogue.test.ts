// Run with: node --import tsx --test engine/src/modules/module-catalogue.test.ts (from repo root)
//
// Parity between the engine module-permission mirror and the contract
// owner. The mirror exists solely so the installer boundary enforces the
// exact vocabulary without importing web; this test is the drift alarm —
// adding a permission to the vocabulary means updating BOTH lists in the
// same change. Test-only cross-boundary import (house precedent:
// engine/src/close.test.ts imports web/lib/document-kinds.ts); runtime
// engine code never imports web.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODULE_CAPABILITIES,
  MODULE_PLATFORM_PERMISSIONS_MIRROR,
} from "./module-catalogue.ts";
import {
  MODULE_CAPABILITIES as CONTRACT_CAPABILITIES,
  MODULE_PLATFORM_PERMISSIONS,
} from "../../../web/lib/modules/manifest.ts";

test("the engine module-permission mirror tracks the contract catalogue", () => {
  assert.deepEqual([...MODULE_PLATFORM_PERMISSIONS_MIRROR].sort(), [...MODULE_PLATFORM_PERMISSIONS].sort());
});

test("the engine capability constants track the contract capabilities", () => {
  assert.deepEqual({ ...MODULE_CAPABILITIES }, { ...CONTRACT_CAPABILITIES });
});
