// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {CollateralEscrow} from "../src/CollateralEscrow.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {OracleRouter} from "../src/OracleRouter.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {EligibilityGate} from "../src/EligibilityGate.sol";
import {LiquidationAuction} from "../src/LiquidationAuction.sol";
import {LoanCore} from "../src/LoanCore.sol";
import {OrderSettlement} from "../src/OrderSettlement.sol";

/**
 * @title DeployNostok
 * @notice Automated deployment script for NOSTOK core contracts on Base.
 */
contract DeployNostok is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address owner = vm.envOr("OWNER_ADDRESS", msg.sender);
        address guardian = vm.envOr("GUARDIAN_ADDRESS", msg.sender);
        address treasury = vm.envOr("TREASURY_ADDRESS", msg.sender);
        address reserve = vm.envOr("RESERVE_ADDRESS", msg.sender);
        address usdc = vm.envOr("USDC_ADDRESS", address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)); // Base Native USDC
        address sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0xBCF85224fc0756B9Fa45aA7892530B47e10b6433)); // Base Sequencer

        if (deployerPrivateKey != 0) {
            vm.startBroadcast(deployerPrivateKey);
        } else {
            vm.startBroadcast();
        }

        console.log("--- Deploying NOSTOK Protocol on Base ---");

        // 1. EligibilityGate
        EligibilityGate gate = new EligibilityGate(owner, address(0), true);
        console.log("EligibilityGate deployed at:", address(gate));

        // 2. CollateralEscrow (IMMUTABLE)
        CollateralEscrow escrow = new CollateralEscrow(owner);
        console.log("CollateralEscrow deployed at:", address(escrow));

        // 3. PositionNFT (IMMUTABLE)
        PositionNFT nft = new PositionNFT(owner, address(gate));
        console.log("PositionNFT deployed at:", address(nft));

        // 4. AssetRegistry (UUPS)
        AssetRegistry regImpl = new AssetRegistry();
        bytes memory regData = abi.encodeCall(AssetRegistry.initialize, (owner, guardian));
        AssetRegistry registry = AssetRegistry(address(new ERC1967Proxy(address(regImpl), regData)));
        console.log("AssetRegistry proxy at:", address(registry));

        // 5. OracleRouter (UUPS)
        OracleRouter routerImpl = new OracleRouter();
        bytes memory routerData = abi.encodeCall(
            OracleRouter.initialize,
            (owner, address(registry), sequencerFeed)
        );
        OracleRouter router = OracleRouter(address(new ERC1967Proxy(address(routerImpl), routerData)));
        console.log("OracleRouter proxy at:", address(router));

        // 6. FeeCollector (UUPS)
        FeeCollector feeImpl = new FeeCollector();
        bytes memory feeData = abi.encodeCall(FeeCollector.initialize, (owner, treasury, reserve));
        FeeCollector feeCollector = FeeCollector(address(new ERC1967Proxy(address(feeImpl), feeData)));
        console.log("FeeCollector proxy at:", address(feeCollector));

        // 7. LoanCore (UUPS)
        LoanCore coreImpl = new LoanCore();
        LoanCore core = LoanCore(address(new ERC1967Proxy(address(coreImpl), "")));
        console.log("LoanCore proxy at:", address(core));

        // 8. LiquidationAuction (UUPS)
        LiquidationAuction auctionImpl = new LiquidationAuction();
        LiquidationAuction auction = LiquidationAuction(address(new ERC1967Proxy(address(auctionImpl), "")));
        console.log("LiquidationAuction proxy at:", address(auction));

        // Initialize LoanCore and LiquidationAuction
        core.initialize(
            owner,
            guardian,
            address(escrow),
            address(nft),
            address(registry),
            address(router),
            address(feeCollector),
            address(auction),
            usdc
        );

        auction.initialize(
            owner,
            address(escrow),
            address(core),
            address(feeCollector),
            usdc
        );

        // 9. OrderSettlement (UUPS)
        OrderSettlement settlementImpl = new OrderSettlement();
        bytes memory settData = abi.encodeCall(
            OrderSettlement.initialize,
            (owner, address(core), address(gate))
        );
        OrderSettlement settlement = OrderSettlement(address(new ERC1967Proxy(address(settlementImpl), settData)));
        console.log("OrderSettlement proxy at:", address(settlement));

        // Wire contract authorizations
        core.setOrderSettlement(address(settlement));
        escrow.setAuthorizedCore(address(core), true);
        escrow.setAuthorizedCore(address(auction), true);
        nft.setAuthorizedCore(address(core), true);

        console.log("--- NOSTOK Protocol Deployment Complete ---");

        vm.stopBroadcast();
    }
}
