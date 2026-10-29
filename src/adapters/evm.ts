import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
  verifyTypedData,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
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

// Only the EIP-3009 surface the Facilitator touches. The v/r/s overload is used for settlement
// because every EIP-3009 token implements it (the packed-bytes overload is FiatTokenV2_2+ only).
const EIP3009_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface EvmAdapterOptions {
  chain: Chain;
  /** EIP-3009 token contract this adapter accepts payments in. */
  asset: Address;
  /** Omit to use the chain's default public RPC. */
  rpcUrl?: string;
  /** Facilitator's gas-paying key. Without it, /verify still works but /settle is refused. */
  settlerPrivateKey?: Hex;
}

export class EvmAdapter implements ChainAdapter {
  readonly asset: Address;
  private readonly chain: Chain;
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private readonly settler?: PrivateKeyAccount;
  // Settlements are sent one at a time so concurrent /settle calls don't race on the
  // settler account's nonce.
  private settleQueue: Promise<unknown> = Promise.resolve();
  // Authorizations already submitted (or being submitted) by this process, so a duplicate
  // /settle doesn't burn gas on a transaction that is bound to revert.
  private readonly submitted = new Set<string>();

  constructor(
    public readonly network: Network,
    opts: EvmAdapterOptions,
  ) {
    this.chain = opts.chain;
    this.asset = opts.asset;
    const transport = http(opts.rpcUrl);
    this.publicClient = createPublicClient({ chain: opts.chain, transport });
    if (opts.settlerPrivateKey) {
      this.settler = privateKeyToAccount(opts.settlerPrivateKey);
      this.walletClient = createWalletClient({ account: this.settler, chain: opts.chain, transport });
    }
  }

  async verifyPayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResult> {
    const { authorization, signature } = payload.payload;

    if (payload.network !== requirements.network) {
      return { isValid: false, reason: "network mismatch" };
    }
    if (requirements.asset.toLowerCase() !== this.asset.toLowerCase()) {
      return { isValid: false, reason: `asset ${requirements.asset} not supported on ${this.network}` };
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

    let isValid: boolean;
    try {
      isValid = await verifyTypedData({
        address: authorization.from as Address,
        domain: {
          name: domainName,
          version: domainVersion,
          chainId: this.chain.id,
          verifyingContract: requirements.asset as Address,
        },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: authorization.from as Address,
          to: authorization.to as Address,
          value: BigInt(authorization.value),
          validAfter,
          validBefore,
          nonce: authorization.nonce as Hex,
        },
        signature: signature as Hex,
      });
    } catch {
      // viem throws, rather than returning false, for malformed signatures (bad length,
      // r/s not on the curve).
      isValid = false;
    }

    if (!isValid) {
      return { isValid: false, reason: "signature verification failed" };
    }

    // On-chain checks: catch payments that are correctly signed but can't settle,
    // so the Resource Server doesn't serve content it will never get paid for.
    try {
      const [used, balance] = await Promise.all([
        this.publicClient.readContract({
          address: this.asset,
          abi: EIP3009_ABI,
          functionName: "authorizationState",
          args: [authorization.from as Address, authorization.nonce as Hex],
        }),
        this.publicClient.readContract({
          address: this.asset,
          abi: EIP3009_ABI,
          functionName: "balanceOf",
          args: [authorization.from as Address],
        }),
      ]);
      if (used) {
        return { isValid: false, reason: "authorization nonce already used" };
      }
      if (balance < BigInt(authorization.value)) {
        return { isValid: false, reason: "insufficient balance" };
      }
    } catch (err) {
      return { isValid: false, reason: `on-chain check failed: ${errorMessage(err)}` };
    }

    return { isValid: true, payer: authorization.from };
  }

  settlePayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResult> {
    const { from, nonce } = payload.payload.authorization;
    const key = `${from.toLowerCase()}:${nonce.toLowerCase()}`;
    if (this.submitted.has(key)) {
      return Promise.resolve({
        success: false,
        network: this.network,
        reason: "authorization already submitted for settlement",
      });
    }
    this.submitted.add(key);

    const run = this.settleQueue
      .then(() => this.settleNow(payload, requirements))
      .then((result) => {
        // Free the key only if nothing reached the chain, so a corrected retry is possible.
        if (!result.success && !result.txHash) this.submitted.delete(key);
        return result;
      });
    this.settleQueue = run.catch(() => undefined);
    return run;
  }

  private async settleNow(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResult> {
    const fail = (reason: string): SettleResult => ({
      success: false,
      network: this.network,
      reason,
    });

    if (!this.walletClient || !this.settler) {
      return fail("facilitator settler key not configured");
    }

    // Never trust that /verify was called first.
    const verification = await this.verifyPayment(payload, requirements);
    if (!verification.isValid) {
      return fail(`verification failed: ${verification.reason}`);
    }

    const { authorization, signature } = payload.payload;
    const { r, s, v, yParity } = parseSignature(signature as Hex);

    try {
      // simulateContract surfaces a revert reason before any gas is spent, and its
      // gas estimate comes from the node rather than a local EVM.
      const { request } = await this.publicClient.simulateContract({
        account: this.settler,
        address: this.asset,
        abi: EIP3009_ABI,
        functionName: "transferWithAuthorization",
        args: [
          authorization.from as Address,
          authorization.to as Address,
          BigInt(authorization.value),
          BigInt(authorization.validAfter),
          BigInt(authorization.validBefore),
          authorization.nonce as Hex,
          Number(v ?? BigInt(yParity) + 27n),
          r,
          s,
        ],
      });
      const txHash = await this.walletClient.writeContract(request);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        return { success: false, network: this.network, txHash, reason: "transaction reverted" };
      }
      return { success: true, network: this.network, txHash };
    } catch (err) {
      return fail(`settlement failed: ${errorMessage(err)}`);
    }
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "shortMessage" in err && typeof err.shortMessage === "string") {
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}
