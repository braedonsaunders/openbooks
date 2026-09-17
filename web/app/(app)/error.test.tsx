import assert from "node:assert/strict";
import test from "node:test";

const React = await import("react");
Object.assign(globalThis, { React });
const { renderToStaticMarkup } = await import("react-dom/server");
const { NextIntlClientProvider } = await import("next-intl");
const AppError = (await import("./error")).default;
// The real English catalog, exactly as the app serves it (shell + common).
const messages = (await import("../../messages/en")).default as Record<string, unknown>;
const shell = (messages.shell ?? {}) as Record<string, Record<string, string>>;
const common = (messages.common ?? {}) as Record<string, Record<string, string>>;

function render(digest: string | undefined): string {
  const error = Object.assign(new Error("database timeout"), digest === undefined ? {} : { digest });
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AppError error={error} reset={() => {}} />
    </NextIntlClientProvider>,
  );
}

test("the route error boundary shows its request id with a retry", () => {
  const html = render("req-abc-123");
  assert.ok(html.includes("req-abc-123"), "boundary must surface the request id");
  assert.ok(html.includes(shell.routeState!.errorReference!.replace("{id}", "req-abc-123")));
  assert.ok(html.includes(common.actions!.retry!));
});

test("the route error boundary renders without an id when the failure is client-side", () => {
  const html = render(undefined);
  assert.ok(html.includes(shell.routeState!.errorTitle!));
  assert.ok(!html.includes("Reference"));
});
