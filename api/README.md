# NOSTOK Order Book API & Quotation Engine (`WS2.3`)

Strictly read-only HTTP JSON API over the NOSTOK PostgreSQL indexer database and on-chain view state (`TypeScript` + `viem` + `pg` + `zod`).

* **Zero Private Keys / Zero Writes:** Never loads or holds private keys and never sends transactions.
* **Production Read-Only DB Role (`nostok_ro`):** In production (`FORK=false`), `DATABASE_URL` **must** connect using a dedicated PostgreSQL role granted `SELECT`-only privileges (`nostok_ro`) with no `INSERT`/`UPDATE`/`DELETE`/DDL/superuser privileges. Connection-level `default_transaction_read_only=on` and the application-level single-statement `SELECT`/`WITH` allowlist (`assertReadOnlySql`) act as defense-in-depth, not a replacement for DB role isolation.
* **Exact `bigint` / Decimal-String Money Math:** Quote inputs require base-10 decimal strings (unsafe JSON numbers above `Number.MAX_SAFE_INTEGER` are rejected with `400`). Monetary fields return `{ raw, formatted, decimals, symbol? }` alongside `block_number` and `freshness_timestamp`.
* **Production Geoblock & Proxy Security (`FORK=false`):** When `FORK=false`, the API **refuses to start** unless `TRUST_PROXY >= 1` and `GEO_REQUIRE_HEADER=true` (or an explicit `GEO_DISABLED=true` override is configured, which logs a security warning). An empty `SANCTIONED_ADDRESSES` list also logs a loud startup warning.
* **Cloudflare / Reverse-Proxy Origin Isolation:** When `TRUST_PROXY >= 1`, the API reads `X-Forwarded-For` and `GEO_COUNTRY_HEADER` (`cf-ipcountry` by default). In production, the origin server **must** accept traffic **only from Cloudflare edge IPs / your trusted reverse proxy** (via OS/VPC firewall or Cloudflare Tunnel), and/or configure `TRUSTED_PROXY_CIDRS` with allowed proxy IPv4/IPv6 CIDR ranges so spoofed headers from untrusted callers fail closed (`GEO_UNTRUSTED_PROXY`).
* **Hardening:** Strict EIP-55 checksum address validation (`zod`), bounded pagination (`limit`, `offset`/`cursor`, `MAX_PAGE_LIMIT`), per-IP rate limiting (`429`, `TRUST_PROXY`, `TRUSTED_PROXY_CIDRS`, `RATE_LIMIT_MAX_BUCKETS`, background timer eviction), `multicall` + per-block caching on `/assets`, `503 RPC_UNAVAILABLE` on RPC failures, CORS headers, request body size cap (`413`), and stack-trace-free error responses.

---

## Environment Configuration

Configure `api/.env` from [`api/.env.example`](.env.example):

* `TRUST_PROXY` (`0` default): Number of trusted reverse-proxy hops (`>= 1` required in production unless `GEO_DISABLED=true`).
* `TRUSTED_PROXY_CIDRS` (optional comma-separated IPv4/IPv6 CIDRs): Direct TCP peer IPs allowed to supply `X-Forwarded-For` and `GEO_COUNTRY_HEADER` (e.g., Cloudflare published IP ranges or loopback nginx proxy). Requests from other IPs ignore `X-Forwarded-For` and fail geoblock checks with `403 GEO_UNTRUSTED_PROXY`.
* `GEO_COUNTRY_HEADER` (`cf-ipcountry` default): Proxy-injected ISO-3166 alpha-2 country header.
* `GEO_REQUIRE_HEADER` (`false` default; **`true` required** when `FORK=false` unless `GEO_DISABLED=true`): Fail closed on missing/`XX` headers (`GEO_UNVERIFIED`).
* `GEO_RESTRICTED_COUNTRIES` (`US,CU,IR,KP,SY,RU,BY,MM` default): Blocked ISO-3166 alpha-2 jurisdictions (`T1` Tor exit nodes are always blocked).
* `GEO_DISABLED` (`false` default): Explicit override allowing `FORK=false` startup without edge geoblock enforcement.
* `SANCTIONED_ADDRESSES`: Comma-separated EVM addresses blocked on `/eligibility`, `/eligibility/verify`, and `POST /orders` (logs startup warning if empty).

