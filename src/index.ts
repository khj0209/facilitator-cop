import Fastify from "fastify";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { Network } from "x402-contracts";
import { EvmAdapter } from "./adapters/evm.js";
import type { ChainAdapter } from "./adapters/types.js";
import { registerRoutes } from "./routes.js";

// DemoCoin on Ethereum Sepolia, see coin-contract/README.md
const ETHEREUM_SEPOLIA_DEMO_COIN = "0x025311Ca250150E9c3684b614566c9f187a47e16";

const settlerPrivateKey = process.env.FACILITATOR_PRIVATE_KEY as Hex | undefined;

// GIWA adapter (chainId 91342) is added in Phase 5 once the coin contract is deployed there.
const adapters: Partial<Record<Network, ChainAdapter>> = {
  ethereum: new EvmAdapter("ethereum", {
    chain: sepolia,
    asset: (process.env.ETHEREUM_ASSET_ADDRESS ?? ETHEREUM_SEPOLIA_DEMO_COIN) as Hex,
    rpcUrl: process.env.ETHEREUM_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
    settlerPrivateKey,
  }),
};

const app = Fastify({ logger: true });
registerRoutes(app, adapters);

if (settlerPrivateKey) {
  app.log.info({ settler: privateKeyToAccount(settlerPrivateKey).address }, "settlement enabled");
} else {
  app.log.warn("FACILITATOR_PRIVATE_KEY not set: /settle will refuse to submit transactions");
}

const port = Number(process.env.PORT ?? 4001);
app.listen({ port }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
