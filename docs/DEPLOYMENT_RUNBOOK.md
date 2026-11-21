# NOSTOK Production Base Mainnet Deployment Runbook

> [!IMPORTANT]
> **Target Network & Sequence:**
> Execute this runbook strictly in order for Base Mainnet (`chainId = 8453`). Every fail-closed check below (`evaluateSafeSnapshot`, `scripts/ws4_7_smoke_lib.mjs`, `FORK=false` backend startup gates, and `vite build` production env checks) is exercised end-to-end against a Base Mainnet fork in `npm run test:smoke`, `npm run test:wargames`, and `npm run test:wargames:fullstack`.
> After completing deployment and preflight verification here, proceed to [`WS4_7_MAINNET_SMOKE_RUNBOOK.md`](./WS4_7_MAINNET_SMOKE_RUNBOOK.md) (Phase 5 `M5.1`) **before** permitting any external borrower or lender traffic.

---

## 1. Pre-Deploy Security & Key Isolation Gates (`WS4.6`)

Verify all governance and signing infrastructure **before** broadcasting `DeployNostok.s.sol`:

1. **Key & Address Separation (Zero Role Reuse):**
   - `DEPLOYER` (`DEPLOYER_PRIVATE_KEY` or hardware signer): funds initial deployment gas only; receives **zero** post-deploy privileges on any contract (`DeployNostok.s.sol` revokes `DEPLOYER` from `EligibilityGate` and transfers core ownerships to `NostokTimelock`).
   - `OWNER_ADDRESS`: canonical verified Gnosis Safe multisig on Base (hardware signers, threshold $\ge 2$ required on mainnet). Controls `NostokTimelock` (proposer & executor) and owns `EligibilityGate` directly.
   - `GUARDIAN_ADDRESS`: separate canonical verified Gnosis Safe multisig (`threshold >= 2`, `!= DEPLOYER`, `!= OWNER_ADDRESS` recommended for strict separation).
   - `ATTESTATION_SIGNER`: dedicated Reg S attestation signer (`!= DEPLOYER`).
   - `TREASURY_ADDRESS` & `RESERVE_ADDRESS`: protocol fee splitter destinations (`!= DEPLOYER`).
   - `KEEPER_PRIVATE_KEY`: dedicated hot EOA funded solely for gas (`MIN_KEEPER_ETH=0.01` threshold).

2. **Out-of-Band Safe Multisig Verification (Anti-EIP-7702 Check):**
   - `DeployNostok.s.sol` checks `guardian.code.length > 0`, which EIP-7702 delegated EOAs (`0xef0100...` bytecode prefix) would also pass.
   - Confirm via BaseScan and direct JSON-RPC calls against `OWNER_ADDRESS` and `GUARDIAN_ADDRESS`:
     - Non-zero bytecode **without** `0xef0100` delegation prefix.
     - Verified canonical Gnosis Safe `VERSION()`, `getOwners()`, and `getThreshold() >= 2`.
     - Zero overlap between `DEPLOYER` / `ATTESTATION_SIGNER` and Safe owner sets where required by `scripts/ws4_7_smoke_lib.mjs` (`evaluateSafeSnapshot`).

3. **Foundry Toolchain & Contract Verification:**
   ```bash
   cd contracts
   forge test
   ```
   Confirm `foundry.toml` settings (`solc_version = "0.8.28"`, `evm_version = "cancun"`, `optimizer = true`, `optimizer_runs = 200`, `via_ir = true`) and zero failing tests.

---

## 2. Core Smart Contract Deployment (`contracts/script/DeployNostok.s.sol`)

1. **Export Verified Deployment Environment Variables:**
   ```bash
   export BASE_RPC_URL="https://<your-dedicated-base-mainnet-rpc>"
   export ETHERSCAN_API_KEY="<your-basescan-etherscan-api-key>"
   export OWNER_ADDRESS="0x..."
   export GUARDIAN_ADDRESS="0x..."
   export TREASURY_ADDRESS="0x..."
   export RESERVE_ADDRESS="0x..."
   export ATTESTATION_SIGNER="0x..."
   # Optional overrides on chainId 8453 (defaults shown):
   export USDC_ADDRESS="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
   export SEQUENCER_FEED="0xBCF85224fc0756B9Fa45aA7892530B47e10b6433"
   ```
   Supply deployer signing via `DEPLOYER_PRIVATE_KEY` (or a Foundry keystore / hardware wallet flag such as `--account` or `--ledger` so `DEPLOYER_PRIVATE_KEY` stays off shell history).

