import assert from "node:assert/strict";
import test from "node:test";
import type { PostingContributorRegistry } from "../journal/posting-contributors.ts";
import { postingEffectHooks } from "../journal/posting-effect-contributors.ts";
import { postingLineHooks } from "../journal/posting-line-contributors.ts";
import { postingPreconditionHooks } from "../journal/posting-preconditions.ts";
import { voidRemedyHooks } from "../journal/void-remedy-contributors.ts";
import { installPostingContributors } from "./posting-contributors.ts";

function hooksOf<M extends { [K in keyof M]: object }>(registry: PostingContributorRegistry<M>) {
  return registry.installed().map((domain) => [domain, Object.values(registry.require(domain))]);
}

function installedHooks() {
  return [
    hooksOf(postingLineHooks),
    hooksOf(postingPreconditionHooks),
    hooksOf(postingEffectHooks),
    hooksOf(voidRemedyHooks),
  ];
}

test("installing the posting contributors twice registers the same hooks once", () => {
  for (const registry of [
    postingLineHooks,
    postingPreconditionHooks,
    postingEffectHooks,
    voidRemedyHooks,
  ])
    registry.clear();
  installPostingContributors();
  const first = installedHooks();
  assert.ok(first.flat().length > 0, "the installer registers domain hooks");
  installPostingContributors();
  assert.deepEqual(installedHooks(), first);
});
