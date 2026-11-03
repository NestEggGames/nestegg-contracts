const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployStack, giveId, mintEggs, mintEggIds, warp, balance, U } = require("./helpers");

describe("EggSale mint — gate, ladder, instant issuance, splits", function () {
  let s, alice, bob;
  beforeEach(async function () {
    s = await deployStack();
    [, , alice, bob] = s.signers;
  });

  it("issues eggs INSTANTLY in the mint transaction (no pending state)", async function () {
    await giveId(s.registry, alice);
    const ids = await mintEggIds(s, alice, 3);
    expect(await s.eggs.balanceOf(alice.address)).to.equal(3);
    for (const id of ids) {
      expect(await s.eggs.ownerOf(id)).to.equal(alice.address);
      const info = await s.eggs.eggInfo(id);
      expect(info.species).to.equal(0); // unhatched egg
      expect(info.gen).to.equal(0);
      expect(info.rateNow).to.equal(U("400")); // egg rate 400/day
      expect(info.producing).to.equal(true);
    }
    expect(await s.sale.genSold()).to.equal(3);
  });

  it("rejects wallets without an Agent ID, and with an empty handle", async function () {
    const [bnbDue] = await s.sale.quoteMint(1);
    await expect(s.sale.connect(alice).mint(1, 0, { value: bnbDue })).to.be.revertedWith("no agent id");
    await s.registry.giveEmptyHandle(bob.address); // holds an ID, but its handle reads back empty
    await expect(s.sale.connect(bob).mint(1, 0, { value: bnbDue })).to.be.revertedWith("no agent handle");
  });

  it("welds the handle to the first wallet that uses it", async function () {
    await s.registry.giveHandle(alice.address, "shared-handle");
    await mintEggs(s, alice, 1);
    // The ID moves to bob: same handle, different wallet -> rejected.
    await s.registry.moveId(alice.address, bob.address);
    const [bnbDue] = await s.sale.quoteMint(1);
    await expect(s.sale.connect(bob).mint(1, 0, { value: bnbDue })).to.be.revertedWith("agent id bound elsewhere");
  });

  it("enforces the Gen 0 wallet cap of 10 per generation — the ONLY count limit (no per-tx cap)", async function () {
    await giveId(s.registry, alice);
    // an 11-count mint from a fresh wallet fails on the GENERATION
    // CAP (10), not on any per-transaction limit — none exists
    const [due11] = await s.sale.quoteMint(10);
    await expect(s.sale.connect(alice).mint(11, 0, { value: due11 * 2n })).to.be.revertedWith("generation quota used");
    await mintEggs(s, alice, 10); // the full cap in one transaction is fine
    const [due1] = await s.sale.quoteMint(1);
    await expect(s.sale.connect(alice).mint(1, 0, { value: due1 })).to.be.revertedWith("generation quota used");
    // a zero-count mint is still rejected
    await expect(s.sale.connect(alice).mint(0, 0, { value: 0 })).to.be.revertedWith("bad count");
  });

  it("ladder: tier prices $2/$3/$4/$5 at the tier boundaries", async function () {
    // Feed is $700: 1 egg at $2 = 2/700 BNB.
    let [due] = await s.sale.quoteMint(1);
    expect(due).to.equal((U("2") * 10n ** 8n) / 70000000000n);
    // unit price view agrees
    expect(await s.sale.currentPriceUsd()).to.equal(U("2"));
    // 10 eggs all in tier 1 = $20
    [due] = await s.sale.quoteMint(10);
    expect(due).to.equal((U("20") * 10n ** 8n) / 70000000000n);
  });

  it("pre-open split escrows the 20% project leg in projectDue (released at pool open); 80% to the reserve; refunds overpay", async function () {
    await giveId(s.registry, alice);
    const [due] = await s.sale.quoteMint(10);
    const projBefore = await balance(s.project.address);
    const aliceBefore = await balance(alice.address);
    const overpay = U("0.1");
    const tx = await s.sale.connect(alice).mint(10, 0, { value: due + overpay });
    const receipt = await tx.wait();
    const gas = receipt.gasUsed * receipt.gasPrice;
    // pre-open the project leg is ESCROWED in the sale (change I: a
    // failed launch must be able to refund 100%) — the project wallet
    // receives nothing until the pool opens
    expect(await balance(s.project.address)).to.equal(projBefore);
    expect(await s.sale.projectDue()).to.equal((due * 20n) / 100n);
    expect(await s.sale.reserveBNB()).to.equal(due - (due * 20n) / 100n);
    // alice paid exactly `due` + gas: the overpay came back in the same tx
    expect(await balance(alice.address)).to.equal(aliceBefore - due - gas);
  });

  it("underpayment reverts", async function () {
    await giveId(s.registry, alice);
    const [due] = await s.sale.quoteMint(1);
    await expect(s.sale.connect(alice).mint(1, 0, { value: due - 1n })).to.be.revertedWith("underpaid");
  });
});

