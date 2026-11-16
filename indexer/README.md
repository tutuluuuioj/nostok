# NOSTOK Database & Reorg-Safe Indexer (`WS2.1` & `WS2.2`)

TypeScript + **plain `viem` + PostgreSQL (`pg` + `@electric-sql/pglite`)** indexer for NOSTOK on Base (Node >= 20).

## Stack Choice: Why Plain `viem` + PostgreSQL Instead of Ponder

1. **Deterministic Reorg Rollback & State Reconciliation:** Storing block hashes in `indexed_blocks` allows exact block-by-block parent-hash verification against the RPC. When a reorg (`anvil_revert` or competing fork) is detected, orphaned `loan_events`, `order_fills`, `auction_buys`, and `claims` are rolled back inside a single SQL transaction, and surviving `loans`, `auctions`, `positions`, `orders`, and `assets` are reconciled directly against on-chain view state (`LoanCore.getLoan()`, `LiquidationAuction.getAuction()`, `PositionNFT.ownerOf()`, `CollateralEscrow.getBalance()`).
2. **Production PostgreSQL & Zero-Daemon Local Testing:** Connects to any PostgreSQL server when `DATABASE_URL=postgresql://...` is set (`pg.Pool`), and uses embedded WASM PostgreSQL (`@electric-sql/pglite`) when `DATABASE_URL` is unset or `memory://` — providing identical PostgreSQL SQL/JSONB semantics locally with zero external Postgres service required.
3. **Lightweight Read-Only Boundary:** Requires zero private keys (`RPC_URL` + contract addresses + `START_BLOCK`).

---

## Database Schema (`WS2.1`)

Defined in [`src/db.ts`](src/db.ts):
* `indexer_state`, `indexed_blocks`: Canonical block hashes (`block_number`, `block_hash`, `parent_hash`) for reorg detection and resumption.
* `loans`: Mirrors `LoanCore.getLoan(loanId)` plus `active_auction_id`, `bad_debt_shortfall`, and optimistic concurrency `row_version`.
* `loan_events`: Chronological `(block_number, log_index)` log across `LoanCore`, `OrderSettlement`, `LiquidationAuction`, `PositionNFT`, `AssetRegistry`, `OracleRouter`, and listed B20 `Transfer`s to/from `CollateralEscrow`.
* `orders`, `order_fills`: Tracks maker order fill totals, cancellation status, maker nonces, and individual `OrderFilled` fills.
* `auctions`, `auction_buys`: Tracks `LiquidationAuction.getAuction(auctionId)`, settlement payouts (`total_usdc_collected`, `debt_paid`, `fee_paid`, `surplus_to_borrower`), and per-buy records.
* `positions`: Tracks current `PositionNFT` `owner`, `auction_locked`, and `is_burned`.
* `claims`: Tracks `LoanCore.Claimed` USDC withdrawals.
* `assets`: Tracks `AssetRegistry` configs, `OracleRouter.recordedMultiplier`, and live `CollateralEscrow.getBalance(token)`.

---

## Exact Indexed Events & `contracts/src/` Locations (`WS2.2`)

