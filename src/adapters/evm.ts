import { verifyTypedData } from "viem";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "x402-contracts";
import type { ChainAdapter } from "./types.js";

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export class EvmAdapter implements ChainAdapter {
  constructor(
    public readonly network: Network,
    private readonly chainId: number,
  ) {}

  async verifyPayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResult> {
    const { authorization, signature } = payload.payload;

    if (payload.network !== requirements.network) {
      return { isValid: false, reason: "network mismatch" };
    }
    if (authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return { isValid: false, reason: "payTo mismatch" };
    }
    if (authorization.value !== requirements.amount) {
      return { isValid: false, reason: "amount mismatch" };
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const validAfter = BigInt(authorization.validAfter);
    const validBefore = BigInt(authorization.validBefore);
    if (now < validAfter || now > validBefore) {
      return { isValid: false, reason: "authorization expired or not yet valid" };
    }

    const domainName = requirements.extra?.name;
    if (typeof domainName !== "string") {
      return { isValid: false, reason: "requirements.extra.name (EIP-712 domain name) is required" };
    }
    const domainVersion =
      typeof requirements.extra?.version === "string" ? requirements.extra.version : "1";

    const isValid = await verifyTypedData({
      address: authorization.from as `0x${string}`,
      domain: {
        name: domainName,
        version: domainVersion,
        chainId: this.chainId,
        verifyingContract: requirements.asset as `0x${string}`,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as `0x${string}`,
        to: authorization.to as `0x${string}`,
        value: BigInt(authorization.value),
        validAfter,
        validBefore,
        nonce: authorization.nonce as `0x${string}`,
      },
      signature: signature as `0x${string}`,
    });

    if (!isValid) {
      return { isValid: false, reason: "signature verification failed" };
    }
    return { isValid: true, payer: authorization.from };
  }

  async settlePayment(
    _payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResult> {
    return {
      success: false,
      network: requirements.network,
      reason: "settlement not implemented yet (Phase 4)",
    };
  }
}
