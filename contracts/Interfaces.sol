// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice AggregatorV3-style price feed (BNB/USD on BSC, 8 decimals).
interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals() external view returns (uint8);
}

/// @notice .ai Agent ID registry (ERC-721): gate = balanceOf > 0 plus a
/// permanent handle <-> wallet binding (handleOf).
interface IAgentIdRegistry {
    function balanceOf(address owner) external view returns (uint256);
    /// Handle of the Agent ID held by `owner` (follows the token on transfer).
    function handleOf(address owner) external view returns (string memory);
}

/// @notice PancakeSwap V2 factory (subset used by EggSale).
interface IPancakeFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

/// @notice PancakeSwap V2 pair (subset used by EggSale).
interface IPancakePair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function totalSupply() external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function mint(address to) external returns (uint256 liquidity);
    function skim(address to) external;
    function sync() external;
}

/// @notice WBNB / WETH9 subset.
interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice MAO -> BNB conversion helper (MaoConverter): pulls the
/// caller's MAO, swaps it to BNB and forwards the proceeds.
interface IConverter {
    function swapMaoToBnb(uint256 amountIn, uint256 minOut) external returns (uint256 bnbOut);
}

/// @notice PancakeSwap V2 router (subset: buyback swaps, the Gen 1+
/// MAO -> BNB conversion swap, and LP adds).
interface IPancakeRouter {
    function WETH() external view returns (address);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}
