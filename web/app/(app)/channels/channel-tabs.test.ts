import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { channelTabs } from "./channel-tabs.ts";

describe("channelTabs", () => {
  it("keeps Overview and every channel workspace reachable from each tab", () => {
    const tabs = channelTabs((key) => key, "overview", 4);

    assert.deepEqual(
      tabs.map(({ href }) => href),
      ["/channels", "/channels/orders", "/channels/exceptions", "/channels/posting"],
    );
    assert.equal(tabs.filter(({ active }) => active).length, 1);
    assert.equal(tabs[0]?.active, true);
    assert.equal(tabs[2]?.count, 4);
  });
});