2. **Dry-Run Simulation First, Then Broadcast:**
   ```bash
   cd contracts
   # 1. Dry-run without --broadcast
   forge script script/DeployNostok.s.sol --rpc-url "$BASE_RPC_URL"

   # 2. Broadcast & verify on BaseScan using ETHERSCAN_API_KEY from env (never via CLI flag)
   forge script script/DeployNostok.s.sol \
     --rpc-url "$BASE_RPC_URL" \
     --broadcast \
     --verify
   ```

3. **Record Deployment Output & Block Height:**
   Save the exact deployed addresses and broadcast block number (`DEPLOY_BLOCK` / `START_BLOCK` / `VITE_DEPLOY_BLOCK`):
   - Immutable contracts: `CollateralEscrow`, `PositionNFT`, `EligibilityGate`, `NostokTimelock` (`48h` = `172800s` min delay, `admin = address(0)`)
   - UUPS `ERC1967Proxy` addresses: `AssetRegistry`, `OracleRouter`, `FeeCollector`, `LoanCore`, `LiquidationAuction`, `OrderSettlement`

4. **Verify Post-Deploy Ownership & Wiring On-Chain:**
   - `owner()` on `CollateralEscrow`, `PositionNFT`, `AssetRegistry`, `OracleRouter`, `FeeCollector`, `LoanCore`, `LiquidationAuction`, and `OrderSettlement` **must** equal `NostokTimelock`.
   - `EligibilityGate.owner()` **must** equal `OWNER_ADDRESS`; `EligibilityGate.isOperator(OWNER_ADDRESS)` **must** be `true`; `EligibilityGate.isOperator(DEPLOYER)` **must** be `false`; `EligibilityGate.permissionlessMode()` **must** be `false`.
   - `CollateralEscrow.authorizedCores(LoanCore)` == `true`, `CollateralEscrow.authorizedCores(LiquidationAuction)` == `true`, `PositionNFT.authorizedCores(LoanCore)` == `true`.

---

## 3. Mandatory 48-Hour Governance Initialization (Before Any Trade)

> [!CAUTION]
> `LoanCore.initialize()` sets `globalUsdcCap = 250_000 * 1e6` ($250,000 USDC). Because `LoanCore`, `AssetRegistry`, and `OracleRouter` are owned by `NostokTimelock` (48h delay), the Owner Safe must queue and execute the initialization batch **before** `WS4.7` smoke testing or public access. **Never raise caps above initial guarded launch caps prior to publishing the Tier-1 external audit report.**

1. **Schedule `NostokTimelock` Batch via `OWNER_ADDRESS` Safe (Wait >= 48 Hours, Then Execute):**
   - `LoanCore.setGlobalCap(10_000_000_000)` ($10,000 USDC — within the $5,000–$25,000 initial aggregate guarded launch cap range).
   - `AssetRegistry.setAssetConfig(token, cfg)` using the exact `IAssetRegistry.AssetConfig` struct fields for pinned Base Mainnet Tier A B20 equities (`feed`, `feedDecimals = 8`, `tier = 0` (`Tier A`), `maxInitLtvBps = 6000`, `marginCallLtvBps = 7000`, `liqLtvBps = 7800`, `badDebtLtvBps = 9000`, `maxDiscountBps = 600`, `closedMarketHaircutBps = 500`, `perLoanCap = 1_000_000_000`, `assetCap = 5_000_000_000`, `maxStaleOpenSecs = 21600`, `status = 0` (`Active`), `restricted = false` so allowlisted/permissionless liquidations can clear without per-asset liquidator restrictions):
     - `NVDAc` (`0xb20000000000000000000078ee7ce2fE4908108C`) -> `feed = 0x04689a41629776563E6822F76f2e57D148d28513` (Chainlink `NVDA / USD`, `feedDecimals = 8`)
     - `METAc` (`0xb2000000000000000000008bC8786B856E61707C`) -> `feed = 0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D` (Chainlink `META / USD`, `feedDecimals = 8`)
     - *(Minimum interest duration is passed per loan in `LoanCore.openLoan`, and closed-market staleness `360000`s is a single contract-wide `OracleRouter` setting rather than per-asset `AssetConfig` fields.)*
   - Confirm `OracleRouter.recordedMultiplier(NVDAc)` and `OracleRouter.recordedMultiplier(METAc)` are non-zero (call permissionless `OracleRouter.syncMultiplier(token)` if any baseline is `0`).

