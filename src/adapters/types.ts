import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "x402-contracts";

export interface ChainAdapter {
  readonly network: Network;
  verifyPayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResult>;
  settlePayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResult>;
}
