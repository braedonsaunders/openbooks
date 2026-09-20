import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const DIR = new URL("./", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, DIR), "utf8");
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.split("//", 1)[0])
    .join("\n");

/**
 * Exported symbol -> owning operation module. There is no inventory.ts
 * facade: consumers import the owner directly. Every entry below was
 * exported from the pre-split inventory.ts and moved verbatim.
 */
const OWNERS: Record<string, string> = {
  stockLocationDim: "./journal.ts",
  postInventoryEntry: "./journal.ts",
  inventoryOffsetAccountProblem: "./journal.ts",
  assertStockLocationAdmitsSubsidiary: "./profile-policy.ts",
  CostingMethod: "./profile-policy.ts",
  TrackingMode: "./profile-policy.ts",
  ItemInventoryProfileRow: "./profile-policy.ts",
  parseCostingMethod: "./profile-policy.ts",
  parseTrackingMode: "./profile-policy.ts",
  lockItemInventoryProfile: "./profile-policy.ts",
  CostingPolicyAssessment: "./profile-policy.ts",
  assertCostingPolicyChangeAllowed: "./profile-policy.ts",
  inventoryFeatureEnabled: "./profile-policy.ts",
  assertTracking: "./tracking.ts",
  ensureLot: "./tracking.ts",
  ensureSerial: "./tracking.ts",
  LotRecallFilter: "./tracking.ts",
  LotRecallRow: "./tracking.ts",
  queryLotRecall: "./tracking.ts",
  IdempotentInventoryAction: "./action-idempotency.ts",
  executeIdempotentInventoryAction: "./action-idempotency.ts",
  InventoryAccounts: "./contracts.ts",
  InventoryProfile: "./contracts.ts",
  InventoryError: "./contracts.ts",
  InventoryOwnershipError: "./contracts.ts",
  InventoryIdempotencyConflictError: "./contracts.ts",
  CostingPolicyChangeBlockedError: "./contracts.ts",
  unitCostPerQuantity: "./costing.ts",
  getOnHand: "./position.ts",
  getOnHandForEntity: "./position.ts",
  lockInventoryPosition: "./position.ts",
  revalueOpenLayersToStandardCost: "./revaluation.ts",
  ReceiveInput: "./movements.ts",
  MovementResult: "./movements.ts",
  receiveInventory: "./movements.ts",
  IssueInput: "./movements.ts",
  issueInventory: "./movements.ts",
  AdjustInput: "./movements.ts",
  adjustInventory: "./movements.ts",
  TransferInput: "./transfers.ts",
  transferInventory: "./transfers.ts",
  ReverseInventoryInput: "./reversal.ts",
  ReverseInventoryResult: "./reversal.ts",
  reverseInventoryMovement: "./reversal.ts",
  BuildInput: "./assembly.ts",
  AssemblyBuildResult: "./assembly.ts",
  buildAssembly: "./assembly.ts",
  reverseAssemblyBuild: "./assembly.ts",
  DocumentInventoryLine: "./document-lines.ts",
  loadDocumentInventoryLines: "./document-lines.ts",
  inventoryPostingEffectKey: "./document-lines.ts",
  resolveBillInventoryAccounts: "./documents-purchasing.ts",
  assertBillReceiptsPostable: "./documents-purchasing.ts",
  applyBillInventoryReceipts: "./documents-purchasing.ts",
  PURCHASE_RECEIPT_DOCUMENT_KIND: "./documents-purchasing.ts",
  applyPurchaseReceiptInventory: "./documents-purchasing.ts",
  applyInventoryReceiptsForBill: "./documents-purchasing.ts",
  VendorCreditInventoryReturnSelection: "./documents-vendor-credits.ts",
  parseVendorCreditInventoryReturnSelection: "./documents-vendor-credits.ts",
  resolveVendorCreditInventoryAccounts: "./documents-vendor-credits.ts",
  assertVendorCreditInventoryReturnsPostable: "./documents-vendor-credits.ts",
  applyVendorCreditInventoryReturns: "./documents-vendor-credits.ts",
  applyInventoryReturnsForVendorCredit: "./documents-vendor-credits.ts",
  assertInvoiceIssuesPostable: "./documents-sales.ts",
  applySalesFulfillmentInventoryIssues: "./documents-sales.ts",
  applyInventoryIssuesForInvoice: "./documents-sales.ts",
  TransferOrderLineInput: "./transfer-orders.ts",
  CreateTransferOrderInput: "./transfer-orders.ts",
  createTransferOrder: "./transfer-orders.ts",
  shipTransferOrder: "./transfer-orders.ts",
  receiveTransferOrder: "./transfer-orders.ts",
  LandedCostVoucherTargetInput: "./landed-cost.ts",
  PostLandedCostVoucherInput: "./landed-cost.ts",
  postLandedCostVoucher: "./landed-cost.ts",
  ReverseLandedCostVoucherInput: "./landed-cost.ts",
  ReverseLandedCostVoucherResult: "./landed-cost.ts",
  reverseLandedCostVoucher: "./landed-cost.ts",
};

const operationFiles = (): string[] =>
  readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => f.toString());

test("legacy inventory facade is absent and unreferenced", () => {
  assert.equal(
    existsSync(new URL("./inventory.ts", DIR)),
    false,
    "engine/src/inventory/inventory.ts must not exist — import the owning module",
  );
  for (const file of readdirSync(DIR).map((f) => f.toString())) {
    if (!file.endsWith(".ts") || file === "inventory-boundary.test.ts") continue;
    const code = stripComments(read(`./${file}`));
    assert.equal(
      /["']\.\/inventory(\.ts|\.js)?["']/.test(code),
      false,
      `${file} still targets the deleted facade`,
    );
  }
});

test("every pre-split export resolves to its owning module", () => {
  for (const [name, owner] of Object.entries(OWNERS)) {
    const source = read(owner);
    const declared = new RegExp(
      `^export\\s+(?:async\\s+)?(?:function|interface|type|const|class)\\s+${name}\\b`,
      "m",
    );
    assert.match(source, declared, `${owner} must export ${name}`);
  }
});

test("inventory operation modules stay acyclic and bounded", () => {
  const files = operationFiles();
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const code = stripComments(read(`./${file}`));
    const deps = [...code.matchAll(/from ["']\.\/([A-Za-z-]+\.ts)["']/g)]
      .map((m) => m[1])
      .filter((dep) => files.includes(dep) && dep !== file);
    edges.set(file, [...new Set(deps)]);
    const lines = read(`./${file}`).split("\n").length;
    assert.ok(lines <= 800, `${file} must stay <= 800 lines (now ${lines})`);
  }
  // Depth-first cycle check over the intra-inventory import graph.
  const state = new Map<string, "open" | "closed">();
  const visit = (file: string, trail: string[]): void => {
    if (state.get(file) === "closed") return;
    assert.equal(
      trail.includes(file),
      false,
      `inventory import cycle: ${[...trail, file].join(" -> ")}`,
    );
    for (const dep of edges.get(file) ?? []) visit(dep, [...trail, file]);
    state.set(file, "closed");
  };
  for (const file of files) visit(file, []);
});
