export type BaselineCatalog = Record<string, Record<string, unknown>[]> & {
  openbooks_query_catalog_relations: { relation: string; added_in: string }[];
};
export const BASELINE_REGISTRIES: Readonly<Record<string, readonly string[]>>;
export function baselineDigest(value: string | Uint8Array): string;
export function baselineCatalog(client: { query(text: string): Promise<{ rows: Record<string, unknown>[] }> }): Promise<BaselineCatalog>;
export function assertBaselineCatalogsEqual(expected: BaselineCatalog, actual: BaselineCatalog): void;
export function baselineRegistrySql(catalog: BaselineCatalog): string;
