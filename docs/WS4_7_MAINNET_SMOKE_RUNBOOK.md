# WS4.7 Guarded Base Mainnet Smoke Test Runbook

> [!IMPORTANT]
> **Execution Timing — Phase 5 Only (`M5.1`):**
> This runbook governs the single guarded live smoke test on Base Mainnet (`chainId = 8453`) executed **once after Phase 5 Base Mainnet deployment**, Safe multisig & 48-hour `NostokTimelock` verification (`WS4.6`), and live keeper readiness (`WS2.5`).
> **Do not run as a pre-audit live test**, and **never** use mock ERC-20 tokens or mock Chainlink feeds on Base Mainnet.

---

## 1. Base Mainnet Reference Addresses

| Role | Base Mainnet (`8453`) Address / Parameter |
| --- | --- |
| Collateral / Debt Settlement Token (`USDC`) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Chainlink L2 Sequencer Uptime Feed | `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` |
| Governance Timelock (`NostokTimelock`) | `48 hours` (`172800s`), self-administered (`admin = address(0)`) |
| `LoanCore` Minimum Principal | `500 USDC` (`500_000_000` raw) |
| `LoanCore.initialize()` Default `globalUsdcCap` | `250_000 USDC` (**MUST be lowered before first loan**) |

---

## 2. Pre-Deploy & Governance Setup (`WS4.6` + `DeployNostok.s.sol`)

1. **Out-of-Band Safe Multisig Verification (`OWNER_ADDRESS` & `GUARDIAN_ADDRESS`):**
   - `DeployNostok.s.sol` checks `guardian.code.length > 0`, which EIP-7702 delegated EOAs (`0xef0100...`) also satisfy.
   - Before deploying, verify out-of-band on BaseScan and via Safe `getOwners()` / `getThreshold()` / `VERSION()` that both `OWNER_ADDRESS` and `GUARDIAN_ADDRESS` are canonical verified Safe multisig proxies controlled by hardware signers (threshold >= 2 recommended) and distinct from both `DEPLOYER` and `ATTESTATION_SIGNER`.

2. **Lower `LoanCore.globalUsdcCap` & List Real `NVDAc` / `METAc` Before First Loan:**
   - Because `DeployNostok.s.sol` transfers ownership of `LoanCore`, `AssetRegistry`, and `OracleRouter` to the 48-hour `NostokTimelock` (and `LoanCore.initialize` defaults `globalUsdcCap = 250_000 * 1e6`), the Owner Safe must queue and execute a `NostokTimelock` batch (`48h` delay) **before** opening any live trade:
     - `LoanCore.setGlobalCap(10_000_000_000)` ($10,000 USDC; allowed guarded launch ceiling <= $25,000 USDC — no raise above initial guarded launch caps prior to published Tier-1 audit report).
     - `AssetRegistry.setAssetConfig(NVDAc, ...)` & `AssetRegistry.setAssetConfig(METAc, ...)` using **real Coinbase B20 token contracts** and **real Chainlink Base feeds**:
       - `perLoanCap`: `500_000_000`–`1_000_000_000` ($500–$1,000 USDC)
       - `assetCap`: `5_000_000_000` ($5,000 USDC; <= $25,000 guarded max)
       - `maxStaleOpenSecs`: `21600` (6 hours, within `1800`–`86400`s)
       - Tier A LTVs: `6000 / 7000 / 7800 / 9000` bps, `maxDiscountBps = 600`, `closedMarketHaircutBps = 500`, `status = Active (0)`
     - Call `OracleRouter.syncMultiplier(NVDAc)` and `OracleRouter.syncMultiplier(METAc)` to record baseline B20 `uiMultiplier()`.
   - Confirm `EligibilityGate.permissionlessMode() == false` and allowlist only internal verification wallets (`EligibilityGate.setAllowlistBatch([...], true)` directly from Owner Safe).

---

## 3. Automated Preflight Verification Gate

Run the fork dry-run suite locally before mainnet execution:

```bash
npm run test:smoke
```

Before submitting the first live Base Mainnet (`8453`) smoke order, run the automated preflight CLI against the production Base RPC:

```bash
node scripts/ws4_7_smoke_lib.mjs \
  --rpc-url "$BASE_RPC_URL" \
  --production
```

