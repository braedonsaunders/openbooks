/** Static feature catalog for client and server callers.
 *
 * This module re-exports only the dependency-free registry data: feature keys,
 * categories and static requirements. It must stay free of database, network
 * and Node-only imports so client components can use it without dragging
 * server code into the browser bundle. Gate enforcement that touches the
 * database lives in `./public-features.ts` instead.
 */
export { FEATURE_CATEGORIES, FEATURE_GROUPS } from "./feature-registry.ts";
export type { FeatureCategory, FeatureGroup } from "./feature-registry.ts";
