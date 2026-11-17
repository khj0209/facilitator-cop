import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "x402-contracts";

/** Subset of the pino/Fastify logger that adapters log settlement progress through. */
export interface AdapterLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ChainAdapter {
  readonly network: Network;
  /** EIP-3009 token contract accepted on this network. */
  readonly asset: string;
  verifyPayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResult>;
  settlePayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResult>;
}
