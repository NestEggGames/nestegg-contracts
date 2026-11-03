# 蛋 (Egg) / 毛 (MAO) — Build Notes

Contract package for the 蛋 project (token 毛 / MAO) on BSC, built to
`SPEC.md` (the source of truth — every parameter below traces to it).
Prepared for external review. **Not deployed.** No real keys exist in
this package; the project wallet is a constructor parameter everywhere.

## How to build and test

```
npm install
npx hardhat test                                   # unit suite (mocks): 97 tests — 96 passing in-process; the 100,000-egg cap test is verified via scripts/verify-cap-anvil.js on this VM (see Test inventory environment note)
npx hardhat test --config hardhat.fork.config.js   # fork suite (real BSC): 7 passing
```

Toolchain: Hardhat, solc 0.8.28, viaIR, cancun EVM. Fork config pins
BSC block **131355494** via `https://bsc-rpc.publicnode.com`
(override with `BSC_FORK_RPC` / `BSC_FORK_BLOCK`).

## Architecture map (SPEC section → code)

| SPEC | Where | Key functions |
| --- | --- | --- |
| §1 System shape, burn address | all contracts | `DEAD = 0x0000…dEaD` constant in MaoToken / EggNFT / EggSale |
| §2 Sale, ladder, idle decay, slots, failed-launch refund | `EggSale` | `mint`, `quoteMint`, `currentPriceUsd`, `_simulate`, `onSlotRelease`, `slotsUsed`, `refundEggs`, `refundableOf`, `refundAvailable`, `projectDue` |
| §2 Agent ID gate + welding | `EggSale._gate` | registry `balanceOf`/`handleOf`, `agentKeyOf`, `walletOfAgent` |
| §3 Pool open, buyback, LP adds, anti-snipe latch | `EggSale` + `MaoToken` | `_openPool`, `buyback`, `addLiquidity`, `_tryBuyback`, `_tryAddLiquidity`, `pokePrice`, `MaoToken.notifyPoolOpened`, `MaoToken.inSnipeWindow` |
| §4 Hatch + species table | `EggSale` + `EggNFT` | `requestHatch`, `captureReqSeed(false,…)`, `settleReq(false,…)`, `expireReq(false,…)`, `reqWord`, `speciesForWord`, `hatchRoll`, `EggNFT.transform` |
| §4 Collection set bonus | `EggNFT` | `setStatusOf`, `setBonusPendingOf`, fold-at-transition (`_fold`, `_foldAll`, `_refreshSet`) |
| §5 Claims (two-step, request-time freeze) + claim-death | `EggSale` + `EggNFT` | `requestClaim`, `captureReqSeed(true,…)`, `settleReq(true,…)`, `expireReq(true,…)`, `claimDeathRoll`, `EggNFT.settleClaimUnit`, `EggNFT.killUnit`, `EggNFT.setClaimPending` (fold-and-freeze) |
| §6 Generations + MAO ladder + 90/10 conversion | `EggSale` + `MaoConverter` | `GEN_MAO_LADDER`, `quoteMint`, `currentPriceMao`, rollover in `mint`, `_convertMaoLeg` → `MaoConverter.swapMaoToBnb` |
| §7 Trading tax + anti-snipe window | `MaoToken` | `_update` tax split vs the official pair; `setSystem` / `setConverter` exemptions; window branch (cap + 10% burn) in the same `_update` |
| §8 Supply cap | `MaoToken` | `HARD_CAP`, `circulating`, `headroom`, `mint` (system-only) |
| §9 Website data surface | `EggNFT` | `eggInfo`, `pendingOf`, `setBonusPendingOf`, `unitsOf`, `eggOf` |
| §9 Market | `EggMarket` | `list`, `buy`, `cancel`, `cleanListing`, `clearListingsOf` |
| §5/§9 Graveyard | `EggSale` + `EggNFT` | `Death` event, `EggNFT.lifetimeTotalOf`, dead units rest at DEAD |
| §10 Future add-ons | — | **Removed 2026-11-03 (decision 17)**: the add-on hook was deleted outright; no extension surface ships in v1 |

Contracts: `MaoToken.sol` (ERC20), `EggNFT.sol` (ERC721 + production
accounting), `EggSale.sol` (sale / pool / hatch / claims / refund),
`EggMarket.sol` (listings), `MaoConverter.sol` (stateless MAO→BNB
swap leg for the Gen 1+ mint split — extracted from EggSale under
EIP-170 pressure, decision 17), `Interfaces.sol` (external interfaces),
`contracts/mocks/Mocks.sol` (test doubles only).

## Parameter table (as implemented)

