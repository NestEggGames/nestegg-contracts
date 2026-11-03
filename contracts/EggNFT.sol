// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

interface IMarketClear {
    function clearListingsOf(address seller) external;
}

interface ISaleDeathHook {
    function onSlotRelease(uint256 tokenId, address minter, uint8 gen) external;
}

/// @notice The burn address: dead units are transferred here (they stay
/// visible for the graveyard page but produce nothing, forever).

/// @title EggNFT — eggs and hatched animals of the Egg project.
/// @notice One ERC-721 collection. An NFT is minted as an egg (species 0)
/// and may transform in place into an animal at hatch settlement, keeping
/// its id, its mint time and all of its production state.
///
/// Production accounting lives entirely on the NFT and rides with it on
/// transfer (SPEC section 9): unclaimed MAO (`accruedStored` + live
/// accrual), the claim-pause remainder and the patience-bonus clock are
/// all per-NFT state; a sale never settles anything seller-side.
///
/// Rates (MAO/day) are LIFETIME-CONSTANT (user decision 2026-11-03 —
/// the earlier 30-day halving was removed) for every species EXCEPT
/// the phoenix, whose rate decays geometrically — ×0.8 for each full
/// 30 days since HATCHING (user decision 2026-11-03): egg 400,
/// chicken 300, duck 500, goose 700, bird 1000, phoenix 10000 at
/// hatch (→ 8000 → 6400 → 5120 → …, lifetime output ≈1,500,000 MAO),
/// empty shell 0. `mintTime` is kept as informational age only
/// (displayed as age in days); the phoenix clock runs on `hatchTime`.
/// A unit inside its post-claim 1-hour pause produces nothing; the pause
/// is encoded by pushing `lastSettle` to `pauseUntil`, so the accrual
/// integral never counts paused time.
contract EggNFT is ERC721 {
    uint8 public constant SPECIES_EGG = 0;
    uint8 public constant SPECIES_CHICKEN = 1;
    uint8 public constant SPECIES_DUCK = 2;
    uint8 public constant SPECIES_GOOSE = 3;
    uint8 public constant SPECIES_BIRD = 4;
    uint8 public constant SPECIES_PHOENIX = 5;
    uint8 public constant SPECIES_SHELL = 6; // empty shell: its animal was plundered at hatch; produces 0 forever

    uint256 public constant CLAIM_PAUSE = 1 hours;
    uint256 public constant PHOENIX_DECAY_PERIOD = 30 days; // phoenix rate step length, counted from hatching
    uint256 public constant PHOENIX_DECAY_NUM = 4; // phoenix rate multiplier per period: 4/5 = 0.8
    uint256 public constant PHOENIX_DECAY_DEN = 5;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    struct Egg {
        uint8 gen; // generation index (0-based)
        uint8 species; // 0 = unhatched egg
        address minter; // wallet that minted this unit (mint-slot owner)
        uint64 mintTime; // mint timestamp; informational age only, never changes
        uint64 hatchTime; // hatch settlement timestamp (0 while an egg); the phoenix decay clock starts here
        uint256 accruedStored; // folded, unclaimed MAO (base production)
        uint256 accruedBonus; // folded, unclaimed collection-set bonus MAO
        uint256 lifetimeProduced; // folded lifetime production (base + set bonus)
        uint64 lastSettle; // accrual clock baseline (== pauseUntil while paused)
        uint64 pauseUntil; // production paused until this time (0 = not paused)
        uint64 patienceStart; // patience-bonus clock: last claim (or mint) time
        bool hatchPending; // locked inside a pending hatch request
        bool claimPending; // locked inside a pending claim request
        bool dead; // died (claim-death): sits at DEAD, produces nothing
        bool slotHeld; // occupies its minter's generation mint slot: eggs are born holding one;
        // released exactly once (plunder-shelling, or teardown while still held);
        // plunder-born animals never hold one
    }

    address public immutable deployer;
    address public sale; // EggSale: minter, hatch transformer, claim settler
    address public market;

    uint256 public nextId;
    mapping(uint256 => Egg) internal _eggs;

    // ---- collection set bonus (SPEC section 4) ----
    // A wallet holding at least one of EACH animal species (chicken,
    // duck, goose, bird, phoenix — eggs do not count) earns +20%
    // production on ALL its units. One set per wallet, no stacking.
    // The bonus applies ONLY to production accrued while the set was
    // continuously complete: whenever a wallet's set completes or
    // breaks, every unit of that wallet is folded at the boundary, so
    // each accrual segment is crystallized with the eligibility that
    // was in force while it accrued.
    mapping(address => uint256[7]) internal _speciesCounts; // by species id (set uses 1..5; 6 = shells, bookkeeping symmetry only)
    mapping(address => uint64) public setCompleteSince; // 0 = set not complete
    mapping(address => uint256[]) internal _unitsOf; // wallet => its token ids
    mapping(uint256 => uint256) internal _unitIndex; // tokenId => index + 1 in owner's list

    // ---- plunderer registry (SPEC section 4) ----
    // The set of wallets currently holding at least one LIVE hatched
    // animal (species 1..5): the plunder candidate pool for hatch
    // settlement. Maintained on every ownership/species transition
    // (hatch transform, plundered-animal mint, transfer, teardown),
    // mirroring the BNBCAT v5 snatch candidate set: the winner is
    // derived deterministically from the settlement seed and a
    // snapshot of this list. The DEAD address is never registered
    // (dead animals rest there but are not alive holdings).
    address[] internal _holders; // wallets holding >= 1 hatched animal
    mapping(address => uint256) internal _holderIndex; // wallet => index + 1 in _holders
    mapping(address => uint256) internal _animalCounts; // wallet => live hatched animals held

    /// @dev Bring a wallet's registry membership in line with its live
    /// animal count after any change to that count.
    function _syncHolder(address w) internal {
        if (w == address(0) || w == DEAD) return;
        uint256 idx = _holderIndex[w];
        if (_animalCounts[w] > 0 && idx == 0) {
            _holders.push(w);
            _holderIndex[w] = _holders.length;
        } else if (_animalCounts[w] == 0 && idx != 0) {
            uint256 last = _holders.length - 1;
            address moved = _holders[last];
            _holders[idx - 1] = moved;
            _holderIndex[moved] = idx;
            _holders.pop();
            delete _holderIndex[w];
        }
    }

    /// @notice Size of the plunder candidate pool right now.
    function holderCount() external view returns (uint256) {
        return _holders.length;
    }

    /// @notice Live hatched animals (species 1..5) held by a wallet —
    /// its plunder-pool weight is presence, not count (one entry per
    /// wallet regardless of how many animals it holds).
    function animalCountOf(address wallet) external view returns (uint256) {
        return _animalCounts[wallet];
    }

    /// @notice Deterministic plunderer pick (BNBCAT snatch style):
    /// start at `seed % holderCount` in the registry and walk forward
    /// to the first wallet other than `exclude` that still holds a
    /// live animal. Returns address(0) when no eligible plunderer
    /// exists (empty pool, or the hatcher is the only holder) — in
    /// that case NO plunder occurs and the hatcher keeps the animal.
    function pickPlunderer(uint256 seed, address exclude) external view returns (address) {
        return _pickPlunderer(seed, exclude);
    }

    function _pickPlunderer(uint256 seed, address exclude) internal view returns (address) {
        uint256 n = _holders.length;
        if (n == 0) return address(0);
        uint256 start = seed % n;
        for (uint256 k = 0; k < n; k++) {
            address w = _holders[(start + k) % n];
            if (w != exclude && _animalCounts[w] > 0) return w;
        }
        return address(0);
    }

    /// @notice Plunder chance at hatch settlement, percent (mirrors
    /// EggSale.PLUNDER_PCT — the roll table lives here with the
    /// registry; EggSale keeps its own constant for the SPEC-facing
    /// parameter surface).
    uint256 internal constant PLUNDER_PCT = 10;

    /// @notice Hatch species for a word — ONE 9,000-point table over
    /// the five animal species (user decision 2026-11-03): chicken
    /// 3856, duck 2314, goose 1653, bird 1157, phoenix 20. The
    /// kept-species probabilities are 38.56 / 23.14 / 16.53 / 11.57 /
    /// 0.2% of all hatches; a hatched animal leaves its hatcher only
    /// through the independent plunder roll (hatchRoll), never
    /// through this table.
    function speciesForWord(uint256 word) public pure returns (uint8) {
        uint256 roll = word % 9_000;
        if (roll < 3856) return SPECIES_CHICKEN;
        if (roll < 6170) return SPECIES_DUCK;
        if (roll < 7823) return SPECIES_GOOSE;
        if (roll < 8980) return SPECIES_BIRD;
        return SPECIES_PHOENIX;
    }

    /// @notice The full hatch resolution for a word (SPEC section 4):
    /// the species the egg's animal is born as, whether the plunder
    /// roll hits, and the plunder seed (the derivation the pick walks
    /// the registry with). Species and plunder are INDEPENDENT
    /// derivations from the settlement word (mod-table vs hashed
    /// domain), so the plunder chance applies uniformly to every
    /// species — phoenix included. Settlement additionally requires
    /// an eligible plunderer to exist (pickPlunderer); with none,
    /// the animal is kept regardless of the roll.
    function hatchRoll(uint256 word) public pure returns (uint8 species, bool plunder, uint256 plunderSeed) {
        species = speciesForWord(word);
        plunderSeed = uint256(keccak256(abi.encodePacked(word, "plunder")));
        plunder = plunderSeed % 100 < PLUNDER_PCT;
    }

    event SaleSet(address sale);
    event MarketSet(address market);
    event EggMinted(uint256 indexed tokenId, address indexed to, uint8 gen);
    event EggHatched(uint256 indexed tokenId, uint8 species);
    event UnitDied(uint256 indexed tokenId, address indexed owner, address indexed minter, uint8 gen, uint8 species);
    event Plunder(uint256 indexed eggId, uint256 indexed newAnimalId, address indexed hatcher, address plunderer, uint8 species);

    modifier onlySale() {
        require(msg.sender == sale, "not sale");
        _;
    }

    constructor() ERC721("Egg", "EGG") {
        deployer = msg.sender;
    }

    function setSale(address sale_) external {
        require(msg.sender == deployer && sale == address(0) && sale_ != address(0), "sale set");
        sale = sale_;
        emit SaleSet(sale_);
    }

    function setMarket(address market_) external {
        require(msg.sender == deployer && market == address(0) && market_ != address(0), "market set");
        market = market_;
        emit MarketSet(market_);
    }

    // ---------------- rates & accrual (pure views) ----------------

    /// @notice Base daily production rate by species, in MAO wei/day.
    /// Lifetime-constant for every species except the phoenix, whose
    /// CURRENT rate decays from this base (see currentRate).
    function baseRateOf(uint8 species) public pure returns (uint256) {
        if (species == SPECIES_EGG) return 400 ether;
        if (species == SPECIES_CHICKEN) return 300 ether;
        if (species == SPECIES_DUCK) return 500 ether;
        if (species == SPECIES_GOOSE) return 700 ether;
        if (species == SPECIES_BIRD) return 1000 ether;
        if (species == SPECIES_PHOENIX) return 10000 ether;
        if (species == SPECIES_SHELL) return 0;
        return 0;
    }

    /// @notice Age of the unit in whole days since mint (informational
    /// only — age has no effect on production).
    function ageDays(uint256 tokenId) public view returns (uint256) {
        Egg storage e = _eggs[tokenId];
        if (e.mintTime == 0) return 0;
        return (block.timestamp - e.mintTime) / 1 days;
    }

    /// @notice Current daily rate. Identical to the species base rate
    /// for every species EXCEPT the phoenix: a phoenix's rate steps
    /// down ×0.8 for each full 30-day period since HATCHING
    /// (10,000 → 8,000 → 6,400 → 5,120 → …), which bounds its
    /// lifetime output at ≈1,500,000 MAO. The collection-set +20%
    /// applies on top of the decayed rate (it is computed from the
    /// accrued amounts, which already use the decayed rate).
    function currentRate(uint256 tokenId) public view returns (uint256) {
        Egg storage e = _eggs[tokenId];
        if (e.species == SPECIES_PHOENIX && e.hatchTime != 0) {
            return _phoenixRateAt(e.hatchTime, block.timestamp);
        }
        return baseRateOf(e.species);
    }

    /// @dev Phoenix rate in force at time `t`: the base rate stepped
    /// down by 0.8 once per full decay period elapsed since hatching.
    function _phoenixRateAt(uint64 hatchTime, uint256 t) internal pure returns (uint256) {
        uint256 rate = 10000 ether;
        if (t <= hatchTime) return rate;
        uint256 steps = (t - hatchTime) / PHOENIX_DECAY_PERIOD;
        for (uint256 i = 0; i < steps && rate > 0; i++) {
            rate = (rate * PHOENIX_DECAY_NUM) / PHOENIX_DECAY_DEN;
        }
        return rate;
    }

    /// @dev Accrual for a phoenix over [from, to]: walk the 30-day
    /// period boundaries so every segment accrues at its own step
    /// rate (a segment never mixes two rates).
    function _accruePhoenix(uint64 hatchTime, uint256 from, uint256 to) internal pure returns (uint256) {
        uint256 total = 0;
        uint256 t = from;
        while (t < to) {
            uint256 period = (t - hatchTime) / PHOENIX_DECAY_PERIOD;
            uint256 segEnd = hatchTime + (period + 1) * PHOENIX_DECAY_PERIOD;
            if (segEnd > to) segEnd = to;
            total += _accrue(_phoenixRateAt(hatchTime, t), t, segEnd);
            t = segEnd;
        }
        return total;
    }

    /// @dev Accrual of a constant `rate` over [from, to]: linear.
    function _accrue(uint256 rate, uint256 from, uint256 to) internal pure returns (uint256) {
        if (to <= from || rate == 0) return 0;
        return ((to - from) * rate) / 1 days;
    }

    /// @notice MAO produced and unclaimed for this NFT right now
    /// (stored + live accrual, excluding any paused time). Dead units
    /// produce nothing. Two display suppressions apply (the stored
    /// accounting underneath is untouched in both cases):
    ///  - an EMPTY SHELL shows 0 forever: the egg-phase accrual folded onto
    ///    it at hatch time is stranded — it can never be claimed — so
    ///    the view must not present it as pending (user decision
    ///    2026-11-03);
    ///  - a CLAIM-PENDING unit shows exactly the amount folded at
    ///    request time: the views are FROZEN at the request snapshot
    ///    that EggSale locked into the claim (SPEC section 5).
    function pendingOf(uint256 tokenId) public view returns (uint256) {
        Egg storage e = _eggs[tokenId];
        if (e.mintTime == 0 || e.dead) return 0;
        if (e.species == SPECIES_SHELL) return 0;
        if (e.claimPending) return e.accruedStored;
        return _pendingNow(tokenId);
    }

    /// @dev Raw pending (stored + live accrual) with NO display
    /// suppression — the accounting core the fold runs on. Internal
    /// callers (fold, lifetime) must see the true stored figures even
    /// for shells, whose public view is suppressed to 0.
    function _pendingNow(uint256 tokenId) internal view returns (uint256) {
        Egg storage e = _eggs[tokenId];
        if (e.mintTime == 0 || e.dead) return 0;
        uint256 from = e.lastSettle;
        if (block.timestamp <= from) return e.accruedStored;
        if (e.species == SPECIES_PHOENIX && e.hatchTime != 0) {
            return e.accruedStored + _accruePhoenix(e.hatchTime, from, block.timestamp);
        }
        return e.accruedStored + _accrue(baseRateOf(e.species), from, block.timestamp);
    }

    function isDead(uint256 tokenId) external view returns (bool) {
        return _eggs[tokenId].dead;
    }

    /// @notice Total MAO this unit has produced in its life (base +
    /// collection-set bonus), including the still-unclaimed part. Used
    /// by the Death event / graveyard page. Computed from the raw
    /// internals so it stays exact for shells (whose public pending
    /// views are suppressed) and adds nothing for the frozen window
    /// of a claim-pending unit (that window produces nothing).
    function lifetimeTotalOf(uint256 tokenId) public view returns (uint256) {
        Egg storage e = _eggs[tokenId];
        if (e.mintTime == 0) return 0;
        if (e.claimPending) return e.lifetimeProduced;
        return e.lifetimeProduced + (_pendingNow(tokenId) - e.accruedStored)
            + (_bonusNow(tokenId) - e.accruedBonus);
    }

    /// @notice Collection-set bonus pending for this NFT: the folded
    /// bonus plus 20% of the live accrual segment if the owner's set is
    /// currently complete (transitions fold at boundaries, so a live
    /// segment is always uniformly eligible or uniformly not). Shells
    /// display 0 and claim-pending units show the frozen
    /// request-time figure, exactly like pendingOf.
    function setBonusPendingOf(uint256 tokenId) public view returns (uint256) {
        Egg storage e = _eggs[tokenId];
        if (e.mintTime == 0) return 0;
        if (e.species == SPECIES_SHELL) return 0;
        if (e.claimPending) return e.accruedBonus;
        return _bonusNow(tokenId);
    }

    /// @dev Raw set-bonus pending with no display suppression.
    function _bonusNow(uint256 tokenId) internal view returns (uint256) {
        Egg storage e = _eggs[tokenId];
        if (e.mintTime == 0) return 0;
        uint256 bonus = e.accruedBonus;
        address owner = _ownerOf(tokenId);
        if (owner != address(0) && setCompleteSince[owner] != 0) {
            uint256 live = _pendingNow(tokenId) - e.accruedStored;
            bonus += (live * 20) / 100;
        }
        return bonus;
    }

    /// @notice Whether `wallet`'s collection set is currently complete,
    /// since when, and its per-species animal counts (species 1..5).
    function setStatusOf(address wallet)
        external
        view
        returns (bool complete, uint64 since, uint256[5] memory counts)
    {
        since = setCompleteSince[wallet];
        complete = since != 0;
        for (uint256 i = 0; i < 5; i++) counts[i] = _speciesCounts[wallet][i + 1];
    }

    /// @notice Patience-bonus multiplier (percent) earned if claimed now:
    /// 100 (<6h), 110 (>=6h), 115 (>=12h), 120 (>=24h, cap).
    function patienceMult(uint256 tokenId) public view returns (uint256) {
        Egg storage e = _eggs[tokenId];
        if (e.mintTime == 0) return 100;
        uint256 unclaimed = block.timestamp - e.patienceStart;
        if (unclaimed >= 24 hours) return 120;
        if (unclaimed >= 12 hours) return 115;
        if (unclaimed >= 6 hours) return 110;
        return 100;
    }

    /// @notice Everything the website / market must display for a listing
    /// (SPEC section 9), all read live from this NFT's state.
    function eggInfo(uint256 tokenId)
        external
        view
        returns (
            uint8 gen,
            uint8 species,
            uint64 mintTime,
            uint256 pending,
            uint256 rateNow,
            bool producing,
            uint256 pauseRemaining,
            uint256 patienceMultNow,
            uint256 unclaimedFor,
            uint256 ageInDays,
            uint256 setBonusPending,
            bool ownerSetComplete,
            bool claimPending,
            bool dead,
            uint256 lifetimeProduced
        )
    {
        Egg storage e = _eggs[tokenId];
        gen = e.gen;
        species = e.species;
        mintTime = e.mintTime;
        pending = pendingOf(tokenId);
        rateNow = currentRate(tokenId);
        producing = !e.dead && block.timestamp >= e.pauseUntil;
        pauseRemaining = e.pauseUntil > block.timestamp ? uint256(e.pauseUntil) - block.timestamp : 0;
        patienceMultNow = patienceMult(tokenId);
        unclaimedFor = e.mintTime == 0 ? 0 : block.timestamp - e.patienceStart;
        ageInDays = ageDays(tokenId);
        setBonusPending = setBonusPendingOf(tokenId);
        address owner = _ownerOf(tokenId);
        ownerSetComplete = owner != address(0) && setCompleteSince[owner] != 0;
        claimPending = e.claimPending;
        dead = e.dead;
        lifetimeProduced = lifetimeTotalOf(tokenId);
    }

    function eggOf(uint256 tokenId) external view returns (Egg memory) {
        require(_eggs[tokenId].mintTime != 0, "no egg");
        return _eggs[tokenId];
    }

    function slotHeldOf(uint256 tokenId) external view returns (bool) {
        return _eggs[tokenId].slotHeld;
    }

    function speciesOf(uint256 tokenId) external view returns (uint8) {
        return _eggs[tokenId].species;
    }

    /// @notice The wallet that minted this unit — the mint-slot owner
    /// whose per-generation slot the unit occupies while alive.
    function minterOf(uint256 tokenId) external view returns (address) {
        return _eggs[tokenId].minter;
    }

    function genOf(uint256 tokenId) external view returns (uint8) {
        return _eggs[tokenId].gen;
    }

    function claimPending(uint256 tokenId) external view returns (bool) {
        return _eggs[tokenId].claimPending;
    }

    /// @notice All live unit ids currently held by a wallet.
    function unitsOf(address wallet) external view returns (uint256[] memory) {
        return _unitsOf[wallet];
    }

    function hatchPending(uint256 tokenId) external view returns (bool) {
        return _eggs[tokenId].hatchPending;
    }

    /// @notice When this unit hatched (0 while unhatched). The phoenix
    /// decay clock runs from this timestamp.
    function hatchTimeOf(uint256 tokenId) external view returns (uint64) {
        return _eggs[tokenId].hatchTime;
    }

    // ---------------- sale-only state changes ----------------

    /// @notice Mint a fresh egg. Instant issuance: no randomness and no
    /// pending state are involved at mint (SPEC section 2 guarantee).
    function mintEgg(address to, uint8 gen) external onlySale returns (uint256 tokenId) {
        tokenId = ++nextId;
        uint64 nowTs = uint64(block.timestamp);
        _eggs[tokenId] = Egg({
            gen: gen,
            species: SPECIES_EGG,
            minter: to,
            mintTime: nowTs,
            hatchTime: 0,
            accruedStored: 0,
            accruedBonus: 0,
            lifetimeProduced: 0,
            lastSettle: nowTs,
            pauseUntil: 0,
            patienceStart: nowTs,
            hatchPending: false,
            claimPending: false,
            dead: false,
            slotHeld: true
        });
        _mint(to, tokenId);
        emit EggMinted(tokenId, to, gen);
    }

    function setHatchPending(uint256 tokenId, bool flag) external onlySale {
        _eggs[tokenId].hatchPending = flag;
    }

    /// @notice Transform an egg into its hatched outcome, in place.
    /// Accrual up to this moment is folded at the EGG's rate first, so
    /// not one second is produced at the wrong rate; mintTime is
    /// untouched. A hatched ANIMAL counts toward the owner's collection
    /// set: if this hatch completes the set, every unit of the owner is
    /// folded at the boundary first (the bonus runs only from
    /// completion onward). An empty shell (species 6) never counts toward
    /// the set and produces 0 from this moment on; its folded egg-phase
    /// accrual stays on the unit. A shell also holds NO mint slot: the
    /// egg's slot is released back to its minter here, at plunder
    /// settlement (see slotHeld).
    function transform(uint256 tokenId, uint8 species) external onlySale {
        _transform(tokenId, species);
    }

    function _transform(uint256 tokenId, uint8 species) internal {
        Egg storage e = _eggs[tokenId];
        require(e.species == SPECIES_EGG && e.hatchPending, "not a pending egg");
        address owner = _ownerOf(tokenId);
        _foldAll(owner);
        e.species = species;
        e.hatchTime = uint64(block.timestamp); // the phoenix decay clock starts at hatching
        e.hatchPending = false;
        if (species == SPECIES_SHELL && e.slotHeld) {
            // The shell keeps no slot: release the egg's generation
            // slot to its minter exactly once (slotHeld flips off, so
            // a later teardown of the shell releases nothing more).
            e.slotHeld = false;
            if (sale != address(0)) ISaleDeathHook(sale).onSlotRelease(tokenId, e.minter, e.gen);
        }
        _speciesCounts[owner][species] += 1;
        if (species >= SPECIES_CHICKEN && species <= SPECIES_PHOENIX) {
            _animalCounts[owner] += 1; // joins the plunder candidate pool
            _syncHolder(owner);
        }
        _refreshSet(owner);
        emit EggHatched(tokenId, species);
    }

    /// @notice Mint a brand-new HATCHED animal directly (the plunder
    /// path, SPEC section 4): when a hatch is plundered, the animal
    /// that came out of the egg is issued as a NEW NFT to the
    /// plunderer, while the hatched egg itself becomes an empty shell
    /// (species 6, via transform). The new animal is born fully formed
    /// at settlement: mint/hatch time = now (the phoenix decay clock
    /// runs from here), zero accrual, and its minter-of-record is the
    /// PLUNDERED EGG's original minter. It is born WITHOUT a mint slot
    /// (slotHeld = false): the egg's slot was already released to the
    /// minter when the egg shelled, so this animal's later claim-death
    /// frees nothing — one egg can never free two slots. It counts
    /// toward the plunderer's collection set and plunder-pool
    /// membership like any hatched animal.
    function mintHatchedAnimal(address to, uint8 gen, uint8 species, address minter)
        external
        onlySale
        returns (uint256 tokenId)
    {
        return _mintHatchedAnimal(to, gen, species, minter);
    }

    /// @notice Resolve a hatch settlement completely (EggSale's one
    /// call into the NFT for a settleable hatch): roll the outcome
    /// from the settlement word; on a plunder hit with an eligible
    /// plunderer, the egg becomes an EMPTY SHELL (species 6, its mint
    /// slot released to its minter by the transform) and the animal
    /// is minted as a new NFT to the plunderer, with the Plunder
    /// event emitted here; otherwise the egg transforms into the
    /// animal for its hatcher (kept). Returns the egg's SETTLED
    /// species: 6 on a plunder, the animal's species when kept — all
    /// EggSale needs for its HatchSettled event.
    function settleHatchTransform(uint256 tokenId, uint256 word) external onlySale returns (uint8 settledSpecies) {
        bool plunder;
        uint256 plunderSeed;
        uint8 animalSpecies;
        (animalSpecies, plunder, plunderSeed) = hatchRoll(word);
        if (plunder) {
            (address plunderer, uint256 newAnimalId) = _plunder(tokenId, animalSpecies, plunderSeed);
            if (plunderer != address(0)) {
                emit Plunder(tokenId, newAnimalId, _ownerOf(tokenId), plunderer, animalSpecies);
                return SPECIES_SHELL;
            }
        }
        _transform(tokenId, animalSpecies);
        return animalSpecies;
    }

    /// @dev Plunder core: draw the plunderer from the registry
    /// snapshot; on a hit, shell the egg (releasing its mint slot via
    /// the transform) and mint the animal to the plunderer (born
    /// slotless). Returns (address(0), 0) — without touching the
    /// egg — when no eligible plunderer exists.
    function _plunder(uint256 tokenId, uint8 species, uint256 pickSeed)
        internal
        returns (address plunderer, uint256 newAnimalId)
    {
        Egg storage e = _eggs[tokenId];
        require(e.species == SPECIES_EGG && e.hatchPending, "not a pending egg");
        address hatcher = _ownerOf(tokenId);
        plunderer = _pickPlunderer(pickSeed, hatcher);
        if (plunderer == address(0)) return (address(0), 0);
        uint8 gen = e.gen;
        address minter = e.minter;
        _transform(tokenId, SPECIES_SHELL);
        newAnimalId = _mintHatchedAnimal(plunderer, gen, species, minter);
    }

    function _mintHatchedAnimal(address to, uint8 gen, uint8 species, address minter)
        internal
        returns (uint256 tokenId)
    {
        require(species >= SPECIES_CHICKEN && species <= SPECIES_PHOENIX, "not an animal");
        tokenId = ++nextId;
        uint64 nowTs = uint64(block.timestamp);
        _eggs[tokenId] = Egg({
            gen: gen,
            species: species,
            minter: minter,
            mintTime: nowTs,
            hatchTime: nowTs,
            accruedStored: 0,
            accruedBonus: 0,
            lifetimeProduced: 0,
            lastSettle: nowTs,
            pauseUntil: 0,
            patienceStart: nowTs,
            hatchPending: false,
            claimPending: false,
            dead: false,
            slotHeld: false
        });
        _foldAll(to); // set-boundary discipline, same as transform
        _mint(to, tokenId);
        _speciesCounts[to][species] += 1;
        _animalCounts[to] += 1;
        _syncHolder(to);
        _refreshSet(to);
        emit EggHatched(tokenId, species);
    }

    /// @notice Mark/unmark a unit as locked inside a pending claim.
    /// Both transitions FOLD first. Marking crystallizes live accrual
    /// and set bonus into storage at the request timestamp — the
    /// exact totals EggSale just locked into the claim — and from
    /// that moment the pending views are frozen at that snapshot.
    /// Unmarking folds while still frozen (amounts cannot move; only
    /// the accrual baseline advances to the unlock moment), so on
    /// expiry the frozen amount is fully intact and growth simply
    /// resumes, and on settlement settleClaimUnit performs the final
    /// zeroing. Nothing is lost on either path.
    function setClaimPending(uint256 tokenId, bool flag) external onlySale {
        Egg storage e = _eggs[tokenId];
        require(!e.dead, "unit dead");
        _fold(tokenId);
        e.claimPending = flag;
    }

    /// @notice Finalize a settled claim for a SURVIVING unit (EggSale has
    /// already minted the locked amount to the claimer in full). The
    /// production clock restarts at settlement (SPEC section 5): the
    /// locked accrual is consumed (the request-to-settle window
    /// produced nothing — the views were frozen at the request
    /// snapshot), production pauses for 1 hour, and the patience
    /// clock restarts.
    function settleClaimUnit(uint256 tokenId) external onlySale {
        Egg storage e = _eggs[tokenId];
        require(!e.dead && e.claimPending, "no pending claim");
        _fold(tokenId); // finalizes lifetimeProduced for the whole life segment
        uint64 nowTs = uint64(block.timestamp);
        e.accruedStored = 0;
        e.accruedBonus = 0;
        e.claimPending = false;
        e.pauseUntil = nowTs + uint64(CLAIM_PAUSE);
        e.lastSettle = e.pauseUntil; // no production during the pause hour
        e.patienceStart = nowTs;
    }

    /// @dev Teardown for the claim-death path (killUnit): finalize
    /// lifetime production, detach the unit from its owner's unit
    /// list and species counts (a set it completed may break).
    /// Returns the data the caller needs for the slot hook and events.
    function _teardown(uint256 tokenId)
        internal
        returns (address owner, address minter, uint8 gen, uint8 species)
    {
        Egg storage e = _eggs[tokenId];
        require(e.mintTime != 0, "no egg");
        require(!e.dead, "already dead");
        require(!e.hatchPending, "unit hatching");
        require(!e.claimPending, "claim pending");
        _fold(tokenId);
        owner = _ownerOf(tokenId);
        minter = e.minter;
        gen = e.gen;
        species = e.species;
        _removeUnit(owner, tokenId);
        if (species != SPECIES_EGG) {
            _speciesCounts[owner][species] -= 1;
            if (species >= SPECIES_CHICKEN && species <= SPECIES_PHOENIX) {
                _animalCounts[owner] -= 1; // leaves the plunder candidate pool
                _syncHolder(owner);
            }
            _refreshSet(owner);
        }
    }

    /// @notice Kill a unit (the claim-death and refund paths, called
    /// by EggSale): the NFT is transferred to the DEAD address — it
    /// stays visible for the graveyard page but produces nothing and
    /// can never move again. EggSale is notified so the MINTER's
    /// generation slot is freed (slots follow the minter, never the
    /// current owner; sales and transfers never free slots) — but
    /// ONLY if the unit still held its slot: a shell's slot was
    /// already released at plunder settlement and a plunder-born
    /// animal never held one, so their teardowns free nothing.
    function killUnit(uint256 tokenId) external onlySale {
        (address owner, address minter, uint8 gen, uint8 species) = _teardown(tokenId);
        Egg storage e = _eggs[tokenId];
        bool held = e.slotHeld;
        e.slotHeld = false;
        e.dead = true;
        e.accruedStored = 0;
        e.accruedBonus = 0;
        e.lastSettle = uint64(block.timestamp);
        // Raw transfer to DEAD, bypassing this contract's bookkeeping
        // override (already done by hand above): DEAD gains no unit-list
        // entry and no species counts.
        super._update(DEAD, tokenId, address(0));
        if (held && sale != address(0)) ISaleDeathHook(sale).onSlotRelease(tokenId, minter, gen);
        emit UnitDied(tokenId, owner, minter, gen, species);
    }

    // ---------------- internals / transfer hooks ----------------

    /// @dev Fold live accrual into `accruedStored` and restart the accrual
    /// clock, preserving any unexpired claim pause. If the owner's
    /// collection set is currently complete, the live segment accrued
    /// under a complete set, so its +20% is crystallized into
    /// `accruedBonus` at the same moment. The fold runs on the RAW
    /// accrual (_pendingNow), never the display views, so shells
    /// fold their (zero-rate) state without underflowing. A
    /// claim-pending unit is frozen at its request snapshot: the fold
    /// moves only the accrual baseline, never the amounts.
    function _fold(uint256 tokenId) internal {
        Egg storage e = _eggs[tokenId];
        if (e.dead) return;
        if (e.claimPending) {
            uint256 startF = block.timestamp;
            if (startF < e.pauseUntil) startF = e.pauseUntil;
            e.lastSettle = uint64(startF);
            return;
        }
        uint256 pending = _pendingNow(tokenId);
        uint256 liveBase = pending - e.accruedStored;
        address owner = _ownerOf(tokenId);
        uint256 bonusPart = 0;
        if (owner != address(0) && setCompleteSince[owner] != 0) {
            bonusPart = (liveBase * 20) / 100;
            e.accruedBonus += bonusPart;
        }
        e.lifetimeProduced += liveBase + bonusPart;
        e.accruedStored = pending;
        uint256 start = block.timestamp;
        if (start < e.pauseUntil) start = e.pauseUntil;
        e.lastSettle = uint64(start);
    }

    /// @dev Fold every unit of a wallet (used at set complete/break
    /// boundaries so segments are crystallized with the eligibility in
    /// force while they accrued).
    function _foldAll(address wallet) internal {
        uint256[] storage units = _unitsOf[wallet];
        for (uint256 i = 0; i < units.length; i++) {
            _fold(units[i]);
        }
    }

    /// @dev Re-evaluate a wallet's set completeness after a species
    /// count change. Callers fold first, so the timestamp starts a
    /// clean bonus segment.
    function _refreshSet(address wallet) internal {
        bool complete = _speciesCounts[wallet][1] > 0 && _speciesCounts[wallet][2] > 0
            && _speciesCounts[wallet][3] > 0 && _speciesCounts[wallet][4] > 0
            && _speciesCounts[wallet][5] > 0;
        if (complete && setCompleteSince[wallet] == 0) {
            setCompleteSince[wallet] = uint64(block.timestamp);
        } else if (!complete && setCompleteSince[wallet] != 0) {
            setCompleteSince[wallet] = 0;
        }
    }

    function _addUnit(address wallet, uint256 tokenId) internal {
        _unitsOf[wallet].push(tokenId);
        _unitIndex[tokenId] = _unitsOf[wallet].length;
    }

    function _removeUnit(address wallet, uint256 tokenId) internal {
        uint256 idx = _unitIndex[tokenId];
        if (idx == 0) return;
        uint256[] storage units = _unitsOf[wallet];
        uint256 last = units[units.length - 1];
        units[idx - 1] = last;
        _unitIndex[last] = idx;
        units.pop();
        delete _unitIndex[tokenId];
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            // Locked units cannot move: an egg inside a pending hatch
            // (SPEC section 4), any unit inside a pending claim
            // (section 5), and dead units (they rest at DEAD forever).
            require(!_eggs[tokenId].hatchPending, "egg hatching");
            require(!_eggs[tokenId].claimPending, "claim pending");
            require(!_eggs[tokenId].dead, "unit dead");
            // Accrual rides with the NFT: folding is pure bookkeeping —
            // amounts, patience progress and pause remainder are unchanged.
            _fold(tokenId);
            uint8 species = _eggs[tokenId].species;
            if (species != SPECIES_EGG) {
                // A set boundary may be crossed for BOTH wallets: fold
                // all their units with the pre-change eligibility, then
                // move the species count and re-evaluate.
                _foldAll(from);
                _foldAll(to);
                _speciesCounts[from][species] -= 1;
                _speciesCounts[to][species] += 1;
                if (species >= SPECIES_CHICKEN && species <= SPECIES_PHOENIX) {
                    // Plunder-pool membership rides with the animal.
                    _animalCounts[from] -= 1;
                    _syncHolder(from);
                    _animalCounts[to] += 1;
                    _syncHolder(to);
                }
                _refreshSet(from);
                _refreshSet(to);
            }
            _removeUnit(from, tokenId);
            _addUnit(to, tokenId);
        } else if (to != address(0)) {
            _addUnit(to, tokenId); // mint
        } else if (from != address(0)) {
            _removeUnit(from, tokenId); // burn (no burn path exists today; kept symmetric)
        }
        return super._update(to, tokenId, auth);
    }

    // Revoking the market's approval clears that seller's listings at once
    // (ported from BNBCAT Animals).
    function approve(address to, uint256 tokenId) public override {
        address mkt = market;
        address prevApproved = getApproved(tokenId);
        super.approve(to, tokenId);
        if (mkt != address(0) && prevApproved == mkt && getApproved(tokenId) != mkt) {
            IMarketClear(mkt).clearListingsOf(_ownerOf(tokenId));
        }
    }

    function setApprovalForAll(address operator, bool approved) public override {
        super.setApprovalForAll(operator, approved);
        if (market != address(0) && operator == market && !approved) {
            IMarketClear(market).clearListingsOf(msg.sender);
        }
    }
}
