# NOSTOK Phase 4 Pre-Audit Verification & Scope Package

Prepared for external Tier-1 smart contract audit (`WS4.4` / `M4.1`), documenting the exact in-scope contracts, governance & upgradeability boundaries, formal verification (`Halmos 0.3.3` / `WS4.3`), and 1,000,000-call stateful fuzzing (`Echidna 2.4.0` / `WS4.2`).

## 1. In-Scope Smart Contracts (`contracts/src/`)

All 10 implementation contracts (`2,587` total lines) and 10 interface files (`435` total lines) sum to `3,022` total lines across `contracts/src/`:

| Contract | File | Lines | Upgradeability / Governance |
|---|---|---|---|
| `CollateralEscrow` | `contracts/src/CollateralEscrow.sol` | 95 | Immutable; `owner = NostokTimelock` (48h delay) authorizes cores |
| `PositionNFT` | `contracts/src/PositionNFT.sol` | 144 | Immutable; `owner = NostokTimelock`, `EligibilityGate` checked on transfers |
| `NostokTimelock` | `contracts/src/NostokTimelock.sol` | 18 | Immutable OZ `TimelockController`, `MIN_DELAY = 48 hours`, self-administered (`admin = address(0)`) |
| `EligibilityGate` | `contracts/src/EligibilityGate.sol` | 141 | Non-proxied; owner/operator gated (`NostokTimelock` + offchain EIP-712 attestation signer) |
| `AssetRegistry` | `contracts/src/AssetRegistry.sol` | 136 | UUPS proxy; `owner = NostokTimelock`, `guardian = Guardian Safe` (tightening only) |
| `OracleRouter` | `contracts/src/OracleRouter.sol` | 400 | UUPS proxy; `owner = NostokTimelock`; Chainlink L2 sequencer feed + NYSE 2024-2030 calendar + B20 split detection |
| `FeeCollector` | `contracts/src/FeeCollector.sol` | 130 | UUPS proxy; `owner = NostokTimelock`; immutable caps (100 / 2000 / 300 bps) |
| `LoanCore` | `contracts/src/LoanCore.sol` | 761 | UUPS proxy; `owner = NostokTimelock`, `guardian = Guardian Safe` (`setPaused`, unstoppable exit paths) |
| `LiquidationAuction` | `contracts/src/LiquidationAuction.sol` | 401 | UUPS proxy; `owner = NostokTimelock`; `guardian`/owner `emergencyCancelAuction` (stale/frozen + 1h cooldown) |
| `OrderSettlement` | `contracts/src/OrderSettlement.sol` | 317 | UUPS proxy; `owner = NostokTimelock`; EIP-712/ERC-1271 order/offer fills & nonces |
| Interfaces (`contracts/src/interfaces/*.sol`) | 10 files | 435 | `IAssetRegistry`, `ICollateralEscrow`, `IEligibilityGate`, `IFeeCollector`, `ILiquidationAuction`, `ILoanCore`, `IOracleRouter`, `IOrderSettlement`, `IPositionNFT`, `AggregatorV3Interface` |

> **Deferred from Phase 1 (`M1.4`) for audit-window evaluation:** Secondary DEX TWAP (`DISPUTED` oracle state) sanity check against Aerodrome/Uniswap, Euler collateral yield strategy (`yieldMode` reserved field), and pull-based collateral claim queue for B20 issuer pauses remain out-of-scope / unimplemented in `contracts/src/`.

## 2. Roadmap Invariant Coverage Matrix

| # | Roadmap Invariant | Foundry Invariants / Fuzz (`WS4.1` / `WS4.2`) | Echidna 1M-Run (`WS4.2`) | Halmos Symbolic Proofs (`WS4.3`) |
|---|---|---|---|---|
| 1 | Collateral Solvency | `invariant_1_CollateralSolvency` | `echidna_1_collateral_solvency` | Verified via `CollateralEscrow` deposit/release & `AuctionBuy` conservation |
| 2 | Escrow Isolation | `invariant_2_StrictEscrowIsolation` | `echidna_2_strict_escrow_isolation` | `check_CollateralEscrowIsolation` |
| 3 | Unstoppable Exit Paths (`repay` / `topUp` / `claim` / floor auction buy) | `invariant_3_UnstoppableProtocolLiquidity` | `echidna_3_unstoppable_liquidity` | Verified across unit + stress + fork pause/freeze drills |
| 4 | Valid Auction Condition & Lock Parity | `invariant_4_ValidAuctionConditionAndLockParity` | `echidna_4_valid_auction_condition` | `check_CloseFactor*` (6/8/18 dec, partial/full buckets, symbolic shares/price) |
| 5 | Borrower Surplus Protection & Leftover Return | `invariant_5_BorrowerSurplusProtection` | `echidna_5_borrower_surplus_protection` | `check_AuctionWaterfall*` (6/8/18 dec, joint `principal x shares x crashPrice`) |
| 6 | Debt Payoff, Hard Fee Caps & Strict Nonce Monotonicity | `invariant_6_DebtPayoffCapsFeesAndNonces` | `echidna_6_debt_payoff_caps_and_fees` | `check_SimpleInterest*`, `check_GracePenalty*`, `check_MinInterestFloor*`, `check_ExtendCaps*`, `check_AuctionWaterfall_FeeCollectorConservation` |
| 7 | 0-Wei Credit Conservation | `invariant_7_CreditConservation` | `echidna_7_credit_conservation` | `check_AuctionWaterfallWide_*`, `check_AuctionWaterfall_JointPriceSharesPrincipal_*`, `check_AuctionBuy_SymbolicAmountAndDust` |
| 8 | Claimant Entitlement (`ownerOf(loanId)`) | `invariant_8_ClaimantEntitlement` | `echidna_8_claimant_entitlement` | `check_AuctionWaterfall*` `lenderWallet` claimable conservation |
| 9 | Liveness & Silent-Revert Guard | `test_WS42_EchidnaHarnessAll8PropertiesPass`, `test_WS42_EchidnaHarnessRandom500StepCampaign` | `echidna_9_liveness_no_silent_reverts` | — |

