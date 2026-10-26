import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { HEAD_INIT, SPLASH_PLAYED_COOKIE } from "./splash";

function headInit({ cookie = "", referrer = "" }: { cookie?: string; referrer?: string }) {
  const classes = new Set<string>();
  const toggle = (name: string, on?: boolean) => {
    if (on ?? !classes.has(name)) classes.add(name);
    else classes.delete(name);
  };
  runInNewContext(HEAD_INIT, {
    URL,
    localStorage: { getItem: () => null },
    window: { matchMedia: () => ({ matches: false }) },
    location: { origin: "https://books.example.test" },
    document: {
      cookie,
      referrer,
      documentElement: { classList: { add: (name: string) => classes.add(name), toggle } },
    },
  });
  return classes;
}

test("the brand intro plays on the first direct load of a browser session only", () => {
  assert.equal(headInit({}).has("nav-internal"), false, "a fresh session sees the intro");
  assert.equal(
    headInit({ referrer: "https://elsewhere.example.test/" }).has("nav-internal"),
    false,
  );
  assert.equal(
    headInit({ cookie: `theme=x; ${SPLASH_PLAYED_COOKIE}=1` }).has("nav-internal"),
    true,
    "later loads in the session skip it",
  );
  assert.equal(
    headInit({ referrer: "https://books.example.test/ar" }).has("nav-internal"),
    true,
    "in-app new tabs skip it",
  );
  assert.equal(
    headInit({ cookie: `${SPLASH_PLAYED_COOKIE}=10` }).has("nav-internal"),
    false,
    "only the exact marker counts",
  );
});
