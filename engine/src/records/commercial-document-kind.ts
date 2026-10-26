import { docKindConfig, type DocKindConfig } from "./document-kinds.ts";

export type CommercialDocumentKind = "quote" | "sales_order";
/** Non-posting commercial documents share reference, default and tax editing
 * with sales documents. Their creation and approval remain in the order domain;
 * this internal declaration does not expand the public document-create kinds. */
export function commercialDocumentKindConfig(kind: CommercialDocumentKind): DocKindConfig {
  const sales = docKindConfig("customer_invoice");
  if (!sales) throw new Error("Sales document policy is unavailable");
  return {
    ...sales,
    kind,
    numberPrefix: kind === "quote" ? "EST-" : "SO-",
    hasDueDate: false,
    isOpenItem: false,
    showsBalance: false,
    dueDateFromTerms: false,
  };
}
