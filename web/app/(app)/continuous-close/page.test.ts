import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import React from "react";
import { stubModules } from "../../../testing/stub-modules";

stubModules({ intl: true, navigation: false });
Object.assign(globalThis, { React });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./view" && context.parentURL?.endsWith("/continuous-close/page.tsx")) {
      return { shortCircuit: true, url: "data:text/javascript,export async function loadContinuousClose(search){return {search}};export function continuousCloseSpec(data){return {route:'/continuous-close',search:data.search}}" };
    }
    if (specifier.endsWith("/components/viewspec/module-view")) {
      return { shortCircuit: true, url: "data:text/javascript,export function ModuleView(){return null}" };
    }
    return next(specifier, context);
  },
});
const { default: ContinuousClosePage } = await import("./page");
test.after(() => hooks.deregister());

for (const search of [{}, { item: ["item-1", "ignored"], q: "pending" }, { tab: "reports" }]) {
  test(`continuous close renders its native page with ${JSON.stringify(search)}`, async () => {
    const result = await ContinuousClosePage({ searchParams: Promise.resolve(search) });
    assert.deepEqual(result.props.searchParams, search);
    assert.deepEqual(result.props.data, { search });
    assert.deepEqual(result.props.spec, { route: "/continuous-close", search });
    assert.equal(result.props.trusted, true);
  });
}
