# coin-contract

> **Active token: `contracts/demo/DemoCoin.sol`** — a minimal, dependency-free
> ERC-20 + EIP-3009 token. The vendored `FiatTokenV2_2` below could not be
> deployed: its ~23KB runtime needs ~36.9M gas on Sepolia, over the 2^24
> per-transaction gas cap. Its first deploy attempt (`broadcast/deploy-fiat-token.s.sol`)
> reverted on every CREATE — those addresses hold no code.
>
> ### Deployments
>
> | Network | Address | Tx |
> |---|---|---|
> | Ethereum Sepolia (11155111) | `0x025311Ca250150E9c3684b614566c9f187a47e16` | `0xadbf06ab2a5e23d4deea35583072a0312b045bb05d04af7ef527b3cbcaf6fe96` |
>
> EIP-712 domain: name `DemoCoin`, version `"1"`. Owner `0x0E79409e5f2b822d2046cC28E99FF6b411B3beBE`
> (holds the initial 1,000,000 DEMO mint and is the only minter).
>
> ### Deploy DemoCoin
>
> forge's local simulation underestimates Sepolia's contract-creation gas (~5x),
> so pin the gas limit instead of relying on its estimate:
>
> ```bash
> source .env
> forge create contracts/demo/DemoCoin.sol:DemoCoin --rpc-url $SEPOLIA_RPC_URL \
>   --private-key $DEPLOYER_PRIVATE_KEY --broadcast --gas-limit 11000000 \
>   --constructor-args "$TOKEN_NAME" "$TOKEN_SYMBOL" $TOKEN_DECIMALS $OWNER_ADDRESS
> cast send <token> 'mint(address,uint256)' <to> <rawAmount> --rpc-url $SEPOLIA_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY
> ```
>
> Always confirm afterwards with `cast receipt <tx> status` and `cast code <address>`.
> Tests: `forge test --match-contract DemoCoinTest`.

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
