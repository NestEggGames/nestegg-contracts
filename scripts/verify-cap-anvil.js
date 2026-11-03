// Environment workaround driver (NOT part of the mocha suite).
//
// The mocha generation-cap test (test/gen.test.js, "selling out
// Gen 9 latches saleFinished") sells all 100,000 eggs through the
// real mint path on Hardhat's in-process chain. On this 8 GB VM the
// in-process EDR state growth OOM-kills the test process before it
// can finish (observed three times, incl. an isolated run). This
// driver executes the SAME flow with the SAME assertions against a
// local anvil node (state lives in the native node process), with
// one adaptation: every transaction is awaited to its receipt,
// because the mocha helpers assume Hardhat's synchronous mining.
//
// Run:  anvil --accounts 1100 --balance 10000 --port 8545
//       npx hardhat run --network localhost scripts/verify-cap-anvil.js
const { ethers } = require("hardhat");
const { U } = require("../test/helpers");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// deployStack equivalent with anvil-safe synchronization: anvil
/// applies blocks asynchronously, so a getTransactionCount read can
/// lag the last deployment by one — which would skew the CREATE2
/// pair prediction (futureToken) baked into MaoToken. Poll the
/// deployer nonce until all five mock deployments are visible
/// before reading it, and await receipts for the wiring calls.
async function deployStackSync() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const project = signers[1];
  const actors = signers.slice(2);
  const startNonce = await ethers.provider.getTransactionCount(deployer.address);

  const registry = await (await ethers.getContractFactory("MockAgentIdRegistry")).deploy();
  const feed = await (await ethers.getContractFactory("MockPriceFeed")).deploy();
  const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
  const factory = await (await ethers.getContractFactory("MockFactoryC2")).deploy(await wbnb.getAddress());
  const router = await (await ethers.getContractFactory("MockRouter")).deploy(await factory.getAddress(), await wbnb.getAddress());

  for (let i = 0; i < 100; i++) {
    if ((await ethers.provider.getTransactionCount(deployer.address)) >= startNonce + 5) break;
    await sleep(100);
  }
  const tokenNonce = await ethers.provider.getTransactionCount(deployer.address);
  if (tokenNonce !== startNonce + 5) throw new Error("nonce sync failed");
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
  const token = await (await ethers.getContractFactory("MaoToken")).deploy(
    project.address,
    await factory.getAddress(),
    wbnbAddr,
    ethers.keccak256(pairInitCode)
  );
  if ((await token.getAddress()) !== futureToken) throw new Error("token address prediction failed");
  const eggs = await (await ethers.getContractFactory("EggNFT")).deploy();
  const sale = await (await ethers.getContractFactory("EggSale")).deploy(
    await token.getAddress(),
    await eggs.getAddress(),
    await registry.getAddress(),
    await feed.getAddress(),
    await router.getAddress(),
    await factory.getAddress(),
    project.address,
    0
  );
  const market = await (await ethers.getContractFactory("EggMarket")).deploy(await eggs.getAddress(), project.address);
  await (await token.setSystem(await sale.getAddress())).wait();
  await (await eggs.setSale(await sale.getAddress())).wait();
  await (await eggs.setMarket(await market.getAddress())).wait();
  return { signers, deployer, project, actors, registry, feed, wbnb, factory, router, token, eggs, sale, market };
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`ASSERT FAIL ${label}: got ${actual}, want ${expected}`);
  }
  console.log(`  ok ${label} = ${expected}`);
}

async function waitTx(p) {
  const tx = await p;
  return tx.wait();
}

async function mintWait(s, user, count, maxMao = 0n) {
  const [bnbDue, maoDue] = await s.sale.quoteMint(count);
  const value = count > 0 && bnbDue > 0n ? bnbDue + bnbDue / 100n + 1000n : 0n;
  await waitTx(s.sale.connect(user).mint(count, maxMao === 0n ? maoDue : maxMao, { value }));
}

async function expectRevertFinished(s, user, count) {
  try {
    await s.sale.connect(user).mint.staticCall(count, U("100000"), { value: 0 });
  } catch (e) {
    if (e.message.includes("sale finished")) return;
    throw new Error(`expected 'sale finished' revert, got: ${e.message.slice(0, 160)}`);
  }
  throw new Error("expected mint to revert with 'sale finished', but it succeeded");
}

async function main() {
  const s = await deployStackSync();
  console.log("stack deployed; Gen 0 sellout (1,000 buyers x 10) ...");
  // Gen 0: 1,000 buyers x 10 (BNB ladder, pool opens midway).
  for (let i = 0; i < 1000; i++) {
    const buyer = s.actors[i];
    await waitTx(s.registry.give(buyer.address));
    await mintWait(s, buyer, 10);
  }
  assertEq(await s.sale.currentGen(), 1n, "currentGen after Gen 0");
  assertEq(await s.sale.saleFinished(), false, "saleFinished after Gen 0");

  // Fund 500 buyers once for all MAO generations (system mint via
  // impersonation, same pattern as the mocha tests).
  const saleAddr = await s.sale.getAddress();
  await ethers.provider.send("hardhat_impersonateAccount", [saleAddr]);
  await waitTx(s.deployer.sendTransaction({ to: saleAddr, value: U("1") }));
  const saleSigner = await ethers.getSigner(saleAddr);
  const buyers = s.actors.slice(0, 500);
  for (const b of buyers) {
    await waitTx(s.token.connect(saleSigner).mint(b.address, U("400000")));
    await waitTx(s.token.connect(b).approve(saleAddr, U("400000")));
  }
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [saleAddr]);
  console.log("funded 500 buyers; selling Gens 1..9 (500 x 20 each) ...");

  for (let g = 1; g <= 9; g++) {
    for (const b of buyers) {
      await mintWait(s, b, 20, U("400000"));
    }
    console.log(`  gen ${g} sold out`);
    if (g < 9) {
      assertEq(await s.sale.currentGen(), BigInt(g + 1), `currentGen after Gen ${g}`);
      assertEq(await s.sale.saleFinished(), false, `saleFinished after Gen ${g}`);
    }
  }

  console.log("final state assertions:");
  assertEq(await s.sale.currentGen(), 9n, "currentGen");
  assertEq(await s.sale.currentGen(), await s.sale.MAX_GENERATION(), "currentGen == MAX_GENERATION");
  assertEq(await s.sale.genSold(), 10000n, "genSold");
  assertEq(await s.sale.saleFinished(), true, "saleFinished");
  assertEq(await s.eggs.nextId(), 100000n, "eggs.nextId (100,000 eggs)");
  assertEq(await s.sale.currentPriceMao(), 0n, "currentPriceMao");
  assertEq(await s.sale.currentPriceUsd(), 0n, "currentPriceUsd");
  await expectRevertFinished(s, buyers[0], 1);
  console.log("  ok mint(1) reverts 'sale finished'");
  await expectRevertFinished(s, buyers[499], 20);
  console.log("  ok mint(20) reverts 'sale finished'");
  console.log("CAP VERIFICATION PASSED (anvil driver)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
