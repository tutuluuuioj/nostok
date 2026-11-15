# NOSTOK Protocol

> Peer-to-peer, fixed-term repurchase (repo) market for tokenized stocks on Base (Chain ID: 8453).

[![Foundry Tests](https://img.shields.io/badge/Foundry-34%2F34%20Tests%20Passing-brightgreen)](#smart-contracts)
[![Network](https://img.shields.io/badge/Network-Base%20L2-blue)](#architecture)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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
|   - CollateralEscrow.sol    : Holds collateral in raw token units; strictly isolated             |
|   - PositionNFT.sol         : ERC-721 debt claim (tokenId == loanId) with auction transfer lock  |
|                                                                                                  |
|   UUPS PROXIES (0-DELAY TIMELOCK / MULTISIG + 3/5 GUARDIAN):                                     |
|   - LoanCore.sol            : Bullet repayment, Actual/365 simple interest, early repay penalty |
|   - OrderSettlement.sol     : EIP-712 signed maker orders, nonces, partial fill tracking         |
|   - LiquidationAuction.sol  : Oracle-referenced Dutch auction, 50% close factor, surplus refund |
|   - OracleRouter.sol        : Chainlink feeds + Base sequencer uptime + US market session hours  |
|   - AssetRegistry.sol       : Risk configurations (LTV ceilings, haircuts, caps, statuses)       |
|   - FeeCollector.sol        : Hardcoded contractual fee ceilings, treasury & reserve splits      |
|   - EligibilityGate.sol     : Modular Reg S non-US attestation and sanctions gate               |
|                                                                                                  |
+--------------------------------------------------------------------------------------------------+
```

---

## 🧪 Smart Contracts & Test Suite

The protocol smart contracts are written in Solidity `^0.8.28` using Foundry with `--via-ir`.

### Core Contracts (`contracts/src/`)
* **`CollateralEscrow.sol`**: Immutable singleton custody contract for tokenized equities. Zero upgradeability, strictly restricted to authorized LoanCore versions and LiquidationAuction.
* **`PositionNFT.sol`**: Immutable ERC-721 position claim representing bullet debt repayment entitlement. Features auction transfer locks and dynamic onchain SVG metadata.
* **`LoanCore.sol`**: State machine managing loan origination, bullet repayment, early repayments (with `minInterestDays` penalty), grace periods (+5% penalty spread), partial repayments, top-ups, and pull-based claims.
* **`OrderSettlement.sol`**: EIP-712 typed structured data verification for `BorrowOrder` and `LendOffer`, nonce invalidation, cancellation, and partial fill execution.
* **`LiquidationAuction.sol`**: Linear decaying Dutch auction over 30 minutes with a 50% partial liquidation close factor. Surplus proceeds are credited directly to the borrower.
* **`OracleRouter.sol`**: Validates Chainlink price feeds against Base Sequencer Uptime (1-hour grace), US equity market hours (`VALID_OPEN` vs `VALID_CLOSED` with closed-market haircuts), and corporate action multiplier monitoring.
* **`AssetRegistry.sol`**: Configures Tier A/B LTV boundaries. Guardians can only tighten (reduce-only/freeze); only Governance can loosen.
* **`FeeCollector.sol`**: Enforces strict immutable fee ceilings (Origination max 1%, Interest cut max 20%, Liquidation max 3%).
* **`EligibilityGate.sol`**: Enforces Reg S non-US counterparty eligibility via allowlist or signed ECDSA attestations.

### Running Contract Tests

```bash
cd contracts
forge test -v
```

**Results:** 9 test suites, **34 tests passing (100%)**:
* `CollateralEscrowTest`: 5 passing
* `PositionNFTTest`: 3 passing
* `AssetRegistryTest`: 3 passing
* `FeeCollectorTest`: 3 passing
* `OracleRouterTest`: 6 passing
* `LoanCoreTest`: 6 passing
* `LiquidationAuctionTest`: 1 passing
* `OrderSettlementTest`: 4 passing
* `InvariantsTest`: 3 passing (Escrow Solvency, Unstoppable Liquidity, Credit Conservation)

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