describe("Idle-decay ratchet", function () {
  let s, alice, bob, carol;
  beforeEach(async function () {
    s = await deployStack();
    [, , alice, bob, carol] = s.signers;
    for (const u of [alice, bob, carol]) await giveId(s.registry, u);
  });

  async function sellToTier2() {
    // Sell 1,000 eggs (tier 1) with 100 buyers x 10 to enter tier 2 ($3).
    const buyers = s.actors.slice(10, 110);
    for (const b of buyers) {
      await giveId(s.registry, b);
      await mintEggs(s, b, 10);
    }
    expect(await s.sale.genSold()).to.equal(1000);
    expect(await s.sale.currentPriceUsd()).to.equal(U("3"));
  }

  it("5 idle minutes step the price down one tier; it stays down after a mint", async function () {
    await sellToTier2();
    await warp(5 * 60 + 5);
    expect(await s.sale.currentPriceUsd()).to.equal(U("2")); // $3 tier decayed to $2
    // a mint at the decayed price does NOT restore it
    await mintEggs(s, alice, 1);
    expect(await s.sale.currentPriceUsd()).to.equal(U("2"));
    // another idle 5 min: floor is tier 1 price, stays $2
    await warp(5 * 60 + 5);
    expect(await s.sale.currentPriceUsd()).to.equal(U("2"));
  });

  it("repeated idle steps down multiple tiers to the $2 floor", async function () {
    // Reach tier 3 ($4): sell 3,000 with 300 buyers.
    const buyers = s.actors.slice(10, 310);
    for (const b of buyers) {
      await giveId(s.registry, b);
      await mintEggs(s, b, 10);
    }
    expect(await s.sale.currentPriceUsd()).to.equal(U("4"));
    await warp(5 * 60 + 5);
    expect(await s.sale.currentPriceUsd()).to.equal(U("3")); // one step
    await warp(5 * 60 + 5);
    expect(await s.sale.currentPriceUsd()).to.equal(U("2")); // two steps
    await warp(15 * 60 + 5);
    expect(await s.sale.currentPriceUsd()).to.equal(U("2")); // floor
  });

  it("a mint before 5 minutes keeps the full tier price", async function () {
    await sellToTier2();
    await warp(4 * 60 + 59);
    expect(await s.sale.currentPriceUsd()).to.equal(U("3"));
  });

  it("crossing into the next tier resets to full price with decay cleared", async function () {
    await sellToTier2(); // in tier 2 at $3, genSold = 1000
    await warp(5 * 60 + 5);
    expect(await s.sale.currentPriceUsd()).to.equal(U("2")); // decayed
    // Sell the remaining 2,000 tier-2 eggs (200 buyers) at decayed prices,
    // then the next egg is tier 3 at FULL $4.
    const buyers = s.actors.slice(200, 400);
    for (const b of buyers) {
      await giveId(s.registry, b);
      await mintEggs(s, b, 10);
    }
    expect(await s.sale.genSold()).to.equal(3000);
    expect(await s.sale.currentPriceUsd()).to.equal(U("4"));
    // and decay restarts from the new tier
    await warp(5 * 60 + 5);
    expect(await s.sale.currentPriceUsd()).to.equal(U("3"));
  });

  it("a batch crossing a tier boundary charges old-tier price then new-tier full price", async function () {
    // genSold = 995: next batch of 10 = 5 eggs @ $2 + 5 eggs @ $3 = $25.
    const buyers = s.actors.slice(10, 109); // 99 buyers x 10 = 990
    for (const b of buyers) {
      await giveId(s.registry, b);
      await mintEggs(s, b, 10);
    }
    await mintEggs(s, alice, 5); // genSold = 995
    const [, , usd] = await s.sale.quoteMint(10);
    expect(usd).to.equal(U("25"));
  });
});

describe("EggSale start gate (startTime)", function () {
  it("mint reverts before startTime and opens once startTime is reached", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const start = now + 3600;
    const s2 = await deployStack(start);
    expect(await s2.sale.startTime()).to.equal(start);
    const alice = s2.signers[2];
    await giveId(s2.registry, alice);
    const [bnbDue] = await s2.sale.quoteMint(1);
    await expect(s2.sale.connect(alice).mint(1, 0, { value: bnbDue })).to.be.revertedWith("not started");
    await warp(3601);
    await mintEggs(s2, alice, 1);
    expect(await s2.eggs.balanceOf(alice.address)).to.equal(1);
  });
});
