/**
 * Product families with ordered options (Size × Color). Stable surface for
 * the item catalog UI, the API routes, the commerce sync, and the public
 * barrel: every name below resolved here before the split and resolves
 * here after it. The responsibilities live in six modules —
 * item-family-model.ts (feature gate, errors, validation, option
 * normalization, record shapes, naming, combinations), item-family-store.ts
 * (audit writer, row lock, option/variant loaders, the composed read),
 * item-family-lifecycle.ts (create, edit, convert, create-with-variants),
 * item-family-options.ts (replace the ordered option set),
 * item-family-generation.ts (preview and generate variants),
 * item-family-variants.ts (bulk edit, detach).
 */
export {
  ItemFamilyError,
  assertItemVariantsFeature,
  assertItemVariantsReadable,
  VARIANT_KINDS,
  FAMILY_STATUSES,
  DEFAULT_VARIANT_CODE_PATTERN,
  normalizeFamilyOptions,
  renderVariantCode,
  slugifyCodeSegment,
  variantDisplayName,
  cartesianCombinations,
  textArrayLiteral,
  type VariantKind,
  type BulkBarcodeInput,
  type FamilyOptionInput,
  type FamilyOptionValueInput,
  type NormalizedOption,
  type NormalizedOptionValue,
  type OptionCombination,
  type ItemFamilyRecord,
  type FamilyOptionRecord,
  type VariantRecord,
  type ItemFamilyDetail,
} from "./item-family-model.ts";
export { getItemFamily, listItemFamilies } from "./item-family-store.ts";
export {
  createItemFamily,
  updateItemFamily,
  convertItemToFamily,
  createFamilyWithVariants,
  type CreateFamilyInput,
  type UpdateFamilyInput,
  type ConvertItemInput,
  type CreateVariantChoice,
  type CreateFamilyWithVariantsInput,
} from "./item-family-lifecycle.ts";
export { replaceFamilyOptions } from "./item-family-options.ts";
export {
  generateFamilyVariants,
  previewGenerateVariants,
  type GenerateVariantsInput,
  type GeneratedVariant,
  type MissingCombination,
} from "./item-family-generation.ts";
export {
  bulkEditVariants,
  detachVariant,
  type BulkEditVariantsInput,
} from "./item-family-variants.ts";
