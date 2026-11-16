# NOSTOK Risk Monitor & Corporate Action Daemon (`WS2.4`)

Strictly read-only monitoring daemon and Prometheus/HTTP reporting service over the indexer PostgreSQL database and on-chain view state (`TypeScript` + `viem` + `pg` + `zod`).

* **Zero Private Keys / Zero Writes:** Holds no private keys, sends no transactions, never modifies indexer tables (`SELECT`-only queries via `nostok_ro` DB role in production + `default_transaction_read_only=on` + SQL allowlist). Alert/metric snapshots live strictly in the monitor's own in-memory store.
* **Contract-Exact Health & Liquidation Math (100% On-Chain):** Queries live `LoanCore.nextLoanId()`, `getLoan()`, and `getDueInterest()` directly via chunked `multicall` (200 calls per chunk), never relying on DB `principal_repaid` or `collateral_raw`. Evaluates `principal - onchain.principalRepaid + getDueInterest(loanId)` against **gross** collateral value, flags loans past `maturity + 24h` grace (`keeper_inactive:default:<loan>`), and computes `liquidation_price` as the first strictly non-liquidating price `ceil((floor(D * 1e4 / liq) + 1) * S / (c * 1e6))`.
* **Protocol Watches:**
  * Oracle staleness (`maxStaleOpenSecs` / `maxStaleClosedSecs`), `STALE_FEED` / `INVALID_SEQUENCER` / `DISPUTED` state changes, and price deviation;
  * Corporate actions (`uiMultiplier` vs `recordedMultiplier`: `>= 1%` drift warning, `>= 5%` freeze page, `ReduceOnly` / `WindDown` / `Frozen` asset status);
  * Protocol caps (`globalUsdcCap` & per-asset `assetCap` >= 80% warning / >= 95% critical), `paused()`, and three-way escrow invariant (`IERC20.balanceOf(escrow)` vs `CollateralEscrow.getBalance(token)` ledger vs on-chain open loan `collateralRaw` sum — critical on shortfalls/mismatches, bounded auto-resolving info on donation surpluses);
  * Keeper liveness (`MultiplierSynced`, `startLiquidation`, default auction/restart/cancel timestamps exposed as `/metrics` Prometheus gauges) and unacted liquidatable loans, defaulted loans past 24h grace, and expired auctions;
  * Indexer lag (`last_indexed_block` vs chain head, `indexer_state.updated_at` age);
  * Alert severities (`info | warning | critical | page`) with `dedup_key`, `ALERT_COOLDOWN_MS`, flap damping (`ALERT_MIN_ACTIVE_MS`), escalation & downgrade notifications, bounded history/transitions ring buffer, non-blocking bounded webhook queue with `AbortSignal.timeout(5000)` + retries, and degraded RPC/DB boot + recovery.

## Endpoints

* `GET /metrics` — Prometheus text exposition metrics.
* `GET /risk/summary` (and `/health`) — Latest scan summary, caps, oracle/multiplier state, keeper liveness, indexer lag, and alert counts.
* `GET /risk/loans` — Paginated open loans (`status=healthy|margin_call|near_liquidation|liquidatable`, checksummed `asset`).
* `GET /risk/alerts` — Paginated alerts (`severity`, `status=active|resolved`, `category`).

## Commands

```bash
cd risk
cp .env.example .env
npm install
npm run build

# Single scan
npm run once

# Continuous polling + HTTP server
npm start

# Base Mainnet fork integration suite
npm test
```
