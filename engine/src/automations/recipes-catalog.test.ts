import assert from "node:assert/strict";
import test from "node:test";
import { automationRecipes } from "./services.ts";
import { eventSourcedTriggerRefusal, parseAutomationTrigger } from "./triggers.ts";

/**
 * D14: the recipe catalog must offer nothing dead. Every catalog trigger
 * has to clear the enable-time event-sourcing refusal — a recipe that
 * installs but can never be enabled or fired (no writer stages its
 * events) is the declared-with-no-arm defect: installable, healthy
 * looking, inert forever.
 */
test("every catalog recipe trigger can actually fire once enabled", () => {
  const recipes = automationRecipes();
  assert.ok(recipes.length > 0, "the catalog is empty");
  for (const recipe of recipes) {
    const trigger = parseAutomationTrigger(recipe.trigger);
    assert.equal(
      eventSourcedTriggerRefusal(trigger),
      null,
      `${recipe.key} installs a '${(trigger as { kind: string }).kind}' trigger no writer stages events for`,
    );
  }
});
