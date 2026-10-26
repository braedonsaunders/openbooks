import assert from "node:assert/strict";
import test from "node:test";
import { FEATURE_BY_KEY, type FeatureState } from "../organization/feature-registry.ts";
import { listFlowSubjectProfiles } from "./registry.ts";
import {
  classifiedFlowSubjectKinds,
  flowSubjectAvailable,
  flowSubjectFeatureKeys,
} from "./subject-features.ts";

const registeredKinds = () => listFlowSubjectProfiles().map((profile) => profile.subjectKind);

test("every registered flow subject kind declares its owning features", () => {
  const kinds = registeredKinds();
  assert.ok(kinds.length > 0);
  const unclassified = kinds.filter((kind) => flowSubjectFeatureKeys(kind) === null);
  assert.deepEqual(
    unclassified,
    [],
    `classify these subject kinds in subject-features.ts: ${unclassified.join(", ")}`,
  );
  for (const kind of kinds) {
    for (const key of flowSubjectFeatureKeys(kind) ?? []) {
      assert.ok(FEATURE_BY_KEY.has(key), `${kind} names unknown feature ${key}`);
    }
  }
});

test("the explicit classification names only registered subject kinds", () => {
  const registered = new Set(registeredKinds());
  const stale = classifiedFlowSubjectKinds().filter((kind) => !registered.has(kind));
  assert.deepEqual(stale, [], `remove unregistered subject kinds: ${stale.join(", ")}`);
});

test("a company with optional modules off is offered only the subjects it runs", () => {
  const state: FeatureState = {
    hrm: false,
    equity: false,
    rebateManagement: false,
    saasMetrics: false,
    manufacturing: false,
    fulfillment: false,
  };
  for (const kind of [
    "hrm_leave_request",
    "equity_action",
    "customer_rebate_claim",
    "metrics_normalization",
    "work_order",
    "pick_list",
    "shipment",
  ]) {
    assert.equal(flowSubjectAvailable(state, kind), false, `${kind} is withheld`);
  }
  for (const kind of ["vendor_bill", "customer_invoice", "journal", "party_bank_account"]) {
    assert.equal(flowSubjectAvailable(state, kind), true, `${kind} is a core subject`);
  }
});

test("a child switch never makes a subject available while its parent is off", () => {
  assert.equal(flowSubjectAvailable({ hrm: true, hrmShiftPlanning: true }, "schedule_board"), true);
  assert.equal(
    flowSubjectAvailable({ hrm: false, hrmShiftPlanning: true }, "schedule_board"),
    false,
  );
  assert.equal(flowSubjectAvailable({ projects: true, fieldTickets: true }, "field_ticket"), true);
  assert.equal(
    flowSubjectAvailable({ projects: false, fieldTickets: true }, "field_ticket"),
    false,
  );
});

test("order-cycle documents follow the order features that produce them", () => {
  assert.equal(flowSubjectAvailable({ orders: false }, "sales_fulfillment"), false);
  assert.equal(flowSubjectAvailable({ orders: true }, "sales_fulfillment"), true);
  assert.equal(flowSubjectAvailable({ orders: true, inventory: false }, "purchase_receipt"), false);
  assert.equal(flowSubjectAvailable({ orders: true, inventory: true }, "purchase_receipt"), true);
});

test("an unknown subject kind is never available", () => {
  assert.equal(flowSubjectFeatureKeys("not_a_subject"), null);
  assert.equal(flowSubjectAvailable({}, "not_a_subject"), false);
});
