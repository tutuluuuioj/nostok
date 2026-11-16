# NOSTOK Risk Monitor & Corporate Action Daemon (`WS2.4`)

Strictly read-only monitoring daemon and Prometheus/HTTP reporting service over the indexer PostgreSQL database and on-chain view state (`TypeScript` + `viem` + `pg` + `zod`).

* **Zero Private Keys / Zero Writes:** Holds no private keys, sends no transactions, never modifies indexer tables (`SELECT`-only queries via `nostok_ro` DB role in production + `default_transaction_read_only=on` + SQL allowlist). Alert/metric snapshots live strictly in the monitor's own in-memory store.
* **Contract-Exact Health & Liquidation Math:** Evaluates per-loan `principal - principalRepaid + getDueInterest(loanId)` (which includes `minInterestFloor`) against **gross** collateral value (`OracleRouter.getValue().grossValueUsdc`), checks `VALID_OPEN` for `liquidatable`, computes `liquidation_price` rounded UP and `distance_to_liquidation_bps`, and classifies `healthy`, `margin_call`, `near_liquidation`, and `liquidatable`.
* **Protocol Watches:**
  * Oracle staleness (`maxStaleOpenSecs` / `maxStaleClosedSecs`), `STALE_FEED` / `INVALID_SEQUENCER` state changes, and price deviation;
  * Corporate actions (`uiMultiplier` vs `recordedMultiplier`: `>= 1%` drift warning, `>= 5%` freeze page, `ReduceOnly` / `Frozen` asset status);
  * Protocol caps (`globalUsdcCap` & per-asset `assetCap` >= 80% warning / >= 95% critical), `paused()`, and `CollateralEscrow.getBalance` vs open loan collateral invariant;
  * Keeper liveness (`MultiplierSynced`, `AuctionStarted`, `AuctionRestarted`) and unacted liquidatable loans / expired auctions;
  * Indexer lag (`last_indexed_block` vs chain head, `indexer_state.updated_at` age);
  * Alert severities (`info | warning | critical | page`) with `dedup_key`, `ALERT_COOLDOWN_MS`, escalation, auto-resolve, structured logs, and optional `WEBHOOK_URL`.

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
