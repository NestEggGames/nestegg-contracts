// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MaoToken} from "./MaoToken.sol";
import {EggNFT} from "./EggNFT.sol";
import {
    IAggregatorV3,
    IAgentIdRegistry,
    IConverter,
    IPancakeFactory,
    IPancakePair,
    IPancakeRouter,
    IWETH
} from "./Interfaces.sol";

/// @title EggSale — sale, pool, hatch settlement and production claims.
/// @notice Ownerless by design: no key can move funds, change parameters
/// or stop the sale after deployment. Ported patterns from BNBCAT v5
/// Genesis (Agent ID gate + handle welding, Chainlink BNB/USD pricing
/// with same-transaction overpay refund, pool open inside the trigger
/// mint, buyback with 1h-TWAP guard + pokePrice + per-block cap).
///
/// MAO-specific design:
///  - Minting issues the egg NFT INSTANTLY in the mint transaction. No
///    randomness, no pending state at mint (SPEC section 2 guarantee).
///    The only randomness in the system is hatching and the claim-death
///    roll — both ride the same future-blockhash seed + capture path.
///  - Idle-decay ratchet pricing (SPEC section 2): the effective price
///    tier is stored state; 5 idle minutes step it down one tier
///    (floor = tier 1), a mint never restores it, and entering the next
///    sales tier resets it to that tier's full price.
///  - Generations are capped at 10 total (Gen 0..Gen 9,
///    MAX_GENERATION): 10,000 eggs per generation, 100,000 eggs ever;
///    when Gen 9 sells out the sale is finished permanently. Gen 0 is
///    paid in BNB on the USD ladder; Gen 1+ is priced on a fixed MAO
///    ladder (GEN_MAO_LADDER) and paid 100% in MAO — 90% burned to
///    DEAD, 10% swapped to BNB inside the mint transaction into the
///    buyback/LP pots; no BNB payment leg from the buyer; the
///    idle-decay ratchet applies to both ladders (SPEC section 6).
///  - Hatch settlement uses SEED CAPTURE (SPEC section 1/4): once a
///    pending hatch's seed block has passed, any contract transaction
///    may store that block's hash in contract storage; after capture,
///    settlement is unbounded in time (no 256-block cliff). There is NO
///    settle bounty (cut by user decision 2026-11-03 — see BUILD-NOTES):
///    settlement reliability rests on seed capture, piggyback
///    settlement in ordinary user calls, the owner's own settle call,
///    and a single project backstop keeper sweeping the pending queue
///    (enumerable on-chain via `pendingReqs`).
contract EggSale is ReentrancyGuard {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant GEN_SIZE = 10_000;
    uint256 public constant MAX_GENERATION = 9; // generations are 0..9: 10 gens x 10,000 = 100,000 eggs, then finished
    uint256 public constant GEN_MAO_BURN_BPS = 9_000; // 90% of Gen 1+ MAO payments burned to DEAD
    uint256 public constant GEN_MAO_SWAP_BPS = 1_000; // 10% swapped MAO -> BNB inside the mint, into the buyback/LP pots
    uint256 public constant POOL_TRIGGER = 5_000; // pool opens inside Gen 0 egg #5,000's mint
    // The per-wallet per-generation mint cap is the ONLY mint-count
    // limit (user decision 2026-11-03): there is no separate
    // per-transaction cap — one mint may take any count from 1 up to
    // the wallet's remaining cap for the generation.
    uint256 public constant MAX_PER_GEN_GEN0 = 10; // mint slots per wallet in Gen 0
    uint256 public constant MAX_PER_GEN_LATER = 20; // mint slots per wallet in Gen 1+
    uint256 public constant ANCHOR_USD = 0.0015 ether; // pool-open MAO anchor price
    uint256 public constant SEED_CAP = 10_000_000 ether; // max MAO seeded at open
    uint256 public constant ANCHOR_TOL_BPS = 50; // 0.5% post-open reserve ratio tolerance
    uint256 public constant IDLE_WINDOW = 5 minutes;
    // Hatch seed: the hash of the block HATCH_SEED_DELAY blocks after the
    // request block (same delay as BNBCAT v5 births). Unknowable at
    // request time; publicly computable the moment the seed block is
    // mined — but never steerable: nobody can choose the seed, block its
    // capture, or block settlement.
    uint256 public constant HATCH_SEED_DELAY = 5;
    uint256 public constant CLAIM_SEED_DELAY = 5; // claim-death dice use the same seed path
    uint256 public constant DEATH_PCT = 20; // flat claim-death chance, percent (phoenix exempt)
    // Plunder (user decision 2026-11-03):
    // at hatch settlement an independent PLUNDER_PCT roll decides
    // whether the hatched animal is plundered: the egg becomes an
    // EMPTY SHELL (species SP_SHELL) and the animal is issued as a
    // NEW NFT to a plunderer drawn from the wallets currently
    // holding a hatched animal (EggNFT's registry + settle logic;
    // no eligible plunderer = no plunder, hatcher keeps the animal).
    // The shell persists as a normal NFT: 0 production, not burned,
    // no graveyard entry, never claims, never counts toward the
    // collection set — and it holds NO mint slot: the egg's slot is
    // released back to its minter at plunder settlement, and the
    // plunder-born animal is born slotless.
    uint256 public constant PLUNDER_PCT = 10; // percent of hatches plundered when an eligible plunderer exists
    uint256 public constant SEED_WINDOW = 256; // blockhash() availability window
    uint256 public constant REHATCH_COOLDOWN = 24 hours;
    uint256 public constant PIGGYBACK_MAX = 4; // queue items settled per user call
    // Species ids (mirror EggNFT): 0 egg, 1 chicken, 2 duck, 3 goose,
    // 4 bird, 5 phoenix, 6 empty shell.
    uint8 internal constant SP_EGG = 0;
    uint8 internal constant SP_CHICKEN = 1;
    uint8 internal constant SP_DUCK = 2;
    uint8 internal constant SP_GOOSE = 3;
    uint8 internal constant SP_BIRD = 4;
    uint8 internal constant SP_PHOENIX = 5;
    uint8 internal constant SP_SHELL = 6;

    MaoToken public immutable token;
    EggNFT public immutable eggs;
    IAgentIdRegistry internal immutable registry;
    IAggregatorV3 internal immutable feed;
    IPancakeRouter public immutable router;
    IPancakeFactory internal immutable factory;
    address internal immutable wbnb;
    address public immutable projectWallet;
    uint256 public immutable startTime; // mint opens at this timestamp (0 = open immediately)
    /// @notice Failed-launch refund deadline (user decision 2026-11-03):
    /// 7 days after the mint opens (startTime, or the deploy timestamp
    /// when startTime is 0). If the pool has not opened by then,
    /// minting closes permanently and every Gen 0 egg becomes
    /// refundable in full (see refundEggs).
    uint256 public immutable refundDeadline;

    // ---- sale state ----
    uint256 public currentGen; // 0-based
    uint256 public genSold; // eggs sold in the current generation
    uint256 internal gen0Sold; // Gen 0 progress (pool trigger)
    bool public saleFinished; // latched when the final generation (MAX_GENERATION) sells out; minting is over forever
    uint8 internal curTier; // sales tier of the next egg (0..3)
    uint8 internal effTier; // effective price tier as of lastMintTs (idle-decayed)
    uint64 internal lastMintTs;
    // Mint slots (BNBCAT pen semantics, SPEC section 2): minting takes
    // a slot for (wallet, generation); the slot is held while the
    // self-minted unit is ALIVE and is freed back to the MINTER when
    // that unit dies — regardless of who owns it at death. Sales and
    // transfers never free slots.
    mapping(address => mapping(uint256 => uint256)) public slotsUsed;
    mapping(address => mapping(uint256 => uint256)) public totalMintedInGen; // monotonic, informational

    // ---- money flow (wei accounting over the contract's BNB balance) ----
    uint256 public reserveBNB; // pre-open 80% accumulation (pool seed budget)
    /// @notice Pre-open ESCROW of the 20% project leg (user decision
    /// 2026-11-03): while the pool is unopened the project leg accrues
    /// here instead of being paid out, so a failed launch can refund
    /// 100% of every Gen 0 payment. _openPool releases it in the open
    /// transaction; if the refund state triggers it is never released
    /// and instead funds refunds.
    uint256 public projectDue;
    uint256 public buybackPot; // post-open: half of each mint's 80%
    uint256 public lpPot; // post-open: the other half
    /// @dev Net BNB paid for each Gen 0 egg (its refund value),
    /// recorded at mint: the batch's net kept BNB apportioned across
    /// the batch's eggs by their charged USD, rounding remainder to
    /// the batch's last egg — a batch's records always sum exactly
    /// to the batch's net BNB paid.
    mapping(uint256 => uint256) internal _refundOf;

    bool public poolOpened;
    uint64 internal poolOpenTime;
    address public pair;

    // buyback guards (ported from BNBCAT v5)
    uint256 internal _lastBuybackBlock;
    uint256 internal _buybackSpentThisBlock;
    struct Obs {
        uint64 ts;
        uint256 price; // BNB (wei) per MAO (wei), scaled 1e18
    }
    Obs[64] internal _obs;
    uint256 internal _obsHead;
    uint256 public lastPokeBlock; // pokePrice guard: one observation per block

    // Agent ID binding (handle hash <-> wallet), permanent: one handle,
    // one wallet, forever (moving an Agent ID cannot open fresh quotas).
    mapping(address => bytes32) internal agentKeyOf;
    mapping(bytes32 => address) internal walletOfAgent;

    // ---- hatch state ----
    struct HatchReq {
        address owner;
        uint256 eggId;
        uint64 seedBlock;
        bytes32 captured; // captured seed-block hash; 0 = not captured
        bool settled;
        bool closed; // expired uncaptured and closed out (free re-arm)
    }
    mapping(uint256 => HatchReq) internal _hatches;
    uint256 public nextHatchId;
    mapping(uint256 => uint256) internal activeHatchOfEgg; // eggId => hatchId (0 = none)
    mapping(uint256 => uint64) internal rehatchReadyAt; // eggId => earliest re-hatch time
    uint256[] internal _hatchQueue;
    uint256 internal _queueHead;

    // ---- claim state (two-step claims with claim-death, SPEC section 5) ----
    struct ClaimReq {
        address owner; // the claimer (unit owner at request time)
        uint256 eggId;
        uint256 amount; // MAO locked at request: (base + set bonus) x patience mult
        uint64 seedBlock;
        bytes32 captured; // captured seed-block hash; 0 = not captured
        bool settled;
        bool closed; // expired uncaptured and closed out (nothing paid, no roll)
    }
    mapping(uint256 => ClaimReq) internal _claims;
    uint256 public nextClaimId;
    mapping(uint256 => uint256) internal activeClaimOfEgg; // eggId => claimId (0 = none)
    uint256[] internal _claimQueue;
    uint256 internal _claimQueueHead;

    event AgentBound(address indexed wallet, bytes32 indexed agentKey);
    event SlotFreed(uint256 indexed tokenId, address indexed minter, uint256 gen);
    event Minted(address indexed buyer, uint256 gen, uint256 count, uint256 bnbPaid, uint256 maoPaid, uint256 usdTotal);
    event ReserveFunded(address indexed funder, uint256 amount);
    event EggRefunded(uint256 indexed tokenId, address indexed owner, uint256 amount);
    event PoolOpened(address pair, uint256 bnbUsed, uint256 seedMao);
    event Buyback(uint256 bnbSpent, uint256 maoBurned);
    event LiquidityAdded(uint256 bnbSpent, uint256 maoUsed, uint256 liquidity);
    event ClaimRequested(uint256 indexed claimId, address indexed owner, uint256 indexed eggId, uint256 amount, uint256 seedBlock);
    event ClaimSeedCaptured(uint256 indexed claimId, bytes32 seedHash);
    event ClaimSettled(uint256 indexed claimId, uint256 indexed eggId, address indexed owner, uint256 amount, bool died);
    event ClaimExpired(uint256 indexed claimId, uint256 indexed eggId);
    // Graveyard record (SPEC section 5): cause ids are 0 = tired out,
    // 1 = choked on feathers, 2 = overate, 3 = passed in sleep,
    // 4 = struck by lightning (weights in claimDeathRoll).
    event Death(uint256 indexed eggId, uint8 species, uint8 causeId, uint256 lifetimeProduced, uint256 ageDays);
    event HatchRequested(uint256 indexed hatchId, address indexed owner, uint256 indexed eggId, uint256 seedBlock);
    event SeedCaptured(uint256 indexed hatchId, bytes32 seedHash);
    event HatchSettled(uint256 indexed hatchId, uint256 indexed eggId, uint8 species, address settler);
    event HatchExpired(uint256 indexed hatchId, uint256 indexed eggId);

    constructor(
        address token_,
        address eggs_,
        address registry_,
        address feed_,
        address router_,
        address factory_,
        address projectWallet_,
        uint256 startTime_
    ) {
        token = MaoToken(token_);
        eggs = EggNFT(eggs_);
        registry = IAgentIdRegistry(registry_);
        feed = IAggregatorV3(feed_);
        router = IPancakeRouter(router_);
        factory = IPancakeFactory(factory_);
        wbnb = IPancakeRouter(router_).WETH();
        projectWallet = projectWallet_;
        startTime = startTime_;
        refundDeadline = (startTime_ == 0 ? block.timestamp : startTime_) + 7 days;
        lastMintTs = uint64(block.timestamp);
    }

    // ---------------- pricing ----------------

    function _tierUsd(uint8 tier) internal pure returns (uint256) {
        if (tier == 0) return 2 ether;
        if (tier == 1) return 3 ether;
        if (tier == 2) return 4 ether;
        return 5 ether;
    }

    /// @dev Sales tier of the egg with 1-based serial `serial` in its gen.
    function _tierOf(uint256 serial) internal pure returns (uint8) {
        if (serial <= 1_000) return 0;
        if (serial <= 3_000) return 1;
        if (serial <= 6_000) return 2;
        return 3;
    }

    /// @notice Fixed MAO price ladder for Gen 1 and ALL later
    /// generations (user decision 2026-11-03, SPEC section 6, replacing
    /// the BNB/MAO payment gradient and the spot-priced leg): per-egg
    /// prices by sales segment — tier 0: 800, tier 1: 1,200, tier 2:
    /// 1,600, tier 3: 2,000 MAO — identical for every generation >= 1,
    /// calibrated as 2/3/4/5 days of an egg's 400/day production. Paid
    /// 100% in MAO in the mint transaction: 90% burned to DEAD, 10%
    /// swapped to BNB through the pair inside the same transaction
    /// (proceeds split into the buyback / LP pots) — the buyer pays
    /// no BNB. The idle-decay ratchet applies to this ladder exactly
    /// as to the Gen 0 USD ladder. (Solidity has no constant arrays,
    /// so the table is this pure function.) A full generation pays
    /// 16,000,000 MAO: 14,400,000 burned, 1,600,000 converted to BNB.
    function GEN_MAO_LADDER(uint8 tier) public pure returns (uint256) {
        // The MAO ladder is exactly 400x the USD ladder (2/3/4/5 ->
        // 800/1200/1600/2000), so it shares the one table.
        return _tierUsd(tier) * 400;
    }

    /// @notice Mint slots per wallet for a generation (FINAL, user
    /// decision 2026-11-03): 10 in Gen 0, 20 in every later
    /// generation. This cap is the ONLY mint-count limit — there is
    /// no per-transaction cap; a single mint may take any count from
    /// 1 up to the wallet's remaining slots. (The 1/5/10/20 figures
    /// are website quick-select presets, not a contract rule.)
    function maxPerGen(uint256 gen) public pure returns (uint256) {
        return gen == 0 ? MAX_PER_GEN_GEN0 : MAX_PER_GEN_LATER;
    }

    /// @dev Simulate a batch purchase against the idle-decay ratchet.
    /// `mao` selects the price table: the Gen 0 USD ladder or the
    /// Gen 1+ MAO ladder (identical segment walk and decay mechanics —
    /// SPEC sections 2 and 6). Returns the batch's total price in the
    /// table's unit and the resulting tier state. Decay: idle
    /// 30-minute steps below `effTier` apply to the starting tier only;
    /// crossing into the next sales tier resets to its full price.
    /// When `perEgg` has exactly `count` slots it is filled with each
    /// egg's individual charge (the failed-launch refund apportionment
    /// basis); pass an empty array to skip the fill.
    function _simulate(uint256 count, bool mao, uint256[] memory perEgg)
        internal
        view
        returns (uint256 total, uint8 endTier, uint8 endEffTier)
    {
        uint256 idleSteps = (block.timestamp - lastMintTs) / IDLE_WINDOW;
        uint8 eff = effTier;
        if (idleSteps >= eff) eff = 0;
        else eff -= uint8(idleSteps);
        uint8 tier = curTier;
        uint256 sold = genSold;
        bool fill = perEgg.length == count;
        for (uint256 i = 0; i < count; i++) {
            uint8 t = _tierOf(sold + 1);
            if (t != tier) {
                tier = t;
                eff = t; // entering the next tier: full price, decay cleared
            }
            uint8 chargeTier = eff < tier ? eff : tier;
            uint256 charge = mao ? GEN_MAO_LADDER(chargeTier) : _tierUsd(chargeTier);
            total += charge;
            if (fill) perEgg[i] = charge;
            sold++;
        }
        return (total, tier, eff);
    }

    /// @notice Current effective USD price of the next egg (after any
    /// idle decay), for the website's live price display. Gen 0 only —
    /// returns 0 from Gen 1 on, where eggs are priced in MAO.
    function currentPriceUsd() external view returns (uint256) {
        if (saleFinished) return 0;
        if (currentGen > 0) return 0;
        (uint256 one,,) = _simulate(1, false, new uint256[](0));
        return one;
    }

    /// @notice Current effective MAO price of the next egg (after any
    /// idle decay on the MAO ladder). Gen 1+ only — returns 0 in Gen 0.
    function currentPriceMao() external view returns (uint256) {
        if (saleFinished) return 0;
        if (currentGen == 0) return 0;
        (uint256 one,,) = _simulate(1, true, new uint256[](0));
        return one;
    }

    /// @notice BNB/USD from the price feed, with staleness/validity guards
    /// (ported from BNBCAT v5).
    function bnbUsd() public view returns (uint256 answer) {
        (uint80 roundId, int256 ans,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        require(ans > 0, "bad feed");
        require(updatedAt >= block.timestamp - 1 hours, "stale");
        require(answeredInRound >= roundId, "feed");
        answer = uint256(ans); // 8 decimals
    }

    /// @notice Pool spot price: BNB (wei) per MAO (wei), scaled 1e18.
    /// Zero before the pool opens or if the MAO reserve is empty.
    /// Informational only since the Gen 1+ fixed-price change — no
    /// mint pricing reads spot any more (the buyback guard uses the
    /// 1h TWAP observations instead).
    function spotPrice() internal view returns (uint256) {
        if (!poolOpened) return 0;
        (uint112 r0, uint112 r1,) = IPancakePair(pair).getReserves();
        (uint256 bnbRes, uint256 maoRes) = IPancakePair(pair).token0() == wbnb ? (r0, r1) : (r1, r0);
        if (maoRes == 0) return 0;
        return (bnbRes * 1e18) / maoRes;
    }

    /// @notice Quote a mint. Gen 0: BNB due from the USD ladder (with
    /// idle decay), no MAO. Gen 1+: zero BNB; MAO due from the fixed
    /// MAO ladder (with the same idle decay), no USD component.
    function quoteMint(uint256 count) public view returns (uint256 bnbDue, uint256 maoDue, uint256 usdTotal) {
        (bnbDue, maoDue, usdTotal,,,) = _quoteFull(count);
    }

    // ---------------- mint ----------------

    /// @notice Mint `count` eggs of the current generation. The eggs are
    /// issued INSTANTLY in this transaction — no randomness, no pending
    /// state. Gen 0 is paid in BNB (msg.value; overpay refunded).
    /// Gen 1+ is paid in MAO only: the MAO-ladder total for the batch,
    /// pulled via transferFrom in this transaction — 90% of it burned
    /// to DEAD, 10% swapped to BNB through the pair inside the same
    /// transaction (proceeds to the buyback / LP pots);
    /// `maxMaoPayable` must be at least that amount (a caller-side
    /// sanity cap); any BNB sent with a Gen 1+ mint is refunded.
    function mint(uint256 count, uint256 maxMaoPayable) external payable nonReentrant {
        require(block.timestamp >= startTime, "not started");
        require(count >= 1, "bad count");
        require(!saleFinished, "sale finished");
        // Failed launch: the refund deadline passed with the pool
        // still unopened — minting is permanently closed and every
        // Gen 0 egg is refundable instead (see refundEggs).
        require(poolOpened || block.timestamp < refundDeadline, "sale failed");
        _gate(msg.sender);
        require(genSold + count <= GEN_SIZE, "sold out");
        require(slotsUsed[msg.sender][currentGen] + count <= maxPerGen(currentGen), "generation quota used");

        (uint256 bnbDue, uint256 maoDue, uint256 usdTotal, uint8 endTier, uint8 endEff, uint256[] memory perEgg) =
            _quoteFull(count);
        require(msg.value >= bnbDue, "underpaid");
        if (maoDue > 0) {
            require(maoDue <= maxMaoPayable, "mao leg above max payable");
            require(token.transferFrom(msg.sender, address(this), maoDue), "mao pull");
            // Gen 1+ split (user decision 2026-11-03): 90% of the paid
            // MAO burned to DEAD; the remaining 10% swapped MAO -> BNB
            // through the pair inside this same transaction, proceeds
            // split into the buyback / LP pots (half / rest, exactly
            // like the Gen 0 post-open reserve split below). The
            // conversion can NEVER revert the mint: on any failure
            // the 10% leg is burned to DEAD instead (see
            // _convertMaoLeg). Ladder prices are whole-MAO multiples
            // of 400, so the 90% is always exact.
            uint256 burnLeg = (maoDue * GEN_MAO_BURN_BPS) / 10_000;
            uint256 swapLeg = maoDue - burnLeg;
            require(token.transfer(DEAD, burnLeg), "burn");
            uint256 bnbOut = _convertMaoLeg(swapLeg);
            if (bnbOut > 0) {
                buybackPot += bnbOut / 2;
                lpPot += bnbOut - bnbOut / 2;
            } else {
                require(token.transfer(DEAD, swapLeg), "burn");
            }
        }

        // commit sale state
        genSold += count;
        if (currentGen == 0) gen0Sold += count;
        slotsUsed[msg.sender][currentGen] += count;
        totalMintedInGen[msg.sender][currentGen] += count;
        curTier = endTier;
        effTier = endEff;
        // If this batch ended exactly on a tier boundary, the sale is
        // already sitting in the next tier: commit that crossing now
        // (at full price, decay clock = this mint), so the stored
        // tier state always describes the NEXT egg. Otherwise the next
        // quote's walk would treat the crossing as happening then and
        // wrongly erase the idle decay the new tier has accrued.
        if (genSold < GEN_SIZE) {
            uint8 nextTier = _tierOf(genSold + 1);
            if (nextTier != curTier) {
                curTier = nextTier;
                effTier = nextTier;
            }
        }
        lastMintTs = uint64(block.timestamp);

        // split the BNB leg: 20% project / 80% reserve (Gen 0 only in
        // practice — Gen 1+ mints carry bnbDue == 0 and split nothing).
        // Pre-open, BOTH legs stay in the contract: the reserve accrues
        // as today, but the project leg is escrowed in projectDue so a
        // failed launch can refund 100% of every payment; _openPool
        // releases the escrow in the open transaction. Post-open the
        // project leg is paid immediately, as before.
        uint256 projectPart = (bnbDue * 20) / 100;
        uint256 reservePart = bnbDue - projectPart;
        if (!poolOpened) {
            projectDue += projectPart;
            reserveBNB += reservePart;
        } else {
            (bool ok,) = projectWallet.call{value: projectPart}("");
            require(ok, "project");
            buybackPot += reservePart / 2;
            lpPot += reservePart - reservePart / 2;
        }

        // Instant issuance — the eggs exist before this call returns.
        // A pre-open Gen 0 batch also records each egg's refund value:
        // the batch's net kept BNB (bnbDue — the overpay is refunded
        // at the end of this call, so bnbDue is exactly what the
        // batch paid) apportioned by each egg's charged USD, with
        // the rounding remainder on the batch's last egg, so a
        // batch's records sum exactly to what it paid.
        bool recordRefund = currentGen == 0 && !poolOpened;
        uint256 refundAcc = 0;
        for (uint256 i = 0; i < count; i++) {
            uint256 tid = eggs.mintEgg(msg.sender, uint8(currentGen));
            if (recordRefund) {
                if (i + 1 == count) {
                    _refundOf[tid] = bnbDue - refundAcc;
                } else {
                    uint256 r = (bnbDue * perEgg[i]) / usdTotal;
                    refundAcc += r;
                    _refundOf[tid] = r;
                }
            }
        }
        emit Minted(msg.sender, currentGen, count, bnbDue, maoDue, usdTotal);

        if (!poolOpened && currentGen == 0 && genSold >= POOL_TRIGGER) {
            _openPool();
        } else if (poolOpened) {
            _tryBuyback();
            _tryAddLiquidity();
        }

        // generation rollover — capped: selling out the final
        // generation (MAX_GENERATION) latches the finished state
        // instead of opening a new generation. genSold stays at
        // GEN_SIZE so the finished state reads clean on-chain.
        if (genSold == GEN_SIZE) {
            if (currentGen == MAX_GENERATION) {
                saleFinished = true;
            } else {
                currentGen += 1;
                genSold = 0;
                curTier = 0;
                effTier = 0;
                lastMintTs = uint64(block.timestamp);
            }
        }

        _piggyback();

        uint256 refund = msg.value - bnbDue;
        if (refund > 0) {
            (bool ok2,) = msg.sender.call{value: refund}("");
            require(ok2, "refund");
        }
    }

    function _quoteFull(uint256 count)
        internal
        view
        returns (uint256 bnbDue, uint256 maoDue, uint256 usdTotal, uint8 endTier, uint8 endEff, uint256[] memory perEgg)
    {
        // The tier walk (segments + idle decay) is shared by both
        // ladders; only the price table differs. One walk yields the
        // batch price, the resulting tier state, and each egg's
        // individual charge (refund apportionment basis).
        perEgg = new uint256[](count);
        if (currentGen > 0) {
            (maoDue, endTier, endEff) = _simulate(count, true, perEgg);
            return (0, maoDue, 0, endTier, endEff, perEgg);
        }
        (usdTotal, endTier, endEff) = _simulate(count, false, perEgg);
        bnbDue = (usdTotal * 1e8) / bnbUsd();
        return (bnbDue, 0, usdTotal, endTier, endEff, perEgg);
    }

    /// @dev Agent ID gate + permanent binding (ported from BNBCAT v5).
    /// The wallet must hold an Agent ID; its handle is bound to this
    /// wallet on first use. A handle already bound to another wallet (ID
    /// moved) or a wallet already bound to another handle is rejected:
    /// generation quotas never move between wallets.
    function _gate(address w) internal {
        require(registry.balanceOf(w) > 0, "no agent id");
        bytes memory h = bytes(registry.handleOf(w));
        require(h.length > 0, "no agent handle");
        bytes32 key = keccak256(h);
        bytes32 cur = agentKeyOf[w];
        if (cur == key) return;
        require(cur == bytes32(0), "bound");
        require(walletOfAgent[key] == address(0), "agent id bound elsewhere");
        agentKeyOf[w] = key;
        walletOfAgent[key] = w;
        emit AgentBound(w, key);
    }

    /// @notice Slot-release notification from the EggNFT contract:
    /// frees one mint slot back to its MINTER for that generation. The
    /// NFT contract calls this exactly once per unit — either at
    /// plunder settlement (the egg becomes a shell, which holds no
    /// slot) or at killUnit teardown for a unit that still held its
    /// slot (claim-death, refund surrender) — so a slot can never be
    /// double-freed: a shell's refund and a plunder-born animal's
    /// claim-death release nothing, because their slots are already
    /// gone / never existed. The minter may mint again into the freed
    /// slot while that generation is still on sale (genSold
    /// accounting is unaffected: a freed slot does not un-sell the
    /// generation).
    function onSlotRelease(uint256 tokenId, address minter, uint8 gen) external {
        require(msg.sender == address(eggs), "only eggs");
        if (slotsUsed[minter][gen] > 0) slotsUsed[minter][gen] -= 1;
        emit SlotFreed(tokenId, minter, gen);
    }

    // ---------------- failed-launch refund (Gen 0) ----------------

    /// @notice True when the launch has failed: the refund deadline
    /// passed and the pool never opened. From that moment minting is
    /// permanently closed and every alive Gen 0 unit is refundable.
    /// If the pool opens before the deadline this can never become
    /// true.
    function refundAvailable() public view returns (bool) {
        return !poolOpened && block.timestamp >= refundDeadline;
    }

    /// @notice BNB refundable for a unit right now: the net BNB paid
    /// for that egg at mint. 0 unless refunds are available and the
    /// unit is an alive Gen 0 unit.
    function refundableOf(uint256 tokenId) external view returns (uint256) {
        if (!refundAvailable()) return 0;
        if (eggs.genOf(tokenId) != 0 || eggs.isDead(tokenId)) return 0;
        return _refundOf[tokenId];
    }

    /// @notice Refund Gen 0 units after a failed launch (batch,
    /// mirroring the claim API). SPECIES-AGNOSTIC: the refund attaches
    /// to the NFT and the BNB paid for it, not to the egg form — an
    /// unhatched egg, any hatched animal and an empty shell all refund on
    /// the same terms. Per unit the caller must own it, it must be
    /// alive, and it must not be mid-hatch or mid-claim (settle or
    /// expire those first). The unit is torn down through the
    /// claim-death path (NFT to DEAD, minter's slot freed, sale
    /// counters decremented), its accrued unclaimed MAO dies with it
    /// (already-claimed MAO is NOT clawed back), and the recorded
    /// BNB is paid to the caller from the escrowed mint proceeds
    /// (reserveBNB + projectDue — the project leg is never released
    /// on a failed launch, so refunds are whole).
    function refundEggs(uint256[] calldata tokenIds) external nonReentrant {
        require(refundAvailable(), "no refund");
        uint256 n = tokenIds.length;
        require(n >= 1, "empty");
        uint256 total = 0;
        for (uint256 i = 0; i < n; i++) {
            uint256 tokenId = tokenIds[i];
            require(eggs.ownerOf(tokenId) == msg.sender, "not yours");
            require(eggs.genOf(tokenId) == 0, "gen 0 only");
            require(!eggs.isDead(tokenId), "dead");
            require(!eggs.hatchPending(tokenId), "hatching");
            require(!eggs.claimPending(tokenId), "claim pending");
            uint256 amount = _refundOf[tokenId];
            _refundOf[tokenId] = 0; // zeroed before teardown: no second refund
            total += amount;
            eggs.killUnit(tokenId); // NFT to DEAD; slot freed via onSlotRelease only if still held (a shell's was released at plunder)
            genSold -= 1; // the failed generation unwinds as units are surrendered
            gen0Sold -= 1;
            emit EggRefunded(tokenId, msg.sender, amount);
        }
        // Debit the escrow accounting (reserve leg first, then the
        // never-released project leg) so the wei accounting stays
        // truthful against the contract balance.
        uint256 fromReserve = total < reserveBNB ? total : reserveBNB;
        reserveBNB -= fromReserve;
        projectDue -= total - fromReserve;
        (bool ok,) = msg.sender.call{value: total}("");
        require(ok, "refund");
    }

    // ---------------- production claim (two-step, claim-death) ----------------

    /// @notice Request a claim for the caller's units (batch allowed).
    /// The claimable amount — accrual up to this moment plus the
    /// collection-set bonus, times the patience multiplier as of now —
    /// is LOCKED into the request (SPEC section 5). The unit locks
    /// while pending (no transfer, listing or hatch) and the request
    /// is non-cancellable. Units with nothing to claim are skipped
    /// silently (a zero claim never locks and never rolls death).
    /// Settlement (seed capture + piggyback + backstop, same machinery
    /// as hatching) mints the locked MAO to the claimer IN FULL, then
    /// rolls the unit's death dice.
    function requestClaim(uint256[] calldata eggIds) external nonReentrant {
        uint256 n = eggIds.length;
        require(n >= 1, "empty");
        for (uint256 i = 0; i < n; i++) {
            uint256 eggId = eggIds[i];
            if (eggs.ownerOf(eggId) != msg.sender) continue;
            if (eggs.isDead(eggId)) continue;
            // Empty shells never claim (and so never roll claim-death and
            // never free their mint slot): skipped exactly like
            // zero-balance units, even if egg-phase accrual rides on
            // the unit — it stays on the NFT, unclaimable.
            if (eggs.speciesOf(eggId) == SP_SHELL) continue;
            require(activeClaimOfEgg[eggId] == 0, "claim pending");
            require(!eggs.hatchPending(eggId), "hatching");
            uint256 total = eggs.pendingOf(eggId) + eggs.setBonusPendingOf(eggId);
            if (total == 0) continue;
            uint256 amount = (total * eggs.patienceMult(eggId)) / 100;
            uint256 claimId = ++nextClaimId;
            ClaimReq storage r = _claims[claimId];
            r.owner = msg.sender;
            r.eggId = eggId;
            r.amount = amount;
            r.seedBlock = uint64(block.number + CLAIM_SEED_DELAY);
            activeClaimOfEgg[eggId] = claimId;
            eggs.setClaimPending(eggId, true);
            _claimQueue.push(claimId);
            emit ClaimRequested(claimId, msg.sender, eggId, amount, r.seedBlock);
        }
        _piggyback();
    }

    // ---- unified hatch/claim request API ----
    // Hatches (isClaim = false) and claims (isClaim = true) run the
    // same seed-capture state machine (SPEC sections 4/5); their
    // external surface is one set of functions over the two stores,
    // which also keeps this contract inside the EIP-170 size limit.

    /// @notice Capture a pending request's seed-block hash into
    /// storage. After capture the request can be settled at ANY
    /// later time. Permissionless; also runs automatically
    /// (piggyback) inside mint/claim/hatch calls.
    function captureReqSeed(bool isClaim, uint256 id) external returns (bool) {
        return isClaim ? _captureClaimSeed(id) : _captureSeed(id);
    }

    /// @notice A request's random word: zero while the seed is
    /// unavailable (not yet mined, or expired uncaptured). Once the
    /// seed block exists anyone can compute the outcome — it is
    /// determined, but was never steerable — and once captured it is
    /// frozen forever.
    function reqWord(bool isClaim, uint256 id) public view returns (uint256) {
        if (isClaim) {
            ClaimReq storage r = _claims[id];
            return _seedWord(r.captured, r.seedBlock, id, r.eggId);
        }
        HatchReq storage r = _hatches[id];
        return _seedWord(r.captured, r.seedBlock, id, r.eggId);
    }

    /// @notice Settle one request. Callable by anyone (the owner, the
    /// backstop keeper, any passer-by). Reverts if the seed is not
    /// yet available or expired uncaptured (close it out with
    /// expireReq first — for a claim nothing was consumed; for a
    /// hatch, re-hatch for free after the cooldown).
    function settleReq(bool isClaim, uint256 id) external nonReentrant {
        require(isClaim ? _settleClaim(id) : _settleHatch(id), "seed not ready");
    }

    /// @notice Request states for the keeper / site: 0 = none,
    /// 1 = awaiting seed block, 2 = settleable (seed readable or
    /// captured), 3 = expired uncaptured (close with expireReq),
    /// 4 = settled, 5 = closed.
    function reqState(bool isClaim, uint256 id) external view returns (uint8) {
        if (isClaim) {
            ClaimReq storage r = _claims[id];
            return _reqState(r.owner, r.settled, r.closed, r.captured, r.seedBlock);
        }
        HatchReq storage r = _hatches[id];
        return _reqState(r.owner, r.settled, r.closed, r.captured, r.seedBlock);
    }

    /// @notice Full request record. `amount` is the claim's locked
    /// MAO (0 for hatches, which carry no amount).
    function reqOf(bool isClaim, uint256 id)
        external
        view
        returns (address owner, uint256 eggId, uint256 amount, uint256 seedBlock, bytes32 captured, bool settled, bool closed)
    {
        if (isClaim) {
            ClaimReq storage r = _claims[id];
            return (r.owner, r.eggId, r.amount, r.seedBlock, r.captured, r.settled, r.closed);
        }
        HatchReq storage r = _hatches[id];
        return (r.owner, r.eggId, 0, r.seedBlock, r.captured, r.settled, r.closed);
    }

    /// @notice Total requests ever queued on one queue (append-only).
    function reqQueueLength(bool isClaim) external view returns (uint256) {
        return isClaim ? _claimQueue.length : _hatchQueue.length;
    }

    /// @notice Enumerate pending (unsettled, unclosed) request ids on
    /// one queue, scanning from its current head. `maxCount` bounds
    /// the page size; settled items drop out of the result as
    /// settlement advances the queue. This is the backstop keeper's
    /// discovery surface (with the request events) — fully on-chain,
    /// no notification needed.
    function pendingReqs(bool isClaim, uint256 maxCount) external view returns (uint256[] memory ids) {
        uint256[] storage q = isClaim ? _claimQueue : _hatchQueue;
        uint256 head = isClaim ? _claimQueueHead : _queueHead;
        uint256 n = 0;
        for (uint256 i = head; i < q.length && n < maxCount; i++) {
            if (_reqPending(isClaim, q[i])) n++;
        }
        ids = new uint256[](n);
        uint256 k = 0;
        for (uint256 i = head; i < q.length && k < n; i++) {
            if (_reqPending(isClaim, q[i])) ids[k++] = q[i];
        }
    }

    function _reqPending(bool isClaim, uint256 id) internal view returns (bool) {
        if (isClaim) return !_claims[id].settled && !_claims[id].closed;
        return !_hatches[id].settled && !_hatches[id].closed;
    }

    /// @notice Close out a request whose seed block passed uncaptured
    /// beyond the blockhash window. Claims (isClaim): NO cooldown and
    /// nothing to re-arm — no amount was paid and no roll can ever be
    /// computed (the blockhash is gone), the unit simply unlocks with
    /// its accrual and patience clock untouched, and the owner may
    /// re-request immediately. Hatches: the PROJECT's side of the
    /// B+C rule — the egg is NOT consumed and there is NO penalty;
    /// the only consequence is a 24h re-hatch cooldown (anti
    /// outage-window fishing), and the egg keeps producing
    /// throughout. Permissionless either way.
    function expireReq(bool isClaim, uint256 id) external {
        address owner;
        uint256 eggId;
        bytes32 captured;
        uint64 seedBlock;
        bool settled;
        bool closed;
        if (isClaim) {
            ClaimReq storage r = _claims[id];
            (owner, eggId, captured, seedBlock, settled, closed) =
                (r.owner, r.eggId, r.captured, r.seedBlock, r.settled, r.closed);
            r.closed = true;
        } else {
            HatchReq storage r = _hatches[id];
            (owner, eggId, captured, seedBlock, settled, closed) =
                (r.owner, r.eggId, r.captured, r.seedBlock, r.settled, r.closed);
            r.closed = true;
        }
        require(owner != address(0) && !settled && !closed, isClaim ? "no claim" : "no hatch");
        require(captured == bytes32(0), "captured");
        require(block.number > uint256(seedBlock) + SEED_WINDOW, "seed valid");
        if (isClaim) {
            activeClaimOfEgg[eggId] = 0;
            eggs.setClaimPending(eggId, false);
            emit ClaimExpired(id, eggId);
        } else {
            activeHatchOfEgg[eggId] = 0;
            eggs.setHatchPending(eggId, false);
            rehatchReadyAt[eggId] = uint64(block.timestamp + REHATCH_COOLDOWN);
            emit HatchExpired(id, eggId);
        }
    }

    /// @dev The seed-block hash available for capture by a pending
    /// request, or 0 when capture is impossible (unknown / settled /
    /// closed / already captured / seed block not yet mined / window
    /// passed / hash unavailable). Shared by hatch and claim capture.
    function _capturableHash(address owner, bool settled, bool closed, bytes32 captured, uint64 seedBlock)
        internal
        view
        returns (bytes32)
    {
        if (owner == address(0) || settled || closed || captured != bytes32(0)) return bytes32(0);
        if (block.number <= uint256(seedBlock) || block.number > uint256(seedBlock) + SEED_WINDOW) return bytes32(0);
        return blockhash(uint256(seedBlock));
    }

    function _captureClaimSeed(uint256 claimId) internal returns (bool) {
        ClaimReq storage r = _claims[claimId];
        bytes32 bh = _capturableHash(r.owner, r.settled, r.closed, r.captured, r.seedBlock);
        if (bh == bytes32(0)) return false;
        r.captured = bh;
        emit ClaimSeedCaptured(claimId, bh);
        return true;
    }

    /// @dev Shared seed-word resolution for hatch and claim requests:
    /// the captured hash if present, else the live blockhash inside
    /// its window, else 0 (seed unavailable). Once the seed block
    /// exists the word is determined — but never steerable — and
    /// once captured it is frozen forever.
    function _seedWord(bytes32 captured, uint64 seedBlock, uint256 id, uint256 eggId) internal view returns (uint256) {
        bytes32 bh = captured;
        if (bh == bytes32(0)) {
            if (seedBlock == 0 || block.number <= uint256(seedBlock)) return 0;
            bh = blockhash(uint256(seedBlock));
            if (bh == bytes32(0)) return 0;
        }
        return uint256(keccak256(abi.encodePacked(bh, id, eggId, address(this))));
    }

    /// @notice Death and cause rolls for a claim word (SPEC section 5).
    /// Death: flat 20% (DEATH_PCT) for eggs and chicken/duck/goose/bird
    /// — the caller skips phoenix entirely, no roll is derived for it.
    /// Cause weights (percent): 0 tired out 30, 1 choked on feathers
    /// 30, 2 overate 20, 3 passed in sleep 15, 4 lightning 5.
    function claimDeathRoll(uint256 word, uint256 claimId, uint256 eggId)
        public
        pure
        returns (bool died, uint8 cause)
    {
        uint256 d = uint256(keccak256(abi.encodePacked(word, claimId, eggId, "death"))) % 100;
        died = d < DEATH_PCT;
        if (!died) return (false, 0);
        uint256 c = uint256(keccak256(abi.encodePacked(word, claimId, eggId, "cause"))) % 100;
        cause = c < 30 ? 0 : c < 60 ? 1 : c < 80 ? 2 : c < 95 ? 3 : 4;
    }

    function _settleClaim(uint256 claimId) internal returns (bool) {
        ClaimReq storage r = _claims[claimId];
        if (r.owner == address(0) || r.settled || r.closed) return false;
        if (r.captured == bytes32(0)) _captureClaimSeed(claimId);
        uint256 word = _seedWord(r.captured, r.seedBlock, claimId, r.eggId);
        if (word == 0) return false;
        r.settled = true;
        uint256 eggId = r.eggId;
        activeClaimOfEgg[eggId] = 0;
        // The locked MAO is minted IN FULL, first (SPEC section 5:
        // death never touches the claimed amount). If the circulating
        // cap headroom is short this mint reverts and the claim simply
        // stays pending — burns free headroom over time (section 6).
        token.mint(r.owner, r.amount);
        uint8 species = eggs.speciesOf(eggId);
        bool died = false;
        uint8 cause = 0;
        // Phoenixes never roll death; shells are excluded as a hard
        // guarantee too (requestClaim already skips them, so no claim
        // of theirs can ever reach this point).
        if (species != SP_PHOENIX && species != SP_SHELL) {
            (died, cause) = claimDeathRoll(word, claimId, eggId);
        }
        if (died) {
            uint256 lifetime = eggs.lifetimeTotalOf(eggId);
            uint256 age = eggs.ageDays(eggId);
            eggs.setClaimPending(eggId, false);
            eggs.killUnit(eggId); // NFT to DEAD; slot freed via onSlotRelease if the unit still held one
            emit Death(eggId, species, cause, lifetime, age);
        } else {
            eggs.settleClaimUnit(eggId); // clock restarts at settle; 1h pause
        }
        emit ClaimSettled(claimId, eggId, r.owner, r.amount, died);
        return true;
    }

    /// @dev Shared request-state machine for hatch and claim requests:
    /// 0 = none, 1 = awaiting seed block, 2 = settleable (seed readable
    /// or captured), 3 = expired uncaptured, 4 = settled, 5 = closed.
    function _reqState(address owner, bool settled, bool closed, bytes32 captured, uint64 seedBlock)
        internal
        view
        returns (uint8)
    {
        if (owner == address(0)) return 0;
        if (settled) return 4;
        if (closed) return 5;
        if (captured != bytes32(0)) return 2;
        if (block.number <= uint256(seedBlock)) return 1;
        if (block.number <= uint256(seedBlock) + SEED_WINDOW) return 2;
        return 3;
    }

    // ---------------- hatch: request & settle ----------------

    /// @notice Request hatching for the caller's eggs (batch allowed).
    /// Each egg locks (non-transferable, not listable) until settlement.
    /// Hatching is free — no fee and no bounty (SPEC section 4/10);
    /// settlement rides on seed capture, piggyback settlement, the
    /// owner's own settle call and the project backstop sweep.
    function requestHatch(uint256[] calldata eggIds) external nonReentrant {
        uint256 n = eggIds.length;
        require(n >= 1, "empty");
        for (uint256 i = 0; i < n; i++) {
            uint256 eggId = eggIds[i];
            require(eggs.ownerOf(eggId) == msg.sender, "not yours");
            require(eggs.speciesOf(eggId) == SP_EGG, "not an egg");
            require(!eggs.hatchPending(eggId), "hatching");
            require(activeClaimOfEgg[eggId] == 0, "claim pending");
            require(block.timestamp >= rehatchReadyAt[eggId], "re-hatch cooldown");
            uint256 hatchId = ++nextHatchId;
            HatchReq storage r = _hatches[hatchId];
            r.owner = msg.sender;
            r.eggId = eggId;
            r.seedBlock = uint64(block.number + HATCH_SEED_DELAY);
            activeHatchOfEgg[eggId] = hatchId;
            eggs.setHatchPending(eggId, true);
            _hatchQueue.push(hatchId);
            emit HatchRequested(hatchId, msg.sender, eggId, r.seedBlock);
        }
        _piggyback();
    }

    function _captureSeed(uint256 hatchId) internal returns (bool) {
        HatchReq storage r = _hatches[hatchId];
        bytes32 bh = _capturableHash(r.owner, r.settled, r.closed, r.captured, r.seedBlock);
        if (bh == bytes32(0)) return false;
        r.captured = bh;
        emit SeedCaptured(hatchId, bh);
        return true;
    }

    /// @notice Hatch species for a word: the 9,000-point animal
    /// table in EggNFT (chicken 3856 / duck 2314 / goose 1653 / bird
    /// 1157 / phoenix 20 over 9,000); the kept-species probabilities
    /// are 38.56 / 23.14 / 16.53 / 11.57 / 0.2%. The roll table itself
    /// lives in EggNFT with the plunder machinery; this view mirrors
    /// it for the website/tests. A hatched animal leaves its hatcher
    /// only through the independent plunder roll at settlement (see
    /// _settleHatch), never through this table.
    function speciesForWord(uint256 word) public pure returns (uint8) {
        uint256 roll = word % 9_000;
        if (roll < 3856) return SP_CHICKEN;
        if (roll < 6170) return SP_DUCK;
        if (roll < 7823) return SP_GOOSE;
        if (roll < 8980) return SP_BIRD;
        return SP_PHOENIX;
    }

    /// @notice Permissionless sweep for the project backstop keeper:
    /// settle up to `maxItems` queue-front hatches AND claims. Never
    /// required for correctness — owners can always settle their own —
    /// it only keeps the queues short.
    function settleBacklog(uint256 maxItems) external {
        _piggybackHatches(maxItems);
        _piggybackClaims(maxItems);
    }

    function _settleHatch(uint256 hatchId) internal returns (bool) {
        HatchReq storage r = _hatches[hatchId];
        if (r.owner == address(0) || r.settled || r.closed) return false;
        if (r.captured == bytes32(0)) _captureSeed(hatchId);
        uint256 word = _seedWord(r.captured, r.seedBlock, hatchId, r.eggId);
        if (word == 0) return false;
        r.settled = true;
        uint256 eggId = r.eggId;
        activeHatchOfEgg[eggId] = 0;
        // The whole outcome resolution (species roll, plunder roll,
        // registry pick, shell transform / animal mint, the Plunder
        // event, and the shell's slot release) runs inside EggNFT in
        // one call (SPEC section 4); this function only emits
        // HatchSettled with the egg's settled species: the animal's
        // species when kept, 6 (empty shell) when plundered.
        uint8 settledSpecies = eggs.settleHatchTransform(eggId, word);
        emit HatchSettled(hatchId, eggId, settledSpecies, msg.sender);
        return true;
    }

    /// @dev Piggyback settlement: capture + settle queue-front pending
    /// hatches AND claims inside ordinary user calls, so settlement
    /// rides on normal contract traffic and never depends on a keeper.
    function _piggyback() internal {
        _piggybackHatches(PIGGYBACK_MAX);
        _piggybackClaims(PIGGYBACK_MAX);
    }

    function _piggybackClaims(uint256 maxItems) internal {
        uint256 done = 0;
        while (done < maxItems && _claimQueueHead < _claimQueue.length) {
            uint256 claimId = _claimQueue[_claimQueueHead];
            ClaimReq storage r = _claims[claimId];
            if (r.settled || r.closed) {
                _claimQueueHead++;
                continue;
            }
            if (block.number <= uint256(r.seedBlock)) break; // FIFO: seed blocks are non-decreasing
            if (r.captured == bytes32(0) && block.number > uint256(r.seedBlock) + SEED_WINDOW) {
                _claimQueueHead++; // expired uncaptured: skippable here, closable via expireReq
                continue;
            }
            _captureClaimSeed(claimId);
            if (_settleClaim(claimId)) {
                _claimQueueHead++;
                done++;
            } else {
                break;
            }
        }
    }

    function _piggybackHatches(uint256 maxItems) internal {
        uint256 done = 0;
        while (done < maxItems && _queueHead < _hatchQueue.length) {
            uint256 hatchId = _hatchQueue[_queueHead];
            HatchReq storage r = _hatches[hatchId];
            if (r.settled || r.closed) {
                _queueHead++;
                continue;
            }
            if (block.number <= uint256(r.seedBlock)) break; // FIFO: seed blocks are non-decreasing
            if (r.captured == bytes32(0) && block.number > uint256(r.seedBlock) + SEED_WINDOW) {
                _queueHead++; // expired uncaptured: skippable here, closable via expireReq
                continue;
            }
            _captureSeed(hatchId);
            if (_settleHatch(hatchId)) {
                _queueHead++;
                done++;
            } else {
                break;
            }
        }
    }

    // ---------------- pool opening ----------------

    /// @notice Top up the pre-open pool reserve (ported from BNBCAT v5).
    /// Credited to reserveBNB one-for-one; closed forever once open.
    function fundReserve() external payable {
        require(!poolOpened, "pool open");
        reserveBNB += msg.value;
        emit ReserveFunded(msg.sender, msg.value);
    }

    /// @dev Pool open, inside the mint that sells Gen 0 egg #5,000.
    /// Pattern ported from BNBCAT v5 (hardened open): the pair must be
    /// the CREATE2-predicted one and empty; donated WBNB is skimmed and
    /// recovered into the buyback pot; the seed is sized from the reserve
    /// at the $0.0015 anchor, capped at SEED_CAP MAO (excess reserve goes
    /// to the buyback pot); LP is minted straight to DEAD; the reserve
    /// ratio is asserted within 0.5% of the anchor.
    function _openPool() internal {
        uint256 budget = reserveBNB;
        reserveBNB = 0;
        require(budget > 0, "no reserve");
        address p = factory.getPair(address(token), wbnb);
        if (p == address(0)) p = factory.createPair(address(token), wbnb);
        require(p == token.predictedPair(), "pair");
        require(IPancakePair(p).totalSupply() == 0, "seeded");

        // Recover any donated WBNB (MAO cannot be donated: the token
        // gates transfers into the predicted pair until the open).
        IPancakePair(p).skim(address(this));
        uint256 w = IWETH(wbnb).balanceOf(address(this));
        uint256 toPot = 0;
        if (w > 0) {
            IWETH(wbnb).withdraw(w); // receive() ignores WBNB unwraps
            toPot = w;
        }
        require(token.balanceOf(p) == 0, "donated");
        require(IWETH(wbnb).balanceOf(p) == 0, "donated");

        uint256 px = bnbUsd();
        uint256 bnbUsed = budget;
        uint256 seedMao = (((bnbUsed * px) / 1e8) * 1 ether) / ANCHOR_USD;
        if (seedMao > SEED_CAP) {
            seedMao = SEED_CAP;
            bnbUsed = (((seedMao * ANCHOR_USD) / 1 ether) * 1e8) / px;
            toPot += budget - bnbUsed;
        }
        require(bnbUsed > 0 && seedMao > 0, "zero");
        buybackPot += toPot;

        token.mint(address(this), seedMao);
        IWETH(wbnb).deposit{value: bnbUsed}();
        require(IWETH(wbnb).transfer(p, bnbUsed), "xfer");
        require(token.transfer(p, seedMao), "xfer");
        require(IPancakePair(p).mint(DEAD) > 0, "zero");

        pair = p;
        token.setOfficialPair(p);
        token.notifyPoolOpened(p); // starts the token's anti-snipe window clock
        poolOpened = true;
        poolOpenTime = uint64(block.timestamp);

        (uint112 r0, uint112 r1,) = IPancakePair(p).getReserves();
        (uint256 maoRes, uint256 wbnbRes) =
            IPancakePair(p).token0() == address(token) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        require(maoRes > 0 && wbnbRes > 0, "no reserves");
        uint256 impliedUsd = ((wbnbRes * px) / 1e8) * 1 ether / maoRes;
        require(
            impliedUsd >= (ANCHOR_USD * (10_000 - ANCHOR_TOL_BPS)) / 10_000
                && impliedUsd <= (ANCHOR_USD * (10_000 + ANCHOR_TOL_BPS)) / 10_000,
            "drift"
        );
        _pushObs();
        // Release the escrowed pre-open project leg (20% of every
        // Gen 0 payment up to and including the opening mint): the
        // launch has succeeded, refunds can never trigger now, and
        // later Gen 0 mints pay the leg immediately at mint time.
        if (projectDue > 0) {
            uint256 due = projectDue;
            projectDue = 0;
            (bool okP,) = projectWallet.call{value: due}("");
            require(okP, "project");
        }
        emit PoolOpened(p, bnbUsed, seedMao);
    }

    // ---------------- buyback & liquidity (post-open) ----------------

    /// @notice Permissionless buyback trigger (also piggybacked in mints).
    function buyback() external nonReentrant {
        _tryBuyback();
    }

    /// @notice Permissionless liquidity-add trigger (also piggybacked).
    function addLiquidity() external nonReentrant {
        _tryAddLiquidity();
    }

    /// @dev Convert a Gen 1+ payment's 10% leg from MAO to BNB through
    /// the pair (SPEC section 6), via the MaoConverter helper (a
    /// separate contract for the EIP-170 size budget; the token's
    /// converter address is the wiring record). minOut = 95% of the
    /// value implied by the 1h observation average — spot when no
    /// observation exists — the same pricing basis and slippage
    /// bound as the buyback. Returns the BNB received; 0 when no
    /// price reference exists, no converter is wired, or the swap
    /// failed for any reason. The caller (mint) burns the leg on a
    /// 0 return, so a conversion failure can never revert or strand
    /// a user's mint (a reverted converter call is atomic — the MAO
    /// stays in this contract).
    function _convertMaoLeg(uint256 swapLeg) internal returns (uint256) {
        if (swapLeg == 0 || !poolOpened) return 0;
        address conv = token.converter();
        if (conv == address(0)) return 0;
        (uint256 px,) = _refPrice();
        if (px == 0) return 0;
        uint256 minOut = ((swapLeg * px) / 1e18) * 95 / 100;
        token.approve(conv, swapLeg);
        try IConverter(conv).swapMaoToBnb(swapLeg, minOut) returns (uint256 got) {
            return got;
        } catch {
            return 0;
        }
    }

    function _pushObs() internal {
        uint256 spot = spotPrice();
        if (spot == 0) return;
        _obs[_obsHead] = Obs({ts: uint64(block.timestamp), price: spot});
        _obsHead = (_obsHead + 1) % 64;
    }

    /// @notice Record a price observation (helps the TWAP window stay
    /// fresh). At most one per block (ported BNBCAT v5 fix).
    function pokePrice() external {
        if (!poolOpened) return;
        require(block.number > lastPokeBlock, "poke once per block");
        lastPokeBlock = block.number;
        _pushObs();
    }

    function _avgPrice() internal view returns (uint256 avg, uint256 n) {
        uint256 sum = 0;
        for (uint256 i = 0; i < 64; i++) {
            Obs storage o = _obs[i];
            if (o.ts != 0 && o.ts >= block.timestamp - 1 hours && o.ts <= block.timestamp) {
                sum += o.price;
                n += 1;
            }
        }
        if (n > 0) avg = sum / n;
    }

    /// @dev Reference price for swap minOut bounds: the 1h
    /// observation average when observations exist, else spot (the
    /// buyback's price guard and both minOut computations share this
    /// basis). px == spot exactly when no observation exists, which
    /// is what makes the buyback's `spot > px x 1.02` guard form
    /// equivalent to its average-based form.
    function _refPrice() internal view returns (uint256 px, uint256 spot) {
        (uint256 avg, uint256 n) = _avgPrice();
        spot = spotPrice();
        px = n > 0 ? avg : spot;
    }

    /// @dev Buyback, ported from BNBCAT v5 with its guards verbatim in
    /// spirit: skip when spot > 1h average x 1.02, per-block spend cap =
    /// 1% of the pair's BNB reserve, minOut = 95% of the TWAP-expected
    /// output; bought MAO is sent to DEAD in full (the main burn sink).
    /// A failed swap never reverts the caller — the BNB stays in the pot.
    function _tryBuyback() internal {
        if (!poolOpened || buybackPot == 0) return;
        (uint112 r0, uint112 r1,) = IPancakePair(pair).getReserves();
        uint256 bnbReserve = IPancakePair(pair).token0() == wbnb ? r0 : r1;
        if (block.number != _lastBuybackBlock) {
            _lastBuybackBlock = block.number;
            _buybackSpentThisBlock = 0;
        }
        uint256 blockCap = bnbReserve / 100;
        if (_buybackSpentThisBlock >= blockCap) return;
        (uint256 px, uint256 spot) = _refPrice();
        if (spot == 0) return;
        if (spot > (px * 102) / 100) return; // price-guard pause (px == spot when no observations: never pauses)
        uint256 spend = buybackPot;
        uint256 room = blockCap - _buybackSpentThisBlock;
        if (spend > room) spend = room;
        if (spend == 0) return;
        buybackPot -= spend;
        _buybackSpentThisBlock += spend;
        address[] memory path = new address[](2);
        path[0] = wbnb;
        path[1] = address(token);
        uint256 before = token.balanceOf(address(this));
        uint256 minOut = ((spend * 1e18) / px) * 95 / 100;
        try router.swapExactETHForTokens{value: spend}(minOut, path, address(this), block.timestamp) {}
        catch {
            buybackPot += spend;
            _buybackSpentThisBlock -= spend;
            return;
        }
        uint256 got = token.balanceOf(address(this)) - before;
        if (got > 0) require(token.transfer(DEAD, got), "burn");
        _pushObs();
        emit Buyback(spend, got);
    }

    /// @dev Liquidity add (SPEC section 3): half the LP pot buys MAO from
    /// the pool, the bought MAO pairs with the other half of the BNB, and
    /// the LP is minted to DEAD. Excess MAO from the buy (ratio drift) is
    /// burned to DEAD so no stray balance accumulates. A failed leg never
    /// reverts the caller — the BNB stays in the pot for a later attempt.
    function _tryAddLiquidity() internal {
        if (!poolOpened || lpPot == 0) return;
        uint256 amount = lpPot;
        uint256 half = amount / 2;
        if (half == 0) return;
        uint256 other = amount - half;
        (uint256 px, uint256 spot) = _refPrice();
        if (spot == 0) return;
        lpPot = 0;
        address[] memory path = new address[](2);
        path[0] = wbnb;
        path[1] = address(token);
        uint256 before = token.balanceOf(address(this));
        uint256 minOut = ((half * 1e18) / px) * 95 / 100;
        try router.swapExactETHForTokens{value: half}(minOut, path, address(this), block.timestamp) {}
        catch {
            lpPot = amount;
            return;
        }
        uint256 got = token.balanceOf(address(this)) - before;
        if (got == 0) {
            lpPot = amount;
            return;
        }
        // Pair `other` BNB with the spot-equivalent MAO; burn any excess.
        uint256 maoForPair = (other * 1e18) / spot;
        if (maoForPair > got) maoForPair = got;
        if (got > maoForPair) {
            require(token.transfer(DEAD, got - maoForPair), "burn");
        }
        token.approve(address(router), maoForPair);
        try router.addLiquidityETH{value: other}(
            address(token), maoForPair, (maoForPair * 95) / 100, (other * 95) / 100, DEAD, block.timestamp
        ) returns (uint256, uint256, uint256 liquidity) {
            emit LiquidityAdded(amount, maoForPair, liquidity);
        } catch {
            // Pairing failed after the buy leg: keep the bought MAO for
            // the next attempt by returning its BNB-equivalent value is
            // not possible — burn it instead so funds never strand, and
            // restore the unspent BNB half to the pot.
            require(token.transfer(DEAD, maoForPair), "burn");
            lpPot += other;
        }
        _pushObs();
    }

    /// @notice Plain BNB transfers are accounted (ported BNBCAT v5 fix):
    /// pre-open they credit the pool reserve, post-open the buyback pot.
    /// WBNB unwraps (this contract's own withdraw inside _openPool) and
    /// converter proceeds (the Gen 1+ conversion leg, accounted by
    /// _convertMaoLeg's caller into the pots) are already accounted by
    /// their callers and return early.
    receive() external payable {
        if (msg.sender == wbnb || msg.sender == token.converter()) return;
        if (msg.value == 0) return;
        if (poolOpened) buybackPot += msg.value;
        else reserveBNB += msg.value;
    }
}
