require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

/**
 * Fork config: runs test-fork/ against a pinned BSC mainnet fork.
 * RPC: publicnode (archive-capable; the tokenpocket/dataseed endpoints
 * cannot serve historical state — verified at build time, see
 * BUILD-NOTES). Override with BSC_FORK_RPC / BSC_FORK_BLOCK if needed.
 */
const FORK_BLOCK = Number(process.env.BSC_FORK_BLOCK || 131355494);

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
    tests: "./test-fork",
    cache: "./cache-fork",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 56,
      hardfork: "cancun",
      chains: { 56: { hardforkHistory: { cancun: 0 } } },
      forking: {
        url: process.env.BSC_FORK_RPC || "https://bsc-rpc.publicnode.com",
        blockNumber: FORK_BLOCK,
      },
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        count: 20,
      },
    },
  },
  mocha: { timeout: 1200000 },
};
