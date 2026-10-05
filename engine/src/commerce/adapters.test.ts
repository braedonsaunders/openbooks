import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  channelAdapter,
  registerChannelAdapter,
  registeredChannelKinds,
  workspaceTabsFor,
} from "./adapters.ts";
import { CommerceError } from "./errors.ts";
import type { SalesChannelAdapter } from "./contracts.ts";

/**
 * The registry path the workspace exercises: verification keeps the strict
 * lookup (an uninstalled connector refuses by name), while optional
 * workspace contributions degrade to nothing. A workspace that used the
 * strict lookup would refuse every channel until its connector lands.
 */
const testAdapter: SalesChannelAdapter = {
  kind: "test-shop",
  describeSettings: () => z.object({}),
  verifyWebhook: () => {
    throw new CommerceError(
      "test_unused",
      "The test adapter never verifies.",
      "Use the strict lookup test below instead.",
    );
  },
  testConnection: async () => ({ ok: true, detail: "test adapter" }),
  handleEvent: async () => {
    throw new CommerceError(
      "test_unused",
      "The test adapter never handles events.",
      "Use the inbound suite instead.",
    );
  },
  workspaceTabs: () => [{ key: "orders", labelKey: "test.tabs.orders" }],
};

test("an uninstalled connector refuses verification but contributes no tabs", () => {
  assert.throws(
    () => channelAdapter("uninstalled-kind"),
    (error: unknown) => error instanceof CommerceError && error.code === "channel_kind_unknown",
  );
  assert.deepEqual(workspaceTabsFor("uninstalled-kind"), []);
});

test("a registered adapter contributes its workspace tabs", () => {
  registerChannelAdapter(testAdapter);
  assert.deepEqual(workspaceTabsFor("test-shop"), [{ key: "orders", labelKey: "test.tabs.orders" }]);
  assert.ok(registeredChannelKinds().includes("test-shop"));
  assert.equal(channelAdapter("test-shop").kind, "test-shop");
});
