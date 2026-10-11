import Fastify from "fastify";
import { SUPPORTED_NETWORKS } from "x402-contracts";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok", service: "facilitator" }));

app.get("/supported", async () => ({
  kinds: SUPPORTED_NETWORKS.map((network) => ({ scheme: "exact", network })),
}));

const port = Number(process.env.PORT ?? 4001);
app.listen({ port }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
