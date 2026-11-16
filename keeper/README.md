# NOSTOK Autonomous Keeper (`WS2.5`)

TypeScript + `viem` keeper service (Node >= 20) for the NOSTOK tokenized equity repo protocol on Base.

## Jobs

1. **`syncMultiplier` (`src/jobs/syncMultiplier.ts`)**
   - Polls `token.uiMultiplier()` and `OracleRouter.recordedMultiplier(token)` for each listed asset in `ASSET_LIST`.
   - If `recordedMultiplier == 0` (baseline not yet recorded), simulates and calls permissionless `OracleRouter.syncMultiplier(token)` to set the first baseline.
   - If multiplier drift is `> 0%` and `< 5%` (`< 500 bps`), simulates and calls `OracleRouter.syncMultiplier(token)` to ratchet dividend drift cleanly.
   - If multiplier jump is `>= 5%` (`>= 500 bps`), **does not** call `syncMultiplier` and emits a `FROZEN_SPLIT` alert instead so Owner/Guardian multisigs can verify and unfreeze post-split.

2. **`liquidation` (`src/jobs/liquidation.ts`)**
   - Scans loans `1..nextLoanId - 1` with `LoanStatus.Active (0)` or `LoanStatus.Grace (1)`.
   - Evaluates `OracleRouter.getPrice(token)`, `OracleRouter.getValue(token, collateralRaw)`, and `LoanCore.getDueInterest(loanId)`.
   - When `oracleState == VALID_OPEN` (`0`):
     - If `block.timestamp > loan.maturity + GRACE_PERIOD_SECONDS` (`24h`), simulates and calls `LoanCore.startDefaultAuction(loanId)`.
     - Else if `currentLtvBps >= loan.liqLtvBps`, simulates and calls `LoanCore.startLiquidation(loanId)`.

3. **`expiredAuction` (`src/jobs/expiredAuction.ts`)**
   - Scans auctions `1..nextAuctionId - 1` with `AuctionStatus.Active (0)`.
   - When `block.timestamp >= auction.startTime + auction.duration` (`30 min`) and `collateralRemaining > 0`, checks the exact contract preconditions in `LiquidationAuction.sol:351-373`:
     - `oracleState` must be `VALID_OPEN`, `VALID_CLOSED`, or `STALE_FEED` (skips `FROZEN_CORPORATE_ACTION`, `INVALID_SEQUENCER`, and `DISPUTED`), with `currentPrice > 0`.
     - If `STALE_FEED`, reads `AggregatorV3Interface(cfg.feed).latestRoundData()` and ensures `block.timestamp <= updatedAt + min(cfg.maxStaleOpenSecs * 2, 86400)`.
   - Simulates and calls `LiquidationAuction.restartOrCancelAuction(auctionId)` only when permitted.
   - Floor buys and flash-buy arbitrage are intentionally not enabled yet.

4. **Resilience, Guardrails & Alerts (`src/keeper.ts`, `src/alerts.ts`, `src/tx.ts`)**
   - **Startup Chain ID Check:** Refuses to start unless `chainId == 8453` (Base Mainnet) or `FORK=true` with matching `FORK_CHAIN_ID`.
   - **Failure Isolation:** Every job and every individual asset/loan/auction inside each job runs inside its own `try / catch`, logging + alerting (`RPC_ERROR`) without interrupting other items or jobs.
   - **Gas Cap & Stuck-Tx Replacement:** Skips sending transactions (with `HIGH_GAS_PRICE` alert) when `eth_gasPrice` exceeds `MAX_GAS_PRICE_GWEI`; waits up to `TX_TIMEOUT_MS` for receipt confirmation and attempts a fee-bumped replacement transaction (+`TX_BUMP_BPS` on the same nonce, capped by `MAX_GAS_PRICE_GWEI`) or emits a `STUCK_TX` alert.
   - **Pre-Broadcast Simulation & Default Dry Run:** Every transaction is simulated via `publicClient.simulateContract(...)` before signing/sending; `DRY_RUN=true` by default.
   - Structured console alerts + optional `TELEGRAM_WEBHOOK_URL` webhook delivery for `FROZEN_SPLIT`, `STALE_FEED`, `FAILED_TX`, `LOW_ETH_BALANCE`, `HIGH_GAS_PRICE`, `STUCK_TX`, and `RPC_ERROR`.

---

## Contract Calls Reference

Every contract call used by the keeper matches the exact Solidity signatures in `contracts/src/`:

