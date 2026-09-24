import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Block } from "@braedonsaunders/appkit-viewspec";

// BlockView composes the native pages' components, whose graph pulls
// stylesheets and server-only markers that plain tsx cannot load. Stub those
// out: the unknown-kind arm under test renders neither.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (/\.(css|scss|sass|less)(\?[^"]*)?$/.test(specifier)) {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export default {}" };
    }
    return nextResolve(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { renderToStaticMarkup } = await import("react-dom/server");
const { BlockView } = await import("./blocks");
hooks.deregister();

function render(block: Block): string {
  return renderToStaticMarkup(<BlockView block={block} scope={{}} searchParams={{}} />);
}

test("an unknown block kind renders a visible refusal naming the kind", () => {
  // A spec that bypassed schema validation used to render nothing — a silent
  // hole in the page. It must refuse visibly instead.
  const html = render({ kind: "frobnicator" } as unknown as Block);
  assert.ok(html.includes("Unsupported block"), "the refusal must be visible");
  assert.ok(html.includes("frobnicator"), "the refusal must name the kind");
  assert.ok(html.includes('role="alert"'), "the refusal must be announced");
});

test("a known block kind renders normally with no refusal", () => {
  const html = render({ kind: "text", content: "hello" } as Block);
  assert.ok(html.includes("hello"));
  assert.ok(!html.includes("Unsupported block"));
});
