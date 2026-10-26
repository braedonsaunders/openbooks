import assert from "node:assert/strict";
import test from "node:test";
import {
  PostingContributorMissingError,
  postingContributorRegistry,
} from "./posting-contributors.ts";

interface Hooks {
  alpha: { run(): string };
  beta: { run(): string };
}

test("a hook whose domain was never registered refuses with the installer to run", () => {
  const registry = postingContributorRegistry<Hooks>("effect");
  registry.register("alpha", { run: () => "alpha" });
  assert.throws(
    () => registry.require("beta"),
    (error: unknown) =>
      error instanceof PostingContributorMissingError &&
      error.code === "posting_contributor_missing" &&
      error.kind === "effect" &&
      error.domain === "beta" &&
      /installPostingContributors\(\)/.test(error.message),
  );
  assert.equal(registry.require("alpha").run(), "alpha");
});

test("registering a domain again replaces its hooks instead of adding a second set", () => {
  const registry = postingContributorRegistry<Hooks>("void remedy");
  registry.register("beta", { run: () => "first" });
  registry.register("alpha", { run: () => "alpha" });
  registry.register("beta", { run: () => "second" });
  assert.deepEqual(registry.installed(), ["beta", "alpha"]);
  assert.equal(registry.require("beta").run(), "second");
  registry.clear();
  assert.deepEqual(registry.installed(), []);
  assert.throws(() => registry.require("alpha"), PostingContributorMissingError);
});
