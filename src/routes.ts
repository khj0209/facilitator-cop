import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DelegationPolicySchema,
  SUPPORTED_NETWORKS,
  type ApprovalTokenClaims,
  type PaymentPayload,
} from "x402-contracts";
import { issueApprovalToken } from "./delegation/approvalToken.js";
import { authorize, commitSpend, createDelegation, revokeDelegation } from "./delegation/store.js";
import { LocalKeyStoreProvider } from "./keyCustody/localProvider.js";

const localProvider = new LocalKeyStoreProvider(
  process.env.KEYSTORE_DIR ?? "./data/keystore",
  process.env.KEYSTORE_PASSPHRASE ?? "dev-only-insecure-passphrase-change-me",
);

const CHAIN_ID_BY_NETWORK: Record<string, number> = { ethereum: 11155111, giwa: 91342 };

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

const CreateWalletSchema = z.object({
  agentId: z.string(),
  keyStoreProvider: z.literal("local"),
});

const SignPaymentSchema = z.object({
  agentId: z.string(),
  resource: z.string(),
  requirements: z.object({
    scheme: z.literal("exact"),
    network: z.enum(SUPPORTED_NETWORKS),
    amount: z.string(),
    asset: z.string(),
    payTo: z.string(),
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.record(z.unknown()).optional(),
  }),
});

export function registerRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok", service: "agent-wallet" }));

  app.post("/wallets", async (req, reply) => {
    const parsed = CreateWalletSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request body" });
    }
    try {
      const { address } = await localProvider.createWallet(parsed.data.agentId);
      return { agentId: parsed.data.agentId, address, keyStoreProvider: "local" };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : "failed" });
    }
  });

  app.post("/delegations", async (req, reply) => {
    const parsed = DelegationPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid delegation policy", issues: parsed.error.issues });
    }
    const { id } = createDelegation(parsed.data);
    return { id, policy: parsed.data };
  });

  app.delete("/delegations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!revokeDelegation(id)) {
      return reply.code(404).send({ error: "delegation not found" });
    }
    return { revoked: true };
  });

  app.post("/sign-payment", async (req, reply) => {
    const parsed = SignPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request body" });
    }
    const { agentId, resource, requirements } = parsed.data;
    const amount = BigInt(requirements.amount);

    const authResult = authorize(agentId, resource, requirements.network, amount);
    if (!authResult.ok) {
      return reply.code(403).send({ error: authResult.reason });
    }

    let address: string;
    try {
      address = await localProvider.getAddress(agentId);
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : "wallet not found" });
    }

    const domainName = requirements.extra?.name;
    if (typeof domainName !== "string") {
      return reply
        .code(400)
        .send({ error: "requirements.extra.name (EIP-712 domain name) is required" });
    }
    const domainVersion =
      typeof requirements.extra?.version === "string" ? requirements.extra.version : "1";

    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: address,
      to: requirements.payTo,
      value: requirements.amount,
      validAfter: String(now - 5),
      validBefore: String(now + requirements.maxTimeoutSeconds),
      nonce: `0x${randomBytes(32).toString("hex")}`,
    };

    const claims: ApprovalTokenClaims = {
      agentId,
      resource,
      maxAmount: requirements.amount,
      chain: requirements.network,
      nonce: randomUUID(),
    };
    const approvalToken = issueApprovalToken(claims);

    let signature: string;
    try {
      const result = await localProvider.sign({
        agentId,
        chain: requirements.network,
        approvalToken,
        payload: {
          domain: {
            name: domainName,
            version: domainVersion,
            chainId: CHAIN_ID_BY_NETWORK[requirements.network],
            verifyingContract: requirements.asset,
          },
          types: TRANSFER_WITH_AUTHORIZATION_TYPES,
          primaryType: "TransferWithAuthorization",
          message: {
            ...authorization,
            value: BigInt(authorization.value),
            validAfter: BigInt(authorization.validAfter),
            validBefore: BigInt(authorization.validBefore),
          },
        },
      });
      signature = result.signature;
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : "signing failed" });
    }

    if (authResult.policyId) {
      commitSpend(authResult.policyId, amount);
    }

    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      resource,
      network: requirements.network,
      payload: { signature, authorization },
    };

    return {
      paymentPayload,
      xPayment: Buffer.from(JSON.stringify(paymentPayload)).toString("base64"),
    };
  });
}
