const { ethers } = require("hardhat");

const DEAD = "0x000000000000000000000000000000000000dEaD";
const U = (n) => ethers.parseEther(n.toString());

/// Deploy the full stack on mocks. signers[0] = deployer,
/// signers[1] = project wallet (a normal signer so tests can watch its
/// balances), signers[2..] = actors.
async function deployStack(startTime = 0) {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const project = signers[1];
  const actors = signers.slice(2);

  const Registry = await ethers.getContractFactory("MockAgentIdRegistry");
  const registry = await Registry.deploy();
  const Feed = await ethers.getContractFactory("MockPriceFeed");
  const feed = await Feed.deploy(); // BNB/USD = $700
  const Wbnb = await ethers.getContractFactory("MockWBNB");
  const wbnb = await Wbnb.deploy();
  const Factory = await ethers.getContractFactory("MockFactoryC2");
  const factory = await Factory.deploy(await wbnb.getAddress());
  const Router = await ethers.getContractFactory("MockRouter");
  const router = await Router.deploy(await factory.getAddress(), await wbnb.getAddress());

  // MaoToken predicts its pair via CREATE2: compute the init-code hash
  // for the not-yet-deployed token address (same technique as BNBCAT v5).
  const tokenNonce = await ethers.provider.getTransactionCount(deployer.address);
  const futureToken = ethers.getCreateAddress({ from: deployer.address, nonce: tokenNonce });
  const wbnbAddr = await wbnb.getAddress();
  const [t0, t1] = futureToken.toLowerCase() < wbnbAddr.toLowerCase()
    ? [futureToken, wbnbAddr]
    : [wbnbAddr, futureToken];
  const pairFactory = await ethers.getContractFactory("MockPair");
  const pairInitCode = ethers.concat([
    pairFactory.bytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [t0, t1]),
  ]);
  const Token = await ethers.getContractFactory("MaoToken");
  const token = await Token.deploy(
    project.address,
    await factory.getAddress(),
    wbnbAddr,
    ethers.keccak256(pairInitCode)
  );
  const Eggs = await ethers.getContractFactory("EggNFT");
  const eggs = await Eggs.deploy();
  const Converter = await ethers.getContractFactory("MaoConverter");
  const converter = await Converter.deploy(await token.getAddress(), await router.getAddress());
  const Sale = await ethers.getContractFactory("EggSale");
  const sale = await Sale.deploy(
    await token.getAddress(),
    await eggs.getAddress(),
    await registry.getAddress(),
    await feed.getAddress(),
    await router.getAddress(),
    await factory.getAddress(),
    project.address,
    startTime
  );
  const Market = await ethers.getContractFactory("EggMarket");
  const market = await Market.deploy(await eggs.getAddress(), project.address);

  await token.setSystem(await sale.getAddress());
  await token.setConverter(await converter.getAddress());
  await converter.setSale(await sale.getAddress());
  await eggs.setSale(await sale.getAddress());
  await eggs.setMarket(await market.getAddress());

  return { signers, deployer, project, actors, registry, feed, wbnb, factory, router, token, eggs, sale, market, converter };
}

async function giveId(registry, user) {
  await registry.give(user.address ?? user);
}

/// Mint `count` eggs for `user`, paying exactly the quoted BNB due
/// (+1% slack, refunded). Returns the mint tx.
async function mintEggs(s, user, count, maxMao = 0n) {
  const [bnbDue] = await s.sale.quoteMint(count);
  const value = bnbDue + bnbDue / 100n + 1000n;
  return s.sale.connect(user).mint(count, maxMao, { value });
}

/// Mint and return the new egg ids (parsed from EggNFT balance delta:
/// ids are sequential from sale's perspective — read nextId before/after).
async function mintEggIds(s, user, count, maxMao = 0n) {
  const before = await s.eggs.nextId();
  await mintEggs(s, user, count, maxMao);
  const ids = [];
  for (let i = 1n; i <= BigInt(count); i++) ids.push(before + i);
  return ids;
}

async function warp(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function mine(n) {
  for (let i = 0; i < n; i++) await ethers.provider.send("evm_mine", []);
}

async function balance(addr) {
  return ethers.provider.getBalance(addr);
}

/// Sell `count` eggs of the current generation using fresh gated buyers
/// (10 per wallet). Actors are consumed from `pool` (array of signers).
async function sellWithBuyers(s, pool, count) {
  let remaining = count;
  let i = 0;
  while (remaining > 0) {
    const n = Math.min(10, remaining);
    const buyer = pool[i++];
    await giveId(s.registry, buyer);
    await mintEggs(s, buyer, n);
    remaining -= n;
  }
  return i;
}

/// Drive Gen 0 to the pool-open trigger (5,000 eggs).
async function driveToOpen(s) {
  const used = await sellWithBuyers(s, s.actors, 5000);
  return s.actors.slice(0, used); // 500 buyers
}

/// Request + settle a hatch for `eggId` owned by `user`; returns species.
async function hatchAndSettle(s, user, eggId, settler) {
  await s.sale.connect(user).requestHatch([eggId]);
  const hatchId = await s.sale.nextHatchId();
  await mine(6);
  await s.sale.connect(settler ?? user).settleReq(false, hatchId);
  return s.eggs.speciesOf(eggId);
}

/// Request claims for `ids` (owned by `user`) and settle them all.
/// Death rolls apply — callers must not assume units survive; check
/// `eggs.isDead(id)` afterwards when it matters. Returns the claim ids.
async function requestAndSettleClaims(s, user, ids, settler) {
  const before = await s.sale.nextClaimId();
  await s.sale.connect(user).requestClaim(ids);
  const after = await s.sale.nextClaimId();
  const claimIds = [];
  for (let c = before + 1n; c <= after; c++) claimIds.push(c);
  if (claimIds.length > 0) {
    await mine(6);
    for (const c of claimIds) {
      // Piggyback settlement inside later calls may have settled some
      // already; only settle the ones still settleable.
      if (Number(await s.sale.reqState(true, c)) === 2) {
        await s.sale.connect(settler ?? user).settleReq(true, c);
      }
    }
  }
  return claimIds;
}

/// Hatch eggs in bulk until one of `want` species appears; transfer it
/// to `collector` and return its id. Miners come from `pool` (consumed
/// via state.i). Used for phoenix/set tests. The round budget is sized
/// for the rarest outcome (phoenix = 0.2% of hatches): 900 rounds x
/// 10 eggs makes a total miss ~e^-18; the expected need is ~50 rounds.
async function acquireSpecies(s, want, collector, pool, state) {
  for (let round = 0; round < 900; round++) {
    const m = pool[state.i++];
    await giveId(s.registry, m);
    const ids = await mintEggIds(s, m, 10);
    await s.sale.connect(m).requestHatch(ids);
    await mine(6);
    await s.sale.settleBacklog(50);
    for (const id of ids) {
      if (Number(await s.eggs.speciesOf(id)) === want) {
        await s.eggs.connect(m).transferFrom(m.address, collector.address, id);
        return id;
      }
    }
  }
  throw new Error("species not found");
}

module.exports = {
  DEAD,
  U,
  deployStack,
  giveId,
  mintEggs,
  mintEggIds,
  warp,
  mine,
  balance,
  sellWithBuyers,
  driveToOpen,
  hatchAndSettle,
  requestAndSettleClaims,
  acquireSpecies,
};
