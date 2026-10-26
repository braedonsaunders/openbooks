export type GenealogyQueryUpdate = {
  kind?: "lot" | "serial";
  id?: string;
  direction?: "forward" | "backward";
  maxDepth?: number;
};

/** Keep the selected trace settings when one control changes. */
export function genealogyHref(currentSearch: string, update: GenealogyQueryUpdate) {
  const params = new URLSearchParams(
    currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch,
  );
  const nextKind = update.kind ?? params.get("kind") ?? "lot";
  const kindChanged = update.kind !== undefined && update.kind !== params.get("kind");
  params.set("kind", nextKind);
  if (update.id !== undefined) params.set("id", update.id);
  else if (kindChanged) params.delete("id");
  if (update.direction !== undefined) params.set("direction", update.direction);
  if (update.maxDepth !== undefined) params.set("maxDepth", String(update.maxDepth));
  return `/manufacturing/genealogy?${params.toString()}`;
}
