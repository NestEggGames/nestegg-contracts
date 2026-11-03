const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployStack, giveId, mintEggs, mintEggIds, sellWithBuyers, warp, DEAD, U } = require("./helpers");

/// Impersonate EggSale (the only caller EggNFT.killUnit accepts) and
/// kill a unit through the real claim-death teardown path — the same
/// _teardown + onSlotRelease slot hook production deaths use. (The old
/// burnUnit helper path was deleted with the add-on hook, change C;
/// killUnit is also what the failed-launch refund uses.)
async function killAsSale(s, tokenId) {
  const saleAddr = await s.sale.getAddress();
  await ethers.provider.send("hardhat_impersonateAccount", [saleAddr]);
  await s.deployer.sendTransaction({ to: saleAddr, value: U("1") });
  const saleSigner = await ethers.getSigner(saleAddr);
  await s.eggs.connect(saleSigner).killUnit(tokenId);
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [saleAddr]);
}

describe("Mint slots (pen semantics) — death frees the minter's slot", function () {
  let s, alice, bob;
  beforeEach(async function () {
    s = await deployStack();
    [, , alice, bob] = s.signers;
    await giveId(s.registry, alice);
    await giveId(s.registry, bob);
  });

  it("minting takes slots; the cap binds on alive self-minted units", async function () {
    await mintEggIds(s, alice, 10);
    expect(await s.sale.slotsUsed(alice.address, 0)).to.equal(10);
    expect(await s.sale.totalMintedInGen(alice.address, 0)).to.equal(10);
    const [due] = await s.sale.quoteMint(1);
    await expect(s.sale.connect(alice).mint(1, 0, { value: due })).to.be.revertedWith("generation quota used");
  });

  it("death of a self-minted unit frees the slot; the minter can mint again", async function () {
    const ids = await mintEggIds(s, alice, 10);
    await killAsSale(s, ids[0]);
    expect(await s.sale.slotsUsed(alice.address, 0)).to.equal(9);
    expect(await s.sale.totalMintedInGen(alice.address, 0)).to.equal(10); // history unchanged
    // killUnit is the claim-death path: the NFT is NOT burned — it
    // rests at DEAD, flagged dead (ownerOf resolves, unlike a burn)
    expect(await s.eggs.ownerOf(ids[0])).to.equal(DEAD);
    expect(await s.eggs.isDead(ids[0])).to.equal(true);
    await mintEggIds(s, alice, 1); // freed slot is usable while Gen 0 is on sale
    expect(await s.sale.slotsUsed(alice.address, 0)).to.equal(10);
  });

  it("transfers never free slots — the slot follows the minter, not the owner", async function () {
    const ids = await mintEggIds(s, alice, 10);
    await s.eggs.connect(alice).transferFrom(alice.address, bob.address, ids[0]);
    expect(await s.sale.slotsUsed(alice.address, 0)).to.equal(10); // sale did not free it
    const [due] = await s.sale.quoteMint(1);
    await expect(s.sale.connect(alice).mint(1, 0, { value: due })).to.be.revertedWith("generation quota used");
    // bob owns it now, but its death still frees ALICE's slot
    await killAsSale(s, ids[0]);
    expect(await s.sale.slotsUsed(alice.address, 0)).to.equal(9);
    expect(await s.sale.slotsUsed(bob.address, 0)).to.equal(0);
    await mintEggIds(s, alice, 1);
    expect(await s.sale.slotsUsed(alice.address, 0)).to.equal(10);
  });

  it("onSlotRelease cannot be called by anyone but the NFT contract", async function () {
    await expect(s.sale.connect(alice).onSlotRelease(1, alice.address, 0)).to.be.revertedWith("only eggs");
  });
});