| Contract | Event | Source Location |
|---|---|---|
| `LoanCore` | `LoanOpened` | `contracts/src/interfaces/ILoanCore.sol:38-47`, `contracts/src/LoanCore.sol:287-296` |
| `LoanCore` | `Repaid` | `contracts/src/interfaces/ILoanCore.sol:49`, `contracts/src/LoanCore.sol:426` |
| `LoanCore` | `PartialRepaid` | `contracts/src/interfaces/ILoanCore.sol:50`, `contracts/src/LoanCore.sol:489` |
| `LoanCore` | `ToppedUp` | `contracts/src/interfaces/ILoanCore.sol:51`, `contracts/src/LoanCore.sol:506` |
| `LoanCore` | `Extended` | `contracts/src/interfaces/ILoanCore.sol:52`, `contracts/src/LoanCore.sol:556` |
| `LoanCore` | `StatusSynced` | `contracts/src/interfaces/ILoanCore.sol:53`, `contracts/src/LoanCore.sol:185, 722, 735` |
| `LoanCore` | `Claimed` | `contracts/src/interfaces/ILoanCore.sol:55`, `contracts/src/LoanCore.sol:749` |
| `LoanCore` | `BadDebtRecorded` | `contracts/src/interfaces/ILoanCore.sol:56`, `contracts/src/LoanCore.sol:711` |
| `OrderSettlement` | `OrderFilled` | `contracts/src/interfaces/IOrderSettlement.sol:37-44`, `contracts/src/OrderSettlement.sol:218, 315` |
| `OrderSettlement` | `OrderCancelled` | `contracts/src/interfaces/IOrderSettlement.sol:46`, `contracts/src/OrderSettlement.sol:84, 91` |
| `OrderSettlement` | `NonceBumped` | `contracts/src/interfaces/IOrderSettlement.sol:47`, `contracts/src/OrderSettlement.sol:96` |
| `LiquidationAuction` | `AuctionStarted` | `contracts/src/interfaces/ILiquidationAuction.sol:32-41`, `contracts/src/LiquidationAuction.sol:148-157` |
| `LiquidationAuction` | `AuctionBought` | `contracts/src/interfaces/ILiquidationAuction.sol:43-49`, `contracts/src/LiquidationAuction.sol:301` |
| `LiquidationAuction` | `AuctionSettled` | `contracts/src/interfaces/ILiquidationAuction.sol:51-57`, `contracts/src/LiquidationAuction.sol:305` |
| `LiquidationAuction` | `AuctionCancelled` | `contracts/src/interfaces/ILiquidationAuction.sol:59`, `contracts/src/LiquidationAuction.sol:313, 342, 386` |
| `LiquidationAuction` | `AuctionRestarted` | `contracts/src/interfaces/ILiquidationAuction.sol:60`, `contracts/src/LiquidationAuction.sol:392` |
| `PositionNFT` | `Transfer` | `contracts/src/PositionNFT.sol:4, 16, 57, 64, 83, 95` (`IERC721` inherited) |
| `PositionNFT` | `LoanClaimMinted` | `contracts/src/interfaces/IPositionNFT.sol:13`, `contracts/src/PositionNFT.sol:58` |
| `PositionNFT` | `LoanClaimBurned` | `contracts/src/interfaces/IPositionNFT.sol:14`, `contracts/src/PositionNFT.sol:65` |
| `PositionNFT` | `LoanAuctionLocked` | `contracts/src/interfaces/IPositionNFT.sol:15`, `contracts/src/PositionNFT.sol:70` |
| `AssetRegistry` | `AssetConfigSet` | `contracts/src/interfaces/IAssetRegistry.sol:38`, `contracts/src/AssetRegistry.sol:94` |
| `AssetRegistry` | `AssetStatusSet` | `contracts/src/interfaces/IAssetRegistry.sol:39`, `contracts/src/AssetRegistry.sol:118` |
| `OracleRouter` | `MultiplierSynced` | `contracts/src/OracleRouter.sol:50, 193` |
| Listed B20 Tokens | `Transfer` (to/from `CollateralEscrow`) | `contracts/src/CollateralEscrow.sol:4, 61, 84` (`IERC20.safeTransferFrom` / `safeTransfer`) |

---

## Configuration & Commands

```bash
cd indexer
cp .env.example .env
npm install
npm run build

# Single sync cycle
npm run once

# Continuous polling
npm start

# Base Mainnet fork integration & reorg test suite
npm test
```

Environment variables (no private key required):
* `RPC_URL`, `FORK`, `FORK_CHAIN_ID`
* `DATABASE_URL` (`postgresql://...` for PostgreSQL server, or empty / `memory://` for embedded PGlite)
* `START_BLOCK`, `CONFIRMATIONS` (default `12`), `POLL_INTERVAL_MS`, `BLOCK_BATCH_SIZE`
* `LOAN_CORE_ADDRESS`, `ORDER_SETTLEMENT_ADDRESS`, `LIQUIDATION_AUCTION_ADDRESS`, `POSITION_NFT_ADDRESS`, `COLLATERAL_ESCROW_ADDRESS`, `ASSET_REGISTRY_ADDRESS`, `ORACLE_ROUTER_ADDRESS`, `ASSET_LIST`
