// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MaoToken (MAO) — the Egg project's token.
/// @notice Single hard cap on CIRCULATING supply: totalSupply minus the
/// DEAD balance never exceeds 3,000,000,000 MAO, including the pool
/// seed. The only minter is the EggSale contract (`system`, wired once
/// by the deployer and never changeable). Burns are ordinary transfers
/// to the DEAD address (whose balance is the public burned counter), so
/// every burn frees production headroom under the cap (SPEC section 6).
///
/// Trading tax vs the official PancakeSwap V2 pair: 2% on buys and on
/// sells. Both sides split in-kind 1% to DEAD (burned) + 1% to the
/// project wallet. The splits are named constants below, so flipping
/// one is a one-line change.
/// Wallet-to-wallet transfers are untaxed.
///
/// Anti-snipe launch window (user decision 2026-11-03): sniping is a
/// same-block game, so the window is block-based, not time-based —
/// for the first 5 blocks starting with the pool-open block, pair
/// buys are restricted: each wallet may receive at most 200,000 MAO
/// from the pair in total during the window, and the buy tax is 10%,
/// all of it burned (replacing the normal buy split for window buys
/// only). Sell tax is unchanged at all times. From block
/// poolOpenBlock + 5 onward the normal rules apply. The token learns
/// the open block from EggSale._openPool via the one-time
/// `notifyPoolOpened` latch.
///
/// Two patterns are ported from the BNBCAT v5 token (proven in production):
///  - the official pair address is precomputed via CREATE2 at construction
///    and transfers INTO the predicted pair revert until EggSale opens the
///    pool and calls `setOfficialPair`, so nobody can pre-seed or skim
///    the pair before the official open;
///  - the `system` contract (EggSale) is exempt from trade tax: it is not
///    a trader. Without this, buyback proceeds arriving at EggSale would
///    be buy-taxed and could not be burned in full, and LP legs would be
///    sell-taxed mid-pairing (BNBCAT v5 fix F1). The `converter`
///    (MaoConverter, the Gen 1+ MAO -> BNB swap helper) carries the
///    same exemption: its leg into the pair is EggSale's own leg by
///    proxy, and taxing it would break the router's invariant check.
contract MaoToken is ERC20 {
    uint256 public constant HARD_CAP = 3_000_000_000 ether;
    uint256 public constant TAX_BPS = 200; // 2% total on buys and on sells
    // Per-side split of the trade tax, in bps of the traded amount.
    // Buys and sells alike: half burned, half to the project wallet
    // (buy side changed by user decision 2026-11-03). BUY_* sum and
    // SELL_* sum must each stay = TAX_BPS.
    uint256 public constant BUY_BURN_BPS = 100;
    uint256 public constant BUY_PROJECT_BPS = 100;
    uint256 public constant SELL_BURN_BPS = 100;
    uint256 public constant SELL_PROJECT_BPS = 100;
    // Anti-snipe launch window (SPEC sections 3/7): the first
    // SNIPE_WINDOW_BLOCKS blocks starting with the pool-open block,
    // pair buys pay SNIPE_BUY_BURN_BPS (all burned) and each wallet
    // may receive at most SNIPE_WALLET_CAP MAO from the pair in total.
    uint256 public constant SNIPE_WINDOW_BLOCKS = 5;
    uint256 public constant SNIPE_WALLET_CAP = 200_000 ether;
    uint256 public constant SNIPE_BUY_BURN_BPS = 1_000; // 10%, window buys only
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @dev PancakeSwap V2 pair init code hash on BSC mainnet — verified
    /// against the live factory at build time (CREATE2 of the known
    /// WBNB/USDT pair reproduces the factory's getPair result; see
    /// BUILD-NOTES). Passed into the constructor so tests can inject a
    /// mock factory hash.
    bytes32 public immutable pairInitCodeHash;

    address public immutable deployer;
    address public immutable projectWallet;
    address public immutable wbnb;
    address public immutable pancakeFactory;
    /// @notice CREATE2-predicted MAO/WBNB pair; immutable after construction.
    address public immutable predictedPair;

    address public system; // EggSale
    /// @notice MaoConverter: EggSale's MAO -> BNB swap helper, wired
    /// once by the deployer; trade-tax exempt like `system`.
    address public converter;
    address public officialPair;
    /// @notice Pool-open block number, latched once by EggSale at the
    /// open (0 = pool not open). Starts the anti-snipe window.
    uint256 public poolOpenBlock;
    /// @notice Gross MAO each wallet has received from the pair during
    /// the anti-snipe window (the window cap accounting).
    mapping(address => uint256) public boughtInWindow;

    event SystemSet(address system);
    event ConverterSet(address converter);
    event OfficialPairSet(address pair);
    event PoolOpenNotified(address pair, uint256 openBlock);
    event TradeTaxed(address indexed trader, bool isBuy, uint256 burnPart, uint256 projectPart);

    modifier onlyDeployer() {
        require(msg.sender == deployer, "not deployer");
        _;
    }

    modifier onlySystem() {
        require(msg.sender == system, "not system");
        _;
    }

    constructor(address projectWallet_, address pancakeFactory_, address wbnb_, bytes32 pairInitCodeHash_)
        ERC20(unicode"毛", "MAO")
    {
        require(projectWallet_ != address(0) && pancakeFactory_ != address(0) && wbnb_ != address(0), "zero addr");
        require(pairInitCodeHash_ != bytes32(0), "zero hash");
        deployer = msg.sender;
        projectWallet = projectWallet_;
        pancakeFactory = pancakeFactory_;
        wbnb = wbnb_;
        pairInitCodeHash = pairInitCodeHash_;
        predictedPair = _pairFor(address(this), wbnb_, pancakeFactory_, pairInitCodeHash_);
    }

    function _pairFor(address tokenA, address tokenB, address factory_, bytes32 initHash)
        internal
        pure
        returns (address pair)
    {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pair = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(hex"ff", factory_, keccak256(abi.encodePacked(token0, token1)), initHash)
                    )
                )
            )
        );
    }

    // ---- one-time setup wiring (pre-launch only, fires once) ----

    function setSystem(address system_) external onlyDeployer {
        require(system == address(0) && system_ != address(0), "system set");
        system = system_;
        emit SystemSet(system_);
    }

    function setConverter(address converter_) external onlyDeployer {
        require(converter == address(0) && converter_ != address(0), "converter set");
        converter = converter_;
        emit ConverterSet(converter_);
    }

    function setOfficialPair(address pair) external onlySystem {
        require(officialPair == address(0) && pair != address(0), "pair set");
        require(pair == predictedPair, "not predicted pair");
        officialPair = pair;
        emit OfficialPairSet(pair);
    }

    /// @notice One-time latch called by EggSale inside the pool-open
    /// transaction, right after `setOfficialPair`: records the open
    /// block that starts the anti-snipe window. A second call
    /// reverts — the window start can never be moved.
    function notifyPoolOpened(address pair) external onlySystem {
        require(poolOpenBlock == 0, "open already notified");
        require(pair != address(0) && pair == officialPair, "not official pair");
        poolOpenBlock = block.number;
        emit PoolOpenNotified(pair, block.number);
    }

    /// @notice True while the anti-snipe launch window is running:
    /// the pool-open block and the 4 blocks after it.
    function inSnipeWindow() public view returns (bool) {
        return poolOpenBlock != 0 && block.number < poolOpenBlock + SNIPE_WINDOW_BLOCKS;
    }

    // ---- capped minting (pool seed + production claims only) ----

    /// @notice Circulating supply: tokens actually in existence outside
    /// the burn address. Burns are ordinary transfers to DEAD (SPEC
    /// section 1: the public burned counter is DEAD's balance), so the
    /// 3B hard cap binds the CIRCULATING supply (SPEC section 6:
    /// "circulating never exceeds 3B; every burn frees production
    /// headroom") — headroom = cap − circulating, and production
    /// resumes automatically as MAO is burned.
    function circulating() public view returns (uint256) {
        return totalSupply() - balanceOf(DEAD);
    }

    /// @notice Remaining mintable headroom under the 3B hard cap.
    function headroom() public view returns (uint256) {
        return HARD_CAP - circulating();
    }

    /// @notice Mint new MAO. Only EggSale (pool seed at open, production
    /// claims afterwards). Reverts rather than ever letting the
    /// circulating supply exceed the cap.
    function mint(address to, uint256 amount) external onlySystem {
        require(circulating() + amount <= HARD_CAP, "cap exceeded");
        _mint(to, amount);
    }

    // ---- transfer logic: pre-open pair gate + trade taxes ----
    // Until officialPair is set, the only address allowed to send MAO
    // *into* predictedPair is `system` (EggSale during pool open).
    // transferFrom is covered because both paths hit _update.

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && officialPair == address(0)) {
            if (to == predictedPair) {
                require(from == system, "pair gated");
            }
        }
        // System exemption (ported BNBCAT v5 F1): EggSale moving MAO —
        // buyback proceeds on their way to DEAD, LP legs, Gen 1+ payment
        // legs — is never trade-taxed; the same holds for the converter
        // moving EggSale's conversion leg into the pair. The pair gate
        // above is evaluated FIRST, so the exemption never weakens the
        // pre-open gate.
        if (from == system || to == system || from == converter || to == converter) {
            super._update(from, to, value);
            return;
        }
        address pair = officialPair;
        bool isSell = pair != address(0) && to == pair && from != pair && from != address(0) && to != address(0);
        bool isBuy = pair != address(0) && from == pair && to != pair && from != address(0) && to != address(0);
        if ((!isSell && !isBuy) || value == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 burnBps = isBuy ? BUY_BURN_BPS : SELL_BURN_BPS;
        uint256 projectBps = isBuy ? BUY_PROJECT_BPS : SELL_PROJECT_BPS;
        if (isBuy && inSnipeWindow() && to != DEAD && to != projectWallet) {
            // Anti-snipe window (window buys only): 10% tax, all
            // burned, and a per-wallet cumulative cap on MAO received
            // from the pair. System transfers never reach this branch
            // (exempted above), so EggSale's buyback and LP legs run
            // uncapped and untaxed inside the window; DEAD and the
            // project wallet are exempt from the window rules too.
            uint256 bought = boughtInWindow[to] + value;
            require(bought <= SNIPE_WALLET_CAP, "snipe cap");
            boughtInWindow[to] = bought;
            burnBps = SNIPE_BUY_BURN_BPS;
            projectBps = 0;
        }
        uint256 burnLeg = (value * burnBps) / 10_000;
        uint256 projectLeg = (value * projectBps) / 10_000;
        super._update(from, to, value - burnLeg - projectLeg);
        if (burnLeg > 0) {
            super._update(from, DEAD, burnLeg); // burned (ordinary transfer to DEAD)
        }
        if (projectLeg > 0) {
            super._update(from, projectWallet, projectLeg);
        }
        emit TradeTaxed(isBuy ? to : from, isBuy, burnLeg, projectLeg);
    }
}
