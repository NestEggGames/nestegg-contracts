const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployStack, giveId, mintEggs, mintEggIds, warp, mine, U, acquireSpecies, requestAndSettleClaims, hatchAndSettle } = require("./helpers");

const RATES = { 1: "300", 2: "500", 3: "700", 4: "1000", 5: "10000" };

describe("Hatch — seed capture settlement, no bounty anywhere", function () {
  let s, alice, bob;
  beforeEach(async function () {
    s = await deployStack();
    [, , alice, bob] = s.signers;
    await giveId(s.registry, alice);
    await giveId(s.registry, bob);
  });

  it("requestHatch takes no value: it is non-payable and needs no bounty", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    expect(s.sale.addBounty).to.equal(undefined);
    expect(s.sale.withdrawBounty).to.equal(undefined);
    expect(s.sale.bountyOf).to.equal(undefined);
    await expect(
      s.sale.connect(alice).requestHatch([id], { value: U("0.01") })
    ).to.be.reverted; // non-payable rejects value
    await s.sale.connect(alice).requestHatch([id]);
    expect(await s.sale.reqState(false, 1)).to.equal(1); // awaiting seed block
  });

  it("a pending egg is locked: cannot transfer or be listed", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await s.sale.connect(alice).requestHatch([id]);
    await expect(s.eggs.connect(alice).transferFrom(alice.address, bob.address, id))
      .to.be.revertedWith("egg hatching");
    await s.eggs.connect(alice).setApprovalForAll(await s.market.getAddress(), true);
    await expect(s.market.connect(alice).list(id, U("0.1"))).to.be.revertedWith("egg hatching");
  });

  it("settle transforms the egg in place: valid species, rate matches the table, age clock inherited", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    const mintTime = (await s.eggs.eggOf(id)).mintTime;
    await warp(10 * 24 * 3600); // egg ages 10 days before hatching
    await s.sale.connect(alice).requestHatch([id]);
    await mine(6);
    // outcome is the pure function of the captured/live seed.
    // Nobody holds a hatched animal yet, so no eligible plunderer
    // exists: the animal is always KEPT by its hatcher this time.
    const word = await s.sale.reqWord(false, 1);
    const wantSpecies = await s.sale.speciesForWord(word);
    await s.sale.connect(bob).settleReq(false, 1); // anyone may settle
    const after = await s.eggs.eggOf(id);
    expect(after.species).to.equal(wantSpecies);
    expect(after.mintTime).to.equal(mintTime); // age clock NOT reset
    expect(await s.eggs.ownerOf(id)).to.equal(alice.address); // same NFT, same owner
    expect(after.species).to.be.gte(1).and.to.be.lte(5);
    expect(await s.eggs.currentRate(id)).to.equal(U(RATES[Number(wantSpecies)]));
    expect(await s.eggs.slotHeldOf(id)).to.equal(true); // a kept animal holds its mint slot
    expect(await s.sale.reqState(false, 1)).to.equal(4);
  });

  it("accrual before hatch is at the egg rate; after hatch at the animal rate", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await warp(24 * 3600); // 1 day as egg = ~400
    await s.sale.connect(alice).requestHatch([id]);
    await mine(6);
    await s.sale.settleReq(false, 1);
    const species = Number(await s.eggs.speciesOf(id));
    expect(species).to.be.gte(1).and.to.be.lte(5); // kept: no other wallet holds an animal yet
    const p1 = await s.eggs.pendingOf(id);
    expect(p1).to.be.closeTo(U("400"), U("2")); // folded at egg rate at transform
    await warp(24 * 3600);
    const p2 = await s.eggs.pendingOf(id);
    expect(p2 - p1).to.be.closeTo(U(RATES[species]), U("2"));
  });

  it("seed capture kills the 256-block cliff: settle works long after the window", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await s.sale.connect(alice).requestHatch([id]);
    await mine(6);
    await expect(s.sale.connect(bob).captureReqSeed(false, 1)).to.emit(s.sale, "SeedCaptured");
    const [, , , , captured] = await s.sale.reqOf(false, 1);
    expect(captured).to.not.equal(ethers.ZeroHash);
    await mine(1000); // way beyond the blockhash window
    expect(await s.sale.reqState(false, 1)).to.equal(2); // still settleable
    await s.sale.connect(bob).settleReq(false, 1);
    expect(await s.sale.reqState(false, 1)).to.equal(4);
  });

  it("expired uncaptured seed: free close-out, egg intact, 24h cooldown, then re-hatch works", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await warp(24 * 3600);
    const pendingBefore = await s.eggs.pendingOf(id);
    await s.sale.connect(alice).requestHatch([id]);
    await mine(300); // seed expires uncaptured
    expect(await s.sale.reqState(false, 1)).to.equal(3);
    await expect(s.sale.settleReq(false, 1)).to.be.revertedWith("seed not ready");
    await s.sale.connect(bob).expireReq(false, 1); // permissionless close-out
    expect(await s.sale.reqState(false, 1)).to.equal(5);
    // egg NOT consumed, still alice's, still an egg, still producing
    expect(await s.eggs.ownerOf(id)).to.equal(alice.address);
    expect(await s.eggs.speciesOf(id)).to.equal(0);
    expect(await s.eggs.hatchPending(id)).to.equal(false);
    expect(await s.eggs.pendingOf(id)).to.be.gte(pendingBefore);
    // cooldown blocks an immediate re-hatch
    await expect(s.sale.connect(alice).requestHatch([id])).to.be.revertedWith("re-hatch cooldown");
    await warp(24 * 3600 + 60);
    await s.sale.connect(alice).requestHatch([id]);
    await mine(6);
    await s.sale.settleReq(false, 2);
    expect(await s.eggs.speciesOf(id)).to.be.gte(1);
  });

  it("piggyback: an unrelated mint captures + settles queue-front hatches", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await s.sale.connect(alice).requestHatch([id]);
    await mine(6);
    // bob mints an egg — the piggyback inside his mint settles alice's hatch
    await mintEggs(s, bob, 1);
    expect(await s.sale.reqState(false, 1)).to.equal(4);
    expect(await s.eggs.speciesOf(id)).to.be.gte(1);
  });

  it("backstop sweep: settleBacklog settles the queue; pendingReqs enumerates it", async function () {
    const ids = await mintEggIds(s, alice, 3);
    await s.sale.connect(alice).requestHatch(ids);
    expect(await s.sale.reqQueueLength(false)).to.equal(3);
    let pending = await s.sale.pendingReqs(false, 10);
    expect(pending.map(Number)).to.deep.equal([1, 2, 3]);
    await mine(6);
    await s.sale.connect(bob).settleBacklog(10); // the backstop keeper's call
    pending = await s.sale.pendingReqs(false, 10);
    expect(pending.length).to.equal(0);
    for (const id of ids) expect(await s.eggs.speciesOf(id)).to.be.gte(1);
  });

  it("speciesForWord implements the 9,000-point animal table (chicken 3856 / duck 2314 / goose 1653 / bird 1157 / phoenix 20)", async function () {
    const f = (w) => s.eggs.speciesForWord(w);
    expect(await f(0)).to.equal(1);
    expect(await f(3855)).to.equal(1);
    expect(await f(3856)).to.equal(2);
    expect(await f(6169)).to.equal(2);
    expect(await f(6170)).to.equal(3);
    expect(await f(7822)).to.equal(3);
    expect(await f(7823)).to.equal(4);
    expect(await f(8979)).to.equal(4);
    expect(await f(8980)).to.equal(5);
    expect(await f(8999)).to.equal(5);
    expect(await f(9000)).to.equal(1); // the word wraps modulo 9,000
    // EggSale's mirror view agrees with the table that lives in EggNFT
    expect(await s.sale.speciesForWord(6170)).to.equal(3);
    expect(await s.sale.speciesForWord(8980)).to.equal(5);
  });

  it("many hatches: every outcome is a valid species with the table rate (no distribution claims)", async function () {
    const seen = new Set();
    // 40 eggs across 4 buyers (alice is capped at 10 per generation)
    const buyers = s.actors.slice(20, 24);
    for (const b of buyers) await giveId(s.registry, b);
    for (const b of buyers) {
      const ids = await mintEggIds(s, b, 10);
      await s.sale.connect(b).requestHatch(ids);
    }
    await mine(6);
    await s.sale.settleBacklog(100);
    const total = await s.eggs.nextId();
    for (let id = 1; id <= total; id++) {
      const sp = Number(await s.eggs.speciesOf(id));
      if (sp === 6) {
        // shell: valid outcome, 0 rate, still the hatcher's live NFT
        // (its animal went to a plunderer as a separate id, which
        // this same loop also covers via nextId)
        expect(await s.eggs.currentRate(id)).to.equal(0);
        expect(await s.eggs.isDead(id)).to.equal(false);
      } else {
        expect(sp).to.be.gte(1).and.to.be.lte(5);
        expect(await s.eggs.currentRate(id)).to.equal(U(RATES[sp]));
        seen.add(sp);
      }
    }
    expect(seen.size).to.be.gte(3); // sanity: surviving outcomes actually vary
  });
});

