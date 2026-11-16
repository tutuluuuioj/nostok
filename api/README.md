# NOSTOK Order Book API & Quotation Engine (`WS2.3`)

Strictly read-only HTTP JSON API over the NOSTOK PostgreSQL indexer database and on-chain view state (`TypeScript` + `viem` + `pg` + `zod`).

* **Zero Private Keys / Zero Writes:** Never loads or holds private keys, never sends transactions, and enforces `SELECT`/`WITH`-only queries on a read-only PostgreSQL session (`default_transaction_read_only=on`). The only secret read is `DATABASE_URL`.
* **Exact `bigint` / Decimal-String Money Math:** Never converts USDC, collateral, or interest values to JavaScript floating-point numbers. Monetary fields return `{ raw, formatted, decimals, symbol? }` alongside `block_number` and `freshness_timestamp`.
* **Hardening:** Strict EIP-55 checksum address validation (`zod`), bounded pagination (`limit`, `offset`/`cursor`, `MAX_PAGE_LIMIT`), per-IP rate limiting (`429`), CORS headers, request body size cap (`413`), and stack-trace-free error responses.

---

## Endpoints

All list endpoints support both `/...` and `/v1/...`, with stable primary-key ordering and pagination (`limit`, `offset` or `cursor`):

* `GET /health` — DB status, RPC status, `last_indexed_block`, `chain_head_block`, `lag_blocks`, `within_lag_threshold`.
* `GET /orders` — Filters: `status` (`open | filled | cancelled`), `maker`, `asset`.
* `GET /loans` — Filters: `borrower`, `lender`, `status`, `asset`.
* `GET /positions` — Filters: `owner`, `auction_locked`, `burned`.
* `GET /auctions` — Filters: `status` (`active | settled | cancelled`), `loan` / `loan_id`.
* `GET /assets` — Filters: `status` (`Active | ReduceOnly | Frozen`), `asset` / `token`. Includes caps, LTV thresholds, live `OracleRouter` price/state, `recordedMultiplier`, `uiMultiplier`, and `CollateralEscrow` balance.
* `GET /quote` & `POST /quote` — Live on-chain quotation reading `LoanCore`, `AssetRegistry`, `OracleRouter`, `FeeCollector`, `LiquidationAuction.MIN_BUY_USDC()`, and `EligibilityGate`. Computes `principal`, `collateral_required`, `origination_fee`, `net_proceeds`, `interest_maturity`, `min_interest_floor`, `protocol_interest_cut`, `total_repayment_at_maturity`, `liquidation_price`, `health_factor`, and explicit rejection codes (`PROTOCOL_PAUSED`, `ASSET_NOT_SUPPORTED`, `ASSET_NOT_ACTIVE`, `ORACLE_INVALID`, `PRINCIPAL_BELOW_MINIMUM`, `TERM_OUT_OF_RANGE`, `MAX_90_DAY_TOTAL_TERM_EXCEEDED`, `APR_EXCEEDS_MAX`, `PER_LOAN_CAP_EXCEEDED`, `ASSET_CAP_EXCEEDED`, `GLOBAL_CAP_EXCEEDED`, `LTV_EXCEEDED`, `BORROWER_INELIGIBLE`, `LENDER_INELIGIBLE`).

---

## Commands

```bash
cd api
cp .env.example .env
npm install
npm run build

# Start read-only API server
npm start

# Base Mainnet fork integration tests (endpoints, pagination, validation, quote execution parity)
npm test
```
