// Deployment script for the Egg project (MAO). NOT run against mainnet
// by this package — it deploys to whatever network Hardhat is pointed
// at and prints the wiring for verification. All external addresses are
// parameters: on BSC mainnet they are the verified live addresses listed
// in BUILD-NOTES.md (PancakeSwap V2 factory/router, WBNB, Chainlink
// BNB/USD feed, SPACE ID Agent ID registry, and the Pancake pair init
// code hash — CREATE2-verified against the live WBNB/USDT pair).
//
// Env:
//   PROJECT_WALLET  address receiving the 20% mint leg, tax leg, market fees
//   REGISTRY        Agent ID registry   (BSC: 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F)
//   FEED            BNB/USD feed        (BSC: 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE)
//   ROUTER          Pancake V2 router   (BSC: 0x10ED43C718714eb63d5aA57B78B54704E256024E)
//   FACTORY         Pancake V2 factory  (BSC: 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73)
//   WBNB            WBNB                (BSC: 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c)
//   PAIR_INIT_HASH  pair init code hash (BSC: 0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5)
const { ethers } = require("hardhat");

async function main() {
  const {
    PROJECT_WALLET,
    REGISTRY,
    FEED,
    ROUTER,
    FACTORY,
    WBNB,
    PAIR_INIT_HASH,
  } = process.env;
  for (const [k, v] of Object.entries({ PROJECT_WALLET, REGISTRY, FEED, ROUTER, FACTORY, WBNB, PAIR_INIT_HASH })) {
    if (!v) throw new Error(`missing env ${k}`);
  }
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address);

  const Token = await ethers.getContractFactory("MaoToken");
  const token = await Token.deploy(PROJECT_WALLET, FACTORY, WBNB, PAIR_INIT_HASH);
  await token.waitForDeployment();
  console.log("MaoToken:", await token.getAddress());
  console.log("  name/symbol/decimals:", await token.name(), await token.symbol(), await token.decimals());
  console.log("  predictedPair:", await token.predictedPair());

  const Eggs = await ethers.getContractFactory("EggNFT");
  const eggs = await Eggs.deploy();
  await eggs.waitForDeployment();
  console.log("EggNFT:", await eggs.getAddress());

  const Converter = await ethers.getContractFactory("MaoConverter");
  const converter = await Converter.deploy(await token.getAddress(), ROUTER);
  await converter.waitForDeployment();
  console.log("MaoConverter:", await converter.getAddress());

  // Mint start gate (user decision 2026-11-03): default 1793710800 =
  // 2026-11-03 21:00 CST (13:00 UTC). Override with START_TIME_UNIX if
  // the launch day changes — a startTime in the past opens at deploy.
  const startTime = BigInt(process.env.START_TIME_UNIX ?? "1793710800");
  console.log("EggSale startTime:", startTime.toString(), "=", new Date(Number(startTime) * 1000).toISOString());

  const Sale = await ethers.getContractFactory("EggSale");
  const sale = await Sale.deploy(
    await token.getAddress(),
    await eggs.getAddress(),
    REGISTRY,
    FEED,
    ROUTER,
    FACTORY,
    PROJECT_WALLET,
    startTime
  );
  await sale.waitForDeployment();
  console.log("EggSale:", await sale.getAddress());

  const Market = await ethers.getContractFactory("EggMarket");
  const market = await Market.deploy(await eggs.getAddress(), PROJECT_WALLET);
  await market.waitForDeployment();
  console.log("EggMarket:", await market.getAddress());

  await token.setSystem(await sale.getAddress());
  await token.setConverter(await converter.getAddress());
  await converter.setSale(await sale.getAddress());
  await eggs.setSale(await sale.getAddress());
  await eggs.setMarket(await market.getAddress());
  console.log("wiring done: token.system, token.converter, converter.sale, eggs.sale, eggs.market");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
