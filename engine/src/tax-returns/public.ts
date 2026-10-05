/** EU One-Stop Shop return computation and export for the web layer. */
export {
  computeOssReturn,
  recordOssFxEvidence,
  ossReturnToCsv,
  type OssScheme,
  type OssReturnRequest,
  type OssReturnLine,
  type OssReturn,
  type OssFxEvidence,
} from "./oss-return.ts";
export {
  ossReturnToMemberState,
  ossReturnToMemberStateCsv,
  ossReturnToIrelandXml,
  type OssMemberState,
} from "./oss-exports.ts";
export { enactedIncomeTaxRate, type EnactedRate } from "./income-tax-provision.ts";
