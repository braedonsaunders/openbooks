/**
 * Approval routing refused AFTER the submission wrote its before_submit
 * script effects and ran its on_submit automation. Thrown inside the
 * lifecycle transaction so the whole submission rolls back; each lifecycle
 * entry maps it to the same 422 after the rollback, with none of the
 * refused effects committed.
 */
export class ApprovalRoutingError extends Error {
  constructor(readonly flowError: string) {
    super(`approval could not be routed: ${flowError}`)
    this.name = 'ApprovalRoutingError'
  }
}
