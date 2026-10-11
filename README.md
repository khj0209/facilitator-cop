# coin-contract

The demo's own stablecoin, deployed from Circle's actual USDC contract code
(`FiatTokenV2_2` + `FiatTokenProxy` + `MasterMinter`), so it supports the same
EIP-3009 `transferWithAuthorization` gasless-transfer scheme the Facilitator
expects (see the main `PLAN.md`, section 6.2).

## Provenance

Vendored from [circlefin/stablecoin-evm](https://github.com/circlefin/stablecoin-evm)
at commit `fc85788bc7c23cefe3df1a757133048bfddadeaa`, Apache-2.0 licensed (see `LICENSE`).

Only the standard-EVM path is kept — the Celo variant, the Native Fiat Token
variant, the V1/V2/V2_1 in-place upgrader scripts, and all hardhat/test
tooling were dropped since this demo targets Ethereum/GIWA (both plain EVM)
and always deploys straight to the latest `FiatTokenV2_2` implementation.
`scripts/deploy/DeployImpl.sol` is a trimmed copy of the upstream file with
the Celo-only `getOrDeployImplCelo()` overload removed; `deploy-fiat-token.s.sol`
is otherwise unmodified upstream code.

## Setup

```bash
npm install
forge install   # pulls lib/forge-std at the pinned commit in .gitmodules
forge build
```

## Deploy

Copy `.env.example` to `.env` and fill in the addresses/RPC URL, then:

```bash
source .env
forge script scripts/deploy/deploy-fiat-token.s.sol:DeployFiatToken \
  --rpc-url sepolia --broadcast -vvvv
```

`OWNER_ADDRESS`, `PROXY_ADMIN_ADDRESS`, and `MASTER_MINTER_OWNER_ADDRESS` can
all be the same deployer address for this demo — a single operator owns the
whole stack, there's no multi-party governance to model.

After deploy, mint demo tokens to an agent's wallet via `cast send` against
the proxy address's `configureMinter` (as `MASTER_MINTER_OWNER_ADDRESS`) and
then `mint` (as the configured minter).
