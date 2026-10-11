// Stable movement facade: stock receipts live in movement-receive.ts, issues
// in movement-issue.ts and adjustments in movement-adjust.ts, so each
// operation module stays within the module line budget. Every movement
// import keeps working through this module.
export { receiveInventory, type ReceiveInput, type MovementResult } from "./movement-receive.ts";
export { issueInventory, type IssueInput } from "./movement-issue.ts";
export { adjustInventory, type AdjustInput } from "./movement-adjust.ts";