| Parameter | Value |
| --- | --- |
| Token | name `毛`, symbol `MAO`, 18 decimals (asserted by test) |
| Hard cap | 3,000,000,000 MAO on **circulating** supply (see decision 1) |
| Trading tax | 2% vs pair each side, symmetric (change A): buys 1% to DEAD + 1% to project wallet; sells 1% to DEAD + 1% to project wallet; transfers untaxed. Per-side splits are named constants (`BUY_BURN_BPS`/`BUY_PROJECT_BPS`/`SELL_BURN_BPS`/`SELL_PROJECT_BPS`, all 100) |
| Anti-snipe window (H2) | First 5 blocks from the pool-open block (`block.number < poolOpenBlock + 5`, ≈2.3 s on BSC): pair buys capped at 200,000 MAO cumulative per wallet (`SNIPE_WALLET_CAP`, gross), buy tax 10% ALL burned (`SNIPE_BUY_BURN_BPS`); sells unchanged; system/converter/pair/DEAD/project exempt |
| Ladder (Gen 0, USD) | $2 × #1–1,000 / $3 × #1,001–3,000 / $4 × #3,001–6,000 / $5 × #6,001–10,000 |
| Ladder (Gen 1+, MAO) | 800 / 1,200 / 1,600 / 2,000 MAO on the same segments (`GEN_MAO_LADDER`) |
| Gen 1+ mint split (change B) | 90% of each MAO payment burned to DEAD (`GEN_MAO_BURN_BPS = 9000`); 10% (`GEN_MAO_SWAP_BPS = 1000`) swapped MAO→BNB via `MaoConverter` at minOut = 95% of the observation-average price (spot if none); received BNB splits half buyback pot / rest LP pot; ANY swap failure burns the leg instead (mint never reverts on it). Per full generation: 14,400,000 burned / 1,600,000 converted; project receives NO MAO from Gen 1+ mints |
| Gen size / pool trigger | 10,000 per generation; pool opens inside Gen 0 egg #5,000's mint |
| Generation cap | 10 generations total — Gen 0..Gen 9 (`MAX_GENERATION = 9`) = 100,000 eggs; when Gen 9 sells out, `saleFinished` latches and minting ends permanently |
| Pool open | anchor $0.0015; seed = reserve USD ÷ 0.0015, capped at 10,000,000 MAO; LP to DEAD |
| Fund split (Gen 0) | 20% project / 80% reserve; post-open reserve splits 50% buyback pot / 50% LP pot. Timing (change I): pre-open the 20% leg is ESCROWED in the sale as `projectDue` (not paid out) and released to the project wallet inside the pool-open transaction; post-open Gen 0 mints pay it immediately |
| Failed-launch refund (change I) | If the pool has not opened by `refundDeadline = startTime + 7 days` (deploy time when startTime = 0): minting closes permanently ("sale failed"), and any alive Gen 0 unit — egg, animal, or empty shell — can be surrendered via `refundEggs` for exactly the net BNB recorded for it at mint (per-egg records apportion the batch's net kept BNB by charged USD, remainder to the last egg; a batch's records sum EXACTLY to its net paid). Unit dies via `killUnit` (slot freed only if the unit still held one — a shell's slot was already released at plunder; counters decremented); projectDue is never released in the failed state |
| Buyback guards | skip if spot > 1h average × 1.02; per-block spend cap = 1% of pair BNB reserve; minOut = 95% of average; bought MAO to DEAD |
| Mint caps | per-**wallet** mint-slots per generation are the ONLY mint-count limit: 10 in Gen 0, 20 in Gen 1+ (`MAX_PER_GEN_GEN0/LATER` via `maxPerGen`, FINAL). **No per-transaction cap** — one mint may take any count from 1 up to the wallet's remaining cap (the website's 1/5/10/20 buttons are front-end presets, not a contract rule). Slot rule: decision 8 |
| Idle decay | 5 min without a mint in the current tier → effective price steps down one tier (floor = tier 1); mint does not restore; crossing into the next tier resets to full price. Applies to both ladders |
| Rates | egg 400 / chicken 300 / duck 500 / goose 700 / bird 1,000 / empty shell 0 MAO per day, lifetime-constant; **phoenix exception**: 10,000 at hatch, ×0.8 per full 30 days since hatching (geometric; lifetime output ≈1,500,000 MAO) |
| Hatch table (one 9,000-point roll) + plunder | chicken 3856 / duck 2314 / goose 1653 / bird 1157 / phoenix 20 over 9,000 (kept-species probabilities identical to the old 10,000-point table: 38.56 / 23.14 / 16.53 / 11.57 / 0.2%); INDEPENDENT 10% plunder roll on top (`PLUNDER_PCT`) — see the Plunder row; EV ≈ 483/day |
| Plunder + empty shell | Independent 10% roll at hatch settlement (`PLUNDER_PCT`): on a hit with ≥1 eligible plunderer (another wallet holding a live hatched animal; EggNFT holder registry, BNBCAT-snatch-style deterministic pick), the egg transforms in place into species 6 = EMPTY SHELL — 0 production forever, persists as a normal transferable NFT (NOT market-listable); no burn, no graveyard entry, never claims, never counts toward the set — and a NEW NFT (next id; rolled species; egg's generation; minter-of-record = the egg's original minter; born at settlement) is minted to the plunderer. No eligible plunderer → no plunder, hatcher keeps the animal. Slots: the shell holds NO slot — the egg's slot is released to its minter at plunder settlement, and the plunder-born animal is born slotless, so its claim-death and the shell's later refund free nothing (one egg frees at most one slot). Supply: each plunder creates one extra animal (~+10% animals; NFT total can reach ~110,000 while eggs stay capped at 100,000) |
| Hatch seed | blockhash of request block + 5; capture window 256 blocks; expired-uncaptured → free close-out + 24h re-hatch cooldown, egg keeps producing |
| Set bonus | +20% production on all of a wallet's units while it holds ≥1 of each animal species; one set, no stacking; only on accrual while continuously complete |
| Patience bonus (at claim **request**) | ≥6h → +10% / ≥12h → +15% / ≥24h → +20% (cap); no minimum claim interval exists |
| Claim pause | 1 hour after a settled claim (survivors only) |
| Claim-death | flat 20% per settled claim; eggs + chicken/duck/goose/bird; **phoenix never rolls**; shells never claim, so never roll |
| Death causes (weights) | 0 tired out 30% / 1 choked on feathers 30% / 2 overate 20% / 3 passed in sleep 15% / 4 lightning 5% |
| Market fee | 2.5% to project wallet (`MARKET_FEE_BPS = 250`) |
| Settlement | piggyback up to 4 hatches + 4 claims per user call; `settleBacklog(n)` sweeps both queues |

## Implementation decisions where the SPEC left a choice