2. **Configure `EligibilityGate` Allowlist (Direct Owner Safe Call, Zero Timelock Delay):**
   - Call `EligibilityGate.setAllowlistBatch([...smokeWallets], true)` strictly for controlled internal verification wallets during initial launch (`permissionlessMode` remains `false`).

---

## 4. Database & Role Provisioning (PostgreSQL)

Provision PostgreSQL with **strict role separation** (all off-chain services refuse `memory://` or embedded PGlite when `FORK=false`). Because `notifications/src/db.ts` (`initNotifSchema`) runs `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE`, and `CREATE INDEX IF NOT EXISTS` on startup, grant `CREATE` on its isolated `nostok_notifications` database/schema (or pre-create the `notif_*` tables owned by `nostok_notif`).

### 4.1 Run Now (Before Starting Any Service)

```sql
CREATE ROLE nostok_indexer WITH LOGIN PASSWORD '<INDEXER_PASSWORD>';
CREATE ROLE nostok_ro      WITH LOGIN PASSWORD '<READONLY_PASSWORD>';
CREATE ROLE nostok_notif   WITH LOGIN PASSWORD '<NOTIF_PASSWORD>';

-- 1. Indexer database & writer role (creates & updates all 11 indexer tables)
CREATE DATABASE nostok OWNER nostok_indexer;
REVOKE CONNECT, TEMP ON DATABASE nostok FROM PUBLIC;
GRANT CONNECT ON DATABASE nostok TO nostok_indexer, nostok_ro;
\c nostok
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO nostok_indexer;
GRANT USAGE ON SCHEMA public TO nostok_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE nostok_indexer IN SCHEMA public
  GRANT SELECT ON TABLES TO nostok_ro;

-- 2. Isolated notifications database & role (initNotifSchema runs DDL + DML on notif_* tables)
CREATE DATABASE nostok_notifications OWNER nostok_notif;
REVOKE CONNECT, TEMP ON DATABASE nostok_notifications FROM PUBLIC;
GRANT CONNECT ON DATABASE nostok_notifications TO nostok_notif;
\c nostok_notifications
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO nostok_notif;
```

### 4.2 Run After First Service Start (`indexer` & `notifications` Initial Sync)

Execute after `cd indexer && npm run once` and `cd notifications && npm run once` create the schema tables:

```sql
\c nostok
GRANT SELECT ON TABLE
  indexer_state, indexed_blocks, assets, loans, loan_events,
  orders, order_fills, auctions, auction_buys, positions, claims
TO nostok_ro;

\c nostok_notifications
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  notif_nonces, notif_subscriptions, notif_preferences, notif_deliveries,
  notif_dead_letters, notif_cursor, notif_alert_episodes, notif_revoked_sessions,
  notif_blocked_senders, notif_verify_sends, notif_verify_target_state, notif_manage_token_usage
TO nostok_notif;
```

1. **Indexer Writer (`nostok_indexer`)**: Creates and writes the 11 indexer tables in `nostok`; no other service holds write grants on them.
2. **Read-Only Query Role (`nostok_ro`)**: Used by `api/` (`DATABASE_URL`), `risk/` (`DATABASE_URL`), and `notifications/` (`INDEXER_DATABASE_URL`); zero `INSERT`/`UPDATE`/`DELETE`/`DDL`/superuser privileges.
3. **Scoped Notifications Role (`nostok_notif`)**: Used only by `notifications/` (`DATABASE_URL`) against `nostok_notifications`; holds `USAGE, CREATE` on its own isolated schema (or pre-created `notif_*` tables owned by `nostok_notif`) and zero privileges on `nostok` indexer tables.

