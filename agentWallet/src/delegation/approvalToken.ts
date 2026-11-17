import jwt from "jsonwebtoken";
import type { ApprovalTokenClaims } from "x402-contracts";

const SECRET = process.env.APPROVAL_TOKEN_SECRET ?? "dev-only-insecure-secret-change-me";
export const TOKEN_TTL_SECONDS = 30;

export function issueApprovalToken(claims: ApprovalTokenClaims): string {
  return jwt.sign(claims, SECRET, { expiresIn: TOKEN_TTL_SECONDS });
}

export function verifyApprovalToken(token: string): ApprovalTokenClaims {
  const decoded = jwt.verify(token, SECRET);
  if (typeof decoded === "string") {
    throw new Error("invalid approval token payload");
  }
  const { agentId, resource, maxAmount, chain, nonce } = decoded as Record<string, unknown>;
  if (
    typeof agentId !== "string" ||
    typeof resource !== "string" ||
    typeof maxAmount !== "string" ||
    typeof chain !== "string" ||
    typeof nonce !== "string"
  ) {
    throw new Error("malformed approval token claims");
  }
  return { agentId, resource, maxAmount, chain: chain as ApprovalTokenClaims["chain"], nonce };
}
