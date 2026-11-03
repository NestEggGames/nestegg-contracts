require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

/** Local-only Hardhat config. No external networks: compile + test in-process. */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 56,
      hardfork: "cancun",
      chains: { 56: { hardforkHistory: { cancun: 0 } } },
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        // 1,100 accounts: selling out one 10,000-egg generation at the
        // 10-per-wallet cap needs 1,000 distinct gated buyers.
        count: 1100,
      },
    },
  },
  mocha: { timeout: 1200000 },
};