---

## 5. Off-Chain Services Deployment Order (`FORK=false`)

Configure each service from its `.env.example` (never commit `.env` files), using dedicated private archive/read Base RPC endpoints (`https://...`), never public `https://mainnet.base.org`. Start services in order:

### 5.1 Indexer (`indexer/`) — Start First
- Copy [`indexer/.env.example`](../indexer/.env.example) -> `indexer/.env`.
- Required settings: `FORK=false`, archive-capable `RPC_URL`, writer `DATABASE_URL=postgresql://...`, `START_BLOCK=<deployBlock>`, `CONFIRMATIONS=12`, all 7 contract addresses (`LOAN_CORE_ADDRESS`, `ORDER_SETTLEMENT_ADDRESS`, `LIQUIDATION_AUCTION_ADDRESS`, `POSITION_NFT_ADDRESS`, `COLLATERAL_ESCROW_ADDRESS`, `ASSET_REGISTRY_ADDRESS`, `ORACLE_ROUTER_ADDRESS`), `ASSET_LIST=<NVDAc>,<METAc>`.
- Run initial sync & verify catch-up before starting readers:
  ```bash
  cd indexer && npm install && npm run build && npm run once
  # Once verified against chain head:
  npm start
  ```

### 5.2 Risk Monitor (`risk/`)
- Copy [`risk/.env.example`](../risk/.env.example) -> `risk/.env`.
- Required settings: `HOST=127.0.0.1` (keep `/risk/*` and `/metrics` behind internal network/VPN), `FORK=false`, `RPC_URL`, read-only `DATABASE_URL` (`nostok_ro`), 5 contract addresses (`LOAN_CORE_ADDRESS`, `LIQUIDATION_AUCTION_ADDRESS`, `COLLATERAL_ESCROW_ADDRESS`, `ASSET_REGISTRY_ADDRESS`, `ORACLE_ROUTER_ADDRESS`), optional `WEBHOOK_URL`.
- Verify single scan & start:
  ```bash
  cd risk && npm install && npm run build && npm run once
  npm start
  ```

### 5.3 Read-Only API (`api/`)
- Copy [`api/.env.example`](../api/.env.example) -> `api/.env`.
- Production fail-closed settings (`FORK=false` refuses startup without them unless `GEO_DISABLED=true`):
  - `DATABASE_URL` = read-only `nostok_ro` PostgreSQL URL (**zero** private keys in `api/`).
  - `TRUST_PROXY=1` (or exact proxy hop count) and `GEO_REQUIRE_HEADER=true`.
  - **Proxy origin lock (`TRUSTED_PROXY_CIDRS`)**: configure exact Cloudflare / reverse-proxy IPv4/IPv6 CIDRs **and** firewall the API port to proxy IPs only so spoofed `cf-ipcountry` / `X-Forwarded-For` headers fail closed (`403 GEO_UNTRUSTED_PROXY`).
  - `GEO_COUNTRY_HEADER=cf-ipcountry`, `GEO_RESTRICTED_COUNTRIES=US,CU,IR,KP,SY,RU,BY,MM`.
  - Populate `SANCTIONED_ADDRESSES` (otherwise startup logs `[API_SECURITY_WARNING]`).
  - Set `CORS_ORIGINS` to your hosted frontend origin, all 9 contract addresses (`LOAN_CORE_ADDRESS` through `ELIGIBILITY_GATE_ADDRESS`), and `USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Build and start:
  ```bash
  cd api && npm install && npm run build && npm start
  ```

### 5.4 Notifications Service (`notifications/`)
- Copy [`notifications/.env.example`](../notifications/.env.example) -> `notifications/.env`.
- Required fail-closed production settings (`FORK=false`):
  - `DATABASE_URL` (`nostok_notif`), `INDEXER_DATABASE_URL` (`nostok_ro`), `RISK_API_URL=http://127.0.0.1:3002`.
  - `PUBLIC_BASE_URL=https://notifications.nostok.xyz` (`https://` required), `SIWE_DOMAIN=app.nostok.xyz` (must match hosted `window.location.host`), `SIWE_URI=https://app.nostok.xyz`, `CORS_ORIGINS=https://app.nostok.xyz` (wildcard `*` rejected).
  - Independent high-entropy secrets (all distinct, >=24 chars / 64-hex AES-256 key): `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEYS` / `ENCRYPTION_KEY`, `UNSUBSCRIBE_SECRET`, `CONFIRM_SECRET`, `SESSION_SECRET`, `PII_HASH_SECRET`, `WEBHOOK_SIGNING_SECRET`, plus optional `ADMIN_SECRET`.
  - Configure delivery channels (`SMTP_API_URL`, `SMTP_API_KEY`, `EMAIL_FROM`, `TELEGRAM_BOT_TOKEN`) and 5 contract addresses.
