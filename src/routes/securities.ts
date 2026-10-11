import type { FastifyInstance } from "fastify";
import { requirePayment } from "../payment-middleware.js";

const QUOTES: Record<string, number> = {
  AAPL: 178.32,
  TSLA: 241.05,
  "005930": 81200,
};

const PORTFOLIO = [
  { symbol: "AAPL", quantity: 10, avgPrice: 165.2 },
  { symbol: "TSLA", quantity: 3, avgPrice: 210.0 },
];

export function registerSecuritiesRoutes(app: FastifyInstance) {
  app.get(
    "/securities/quotes/:symbol",
    { preHandler: requirePayment({ price: () => "10000000000000000" }) },
    async (req) => {
      const { symbol } = req.params as { symbol: string };
      const price = QUOTES[symbol.toUpperCase()];
      if (price === undefined) {
        return { symbol, price: null, error: "unknown symbol" };
      }
      return { symbol: symbol.toUpperCase(), price, timestamp: Date.now() };
    },
  );

  app.get(
    "/securities/portfolio",
    { preHandler: requirePayment({ price: () => "10000000000000000" }) },
    async () => ({ holdings: PORTFOLIO }),
  );

  app.post(
    "/securities/orders",
    { preHandler: requirePayment({ price: () => "1000000000000000000" }) },
    async (req) => {
      const body = req.body as { symbol: string; side: "buy" | "sell"; quantity: number };
      return {
        orderId: `ord_${Math.random().toString(36).slice(2, 10)}`,
        status: "filled",
        ...body,
      };
    },
  );
}
