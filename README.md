# NOSTOK Protocol

> Peer-to-peer, fixed-term repurchase (repo) market for tokenized stocks on Base (Chain ID: 8453).

[![Foundry Tests](https://img.shields.io/badge/Foundry-61%2F61%20Tests%20Passing-brightgreen)](#smart-contracts)
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
* **`LoanCore.sol`**: State machine managing loan origination, bullet repayment, dynamic `minInterestDays` early repay penalties, 24h grace window (+5% penalty spread), interest-accruing partial repayments, EIP-712/ERC-1271 mutual consent extensions with expiration deadlines (strictly capped at 40% APR and cumulative 90 days from loan origination with prospective rate application), accrued-to timestamp tracking across partial liquidations/repayments, single-source leftover collateral release upon debt payoff, repayment during auction, bad debt write-offs, and pull-based claims.
* **`OrderSettlement.sol`**: EIP-712 typed structured data verification for `BorrowOrder` and `LendOffer`, nonce bump invalidation, maker-authenticated cancellations (`msg.sender == maker`), partial fill execution, and compliance attestation verification.
* **`LiquidationAuction.sol`**: Linear decaying Dutch auction over 30 minutes with a 50% partial liquidation close factor. Tracks debt per buy, rejects dust buys (<$10), follows debt waterfall (fees -> interest -> principal), and reverts on expired buys past duration (`AuctionExpired`) until keeper restart. Leftover collateral is safely released exclusively via `LoanCore.onAuctionSettlement`, preventing double-release vulnerabilities across multiple loans.
* **`OracleRouter.sol`**: Validates Chainlink price feeds against Base Sequencer Uptime (1-hour grace), US equity market hours with Gregorian DST awareness, pre-loaded NYSE holiday calendar for 2024–2028 (including Thanksgiving, MLK, Christmas, July 3 half-days), 100-hour closed-market staleness threshold (accommodating weekend trading pauses), and Coinbase B20 token multiplier monitoring (initialized from token, tolerating dividend drift <5%, and auto-freezing on corporate action splits >= 5% jump without price double-multiplication).
* **`AssetRegistry.sol`**: Configures Tier A/B LTV boundaries and verifies auction discount boundaries (100–3000 bps). Guardians can only tighten; only Governance can loosen.
* **`FeeCollector.sol`**: Enforces strict immutable fee ceilings (Origination max 1%, Interest cut max 20%, Liquidation max 3%).
* **`EligibilityGate.sol`**: Enforces Reg S non-US counterparty eligibility via allowlist, batch operator allowlisting, or signed EIP-712/ERC-1271 attestations bound to `(chainid, contract, account, nonce, expiry)` with per-user nonce bumping and revocation (owned directly by Multisig with deployer operator permissions revoked).

### Running Contract Tests

```bash
cd contracts
forge test
```

**Results:** 10 test suites, **61 tests passing (100%)** + **1,024 invariant fuzzing calls (0 reverts)**:
* `CollateralEscrowTest`: 6 passing (including 48h Timelock governance)
* `PositionNFTTest`: 4 passing (including transferWithAttestation)
* `AssetRegistryTest`: 4 passing (including discount parameter bounds)
* `FeeCollectorTest`: 3 passing (including hard caps)
* `EligibilityGateTest`: 2 passing (including operator batch allowlisting & instant attestations with revocation/nonces)
* `OracleRouterTest`: 12 passing (including DST, 2024-2028 holidays, B20 split auto-freeze & dividend tolerance, 100h closed staleness)
* `LoanCoreTest`: 16 passing (including EIP-712/ERC-1271 smart wallet extensions, cumulative 90-day cap, prospective rate application, partial auction buy interest tracking, repay during auction, partial repay interest)
* `LiquidationAuctionTest`: 8 passing (including multi-loan single-token collateral isolation, post-duration expiry revert, multi-buy debt reduction, partial liquidation health restoration, bad debt clearance, dust buy rejection, auction restart/cancel, default settlement)
* `OrderSettlementTest`: 5 passing (including attestation verification and maker-authenticated cancellation)
* `InvariantsTest`: 3 invariants passing across 1,024 calls (Escrow Solvency, Outstanding Principal, Asset Outstanding Principal under multi-borrower liquidations and partial buys)

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
