import assert from "node:assert/strict";
import test from "node:test";

const React = await import("react");
Object.assign(globalThis, { React });
const { renderToStaticMarkup } = await import("react-dom/server");
const GlobalError = (await import("./global-error")).default;
import shell from "@/messages/en/shell.json";

function render(digest: string | undefined): string {
  const error = Object.assign(new Error("root layout failure"), digest === undefined ? {} : { digest });
  return renderToStaticMarkup(<GlobalError error={error} reset={() => {}} />);
}

test("the global error surface shows its request id with a retry", () => {
  const html = render("req-global-456");
  assert.ok(html.includes("req-global-456"), "global boundary must surface the request id");
  assert.ok(html.includes("Retry"));
});

test("the global error surface renders without an id when the failure is client-side", () => {
  const html = render(undefined);
  assert.ok(html.includes(shell.routeState.errorTitle));
  assert.ok(!html.includes("req-global-456"));
});
