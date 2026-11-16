// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IAssetRegistry
 * @notice Maintains risk configs and operational status per collateral asset.
 */
interface IAssetRegistry {
    enum AssetStatus {
        Active,      // 0: Normal origination, repay, auction
        ReduceOnly,  // 1: No new loans, existing run to maturity, no rollovers
        WindDown,    // 2: Asset delisting, runs to maturity, no extensions
        Frozen       // 3: Corporate action, issuer pause, or oracle fault; repay/topup only
    }

    enum AssetTier {
        TierA, // Mega-cap (NVDAc, AAPLc, MSFTc, GOOGLc, AMZNc, METAc)
        TierB  // Volatile (TSLAc, MSTRc, SNDKc, SPCXc)
    }

    struct AssetConfig {
        address feed;                 // Chainlink price feed proxy
        uint8 feedDecimals;           // Usually 8
        uint8 tier;                   // TierA (0) or TierB (1)
        uint16 maxInitLtvBps;         // e.g. 6000 (60%) for Tier A
        uint16 marginCallLtvBps;      // e.g. 7000 (70%) for Tier A
        uint16 liqLtvBps;             // e.g. 7800 (78%) for Tier A
        uint16 badDebtLtvBps;         // e.g. 9000 (90%) for Tier A
        uint16 maxDiscountBps;        // e.g. 600 (6%) for Tier A
        uint16 closedMarketHaircutBps;// e.g. 500 (5%) for Tier A
        uint128 perLoanCap;           // Max USDC loan per single position
        uint128 assetCap;             // Max aggregate USDC outstanding for asset
        uint32 maxStaleOpenSecs;      // Max allowable heartbeat during market open
        uint8 status;                 // AssetStatus
        bool restricted;              // Requires eligibility check for liquidators
    }

    event AssetConfigSet(address indexed token, AssetConfig config);
    event AssetStatusSet(address indexed token, AssetStatus status);

    function getAssetConfig(address token) external view returns (AssetConfig memory);
    function getAssetStatus(address token) external view returns (AssetStatus);
    function isAssetSupported(address token) external view returns (bool);
    function setOracleRouter(address router) external;
    function oracleRouter() external view returns (address);
    function guardian() external view returns (address);
}
