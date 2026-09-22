import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Anonymous /api/pay failures must never leak engine internals. The checkout
 * session creator throws raw provider/connection errors; the route answers
 * 500 with a generic message plus a request id and logs the detail.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const acceptanceUrl = pathToFileURL(process.cwd() + "/engine/src/payments/acceptance.ts").href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (
      specifier === "@openbooks/engine/src/payments/acceptance.ts" &&
      context.parentURL?.includes("/api/pay/")
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export { PaymentAcceptanceError } from ${JSON.stringify(acceptanceUrl)};` +
              `export const paymentLinkOrgId = async () => "org-1";` +
              `export const createCheckoutSession = async () => {` +
              `  if (globalThis.__payRouteMode === "refused") {` +
              `    const { PaymentAcceptanceError: PAE } = await import(${JSON.stringify(acceptanceUrl)});` +
              `    throw new PAE("payment link is no longer valid");` +
              `  }` +
              `  throw new Error("connect db://internal:5432/openbooks: password authentication failed");` +
              `};`,
          ),
      };
    }
    if (
      specifier.endsWith("/lib/features") &&
      context.parentURL?.includes("/api/pay/")
    ) {
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent("export async function isFeatureEnabled(){return true}"),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
Object.assign(globalThis, { __payRouteMode: "boom" });
const { POST } = await import("./route.ts");

const TOKEN = "tok_test_0123456789abcdef";
const params = () => ({ params: Promise.resolve({ token: TOKEN }) });
const req = () => new Request(`http://pay.local/api/pay/${TOKEN}`, { method: "POST" });

test("anonymous checkout 500s hide engine internals behind a request id", async () => {
  (globalThis as Record<string, unknown>).__payRouteMode = "boom";
  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const res = await POST(req(), params());
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string; requestId?: string };
    assert.equal(body.error, "failed to create checkout session");
    assert.match(body.requestId ?? "", /^[0-9a-f-]{36}$/, "a request id to quote back");
    assert.ok(!JSON.stringify(body).includes("db://internal"), "no internals in the body");
    const detail = logged.find((args) => typeof args[0] === "string" && args[0].includes(body.requestId!));
    assert.ok(detail, "the detail is logged against the request id");
    assert.ok(
      detail.some((arg) => arg instanceof Error && arg.message.includes("db://internal")),
      "the logged error keeps the original detail",
    );
  } finally {
    console.error = originalError;
  }
});

test("anonymous checkout refusals keep their actionable 422 message", async () => {
  (globalThis as Record<string, unknown>).__payRouteMode = "refused";
  const res = await POST(req(), params());
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: "payment link is no longer valid" });
});