describe("Generations — Gen 1+ fixed MAO ladder (gradient removed)", function () {
  it("GEN_MAO_LADDER holds the fixed segment prices 800/1200/1600/2000", async function () {
    const s = await deployStack();
    expect(await s.sale.GEN_MAO_LADDER(0)).to.equal(U("800"));
    expect(await s.sale.GEN_MAO_LADDER(1)).to.equal(U("1200"));
    expect(await s.sale.GEN_MAO_LADDER(2)).to.equal(U("1600"));
    expect(await s.sale.GEN_MAO_LADDER(3)).to.equal(U("2000"));
  });

  describe("Gen 1 end-to-end", function () {
    let s, buyer;
    before(async function () {
      s = await deployStack();
      // Sell out Gen 0: 1,000 buyers x 10. Pool opens at #5,000 midway.
      await sellWithBuyers(s, s.actors, 10000);
      expect(await s.sale.currentGen()).to.equal(1);
      expect(await s.sale.genSold()).to.equal(0);
      buyer = s.actors[0]; // a Gen 0 buyer: quota must be reset for Gen 1
      // Give the buyer MAO: swap 2 BNB on the pool.
      await s.router.connect(buyer).swapExactETHForTokens(
        0,
        [await s.wbnb.getAddress(), await s.token.getAddress()],
        buyer.address,
        9999999999,
        { value: U("2") }
      );
      await s.token.connect(buyer).approve(await s.sale.getAddress(), U("1000000"));
    });

    it("Gen 0 veterans can mint again in Gen 1 (per-generation quota)", async function () {
      expect(await s.sale.slotsUsed(buyer.address, 0)).to.equal(10);
      expect(await s.sale.slotsUsed(buyer.address, 1)).to.equal(0);
    });

    it("quote: zero BNB, MAO ladder price, no USD component", async function () {
      const [bnbDue, maoDue, usd] = await s.sale.quoteMint(10);
      expect(bnbDue).to.equal(0);
      expect(maoDue).to.equal(U("8000")); // segment 1: 10 x 800 MAO
      expect(usd).to.equal(0);
      expect(await s.sale.currentPriceUsd()).to.equal(0); // USD pricing is Gen 0 only
      expect(await s.sale.currentPriceMao()).to.equal(U("800"));
    });

    it("mint pays MAO only: 90% burned to DEAD, 10% swapped to BNB into the buyback/LP pots (change B); project gets no MAO, no BNB", async function () {
      // expected BNB output of the 10% leg (800 MAO) at the mock
      // router's constant-product rate, from the pre-mint reserves
      const pair = await ethers.getContractAt("MockPair", await s.sale.pair());
      const [r0, r1] = await pair.getReserves();
      const tokenAddr = await s.token.getAddress();
      const [maoRes, wbnbRes] = (await pair.token0()) === tokenAddr ? [r0, r1] : [r1, r0];
      const expectedOut = (wbnbRes * U("800")) / (maoRes + U("800"));
      const deadBefore = await s.token.balanceOf(DEAD);
      const projMaoBefore = await s.token.balanceOf(s.project.address);
      const buyerMaoBefore = await s.token.balanceOf(buyer.address);
      const projBnbBefore = await ethers.provider.getBalance(s.project.address);
      const lpPotBefore = await s.sale.lpPot();
      const bbPotBefore = await s.sale.buybackPot();
      const [bnbDue] = await s.sale.quoteMint(10);
      const value = bnbDue + bnbDue / 100n + 1000n; // mirrors helpers.mintEggs
      const tx = await s.sale.connect(buyer).mint(10, U("8000"), { value });
      const rc = await tx.wait();
      const minted = rc.logs
        .map((l) => {
          try {
            return s.sale.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "Minted");
      expect(minted.args.bnbPaid).to.equal(0); // no BNB leg at all
      expect(minted.args.maoPaid).to.equal(U("8000"));
      const deadDelta = (await s.token.balanceOf(DEAD)) - deadBefore;
      // the exact 90% burn leg (7,200) landed in the mint tx; the
      // piggybacked buyback/LP execution of the converted leg can only
      // add burns on top, never as much as the leg itself was worth
      expect(deadDelta).to.be.gte(U("7200"));
      expect(deadDelta).to.be.lt(U("8000"));
      // the old 1% MAO skim is GONE: the project wallet's MAO is untouched
      expect(await s.token.balanceOf(s.project.address)).to.equal(projMaoBefore);
      expect(await s.token.balanceOf(buyer.address)).to.equal(buyerMaoBefore - U("8000"));
      // the swapped BNB went to the pots (half / rest) — measured as
      // DELTAS, since the pots already hold accumulated Gen 0 money
      // that this mint's piggyback may also spend: the combined delta
      // can never exceed this mint's swap output
      const bbDelta = (await s.sale.buybackPot()) - bbPotBefore;
      const lpDelta = (await s.sale.lpPot()) - lpPotBefore;
      expect(bbDelta).to.be.lte(expectedOut / 2n + 1n);
      expect(bbDelta + lpDelta).to.be.lte(expectedOut);
      // the sale holds no MAO after disposing of the payment
      expect(await s.token.balanceOf(await s.sale.getAddress())).to.equal(0);
      // no 20% project split on Gen 1+: the project wallet received no BNB
      expect(await ethers.provider.getBalance(s.project.address)).to.equal(projBnbBefore);
      const info = await s.eggs.eggInfo((await s.eggs.nextId()) - 9n);
      expect(info.gen).to.equal(1);
      expect(await s.sale.slotsUsed(buyer.address, 1)).to.equal(10);
    });

    it("MaoConverter is sale-only: a holder cannot use it as a tax-free sell rail", async function () {
      // the converter is trade-tax exempt (its leg into the pair is
      // EggSale's own leg by proxy), so a public entry point would
      // let any holder sell MAO for BNB bypassing the 2% sell tax —
      // it must reject everyone but the wired EggSale
      await s.token.connect(buyer).approve(await s.converter.getAddress(), U("800"));
      await expect(s.converter.connect(buyer).swapMaoToBnb(U("800"), 0)).to.be.revertedWith("only sale");
      // and the one-time wiring latch is consumed: not even the
      // deployer can re-point the converter at another caller
      await expect(s.converter.connect(s.deployer).setSale(buyer.address)).to.be.revertedWith("sale set");
    });

    it("Gen 1+ wallet cap is 20 (FINAL) and is the ONLY count limit: any count up to the remaining cap mints in one tx", async function () {
      expect(await s.sale.maxPerGen(0)).to.equal(10);
      expect(await s.sale.maxPerGen(1)).to.equal(20);
      expect(await s.sale.maxPerGen(9)).to.equal(20);
      const b = s.actors[4];
      await giveId(s.registry, b);
      await s.router.connect(b).swapExactETHForTokens(
        0,
        [await s.wbnb.getAddress(), await s.token.getAddress()],
        b.address,
        9999999999,
        { value: U("2") }
      );
      await s.token.connect(b).approve(await s.sale.getAddress(), U("1000000"));
      // 15 in one transaction — no per-transaction cap interferes
      const [, mao15] = await s.sale.quoteMint(15);
      await s.sale.connect(b).mint(15, mao15, { value: 0 });
      expect(await s.sale.slotsUsed(b.address, 1)).to.equal(15);
      // 6 more would exceed the remaining 5: reverts on the
      // GENERATION QUOTA, not on any tx limit
      const [, mao6] = await s.sale.quoteMint(6);
      await expect(s.sale.connect(b).mint(6, mao6, { value: 0 })).to.be.revertedWith("generation quota used");
      // exactly the remaining 5 works
      const [, mao5] = await s.sale.quoteMint(5);
      await s.sale.connect(b).mint(5, mao5, { value: 0 });
      expect(await s.sale.slotsUsed(b.address, 1)).to.equal(20);
      expect(await s.sale.totalMintedInGen(b.address, 1)).to.equal(20);
      // cap full: even 1 more reverts on quota
      const [, mao1] = await s.sale.quoteMint(1);
      await expect(s.sale.connect(b).mint(1, mao1, { value: 0 })).to.be.revertedWith("generation quota used");
    });

    it("BNB sent with a Gen 1+ mint is refunded in full", async function () {
      const b3 = s.actors[2];
      await s.router.connect(b3).swapExactETHForTokens(
        0,
        [await s.wbnb.getAddress(), await s.token.getAddress()],
        b3.address,
        9999999999,
        { value: U("2") }
      );
      await s.token.connect(b3).approve(await s.sale.getAddress(), U("1000000"));
      const balBefore = await ethers.provider.getBalance(b3.address);
      await s.sale.connect(b3).mint(1, U("800"), { value: U("0.05") });
      const balAfter = await ethers.provider.getBalance(b3.address);
      expect(balBefore - balAfter).to.be.lt(U("0.001")); // only gas was spent
    });

    it("maxMaoPayable below the ladder price reverts the mint", async function () {
      const b2 = s.actors[1];
      await s.router.connect(b2).swapExactETHForTokens(
        0,
        [await s.wbnb.getAddress(), await s.token.getAddress()],
        b2.address,
        9999999999,
        { value: U("2") }
      );
      await s.token.connect(b2).approve(await s.sale.getAddress(), U("1000000"));
      await expect(s.sale.connect(b2).mint(10, U("8000") - 1n, { value: 0 })).to.be.revertedWith(
        "mao leg above max payable"
      );
      await s.sale.connect(b2).mint(10, U("8000"), { value: 0 });
      expect(await s.eggs.balanceOf(b2.address)).to.be.gte(10);
    });

    it("the MAO ladder walks segments and idle-decays like Gen 0", async function () {
      const saleAddr = await s.sale.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [saleAddr]);
      await s.deployer.sendTransaction({ to: saleAddr, value: U("1") });
      const saleSigner = await ethers.getSigner(saleAddr);
      // 100 funded buyers x 10 eggs = the whole 800-MAO segment (1,000)
      for (let i = 100; i < 200; i++) {
        const b = s.actors[i];
        await giveId(s.registry, b);
        await s.token.connect(saleSigner).mint(b.address, U("12000"));
        await s.token.connect(b).approve(saleAddr, U("12000"));
        const [, maoDue] = await s.sale.quoteMint(10); // batches cost 8,000 / 8,400 (straddle) / 12,000 (segment 2)
        await s.sale.connect(b).mint(10, maoDue, { value: 0 });
      }
      // a fresh buyer with exactly 800 MAO, for the decayed-price mint
      const late = s.actors[300];
      await s.token.connect(saleSigner).mint(late.address, U("800"));
      await s.token.connect(late).approve(saleAddr, U("800"));
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [saleAddr]);
      expect(await s.sale.genSold()).to.be.gte(1000);
      // segment 2: full price 1,200 (crossing reset the ladder)
      expect(await s.sale.currentPriceMao()).to.equal(U("1200"));
      const [, maoSeg2] = await s.sale.quoteMint(1);
      expect(maoSeg2).to.equal(U("1200"));
      // 5 idle minutes: the MAO ladder steps down one tier to 800
      await warp(6 * 60);
      expect(await s.sale.currentPriceMao()).to.equal(U("800"));
      // a mint at the stepped-down price does NOT restore it
      const deadBefore = await s.token.balanceOf(DEAD);
      const projBefore = await s.token.balanceOf(s.project.address);
      await s.sale.connect(late).mint(1, U("800"), { value: 0 });
      const deadDelta = (await s.token.balanceOf(DEAD)) - deadBefore;
      expect(deadDelta).to.be.gte(U("720")); // the 90% burn leg of the 800 charged, not 1,200
      expect(deadDelta).to.be.lt(U("800")); // the 10% leg was swapped to the pots, not burned
      expect(await s.token.balanceOf(s.project.address)).to.equal(projBefore); // no MAO skim anymore
      expect(await s.sale.currentPriceMao()).to.equal(U("800")); // still stepped down
    });
  });

  describe("Gen 2 uses the identical ladder", function () {
    it("Gen 1 sellout burns >= 14.4M (the 90% legs) and converts the 10% legs to the BNB pots — project gets no MAO; Gen 2 quotes the same ladder from 800", async function () {
      const s = await deployStack();
      await sellWithBuyers(s, s.actors, 10000); // Gen 0 sold out
      expect(await s.sale.currentGen()).to.equal(1);
      const deadAtGen1 = await s.token.balanceOf(DEAD);
      const projAtGen1 = await s.token.balanceOf(s.project.address);
      const saleAddr = await s.sale.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [saleAddr]);
      await s.deployer.sendTransaction({ to: saleAddr, value: U("1") });
      // the impersonated sale pays gas for 1,000 token.mint calls out
      // of its own balance while the pots drain by design — top the
      // balance up so the plumbing never starves (test-only concern;
      // on mainnet nothing impersonates the sale)
      await ethers.provider.send("hardhat_setBalance", [saleAddr, "0x" + U("10000").toString(16)]);
      const saleSigner = await ethers.getSigner(saleAddr);
      // the same 1,000 wallets buy Gen 1 (quota reset); 20,000 MAO
      // covers any segment's 10-egg batch (max 10 x 2,000)
      for (let i = 0; i < 1000; i++) {
        const b = s.actors[i];
        await s.token.connect(saleSigner).mint(b.address, U("20000"));
        await s.token.connect(b).approve(saleAddr, U("20000"));
        const [, maoDue] = await s.sale.quoteMint(10);
        await s.sale.connect(b).mint(10, maoDue, { value: 0 });
      }
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [saleAddr]);
      expect(await s.sale.currentGen()).to.equal(2);
      expect(await s.sale.genSold()).to.equal(0);
      // the ladder charges exactly 16,000,000 MAO per generation
      // (1000x800 + 2000x1200 + 3000x1600 + 4000x2000): 90%
      // (14,400,000) is burned by the split and 10% (1,600,000) is
      // converted to BNB for the buyback/LP pots (whose own burns
      // only add to the DEAD side); the project wallet receives NO MAO
      expect((await s.token.balanceOf(s.project.address)) - projAtGen1).to.equal(0);
      expect((await s.token.balanceOf(DEAD)) - deadAtGen1).to.be.gte(U("14400000"));
      const [bnbDue, maoDue, usd] = await s.sale.quoteMint(10);
      expect(bnbDue).to.equal(0);
      expect(maoDue).to.equal(U("8000")); // Gen 2 starts at segment 1: 10 x 800
      expect(usd).to.equal(0);
      expect(await s.sale.currentPriceMao()).to.equal(U("800"));
    });
  });
});

