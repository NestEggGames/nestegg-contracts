// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPancakeRouter, IWETH} from "./Interfaces.sol";

/// @title MaoConverter — the Gen 1+ MAO -> BNB conversion leg.
/// @notice A tiny stateless helper, extracted from EggSale for the
/// EIP-170 size budget: EggSale approves it for the 10% conversion
/// leg of a Gen 1+ mint payment; it pulls that MAO from EggSale,
/// swaps it to WBNB through the Pancake router, unwraps to BNB and
/// forwards the proceeds to EggSale, all in one call. It holds no
/// balances between calls.
///
/// ACCESS CONTROL IS LOAD-BEARING HERE: MaoToken exempts the
/// converter address from trade tax exactly like EggSale itself
/// (see MaoToken.setConverter) — without that, the converter's leg
/// into the pair would be sell-taxed and the router's invariant
/// check would fail on the real pair. A tax-exempt swap entry point
/// open to the public would be a tax-free sell rail bypassing the
/// 2% sell tax, so `swapMaoToBnb` is SALE-ONLY: the deployer wires
/// the EggSale address once via `setSale`, and no other caller can
/// ever use the converter.
contract MaoConverter {
    IERC20 public immutable token;
    IPancakeRouter public immutable router;
    address public immutable wbnb;
    /// @notice The deployer (constructor caller); the only address
    /// that may perform the one-time `setSale` wiring.
    address public immutable deployer;
    /// @notice The wired EggSale contract — the only caller
    /// `swapMaoToBnb` accepts. Set once by the deployer, never
    /// changeable.
    address public sale;

    event SaleSet(address sale);

    constructor(address token_, address router_) {
        token = IERC20(token_);
        router = IPancakeRouter(router_);
        wbnb = IPancakeRouter(router_).WETH();
        deployer = msg.sender;
    }

    /// @notice One-time wiring: record the EggSale contract. Only
    /// the deployer, only once, never the zero address — after this
    /// call the converter's caller set is frozen forever.
    function setSale(address sale_) external {
        require(msg.sender == deployer, "not deployer");
        require(sale == address(0) && sale_ != address(0), "sale set");
        sale = sale_;
        emit SaleSet(sale_);
    }

    /// @notice Swap `amountIn` of EggSale's MAO to BNB and forward
    /// the proceeds to EggSale. SALE-ONLY (see the contract notice:
    /// the converter is trade-tax exempt, so a public entry would
    /// be a tax-free sell rail). Reverts on any failure (router
    /// slippage included) — EggSale calls this in a try/catch and
    /// burns the leg instead, so a failure here can never revert a
    /// user's mint.
    function swapMaoToBnb(uint256 amountIn, uint256 minOut) external returns (uint256 bnbOut) {
        require(msg.sender == sale, "only sale");
        uint256 ethBefore = address(this).balance;
        require(token.transferFrom(msg.sender, address(this), amountIn), "pull");
        require(token.approve(address(router), amountIn), "approve");
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = wbnb;
        router.swapExactTokensForTokens(amountIn, minOut, path, address(this), block.timestamp);
        uint256 w = IWETH(wbnb).balanceOf(address(this));
        if (w > 0) IWETH(wbnb).withdraw(w);
        bnbOut = address(this).balance - ethBefore;
        (bool ok,) = msg.sender.call{value: bnbOut}("");
        require(ok, "send");
    }

    /// @notice Accepts the WBNB unwrap payout. Delta accounting in
    /// swapMaoToBnb means stray dust sent here is never forwarded —
    /// it simply stays here, inert.
    receive() external payable {}
}