describe("Plunder — a plundered hatch shells the egg and mints the animal to a plunderer", function () {
  let s, alice, bob, carol;
  beforeEach(async function () {
    s = await deployStack();
    [, , alice, bob, carol] = s.signers;
    await giveId(s.registry, alice);
    await giveId(s.registry, bob);
    await giveId(s.registry, carol);
  });

  it("the species table: exhaustive census over all 9,000 rolls matches the weights exactly", async function () {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (let w = 0; w < 9000; w++) {
      counts[Number(await s.eggs.speciesForWord(w))]++;
    }
    expect(counts[1]).to.equal(3856); // chicken 38.56%
    expect(counts[2]).to.equal(2314); // duck 23.14%
    expect(counts[3]).to.equal(1653); // goose 16.53%
    expect(counts[4]).to.equal(1157); // bird 11.57%
    expect(counts[5]).to.equal(20); // phoenix 0.2%
  });

  it("hatchRoll accounting: the plunder flag hits ~10% of words, across every species", async function () {
    // Distribution accounting on the roll function itself (never a
    // demand on a specific settlement outcome): the census over
    // words 0..9999 is deterministic for this build; the bands are
    // the design tolerances around 10% / the 9,000-table shares.
    let plunders = 0;
    const perSpecies = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const plunderedSpecies = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (let w = 0; w < 9000; w++) {
      const [species, plunder] = await s.eggs.hatchRoll(w);
      perSpecies[Number(species)]++;
      if (plunder) {
        plunders++;
        plunderedSpecies[Number(species)]++;
      }
    }
    // one full table cycle: the species counts are the exact weights
    expect(perSpecies[1]).to.equal(3856);
    expect(perSpecies[2]).to.equal(2314);
    expect(perSpecies[3]).to.equal(1653);
    expect(perSpecies[4]).to.equal(1157);
    expect(perSpecies[5]).to.equal(20);
    expect(plunders).to.be.gte(700).and.to.be.lte(1100); // design: 900 of 9,000
    for (const sp of [1, 2, 3, 4]) expect(plunderedSpecies[sp]).to.be.gt(0); // every common species can be plundered
  });

  // Seed bob with a hatched animal first: his own first hatch can
  // never be plundered (the eligible pool is empty), and from then
  // on an eligible pool exists. Then hatch fresh minters' eggs until
  // one is plundered (~10% per hatch; 60 rounds makes a total miss
  // ~0.2% likely, the acquireSpecies tolerance style). The RECEIVER
  // is whoever the registry pick lands on — bob, or an earlier
  // round's minter who kept an animal — so it is read back from the
  // Plunder event log, never assumed. Each candidate accrues 2h AS
  // AN EGG first (~33 MAO), so the shell carries nonzero egg-phase
  // accrual into the never-claims test, and cumulative warps stay
  // inside the 7-day refund deadline.
  async function huntShell(opts = {}) {
    const [bobEgg] = await mintEggIds(s, bob, 1);
    await hatchAndSettle(s, bob, bobEgg);
    expect(await s.eggs.holderCount()).to.equal(1); // bob: the one eligible plunderer
    for (let round = 0; round < 60; round++) {
      const minter = s.actors[100 + round];
      await giveId(s.registry, minter);
      const [id] = await mintEggIds(s, minter, 1);
      await warp(2 * 3600);
      await s.sale.connect(minter).requestHatch([id]);
      const hatchId = await s.sale.nextHatchId();
      await mine(6);
      const word = await s.sale.reqWord(false, hatchId);
      const nextBefore = await s.eggs.nextId();
      const tx = await s.sale.settleReq(false, hatchId);
      if (Number(await s.eggs.speciesOf(id)) === 6) {
        const animalSpecies = Number(await s.eggs.speciesForWord(word));
        if (opts.nonPhoenix && animalSpecies === 5) continue; // phoenixes never claim-die; the death test needs a mortal
        const rc = await tx.wait();
        const plog = rc.logs.map((l) => { try { return s.eggs.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "Plunder");
        expect(plog, "a shell implies a Plunder event").to.not.equal(null);
        expect(plog.args.newAnimalId).to.equal(nextBefore + 1n); // the very next NFT id
        const plunderer = s.signers.find((x) => x.address === plog.args.plunderer);
        return { minter, id, hatchId, word, tx, newId: plog.args.newAnimalId, animalSpecies, plunderer, plundererAddr: plog.args.plunderer };
      }
    }
    throw new Error("no plunder in 60 hatches");
  }

  it("plunder: the egg shells in place, a NEW animal NFT goes to the plunderer, events and records line up", async function () {
    const { minter, id, hatchId, tx, newId, animalSpecies, plundererAddr } = await huntShell();
    expect(plundererAddr).to.not.equal(minter.address); // the hatcher is never her own plunderer
    await expect(tx).to.emit(s.eggs, "Plunder").withArgs(id, newId, minter.address, plundererAddr, animalSpecies);
    // HatchSettled reports the EGG's settled species: 6 (shell)
    await expect(tx).to.emit(s.sale, "HatchSettled").withArgs(hatchId, id, 6, s.deployer.address);
    // the egg: an empty shell, still the hatcher's NFT, slot RELEASED
    expect(await s.eggs.speciesOf(id)).to.equal(6);
    expect(await s.eggs.ownerOf(id)).to.equal(minter.address);
    expect(await s.eggs.slotHeldOf(id)).to.equal(false);
    expect(await s.sale.slotsUsed(minter.address, 0)).to.equal(0); // was 1 at mint
    await expect(tx).to.emit(s.sale, "SlotFreed").withArgs(id, minter.address, 0);
    // the new animal: the plunderer's NFT, the rolled species and
    // generation, minter-of-record = the egg's original minter,
    // born slotless
    const a = await s.eggs.eggOf(newId);
    expect(Number(a.species)).to.equal(animalSpecies);
    expect(Number(a.gen)).to.equal(0);
    expect(a.minter).to.equal(minter.address);
    expect(await s.eggs.ownerOf(newId)).to.equal(plundererAddr);
    expect(await s.eggs.slotHeldOf(newId)).to.equal(false);
    expect(await s.eggs.currentRate(newId)).to.equal(U(RATES[animalSpecies]));
    expect(Number(a.hatchTime)).to.be.gt(0);
    // the receiver was already a holder (eligibility) and the new
    // animal joined their registry count; bob's own egg slot is
    // untouched (he minted one egg and still holds its animal)
    expect(await s.eggs.animalCountOf(plundererAddr)).to.be.gte(2);
    expect(await s.sale.slotsUsed(bob.address, 0)).to.equal(1);
  });

  it("a shell persists: not burned, no death, produces 0 forever, transferable — and its minter's quota is fully restored", async function () {
    const { minter, id } = await huntShell();
    expect(await s.eggs.isDead(id)).to.equal(false); // no graveyard path
    expect(await s.eggs.currentRate(id)).to.equal(0);
    // the minter can mint a FULL fresh batch again: the shell holds no slot
    await mintEggIds(s, minter, 10);
    expect(await s.sale.slotsUsed(minter.address, 0)).to.equal(10);
    // zero production forever AND the pending views read 0 (the
    // egg-phase fold is stranded in storage, never displayed)
    expect(await s.eggs.pendingOf(id)).to.equal(0);
    expect(await s.eggs.setBonusPendingOf(id)).to.equal(0);
    await warp(7 * 24 * 3600);
    expect(await s.eggs.pendingOf(id)).to.equal(0);
    // transferable like any other unit; the transfer frees nothing
    await s.eggs.connect(minter).transferFrom(minter.address, bob.address, id);
    expect(await s.eggs.ownerOf(id)).to.equal(bob.address);
    expect(await s.sale.slotsUsed(minter.address, 0)).to.equal(10); // his 10 live eggs hold theirs
  });

  it("a shell can never claim: requestClaim skips it even with egg-phase accrual on board", async function () {
    const { minter, id } = await huntShell();
    // ~33 MAO accrued during its 2 egg hours is still sitting in STORAGE...
    expect((await s.eggs.eggOf(id)).accruedStored).to.be.gt(0);
    // ...but the pending views display 0 for a shell
    expect(await s.eggs.pendingOf(id)).to.equal(0);
    expect(await s.eggs.setBonusPendingOf(id)).to.equal(0);
    const claimsBefore = await s.sale.nextClaimId();
    await s.sale.connect(minter).requestClaim([id]);
    expect(await s.sale.nextClaimId()).to.equal(claimsBefore); // skipped: no claim created
    expect(await s.eggs.claimPending(id)).to.equal(false);
    expect(await s.sale.slotsUsed(minter.address, 0)).to.equal(0); // released at plunder, stays released
  });

  it("no eligible plunderer, no plunder: a lone hatcher keeps every animal and no new NFT appears", async function () {
    const ids = await mintEggIds(s, alice, 10);
    const nextBefore = await s.eggs.nextId();
    for (const id of ids) await hatchAndSettle(s, alice, id);
    // alice is the only animal holder and the hatcher is excluded
    // from her own pool: every hatch was kept, deterministically
    expect(await s.eggs.nextId()).to.equal(nextBefore); // no plunder-minted NFTs
    for (const id of ids) {
      const sp = Number(await s.eggs.speciesOf(id));
      expect(sp).to.be.gte(1).and.to.be.lte(5);
    }
    expect(await s.eggs.holderCount()).to.equal(1); // alice alone
    const logs = await s.eggs.queryFilter(s.eggs.filters.Plunder, 0, "latest");
    expect(logs.length).to.equal(0);
  });

  it("the plunderer registry tracks hatch, transfer and claim-death", async function () {
    const [bobEgg] = await mintEggIds(s, bob, 1);
    await hatchAndSettle(s, bob, bobEgg);
    expect(await s.eggs.holderCount()).to.equal(1);
    expect(await s.eggs.animalCountOf(bob.address)).to.equal(1);
    expect(await s.eggs.pickPlunderer(12345, alice.address)).to.equal(bob.address);
    expect(await s.eggs.pickPlunderer(12345, bob.address)).to.equal(ethers.ZeroAddress); // self excluded -> empty
    // transfer: registry membership moves with the animal
    await s.eggs.connect(bob).transferFrom(bob.address, carol.address, bobEgg);
    expect(await s.eggs.holderCount()).to.equal(1);
    expect(await s.eggs.animalCountOf(bob.address)).to.equal(0);
    expect(await s.eggs.animalCountOf(carol.address)).to.equal(1);
    expect(await s.eggs.pickPlunderer(999, alice.address)).to.equal(carol.address);
    // claim-death removes the holder (flat 20% per claim; bounded loop)
    let died = false;
    for (let i = 0; i < 40 && !died; i++) {
      await warp(2 * 3600);
      await requestAndSettleClaims(s, carol, [bobEgg]);
      died = await s.eggs.isDead(bobEgg);
    }
    expect(died).to.equal(true);
    expect(await s.eggs.holderCount()).to.equal(0);
    expect(await s.eggs.animalCountOf(carol.address)).to.equal(0);
    expect(await s.eggs.pickPlunderer(1, alice.address)).to.equal(ethers.ZeroAddress);
  });

  it("a plunder-born animal's claim-death frees NOTHING: one egg never frees two slots", async function () {
    const { minter, newId, plunderer } = await huntShell({ nonPhoenix: true });
    expect(await s.sale.slotsUsed(minter.address, 0)).to.equal(0); // released at plunder
    let died = false;
    for (let i = 0; i < 40 && !died; i++) {
      await warp(2 * 3600);
      await requestAndSettleClaims(s, plunderer, [newId]); // claims run as the animal's owner
      died = await s.eggs.isDead(newId);
      // checked every round, not just at death: the counter never moves
      expect(await s.sale.slotsUsed(minter.address, 0)).to.equal(0);
    }
    expect(died).to.equal(true);
    expect(await s.sale.slotsUsed(minter.address, 0)).to.equal(0);
    expect(await s.sale.slotsUsed(bob.address, 0)).to.equal(1); // bob's own egg slot untouched throughout
  });

  it("plunder exists ONLY at hatch resolution: a minted egg is always a normal producing egg until hatched", async function () {
    const ids = await mintEggIds(s, alice, 10);
    // at mint there is no shell state: every egg is species 0 at the
    // full guaranteed egg rate
    for (const id of ids) {
      expect(await s.eggs.speciesOf(id)).to.equal(0);
      expect(await s.eggs.currentRate(id)).to.equal(U("400"));
    }
    // 30 days unhatched: still normal eggs producing 400/day — an egg
    // that is never hatched can never become a shell
    await warp(30 * 24 * 3600);
    for (const id of ids) {
      expect(await s.eggs.speciesOf(id)).to.equal(0);
      expect(await s.eggs.currentRate(id)).to.equal(U("400"));
      expect(await s.eggs.pendingOf(id)).to.be.closeTo(U("12000"), U("10"));
    }
  });
});

describe("Phoenix decay — rate ×0.8 per 30 days from hatching (phoenix-only exception)", function () {
  let s, alice;
  beforeEach(async function () {
    s = await deployStack();
    [, , alice] = s.signers;
    await giveId(s.registry, alice);
  });

  async function nowTs() {
    return Number((await ethers.provider.getBlock("latest")).timestamp);
  }

  it("currentRate steps down geometrically at the 30-day boundaries counted from the HATCH time", async function () {
    const state = { i: 200 };
    const id = await acquireSpecies(s, 5, alice, s.actors, state);
    const h = Number(await s.eggs.hatchTimeOf(id));
    expect(h).to.be.gt(0);
    expect(await s.eggs.currentRate(id)).to.equal(U("10000")); // period 0
    // one hour before the first boundary: still the full rate
    await warp(h + 30 * 24 * 3600 - 3600 - (await nowTs()));
    expect(await s.eggs.currentRate(id)).to.equal(U("10000"));
    await warp(2 * 3600); // hatch + 30d + 1h: period 1
    expect(await s.eggs.currentRate(id)).to.equal(U("8000"));
    await warp(30 * 24 * 3600); // period 2
    expect(await s.eggs.currentRate(id)).to.equal(U("6400"));
    await warp(30 * 24 * 3600); // period 3
    expect(await s.eggs.currentRate(id)).to.equal(U("5120"));
  });

  it("accrual segments at period boundaries: 15d at 10,000 + 15d at 8,000 = 270,000 across the straddle", async function () {
    const state = { i: 200 };
    const id = await acquireSpecies(s, 5, alice, s.actors, state);
    const h = Number(await s.eggs.hatchTimeOf(id));
    await warp(h + 15 * 24 * 3600 - (await nowTs())); // hatch + 15d
    const p1 = await s.eggs.pendingOf(id);
    await warp(30 * 24 * 3600); // hatch + 45d
    const p2 = await s.eggs.pendingOf(id);
    expect(p2 - p1).to.be.closeTo(U("270000"), U("5"));
    // pure period-1 remainder, then a pure period-2 window
    await warp(15 * 24 * 3600); // hatch + 60d (the boundary)
    const p3 = await s.eggs.pendingOf(id);
    expect(p3 - p2).to.be.closeTo(U("120000"), U("5")); // 15 x 8,000
    await warp(30 * 24 * 3600); // hatch + 90d
    const p4 = await s.eggs.pendingOf(id);
    expect(p4 - p3).to.be.closeTo(U("192000"), U("5")); // 30 x 6,400
  });

  it("claims pay the decayed accrual in full (settlement consumes the segmented pending)", async function () {
    const state = { i: 200 };
    const id = await acquireSpecies(s, 5, alice, s.actors, state);
    const h = Number(await s.eggs.hatchTimeOf(id));
    await warp(h + 40 * 24 * 3600 - (await nowTs())); // period 1 (8,000/day)
    const pending = await s.eggs.pendingOf(id);
    const balBefore = await s.token.balanceOf(alice.address);
    const claimIds = await requestAndSettleClaims(s, alice, [id]);
    expect(claimIds.length).to.equal(1);
    const got = (await s.token.balanceOf(alice.address)) - balBefore;
    // locked at request: pending x patience multiplier (>=24h -> 120%)
    expect(got).to.be.closeTo((pending * 120n) / 100n, U("30"));
    expect(await s.eggs.isDead(id)).to.equal(false); // phoenix never dies
  });

  it("other species never decay: a chicken keeps 300/day past 90 days", async function () {
    const state = { i: 200 };
    const id = await acquireSpecies(s, 1, alice, s.actors, state);
    await warp(90 * 24 * 3600);
    expect(await s.eggs.currentRate(id)).to.equal(U("300"));
    expect(await s.eggs.hatchTimeOf(id)).to.be.gt(0); // hatched, yet constant
  });
});
