const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployStack, giveId, mintEggs, driveToOpen, balance, DEAD, U } = require("./helpers");

describe("Pool open at egg #5,000 + post-open flows", function () {
  let s;
  before(async function () {
    s = await deployStack();
    await driveToOpen(s); // 500 buyers x 10 = 5,000 eggs; open fires in the last mint
  });

  it("opens inside the #5,000 mint at the $0.0015 anchor with LP burned to DEAD", async function () {
    expect(await s.sale.poolOpened()).to.equal(true);
    // the anti-snipe window anchor was latched on the token at the open
    expect(await s.token.poolOpenBlock()).to.be.gt(0);
    const pairAddr = await s.sale.pair();
    expect(pairAddr).to.equal(await s.token.predictedPair());
    expect(await s.token.officialPair()).to.equal(pairAddr);
    const pair = await ethers.getContractAt("MockPair", pairAddr);
    // Full-price Gen 0 to #5,000: gross $16,000, reserve 80% = $12,800
    // = 12,800/700 BNB; seed = 12,800 / 0.0015 = 8,533,333.33 MAO (< 10M cap).
    const [r0, r1] = await pair.getReserves();
    const wbnbAddr = await s.wbnb.getAddress();
    const [maoRes, bnbRes] = (await pair.token0()) === (await s.token.getAddress()) ? [r0, r1] : [r1, r0];
    const expectBnb = (U("12800") * 10n ** 8n) / 70000000000n;
    expect(bnbRes).to.be.closeTo(expectBnb, U("0.001"));
    const expectMao = (expectBnb * 1400000n) / 3n; // BNB * $700 / $0.0015, in MAO wei
    expect(maoRes).to.be.closeTo(expectMao, U("1000"));
    // implied price ~ $0.0015 (within the 0.5% anchor tolerance + rounding)
    const impliedUsd = (bnbRes * 700n * U("1")) / maoRes;
    expect(impliedUsd).to.be.closeTo(U("0.0015"), U("0.00001"));
    // LP went to DEAD, supply = seed exactly
    expect(await pair.balanceOf(DEAD)).to.be.gt(0);
    expect(await s.token.totalSupply()).to.equal(maoRes);
    expect(await s.sale.reserveBNB()).to.equal(0);
  });

  it("post-open mints split the 80% reserve: half buyback / half LP, executed on-chain", async function () {
    const buyer = s.actors[700];
    await giveId(s.registry, buyer);
    const pairAddr = await s.sale.pair();
    const pair = await ethers.getContractAt("MockPair", pairAddr);
    const deadMaoBefore = await s.token.balanceOf(DEAD);
    const deadLpBefore = await pair.balanceOf(DEAD);
    const lpSupplyBefore = await pair.totalSupply();
    // Post-open mint of 10 eggs (tier 3 @ $4 = $40): 20% project, 40%
    // buyback, 40% LP — all inside this one mint transaction.
    await mintEggs(s, buyer, 10);
    // buyback burned MAO to DEAD and/or LP add burned excess: DEAD MAO grew
    expect(await s.token.balanceOf(DEAD)).to.be.gt(deadMaoBefore);
    // LP was added with LP tokens to DEAD (pair supply grew). Note: a
    // raw sum of the two reserves is NOT a growth measure — the buyback
    // leg removes MAO while adding BNB — so growth is asserted on LP
    // supply, which only ever increases when liquidity is added.
    expect(await pair.balanceOf(DEAD)).to.be.gt(deadLpBefore);
    expect(await pair.totalSupply()).to.be.gt(lpSupplyBefore);
    // pots drained by the piggybacked execution (block cap: buyback may
    // legitimately leave a remainder when the pot exceeds 1% of pool BNB;
    // with a $16 pot vs ~18 BNB pool the 1% cap = 0.18 BNB >> pot, so
    // both pots fully execute here)
    expect(await s.sale.buybackPot()).to.equal(0);
    expect(await s.sale.lpPot()).to.equal(0);
  });

  it("buyback() is permissionless and burns bought MAO to DEAD", async function () {
    // Fund the buyback pot with a plain BNB transfer (receive() books it
    // post-open), then anyone can trigger.
    const saleAddr = await s.sale.getAddress();
    await s.deployer.sendTransaction({ to: saleAddr, value: U("0.05") });
    expect(await s.sale.buybackPot()).to.equal(U("0.05"));
    const deadBefore = await s.token.balanceOf(DEAD);
    await s.sale.connect(s.actors[701]).buyback();
    expect(await s.token.balanceOf(DEAD)).to.be.gt(deadBefore);
    expect(await s.sale.buybackPot()).to.equal(0);
  });

  it("pokePrice records at most one observation per block", async function () {
    const Harness = await ethers.getContractFactory("PokeTwiceHarness");
    const harness = await Harness.deploy();
    await expect(harness.twice(await s.sale.getAddress()))
      .to.be.revertedWith("poke once per block");
    // a single poke in a fresh block still works
    await s.sale.pokePrice();
    expect(await s.sale.lastPokeBlock()).to.be.gt(0);
  });
});
