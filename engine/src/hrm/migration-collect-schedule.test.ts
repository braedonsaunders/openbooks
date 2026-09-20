import assert from "node:assert/strict";
import test from "node:test";

import { EmploymentCollectionError, assertScheduleObservable } from "./migration-collect.ts";

/**
 * The dangling-schedule refusal is decided on the join, never on the
 * schedule's own subsidiary. Production found the inverse: every profile on
 * an org-wide schedule (subsidiary null, a legitimate scope) was refused as
 * "no read can observe" and the operator was sent to reconcile healthy data.
 * The rows below carry the schedule subsidiary exactly as the collector's
 * query does, so the refusal is proven to ignore it.
 */

const PROFILE_ID = "019f0000-0000-7000-8000-000000000001";
const SCHEDULE_ID = "019f0000-0000-7000-8000-000000000002";

test("a profile on an org-wide schedule is observable and never refused", () => {
  const orgWide = {
    id: PROFILE_ID,
    pay_schedule_id: SCHEDULE_ID,
    schedule_subsidiary_id: null,
    schedule_missing: false,
  };
  assert.doesNotThrow(() => assertScheduleObservable(orgWide));
});

test("a profile on a subsidiary-scoped schedule is observable", () => {
  const scoped = {
    id: PROFILE_ID,
    pay_schedule_id: SCHEDULE_ID,
    schedule_subsidiary_id: "019f0000-0000-7000-8000-000000000003",
    schedule_missing: false,
  };
  assert.doesNotThrow(() => assertScheduleObservable(scoped));
});

test("a profile whose schedule the org-scoped read cannot find is refused with its remedy", () => {
  const dangling = {
    id: PROFILE_ID,
    pay_schedule_id: SCHEDULE_ID,
    schedule_subsidiary_id: null,
    schedule_missing: true,
  };
  assert.throws(
    () => assertScheduleObservable(dangling),
    (error: unknown) =>
      error instanceof EmploymentCollectionError &&
      new RegExp(`names pay schedule ${SCHEDULE_ID} which no read can observe`).test(error.message) &&
      /reconcile employee_payroll_profiles/.test(error.message),
  );
});
