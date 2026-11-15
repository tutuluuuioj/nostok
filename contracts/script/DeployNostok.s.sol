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
import {NostokTimelock} from "../src/NostokTimelock.sol";

/**
 * @title DeployNostok
 * @notice Automated deployment script for NOSTOK core contracts on Base.
 */
contract DeployNostok is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = deployerPrivateKey != 0 ? vm.addr(deployerPrivateKey) : msg.sender;
        address multisigOwner = vm.envOr("OWNER_ADDRESS", deployer);
        address guardian = vm.envOr("GUARDIAN_ADDRESS", deployer);
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address reserve = vm.envOr("RESERVE_ADDRESS", deployer);

        uint256 chainId = block.chainid;
        address usdc;
        address sequencerFeed;

        if (chainId == 8453) {
            // Base Mainnet
            usdc = vm.envOr("USDC_ADDRESS", address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913));
            sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0xBCF85224fc0756B9Fa45aA7892530B47e10b6433));
        } else if (chainId == 84532) {
            // Base Sepolia - sequencer feed has no contract code; fallback to address(0)
            usdc = vm.envOr("USDC_ADDRESS", address(0x036CbD53842c5426634e7929541eC2318f3dCF7e));
            sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0));
        } else {
            // Local Anvil / Foundry testing
            usdc = vm.envOr("USDC_ADDRESS", address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913));
            sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0));
        }

        if (deployerPrivateKey != 0) {
            vm.startBroadcast(deployerPrivateKey);
        } else {
            vm.startBroadcast();
        }

        console.log("--- Deploying NOSTOK Protocol ---");
        console.log("Chain ID:", chainId);
        console.log("Deployer:", deployer);
        console.log("Target Multisig Owner:", multisigOwner);

        // 1. EligibilityGate (starts in permissioned mode: permissionless = false)
        EligibilityGate gate = new EligibilityGate(deployer, address(0), false);
        console.log("EligibilityGate deployed at:", address(gate));

        // 2. CollateralEscrow (IMMUTABLE) - deployer temporary owner for initial authorization wiring
        CollateralEscrow escrow = new CollateralEscrow(deployer);
        console.log("CollateralEscrow deployed at:", address(escrow));

        // 3. PositionNFT (IMMUTABLE)
        PositionNFT nft = new PositionNFT(deployer, address(gate));
        console.log("PositionNFT deployed at:", address(nft));

        // 4. AssetRegistry (UUPS) - atomic initialization in proxy constructor
        AssetRegistry regImpl = new AssetRegistry();
        bytes memory regData = abi.encodeCall(AssetRegistry.initialize, (deployer, guardian));
        AssetRegistry registry = AssetRegistry(address(new ERC1967Proxy(address(regImpl), regData)));
        console.log("AssetRegistry proxy at:", address(registry));

        // 5. OracleRouter (UUPS) - atomic initialization in proxy constructor
        OracleRouter routerImpl = new OracleRouter();
        bytes memory routerData = abi.encodeCall(
            OracleRouter.initialize,
            (deployer, address(registry), sequencerFeed)
        );
        OracleRouter router = OracleRouter(address(new ERC1967Proxy(address(routerImpl), routerData)));
        console.log("OracleRouter proxy at:", address(router));

        // 6. FeeCollector (UUPS) - atomic initialization in proxy constructor
        FeeCollector feeImpl = new FeeCollector();
        bytes memory feeData = abi.encodeCall(FeeCollector.initialize, (deployer, treasury, reserve));
        FeeCollector feeCollector = FeeCollector(address(new ERC1967Proxy(address(feeImpl), feeData)));
        console.log("FeeCollector proxy at:", address(feeCollector));

        // 7. LoanCore (UUPS) - atomic initialization in proxy constructor
        LoanCore coreImpl = new LoanCore();
        bytes memory coreData = abi.encodeCall(
            LoanCore.initialize,
            (
                deployer,
                guardian,
                address(escrow),
                address(nft),
                address(registry),
                address(router),
                address(feeCollector),
                address(0), // set auction right after
                usdc
            )
        );
        LoanCore core = LoanCore(address(new ERC1967Proxy(address(coreImpl), coreData)));
        console.log("LoanCore proxy at:", address(core));

        // 8. LiquidationAuction (UUPS) - atomic initialization in proxy constructor
        LiquidationAuction auctionImpl = new LiquidationAuction();
        bytes memory auctionData = abi.encodeCall(
            LiquidationAuction.initialize,
            (
                deployer,
                address(escrow),
                address(core),
                address(feeCollector),
                usdc
            )
        );
        LiquidationAuction auction = LiquidationAuction(address(new ERC1967Proxy(address(auctionImpl), auctionData)));
        console.log("LiquidationAuction proxy at:", address(auction));

        // Link core and auction
        core.setLiquidationAuction(address(auction));

        // 9. OrderSettlement (UUPS) - atomic initialization in proxy constructor
        OrderSettlement settlementImpl = new OrderSettlement();
        bytes memory settData = abi.encodeCall(
            OrderSettlement.initialize,
            (deployer, address(core), address(gate))
        );
        OrderSettlement settlement = OrderSettlement(address(new ERC1967Proxy(address(settlementImpl), settData)));
        console.log("OrderSettlement proxy at:", address(settlement));

        // Wire contract authorizations using deployer
        core.setOrderSettlement(address(settlement));
        escrow.setAuthorizedCore(address(core), true);
        escrow.setAuthorizedCore(address(auction), true);
        nft.setAuthorizedCore(address(core), true);

        // 10. Deploy 48h NostokTimelock
        address[] memory proposers = new address[](1);
        proposers[0] = multisigOwner;
        address[] memory executors = new address[](1);
        executors[0] = multisigOwner;
        NostokTimelock timelock = new NostokTimelock(proposers, executors, multisigOwner);
        console.log("NostokTimelock deployed at:", address(timelock));

        // Transfer ownership of contracts to TimelockController
        escrow.transferOwnership(address(timelock));
        nft.transferOwnership(address(timelock));
        registry.transferOwnership(address(timelock));
        router.transferOwnership(address(timelock));
        feeCollector.transferOwnership(address(timelock));
        core.transferOwnership(address(timelock));
        auction.transferOwnership(address(timelock));
        settlement.transferOwnership(address(timelock));
        gate.transferOwnership(address(timelock));

        console.log("Contract ownership successfully transferred to TimelockController:", address(timelock));
        console.log("--- NOSTOK Protocol Deployment Complete ---");

        vm.stopBroadcast();
    }
}
