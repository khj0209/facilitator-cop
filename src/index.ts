import Fastify from "fastify";
import type { Network } from "x402-contracts";
import { EvmAdapter } from "./adapters/evm.js";
import type { ChainAdapter } from "./adapters/types.js";
import { registerRoutes } from "./routes.js";

const ETHEREUM_SEPOLIA_CHAIN_ID = 11155111;

// GIWA adapter (chainId 91342) is added in Phase 5 once the coin contract is deployed there.
const adapters: Partial<Record<Network, ChainAdapter>> = {
  ethereum: new EvmAdapter("ethereum", ETHEREUM_SEPOLIA_CHAIN_ID),
};

const app = Fastify({ logger: true });
registerRoutes(app, adapters);

const port = Number(process.env.PORT ?? 4001);
app.listen({ port }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
