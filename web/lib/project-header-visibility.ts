/**
 * Project header visibility against an operating profile's presentation flags.
 *
 * The foreman field belongs to the one shared project field set (the
 * `project` record type's header fields), so it renders for every project
 * flavour — shop jobs included. A type hides it only by omitting the
 * `foreman_id` placement from its form layout, which never reaches this
 * helper. The site and customer-PO fields keep their profile presentation
 * switches; only foreman moved to the shared set.
 */
export interface ProjectPresentationFlags {
  showSite: boolean;
  showForeman: boolean;
  showCustomerPo: boolean;
}

export function profileHidesProjectHeaderField(
  key: string,
  presentation: ProjectPresentationFlags | null | undefined,
): boolean {
  if (!presentation) return false;
  if (key === "site_jurisdiction" && !presentation.showSite) return true;
  if (key === "customer_po_number" && !presentation.showCustomerPo) return true;
  return false;
}