describe("Generation cap — 10 generations (100,000 eggs), then finished forever", function () {
  it("MAX_GENERATION is 9 (Gen 0..Gen 9) and the sale starts unfinished", async function () {
    const s = await deployStack();
    expect(await s.sale.MAX_GENERATION()).to.equal(9);
    expect(await s.sale.saleFinished()).to.equal(false);
  });

  it("selling out Gen 9 latches saleFinished: no Gen 10 ever opens and mint reverts", async function () {
    // This test sells all 100,000 eggs through the real mint path —
    // the cap proof must not shortcut it. On the in-memory chain the
    // per-mint cost grows with total state, so the default 20-minute
    // mocha timeout is too small; this test gets its own budget.
    this.timeout(7_200_000);
    const s = await deployStack();
    // Gen 0: 1,000 buyers x 10 (BNB ladder, pool opens midway).
    await sellWithBuyers(s, s.actors, 10000);
    expect(await s.sale.currentGen()).to.equal(1);
    expect(await s.sale.saleFinished()).to.equal(false);
    // Fund 500 buyers once for ALL MAO generations: worst case per
    // generation is 20 eggs x 2,000 MAO = 40,000, so 400,000 covers
    // Gens 1..9 with headroom. Funding is a system mint via
    // impersonation (test-only, same pattern as the Gen 2 test).
    const saleAddr = await s.sale.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [saleAddr]);
    await s.deployer.sendTransaction({ to: saleAddr, value: U("1") });
    const saleSigner = await ethers.getSigner(saleAddr);
    const buyers = s.actors.slice(0, 500);
    for (const b of buyers) {
      await s.token.connect(saleSigner).mint(b.address, U("400000"));
      await s.token.connect(b).approve(saleAddr, U("400000"));
    }
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [saleAddr]);
    // Gens 1..9: 500 buyers x 20 eggs in a single transaction each.
    for (let g = 1; g <= 9; g++) {
      for (const b of buyers) {
        const [, maoDue] = await s.sale.quoteMint(20);
        await s.sale.connect(b).mint(20, maoDue, { value: 0 });
      }
      if (g < 9) {
        expect(await s.sale.currentGen()).to.equal(g + 1);
        expect(await s.sale.genSold()).to.equal(0);
        expect(await s.sale.saleFinished()).to.equal(false);
      }
    }
    // Final state: still "in" Gen 9, full and finished forever —
    // the generation counter never advances past MAX_GENERATION.
    expect(await s.sale.currentGen()).to.equal(9);
    expect(await s.sale.currentGen()).to.equal(await s.sale.MAX_GENERATION());
    expect(await s.sale.genSold()).to.equal(10000);
    expect(await s.sale.saleFinished()).to.equal(true);
    expect(await s.eggs.nextId()).to.equal(100000);
    // price views reflect the finished state
    expect(await s.sale.currentPriceMao()).to.equal(0);
    expect(await s.sale.currentPriceUsd()).to.equal(0);
    // no Gen 10: any further mint reverts, for any wallet
    await expect(s.sale.connect(buyers[0]).mint(1, U("100000"), { value: 0 })).to.be.revertedWith("sale finished");
    await expect(s.sale.connect(buyers[499]).mint(20, U("100000"), { value: 0 })).to.be.revertedWith("sale finished");
  });
});
