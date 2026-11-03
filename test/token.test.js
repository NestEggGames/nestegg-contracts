const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployStack, giveId, mintEggs, driveToOpen, mine, DEAD, U } = require("./helpers");

describe("MaoToken — identity, cap, taxes", function () {
  let s, alice, bob;
  beforeEach(async function () {
    s = await deployStack();
    [, , alice, bob] = s.signers;
  });

  it("has the right name, symbol and decimals (prototype-name guard)", async function () {
    // A past project shipped a prototype codename in the ERC20
    // constructor; this assertion exists so that can never pass a build.
    expect(await s.token.name()).to.equal("毛");
    expect(await s.token.symbol()).to.equal("MAO");
    expect(await s.token.decimals()).to.equal(18);
    expect(await s.token.HARD_CAP()).to.equal(U("3000000000"));
  });

  it("only the wired system can mint, and never above the 3B cap", async function () {
    await expect(s.token.connect(alice).mint(alice.address, 1)).to.be.revertedWith("not system");
    // Impersonate EggSale (the system) to reach the cap in one call.
    const saleAddr = await s.sale.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [saleAddr]);
    await s.deployer.sendTransaction({ to: saleAddr, value: U("1") });
    const saleSigner = await ethers.getSigner(saleAddr);
    await s.token.connect(saleSigner).mint(alice.address, U("3000000000"));
    expect(await s.token.totalSupply()).to.equal(U("3000000000"));
    expect(await s.token.circulating()).to.equal(U("3000000000"));
    expect(await s.token.headroom()).to.equal(0);
    await expect(s.token.connect(saleSigner).mint(alice.address, 1)).to.be.revertedWith("cap exceeded");
    // Burning (ordinary transfer to DEAD) frees production headroom:
    // the cap binds CIRCULATING supply, and DEAD's balance is the burn
    // counter (SPEC sections 1/6).
    await s.token.connect(alice).transfer(DEAD, U("100"));
    expect(await s.token.balanceOf(DEAD)).to.equal(U("100"));
    expect(await s.token.circulating()).to.equal(U("2999999900"));
    expect(await s.token.headroom()).to.equal(U("100"));
    await s.token.connect(saleSigner).mint(alice.address, U("100"));
    expect(await s.token.headroom()).to.equal(0);
    await expect(s.token.connect(saleSigner).mint(alice.address, 1)).to.be.revertedWith("cap exceeded");
  });

  it("predicted pair matches the factory-created pair", async function () {
    const pair = await s.factory.createPair(await s.token.getAddress(), await s.wbnb.getAddress());
    const pairAddr = await s.factory.getPair(await s.token.getAddress(), await s.wbnb.getAddress());
    expect(pairAddr).to.equal(await s.token.predictedPair());
  });

  it("gates transfers into the predicted pair before the pool opens", async function () {
    // Fund alice with MAO via a system mint (impersonated sale).
    const saleAddr = await s.sale.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [saleAddr]);
    await s.deployer.sendTransaction({ to: saleAddr, value: U("1") });
    const saleSigner = await ethers.getSigner(saleAddr);
    await s.token.connect(saleSigner).mint(alice.address, U("1000"));
    const predicted = await s.token.predictedPair();
    await expect(s.token.connect(alice).transfer(predicted, U("1"))).to.be.revertedWith("pair gated");
    // wallet-to-wallet is fine and untaxed pre-open
    await s.token.connect(alice).transfer(bob.address, U("100"));
    expect(await s.token.balanceOf(bob.address)).to.equal(U("100"));
  });

  describe("after pool open", function () {
    beforeEach(async function () {
      await driveToOpen(s);
    });

    it("buy tax: 1% burned + 1% to project (change A); sell tax: 1% DEAD + 1% project; transfers untaxed — measured AFTER the anti-snipe window", async function () {
      await mine(6); // past poolOpenBlock + 5: normal tax rules apply
      expect(await s.token.inSnipeWindow()).to.equal(false);
      const pairAddr = await s.sale.pair();
      const trader = s.actors[600];
      // BUY: trader swaps 1 BNB for MAO via the router (pair -> trader).
      const deadBefore = await s.token.balanceOf(DEAD);
      const projBefore = await s.token.balanceOf(s.project.address);
      await s.router.connect(trader).swapExactETHForTokens(0, [await s.wbnb.getAddress(), await s.token.getAddress()], trader.address, 9999999999, { value: U("1") });
      const got = await s.token.balanceOf(trader.address);
      expect(got).to.be.gt(0);
      // buy tax is now 1% burned + 1% to the project (mirrors the sell
      // side). Trader received 98% of gross, so gross ~= got*100/98 and
      // each leg ~= gross/100.
      const gross = (got * 100n) / 98n;
      const leg = gross / 100n;
      expect(await s.token.balanceOf(DEAD)).to.be.closeTo(deadBefore + leg, 2n);
      expect(await s.token.balanceOf(s.project.address)).to.be.closeTo(projBefore + leg, 2n);
      // post-window buys are not cap-tracked
      expect(await s.token.boughtInWindow(trader.address)).to.equal(0);

      // SELL: trader sends MAO back into the pair (trader -> pair).
      const dead2 = await s.token.balanceOf(DEAD);
      const proj2 = await s.token.balanceOf(s.project.address);
      await s.token.connect(trader).transfer(pairAddr, got);
      const sellLeg = got / 100n;
      expect(await s.token.balanceOf(DEAD)).to.equal(dead2 + sellLeg);
      expect(await s.token.balanceOf(s.project.address)).to.equal(proj2 + sellLeg);
      // pair received 98%
      expect(await s.token.balanceOf(trader.address)).to.equal(0);

      // wallet-to-wallet untaxed
      const t2 = s.actors[601];
      await s.router.connect(t2).swapExactETHForTokens(0, [await s.wbnb.getAddress(), await s.token.getAddress()], t2.address, 9999999999, { value: U("0.5") });
      const bal = await s.token.balanceOf(t2.address);
      await s.token.connect(t2).transfer(s.actors[602].address, bal / 2n);
      expect(await s.token.balanceOf(s.actors[602].address)).to.equal(bal / 2n);
    });

    it("anti-snipe window (first 5 blocks, H2): pair buys pay 10%, ALL burned, nothing to project, cumulative tracked", async function () {
      // the pool opened in driveToOpen's last mint — we are inside the
      // window right now (block-based, ~2.3 s on BSC)
      expect(await s.token.inSnipeWindow()).to.equal(true);
      const pairAddr = await s.sale.pair();
      const pair = await ethers.getContractAt("MockPair", pairAddr);
      const trader = s.actors[603];
      // exact mock output for 0.05 BNB from the pre-swap reserves
      const [r0, r1] = await pair.getReserves();
      const tokenAddr = await s.token.getAddress();
      const [maoRes, bnbRes] = (await pair.token0()) === tokenAddr ? [r0, r1] : [r1, r0];
      const out = (maoRes * U("0.05")) / (bnbRes + U("0.05"));
      expect(out).to.be.lt(U("200000")); // inside the cap: the buy itself is allowed
      const deadBefore = await s.token.balanceOf(DEAD);
      const projBefore = await s.token.balanceOf(s.project.address);
      await s.router.connect(trader).swapExactETHForTokens(0, [await s.wbnb.getAddress(), tokenAddr], trader.address, 9999999999, { value: U("0.05") });
      expect(await s.token.balanceOf(trader.address)).to.equal(out - out / 10n); // 90% kept
      expect(await s.token.balanceOf(DEAD)).to.equal(deadBefore + out / 10n); // 10% burned, in full
      expect(await s.token.balanceOf(s.project.address)).to.equal(projBefore); // project gets NOTHING on window buys
      expect(await s.token.boughtInWindow(trader.address)).to.equal(out); // tracked on the gross amount
    });

    it("anti-snipe cap: cumulative window buys past 200,000 MAO from the pair revert", async function () {
      const pairAddr = await s.sale.pair();
      await ethers.provider.send("hardhat_impersonateAccount", [pairAddr]);
      // fund the pair's gas by setBalance — a plain transfer would
      // revert (MockPair has no receive function)
      await ethers.provider.send("hardhat_setBalance", [pairAddr, "0x" + U("1").toString(16)]);
      const pairSigner = await ethers.getSigner(pairAddr);
      const buyer = s.actors[604];
      // 150,000 gross from the pair: under the cap (the buyer keeps
      // 135,000 after the 10% window tax)
      await s.token.connect(pairSigner).transfer(buyer.address, U("150000"));
      expect(await s.token.balanceOf(buyer.address)).to.equal(U("135000"));
      expect(await s.token.boughtInWindow(buyer.address)).to.equal(U("150000"));
      // 60,000 more would take the cumulative gross to 210,000 > cap
      await expect(s.token.connect(pairSigner).transfer(buyer.address, U("60000"))).to.be.revertedWith("snipe cap");
      // exactly to the cap is fine
      await s.token.connect(pairSigner).transfer(buyer.address, U("50000"));
      expect(await s.token.boughtInWindow(buyer.address)).to.equal(U("200000"));
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [pairAddr]);
    });

    it("from block poolOpenBlock + 5 on: no window, no cap, normal 2% buy tax (1 burn / 1 project)", async function () {
      await mine(6); // past the window
      expect(await s.token.inSnipeWindow()).to.equal(false);
      const pairAddr = await s.sale.pair();
      await ethers.provider.send("hardhat_impersonateAccount", [pairAddr]);
      // fund the pair's gas by setBalance — a plain transfer would
      // revert (MockPair has no receive function)
      await ethers.provider.send("hardhat_setBalance", [pairAddr, "0x" + U("1").toString(16)]);
      const pairSigner = await ethers.getSigner(pairAddr);
      const buyer = s.actors[605];
      const deadBefore = await s.token.balanceOf(DEAD);
      const projBefore = await s.token.balanceOf(s.project.address);
      // 300,000 gross — far past the window cap, but the window is over
      await s.token.connect(pairSigner).transfer(buyer.address, U("300000"));
      expect(await s.token.balanceOf(buyer.address)).to.equal(U("294000")); // 98% after 1% burn + 1% project
      expect(await s.token.balanceOf(DEAD)).to.equal(deadBefore + U("3000"));
      expect(await s.token.balanceOf(s.project.address)).to.equal(projBefore + U("3000"));
      expect(await s.token.boughtInWindow(buyer.address)).to.equal(0); // not tracked outside the window
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [pairAddr]);
    });

    it("system transfers are untaxed (buyback/LP accounting integrity)", async function () {
      const saleAddr = await s.sale.getAddress();
      const before = await s.token.balanceOf(DEAD);
      // move MAO pair-wards via a normal user first to give sale a balance:
      // simpler — claim-minted MAO: impersonate sale and move its own mint.
      await ethers.provider.send("hardhat_impersonateAccount", [saleAddr]);
      await s.deployer.sendTransaction({ to: saleAddr, value: U("1") });
      const saleSigner = await ethers.getSigner(saleAddr);
      await s.token.connect(saleSigner).mint(saleAddr, U("100"));
      await s.token.connect(saleSigner).transfer(DEAD, U("100"));
      expect(await s.token.balanceOf(DEAD)).to.equal(before + U("100"));
    });
  });
});