- Verify single pass and start:
  ```bash
  cd notifications && npm install && npm run build && npm run once
  npm start
  ```

### 5.5 Autonomous Keeper (`keeper/`) — Dry Run First
- Copy [`keeper/.env.example`](../keeper/.env.example) -> `keeper/.env`.
- Configure `FORK=false`, `RPC_URL`, `KEEPER_PRIVATE_KEY` (env var only; never in JSON config), `ORACLE_ROUTER_ADDRESS`, `ASSET_REGISTRY_ADDRESS`, `LOAN_CORE_ADDRESS`, `LIQUIDATION_AUCTION_ADDRESS`, `ASSET_LIST=<NVDAc>,<METAc>`, `MAX_GAS_PRICE_GWEI=50`, `MIN_KEEPER_ETH=0.01`, `TELEGRAM_WEBHOOK_URL` / `TELEGRAM_CHAT_ID`.
- Execute **simulation first (`DRY_RUN=true`)** and inspect simulated `syncMultiplier`, `startLiquidation`, and `restartOrCancelAuction` output before enabling live broadcasts (`DRY_RUN=false`):
  ```bash
  cd keeper && npm install && npm run build
  DRY_RUN=true npm run once
  # After verifying logs & ETH balance >= 0.05 ETH:
  DRY_RUN=false npm start
  ```

---

## 6. Frontend Production Build & Static Hosting (`src/`)

Configure production build variables from [`.env.example`](../.env.example). `src/lib/contracts.js` fails closed if `VITE_IS_FORK=true`, `VITE_CHAIN_ID != 8453`, public `https://mainnet.base.org` is used as `VITE_RPC_URL`, any service URL is non-`https://`, `VITE_USDC_ADDRESS` is overridden away from Base USDC, or any of the 8 core contract addresses are missing:

```bash
VITE_CHAIN_ID=8453 \
VITE_IS_FORK=false \
VITE_RPC_URL="https://<private-base-rpc>" \
VITE_API_URL="https://<api-domain>" \
VITE_NOTIFICATIONS_URL="https://<notifications-domain>" \
VITE_RISK_URL="https://<risk-domain>" \
VITE_SIWE_DOMAIN="<frontend-host>" \
VITE_SIWE_ORIGIN="https://<frontend-host>" \
VITE_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
VITE_LOAN_CORE_ADDRESS="0x..." \
VITE_ORDER_SETTLEMENT_ADDRESS="0x..." \
VITE_LIQUIDATION_AUCTION_ADDRESS="0x..." \
VITE_POSITION_NFT_ADDRESS="0x..." \
VITE_COLLATERAL_ESCROW_ADDRESS="0x..." \
VITE_ASSET_REGISTRY_ADDRESS="0x..." \
VITE_ORACLE_ROUTER_ADDRESS="0x..." \
VITE_ELIGIBILITY_GATE_ADDRESS="0x..." \
VITE_DEPLOY_BLOCK="<deployBlock>" \
npm run build
```

Verify `npm test` passes and deploy the generated static bundle from `dist/` behind Cloudflare / TLS reverse proxy injecting `cf-ipcountry`.

---

## 7. Post-Deploy Validation Gate & `WS4.7` Handoff

Before clearing guarded launch or inviting allowlisted wallets:

