import type { Network } from "x402-contracts";

export const config = {
  facilitatorUrl: process.env.FACILITATOR_URL ?? "http://localhost:4001",
  network: (process.env.NETWORK as Network) ?? "ethereum",
  assetAddress: process.env.ASSET_ADDRESS ?? "0x0000000000000000000000000000000000000ac0",
  payToAddress: process.env.PAY_TO_ADDRESS ?? "0x0000000000000000000000000000000000000af1",
  tokenName: process.env.TOKEN_NAME ?? "DemoCoin",
};
