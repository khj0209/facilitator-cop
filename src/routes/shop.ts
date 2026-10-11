import type { FastifyInstance } from "fastify";
import { requirePayment } from "../payment-middleware.js";

interface Product {
  id: string;
  name: string;
  priceAtomic: string;
}

interface CartItem {
  productId: string;
  quantity: number;
}

interface Order {
  id: string;
  items: CartItem[];
  totalAtomic: string;
}

const PRODUCTS: Product[] = [
  { id: "p1", name: "무선 키보드", priceAtomic: "50000000000000000" },
  { id: "p2", name: "USB-C 허브", priceAtomic: "30000000000000000" },
  { id: "p3", name: "노트북 스탠드", priceAtomic: "20000000000000000" },
];

const ORDERS = new Map<string, Order>();

function cartTotal(items: CartItem[]): bigint {
  return items.reduce((sum, item) => {
    const product = PRODUCTS.find((p) => p.id === item.productId);
    if (!product) throw new Error(`unknown product ${item.productId}`);
    return sum + BigInt(product.priceAtomic) * BigInt(item.quantity);
  }, 0n);
}

export function registerShopRoutes(app: FastifyInstance) {
  app.get("/shop/products", async () => ({ products: PRODUCTS }));

  app.post(
    "/shop/cart/checkout",
    {
      preHandler: requirePayment({
        price: (req) => cartTotal((req.body as { items: CartItem[] }).items).toString(),
      }),
    },
    async (req) => {
      const { items } = req.body as { items: CartItem[] };
      const orderId = `order_${Math.random().toString(36).slice(2, 10)}`;
      const order: Order = { id: orderId, items, totalAtomic: cartTotal(items).toString() };
      ORDERS.set(orderId, order);
      return { orderId, status: "paid", totalAtomic: order.totalAtomic };
    },
  );

  app.get(
    "/shop/orders/:id",
    { preHandler: requirePayment({ price: () => "5000000000000000" }) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const order = ORDERS.get(id);
      if (!order) {
        reply.code(404);
        return { error: "order not found" };
      }
      return order;
    },
  );
}
