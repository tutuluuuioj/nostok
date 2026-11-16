# NOSTOK Protocol

> Peer-to-peer, fixed-term repurchase (repo) market for tokenized stocks on Base (Chain ID: 8453).

[![Foundry Tests](https://img.shields.io/badge/Foundry-79%2F79%20Tests%20Passing-brightgreen)](#smart-contracts)
[![Network](https://img.shields.io/badge/Network-Base%20L2-blue)](#architecture)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

NOSTOK lets borrowers escrow tokenized equities (e.g. Coinbase B20 tokens such as `NVDAc`, `AAPLc`, `MSFTc`) to borrow USDC at fixed rates and terms (7 to 90 days). Lenders receive transferable ERC-721 Position NFTs representing the legal and economic claim to bullet repayment (principal + fixed interest).

---

## 🏛 Architecture Overview

```
+--------------------------------------------------------------------------------------------------+
|                                    NOSTOK PROTOCOL ARCHITECTURE                                  |
+--------------------------------------------------------------------------------------------------+
|                                                                                                  |
|   [ FRONTEND (nostok/src) ]                                                                      |
|   - React 18 + Vite + Plain CSS (src/styles.css)                                                |
|   - Pages: Borrow, Lend, Markets, Loans, Loan Detail, Positions, Risk, Alerts                      |
|                                                                                                  |
|                                         | Transactions & EIP-712 Orders                          |
|                                         v                                                        |
|   [ SMART CONTRACTS (nostok/contracts) ]                                                         |
|                                                                                                  |
|   IMMUTABLE CORE:                                                                                |
|   - CollateralEscrow.sol    : Custody in raw token units; authorizations governed via Timelock   |
|   - PositionNFT.sol         : ERC-721 debt claim (tokenId == loanId) with auction transfer lock  |
|                                                                                                  |
|   GOVERNANCE & UPGRADES (48-HOUR TIMELOCK CONTROLLER + MULTISIG + PROTOCOL GUARDIAN):            |
|   - NostokTimelock.sol      : OpenZeppelin 48h TimelockController governing escrow & proxies    |
|   - LoanCore.sol            : Bullet repayment, Actual/365 interest, EIP-712 extensions, grace  |
|   - OrderSettlement.sol     : EIP-712 orders, nonces, maker-authenticated cancellations          |
|   - LiquidationAuction.sol  : Linear Dutch auction, multi-buy waterfall, dust-rejection, refund  |
|   - OracleRouter.sol        : Sequencer uptime, DST calendar, holidays/half-days, B20 splits    |
|   - AssetRegistry.sol       : Risk configurations (LTV ceilings, discount bounds, caps, status)  |
|   - FeeCollector.sol        : Hardcoded contractual fee ceilings, treasury & reserve splits      |
|   - EligibilityGate.sol     : Modular Reg S non-US attestation gate (direct multisig ownership)  |
|                                                                                                  |
+--------------------------------------------------------------------------------------------------+
```

---

## 🧪 Smart Contracts & Test Suite

The protocol smart contracts are written in Solidity `^0.8.28` using Foundry with `--via-ir`.

### Core Contracts (`contracts/src/`)
* **`NostokTimelock.sol`**: 48-hour OpenZeppelin `TimelockController` governing all contract upgrades and `CollateralEscrow` authorizations.
* **`CollateralEscrow.sol`**: Immutable singleton custody contract for tokenized equities. Zero upgradeability; core authorization moves strictly through the 48-hour timelock.
* **`PositionNFT.sol`**: Immutable ERC-721 position claim representing bullet debt repayment entitlement. Features auction transfer locks, dynamic onchain SVG metadata, and `transferWithAttestation` compliance verification.
* **`LoanCore.sol`**: State machine managing loan origination, bullet repayment, dynamic `minInterestDays` early repay penalties (enforced strictly as a floor on total interest to avoid double-counting post-liquidation, with fair min floor charges when extending or partially buying within the window), 24h grace window (+5% penalty spread), interest-accruing partial repayments, EIP-712/ERC-1271 mutual consent extensions with expiration deadlines (strictly capped at 40% APR and cumulative 90 days from loan origination with prospective rate application and origination-rate floor anchoring), real accrued interest tracking via `loanTotalRealInterestAccrued` with zero dropped interest between checkpoints and settlements, single-source leftover collateral release upon debt payoff, zeroing collateralRaw upon repayment, repayment during auction, bad debt write-offs, and pull-based claims.
* **`OrderSettlement.sol`**: EIP-712 typed structured data verification for `BorrowOrder` and `LendOffer`, nonce bump invalidation, maker-authenticated cancellations (`msg.sender == maker`), partial fill execution, and compliance attestation verification with symmetric `(borrowerAttestation, lenderAttestation)` argument ordering.
* **`LiquidationAuction.sol`**: Linear decaying Dutch auction over 30 minutes with a 50% partial liquidation close factor. Tracks debt per buy, rejects dust buys (<$10), follows debt waterfall (fees -> real-time recomputed due interest -> principal), auto-closes dust remainders (<$10) by refunding residual dust collateral to the borrower, permits floor price execution and valid-closed/stale restarts over weekends/closed market sessions to prevent deadlocks (with Dutch restarts at last valid closed or stale price available to give borrowers orderly decay), allows floor buys when feeds are stale or frozen, and exposes `emergencyCancelAuction()` callable strictly by the protocol guardian or owner only when the feed is `STALE_FEED` or `FROZEN_CORPORATE_ACTION` (with a 1-hour per-loan cooldown). Reverts on expired buys past duration (`AuctionExpired`) during healthy open market hours. Leftover collateral is safely released exclusively via `LoanCore.onAuctionSettlement`, preventing double-release vulnerabilities across multiple loans.
* **`OracleRouter.sol`**: Validates Chainlink price feeds against Base Sequencer Uptime (1-hour grace), US equity market hours with Gregorian DST awareness, pre-loaded NYSE holiday calendar for 2024–2030 (including Thanksgiving, MLK, Christmas, July 3 half-days), 100-hour closed-market staleness threshold (accommodating weekend trading pauses), and Coinbase B20 token multiplier monitoring (initialized from `token.uiMultiplier()` on asset listing baseline via `AssetRegistry.setAssetConfig()`; unsynced tokens freeze; permissionless `syncMultiplier` ratchets up dividend drift <5%; corporate action splits >=5% freeze the asset until owner or guardian unfreezes post-split; recommended `maxStaleOpenSecs` is ~21600s / 6 hours to accommodate deviation-based Chainlink update cadence on Base).
* **`AssetRegistry.sol`**: Configures Tier A/B LTV boundaries, enforces maxStaleOpenSecs sanity bounds (1800s to 86400s), and verifies auction discount boundaries (100–3000 bps). Records multiplier baseline on `setAssetConfig` via `syncMultiplier` (safely checking `oracleRouter.code.length > 0` and wrapped in try/catch to ensure pending corporate action splits never revert risk configuration updates). Guardians can only tighten (Active -> ReduceOnly -> Frozen); only Governance can loosen.
* **`FeeCollector.sol`**: Enforces strict immutable fee ceilings (Origination max 1%, Interest cut max 20%, Liquidation max 3%).
* **`EligibilityGate.sol`**: Enforces Reg S non-US counterparty eligibility via allowlist, batch operator allowlisting, or signed EIP-712/ERC-1271 attestations bound to `(chainid, contract, account, nonce, expiry)` with safe non-reverting malformed context handling, per-user nonce bumping, and revocation (governed by dedicated attestation signer and multisig operator).

### Running Contract Tests

```bash
cd contracts
forge test
```

**Results:** 10 test suites, **84 tests passing (100%)** + **1,024 invariant fuzzing calls (0 reverts)** with `fail_on_revert = true`:
* `CollateralEscrowTest`: 6 passing (including 48h Timelock governance)
* `PositionNFTTest`: 4 passing (including transferWithAttestation)
* `AssetRegistryTest`: 7 passing (including maxStaleOpenSecs sanity range bounds, EOA router safety, discount parameter bounds, registry-to-router sync, and pending split tolerance)
* `FeeCollectorTest`: 3 passing (including hard caps)
* `EligibilityGateTest`: 5 passing (including ERC-1271 smart wallet attestation signers, malformed context safe handling, legacy 65-byte rejection, operator batch allowlisting, and revocation/nonces)
* `OracleRouterTest`: 18 passing (including false-stale prevention with 21600s threshold against 6,094s NVDA and 13,267s META gaps, asset listing baseline recording, unsynced split freeze, PMc 1.5588 baseline at launch, +4% repeated 5-step dividend ratcheting, 10:1 split freeze & sync, DST, 2024-2030 holidays, 100h closed staleness)
* `LoanCoreTest`: 19 passing (including extend at day 1 then repay at day 2 charging fair min floor, liquidation plus partial buy in window charging fair min floor, real accrued interest tracking in loanTotalRealInterestAccrued, EIP-712/ERC-1271 smart wallet extensions, cumulative 90-day cap, prospective rate application, partial auction buy interest tracking, repay during auction, partial repay interest)
* `LiquidationAuctionTest`: 15 passing (including stale feed restart age limits, paused-token transfer revert proving unmitigated pause risk, emergencyCancelAuction healthy oracle revert with cooldown, frozen asset underwater loan handling, expired auctions during open market with stale/frozen feeds permitting floor buys, weekend closed-market floor buys and restarts at last valid closed price, dust remainder auto-close & borrower refund, multi-loan single-token collateral isolation, post-duration expiry revert during healthy open hours, multi-buy debt reduction, partial liquidation health restoration, bad debt clearance, dust buy rejection, default settlement)
* `OrderSettlementTest`: 6 passing (including symmetric fillBorrowOrderWithAttestations & fillLendOfferWithAttestations, and maker-authenticated cancellation)
* `InvariantsTest`: 4 invariants passing across 1,024 calls with 0 reverts under `fail_on_revert = true` (Escrow Solvency, LoanCore USDC Solvency, Outstanding Principal, Asset Outstanding Principal under warp, price shifts, multi-borrower liquidations, default auctions, and partial buys)

---

## ⚠️ B20 Equity Token Risks & Protocol Safeguards

Tokenized equities on Base (such as Coinbase B20 tokens `NVDAc`, `AAPLc`, `MSFTc`) introduce specific legal, operational, and smart contract risks distinct from native crypto assets:

1. **Issuer Pause Risk**:
   - *Risk*: Coinbase B20 token contracts contain administrative pause functions that allow the issuer to globally freeze transfers in emergency situations or regulatory compliance events.
   - *Protocol Behavior & Unmitigated Risk*: Escrow collateral is isolated per loan inside `CollateralEscrow` with separate balance accounting. However, NOSTOK does not employ an asynchronous queue for ERC-20 token transfers. If token transfers are globally paused by the token issuer, `repay()` and auction `buy()` operations will revert when attempting to transfer underlying stock tokens. This is an unmitigated risk inherent to centralized token issuer controls until the token issuer unpauses transfers.
2. **Policy Engine & Transfer Restrictions**:
   - *Risk*: B20 tokens implement transfer hooks and compliance policy checks that can reject transfers to unverified, sanctioned, or non-whitelisted addresses.
   - *Protocol Safeguards*: `EligibilityGate` enforces pre-trade non-US Reg S verification and allowlisting on counterparties before orders can match or NFTs can transfer.
3. **Asset Seizure & Blacklisting**:
   - *Risk*: Regulated issuers maintain administrative authority to blacklist addresses or seize token balances in compliance with court orders or AML/sanctions mandates.
   - *Protocol Safeguards*: NOSTOK employs a non-custodial design without pooled lending reserves; each loan's collateral is accounted for individually. Lenders hold ERC-721 debt claim NFTs representing their entitlement to bullet repayment in USDC.
4. **Corporate Actions & Stock Splits**:
   - *Risk*: Corporate actions such as forward/reverse stock splits drastically change the supply and multiplier of the underlying tokenized shares.
   - *Protocol Safeguards*: `OracleRouter` continuously tracks token `uiMultiplier()`. Baseline multipliers are recorded upon listing; dividend drift (<5%) is absorbed via permissionless `syncMultiplier` synchronization callable by keepers or users; corporate action jumps ($\ge 5\%$) automatically freeze the asset in `OracleRouter` until governance or the protocol guardian validates and syncs post-split terms.
5. **Guardian Emergency Powers**:
   - The Protocol Guardian (multisig contract) has defined emergency capabilities:
     - Pausing and unpausing `LoanCore` (`setPaused`).
     - Tightening asset statuses in `AssetRegistry` to `ReduceOnly` or `Frozen` (loosening back to `Active` is strictly reserved for Timelock / Governance).
     - Calling `syncMultiplier` on `OracleRouter` to unfreeze assets after corporate action splits $\ge 5\%$.
     - Calling `emergencyCancelAuction()` with a 1-hour per-loan cooldown exclusively when oracle feeds are in `STALE_FEED` or `FROZEN_CORPORATE_ACTION` states.

---

## 💻 Frontend Application

The frontend UI is built with React 18, Vite, and plain CSS ([`src/styles.css`](src/styles.css)).

### Running the Frontend

```bash
# In project root
npm install
npm run dev
```

### Running Frontend Tests

```bash
npm test
```

---

## 🚀 Deployment to Base

Run the automated deployment script with Foundry:

```bash
cd contracts
forge script script/DeployNostok.s.sol --rpc-url <BASE_RPC_URL> --broadcast
```

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
