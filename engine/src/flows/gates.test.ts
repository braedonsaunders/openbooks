import assert from "node:assert/strict";
import test from "node:test";
import { gateSubsidiaryScopeAllows } from "./gates.ts";
import { getFlowAdapter, listFlowSubjectProfiles } from "./registry.ts";
import type { FlowSubjectAdapter } from "./types.ts";

const IN_SCOPE = "00000000-0000-4000-8000-000000000001";
const OUT_OF_SCOPE = "00000000-0000-4000-8000-000000000002";

test("restricted gate decisions require the subject subsidiary", () => {
  const allowed = new Set([IN_SCOPE]);

  assert.equal(gateSubsidiaryScopeAllows(allowed, OUT_OF_SCOPE), false);
  assert.equal(gateSubsidiaryScopeAllows(allowed, IN_SCOPE), true);
});

test("unrestricted gate decisions preserve org-wide access", () => {
  assert.equal(gateSubsidiaryScopeAllows(null, OUT_OF_SCOPE), true);
  assert.equal(gateSubsidiaryScopeAllows(undefined, null), true);
});

test("every registered subject kind declares its grants and its scope", () => {
  // The type requires both members; this catches a registration the type
  // cannot see (a JS-built adapter, a cast). Null permissions are an explicit
  // declaration that no single grant exists, and generic endpoints fail
  // closed on them; an undeclared member is the defect.
  const vias = ["document", "none", "column", "party", "project", "employment", "custom"];
  const kinds = listFlowSubjectProfiles().map((profile) => profile.subjectKind);
  assert.ok(kinds.length > 0);
  const defects = kinds.flatMap((kind) => {
    const adapter = getFlowAdapter(kind);
    if (!adapter) return [`${kind}: no adapter`];
    const found: string[] = [];
    const permissions = adapter.permissions as FlowSubjectAdapter["permissions"] | undefined;
    if (permissions === undefined) found.push(`${kind}: permissions undeclared`);
    else if (permissions !== null && !(["read", "edit", "approve"] as const).every((key) => typeof permissions[key] === "string" && permissions[key] !== "")) {
      found.push(`${kind}: permissions ${JSON.stringify(permissions)} are not three grants`);
    }
    if (!vias.includes((adapter.scope as { via?: string } | undefined)?.via ?? "")) {
      found.push(`${kind}: scope ${JSON.stringify(adapter.scope)} is not a declared variant`);
    }
    return found;
  });
  assert.deepEqual(defects, [], `subject kinds missing an arm:\n  ${defects.join("\n  ")}`);
});
