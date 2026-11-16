# NOSTOK User Notifications & Alerts Service (`WS2.6`)

Per-wallet notification service delivering margin call, liquidation, auction, maturity countdown, repayment, lender claimable, corporate-action freeze, and stale-oracle alerts across Email, Telegram, and Webhook channels (`TypeScript` + `viem` + `pg` + `zod`).

## Security & Isolation Guarantees

* **Zero Private Keys / Zero On-Chain Writes:** Holds no EOA or relayer keys and never signs or broadcasts transactions.
* **Read-Only Access to Indexer & Risk State:**
  * Production `INDEXER_DATABASE_URL` **must** use a PostgreSQL role restricted strictly to `SELECT` (`nostok_ro`), reinforced by `default_transaction_read_only=on` and `assertReadOnlySql`.
  * Production `DATABASE_URL` uses its own schema/tables prefixed with `notif_*` (`notif_nonces`, `notif_subscriptions`, `notif_preferences`, `notif_deliveries`, `notif_dead_letters`, `notif_cursor`). A dedicated `nostok_notif` DB role should have `SELECT/INSERT/UPDATE/DELETE` privileges **only** on `notif_*` tables and zero write privileges on indexer tables (`assertNotifTableSql` also enforces this at the application layer).
  * Consumes Risk Monitor state (`GET /risk/loans`, `GET /risk/alerts`) when `RISK_API_URL` is set, with direct read-only on-chain fallback if the risk monitor is unreachable.
* **Minimal PII & Encryption at Rest:**
  * Stores only the wallet address and the encrypted delivery target (`email`, Telegram `chat_id`, or `webhook` URL).
  * Encrypts targets at rest using **AES-256-GCM** with versioned `key_id` support (`ENCRYPTION_KEYS` / `ENCRYPTION_KEY_ID`) for zero-downtime key rotation, plus an HMAC-SHA256 keyed lookup hash (`PII_HASH_SECRET`).
  * Never logs plaintext emails, chat IDs, webhook URLs, SIWE tokens, or unsubscribe tokens.
  * Exposes `DELETE /user/data` to permanently delete a wallet's subscriptions, preferences, deliveries, dead-letters, and nonces.
* **SIWE (EIP-4361) Wallet Ownership Proof:**
  * `POST /auth/nonce` issues a single-use expiring nonce bound to the wallet & domain.
  * `POST /auth/verify` validates `domain`, `uri`, `chainId`, `issuedAt`, `expirationTime`, consumes the nonce atomically in PostgreSQL, and verifies signatures using `publicClient.verifyMessage` (supporting both EOA signatures and EIP-1271 smart contract wallets).

---

## Alert Types

| Alert Type | Severity | Quiet Hours Critical Override | Trigger |
|---|---|---|---|
| `loan_margin_call` | `warning` | No | Loan LTV crosses `marginCallLtvBps` |
| `loan_near_liquidation` | `warning` | No | Loan LTV within near-liquidation buffer or liquidatable |
| `liquidation_started` | `critical` | **Yes** | `AuctionStarted` indexed event |
| `auction_bid` | `info` | No | `AuctionBought` indexed event |
| `auction_settled` | `critical` | **Yes** | `AuctionSettled` indexed event |
| `maturity_reminder_3d` | `warning` | No | Active loan `maturity - block.timestamp <= 72h` |
| `maturity_reminder_1d` | `warning` | No | Active loan `maturity - block.timestamp <= 24h` |
| `maturity_reminder_6h` | `critical` | **Yes** | Active loan `maturity - block.timestamp <= 6h` |
| `loan_repaid` | `info` | No | `Repaid` / `PartialRepaid` indexed event |
| `lender_claimable` | `info` | No | Lender has claimable USDC in `LoanCore` |
| `asset_frozen_or_corporate_action` | `critical` | **Yes** | Collateral asset frozen (`AssetStatus=Frozen` or `FROZEN_CORPORATE_ACTION` / multiplier freeze) |
| `oracle_stale` | `warning` | No | Collateral asset oracle feed reports `STALE_FEED` |

---

## Endpoints

* `GET /health` — Health status for both `notif_*` DB and read-only indexer DB.
* `POST /auth/nonce` — Issue a single-use SIWE nonce (`{ wallet_address }`).
* `POST /auth/verify` — Verify EIP-4361 SIWE message + signature (`{ message, signature }`) -> `{ token, expires_at }`.
* `POST /subscriptions`, `GET /subscriptions` — Authenticated wallet channel management (`email`, `telegram`, `webhook`). Returns masked targets only.
* `GET /preferences`, `PUT /preferences` — Configure per-alert-type enable/disable flags, UTC `quiet_hours_start` / `quiet_hours_end`, and per-user `max_per_hour`.
* `GET /deliveries`, `GET /dead-letters` — Authenticated wallet paginated delivery & DLQ inspection.
* `GET /unsubscribe?token=...` / `POST /unsubscribe` — Single-purpose HMAC-signed unsubscribe endpoint.
* `DELETE /user/data` — Deletes all `notif_*` records for the authenticated wallet.

---

## Commands

```bash
cd notifications
cp .env.example .env
npm install
npm run build

# Single poll & delivery pass
npm run once

# Continuous daemon + HTTP API
npm start

# Base Mainnet fork lifecycle & hardening tests
npm test
```