---

## Endpoints

All list endpoints support both `/...` and `/v1/...`, with stable primary-key ordering and pagination (`limit`, `offset` or `cursor`):

* `GET /health` — DB status, RPC status, `last_indexed_block`, `chain_head_block`, `lag_blocks`, `within_lag_threshold`, `geo` mode (`mode`, `enabled`, `require_header`, `trust_proxy_hops`, `trusted_proxy_cidrs_count`, `restricted_countries_count`), and `sanctions` mode (`mode`, `sanctioned_addresses_count`).
* `GET /eligibility` — Edge geo verification, wallet sanctions screening (`SANCTIONED_ADDRESSES`), live on-chain `EligibilityGate` state (`permissionlessMode`, `isRevoked`, `allowlisted`, `userNonce`, `attestationSigner`, `isEligible`), optional attestation decoding, and EIP-712 `EligibilityDeclaration` signing parameters.
* `POST /eligibility/verify` — Verifies edge geo match, sanctions status, non-revocation, canonical statement hash, `EligibilityGate.userNonce(account)`, `60s..24h` TTL bounds, and EOA/ERC-1271 `EligibilityDeclaration` signature.
* `GET /orders` — Filters: `status` (`cancelled | partially_filled | filled | unknown`), `maker`, `asset`. Because `OrderSettlement` orders only appear on-chain once filled or cancelled, `open` is intentionally unsupported until off-chain order intake exists. Orders store decoded `min_usdc`, `filled_usdc`, `remaining_usdc`, `order_type`, and `collateral_token` (so `asset` filtering matches cancelled orders even when `fills_count = 0`). When `min_usdc = 0` (e.g., filled via a wrapper contract or unavailable calldata), the API reports `status: "unknown"` and `remaining_usdc: null` rather than `"filled"`.
* `GET /loans` — Filters: `borrower`, `lender`, `status`, `asset`.
* `GET /positions` — Filters: `owner`, `auction_locked`, `burned`.
* `GET /auctions` — Filters: `status` (`active | settled | cancelled`), `loan` / `loan_id`.
* `GET /assets` — Filters: `status` (`Active | ReduceOnly | WindDown | Frozen`), `asset` / `token`. Uses `multicall` batched and cached per block. Returns caps, LTV thresholds, live `OracleRouter` price/state, `recordedMultiplier`, `uiMultiplier`, and `CollateralEscrow` balance.
* `GET /quote` & `POST /quote` — Live on-chain quotation reading `LoanCore`, `AssetRegistry`, `OracleRouter`, `FeeCollector`, `LiquidationAuction.MIN_BUY_USDC()`, and `EligibilityGate.isEligible(account, attestation)` (checked even in `permissionlessMode` so revoked users are rejected). Computes `principal`, `collateral_required`, `origination_fee`, `net_proceeds`, `interest_maturity`, `min_interest_floor`, `origination_debt`, `protocol_interest_cut`, `total_repayment_at_maturity`, `liquidation_price` & `liquidation_price_at_maturity` (`ceil((floor(D * 1e4 / liq) + 1) * S / (c * 1e6))`, the first strictly non-liquidating price above gross value thresholds), `health_factor`, warnings (`BELOW_MIN_BUY_USDC`), and explicit rejection codes (`PROTOCOL_PAUSED`, `ASSET_NOT_SUPPORTED`, `ASSET_NOT_ACTIVE`, `ORACLE_INVALID`, `PRINCIPAL_BELOW_MINIMUM`, `PRINCIPAL_EXCEEDS_UINT128_MAX`, `COLLATERAL_EXCEEDS_UINT128_MAX`, `TERM_OUT_OF_RANGE`, `MAX_90_DAY_TOTAL_TERM_EXCEEDED`, `APR_EXCEEDS_MAX`, `PER_LOAN_CAP_EXCEEDED`, `ASSET_CAP_EXCEEDED`, `GLOBAL_CAP_EXCEEDED`, `LTV_EXCEEDED`, `BORROWER_INELIGIBLE`, `LENDER_INELIGIBLE`). Unsupported assets report `asset.status = null`.

---

## Commands

```bash
cd api
cp .env.example .env
npm install
npm run build

# Start read-only API server
npm start

# Base Mainnet fork integration tests
npm test
```
