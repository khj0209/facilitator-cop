import Fastify from "fastify";
import { registerRoutes } from "./routes.js";

const app = Fastify({ logger: true });
registerRoutes(app);

const port = Number(process.env.PORT ?? 4003);
app.listen({ port }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
