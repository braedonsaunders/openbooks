import { assertUnrestrictedScope } from "@openbooks/engine/organization/scope";

/** Price-level schedules govern every subsidiary; customer schedules stay customer-scoped. */
export function assertScheduleScope(
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
  ...customerIds: Array<string | null>
): void {
  if (customerIds.some((customerId) => customerId === null)) {
    assertUnrestrictedScope(allowedSubsidiaryIds);
  }
}
