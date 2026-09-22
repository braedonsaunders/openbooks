/**
 * Compatibility re-export: the decimal refusal classifier now lives in the
 * engine money module so payroll import paths can share it without an upward
 * edge. Every export and type is preserved here.
 */
export {
  decimalNullCause,
  decimalNullRefusal,
  suppliedValue,
  type DecimalNullCause,
} from "@openbooks/engine/src/money/decimal-refusal.ts";
