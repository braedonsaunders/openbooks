import { isUuid } from "@openbooks/engine/src/platform/uuid.ts";

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

export function parseSessionTokenFormat(token: string | undefined): ParsedSessionToken | null {
  if (!token || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "v2") return null;
  const sessionId = parts[1]!;
  const userId = parts[2]!;
  const rawExpires = parts[3]!;
  const signature = parts[4]!;
  const expiresEpoch = Number(rawExpires);
  if (!isUuid(sessionId) || !isUuid(userId) || !Number.isSafeInteger(expiresEpoch) || !signature) return null;
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
  const challengeId = parts[1]!;
  const userId = parts[2]!;
  const rawExpires = parts[3]!;
  const signature = parts[4]!;
  const expiresEpoch = Number(rawExpires);
  if (!isUuid(challengeId) || !isUuid(userId) || !Number.isSafeInteger(expiresEpoch) || !signature) return null;
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
