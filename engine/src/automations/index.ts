/**
 * HR-16 automations engine module — triggers, rules, conditions, actions,
 * exception-only approval, simulator, run log, action/reason codes, and
 * cancel / rescind / correct event verbs on Flows.
 *
 * Boundary: this module depends on flows (subject adapters, delegations,
 * system gate decisions), hrm (temporal primitives, change requests,
 * processes, employment reads), organization (permissions, features),
 * platform (db), and scheduling (durable email outbox). NO engine module
 * may depend on automations — the tick is web-composed
 * (web/instrumentation.node.ts) so the pinned dependency cycle never
 * grows. Entity write services stage trigger rows in
 * automation_event_queue with plain SQL (no import); the tick drains them.
 */
export * from "./triggers.ts";
export * from "./evaluate.ts";
export * from "./registry.ts";
export * from "./execute.ts";
export * from "./approvals.ts";
export * from "./simulator.ts";
export * from "./services.ts";
export * from "./action-reasons.ts";
export * from "./event-verbs.ts";
export * from "./tick.ts";
