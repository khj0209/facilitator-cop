import { z } from "zod";
import { SUPPORTED_NETWORKS } from "./chains.js";

export const PaymentRequirementsSchema = z.object({
  scheme: z.literal("exact"),
  network: z.enum(SUPPORTED_NETWORKS),
  amount: z.string(),
  asset: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.unknown()).optional(),
});

export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

export const EIP3009AuthorizationSchema = z.object({
  from: z.string(),
  to: z.string(),
  value: z.string(),
  validAfter: z.string(),
  validBefore: z.string(),
  nonce: z.string(),
});

export type EIP3009Authorization = z.infer<typeof EIP3009AuthorizationSchema>;

export const PaymentPayloadSchema = z.object({
  x402Version: z.number().int(),
  resource: z.string(),
  network: z.enum(SUPPORTED_NETWORKS),
  payload: z.object({
    signature: z.string(),
    authorization: EIP3009AuthorizationSchema,
  }),
});

export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export const VerifyResultSchema = z.object({
  isValid: z.boolean(),
  payer: z.string().optional(),
  reason: z.string().optional(),
});

export type VerifyResult = z.infer<typeof VerifyResultSchema>;

export const SettleResultSchema = z.object({
  success: z.boolean(),
  txHash: z.string().optional(),
  network: z.enum(SUPPORTED_NETWORKS),
  reason: z.string().optional(),
});

export type SettleResult = z.infer<typeof SettleResultSchema>;

export const SupportedKindSchema = z.object({
  scheme: z.literal("exact"),
  network: z.enum(SUPPORTED_NETWORKS),
  asset: z.string(),
});

export type SupportedKind = z.infer<typeof SupportedKindSchema>;
