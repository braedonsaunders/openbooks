import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { AiRailsError } from "@openbooks/engine/src/hrm/ai/errors.ts";

// ./ai-rails.ts rides ./authz, which opens with `import "server-only"` —
// the package throws at load outside a Server Component. Stub it the way
// web/lib/authz.test.ts does so this unit file loads in the node runner.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});
const { aiRailsErrorResponse, dateParam, uuidParam } = await import("./ai-rails.ts");
hooks.deregister();

/**
 * HR-21 API plumbing unit tests — no database. The refusal-to-status
 * contract is asserted here; DB-owned route behavior ships for the
 * gating box.
 */
test("computed refusals map to the status naming their shape", async () => {
  const cases: [AiRailsError, number][] = [
    [new AiRailsError("ai_invalid_input", "bad"), 400],
    [new AiRailsError("ai_reason_required", "reason"), 400],
    [new AiRailsError("ai_forbidden", "no"), 403],
    [new AiRailsError("ai_autonomy_raise_refused", "no"), 403],
    [new AiRailsError("ai_subject_missing", "gone"), 404],
    [new AiRailsError("ai_feature_off", "off"), 404],
    [new AiRailsError("ai_unknown_capability", "unknown"), 404],
    [new AiRailsError("ai_finalize_blocked", "blocked"), 409],
    [new AiRailsError("ai_flag_closed", "closed"), 409],
    [new AiRailsError("ai_decision_not_logged", "lost"), 422],
  ];
  for (const [error, status] of cases) {
    const res = aiRailsErrorResponse(error);
    assert.equal(res.status, status, error.code);
    // The message — with its remedy — survives intact, never a bare
    // 'internal error' for a computed refusal.
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, error.message);
  }
});

test("unknown failures stay private behind a 500", async () => {
  const res = aiRailsErrorResponse(new Error("connection string postgres://secret"));
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "internal error");
});

test("uuid and date params refuse with the remedy", () => {
  const uuid = uuidParam(new URL("https://x/?employmentId=nope"), "employmentId", true);
  assert.ok(uuid instanceof Response && uuid.status === 400);
  const missing = uuidParam(new URL("https://x/"), "employmentId", true);
  assert.ok(missing instanceof Response && missing.status === 400);
  assert.equal(uuidParam(new URL("https://x/"), "stubId", false), null);
  const date = dateParam(new URL("https://x/?from=15-09-2026"), "from", true);
  assert.ok(date instanceof Response && date.status === 400);
});
