// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test double for the .ai Agent ID registry.
contract MockAgentIdRegistry {
    mapping(address => bool) public has;
    // Optional explicit handle; default handle = "id-" + holder address.
    mapping(address => string) internal _handle;
    // Holders whose handle reads back EMPTY (the real SPACE ID registry
    // can return an empty handle for a holder; the sale gate rejects it).
    mapping(address => bool) public emptyHandle;

    function give(address who) external {
        has[who] = true;
    }

    /// Give `who` an Agent ID with an explicitly empty handle.
    function giveEmptyHandle(address who) external {
        has[who] = true;
        emptyHandle[who] = true;
    }

    function giveMany(address[] calldata who) external {
        for (uint256 i = 0; i < who.length; i++) has[who[i]] = true;
    }

    /// Give `who` an Agent ID with an explicit handle.
    function giveHandle(address who, string calldata h) external {
        has[who] = true;
        _handle[who] = h;
    }

    /// Move `from`'s Agent ID (and its handle) to `to`, like an ERC-721
    /// transfer of the ID.
    function moveId(address from, address to) external {
        require(has[from], "no id");
        string memory h = handleOf(from);
        has[from] = false;
        _handle[from] = "";
        has[to] = true;
        _handle[to] = h;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return has[owner] ? 1 : 0;
    }

    function handleOf(address owner) public view returns (string memory) {
        if (!has[owner]) return "";
        if (emptyHandle[owner]) return "";
        if (bytes(_handle[owner]).length > 0) return _handle[owner];
        return string(abi.encodePacked("id-", owner));
    }
}

