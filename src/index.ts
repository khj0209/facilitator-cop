import Fastify from "fastify";
import { settlePaymentOnResponse } from "./payment-middleware.js";
import { registerSecuritiesRoutes } from "./routes/securities.js";
import { registerShopRoutes } from "./routes/shop.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok", service: "resource-server" }));

app.addHook("onResponse", async (req, reply) => {
  await settlePaymentOnResponse(req, reply);
});

registerSecuritiesRoutes(app);
registerShopRoutes(app);

const port = Number(process.env.PORT ?? 4002);
app.listen({ port }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
