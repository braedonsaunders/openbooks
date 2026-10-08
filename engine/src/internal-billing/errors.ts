/**
 * A refusal from the internal billing services. `status` is the HTTP answer
 * an API boundary gives: 404 for a record that is missing, in another
 * organization or outside the caller's subsidiary scope (indistinguishable
 * on purpose), 409 for a concurrent change, 422 for every business refusal.
 */
export class InternalBillingError extends Error {
  override readonly name = "InternalBillingError";

  constructor(
    message: string,
    readonly status: 404 | 409 | 422 = 422,
  ) {
    super(message);
  }
}

export const INTERNAL_BILLING_DISABLED =
  "Internal billing is turned off; turn it on in Company Settings → Features";
export const INTERNAL_BILLING_PROJECTS_DISABLED =
  "this internal billing references a project and Projects is turned off; turn it on in Company Settings → Features";
