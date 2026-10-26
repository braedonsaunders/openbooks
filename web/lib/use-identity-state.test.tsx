import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

await bootJsdomEnvironment({ url: "http://localhost/payments" });
const React = await import("react");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useIdentityState } = await import("./use-identity-state.ts");

test("same-subject refresh preserves a draft; switching subjects commits only the new seed", async (t) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  let edit: React.Dispatch<React.SetStateAction<string>> = () => {
    throw new Error("Not mounted");
  };
  const committed: string[] = [];
  function Draft({ subject, seed }: { subject: string; seed: string }) {
    const [value, setValue] = useIdentityState([subject], seed);
    edit = setValue;
    React.useLayoutEffect(() => {
      committed.push(value);
    }, [value]);
    return <output>{value}</output>;
  }
  await act(async () => root.render(<Draft subject="first" seed="stored" />));
  await act(async () => edit("unsaved"));
  await act(async () => root.render(<Draft subject="first" seed="refreshed" />));
  assert.equal(host.textContent, "unsaved");
  committed.length = 0;
  await act(async () => root.render(<Draft subject="second" seed="second stored" />));
  assert.deepEqual(committed, ["second stored"]);
  assert.equal(host.textContent, "second stored");
});

test("late callbacks cannot cross an identity change, including a return to the original request key", async (t) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  let respond: React.Dispatch<React.SetStateAction<string>> = () => {
    throw new Error("Not mounted");
  };
  function Result({ request }: { request: string }) {
    const [value, setValue] = useIdentityState([request], "loading");
    respond = setValue;
    return <output>{value}</output>;
  }
  await act(async () => root.render(<Result request="first" />));
  const oldResponse = respond;
  await act(async () => root.render(<Result request="second" />));
  await act(async () => oldResponse("old response"));
  assert.equal(host.textContent, "loading");
  await act(async () => root.render(<Result request="first" />));
  await act(async () => oldResponse((previous) => `${previous}: stale`));
  assert.equal(host.textContent, "loading");
  await act(async () => respond((previous) => `${previous}: current`));
  assert.equal(host.textContent, "loading: current");
});