/// @notice Test double for the BNB/USD price feed.
contract MockPriceFeed {
    int256 public answer = 700 * 1e8; // $700
    uint256 public updatedAtOverride; // 0 = use block.timestamp

    function setAnswer(int256 a) external {
        answer = a;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAtOverride = t;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 u = updatedAtOverride == 0 ? block.timestamp : updatedAtOverride;
        return (1, answer, u, u, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

/// @notice WBNB test double.
contract MockWBNB is ERC20 {
    constructor() ERC20("Wrapped BNB", "WBNB") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

/// @notice Pancake V2 pair test double (constant product, no swap fee).
contract MockPair {
    address public token0;
    address public token1;
    uint112 internal _r0;
    uint112 internal _r1;

    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    constructor(address t0, address t1) {
        require(t0 < t1, "order");
        token0 = t0;
        token1 = t1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (_r0, _r1, 0);
    }

    function sync() external {
        _r0 = uint112(IERC20(token0).balanceOf(address(this)));
        _r1 = uint112(IERC20(token1).balanceOf(address(this)));
    }

    /// @notice UniV2 skim: excess balances over reserves go to `to`.
    function skim(address to) external {
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        if (b0 > _r0) require(IERC20(token0).transfer(to, b0 - _r0), "skim0");
        if (b1 > _r1) require(IERC20(token1).transfer(to, b1 - _r1), "skim1");
    }

    function mint(address to) external returns (uint256 liquidity) {
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        if (totalSupply == 0) {
            // UniV2: MINIMUM_LIQUIDITY (1000) is locked to address(0) on
            // the first mint and counts toward totalSupply forever.
            liquidity = _sqrt(b0 * b1) - 1000;
            balanceOf[address(0)] += 1000;
            totalSupply += 1000;
        } else {
            uint256 l0 = ((b0 - _r0) * totalSupply) / _r0;
            uint256 l1 = ((b1 - _r1) * totalSupply) / _r1;
            liquidity = l0 < l1 ? l0 : l1;
        }
        require(liquidity > 0, "no liquidity");
        balanceOf[to] += liquidity;
        totalSupply += liquidity;
        _r0 = uint112(b0);
        _r1 = uint112(b1);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to) external {
        if (amount0Out > 0) require(IERC20(token0).transfer(to, amount0Out), "t0 out");
        if (amount1Out > 0) require(IERC20(token1).transfer(to, amount1Out), "t1 out");
        _r0 = uint112(IERC20(token0).balanceOf(address(this)));
        _r1 = uint112(IERC20(token1).balanceOf(address(this)));
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        y = x;
        if (x > 3) {
            uint256 z = x / 2 + 1;
            while (z < y) {
                y = z;
                z = (x / z + z) / 2;
            }
        } else if (x != 0) {
            y = 1;
        }
    }
}

/// @notice CREATE2 mock factory (test-only): deploys MockPair with
/// salt = keccak256(abi.encodePacked(token0, token1)) — the Pancake V2
/// scheme — so a MaoToken constructed with
/// pairInitCodeHash = keccak256(MockPair creation code ++ abi.encode(t0, t1))
/// predicts exactly the address this factory creates.
contract MockFactoryC2 {
    address public immutable wbnb;
    mapping(address => mapping(address => address)) public getPair;

    constructor(address wbnb_) {
        wbnb = wbnb_;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(getPair[tokenA][tokenB] == address(0), "pair exists");
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        bytes32 salt = keccak256(abi.encodePacked(t0, t1));
        pair = address(new MockPair{salt: salt}(t0, t1));
        getPair[tokenA][tokenB] = pair;
        getPair[tokenB][tokenA] = pair;
    }
}

/// @notice Calls EggSale.pokePrice twice inside ONE transaction, so a
/// test can pin the one-observation-per-block guard within a single
/// block (two separate txs would land in two blocks under automine).
interface IPokePrice {
    function pokePrice() external;
}

contract PokeTwiceHarness {
    function twice(address sale) external {
        IPokePrice(sale).pokePrice();
        IPokePrice(sale).pokePrice();
    }
}

/// @notice Pancake V2 router test double.
contract MockRouter {
    MockFactoryC2 public immutable factory;
    MockWBNB public immutable wbnb;

    constructor(address factory_, address wbnb_) {
        factory = MockFactoryC2(factory_);
        wbnb = MockWBNB(payable(wbnb_));
    }

    function WETH() external view returns (address) {
        return address(wbnb);
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address to,
        uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        address pair = factory.getPair(token, address(wbnb));
        require(pair != address(0), "no pair");
        require(IERC20(token).transferFrom(msg.sender, pair, amountTokenDesired), "token in");
        wbnb.deposit{value: msg.value}();
        require(wbnb.transfer(pair, msg.value), "wbnb in");
        liquidity = MockPair(pair).mint(to);
        return (amountTokenDesired, msg.value, liquidity);
    }

    /// @notice Token -> token swap (same constant-product math, no fee,
    /// as swapExactETHForTokens). Used by EggSale's Gen 1+ MAO -> WBNB
    /// conversion leg.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(path.length == 2, "bad path");
        address pair = factory.getPair(path[0], path[1]);
        require(pair != address(0), "no pair");
        (uint112 r0, uint112 r1,) = MockPair(pair).getReserves();
        bool inIs0 = MockPair(pair).token0() == path[0];
        (uint256 resIn, uint256 resOut) = inIs0 ? (r0, r1) : (r1, r0);
        uint256 out = (resOut * amountIn) / (resIn + amountIn);
        require(out >= amountOutMin && out < resOut, "bad out");
        require(IERC20(path[0]).transferFrom(msg.sender, pair, amountIn), "token in");
        if (inIs0) MockPair(pair).swap(0, out, to);
        else MockPair(pair).swap(out, 0, to);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external payable returns (uint256[] memory amounts) {
        require(path.length == 2 && path[0] == address(wbnb), "bad path");
        address pair = factory.getPair(path[1], address(wbnb));
        require(pair != address(0), "no pair");
        (uint112 r0, uint112 r1,) = MockPair(pair).getReserves();
        bool wbnbIs0 = MockPair(pair).token0() == address(wbnb);
        (uint256 resIn, uint256 resOut) = wbnbIs0 ? (r0, r1) : (r1, r0);
        uint256 out = (resOut * msg.value) / (resIn + msg.value);
        require(out >= amountOutMin && out < resOut, "bad out");
        wbnb.deposit{value: msg.value}();
        require(wbnb.transfer(pair, msg.value), "wbnb in");
        if (wbnbIs0) MockPair(pair).swap(0, out, to);
        else MockPair(pair).swap(out, 0, to);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = out;
    }
}
