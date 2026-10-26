import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../web/testing/jsdom-env";
import { stubModules } from "../../../web/testing/stub-modules";

await bootJsdomEnvironment({ event: "native" });
stubModules({ navigation: false });
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { Select } = await import("./select");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../web/messages/en")).default;

test("a selected option dispatches in the native control realm and updates its controlled form value", async () => {
  assert.notEqual(
    globalThis.Event,
    window.Event,
    "the host and control use different event realms",
  );
  const observed: string[] = [];
  function Harness() {
    const [value, setValue] = React.useState("a");
    return (
      <Select
        id="choice"
        value={value}
        required
        onChange={(event) => {
          observed.push(event.currentTarget.value);
          setValue(event.currentTarget.value);
        }}
      >
        <option value="a">First choice</option>
        <option value="b">Second choice</option>
      </Select>
    );
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <Harness />
        </NextIntlClientProvider>,
      ),
    );
    const trigger = host.querySelector<HTMLButtonElement>("#choice");
    assert.ok(trigger);
    await act(async () => trigger.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
      node.textContent?.includes("Second choice"),
    );
    assert.ok(option);
    await act(async () => option.click());
    const native = host.querySelector("select");
    assert.ok(native);
    assert.equal(native.value, "b");
    assert.equal(native.checkValidity(), true);
    assert.deepEqual(observed, ["b"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
