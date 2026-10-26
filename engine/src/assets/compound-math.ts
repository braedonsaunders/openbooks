import { add, apportion, cmp, fromUnits, isZero, toUnits } from "../money/money.ts";
import { refuse } from "./asset-refusal.ts";

/**
 * Pure rules for compound assets: which attachments are allowed, how a
 * parent rolls up its components per book, and how one sale price splits
 * across the assets a compound disposal derecognizes. No database here, so
 * the invariants are unit-tested exactly.
 */

export const COMPONENT_ATTACHABLE_STATUSES = ["draft", "in_service", "fully_depreciated"] as const;
export const PARENT_OPEN_STATUSES = ["draft", "in_service", "fully_depreciated"] as const;

export interface ComponentCandidate {
  id: string;
  assetNumber: string;
  subsidiaryId: string;
  status: string;
  parentAssetId: string | null;
  /** Ids of assets that name this one as their parent. */
  childIds: readonly string[];
  /** Books holding a depreciation schedule for this asset (empty for drafts). */
  scheduledBookIds: readonly string[];
}

/**
 * Refuse every attachment that would break the one-level, same-entity,
 * same-books shape of a compound asset. Cycles are refused by name even
 * though one level makes them structurally impossible: an operator who picks
 * a component's own parent deserves the precise reason.
 */
export function assertComponentAttachable(
  parent: ComponentCandidate,
  child: ComponentCandidate,
): void {
  if (parent.id === child.id) {
    refuse("component_self", `asset ${child.assetNumber} cannot be a component of itself`);
  }
  if (parent.parentAssetId === child.id || child.childIds.includes(parent.id)) {
    refuse(
      "component_cycle",
      `asset ${parent.assetNumber} is already a component of ${child.assetNumber}; attaching would form a cycle`,
    );
  }
  if (parent.parentAssetId !== null) {
    refuse(
      "component_nesting",
      `asset ${parent.assetNumber} is itself a component; attach ${child.assetNumber} to its parent instead`,
    );
  }
  if (child.childIds.length > 0) {
    refuse(
      "component_nesting",
      `asset ${child.assetNumber} owns components and cannot become a component`,
      {
        remedy: "Detach its components first, or attach them directly to the new parent.",
      },
    );
  }
  if (child.parentAssetId !== null && child.parentAssetId !== parent.id) {
    refuse(
      "component_already_attached",
      `asset ${child.assetNumber} is already a component of another asset`,
      {
        remedy: "Detach it from its current parent first.",
      },
    );
  }
  if (parent.subsidiaryId !== child.subsidiaryId) {
    refuse(
      "component_cross_subsidiary",
      `asset ${child.assetNumber} belongs to a different legal entity than ${parent.assetNumber}`,
      {
        remedy:
          "Transfer the asset to the parent's legal entity first; components always share their parent's entity.",
      },
    );
  }
  if (!(PARENT_OPEN_STATUSES as readonly string[]).includes(parent.status)) {
    refuse(
      "component_parent_status",
      `asset ${parent.assetNumber} is ${parent.status} and cannot take components`,
    );
  }
  if (!(COMPONENT_ATTACHABLE_STATUSES as readonly string[]).includes(child.status)) {
    refuse(
      "component_status",
      `asset ${child.assetNumber} is ${child.status} and cannot become a component`,
    );
  }
  if (parent.scheduledBookIds.length > 0 && child.scheduledBookIds.length > 0) {
    const parentBooks = [...new Set(parent.scheduledBookIds)].sort();
    const childBooks = [...new Set(child.scheduledBookIds)].sort();
    if (parentBooks.join(",") !== childBooks.join(",")) {
      refuse(
        "component_books_mismatch",
        `asset ${child.assetNumber} is depreciated in different accounting books than ${parent.assetNumber}`,
        {
          remedy:
            "Rebuild both depreciation schedules so they cover the same active books, then attach again.",
        },
      );
    }
  }
}

export interface BookValueRow {
  assetId: string;
  bookId: string;
  cost: string;
  accumulated: string;
  carryingValue: string;
}

export interface BookRollup {
  bookId: string;
  cost: string;
  accumulated: string;
  carryingValue: string;
  assets: number;
}

/** Sum cost, accumulated depreciation and carrying value per book across a parent and its components. */
export function rollUpCompound(rows: readonly BookValueRow[]): BookRollup[] {
  const byBook = new Map<string, BookRollup>();
  for (const row of rows) {
    const current = byBook.get(row.bookId) ?? {
      bookId: row.bookId,
      cost: "0.0000",
      accumulated: "0.0000",
      carryingValue: "0.0000",
      assets: 0,
    };
    byBook.set(row.bookId, {
      bookId: row.bookId,
      cost: add(current.cost, row.cost),
      accumulated: add(current.accumulated, row.accumulated),
      carryingValue: add(current.carryingValue, row.carryingValue),
      assets: current.assets + 1,
    });
  }
  return [...byBook.values()].sort((a, b) => a.bookId.localeCompare(b.bookId));
}

/**
 * Split one sale price across the assets a compound disposal derecognizes,
 * in proportion to net book value; when every carrying value is zero, in
 * proportion to cost; when cost is zero too, the parent (first entry) takes
 * it all. Exact to the cent with largest-remainder dealing, so the parts
 * always sum to the price and each asset's gain or loss is deterministic.
 */
export function apportionProceeds(
  proceeds: string,
  assets: readonly { assetId: string; carryingValue: string; cost: string }[],
): { assetId: string; proceeds: string }[] {
  if (assets.length === 0) return [];
  if (cmp(proceeds, "0") < 0) refuse("proceeds_negative", "proceeds must not be negative");
  const units = toUnits(proceeds);
  if (units % 100n !== 0n) refuse("proceeds_precision", "proceeds must be stated to the cent");
  const cents = units / 100n;
  const positive = (value: string) => {
    const amount = toUnits(value);
    return amount > 0n ? amount : 0n;
  };
  let weights = assets.map((asset) => positive(asset.carryingValue));
  if (weights.every((weight) => weight === 0n))
    weights = assets.map((asset) => positive(asset.cost));
  if (weights.every((weight) => weight === 0n))
    weights = assets.map((_, index) => (index === 0 ? 1n : 0n));
  const parts = isZero(proceeds) ? assets.map(() => 0n) : apportion(cents, weights);
  return assets.map((asset, index) => ({
    assetId: asset.assetId,
    proceeds: fromUnits(parts[index]! * 100n),
  }));
}