1. **Cap accounting.** Burns are ordinary transfers to DEAD (SPEC §1:
   the public burned counter is DEAD's MAO balance), and §6 requires
   burns to free production headroom. Both hold only if the cap binds
   the *circulating* supply: `circulating() = totalSupply() −
   balanceOf(DEAD)`, `headroom() = HARD_CAP − circulating()`. Minting
   reverts rather than letting circulating exceed 3B.
2. **Claim settlement at the cap.** SPEC §5 says the locked amount is
   minted *in full* — death never touches it. So if headroom is short
   at settle time, the settle transaction reverts and the claim simply
   stays pending (nothing is consumed, no roll is lost); burns free
   headroom over time and any later settle pays in full. (An earlier
   synchronous design paid pro-rata; the adopted two-step design
   supersedes it.)
3. **Claim expiry is lossless and has no cooldown** — deliberately
   different from hatch expiry. A hatch expiry needs the 24h cooldown
   because the egg's *outcome* was at stake; a claim locks only an
   amount, and once the seed blockhash is gone the death roll can
   never be computed by anyone, so there is nothing to fish for:
   `expireClaim` just unlocks the unit with accrual and patience
   untouched, and the owner may re-request immediately.
4. **Hatch ↔ claim mutual lock.** A unit may have at most one pending
   operation: claim requests reject hatching units and hatch requests
   reject claim-pending units (the death teardown requires a
   non-hatching unit; the hatch transform requires an unlocked egg).
5. **Death moves the NFT to DEAD; it is not burned** (SPEC §5: "NFT
   转黑洞地址"). The unit's state is frozen (`dead` flag, production
   zeroed) so the graveyard page can read species/age/lifetime from
   the NFT and the `Death` event. (`killUnit` is also the teardown
   the failed-launch refund uses, decision 17.)
6. **Settle bounty: CUT — not implemented** (user decision
   2026-11-03). No escrow, no `addBounty`, no bounty fields anywhere;
   hatch/claim functions are non-payable in value terms. Reasoning:
   ordinary holders don't know what a bounty is and shouldn't need a
   new concept to hatch an egg; the BNBCAT settlement outage that
   motivated the idea was a keeper balance/stop-line failure, not a
   missing-incentive failure (settlement was always permissionless).
   Reliability rests on seed capture + piggybacking + owner
   self-settle + one project backstop keeper. If congestion ever
   appears, a bounty can be added as an *external* add-on; it does not
   belong in the core contracts. The discovery surface is kept:
   `HatchRequested` / `ClaimRequested` events, `pendingReqs`,
   `reqOf`, `reqState` (the unified hatch/claim request API,
   decision 17).
7. **`GEN_MAO_LADDER` is a pure function, not an array constant** —
   Solidity has no constant arrays. It is the single place the four
   Gen 1+ prices live. A full Gen 1+ generation charges exactly
   16,000,000 MAO (1000×800 + 2000×1200 + 3000×1600 + 4000×2000),
   split 90% burned / 10% converted to BNB (decisions 13, 18).
8. **Mint slots (BNBCAT pen semantics).** The per-generation cap
   counts *alive self-minted* units: `slotsUsed[minter][gen]`. It is
   10 in Gen 0 and 20 in Gen 1+ (`MAX_PER_GEN_LATER`, FINAL per the
   user's last word). There is no per-transaction cap on top of it:
   a mint's count is bounded only by the wallet's remaining slots.
   `EggNFT` records each unit's original `minter`; on death/burn the
   NFT calls `EggSale.onUnitDeath`, freeing the **minter's** slot for
   that generation regardless of who owned the unit. Sales/transfers
   never free slots. `totalMintedInGen` is a monotonic informational
   counter.
9. **Future add-on hook (SPEC §10) — SUPERSEDED by decision 17.**
   Fusion / recycle / sacrifice / duels are **not** built. The hook
   that once let the deployer authorize an add-on contract
   (`setAddonAuthorized` / `burnUnit` / `transformUnit`) was first
   frozen at pool open (decision 16) and then **deleted outright**
   in the 2026-11-03 review round: v1 has no add-on to authorize,
   and the hook was the system's only standing deployer power.
10. **Set bonus mechanics.** Implemented as fold-at-transition
    segmentation: whenever a wallet's set completes or breaks, all its
    units are folded, crystallizing each accrual segment with the
    eligibility in force while it accrued. Claim composition is
    (base + setBonus) × patience multiplier; the multiplier is priced
    at claim **request** time and locked with the amount.
11. **EggNFT identity.** SPEC names only the token; the NFT collection
    is `Egg` / `EGG` (constructor constants in `EggNFT`). Flagged here
    in case the user wants different collection naming before launch.
12. **`spotPrice()` is informational only.** Since the Gen 1+ MAO
    ladder replaced the spot-priced leg, no mint pricing reads spot;
    the buyback guard uses the 1h observation average (`pokePrice`,
    one observation per block). It was made `internal` in the
    decision-18 size trims — the website reads pair reserves
    directly for price display.
13. **Generation cap, Gen 1+ skim, per-gen mint caps, buy-tax burn
    (user decisions 2026-11-03, post-delivery amendment).**
    Generations are capped: `MAX_GENERATION = 9` — Gen 0..Gen 9,
    10,000 eggs each, 100,000 eggs ever. When the final generation
    sells out, the rollover latches `saleFinished` instead of
    advancing; `genSold` stays at `GEN_SIZE` so the finished state
    reads clean, the price views return 0, and `mint` reverts with
    "sale finished" forever. Gen 1+ MAO payments originally split
    1% to the project wallet / 99% burned — **superseded by
    decision 17** (90% burned / 10% converted to BNB for the pots,
    no project MAO). The per-wallet per-generation slot
    cap (via `maxPerGen`) is 10 in Gen 0 (`MAX_PER_GEN_GEN0`) and 20
    in Gen 1+ (`MAX_PER_GEN_LATER`, FINAL). It is the ONLY
    mint-count limit: a separate per-transaction cap that existed
    mid-amendment was folded away on the user's final word — a mint
    may take any count from 1 up to the wallet's remaining cap in a
    single transaction (the 1/5/10/20 figures are website
    quick-select presets). The buy-side trade tax was 2% all-burn
    under this decision — **superseded by decision 17** (buy tax is
    now 1% burn / 1% project, symmetric with the sell side).
14. **Phoenix rebalance (user decision 2026-11-03, post-delivery
    amendment).** Phoenix probability is 20 points on the species
    table = 0.2% of ALL hatches (≈20 phoenixes per fully-hatched
    generation), and the phoenix daily rate is 10,000 MAO/day at
    hatch — a jackpot slot (decaying thereafter — decision 15).
    The species table's weights keep the four animals in their
    inverse-to-rate proportions (chicken 3856 / duck 2314 / goose
    1653 / bird 1157; the table itself is specified in decision 18).
    Phoenix still never rolls claim-death and still completes the
    collection set as the fifth species. Hatch EV ≈ 483/day.
15. **Phoenix decay (user decision 2026-11-03, post-delivery
    amendment).** The phoenix is the single exception to
    lifetime-constant rates: every full 30 days since HATCHING its
    daily rate multiplies by 0.8 (10,000 → 8,000 → 6,400 → 5,120 →
    …, `PHOENIX_DECAY_PERIOD` / `PHOENIX_DECAY_NUM` /
    `PHOENIX_DECAY_DEN` in EggNFT), bounding one phoenix's lifetime
    output at ≈1,500,000 MAO (10,000 × 30 × 1/(1−0.8)). Roughly 200
    phoenixes are expected across all 10 generations, a permanent
    but decaying emission anchor inside the 3B cap. Implementation:
    `Egg.hatchTime` is stamped at hatch settlement
    (`EggNFT.transform`; exposed as `hatchTimeOf`); `pendingOf`
    integrates a phoenix's accrual by walking the 30-day boundaries
    so no accrual segment ever mixes two rates; `currentRate`
    reports the step in force now. Everything downstream (claim
    locking, the collection-set +20%, lifetime totals) reads
    `pendingOf`, so bonuses and claims automatically use the
    decayed rate. All other species are untouched.
16. **Privilege freeze at pool open (user decision 2026-11-03,
    post-delivery amendment) — SUPERSEDED by decision 17.** "池子一开就丢权限" —
    the moment the pool opens, all standing deployer power dies.
    This decision first made `EggNFT.setAddonAuthorized` (the
    package's only standing deployer power) revert after the open,
    freezing the authorization set. The review round that followed
    deleted the hook entirely instead (decision 17), which reaches
    the same end state more strongly: after deploy wiring, no
    standing deployer power exists anywhere, at any time. Full
    inventory: the Privilege audit section.

17. **Review-round change package A–I + H2 (user decisions
    2026-11-03, post-delivery).** One coordinated revision:
    **(A)** buy tax is now 1% burn / 1% project (symmetric with
    sells); **(B)** the Gen 1+ mint split is 90% burned / 10%
    swapped MAO→BNB into the buyback/LP pots (minOut 95% of the
    observation average; any failure burns the leg — a mint can
    never revert on the conversion); **(C)** the §10 add-on hook is
    DELETED (supersedes decisions 9 and 17); **(D)** LP adds carry
    95% minimums on both legs; **(E)** shells display
    `pendingOf` / `setBonusPendingOf` = 0 (their stranded egg-phase
    accrual stays in storage, invisible and unclaimable — the raw
    helpers `_pendingNow` / `_bonusNow` keep the internal math
    exact); **(F)** claim views FREEZE at the request-time snapshot
    (`setClaimPending(true)` folds first, so the frozen views equal
    the locked amount exactly; expiry unfreezes losslessly);
    **(H2)** anti-snipe: the first 5 BLOCKS from the open block
    (the user rejected a 30-minute window — sniping is a same-block
    game), pair buys capped at 200,000 MAO cumulative per wallet
    with a 10% all-burn buy tax; **(I)** failed-launch refund +
    project-leg escrow (SPEC §2; known accepted edges: MAO already
    claimed pre-open is NOT clawed back — it has no pool and no
    price before the open; refunding a market-listed unit leaves a
    zombie listing, clearable via `cleanListing`, the same wart
    BNBCAT carries; unclaimed accrual dies with the surrendered
    unit). Two engineering notes: (1) the swap leg lives in a
    separate stateless `MaoConverter` contract because EggSale hit
    the EIP-170 limit — the token treats the converter as a system
    address for tax purposes (without that, the converter's leg
    into the pair would be sell-taxed and the real router's K-check
    would fail), and EggSale skips converter-sourced BNB in
    `receive()` because `mint` accounts it. That tax exemption is
    exactly why the converter is SALE-ONLY (`swapMaoToBnb` requires
    the wired EggSale as caller, latched once by `setSale`): a
    public tax-exempt swap entry would be a tax-free sell rail
    bypassing the 2% sell tax — this hole was caught in review of
    this round and closed before delivery. (2) The twelve paired hatch/claim
    externals were unified into one `req*` API (`captureReqSeed` /
    `reqWord` / `settleReq` / `expireReq` / `reqState` / `reqOf` /
    `reqQueueLength` / `pendingReqs`, keyed by an `isClaim` flag),
    and several internal-only getters were internalized — together
    with the converter extraction these trims brought EggSale from
    26,685 B back under the limit (see Sizes).

18. **Revision round 3: plunder + 5-minute idle decay +
    animals-only market (user decisions 2026-11-03,
    post-delivery).** Four changes:
    **(a) PLUNDER.** The species roll uses a 9,000-point table
    in EggNFT (`speciesForWord`: chicken 3856 / duck 2314 / goose
    1653 / bird 1157 / phoenix 20) — kept-species probabilities
    are 38.56 / 23.14 / 16.53 / 11.57 / 0.2% of all hatches. A
    second, independent roll (`hatchRoll`: keccak domain
    separation) hits 10% (`PLUNDER_PCT`, mirrored in EggSale for
    the parameter surface). On a hit, EggNFT's holder registry —
    wallets holding ≥1 live hatched animal, maintained on hatch /
    plunder-mint / transfer / teardown, BNBCAT-snatch style —
    picks a plunderer deterministically from the settlement seed
    (start at `seed % count`, walk forward, hatcher excluded). The
    egg transforms in place into species 6 = EMPTY SHELL
    (0 production, pending views 0, never claims, never
    claim-dies, no set credit, transferable — but NOT
    market-listable, see (c)); the animal is minted as a NEW NFT
    to the plunderer with the egg's generation and the egg's
    ORIGINAL minter as minter-of-record, born at settlement time.
    Empty registry → no plunder, the hatcher keeps the animal (the
    first hatch of the system can never be plundered). The whole
    resolution runs inside EggNFT (`settleHatchTransform`, one
    call from `EggSale._settleHatch`) — it emits the `Plunder`
    event itself and returns only the egg's settled species (6 on
    a plunder), keeping EggSale's settlement path one call thin;
    `HatchSettled` carries that settled species.
    **(b) SHELL SLOT RULE (user correction 2026-11-03).** A shell holds NO mint
    slot: EggNFT tracks `slotHeld` per unit (eggs are born holding
    one; plunder-born animals are born without one), and the
    EggSale slot hook — renamed `onUnitDeath` → `onSlotRelease` —
    fires exactly once per unit: at plunder settlement when the
    egg shells, or at `killUnit` teardown for a unit that still
    holds its slot. Consequences, all pinned by tests: the
    minter's quota is restored at plunder (can mint a full batch
    again while the generation sells); a plunder-born animal's
    claim-death frees NOTHING; a shell's failed-launch refund
    frees NOTHING extra. One egg can never free two slots.
    **(c) MARKET: animals only.** `EggMarket.list()` requires
    species 1..5 ("not an animal"), checked after the existing
    hatch/claim-pending guards: unhatched eggs and empty shells
    can NOT be listed; plain wallet-to-wallet transfers of eggs
    and shells remain unrestricted.
    **(d) IDLE DECAY 30 → 5 MINUTES.** `IDLE_WINDOW = 5 minutes`;
    every other ratchet semantic unchanged (floor tier 1, a mint
    does not restore the price, tier crossings reset to full).
    Supply note: plunder creates ≈10% more animals than a
    no-plunder baseline (each plunder is one extra NFT; eggs stay
    capped at 100,000, NFT supply can reach ≈110,000).
    Size: EggSale lands at 24,335 B (241 B spare) — achieved by
    keeping the delivered layout and the thin delegation above;
    structural refactors (moving roll functions between contracts,
    unifying the piggyback loops) were measured to GROW the viaIR
    output and were reverted. EggNFT grows to 16,345 B (registry +
    slot flag + plunder mint), EggMarket to 4,796 B (listability
    guard).
    Test scope (user instruction 2026-11-03): only the changed
    areas were re-run — hatch (plunder/shell/registry/slots),
    market (listability), refund (shell refundability), mint +
    scoped gen (5-minute decay, slot hook). Suites over untouched
    mechanisms (token taxes/anti-snipe, converter latch, pool-open
    internals, claim math, generation sellout) were NOT re-run.

## Two bugs the test process caught (both fixed, both instructive)

- **Tier-boundary decay erasure.** When a batch ended *exactly* on a
  tier boundary (e.g. genSold = 1,000), the stored tier state still
  described the old tier, so the next quote's tier walk treated the
  first egg of the new tier as a fresh crossing and reset the
  effective price to full — erasing idle decay the new tier had
  accrued. Fix: `mint` commits a pending boundary crossing eagerly
  (at full price, clock = that mint), so stored tier state always
  describes the *next* egg. Covered by `mint.test.js` decay tests and
  the Gen 1 ladder/decay test.
- **Fork LP-add minOut vs pool size.** On the fork, the LP piggyback
  initially no-opped: the counter fast-forward left a ~0.1 BNB pool,
  so the LP buy leg's price impact (~15%) exceeded its 95%-of-TWAP
  `minOut` and the guarded swap correctly refused (pot retained,
  retried next mint — the designed behavior). The fork test now funds
  a realistic 20 BNB reserve pre-open, and the LP add executes against
  the real router. Worth knowing for launch: on a real-sized pool
  this guard is a safety pause, not a blocker; pots are never
  stranded.

## Emission note — expected production under claim-death

Survival is geometric: each settled claim independently kills a
non-phoenix unit with p = 0.2, so a unit lives through an expected
**5 claim cycles** (the 5th, on average, is fatal) regardless of claim
frequency. Lifetime production is therefore behavior-dependent:
cycles are fixed in expectation, but the production *per cycle* is
the rate × time between claims × that cycle's patience multiplier.

Daily-claim scenario (claim every ~24h: each cycle produces 1 day at
the species rate and locks the +20% patience tier):

| Unit | Per cycle | Expected lifetime (≈5 cycles) | Expected lifespan |
| --- | --- | --- | --- |
| Egg | 400 × 1.2 = 480 | ≈ 2,400 MAO | ≈ 5 days |
| Chicken | 300 × 1.2 = 360 | ≈ 1,800 MAO | ≈ 5 days |
| Duck | 500 × 1.2 = 600 | ≈ 3,000 MAO | ≈ 5 days |
| Goose | 700 × 1.2 = 840 | ≈ 4,200 MAO | ≈ 5 days |
| Bird | 1,000 × 1.2 = 1,200 | ≈ 6,000 MAO | ≈ 5 days |
| Phoenix | 2,000 × 1.2 = 2,400 | **unbounded — never dies** | unbounded |

Claiming more often (e.g. every 6h at +10%) keeps the same expected
5 cycles but compresses them into ~30 hours and cuts per-cycle
production, so expected lifetime falls to ≈ 1.4× the daily rate.
Never claiming means never dying but also never realizing anything.
All production — base, set bonus and patience bonus — draws from the
same 3B circulating cap (decision 1).

## Test inventory and results

Unit suite (mocks), **final verification (decision-18 round):
96 of 97 passing in-process, 0 failing; the remaining test (the
100,000-egg generation-cap sellout) stands verified end-to-end
via the anvil driver from the v2 round — see the environment note
after this list**:

- `token.test.js` — identity (name 毛 / symbol MAO asserted), cap +
  burn-frees-headroom, CREATE2 pair prediction, pre-open pair gate,
  buy tax 1% burn + 1% project / sell tax 1% + 1% (change A);
  anti-snipe window (H2): in-window buy pays 10% all to DEAD with
  the project at 0 and the gross tracked in `boughtInWindow`,
  cumulative buys past 200,000 MAO from the pair revert ("snipe
  cap"), from block poolOpenBlock + 5 the normal split applies
  with no cap and no tracking.
- `mint.test.js` — gate (no ID / empty handle / welded handle),
  instant issuance, quotas, USD ladder boundaries, 20/80 split +
  refund, idle-decay ratchet (step-down, floor, no restore, crossing
  reset, straddle batch).
- `pool.test.js` — pool open inside the trigger mint (seed size,
  anchor ratio, LP to DEAD, `poolOpenBlock` latched on the token),
  buyback guards, LP adds, `pokePrice` once-per-block. (The
  privilege-freeze describe was removed with the hook it tested,
  change C.)
- `claim.test.js` — two-step claims: amount locked at request, paid
  in full at settle (even on death), views FROZEN at the request
  snapshot while pending (change F: warp 6h, views unchanged to the
  wei, settle pays the locked amount, accrual resumes after the
  pause), pause + clock restart at settle,
  patience tiers priced at request, zero-claim no-op, batch/foreign
  units, pending-unit locks, death loop (payment + NFT to DEAD +
  Death event + slot freed), phoenix immunity over 12 cycles,
  death-roll purity scan (20% band, all 5 causes), seed capture past
  the 256-block cliff, lossless expiry, cap-revert-then-pay-in-full,
  piggyback settlement by an unrelated mint.
- `hatch.test.js` — hatch lifecycle, seed capture, expiry + cooldown,
  9,000-table boundaries of `speciesForWord` plus an exhaustive
  9,000-roll census (chicken 3856 / duck 2314 / goose 1653 / bird
  1157 / phoenix 20) and a `hatchRoll` distribution census (plunder
  flag ≈10% of words, across every species), outcome validity over
  many hatches (no specific-outcome assertions); plunder + shell:
  the egg shells in place and a NEW animal NFT goes to the picked
  plunderer (Plunder event fields, species/gen/minter-of-record,
  born slotless), the shell's slot is RELEASED at settlement and
  the minter's quota is fully restored, shell persistence (not
  burned, transferable, 0 production forever, pending views read 0
  while the stranded egg-phase accrual remains visible in raw
  storage — change E), `requestClaim` skips shells even with
  egg-phase accrual on board, empty-pool no-plunder (a lone hatcher
  keeps every animal), the plunderer registry across hatch /
  transfer / claim-death, a plunder-born animal's claim-death frees
  NOTHING (no double-free), and the hatch-only pin (minted eggs
  stay species 0 at full rate; unhatched eggs never shell); phoenix decay (rate steps 10,000 → 8,000 →
  6,400 → 5,120 at 30-day boundaries from `hatchTimeOf`,
  boundary-segmented accrual identities, claims pay decayed
  amounts in full, non-phoenix species constant past 90 days).
- `gen.test.js` — mint slots (cap on alive units, death frees the
  minter's slot, transfers never free, hook access control — the
  slot-teardown helper impersonates the sale through the REAL
  claim-death path `killUnit` since change C deleted `burnUnit`;
  after a kill the NFT rests at DEAD with `isDead` true),
  `GEN_MAO_LADDER` values, Gen 1 end-to-end (quota reset, MAO-only
  payment split 90% burned / 10% converted with the pots' combined
  delta bounded by the mock swap output, Gen 1+ wallet cap 20 as
  the only count limit (partial batch + exact-remainder batch in
  single transactions, over-cap counts revert on quota), BNB
  refund, maxMaoPayable, ladder walk + idle decay), Gen 2 identical
  ladder + project-MAO-unchanged / ≥14.4M burn identity,
  generation cap (MAX_GENERATION = 9; Gen 9 sellout latches
  `saleFinished`, no Gen 10, mint reverts, 100,000 eggs total).
- `refund.test.js` — failed-launch refund (change I): deadline
  anchoring (startTime + 7d), unavailable before the deadline,
  available + mint closed ("sale failed") after it, per-batch
  records summing EXACTLY to the net BNB paid, two-part refunds
  paying the recorded amounts with units dead at DEAD / slots
  freed / counters unwound, non-owner + double-refund reverts,
  project wallet at 0 throughout the failed scenario, a HATCHED
  unit refunding for exactly its egg's BNB (species-agnostic),
  success path (escrow released in the open tx incl. the opening
  mint's own leg; post-open mints pay immediately), and no refunds
  when the pool opened before the deadline.
- `market.test.js` — list/buy/fee split, all state rides with the
  NFT, cancel/stale/clean, approval-revocation wipe, hatch-locked and
  claim-locked listings cannot execute.
- `setbonus.test.js` — eggs don't count, completion boundary (no
  retroactive bonus), +20% accrual, claim pays (base + bonus) ×
  patience, break crystallizes, no stacking.

Fork suite (real BSC contracts, pinned block 131355494), **7 passing,
0 failing**: real Chainlink quote; CREATE2 prediction vs the real
factory; real Agent ID gate + instant mint for mars (handle "mars");
pool open on the real factory/router with LP to DEAD and the anchor
ratio within 0.5%; buyback against the real pair burning to DEAD;
LP add piggybacked in a post-open mint; Gen 1 ladder-priced mint
split 90% burned to DEAD / 10% converted (project MAO unchanged,
DEAD strictly between 90% and 100% of the payment).


Tests assert flows, counts and accounting identities only — never
specific random outcomes (hatch/death outcomes are validated as
*membership* in the legal set, plus pure-function boundary scans of
`speciesForWord` / `claimDeathRoll`).

**Environment note (final verification, 2026-11-03).** The
100,000-egg generation-cap sellout test is the one test that could
not complete on this 8 GB development VM under Hardhat's
in-process chain: the process was OOM-killed inside that test
three times (full suite at default and at 6 GB heap; isolated
`gen.test.js` at 2 GB heap) — the in-memory state of 100,000 NFTs
outgrows the box, while every other test in the suite passes
in-process (96 of 97). The decision-18 round did NOT re-run the
anvil driver: its EggSale changes do not touch generation
rollover (the Gen 1+ split changes only how a payment is disposed
of; the refund path's genSold/gen0Sold decrements can only occur
in the failed-launch state, where minting is already closed). The cap behavior was therefore verified
end-to-end on a local anvil node with `scripts/verify-cap-anvil.js`,
which executes the mocha test's exact flow and assertions (all 10
generations sold through the real mint path; `currentGen` stops at
`MAX_GENERATION`, `saleFinished` latches, price views read 0,
further mints revert "sale finished") with receipt-awaited
transactions: **CAP VERIFICATION PASSED**. On a machine with
≥16 GB RAM, `npx hardhat test` runs the test natively. The fork
suite's final run used the BlastAPI archive endpoint
(`BSC_FORK_RPC`) after the default publicnode endpoint began
answering 403.