| Contract | Function | Source Location | Usage in Keeper |
|---|---|---|---|
| `IB20Token` / `IERC20Metadata` | `uiMultiplier()` | `contracts/src/OracleRouter.sol:13` | Read live B20 multiplier |
| `IERC20Metadata` | `symbol()` | `contracts/src/OracleRouter.sol:4` | Human-readable token label in logs/alerts |
| `OracleRouter` | `recordedMultiplier(address)` | `contracts/src/OracleRouter.sol:38` | Compare baseline against live `uiMultiplier()` |
| `OracleRouter` | `getPrice(address)` | `contracts/src/OracleRouter.sol:292-358` | Read price, decimals, and `OracleState` |
| `OracleRouter` | `getValue(address,uint256)` | `contracts/src/OracleRouter.sol:363-393` | Compute gross collateral value in USDC |
| `OracleRouter` | `syncMultiplier(address)` | `contracts/src/OracleRouter.sol:170-194` | Ratchet `< 5%` B20 multiplier drift |
| `AssetRegistry` | `isAssetSupported(address)` | `contracts/src/AssetRegistry.sol:131-133` | Verify listed collateral before scanning |
| `AssetRegistry` | `getAssetConfig(address)` | `contracts/src/AssetRegistry.sol:121-124` | Read `feed` and `maxStaleOpenSecs` |
| `LoanCore` | `nextLoanId()` | `contracts/src/LoanCore.sol:57` | Determine loan iteration upper bound |
| `LoanCore` | `GRACE_PERIOD_SECONDS()` | `contracts/src/LoanCore.sol:37` | Read `24 hours` (`86400s`) grace period |
| `LoanCore` | `getLoan(uint256)` | `contracts/src/LoanCore.sol:752-754` | Read loan terms, status, collateral, debt |
| `LoanCore` | `getDueInterest(uint256)` | `contracts/src/LoanCore.sol:361-374` | Compute exact accrued interest for LTV |
| `LoanCore` | `startLiquidation(uint256)` | `contracts/src/LoanCore.sol:562-604` | Trigger LTV liquidation when `VALID_OPEN` |
| `LoanCore` | `startDefaultAuction(uint256)` | `contracts/src/LoanCore.sol:609-645` | Trigger default auction past `maturity + 24h` |
| `LiquidationAuction` | `nextAuctionId()` | `contracts/src/LiquidationAuction.sol:41` | Determine auction iteration upper bound |
| `LiquidationAuction` | `getAuction(uint256)` | `contracts/src/LiquidationAuction.sol:396-398` | Read auction status, `startTime`, `duration` |
| `LiquidationAuction` | `restartOrCancelAuction(uint256)` | `contracts/src/LiquidationAuction.sol:345-394` | Restart/cancel expired 30m auctions |
| `AggregatorV3Interface` | `latestRoundData()` | `contracts/src/interfaces/AggregatorV3Interface.sol:19-28` | Verify stale feed age before auction restart |

---

## Configuration

Copy `.env.example` to `.env` (never commit `.env`; `.gitignore` excludes all `.env.*` except `.env.example`):

```bash
cp .env.example .env
```

Environment variables:
- `RPC_URL`: RPC endpoint (e.g. `http://127.0.0.1:8545` for local Anvil fork).
- `FORK` / `FORK_CHAIN_ID`: Keeper requires `chainId == 8453` on startup unless `FORK=true` (in which case it requires `chainId == FORK_CHAIN_ID`, defaulting to `8453`).
- `KEEPER_PRIVATE_KEY`: Required signer private key (**env var only**; rejected if placed in JSON config, never logged).
- `ORACLE_ROUTER_ADDRESS`, `ASSET_REGISTRY_ADDRESS`, `LOAN_CORE_ADDRESS`, `LIQUIDATION_AUCTION_ADDRESS`: Deployed contract addresses.
- `ASSET_LIST`: Comma-separated list of listed collateral token addresses.
- `POLL_INTERVAL_MS`: Poll loop interval in milliseconds (default `15000`).
- `DRY_RUN`: Defaults to `true` (simulate only). Set `DRY_RUN=false` to broadcast transactions.
- `MIN_KEEPER_ETH`: Minimum ETH balance before emitting `LOW_ETH_BALANCE` alert (default `0.01`).
- `MAX_GAS_PRICE_GWEI`: Skip transactions and emit `HIGH_GAS_PRICE` alert if current gas price exceeds cap (default `50`).
- `TX_TIMEOUT_MS` / `TX_BUMP_BPS`: Wait timeout before treating a pending tx as stuck (default `30000` ms) and fee bump basis points for same-nonce replacement (default `2000`, i.e., +20%).
- `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_CHAT_ID`: Optional webhook alert target.
- `CONFIG_PATH`: Optional JSON file path (see `config.example.json`) for non-secret settings.

---

## Usage & Fork Tests

```bash
cd keeper
npm install
npm run build

# Single simulation cycle (DRY_RUN=true by default)
npm run once

# Continuous polling
npm start

# Base Mainnet fork integration suite (starts local Anvil fork & runs DeployNostok.s.sol)
npm test
```
