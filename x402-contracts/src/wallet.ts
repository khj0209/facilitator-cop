import { z } from "zod";
import { SUPPORTED_NETWORKS } from "./chains.js";

export const SignRequestSchema = z.object({
  agentId: z.string(),
  chain: z.enum(SUPPORTED_NETWORKS),
  payload: z.unknown(),
  approvalToken: z.string(),
});

export type SignRequest = z.infer<typeof SignRequestSchema>;

export interface KeyStoreProvider {
  readonly type: "local" | "custodial" | "external-wallet";
  getAddress(agentId: string): Promise<string>;
  sign(req: SignRequest): Promise<{ signature: string }>;
}

export const DelegationPolicySchema = z.object({
  agentId: z.string(),
  allowedResources: z.array(z.string()),
  maxAmountPerTx: z.string(),
  maxAmountPerWindow: z.string(),
  windowSeconds: z.number().int().positive(),
  allowedChains: z.array(z.enum(SUPPORTED_NETWORKS)),
  expiresAt: z.number().int(),
  nonce: z.string(),
});

export type DelegationPolicy = z.infer<typeof DelegationPolicySchema>;

export interface ApprovalTokenClaims {
  agentId: string;
  resource: string;
  maxAmount: string;
  chain: (typeof SUPPORTED_NETWORKS)[number];
  nonce: string;
}
