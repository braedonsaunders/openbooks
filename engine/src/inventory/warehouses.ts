// Stable warehouse facade: admission policy lives in
// warehouse-admission.ts, master data in warehouse-records.ts, status
// transitions and defaults in warehouse-lifecycle.ts, and positions and the
// stock tie-out in warehouse-positions.ts, so each operation module stays
// within the module line budget. Every warehouse import keeps working
// through this module.
export {
  WarehouseRefusal,
  warehouseAdmits,
  assertWarehouseAdmitsMovement,
  assertWarehousingFeature,
  type StockMovementDirection,
  type WarehouseStatus,
} from "./warehouse-admission.ts";
export {
  listWarehouses,
  getWarehouse,
  warehouseOf,
  listWarehouseLocations,
  createWarehouse,
  updateWarehouseDetails,
  type WarehouseAddress,
  type WarehouseRecord,
  type WarehouseLocationRecord,
  type CreateWarehouseInput,
} from "./warehouse-records.ts";
export {
  activateWarehouse,
  suspendWarehouse,
  retireWarehouse,
  resolveDefaultWarehouse,
  ensureDefaultWarehouse,
  type WarehouseTransitionInput,
} from "./warehouse-lifecycle.ts";
export {
  warehousePositions,
  assertStockLocationDeletionAllowed,
  warehouseStockTieOut,
  type WarehousePosition,
  type WarehouseTieOutRow,
  type WarehouseTieOut,
} from "./warehouse-positions.ts";
