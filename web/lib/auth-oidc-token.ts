import { constants, createPublicKey, verify as verifySignature } from "node:crypto";

type JsonObject = Record<string, unknown>;

export type VerifiedOidcClaims = {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
};

function decodeJson(segment: string): JsonObject | null {
  if (!segment || segment.length > 64_000) return null;
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
  } catch {
    return null;
  }
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Verify an OIDC ID token using the provider's asymmetric JWKS. */
export function verifyOidcIdToken(input: {
  idToken: string;
  issuer: string;
  clientId: string;
  nonce: string;
  keys: JsonObject[];
  nowEpoch?: number;
}): VerifiedOidcClaims | null {
  const segments = input.idToken.split(".");
  if (segments.length !== 3) return null;
  const headerSegment = segments[0]!;
  const payloadSegment = segments[1]!;
  const signatureSegment = segments[2]!;
  const header = decodeJson(headerSegment);
  const claims = decodeJson(payloadSegment);
  if (!header || !claims) return null;
  const algorithm = stringClaim(header.alg);
  const keyId = stringClaim(header.kid);
  if (!algorithm || !keyId || !["RS256", "PS256", "ES256"].includes(algorithm)) return null;
  const jwk = input.keys.find((candidate) => {
    const expectedKeyType = algorithm === "ES256" ? "EC" : "RSA";
    const expectedCurve = algorithm === "ES256" ? "P-256" : undefined;
    return candidate.kid === keyId
      && (!candidate.alg || candidate.alg === algorithm)
      && candidate.kty === expectedKeyType
      && (!expectedCurve || candidate.crv === expectedCurve)
      && (!candidate.use || candidate.use === "sig")
      && (!Array.isArray(candidate.key_ops) || candidate.key_ops.includes("verify"));
  });
  if (!jwk) return null;
  let key;
  try {
    key = createPublicKey({ key: jwk as never, format: "jwk" });
  } catch {
    return null;
  }
  const data = Buffer.from(`${headerSegment}.${payloadSegment}`);
  const signature = Buffer.from(signatureSegment, "base64url");
  const keyOptions = algorithm === "PS256"
    ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
    : algorithm === "ES256"
      ? { key, dsaEncoding: "ieee-p1363" as const }
      : key;
  if (!verifySignature("sha256", data, keyOptions, signature)) return null;

  const now = input.nowEpoch ?? Math.floor(Date.now() / 1000);
  const issuer = stringClaim(claims.iss);
  const subject = stringClaim(claims.sub);
  const nonce = stringClaim(claims.nonce);
  const email = stringClaim(claims.email);
  const expiresAt = typeof claims.exp === "number" ? claims.exp : NaN;
  const issuedAt = typeof claims.iat === "number" ? claims.iat : NaN;
  const notBefore = claims.nbf === undefined ? null : typeof claims.nbf === "number" ? claims.nbf : NaN;
  const audience = typeof claims.aud === "string"
    ? [claims.aud]
    : Array.isArray(claims.aud) && claims.aud.every((entry) => typeof entry === "string")
      ? claims.aud as string[]
      : [];
  if (
    issuer !== input.issuer
    || !subject
    || nonce !== input.nonce
    || !email
    || claims.email_verified !== true
    || !audience.includes(input.clientId)
    || !Number.isFinite(expiresAt)
    || expiresAt < now - 60
    || !Number.isFinite(issuedAt)
    || issuedAt > now + 60
    || (notBefore !== null && (!Number.isFinite(notBefore) || notBefore > now + 60))
  ) return null;
  if (audience.length > 1 && claims.azp !== input.clientId) return null;
  return { issuer, subject, email, emailVerified: true };
}
