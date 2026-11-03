# NestEgg （蛋） — Hatch. Raise. Earn.

Smart contracts for **NestEgg**, an egg-hatching game on BNB Chain (BSC).
Mint an egg, hatch it, and earn **毛 / MAO** every day.

- 🌐 Website: https://nestegg.games
- 📜 Full game rules & parameters: [SPEC.md](./SPEC.md)
- 🔧 Build notes & audit trail: [BUILD-NOTES.md](./BUILD-NOTES.md)

## Deployed contracts (BSC mainnet)

All five contracts are **verified on BscScan** — the source in this repository
is the exact source that was verified.

| Contract | Address |
|---|---|
| MaoToken （毛 / MAO) | [0x986D20Ad52691a615277756Df18E004cc9FC5D29](https://bscscan.com/address/0x986D20Ad52691a615277756Df18E004cc9FC5D29) |
| EggNFT (EGG) | [0x57Ba8cF43ADf3f495be1a16fC23D6bABb5B8aa25](https://bscscan.com/address/0x57Ba8cF43ADf3f495be1a16fC23D6bABb5B8aa25) |
| EggSale (mint) | [0x29A4B2f50871a010064571AaF34B228e9f245EC8](https://bscscan.com/address/0x29A4B2f50871a010064571AaF34B228e9f245EC8) |
| EggMarket | [0x6a22870cE8889D804db0CBEB98e35F3Ab849587e](https://bscscan.com/address/0x6a22870cE8889D804db0CBEB98e35F3Ab849587e) |
| MaoConverter | [0x34D6fBED8b5E202b459d68B246314cD6ed18df91](https://bscscan.com/address/0x34D6fBED8b5E202b459d68B246314cD6ed18df91) |

Minting opened 2026-11-03 21:00 CST (13:00 UTC). The MAO/BNB pool opens
inside the mint that sells egg #5,000.

## How it works

- **100,000 eggs, ever** — 10 generations × 10,000. Gen 9 is final; after it
  sells out, minting ends permanently.
- **Mint gate** — minting requires a Binance Agent ID (SPACE ID registry
  `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`); a wallet and its handle are
  bound permanently at first mint. Gen 0 cap: 10 eggs per wallet; Gen 1+: 20.
- **Gen 0 pricing** — paid in BNB at the live Chainlink BNB/USD price:
  $2 × #1–1,000 / $3 × #1,001–3,000 / $4 × #3,001–6,000 / $5 × #6,001–10,000.
  If no egg is minted for 5 minutes, the price steps down one tier (floor $2).
  80% of proceeds go to the contract reserve, 20% to the project wallet.
- **Pool open** — inside the mint that sells egg #5,000, the reserve seeds a
  PancakeSwap V2 MAO/BNB pool at $0.0015 and the LP tokens are burned to the
  dead address. After the open, each mint's reserve share splits 50/50 into an
  automatic buyback-and-burn pot and liquidity adds (LP burned).
- **Eggs & animals produce MAO daily** — unhatched egg 400/day; chicken 300,
  duck 500, goose 700, bird 1,000; phoenix 10,000/day decaying ×0.8 every
  30 days. Holding at least one of each of the five species gives +20%
  production on all your units.
- **Hatching** — optional, rolled at hatch time from a future blockhash.
  Phoenix odds: 20 in 10,000 (0.2%). On a 10% plunder roll, the animal is
  born to another player instead and you keep an empty shell.
- **Claims are two-step** — a claim request locks the accrued MAO plus a
  patience bonus (up to +20%); settlement always pays the locked amount in
  full. Each claim carries a flat 20% death chance for the unit (phoenixes
  never die). A claim pauses production for 1 hour.
- **Gen 1+** — paid in MAO at a fixed ladder (800 / 1,200 / 1,600 / 2,000);
  90% of the payment is burned, 10% is converted to BNB into the
  buyback/liquidity pipeline.
- **Trading tax** — 2% on buys and 2% on sells (1% burned, 1% project);
  plain transfers are untaxed. All burns go to
  `0x000000000000000000000000000000000000dEaD`.
- **Failed-launch refund** — if the pool has not opened within 7 days of the
  mint start, minting closes and every Gen 0 egg can be returned for a full
  refund of the BNB actually paid. Once the pool opens, refunds never exist.
- **No admin keys** — there is no pause function and no standing manual
  permission anywhere in the system after deployment wiring.

MAO supply: circulating supply can never exceed 3,000,000,000
(total supply minus the dead address's balance).

## Repository layout

```
contracts/    MaoToken, EggNFT, EggSale, EggMarket, MaoConverter, Interfaces (+ mocks)
test/         Unit test suite (Hardhat)
test-fork/    Fork tests against live BSC state
scripts/      deploy.js (all parameters via environment variables)
SPEC.md       Full specification
BUILD-NOTES.md Build history, review fixes, verification notes
```

## Build & test

```bash
npm install
npm run compile
npm test            # unit tests
npm run test:fork   # fork tests (needs BSC_FORK_RPC)
```

Solidity 0.8.28, optimizer 200 runs, viaIR, cancun — matching the BscScan
verification settings.

## License

MIT — see [LICENSE](./LICENSE).
