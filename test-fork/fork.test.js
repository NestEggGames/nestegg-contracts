const { expect } = require("chai");
const { ethers } = require("hardhat");

// Fork tests against the REAL BSC mainnet contracts (pinned block):
// PancakeSwap V2 factory/router, WBNB, Chainlink BNB/USD feed and the
// SPACE ID Agent ID registry — all verified from chain at build time
// (see BUILD-NOTES). The buyer is a real Agent ID holder (handle
// "mars"), impersonated on the fork.
const FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const FEED = "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE";
const REGISTRY = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";
const INIT_HASH = "0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const MARS = "0x66088f823D6001cf96cD5E11F979e7855dB3b406";
const U = (n) => ethers.parseEther(n.toString());

async function setSlot(addr, slot, value) {
  const slotHex = typeof slot === "string" ? slot : ethers.toBeHex(slot);
  await ethers.provider.send("hardhat_setStorageAt", [
    addr,
    slotHex,
    ethers.zeroPadValue(ethers.toBeHex(value), 32),
  ]);
}
async function getSlot(addr, slot) {
  return BigInt(await ethers.provider.getStorage(addr, slot));
}

describe("FORK — real BSC integrations", function () {
  let deployer, project, token, eggs, sale, mars, saleAddr;
  let soldSlots = []; // storage slots of genSold / gen0Sold, discovered by diffing
  let quotaSlot = null; // storage slot of slotsUsed[mars][0]

  before(async function () {
    [deployer, project] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MaoToken");
    token = await Token.deploy(project.address, FACTORY, WBNB, INIT_HASH);
    const Eggs = await ethers.getContractFactory("EggNFT");
    eggs = await Eggs.deploy();
    const Converter = await ethers.getContractFactory("MaoConverter");
    const converter = await Converter.deploy(await token.getAddress(), ROUTER);
    const Sale = await ethers.getContractFactory("EggSale");
    sale = await Sale.deploy(
      await token.getAddress(),
      await eggs.getAddress(),
      REGISTRY,
      FEED,
      ROUTER,
      FACTORY,
      project.address,
      0
    );
    saleAddr = await sale.getAddress();
    const Market = await ethers.getContractFactory("EggMarket");
    const market = await Market.deploy(await eggs.getAddress(), project.address);
    await token.setSystem(saleAddr);
    await token.setConverter(await converter.getAddress());
    await converter.setSale(saleAddr);
    await eggs.setSale(saleAddr);
    await eggs.setMarket(await market.getAddress());

    await ethers.provider.send("hardhat_impersonateAccount", [MARS]);
    await ethers.provider.send("hardhat_setBalance", [MARS, "0x" + U("1000").toString(16)]);
    mars = await ethers.getSigner(MARS);
  });

  it("real Chainlink feed drives the quote", async function () {
    const feed = await ethers.getContractAt(
      ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"],
      FEED
    );
    const [, answer] = await feed.latestRoundData();
    expect(answer).to.be.gt(100n * 10n ** 8n).and.lt(2000n * 10n ** 8n);
    expect(await sale.bnbUsd()).to.equal(answer);
    const [bnbDue, maoDue, usd] = await sale.quoteMint(1);
    expect(usd).to.equal(U("2"));
    expect(maoDue).to.equal(0);
    expect(bnbDue).to.equal((U("2") * 10n ** 8n) / answer);
  });

  it("predicted pair equals the real factory's pair", async function () {
    const factory = await ethers.getContractAt(
      ["function getPair(address,address) view returns (address)", "function createPair(address,address) returns (address)"],
      FACTORY
    );
    await factory.createPair(await token.getAddress(), WBNB);
    const real = await factory.getPair(await token.getAddress(), WBNB);
    expect(real).to.equal(await token.predictedPair());
  });

  it("real Agent ID gate: mars (handle 'mars') mints and gets eggs instantly", async function () {
    const reg = await ethers.getContractAt(
      ["function handleOf(address) view returns (string)", "function balanceOf(address) view returns (uint256)"],
      REGISTRY
    );
    expect(await reg.balanceOf(MARS)).to.equal(1);
    expect(await reg.handleOf(MARS)).to.equal("mars");
    // snapshot slots, mint 10, diff to find the counters
    const before = [];
    for (let i = 0; i < 100; i++) before.push(await getSlot(saleAddr, i));
    const [due] = await sale.quoteMint(10);
    await sale.connect(mars).mint(10, 0, { value: due + due / 100n });
    expect(await eggs.balanceOf(MARS)).to.equal(10);
    expect(await sale.genSold()).to.equal(10);
    for (let i = 0; i < 100; i++) {
      const v = await getSlot(saleAddr, i);
      if (v !== before[i] && v === 10n) soldSlots.push(i);
    }
    expect(soldSlots.length).to.be.gte(2); // genSold + gen0Sold
    // slotsUsed[mars][0]: probe mapping base slots
    for (let base = 0; base < 100 && quotaSlot === null; base++) {
      const inner = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32"], [
          0,
          ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [MARS, base])),
        ])
      );
      if (BigInt(await ethers.provider.getStorage(saleAddr, inner)) === 10n) quotaSlot = inner;
    }
    expect(quotaSlot).to.not.equal(null);
  });

  it("pool opens on the REAL factory/router at egg #5,000 (counters fast-forwarded on the fork only)", async function () {
    for (const s of soldSlots) await setSlot(saleAddr, s, 4990n);
    await setSlot(saleAddr, quotaSlot, 0n);
    expect(await sale.genSold()).to.equal(4990);
    // Fund a realistic reserve (the counter fast-forward above skips
    // ~4,990 real mint payments, so without this the fork pool would
    // be ~0.1 BNB and later price-impact checks would be meaningless).
    await sale.connect(mars).fundReserve({ value: U("20") });
    const [due] = await sale.quoteMint(10);
    await sale.connect(mars).mint(10, 0, { value: due + due / 100n });
    expect(await sale.poolOpened()).to.equal(true);
    const pairAddr = await sale.pair();
    expect(pairAddr).to.equal(await token.predictedPair());
    const pair = await ethers.getContractAt(
      ["function getReserves() view returns (uint112,uint112,uint32)", "function balanceOf(address) view returns (uint256)", "function token0() view returns (address)"],
      pairAddr
    );
    const [r0, r1] = await pair.getReserves();
    const [maoRes, bnbRes] = (await pair.token0()) === (await token.getAddress()) ? [r0, r1] : [r1, r0];
    expect(maoRes).to.equal(await token.totalSupply()); // supply == seed
    expect(bnbRes).to.be.gt(0);
    expect(await pair.balanceOf(DEAD)).to.be.gt(0); // LP burned to DEAD
    // implied price within the 0.5% anchor tolerance of $0.0015
    const px = await sale.bnbUsd();
    const implied = ((bnbRes * px) / 10n ** 8n) * U("1") / maoRes;
    expect(implied).to.be.closeTo(U("0.0015"), U("0.00001"));
  });

  it("buyback executes against the REAL pair and burns to DEAD", async function () {
    await deployer.sendTransaction({ to: saleAddr, value: U("0.05") });
    const pot = await sale.buybackPot();
    expect(pot).to.be.gt(0);
    const deadBefore = await token.balanceOf(DEAD);
    await sale.buyback();
    expect(await token.balanceOf(DEAD)).to.be.gt(deadBefore);
    expect(await sale.buybackPot()).to.be.lt(pot); // spent (block cap may leave a remainder)
  });

  it("post-open mint piggybacks a REAL LP add (LP to DEAD)", async function () {
    await setSlot(saleAddr, quotaSlot, 0n);
    const pairAddr = await sale.pair();
    const pair = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], pairAddr);
    const lpBefore = await pair.balanceOf(DEAD);
    const [due] = await sale.quoteMint(10);
    await sale.connect(mars).mint(10, 0, { value: due + due / 100n });
    expect(await pair.balanceOf(DEAD)).to.be.gt(lpBefore);
    expect(await sale.lpPot()).to.equal(0);
  });

  it("Gen 1 mint costs the fixed MAO ladder price: 90% burned to DEAD, 10% swapped to BNB pots, no project skim", async function () {
    // fast-forward Gen 0 to its last batch and reset mars's quota
    for (const s of soldSlots) await setSlot(saleAddr, s, 9990n);
    await setSlot(saleAddr, quotaSlot, 0n);
    const [due0] = await sale.quoteMint(10);
    await sale.connect(mars).mint(10, 0, { value: due0 + due0 / 100n });
    expect(await sale.currentGen()).to.equal(1);
    // make sure we are past the 5-block anti-snipe window (H2) so the
    // funding buy pays the normal tax and is not cap-bound
    for (let i = 0; i < 3; i++) await ethers.provider.send("evm_mine", []);
    // mars buys MAO on the real router, approves, and mints Gen 1
    const router = await ethers.getContractAt(
      ["function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])"],
      ROUTER
    );
    await router.connect(mars).swapExactETHForTokens(0, [WBNB, await token.getAddress()], MARS, 9999999999, { value: U("0.5") });
    await token.connect(mars).approve(saleAddr, U("1000000"));
    const [bnbDue, maoDue, usd] = await sale.quoteMint(10);
    expect(bnbDue).to.equal(0); // no BNB leg from Gen 1 on
    expect(usd).to.equal(0); // no USD ladder from Gen 1 on
    expect(maoDue).to.equal((await sale.GEN_MAO_LADDER(0)) * 10n); // segment 1: 10 x 800 MAO
    const deadBefore = await token.balanceOf(DEAD);
    const projBefore = await token.balanceOf(project.address);
    await sale.connect(mars).mint(10, maoDue, { value: 0 });
    // change B: the project wallet receives NO MAO (the skim is gone)
    expect(await token.balanceOf(project.address)).to.equal(projBefore);
    // 90% of the payment burned in the mint tx (the piggybacked
    // buyback of the converted leg's proceeds can only add a little)
    expect(await token.balanceOf(DEAD)).to.be.gte(deadBefore + (maoDue * 9n) / 10n);
    // but NOT the whole payment: the 10% leg was swapped to BNB
    expect(await token.balanceOf(DEAD)).to.be.lt(deadBefore + maoDue);
    const info = await eggs.eggInfo(await eggs.nextId());
    expect(info.gen).to.equal(1);
  });
});
