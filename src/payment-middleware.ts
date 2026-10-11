import type { FastifyReply, FastifyRequest } from "fastify";
import {
  PaymentPayloadSchema,
  type PaymentPayload,
  type PaymentRequirements,
  type VerifyResult,
} from "x402-contracts";
import { config } from "./config.js";

declare module "fastify" {
  interface FastifyRequest {
    paymentContext?: { payload: PaymentPayload; requirements: PaymentRequirements };
  }
}

interface PaymentOptions {
  price: (req: FastifyRequest) => string;
}

export function requirePayment(opts: PaymentOptions) {
  return async function paymentPreHandler(req: FastifyRequest, reply: FastifyReply) {
    let amount: string;
    try {
      amount = opts.price(req);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : "invalid request" });
    }

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: config.network,
      amount,
      asset: config.assetAddress,
      payTo: config.payToAddress,
      maxTimeoutSeconds: 300,
      extra: { name: config.tokenName, version: "1" },
    };

    const header = req.headers["x-payment"];
    if (!header || typeof header !== "string") {
      return reply.code(402).send({ error: "payment required", requirements });
    }

    let payload: PaymentPayload;
    try {
      const decoded = Buffer.from(header, "base64").toString("utf8");
      payload = PaymentPayloadSchema.parse(JSON.parse(decoded));
    } catch {
      return reply.code(402).send({ error: "invalid X-PAYMENT header", requirements });
    }

    const verifyRes = (await fetch(`${config.facilitatorUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, requirements }),
    }).then((r) => r.json())) as VerifyResult;

    if (!verifyRes.isValid) {
      return reply
        .code(402)
        .send({ error: verifyRes.reason ?? "payment invalid", requirements });
    }

    req.paymentContext = { payload, requirements };
  };
}

export async function settlePaymentOnResponse(req: FastifyRequest) {
  const ctx = req.paymentContext;
  if (!ctx) return;
  fetch(`${config.facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ctx),
  }).catch((err) => req.log.error({ err }, "settle call failed"));
}
