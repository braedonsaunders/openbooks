export type CatalogNativeTable = "items" | "item_families";
export type CatalogObjectType = "product" | "variant";

/** Products link to a family; variants link to their individual catalog item. */
export function catalogNativeTable(objectType: CatalogObjectType): CatalogNativeTable {
  return objectType === "product" ? "item_families" : "items";
}
