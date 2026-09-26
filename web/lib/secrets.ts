import "server-only";

/**
 * Server-only secret sealing for web-side use. The implementation lives in
 * the engine so the web app (sealing on a tenant's save) and the background
 * worker (unsealing at run time) share one wire format, one key ring, and
 * one refusal shape — see engine/src/platform/secrets.ts.
 */
export {
  describeSealedBlob,
  isNamedNonProductionEnvironment,
  keyedFingerprint,
  loadDataKeyRing,
  requireDataKey,
  sealJson,
  sealSecret,
  SEALED_V1_PREFIX,
  SEALED_V2_PREFIX,
  SecretIntegrityError,
  unsealJson,
  unsealSecret,
  type SecretScope,
} from "@openbooks/engine/src/platform/secrets.ts";
