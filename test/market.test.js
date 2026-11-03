const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployStack, giveId, mintEggIds, warp, mine, balance, requestAndSettleClaims, hatchAndSettle, U } = require("./helpers");

describe("EggMarket — listings ride with the NFT state (hatched animals only)", function () {
  let s, alice, bob, carol;
  beforeEach(async function () {
    s = await deployStack();
    [, , alice, bob, carol] = s.signers;
    await giveId(s.registry, alice);
    await giveId(s.registry, bob);
    await s.eggs.connect(alice).setApprovalForAll(await s.market.getAddress(), true);
  });

  // Mint + hatch one egg for `user` and return its id as a live
  // animal. While bob/carol hold no animals, alice's hatches can
  // never be plundered (she is excluded from her own pool and no
  // other holder exists), so the animal always stays hers.
  async function hatchedAnimal(user) {
    const [id] = await mintEggIds(s, user, 1);
    await hatchAndSettle(s, user, id);
    const sp = Number(await s.eggs.speciesOf(id));
    expect(sp).to.be.gte(1).and.to.be.lte(5);
    return id;
  }

  it("list / buy / fee split: seller gets 97.5%, project wallet 2.5%", async function () {
    const id = await hatchedAnimal(alice);
    await s.market.connect(alice).list(id, U("1"));
    const projBefore = await balance(s.project.address);
    const aliceBefore = await balance(alice.address);
    await s.market.connect(bob).buy(id, { value: U("1") });
    expect(await s.eggs.ownerOf(id)).to.equal(bob.address);
    expect(await balance(s.project.address)).to.equal(projBefore + U("0.025"));
    expect(await balance(alice.address)).to.equal(aliceBefore + U("0.975"));
    const [seller, price] = await s.market.listingOf(id);
    expect(seller).to.equal(ethers.ZeroAddress);
    expect(price).to.equal(0);
  });

  it("all state rides with the NFT: pending MAO, patience and pause go to the buyer", async function () {
    const [eggId] = await mintEggIds(s, alice, 1);
    await warp(10 * 3600); // accrue ~10h of production as an egg, patience tier +10% pending
    const id = eggId;
    await hatchAndSettle(s, alice, id); // kept (see hatchedAnimal note); accrual folds at the egg rate
    const pendingBefore = await s.eggs.pendingOf(id);
    // the unit keeps producing at its animal rate while the list/buy
    // transactions mine: tolerances below are rate-aware (seconds of
    // production), the claim being tested is that nothing was
    // settled or skimmed by the sale itself
    const ratePerSec = (await s.eggs.currentRate(id)) / 86400n;
    await s.market.connect(alice).list(id, U("0.5"));
    await s.market.connect(bob).buy(id, { value: U("0.5") });
    // nothing was settled seller-side: pending is intact for the buyer
    expect(await s.eggs.pendingOf(id)).to.be.closeTo(pendingBefore, ratePerSec * 10n + U("0.01"));
    expect(await s.eggs.patienceMult(id)).to.equal(110);
    // buyer claims alice's accrual (with the patience bonus she built
    // up): the amount locks at his claim request and pays in full at
    // settlement — even if the unit dies on the roll
    const pendingAtRequest = await s.eggs.pendingOf(id);
    const bobBefore = await s.token.balanceOf(bob.address);
    await requestAndSettleClaims(s, bob, [id]);
    const got = (await s.token.balanceOf(bob.address)) - bobBefore;
    expect(got).to.be.closeTo((pendingAtRequest * 110n) / 100n, ratePerSec * 10n + U("0.05"));
    // and (if it survived) the claim pause is visible on the NFT
    if (!(await s.eggs.isDead(id))) {
      const info = await s.eggs.eggInfo(id);
      expect(info.producing).to.equal(false);
      expect(info.pauseRemaining).to.be.gt(3000n);
    }
  });

  it("cancel removes the listing; stale listings cannot execute", async function () {
    const id = await hatchedAnimal(alice);
    await s.market.connect(alice).list(id, U("1"));
    await s.market.connect(alice).cancel(id);
    await expect(s.market.connect(bob).buy(id, { value: U("1") })).to.be.revertedWith("no listing");
    // re-list, then transfer the NFT away: buy must fail, clean must work
    await s.market.connect(alice).list(id, U("1"));
    await s.eggs.connect(alice).transferFrom(alice.address, carol.address, id);
    await expect(s.market.connect(bob).buy(id, { value: U("1") })).to.be.revertedWith("stale listing");
    await s.market.connect(bob).cleanListing(id);
    const [seller] = await s.market.listingOf(id);
    expect(seller).to.equal(ethers.ZeroAddress);
  });

  it("revoking market approval wipes the seller's listings", async function () {
    const id1 = await hatchedAnimal(alice);
    const id2 = await hatchedAnimal(alice);
    await s.market.connect(alice).list(id1, U("1"));
    await s.market.connect(alice).list(id2, U("1"));
    expect((await s.market.listingsOf(alice.address)).length).to.equal(2);
    await s.eggs.connect(alice).setApprovalForAll(await s.market.getAddress(), false);
    expect((await s.market.listingsOf(alice.address)).length).to.equal(0);
  });

  it("an animal that enters a claim while listed cannot be bought; listing cleans up", async function () {
    const id = await hatchedAnimal(alice);
    await warp(2 * 3600); // some accrual to claim
    await s.market.connect(alice).list(id, U("1"));
    await s.sale.connect(alice).requestClaim([id]);
    await expect(s.market.connect(bob).buy(id, { value: U("1") })).to.be.revertedWith("claim pending");
    await s.market.connect(bob).cleanListing(id);
    const [seller] = await s.market.listingOf(id);
    expect(seller).to.equal(ethers.ZeroAddress);
  });

  it("underpayment and self-buy revert", async function () {
    const id = await hatchedAnimal(alice);
    await s.market.connect(alice).list(id, U("1"));
    await expect(s.market.connect(bob).buy(id, { value: U("0.5") })).to.be.revertedWith("underpaid");
    await expect(s.market.connect(alice).buy(id, { value: U("1") })).to.be.revertedWith("own listing");
  });

  it("listability: an unhatched egg can NOT be listed (transfers still work)", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await expect(s.market.connect(alice).list(id, U("1"))).to.be.revertedWith("not an animal");
    // the restriction is on market listing only: plain transfers fine
    await s.eggs.connect(alice).transferFrom(alice.address, bob.address, id);
    expect(await s.eggs.ownerOf(id)).to.equal(bob.address);
  });

  it("listability: an empty shell can NOT be listed, a hatched animal can (transfers of shells still work)", async function () {
    // Seed bob with an animal so an eligible plunderer exists, then
    // hatch fresh minters' eggs until one shells (~10% per hatch).
    const bobAnimal = await hatchedAnimal(bob);
    expect(await s.eggs.holderCount()).to.equal(1);
    let shell = null;
    for (let round = 0; round < 60 && !shell; round++) {
      const minter = s.actors[100 + round];
      await giveId(s.registry, minter);
      const [id] = await mintEggIds(s, minter, 1);
      await hatchAndSettle(s, minter, id);
      if (Number(await s.eggs.speciesOf(id)) === 6) shell = { minter, id };
    }
    expect(shell, "no shell in 60 hatches").to.not.equal(null);
    await s.eggs.connect(shell.minter).setApprovalForAll(await s.market.getAddress(), true);
    await expect(s.market.connect(shell.minter).list(shell.id, U("1"))).to.be.revertedWith("not an animal");
    // plain wallet-to-wallet transfer of the shell is still allowed
    await s.eggs.connect(shell.minter).transferFrom(shell.minter.address, carol.address, shell.id);
    expect(await s.eggs.ownerOf(shell.id)).to.equal(carol.address);
    // and a hatched animal lists fine in the same world state
    await s.eggs.connect(bob).setApprovalForAll(await s.market.getAddress(), true);
    await s.market.connect(bob).list(bobAnimal, U("1"));
    const [seller, price] = await s.market.listingOf(bobAnimal);
    expect(seller).to.equal(bob.address);
    expect(price).to.equal(U("1"));
  });
});
