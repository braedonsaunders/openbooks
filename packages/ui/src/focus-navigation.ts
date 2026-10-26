/**
 * Field-to-field focus movement for data entry. Pickers and "Enter moves to
 * the next field" use it so focus lands where Tab would have taken it, inside
 * the same dialog or drawer, without ever escaping to the page behind.
 */

const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
  '[contenteditable="true"]',
].join(",");

function isTabbable(element: HTMLElement): boolean {
  const tabIndex = element.getAttribute("tabindex");
  if (tabIndex !== null && Number(tabIndex) < 0) return false;
  if (element.closest('[inert],[aria-hidden="true"]')) return false;
  if (element.closest("[data-ui-overlay]") && !element.closest('[role="dialog"]')) return false;
  // Collapsed <details> content is not reachable by Tab either.
  const details = element.closest("details");
  if (details && !details.open && !element.closest("summary")) return false;
  return isRendered(element);
}

/**
 * Rendered and visible. Browsers answer with `checkVisibility()`; elsewhere
 * (server-side test DOMs without layout) hidden ancestors and display or
 * visibility styles decide.
 */
function isRendered(element: HTMLElement): boolean {
  if (typeof element.checkVisibility === "function")
    return element.checkVisibility({ visibilityProperty: true });
  const view = element.ownerDocument.defaultView;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden) return false;
    const style = view?.getComputedStyle(node);
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  }
  return true;
}

/** The region focus movement stays inside: the nearest dialog or drawer, else the document. */
function scopeOf(element: Element): ParentNode {
  return element.closest('[role="dialog"]') ?? element.ownerDocument;
}

/** Tabbable elements in the same scope as `from`, in document order. */
export function tabbableSiblings(from: Element): HTMLElement[] {
  return Array.from(scopeOf(from).querySelectorAll<HTMLElement>(TABBABLE)).filter(isTabbable);
}

/**
 * Move focus to the next (or previous) tabbable element after `from`.
 * Returns the element that received focus, or null when there is none.
 */
export function focusAdjacentField(from: Element, direction: 1 | -1 = 1): HTMLElement | null {
  const items = tabbableSiblings(from);
  let index = items.indexOf(from as HTMLElement);
  if (index === -1) {
    // `from` itself may be untabbable (a closed menu's search box): find its
    // position by document order.
    index = items.findIndex(
      (item) => from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    if (index === -1) index = items.length;
    if (direction === 1) index -= 1;
  }
  const target = items[index + direction];
  if (!target) return null;
  target.focus();
  if (
    target instanceof HTMLInputElement &&
    typeof target.select === "function" &&
    target.type !== "checkbox" &&
    target.type !== "radio"
  ) {
    target.select();
  }
  return target;
}
