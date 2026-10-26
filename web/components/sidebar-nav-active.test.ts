import assert from "node:assert/strict";
import test from "node:test";
import { findActiveNavHref, findNavWorkspace } from "./sidebar-nav-active.ts";

const groups = [
  {
    items: [{ href: "/assets" }, { href: "/assets?tab=tax-depreciation" }],
  },
];

test("query-addressed modules win over their shared page module", () => {
  assert.equal(findActiveNavHref("/assets", groups), "/assets");
  assert.equal(findActiveNavHref("/assets?asset=abc", groups), "/assets");
  assert.equal(
    findActiveNavHref("/assets?asset=abc&tab=tax-depreciation", groups),
    "/assets?tab=tax-depreciation",
  );
});

const workspaces = [
  { id: "my-work", groupHref: "/dashboard", items: [{ href: "/inbox" }, { href: "/documents" }] },
  {
    id: "accounting",
    groupHref: "/accounting",
    items: [{ href: "/journals" }, { href: "/accounting/amortization" }],
  },
  {
    id: "hrm",
    groupHref: "/hrm",
    items: [{ href: "/hrm/leave" }, { href: "/payroll", subgroupHref: "/payroll" }],
  },
];

test("a page owns the workspace holding its menu entry", () => {
  assert.equal(findNavWorkspace("/journals/je-42", workspaces)?.id, "accounting");
  assert.equal(findNavWorkspace("/accounting", workspaces)?.id, "accounting");
});

test("pages inside a module that are not menu entries resolve to that module workspace", () => {
  // Workspace homes match exactly, so these have no active entry of their own.
  assert.equal(findActiveNavHref("/accounting/provisions", workspaces), null);
  assert.equal(findNavWorkspace("/accounting/provisions", workspaces)?.id, "accounting");
  assert.equal(findNavWorkspace("/hrm/org-chart?view=tree", workspaces)?.id, "hrm");
});

test("a location sharing no path with any workspace has no owner", () => {
  assert.equal(findNavWorkspace("/platform/organizations", workspaces), null);
  assert.equal(findNavWorkspace("", workspaces), null);
});
