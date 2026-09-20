import assert from "node:assert/strict";
import test from "node:test";
import {
  DASHBOARD_ROLE_KEYS,
  DEFAULT_DASHBOARD_LAYOUTS,
  defaultDashboardLayoutForRole,
} from "@openbooks/schema";

test("every built-in role has a valid, distinct dashboard layout", () => {
  assert.deepEqual(Object.keys(DEFAULT_DASHBOARD_LAYOUTS).sort(), [...DASHBOARD_ROLE_KEYS].sort());

  for (const role of DASHBOARD_ROLE_KEYS) {
    const widgets = DEFAULT_DASHBOARD_LAYOUTS[role].widgets;
    assert.ok(widgets.length > 0, `${role} dashboard must not be empty`);
    assert.equal(new Set(widgets.map((widget) => widget.id)).size, widgets.length, `${role} widget ids must be unique`);
    assert.ok(!widgets.some((widget) => widget.id === "kpi-journal-entries"), `${role} must not restore the retired journal-entry count`);

    for (const widget of widgets) {
      assert.ok(widget.x >= 0 && widget.y >= 0, `${role}/${widget.id} must start inside the grid`);
      assert.ok(widget.w > 0 && widget.h > 0, `${role}/${widget.id} must have positive dimensions`);
      assert.ok(widget.x + widget.w <= 12, `${role}/${widget.id} must fit the 12-column grid`);
    }
  }
});

test("unknown and custom roles receive the read-focused viewer default", () => {
  assert.equal(defaultDashboardLayoutForRole("custom_auditor"), DEFAULT_DASHBOARD_LAYOUTS.viewer);
});
