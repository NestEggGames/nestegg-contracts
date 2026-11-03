const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployStack, giveId, mintEggIds, warp, mine, requestAndSettleClaims, acquireSpecies, DEAD, U } = require("./helpers");

describe("Production & claim — two-step claims with claim-death", function () {
  let s, alice, bob;
  beforeEach(async function () {
    s = await deployStack();
    [, , alice, bob] = s.signers;
    await giveId(s.registry, alice);
  });

  it("locks the amount at request; MAO arrives only at settlement, in full", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await warp(24 * 3600);
    const pending = await s.eggs.pendingOf(id);
    expect(pending).to.be.closeTo(U("400"), U("1"));
    const balBefore = await s.token.balanceOf(alice.address);
    await s.sale.connect(alice).requestClaim([id]);
    // nothing arrives at request time
    expect(await s.token.balanceOf(alice.address)).to.equal(balBefore);
    const claimId = await s.sale.nextClaimId();
    const req = await s.sale.reqOf(true, claimId);
    expect(req.owner).to.equal(alice.address);
    expect(req.amount).to.be.closeTo((pending * 120n) / 100n, U("1")); // 24h -> patience +20% locked
    // time passing between request and settle changes NOTHING: the
    // amount was locked at request, and the interval produces nothing
    await warp(24 * 3600);
    await mine(6);
    await s.sale.connect(bob).settleReq(true, claimId); // anyone may settle
    const got = (await s.token.balanceOf(alice.address)) - balBefore;
    expect(got).to.equal(req.amount);
    expect(Number(await s.sale.reqState(true, claimId))).to.equal(4);
  });

  it("after settlement the unit pauses 1 hour and its clock restarts at settle", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await warp(2 * 3600);
    await requestAndSettleClaims(s, alice, [id]);
    if (await s.eggs.isDead(id)) return; // death path is covered by its own test
    const info = await s.eggs.eggInfo(id);
    expect(info.producing).to.equal(false);
    expect(info.pauseRemaining).to.be.closeTo(3600n, 15n);
    expect(await s.eggs.pendingOf(id)).to.equal(0);
    await warp(30 * 60);
    expect(await s.eggs.pendingOf(id)).to.equal(0); // no accrual during the pause
    await warp(31 * 60);
    expect(await s.eggs.pendingOf(id)).to.be.gt(0); // resumed
    expect((await s.eggs.eggInfo(id)).producing).to.equal(true);
  });

  it("patience is priced at REQUEST time, not settle time", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await warp(6 * 3600 + 60); // just past 6h: mult 110
    const pending = await s.eggs.pendingOf(id);
    await s.sale.connect(alice).requestClaim([id]);
    const claimId = await s.sale.nextClaimId();
    const req = await s.sale.reqOf(true, claimId);
    expect(req.amount).to.be.closeTo((pending * 110n) / 100n, U("0.1"));
    await warp(48 * 3600); // would be +20% if priced at settle
    await mine(6);
    const before = await s.token.balanceOf(alice.address);
    await s.sale.settleReq(true, claimId);
    expect((await s.token.balanceOf(alice.address)) - before).to.equal(req.amount);
  });

  it("patience tiers: +10% at 6h, +15% at 12h, +20% at 24h, none before 6h; claiming restarts the clock", async function () {
    const ids = await mintEggIds(s, alice, 4);
    await warp(3600);
    expect(await s.eggs.patienceMult(ids[0])).to.equal(100);
    await warp(5 * 3600 + 60);
    expect(await s.eggs.patienceMult(ids[1])).to.equal(110);
    await warp(6 * 3600);
    expect(await s.eggs.patienceMult(ids[2])).to.equal(115);
    await warp(12 * 3600);
    expect(await s.eggs.patienceMult(ids[3])).to.equal(120);
    await requestAndSettleClaims(s, alice, [ids[3]]);
    if (!(await s.eggs.isDead(ids[3]))) {
      expect(await s.eggs.patienceMult(ids[3])).to.equal(100); // consumed, clock restarted
    }
  });

  it("a zero-pending claim request creates no request and no lock", async function () {
    const [due] = await s.sale.quoteMint(1);
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const mtx = s.sale.connect(alice).mint(1, 0, { value: due + due / 100n });
      const rtx = s.sale.connect(alice).requestClaim([1]); // same block: zero elapsed
      await ethers.provider.send("evm_mine", []);
      await mtx;
      await rtx;
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    expect(await s.sale.nextClaimId()).to.equal(0);
    expect(await s.eggs.claimPending(1)).to.equal(false);
    expect((await s.eggs.eggInfo(1)).producing).to.equal(true);
    expect(await s.token.balanceOf(alice.address)).to.equal(0);
  });

  it("batch requests skip other wallets' units; each unit locks independently", async function () {
    const ids = await mintEggIds(s, alice, 3);
    await giveId(s.registry, bob);
    const [bobId] = await mintEggIds(s, bob, 1);
    await warp(12 * 3600);
    const pendSum = (await s.eggs.pendingOf(ids[0])) + (await s.eggs.pendingOf(ids[1])) + (await s.eggs.pendingOf(ids[2]));
    await s.sale.connect(alice).requestClaim([...ids, bobId]); // bob's id is skipped
    expect(await s.sale.nextClaimId()).to.equal(3);
    expect(await s.eggs.claimPending(bobId)).to.equal(false); // untouched
    await mine(6);
    const before = await s.token.balanceOf(alice.address);
    await s.sale.settleBacklog(10);
    const got = (await s.token.balanceOf(alice.address)) - before;
    expect(got).to.be.closeTo((pendSum * 115n) / 100n, U("1")); // 12h -> +15%, locked
  });

  it("a claim-pending unit is locked: no transfer, no listing, no hatch, no second claim", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await warp(2 * 3600);
    await s.sale.connect(alice).requestClaim([id]);
    await expect(s.eggs.connect(alice).transferFrom(alice.address, bob.address, id)).to.be.revertedWith("claim pending");
    await s.eggs.connect(alice).approve(await s.market.getAddress(), id);
    await expect(s.market.connect(alice).list(id, U("0.01"))).to.be.revertedWith("claim pending");
    await expect(s.sale.connect(alice).requestHatch([id])).to.be.revertedWith("claim pending");
    await expect(s.sale.connect(alice).requestClaim([id])).to.be.revertedWith("claim pending");
    // settling unlocks it (if it survives)
    await mine(6);
    await s.sale.settleBacklog(5);
    if (!(await s.eggs.isDead(id))) {
      expect(await s.eggs.claimPending(id)).to.equal(false);
    }
  });

  it("rates are lifetime-constant: no age decay, accrual is linear forever", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    expect(await s.eggs.currentRate(id)).to.equal(U("400"));
    await warp(90 * 24 * 3600); // 90 days
    expect(await s.eggs.ageDays(id)).to.equal(90);
    expect(await s.eggs.currentRate(id)).to.equal(U("400")); // unchanged
    const pending = await s.eggs.pendingOf(id);
    expect(pending).to.be.closeTo(U("36000"), U("50"));
    const info = await s.eggs.eggInfo(id);
    expect(info.ageInDays).to.equal(90);
    expect(info.rateNow).to.equal(U("400"));
  });

  it("accrual rides with the NFT on transfer (no seller-side settlement)", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await warp(10 * 3600);
    const pendingBefore = await s.eggs.pendingOf(id);
    await s.eggs.connect(alice).transferFrom(alice.address, bob.address, id);
    expect(await s.eggs.pendingOf(id)).to.be.closeTo(pendingBefore, U("0.01"));
    const bobBefore = await s.token.balanceOf(bob.address);
    await requestAndSettleClaims(s, bob, [id]);
    expect(await s.token.balanceOf(bob.address)).to.be.gt(bobBefore); // paid in full, dead or alive
  });

  it("claim-death: a unit eventually dies at settlement — paid in full, NFT to DEAD, slot freed", async function () {
    let deathSeen = null;
    for (let round = 0; round < 6 && !deathSeen; round++) {
      // refill alice's alive gen-0 units to 10 (deaths freed slots)
      const alive = Number(await s.sale.slotsUsed(alice.address, 0));
      if (alive < 10) await mintEggIds(s, alice, 10 - alive);
      const ids = [...(await s.eggs.unitsOf(alice.address))];
      await warp(2 * 3600 + 120); // accrue + exit the post-claim pause
      const slotsBefore = Number(await s.sale.slotsUsed(alice.address, 0));
      const c0 = await s.sale.nextClaimId();
      await s.sale.connect(alice).requestClaim(ids);
      const c1 = await s.sale.nextClaimId();
      await mine(6);
      let roundDeaths = 0;
      for (let c = c0 + 1n; c <= c1; c++) {
        if (Number(await s.sale.reqState(true, c)) !== 2) continue;
        const req = await s.sale.reqOf(true, c);
        const balBefore = await s.token.balanceOf(alice.address);
        await s.sale.settleReq(true, c);
        // death never touches the claimed amount: full payment either way
        expect((await s.token.balanceOf(alice.address)) - balBefore).to.equal(req.amount);
        if (await s.eggs.isDead(req.eggId)) {
          roundDeaths++;
          if (!deathSeen) deathSeen = { eggId: req.eggId, claimId: c };
        }
      }
      if (deathSeen) {
        const { eggId } = deathSeen;
        expect(await s.eggs.ownerOf(eggId)).to.equal(DEAD);
        expect(await s.eggs.pendingOf(eggId)).to.equal(0);
        // each death freed exactly one of the minter's slots
        expect(Number(await s.sale.slotsUsed(alice.address, 0))).to.equal(slotsBefore - roundDeaths);
        const deaths = await s.sale.queryFilter(s.sale.filters.Death(eggId));
        expect(deaths.length).to.equal(1);
        expect(deaths[0].args.species).to.equal(0); // it was an egg
        expect(deaths[0].args.causeId).to.be.within(0, 4);
        expect(deaths[0].args.lifetimeProduced).to.be.gt(0);
        await expect(s.eggs.connect(alice).transferFrom(DEAD, alice.address, eggId)).to.be.reverted;
      }
    }
    expect(deathSeen, "expected at least one death within 60 claims (p=0.2 each)").to.not.equal(null);
  });

  it("phoenix NEVER dies: repeated claims always survive", async function () {
    const state = { i: 20 };
    const phoenixId = await acquireSpecies(s, 5, alice, s.actors, state);
    for (let k = 0; k < 12; k++) {
      await warp(2 * 3600 + 60);
      await requestAndSettleClaims(s, alice, [phoenixId]);
      expect(await s.eggs.isDead(phoenixId)).to.equal(false);
      expect(await s.eggs.ownerOf(phoenixId)).to.equal(alice.address);
    }
  });

  it("death roll purity: 20% band + all five causes reachable from the word", async function () {
    let diedCount = 0;
    const causes = new Set();
    for (let w = 0; w < 3000; w++) {
      const [died, cause] = await s.sale.claimDeathRoll(w, 7, 9);
      if (died) {
        diedCount++;
        causes.add(Number(cause));
      }
    }
    expect(diedCount).to.be.gt(400).and.lt(800); // ~20% of 3000
    expect([...causes].sort()).to.deep.equal([0, 1, 2, 3, 4]);
  });

  it("seed capture removes the 256-block cliff for claims too", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await warp(2 * 3600);
    await s.sale.connect(alice).requestClaim([id]);
    const claimId = await s.sale.nextClaimId();
    await mine(6);
    await expect(s.sale.captureReqSeed(true, claimId)).to.emit(s.sale, "ClaimSeedCaptured");
    await mine(1000); // far beyond the blockhash window
    const before = await s.token.balanceOf(alice.address);
    await s.sale.settleReq(true, claimId);
    expect(await s.token.balanceOf(alice.address)).to.be.gt(before);
  });

  it("FROZEN at request (change F): pending views stop growing while claim-pending; settle pays the locked amount; accrual resumes after the pause", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await warp(2 * 3600);
    await s.sale.connect(alice).requestClaim([id]);
    const claimId = await s.sale.nextClaimId();
    const req = await s.sale.reqOf(true, claimId);
    const frozenBase = await s.eggs.pendingOf(id);
    const frozenBonus = await s.eggs.setBonusPendingOf(id);
    expect(frozenBase).to.be.gt(0);
    // at 2h unclaimed the patience multiplier is 100%, so the frozen
    // views sum EXACTLY to the amount EggSale locked in the same block
    expect(req.amount).to.equal(frozenBase + frozenBonus);
    await warp(6 * 3600); // hours pass: the views must NOT move
    expect(await s.eggs.pendingOf(id)).to.equal(frozenBase);
    expect(await s.eggs.setBonusPendingOf(id)).to.equal(frozenBonus);
    await mine(6);
    const before = await s.token.balanceOf(alice.address);
    await s.sale.settleReq(true, claimId);
    // the locked amount lands IN FULL (death never touches it)
    expect((await s.token.balanceOf(alice.address)) - before).to.equal(req.amount);
    if (!(await s.eggs.isDead(id))) {
      expect(await s.eggs.pendingOf(id)).to.equal(0); // consumed; 1h pause
      await warp(3600 + 60); // pause over
      expect(await s.eggs.pendingOf(id)).to.be.gt(0); // accruing again
    }
  });

  it("an uncaptured expired claim closes out losslessly: unlock, accrual intact, re-request works", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await warp(2 * 3600);
    const pending = await s.eggs.pendingOf(id);
    await s.sale.connect(alice).requestClaim([id]);
    const claimId = await s.sale.nextClaimId();
    await mine(300); // seed window passes uncaptured
    expect(Number(await s.sale.reqState(true, claimId))).to.equal(3);
    await s.sale.expireReq(true, claimId);
    expect(await s.eggs.claimPending(id)).to.equal(false);
    // the frozen request-time snapshot survived the whole window
    // untouched — nothing was lost or consumed (under the freeze the
    // pending window itself produces nothing, SPEC section 5)
    expect(await s.eggs.pendingOf(id)).to.be.gte(pending);
    expect(await s.eggs.pendingOf(id)).to.be.closeTo(pending, U("2"));
    const before = await s.token.balanceOf(alice.address);
    await requestAndSettleClaims(s, alice, [id]);
    expect(await s.token.balanceOf(alice.address)).to.be.gt(before);
  });

  it("cap: settlement at short headroom reverts and stays pending; burns free headroom and it pays in FULL", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await warp(24 * 3600);
    await s.sale.connect(alice).requestClaim([id]);
    const claimId = await s.sale.nextClaimId();
    const req = await s.sale.reqOf(true, claimId);
    // squeeze headroom below the locked amount via an impersonated system mint
    const saleAddr = await s.sale.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [saleAddr]);
    await s.deployer.sendTransaction({ to: saleAddr, value: U("1") });
    const saleSigner = await ethers.getSigner(saleAddr);
    const head = await s.token.headroom();
    await s.token.connect(saleSigner).mint(s.deployer.address, head - U("100"));
    expect(await s.token.headroom()).to.equal(U("100"));
    await mine(6);
    await expect(s.sale.settleReq(true, claimId)).to.be.revertedWith("cap exceeded");
    expect(Number(await s.sale.reqState(true, claimId))).to.equal(2); // still pending, nothing lost
    // burn 1,000 MAO (to DEAD) -> headroom frees -> settle pays in full
    await s.token.connect(s.deployer).transfer(DEAD, U("1000"));
    const before = await s.token.balanceOf(alice.address);
    await s.sale.settleReq(true, claimId);
    expect((await s.token.balanceOf(alice.address)) - before).to.equal(req.amount);
  });

  it("piggyback: an unrelated mint settles a queue-front claim once its seed is ready", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await giveId(s.registry, bob);
    await warp(2 * 3600);
    await s.sale.connect(alice).requestClaim([id]);
    await mine(6);
    const before = await s.token.balanceOf(alice.address);
    await mintEggIds(s, bob, 1); // bob's mint piggybacks the claim settlement
    expect(await s.token.balanceOf(alice.address)).to.be.gt(before);
    expect(Number(await s.sale.reqState(true, 1))).to.equal(4);
  });
});
