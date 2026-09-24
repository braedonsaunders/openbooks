import { test } from "node:test";
import assert from "node:assert/strict";
import { UNRESTRICTED_SCOPE_REQUIRED, UnrestrictedScopeError } from "../../organization/subsidiary-scope.ts";
import { createKit } from "./kits.ts";
import { createOfferTemplate } from "./offers-signing.ts";
import { createRetentionRule } from "./retention.ts";
import { setupScopeHarness, teardownScopeHarness } from "./recruiting-scope-test-fixture.ts";

/**
 * H-RECRUIT-CONFIG: offer templates, interview kits, and retention rules
 * are org-keyed shared configuration — a scoped actor writing them would
 * reinterpret another entity's pipeline. Writes need the manage grant plus
 * unrestricted scope; reads stay open to grant holders (covered by the
 * grants file). Data and audit history are untouched by the denial.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

test("H-RECRUIT-CONFIG: shared-config writes need unrestricted scope", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting", "hrmStructuredInterviews", "hrmOfferSigning", "hrmCandidateRetention"]);
  try {
    const orgId = h.org.orgId;
    const writes: Record<string, () => Promise<unknown>> = {
      "offer template": () => createOfferTemplate({ orgId, actorId: h.scopedId, name: "scoped letter", bodyTemplate: "Dear {{candidate_name}}" }),
      "kit": () => createKit({ orgId, actorId: h.scopedId, name: "scoped kit" }),
      "retention rule": () => createRetentionRule({ orgId, actorId: h.scopedId, name: "scoped rule", basis: "inactivity", retainMonths: 6 }),
    };
    for (const [name, write] of Object.entries(writes)) {
      await assert.rejects(write, (error: unknown) => {
        assert.ok(error instanceof UnrestrictedScopeError, `${name}: expected UnrestrictedScopeError, got ${String(error)}`);
        assert.equal(error.message, UNRESTRICTED_SCOPE_REQUIRED, `${name}: the canonical 403 body`);
        return true;
      }, `${name}: a scoped writer must be refused`);
    }

    // The unrestricted admin still writes every surface.
    const template = await createOfferTemplate({ orgId, actorId: h.adminId, name: "org letter", bodyTemplate: "Dear {{candidate_name}}" });
    assert.equal(template.name, "org letter");
    const kit = await createKit({ orgId, actorId: h.adminId, name: "org kit" });
    assert.equal(kit.name, "org kit");
    const rule = await createRetentionRule({ orgId, actorId: h.adminId, name: "org rule", basis: "inactivity", retainMonths: 6 });
    assert.equal(rule.name, "org rule");
  } finally {
    await teardownScopeHarness(h);
  }
});