## External addresses — verified on-chain at build time (never from memory)

| Contract | Address | Verified by |
| --- | --- | --- |
| PancakeSwap V2 factory | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` | pair creation in fork test |
| PancakeSwap V2 router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` | `WETH()` / `factory()` read back |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` | router `WETH()` |
| Chainlink BNB/USD feed | `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` | `decimals()` = 8, description "BNB / USD", live rounds in fork test |
| SPACE ID Agent ID registry | `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` | mars `balanceOf` = 1, `handleOf` = "mars" on the fork |
| Pair init-code hash | `0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5` | CREATE2-verified against the real WBNB/USDT pair `0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE` |

## Sizes (EIP-170 limit 24,576 B)

MaoToken 6,415 · EggNFT 16,345 · EggSale 24,335 · EggMarket 4,796 ·
MaoConverter 2,086. All five deployable contracts are under the
limit.

EggSale size history: the v2 package measured 24,261 B; the
decision-18 change package (Gen 1+ conversion, claim freeze,
anti-snipe, failure refund) pushed it to 26,685 B. Three structural
trims brought it back without touching behavior: (1) the MAO→BNB
swap leg was extracted into the stateless `MaoConverter` contract;
(2) the twelve paired hatch/claim externals were unified into one
`req*` API over the two request stores; (3) getters no consumer
reads (`curTier`, `gen0Sold`, `spotPrice`, the wiring immutables
`feed` / `registry` / `factory` / `wbnb`, …) were internalized.
Optimizer-runs and viaIR levers were measured and are useless here
(runs=1 saves 82 B; viaIR off is byte-identical) — the Hardhat
config is unchanged. EggSale now fits with 168 B to spare — future
additions must still watch its size. Round 3 (decision 18) landed
EggSale at 24,335 B (241 B spare) by keeping this layout and
delegating the whole hatch resolution to EggNFT in one call;
during that round, structural refactors (relocating roll
functions, unifying the twin piggyback loops, optimizer-run
overrides) were each measured to GROW the viaIR output and were
reverted — on this contract, viaIR inlining decisions dominate
and deduplication does not pay.

## Privilege audit (for external review)

Every privileged function in the four contracts, and its state
after the pool opens. Short version: there is no owner, no proxy,
no upgrade path, no pause, and no function that withdraws or
rescues funds anywhere in the package.

**MaoToken**

- `setSystem` — deployer-only, ONE-TIME (`system` must be unset);
  consumed at deploy wiring to point at EggSale. Dead after wiring.
- `setConverter` — deployer-only, ONE-TIME (`converter` must be
  unset); consumed at deploy wiring to point at MaoConverter. The
  converter address is a tax-exemption entry (like the system
  address) — safe only because the converter itself accepts calls
  from the wired EggSale alone (its own one-time `setSale` latch;
  see the MaoConverter section below). A tax-exempt address whose
  contract anyone could call would be a public tax-free sell
  rail.
- `notifyPoolOpened` — `onlySystem`, ONE-TIME; called by EggSale
  inside the pool-open mint to latch the pair and the open block
  for the anti-snipe window. Dead after the open.
- `mint` — `onlySystem` (EggSale only): pool seed at open and
  production claims; every mint is bounded by the 3B circulating
  cap (a mint that would push `circulating()` over `HARD_CAP`
  reverts).
- `setOfficialPair` — `onlySystem`, ONE-TIME, and the pair must
  equal the CREATE2-predicted pair; called by EggSale inside the
  pool-open mint. Dead after the open.
- Everything else is automatic `_update` logic (the pre-open pair
  gate; per-side tax splits to DEAD and the immutable project
  wallet — no setter exists for either).

**EggNFT**

- `setSale` / `setMarket` — deployer-only, ONE-TIME (the target
  must be unset); consumed at deploy wiring. Dead after wiring.
  **These are the NFT's only privileged functions**: the §10 add-on
  hook (`setAddonAuthorized`, `burnUnit`, `transformUnit`, the
  `authorizedAddon` set) was deleted outright in decision 17 — it
  had been the package's only standing deployer power, and it no
  longer exists in any form.
- Sale-only state changes (`mintEgg`, `transform`,
  `setHatchPending`, `setClaimPending`, `settleClaimUnit`,
  `killUnit`) — the caller must be the wired EggSale contract,
  which has no admin of its own (below).

**EggSale**

- No deployer, no owner, no admin state at all: every constructor
  parameter is immutable (token, eggs, registry, feed, router,
  factory, WBNB, project wallet). `onUnitDeath` accepts only the
  EggNFT contract. All other external functions are user flows
  (mint, claim/hatch requests) or permissionless public triggers
  anyone may call (seed capture, settlement, expiry close-outs,
  `pokePrice`, `buyback`, `addLiquidity`, `fundReserve` — the
  last only ADDS the caller's own BNB to the reserve). Fund
  movements follow hardcoded splits to the immutable project
  wallet, the pair, and DEAD; there is no withdraw, sweep,
  rescue, pause, or parameter setter. Its one outbound approval —
  to the wired MaoConverter, for exactly the 10% leg of a Gen 1+
  mint, inside that mint — is hardcoded, as is the refund payout
  path (`refundEggs` pays only the recorded per-egg amount to the
  unit's owner, only in the failed-launch state).

**EggMarket**

- No admin functions: the fee is the constant `MARKET_FEE_BPS`
  (2.5%, to the immutable project wallet). `list` / `cancel` /
  `buy` are user-only flows; `clearListingsOf` may be called only
  by the seller themself or by the EggNFT contract (the
  approval-revocation wipe).

**MaoConverter**

- `setSale` — deployer-only, ONE-TIME (`sale` must be unset);
  consumed at deploy wiring to record the EggSale contract. Dead
  after wiring.
- `swapMaoToBnb` — SALE-ONLY (`msg.sender` must be the wired
  EggSale; EggSale approves it for exactly one mint leg at a
  time). The access control is load-bearing, not ceremonial:
  MaoToken exempts the converter address from trade tax (its leg
  into the pair is EggSale's own leg by proxy), so a permissionless
  entry point would hand every MAO holder a tax-free sell rail
  bypassing the 2% sell tax. The converter is otherwise stateless
  and holds no balances between calls.

**Bottom line (any time, not just post-open)** — after deploy
wiring: every setter in the system is one-time and consumed
(`setSystem`, `setConverter`, `setOfficialPair`,
`notifyPoolOpened`, `setSale`, `setMarket`, and the converter's
own `setSale`), the add-on hook is
deleted, MAO can be minted only by EggSale under the cap, and no
key anywhere can change a parameter, move a fund, pause the
system, or upgrade a contract. There is no standing deployer
power anywhere in the package.

## Deployment

`scripts/deploy.js` is env-parameterized (external addresses + project
wallet), contains no keys, and **has not been run on mainnet**. Wiring
order inside it: deploy token → NFT → converter → sale → market,
then `token.setSystem(sale)`, `token.setConverter(converter)`,
`converter.setSale(sale)`, `eggs.setSale(sale)`,
`eggs.setMarket(market)` (each a one-time setter).

**Mint start gate (user decision 2026-11-03):** EggSale takes an
immutable `startTime` constructor argument; `mint` reverts with
"not started" while `block.timestamp < startTime` (0 = open
immediately; all test stacks use 0 except the dedicated start-gate
test in `mint.test.js`). `scripts/deploy.js` defaults it to
1793710800 = 2026-11-03 21:00 CST (13:00 UTC), overridable via the
`START_TIME_UNIX` env var; a startTime in the past opens at deploy.

**Failed-launch refund (user decision 2026-11-03, decision 17).**
The user dropped this idea earlier the same day and then explicitly
reinstated it: `refundDeadline = startTime + 7 days`; if the pool
has not opened by then, minting closes and Gen 0 units are
refundable per egg (SPEC §2). The fund-flow consequence is the
pre-open escrow of the 20% project leg (`projectDue`, released in
the open transaction) — the Deployment reader should note the
project wallet receives NOTHING from Gen 0 until the pool opens.

## Still undecided (SPEC §10 — stated, not resolved here)

- **Post-sellout trading-tax redirect to buyback: NOT implemented.**
  Both tax sides are fixed at 1% burn / 1% project (buy side made
  symmetric in decision 17, change A).
- **Hatch fee: currently free** (no fee is charged; left open in the
  SPEC).
- **Market fee: 2.5% implemented** as the current default; the SPEC
  still lists the rate as unconfirmed.
