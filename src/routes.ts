import type { FastifyInstance } from "fastify";
import { FacilitatorRequestSchema, type Network } from "x402-contracts";
import type { ChainAdapter } from "./adapters/types.js";

export function registerRoutes(
  app: FastifyInstance,
  adapters: Partial<Record<Network, ChainAdapter>>,
) {
  app.get("/health", async () => ({ status: "ok", service: "facilitator" }));

  app.get("/supported", async () => ({
    kinds: Object.values(adapters).map((adapter) => ({
      scheme: "exact",
      network: adapter.network,
      asset: adapter.asset,
    })),
  }));

  app.post("/verify", async (req, reply) => {
    const parsed = FacilitatorRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ isValid: false, reason: "invalid request body" });
    }
    const { payload, requirements } = parsed.data;
    const adapter = adapters[requirements.network];
    if (!adapter) {
      return reply
        .code(400)
        .send({ isValid: false, reason: `network ${requirements.network} not supported` });
    }
    const result = await adapter.verifyPayment(payload, requirements);
    const { from: payer, value: amount, nonce } = payload.payload.authorization;
    if (result.isValid) {
      req.log.info(
        { event: "verify.passed", network: requirements.network, payer, amount, nonce },
        "payment verified (signature, amount, payee, balance, nonce)",
      );
    } else {
      req.log.warn({ event: "verify.failed", payer, reason: result.reason, nonce }, "payment verification failed");
    }
    return result;
  });

  app.post("/settle", async (req, reply) => {
    const parsed = FacilitatorRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, reason: "invalid request body" });
    }
    const { payload, requirements } = parsed.data;
    const adapter = adapters[requirements.network];
    if (!adapter) {
      return reply
        .code(400)
        .send({ success: false, network: requirements.network, reason: `network ${requirements.network} not supported` });
    }
    const { from: payer, value: amount, nonce } = payload.payload.authorization;
    req.log.info({ event: "settle.requested", network: requirements.network, payer, amount, nonce }, "settlement requested");
    return adapter.settlePayment(payload, requirements);
  });
}
