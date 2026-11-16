# NOSTOK User Notifications & Alerts Service (`WS2.6`)

Per-wallet notification service delivering margin call, liquidation, auction, maturity countdown, repayment, lender claimable, corporate-action freeze, and stale-oracle alerts across Email, Telegram, and Webhook channels (`TypeScript` + `viem` + `pg` + `zod`).

## Security & Isolation Guarantees

* **Zero Private Keys / Zero On-Chain Writes:** Holds no EOA or relayer keys and never signs or broadcasts transactions.
* **Read-Only Access to Indexer & Risk State:**
  * Production `INDEXER_DATABASE_URL` **must** use a PostgreSQL role restricted strictly to `SELECT` (`nostok_ro`), reinforced by `default_transaction_read_only=on`, `BEGIN READ ONLY`, short `statement_timeout`, and a lexical SQL tokenizer (`assertReadOnlySql`).
  * Production `DATABASE_URL` uses its own tables prefixed with `notif_*` (`notif_nonces`, `notif_subscriptions`, `notif_preferences`, `notif_deliveries`, `notif_dead_letters`, `notif_cursor`, `notif_alert_episodes`, `notif_revoked_sessions`). A dedicated `nostok_notif` DB role should have `SELECT/INSERT/UPDATE/DELETE` privileges **only** on `notif_*` tables and zero write privileges on indexer tables (`assertNotifTableSql` also enforces this at the application layer).
  * Consumes Risk Monitor state (`GET /risk/loans`, `GET /risk/alerts`) when `RISK_API_URL` is set, with direct read-only on-chain fallback if the risk monitor is unreachable.
* **Webhook SSRF Protection & HMAC Payload Signing:**
  * Webhook targets require `https://`, reject localhost, private, loopback, link-local, metadata (`169.254.169.254`), IPv6, and encoded IP forms (hex, octal, decimal, shorthand), resolve & validate DNS before socket connection, pin the validated IPv4 at connect time, disable redirects (`redirect: 'manual'`), apply per-host circuit breakers, and sign webhook payloads with `X-Nostok-Timestamp` + `X-Nostok-Signature` (`HMAC-SHA256`).
* **Minimal PII, Ownership Verification & Encryption at Rest:**
  * Enforces per-wallet subscription caps (default `5`), requires confirmation code/token verification for email and Telegram subscriptions before activation, encrypts targets with **AES-256-GCM** (`ENCRYPTION_KEYS` / `ENCRYPTION_KEY_ID`) + keyed lookup hashes (`PII_HASH_SECRET`), enforces distinct high-entropy secrets, and supports `DELETE /user/data`.
* **SIWE (EIP-4361) Wallet Ownership Proof & Session Revocation:**
  * `POST /auth/nonce` and `POST /auth/verify` are rate-limited per IP and per wallet, support EOA & EIP-1271 signatures, issue JWT-style HMAC sessions with `jti` claims, and support server-side revocation via `POST /auth/logout`.

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
| `loan_grace_entry` | `warning` | No | Loan passed maturity and entered 24h grace window |
| `penalty_interest_accruing` | `warning` | No | Overdue loan accruing penalty interest |
| `default_auction_pending` | `critical` | **Yes** | Loan exceeded `maturity + 24h` grace period awaiting default auction |
| `loan_repaid` | `info` | No | `Repaid` / `PartialRepaid` indexed event |
| `lender_claimable` | `info` | No | Lender has claimable USDC in `LoanCore` |
| `asset_frozen_or_corporate_action` | `critical` | **Yes** | Collateral asset frozen (`AssetStatus=Frozen` or `FROZEN_CORPORATE_ACTION` / multiplier freeze) |
| `oracle_stale` | `warning` | No | Collateral asset oracle feed reports `STALE_FEED` |

---

## Endpoints

* `GET /health` — Health status for both `notif_*` DB and read-only indexer DB.
* `POST /auth/nonce` — Issue a single-use SIWE nonce (`{ wallet_address }`).
* `POST /auth/verify` — Verify EIP-4361 SIWE message + signature (`{ message, signature }`) -> `{ token, jti, expires_at }`.
* `POST /auth/logout` — Revoke the caller's active Bearer session `jti`.
* `POST /subscriptions`, `GET /subscriptions` — Authenticated wallet channel management (`email`, `telegram`, `webhook`). Email & Telegram start `verified=false, enabled=false` until confirmed.
* `GET /subscriptions/confirm?token=...`, `POST /subscriptions/confirm` — Confirm subscription ownership via `{ token }` or `{ subscription_id, code }`.
* `GET /preferences`, `PUT /preferences` — Configure per-alert-type enable/disable flags, UTC `quiet_hours_start` / `quiet_hours_end`, and per-user `max_per_hour`.
* `GET /deliveries`, `GET /dead-letters` — Authenticated wallet paginated delivery & generic DLQ inspection (`last_error: "delivery failed"`).
* `GET /unsubscribe?token=...` — Read-only verification preview (`confirmation_required: true`); `POST /unsubscribe` executes the subscription disable.
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
