export type ParsedSessionToken = {
  sessionId: string;
  userId: string;
  expiresEpoch: number;
  payload: string;
  signature: string;
};

export type ParsedChallengeToken = {
  challengeId: string;
  userId: string;
  expiresEpoch: number;
  payload: string;
  signature: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseSessionTokenFormat(token: string | undefined): ParsedSessionToken | null {
  if (!token || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "v2") return null;
  const [, sessionId, userId, rawExpires, signature] = parts;
  const expiresEpoch = Number(rawExpires);
  if (!UUID.test(sessionId) || !UUID.test(userId) || !Number.isSafeInteger(expiresEpoch) || !signature) return null;
  return {
    sessionId,
    userId,
    expiresEpoch,
    payload: `v2.${sessionId}.${userId}.${rawExpires}`,
    signature,
  };
}

export function parseChallengeTokenFormat(token: string | undefined): ParsedChallengeToken | null {
  if (!token || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "m1") return null;
  const [, challengeId, userId, rawExpires, signature] = parts;
  const expiresEpoch = Number(rawExpires);
  if (!UUID.test(challengeId) || !UUID.test(userId) || !Number.isSafeInteger(expiresEpoch) || !signature) return null;
  return {
    challengeId,
    userId,
    expiresEpoch,
    payload: `m1.${challengeId}.${userId}.${rawExpires}`,
    signature,
  };
}

export const sessionSigningInput = (payload: string) => `openbooks:session:${payload}`;
export const challengeSigningInput = (payload: string) => `openbooks:mfa-challenge:${payload}`;