## 3. Verification Evidence & Reproduction

### 3.1 Halmos 0.3.3 Formal Verification (`34/34` Passed)
- Config: [contracts/halmos.toml](../contracts/halmos.toml) (`contract = "FormalPropertiesTest"`, `solver = "yices"`, `loop = 2`, `solver_timeout_branching = "20ms"`, `solver_timeout_assertion = "60s"`).
- Suite: [contracts/test/FormalProperties.t.sol](../contracts/test/FormalProperties.t.sol).
- Command:
  ```bash
  cd contracts && forge clean && halmos
  ```
- Latest verified run: `Symbolic test result: 34 passed; 0 failed; time: 575.81s` (`build: 43.11s, total: 619.24s`), including:
  - Joint 3-variable interest proof: `check_SimpleInterestFormula_JointPrincipalRateTerm(uint64,uint16,uint16)` (`14.29s`).
  - Joint 3-variable waterfall proofs: `check_AuctionWaterfall_JointPriceSharesPrincipal_Full` (`78.65s`) and `_Partial` (`190.85s`) across `[1,000 .. 50,000]` USDC, `[10 .. 1,000]` shares, and `[$5 .. $5,000]` price with liquidation fee, interest cut, and reserve split active.
  - Wide close-factor & waterfall proofs across 6-, 8-, and 18-decimal collateral (`[1,000 .. 50,000]` USDC), mid/high partial buckets (`$9.36k-$10.79k` and `$46.8k-$50k`), symbolic shares (`check_CloseFactor_SymbolicShares_50k`), grace penalty spread, `minInterestDays` floor, extend caps, and `CollateralEscrow` isolation.
  - Note on QF_BV boundary: 3-way joint `CloseFactor` (`bvudiv(symDebt, symShares * symPrice)` inside `LoanCore.startLiquidation`) exceeds QF_BV bit-blasting bounds in `yices`/`z3`, so it is covered by 2-variable symbolic Halmos proofs + 512-run 3-way Foundry fuzz (`test_JointCloseFactor_PriceSharesPrincipal_PartialAndFull`).

### 3.2 Echidna 2.4.0 1,000,000-Call Campaign (`9/9` Passed)
- Config: [contracts/echidna.yaml](../contracts/echidna.yaml) (`testLimit: 1000000`, `seqLen: 50`, `coverage: true`).
- Harness: [contracts/test/echidna/EchidnaHarness.sol](../contracts/test/echidna/EchidnaHarness.sol) (exercises open, repay, partialRepay, topUp, extend, liquidate, defaultAuction, buy, restart/cancel, NFT transfer, oracle freeze/recovery, leftover collateral return at `LoanCore.sol:701`, and bad-debt settlement at `LoanCore.sol:707-713`).
- Command:
  ```bash
  cd contracts && echidna --config echidna.yaml --format text . --contract EchidnaHarness
  ```
- Archived campaign log: [docs/echidna-1m-campaign.log](./echidna-1m-campaign.log)
  - `Total calls: 1000000`, `Unique instructions: 54705`, `Unique codehashes: 15`, `Corpus size: 47`, `Seed: 7881982332600955428`.
  - All 9 properties (`echidna_1` through `echidna_9`): `passing` (`0/9` failures).

### 3.3 Foundry Test Suite (`129/129` Passed)
- Command:
  ```bash
  cd contracts && forge test
  ```
- Covers all 13 contract test suites including 4/4 `InvariantsTest`, 8/8 `ExtendedInvariantsTest` (`runs: 64, calls: 1024, reverts: 0`), `SecurityBoundaryStressTest` (`test_WS42_*` mutation guards, 500-step Echidna campaign & 64x16 aggregate coverage), and 35/35 512-run `FormalPropertiesTest` fuzz tests.

### 3.4 Mainnet-Fork War Games, Smoke Preflight & Services
- Root UI/contracts integration fork suite (`npm run test:fork`): Base fork pinned to `FORK_BLOCK_NUMBER` (default `62164000`) with `deployBlock` passed in test overrides.
- Smoke preflight (`npm run test:smoke`), chaos war games (`npm run test:wargames`), full-stack war games (`npm run test:wargames:fullstack`), and service suites (`api`, `indexer`, `notifications`, `keeper`, `risk`).
