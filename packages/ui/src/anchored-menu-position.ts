/** Desktop menu bounds. Keep the full menu reachable near any viewport edge. */
export function anchoredMenuPosition(
  anchor: { top: number; bottom: number; left: number; width: number },
  viewport: { width: number; height: number },
  desiredHeight: number,
): { top: number; left: number; width: number; maxHeight: number } {
  const padding = Math.min(8, viewport.width / 2, viewport.height / 2);
  const gap = 6;
  const availableHeight = Math.max(0, viewport.height - padding * 2);
  const below = Math.max(0, Math.min(availableHeight, viewport.height - padding - anchor.bottom - gap));
  const above = Math.max(0, Math.min(availableHeight, anchor.top - gap - padding));
  const useBelow = desiredHeight <= below || below >= above;
  const maxHeight = useBelow ? below : above;
  const height = Math.min(Math.max(0, desiredHeight), maxHeight);
  const width = Math.min(Math.max(anchor.width, 208), Math.max(0, viewport.width - padding * 2));
  const top = useBelow ? anchor.bottom + gap : anchor.top - gap - height;
  return {
    top: Math.max(padding, Math.min(top, viewport.height - padding - height)),
    left: Math.max(padding, Math.min(anchor.left, viewport.width - padding - width)),
    width,
    maxHeight,
  };
}