1. **Automated On-Chain & Safe Preflight Gate (Must Exit `0`):**
   Export the deployed addresses (`OWNER_SAFE_ADDRESS`, `GUARDIAN_SAFE_ADDRESS`, `NOSTOK_TIMELOCK_ADDRESS`, all 9 protocol addresses, `SMOKE_ASSETS="NVDAc:0xb20000000000000000000078ee7ce2fE4908108C,METAc:0xb2000000000000000000008bC8786B856E61707C"`, `SMOKE_ALLOWLIST`) and run:
   ```bash
   node scripts/ws4_7_smoke_lib.mjs --rpc-url "$BASE_RPC_URL"
   ```
   Confirm `15/15 WS4.7 guarded preflight checks passed` (`globalUsdcCap < 250,000 USDC`, 2-of-2 non-EIP-7702 Safes, 48h timelock, `permissionlessMode == false`, pinned real `NVDAc`/`METAc` tokens + Chainlink feeds, synced multipliers, active sequencer feed).
2. **Backend & Indexer Health Verification:**
   - `GET <api>/health` -> HTTP `200`, `status: "ok"`, `db_ok: true`, `rpc_ok: true`, `within_lag_threshold: true`, `geo.mode: "enforced"` (when proxy headers active).
   - `GET <risk>/risk/summary` -> HTTP `200`, `monitor_degraded: false`, `protocol_paused: false`, `global_usdc_cap.raw` matches lowered cap.
   - `GET <notifications>/health` -> HTTP `200`, both `notif_*` DB and read-only indexer DB healthy.
   - `GET <api>/assets` matches live `AssetRegistry` & `OracleRouter` values with zero discrepancies on the UI Markets view.
3. **Execute Guarded Live Smoke Test (`WS4.7` / `M5.1`):**
   Proceed directly to [`WS4_7_MAINNET_SMOKE_RUNBOOK.md`](./WS4_7_MAINNET_SMOKE_RUNBOOK.md) during active NYSE hours with Guardian Safe signers and keeper online.

---

## 8. Rollback & Incident Controls

- **Halfway / Interrupted `DeployNostok.s.sol` Broadcast:** Before the final step of `DeployNostok.s.sol` (`transferOwnership(address(timelock))` and `EligibilityGate.transferOwnership(multisigOwner)`), the `DEPLOYER` key temporarily still owns any already-broadcast contracts and `EligibilityGate` operator status. Do **not** point backends, the frontend, or `WS4.7` at a partial broadcast. Inspect `contracts/broadcast/DeployNostok.s.sol/8453/run-latest.json`, strip `DEPLOYER` authority on partial contracts (`LoanCore.setPaused(true)`, `EligibilityGate.setOperator(deployer, false)`, transfer ownership to `NostokTimelock` / `OWNER_ADDRESS` or abandon and re-run a clean `DeployNostok.s.sol` broadcast), and re-verify `owner()` and `isOperator(DEPLOYER) == false` before publishing addresses.
- **Cancel a Bad `NostokTimelock` Batch During the 48h Wait:** `NostokTimelock` (OpenZeppelin `TimelockController`, `admin = address(0)`) grants `CANCELLER_ROLE` to `OWNER_ADDRESS` alongside `PROPOSER_ROLE`. Compute `bytes32 id = timelock.hashOperationBatch(targets, values, payloads, predecessor, salt)` (or `hashOperation(...)` for a single call) and submit `NostokTimelock.cancel(id)` from the `OWNER_ADDRESS` Safe any time before execution while `isOperationPending(id)` is `true`.
- **Halt New Originations Immediately:** Guardian Safe executes `LoanCore.setPaused(true)` (existing borrower repayments, collateral top-ups, partial repayments, cancellations, and lender claims remain functional).
- **Restrict or Freeze an Asset:** Guardian Safe calls `AssetRegistry.setAssetStatus(token, 1)` (`ReduceOnly`) or `AssetRegistry.setAssetStatus(token, 3)` (`Frozen`) without timelock delay; only `NostokTimelock` governance can restore `Active (0)`.
- **Halt Keeper Auto-Broadcasts:** Stop the `keeper/` process or revert to `DRY_RUN=true` while investigating RPC/oracle incidents.
- **Keep External Access Closed Until Cleared:** Leave `EligibilityGate.permissionlessMode() == false` and allowlist empty/internal-only until `WS4.7` passes and Phase 4 Tier-1 audit remediation is published.
