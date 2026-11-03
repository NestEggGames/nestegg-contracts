const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  deployStack,
  giveId,
  mintEggIds,
  sellWithBuyers,
  driveToOpen,
  warp,
  mine,
  balance,
  DEAD,
  U,
} = require("./helpers");

/// Change I (user order 2026-11-03): if the pool has NOT opened
/// (egg #5,000 unsold) 7 days after startTime, Gen 0 minters can
/// surrender their units for a full refund of the net BNB paid.
/// The 20% project leg is escrowed in the sale pre-open (projectDue)
/// precisely so the full 100% is refundable; it is released to the
/// project wallet only in the pool-open transaction.
describe("Failed-launch refund — Gen 0 (7 days, pool unopened)", function () {
  let s, alice, bob;
  beforeEach(async function () {
    s = await deployStack();
    [, , alice, bob] = s.signers;
    await giveId(s.registry, alice);
    await giveId(s.registry, bob);
  });

  async function pastDeadline() {
    await warp(7 * 24 * 3600 + 60);
  }

  it("refundDeadline anchors to startTime + 7 days (deploy time when startTime = 0)", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    expect(await s.sale.refundDeadline()).to.be.closeTo(BigInt(now) + 7n * 24n * 3600n, 300n);
    expect(await s.sale.refundAvailable()).to.equal(false);
  });

  it("(1) before the deadline, refunds are unavailable even with the pool unopened", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await warp(6 * 24 * 3600); // day 6: not yet
    expect(await s.sale.refundAvailable()).to.equal(false);
    expect(await s.sale.refundableOf(id)).to.equal(0);
    await expect(s.sale.connect(alice).refundEggs([id])).to.be.revertedWith("no refund");
  });

  it("(2) past the deadline with < 5,000 sold: refundAvailable turns true and minting is closed forever", async function () {
    await mintEggIds(s, alice, 3);
    await pastDeadline();
    expect(await s.sale.refundAvailable()).to.equal(true);
    const [due] = await s.sale.quoteMint(1);
    await expect(s.sale.connect(alice).mint(1, 0, { value: due })).to.be.revertedWith("sale failed");
  });

  it("(3a) batch-sum identity: a batch's per-egg refund records sum EXACTLY to its net BNB paid", async function () {
    const [due] = await s.sale.quoteMint(10);
    const ids = await mintEggIds(s, alice, 10);
    await pastDeadline();
    let sum = 0n;
    for (const id of ids) {
      const r = await s.sale.refundableOf(id);
      expect(r).to.be.gt(0);
      sum += r;
    }
    expect(sum).to.equal(due);
  });

  it("(3b) refunding pays exactly the recorded BNB per unit; units die at DEAD; slots freed; counters unwind", async function () {
    const [due] = await s.sale.quoteMint(10);
    const ids = await mintEggIds(s, alice, 10);
    expect(await s.sale.genSold()).to.equal(10);
    await pastDeadline();
    // refund 4 of the 10 first
    const first = ids.slice(0, 4);
    let expectFirst = 0n;
    for (const id of first) expectFirst += await s.sale.refundableOf(id);
    const balBefore = await balance(alice.address);
    const tx = await s.sale.connect(alice).refundEggs(first);
    const rc = await tx.wait();
    expect((await balance(alice.address)) - balBefore + rc.gasUsed * rc.gasPrice).to.equal(expectFirst);
    expect(await s.sale.genSold()).to.equal(6); // Gen 0: genSold tracks gen0Sold here
    for (const id of first) {
      expect(await s.eggs.ownerOf(id)).to.equal(DEAD);
      expect(await s.eggs.isDead(id)).to.equal(true);
      expect(await s.sale.refundableOf(id)).to.equal(0);
    }
    expect(await s.sale.slotsUsed(alice.address, 0)).to.equal(6);
    // then the rest: the two payouts together equal the batch's net paid
    const rest = ids.slice(4);
    let expectRest = 0n;
    for (const id of rest) expectRest += await s.sale.refundableOf(id);
    expect(expectFirst + expectRest).to.equal(due);
    await s.sale.connect(alice).refundEggs(rest);
    expect(await s.sale.genSold()).to.equal(0);
    expect(await s.sale.slotsUsed(alice.address, 0)).to.equal(0);
    expect(await s.eggs.balanceOf(alice.address)).to.equal(0);
  });

  it("(4) non-owner cannot refund; a refunded unit cannot be refunded again", async function () {
    const [id] = await mintEggIds(s, alice, 1);
    await pastDeadline();
    await expect(s.sale.connect(bob).refundEggs([id])).to.be.revertedWith("not yours");
    await s.sale.connect(alice).refundEggs([id]);
    // the unit now sits at DEAD — alice no longer owns it
    await expect(s.sale.connect(alice).refundEggs([id])).to.be.revertedWith("not yours");
  });

  it("(5) failed launch: the project wallet received NOTHING — the escrowed 20% funds refunds", async function () {
    const projBefore = await balance(s.project.address);
    await mintEggIds(s, alice, 10);
    await mintEggIds(s, bob, 10);
    expect(await s.sale.projectDue()).to.be.gt(0); // the escrow accrued
    expect(await balance(s.project.address)).to.equal(projBefore);
    await pastDeadline();
    const ids = await s.eggs.unitsOf(alice.address);
    await s.sale.connect(alice).refundEggs(ids.map((x) => x));
    expect(await balance(s.project.address)).to.equal(projBefore); // still nothing
  });

  it("(clarification) species-agnostic: a HATCHED unit refunds for exactly the BNB paid for its egg", async function () {
    const [due] = await s.sale.quoteMint(1);
    const [id] = await mintEggIds(s, alice, 1);
    // hatch it first — whatever comes out (animal or shell), the
    // refund attaches to the NFT and the BNB paid, not the egg form
    await s.sale.connect(alice).requestHatch([id]);
    await mine(6);
    await s.sale.settleReq(false, 1);
    expect(await s.eggs.speciesOf(id)).to.be.gte(1); // no longer an egg
    await pastDeadline();
    expect(await s.sale.refundableOf(id)).to.equal(due); // single-egg batch: the whole net paid
    const balBefore = await balance(alice.address);
    const tx = await s.sale.connect(alice).refundEggs([id]);
    const rc = await tx.wait();
    expect((await balance(alice.address)) - balBefore + rc.gasUsed * rc.gasPrice).to.equal(due);
    expect(await s.eggs.ownerOf(id)).to.equal(DEAD);
  });

  it("(clarification 2) an empty SHELL refunds in full like any Gen 0 unit — and its refund frees NO slot (already released at plunder)", async function () {
    // seed bob with a hatched animal so an eligible plunderer exists,
    // then hatch fresh minters' eggs until one shells (~10% per hatch)
    const [bobEgg] = await mintEggIds(s, bob, 1);
    await s.sale.connect(bob).requestHatch([bobEgg]);
    await mine(6);
    await s.sale.settleReq(false, 1);
    expect(await s.eggs.holderCount()).to.equal(1);
    let shell = null;
    for (let round = 0; round < 60 && !shell; round++) {
      const minter = s.actors[100 + round];
      await giveId(s.registry, minter);
      const [id] = await mintEggIds(s, minter, 1);
      await s.sale.connect(minter).requestHatch([id]);
      const hid = await s.sale.nextHatchId();
      await mine(6);
      await s.sale.settleReq(false, hid);
      if (Number(await s.eggs.speciesOf(id)) === 6) shell = { minter, id };
    }
    expect(shell, "no shell in 60 hatches").to.not.equal(null);
    // the shell's slot was ALREADY released at plunder settlement
    expect(await s.eggs.slotHeldOf(shell.id)).to.equal(false);
    expect(await s.sale.slotsUsed(shell.minter.address, 0)).to.equal(0);
    await pastDeadline();
    expect(await s.sale.refundAvailable()).to.equal(true);
    const amount = await s.sale.refundableOf(shell.id);
    expect(amount).to.be.gt(0); // the full BNB recorded for its egg at mint
    const balBefore = await balance(shell.minter.address);
    const tx = await s.sale.connect(shell.minter).refundEggs([shell.id]);
    const rc = await tx.wait();
    expect((await balance(shell.minter.address)) - balBefore + rc.gasUsed * rc.gasPrice).to.equal(amount);
    expect(await s.eggs.ownerOf(shell.id)).to.equal(DEAD);
    expect(await s.eggs.isDead(shell.id)).to.equal(true);
    expect(await s.sale.refundableOf(shell.id)).to.equal(0);
    // ...and the refund released NOTHING further: no double-free
    expect(await s.sale.slotsUsed(shell.minter.address, 0)).to.equal(0);
  });

  it("(6) success path: the escrow releases in the open tx; post-open Gen 0 mints pay the project immediately", async function () {
    await sellWithBuyers(s, s.actors, 4990); // 499 buyers, pool still closed
    const escrowed = await s.sale.projectDue();
    expect(escrowed).to.be.gt(0);
    const projBefore = await balance(s.project.address);
    const opener = s.actors[999];
    await giveId(s.registry, opener);
    const [openDue] = await s.sale.quoteMint(10);
    await s.sale.connect(opener).mint(10, 0, { value: openDue + openDue / 100n });
    expect(await s.sale.poolOpened()).to.equal(true);
    // released in the open tx: everything escrowed + the opening
    // mint's own 20% leg
    expect(await s.sale.projectDue()).to.equal(0);
    expect(await balance(s.project.address)).to.equal(projBefore + escrowed + (openDue * 20n) / 100n);
    // a post-open Gen 0 mint pays its 20% immediately, as before
    const buyer = s.actors[998];
    await giveId(s.registry, buyer);
    const [due2] = await s.sale.quoteMint(10);
    const proj2 = await balance(s.project.address);
    await s.sale.connect(buyer).mint(10, 0, { value: due2 + due2 / 100n });
    expect(await balance(s.project.address)).to.equal(proj2 + (due2 * 20n) / 100n);
  });

  it("(7) pool opened before the deadline: warping past it does NOT enable refunds", async function () {
    await driveToOpen(s);
    expect(await s.sale.poolOpened()).to.equal(true);
    await pastDeadline();
    expect(await s.sale.refundAvailable()).to.equal(false);
    await expect(s.sale.connect(alice).refundEggs([1n])).to.be.revertedWith("no refund");
  });
});
