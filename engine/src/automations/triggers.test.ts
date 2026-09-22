import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPublishableAutomationActions,
  parseAutomationActions,
  parseAutomationConditions,
  parseAutomationRules,
  parseAutomationTrigger,
  AutomationContractError,
} from "./triggers.ts";
import { AUTOMATION_TRIGGER_KINDS } from "@openbooks/schema/src/hrm-automations.ts";

test("all six trigger kinds parse", () => {
  assert.equal(parseAutomationTrigger({ kind: "schedule", cron: "0 9 * * *", timezone: "UTC" }).kind, "schedule");
  assert.equal(
    parseAutomationTrigger({ kind: "date_relative", entity: "employment", dateField: "service_start", offsetDays: 3, direction: "before", atTime: "09:00" }).kind,
    "date_relative",
  );
  assert.equal(parseAutomationTrigger({ kind: "field_change", entity: "employment", field: "status" }).kind, "field_change");
  assert.equal(parseAutomationTrigger({ kind: "event", subjectKind: "x", eventKind: "approved" }).kind, "event");
  assert.equal(parseAutomationTrigger({ kind: "document", event: "signed" }).kind, "document");
  assert.equal(parseAutomationTrigger({ kind: "manual" }).kind, "manual");
});

test("trigger kind vocabulary matches the storage CHECK (0226)", () => {
  assert.deepEqual([...AUTOMATION_TRIGGER_KINDS].sort(), ["date_relative", "document", "event", "field_change", "manual", "schedule"]);
});

test("unknown trigger kind refuses with remedy", () => {
  assert.throws(
    () => parseAutomationTrigger({ kind: "webhook_inbound" }),
    (e: unknown) => e instanceof AutomationContractError && /invalid/.test((e as Error).message),
  );
});

test("bad at_time refuses", () => {
  assert.throws(
    () => parseAutomationTrigger({ kind: "date_relative", entity: "e", dateField: "f", offsetDays: 1, direction: "before", atTime: "9am" }),
    AutomationContractError,
  );
});

test("actions need at least one valid action", () => {
  assert.throws(() => parseAutomationActions([]), AutomationContractError);
  assert.throws(() => parseAutomationActions([{ kind: "fire_missiles" }]), AutomationContractError);
  const actions = parseAutomationActions([
    { kind: "send_notification", to: "manager", body: "hi" },
    { kind: "update_field", entity: "employment", field: "department_id", value: "x" },
  ]);
  assert.equal(actions.length, 2);
});

test("webhook actions refuse publishing with the transport named and a replacement", () => {
  const actions = parseAutomationActions([{ kind: "webhook", endpointKey: "crm" }]);
  assert.throws(
    () => assertPublishableAutomationActions(actions),
    (e: unknown) =>
      e instanceof AutomationContractError &&
      /no outbound webhook transport/.test((e as Error).message) &&
      /send_notification/.test((e as Error).message),
  );
  // Deliverable actions still publish.
  assertPublishableAutomationActions(
    parseAutomationActions([{ kind: "send_notification", to: "manager", body: "hi" }]),
  );
});

test("conditions default to empty (match-all)", () => {
  assert.equal(parseAutomationConditions({}).root, undefined);
  const rules = parseAutomationRules(null);
  assert.equal(rules.departmentId, undefined);
  assert.deepEqual(rules.attributes, []);
});
