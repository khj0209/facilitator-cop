# demo-ui

Browser demo of the x402 agent payment flow on Ethereum Sepolia. One command starts the
Facilitator, Resource Server and Agent Wallet from the sibling repos plus this page:

```bash
npm start   # then open http://localhost:4000
```

Ctrl+C stops everything. Service logs go to `logs/`.

## What the page shows

- **Agent wallet**: address, DEMO and ETH balances (ETH stays 0: payments are gasless), and a
  button that tops the agent up with 1 DEMO from the token owner
- **Settlement parties**: the Facilitator's settler address and ETH, the seller (`payTo`), the token
- **Delegation policy**: allowed resources and per-transaction / per-window limits; saving revokes
  the current policy and issues a new one (the Agent Wallet uses an agent's first active policy)
- **Payment flow** for a chosen API, step by step or all at once:
  1. unpaid call → `402` with `PaymentRequirements`
  2. Agent Wallet signs (or the delegation policy refuses, e.g. the 1 DEMO stock order)
  3. retry with `X-PAYMENT` → `200`
  4. on-chain settlement: tx, gas payer, balance changes
- **Attacks**: replaying a payment, 5 concurrent uses of one payment, tampered signature

## How it works

`server.mjs` (no dependencies) serves `index.html`, proxies `/api/rs|aw|fac/*` to the three
services (they don't send CORS headers, and stay unmodified), and answers chain questions:
balances, and which transaction settled a payment, found through DemoCoin's
`AuthorizationUsed(from, nonce)` event. Settlement failures are picked up from the Resource
Server log so the page can show the reason right away.

## Prerequisites

- Sibling repos checked out next to this one, each with `npm install` done
- Ports 4000–4003 free
- `facilitator/.env` with `FACILITATOR_PRIVATE_KEY` (funded with a little Sepolia ETH)
- For the top-up button: `coin-contract/.env` (`DEPLOYER_PRIVATE_KEY`) and Foundry's `cast`

The demo agent's key lives in `.keystore/` and is reused across runs.