Required environment variables for `scripts/ws4_7_smoke_lib.mjs`:
- `OWNER_SAFE_ADDRESS`, `GUARDIAN_SAFE_ADDRESS`, `NOSTOK_TIMELOCK_ADDRESS`
- `LOANCORE_ADDRESS`, `ORDER_SETTLEMENT_ADDRESS`, `LIQUIDATION_AUCTION_ADDRESS`
- `POSITION_NFT_ADDRESS`, `COLLATERAL_ESCROW_ADDRESS`, `ASSET_REGISTRY_ADDRESS`
- `ORACLE_ROUTER_ADDRESS`, `ELIGIBILITY_GATE_ADDRESS`, `FEE_COLLECTOR_ADDRESS`
- `SMOKE_ASSETS` (e.g. `NVDAc:0x...,METAc:0x...`), plus optional `SMOKE_ALLOWLIST` and `DEPLOYER_ADDRESS`

Preflight **must exit `0`** (all checks passing: non-EIP-7702 Safes, 48h timelock, `globalUsdcCap < 250,000 USDC`, `permissionlessMode == false`, active sequencer feed, Tier-A caps/LTVs, synced `recordedMultiplier`, and zero mock tokens or feeds).

---

## 4. Guarded Execution Steps (`WS4.7`)

Execute only during active NYSE market hours with keeper and Guardian Safe signers online:

1. **Guardian Pause Verification:**
   - Have Guardian Safe pause and unpause `LoanCore.setPaused(true)` -> confirm `setPaused(false)` before originating smoke positions.
2. **Step 1 — Originate Real Micro-Loans (`NVDAc` & `METAc`, ~$500–$750 USDC):**
   - Sign Regulation S declarations and obtain `ATTESTATION_SIGNER` attestations for the internal borrower and lender wallets.
   - Approve exact collateral to `CollateralEscrow` (never `MaxUint256`) and exact USDC to `LoanCore`.
   - Settle one loan on `NVDAc` (`BorrowOrder`) and one on `METAc` (`LendOffer`).
   - Verify `CollateralEscrow.balanceOf` deltas, `PositionNFT.ownerOf(loanId)`, `LoanCore.totalOutstandingPrincipal`, and `FeeCollector` origination split (`0.10%`).
3. **Step 2 — Loan Lifecycle & Exit Verification (`NVDAc` Loan):**
   - Execute `LoanCore.topUp()` (+collateral) and confirm `CollateralEscrow` balance increase.
   - Execute `LoanCore.partialRepay()` and confirm `totalOutstandingPrincipal` drop, `FeeCollector` interest cut (`10%`), and `LoanCore.claimable[lender]` accrual (`90%`).
   - Execute `LoanCore.extend()` with signed counterparty `ExtendOrder` and confirm updated maturity, rate, and nonce.
   - Execute full `LoanCore.repay()` and verify `PositionNFT` burn (`ERC721NonexistentToken`) and 100% collateral return to borrower.
   - Lender executes `LoanCore.claim(recipient)` and confirms `getClaimable(lender) == 0`.
4. **Step 3 — Controlled Live Liquidation Auction (`METAc` Loan):**
   - Let a dedicated short-term micro-loan cross `maturity + 24h GRACE_PERIOD_SECONDS` (calling `LoanCore.startDefaultAuction`) or reach liquidation threshold cleanly (`LoanCore.startLiquidation`).
   - Execute `LiquidationAuction.buy()` from an allowlisted internal liquidator wallet (`USDC` approved solely to `LiquidationAuction`).
   - Confirm exact waterfall settlement: `keeper` reward, `FeeCollector` liquidation/interest fee split, `LoanCore.claimable[lender]` credit, leftover collateral / USDC surplus refund directly to borrower, and `LoanCore.claim()`.

---

## 5. Emergency Abort & Rollback Controls

If any check or settlement step diverges during `WS4.7`:

- **Protocol-Wide Pause:** Guardian Safe immediately calls `LoanCore.setPaused(true)` (blocks new loan originations in `openLoan`, while preserving `repay`, `partialRepay`, `topUp`, `extend`, `claim`, order cancellations, and liquidations per `LoanCore.sol`).
- **Asset Freeze / Reduce-Only:** Guardian Safe calls `AssetRegistry.setAssetStatus(token, 1)` (`ReduceOnly`) or `AssetRegistry.setAssetStatus(token, 3)` (`Frozen`) immediately without timelock delay (`GuardianCanOnlyTighten` prevents Guardian from loosening back to `Active` = `0`).
- **Auction Emergency Cancel:** During verified `STALE_FEED` or `FROZEN_CORPORATE_ACTION`, call `LiquidationAuction.emergencyCancelAuction(auctionId)` (subject to 1-hour per-loan cooldown).
- **Revert to Pre-Audit Hold:** Keep `LoanCore.globalUsdcCap` and `perLoanCap` at smoke micro-caps and `EligibilityGate.permissionlessMode = false` until Tier-1 audit remediation (`Phase 4`) is complete.
