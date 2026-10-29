# e2e

Testnet end-to-end test for the x402 demo. Starts the three services from the sibling
repos (`../facilitator`, `../resourceServer`, `../agentWallet`) on ports 4101–4103, runs the
whole payment flow against Ethereum Sepolia, and checks the results on-chain.

```bash
npm run test:testnet
```

## Prerequisites

- Sibling repos checked out next to this one, each with `npm install` done
- `facilitator/.env` with `FACILITATOR_PRIVATE_KEY` (see `facilitator/.env.example`); that
  address needs a little Sepolia ETH to pay settlement gas
- The test agent wallet (kept in `.keystore/`, reused across runs) needs DEMO. When its balance
  drops below 0.1 DEMO the script tops it up with 1 DEMO from the token owner, which requires
  `coin-contract/.env` (`DEPLOYER_PRIVATE_KEY`) and Foundry's `cast`

## What it checks

1. Facilitator `/supported` lists DemoCoin on `ethereum`
2. Unpaid request → `402` with `PaymentRequirements`
3. Agent Wallet signs → paid request → `200`
4. Replaying the same `X-PAYMENT` → `402`
5. 5 concurrent uses of one payment → exactly one `200`
6. Tampered signature → `402`
7. Payment over the delegation's `maxAmountPerTx` → wallet refuses (`403`)
8. Resource outside the delegation scope → wallet refuses (`403`)
9. Exactly 2 settlements land on-chain, each sent by the Facilitator's settler to DemoCoin
10. Agent balance drops and `payTo` balance rises by exactly 2 × 0.01 DEMO
11. The agent holds no ETH: the payments were gasless

Each run spends 0.02 DEMO from the agent and a little settler ETH. Server logs go to `logs/`.
