/**
 * F1 opens the help for the field that holds focus. Field help buttons sit
 * outside the Tab order, so this is how a keyboard user reaches them. The
 * field is matched to its help through the same names assistive technology
 * uses: its `aria-labelledby` labels, then a `<label for>`, then the nearest
 * enclosing field container with exactly one help button.
 */
export function fieldHelpButtonFor(field: Element | null): HTMLElement | null {
  if (!field || field === field.ownerDocument.body) return null;
  const document = field.ownerDocument;
  const helpIn = (element: Element | null | undefined): HTMLElement | null =>
    element ? element.querySelector<HTMLElement>("[data-field-help]") : null;

  for (const id of (field.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) {
    const label = document.getElementById(id);
    const help = helpIn(label) ?? helpIn(label?.parentElement);
    if (help) return help;
  }
  if (field.id) {
    const label = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
    const help = helpIn(label?.parentElement);
    if (help) return help;
  }
  let container = field.parentElement;
  for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
    const helps = container.querySelectorAll<HTMLElement>("[data-field-help]");
    if (helps.length === 1) return helps[0]!;
    if (helps.length > 1) return null;
  }
  return null;
}

/** Open the focused field's help; true when there was one to open. */
export function openFocusedFieldHelp(field: Element | null): boolean {
  const help = fieldHelpButtonFor(field);
  if (!help) return false;
  help.click();
  return true;
}
