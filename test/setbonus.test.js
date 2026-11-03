const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployStack, giveId, mintEggIds, warp, mine, requestAndSettleClaims, U } = require("./helpers");

/// Hatch batches of 10 from rotating minters until an animal of species
/// `want` appears, then transfer it to the collector. (Outcomes are
/// never asserted — this is a search harness; accounting is what's
/// tested. Phoenix at 0.5% takes ~20 batches in expectation.)
async function acquireSpecies(s, want, collector, pool, state) {
  for (let round = 0; round < 250; round++) {
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
  throw new Error("species not found: " + want);
}

describe("Collection set bonus (+20% while holding all 5 species)", function () {
  let s, collector, other;
  const state = { i: 100 }; // minter pool cursor (actors[100..])
  let eggId, egg2Id;

  before(async function () {
    s = await deployStack();
    collector = s.actors[950];
    other = s.actors[951];
    await giveId(s.registry, collector);
    [eggId] = await mintEggIds(s, collector, 1); // the measuring unit (an egg)
    [egg2Id] = await mintEggIds(s, collector, 1);
    // Bring in chicken, duck, goose, bird — one species short of a set.
    for (const sp of [1, 2, 3, 4]) {
      await acquireSpecies(s, sp, collector, s.actors, state);
    }
  });

  it("eggs do not count toward the set; 4 species is not a set; no bonus accrues", async function () {
    const st = await s.eggs.setStatusOf(collector.address);
    expect(st.complete).to.equal(false);
    expect(st.counts.map(Number)).to.deep.equal([1, 1, 1, 1, 0]);
    await warp(24 * 3600);
    expect(await s.eggs.pendingOf(eggId)).to.be.closeTo(U("400"), U("3"));
    expect(await s.eggs.setBonusPendingOf(eggId)).to.equal(0);
  });

  it("completing the set starts the bonus clock; earlier accrual gets no bonus", async function () {
    await acquireSpecies(s, 5, collector, s.actors, state); // phoenix completes the set
    const st = await s.eggs.setStatusOf(collector.address);
    expect(st.complete).to.equal(true);
    expect(st.since).to.be.gt(0);
    // ~1 day of pre-completion accrual carries (almost) no bonus
    expect(await s.eggs.setBonusPendingOf(eggId)).to.be.lt(U("0.1"));
    await warp(24 * 3600);
    // one full day under a complete set: bonus = 20% of ~400
    expect(await s.eggs.setBonusPendingOf(eggId)).to.be.closeTo(U("80"), U("2"));
    expect(await s.eggs.setBonusPendingOf(egg2Id)).to.be.closeTo(U("80"), U("2")); // eggs earn it too
  });

  it("claim pays (base + set bonus) x patience multiplier", async function () {
    const base = await s.eggs.pendingOf(eggId);
    const bonus = await s.eggs.setBonusPendingOf(eggId);
    const before = await s.token.balanceOf(collector.address);
    await requestAndSettleClaims(s, collector, [eggId]); // amount locks at request, pays in full at settle
    const got = (await s.token.balanceOf(collector.address)) - before;
    // unclaimed for ~2 days -> patience +20% (cap)
    expect(got).to.be.closeTo(((base + bonus) * 120n) / 100n, U("3"));
    expect(await s.eggs.setBonusPendingOf(eggId)).to.equal(0);
  });

  it("breaking the set stops the bonus; accrued bonus stays claimable (crystallized)", async function () {
    const [, , , , phoenixCount] = (await s.eggs.setStatusOf(collector.address)).counts;
    expect(phoenixCount).to.equal(1);
    // find the phoenix id among collector's recent acquisitions: scan ids
    const total = await s.eggs.nextId();
    let phoenixId = 0;
    for (let id = 1; id <= total; id++) {
      if (Number(await s.eggs.speciesOf(id)) === 5 && (await s.eggs.ownerOf(id)) === collector.address) {
        phoenixId = id;
        break;
      }
    }
    expect(phoenixId).to.be.gt(0);
    const bonusAtBreak = await s.eggs.setBonusPendingOf(egg2Id);
    await s.eggs.connect(collector).transferFrom(collector.address, other.address, phoenixId);
    const st = await s.eggs.setStatusOf(collector.address);
    expect(st.complete).to.equal(false);
    expect(st.since).to.equal(0);
    const pendingAtBreak = await s.eggs.pendingOf(egg2Id);
    await warp(24 * 3600);
    // base keeps accruing (~+400/day), bonus does not grow any more
    expect(await s.eggs.pendingOf(egg2Id)).to.be.closeTo(pendingAtBreak + U("400"), U("3"));
    expect(await s.eggs.setBonusPendingOf(egg2Id)).to.be.closeTo(bonusAtBreak, U("0.1"));
    // ...and the crystallized bonus is still paid on claim
    const base = await s.eggs.pendingOf(egg2Id);
    const bonus = await s.eggs.setBonusPendingOf(egg2Id);
    expect(bonus).to.be.gt(0);
    const before = await s.token.balanceOf(collector.address);
    await requestAndSettleClaims(s, collector, [egg2Id]);
    const got = (await s.token.balanceOf(collector.address)) - before;
    const mult = await s.eggs.patienceMult(egg2Id); // read post-claim = 100; recompute pre-claim below
    void mult;
    expect(got).to.be.gte(base + bonus); // at least base+bonus (patience >= 100%)
    expect(got).to.be.closeTo(((base + bonus) * 120n) / 100n, U("3")); // ~3 days unclaimed -> +20% (cap)
  });

  it("no stacking: a second animal of a species does not raise the 20%", async function () {
    // re-complete the set (phoenix comes back), then add a 2nd chicken
    const total = await s.eggs.nextId();
    let phoenixId = 0;
    for (let id = 1; id <= total; id++) {
      if (Number(await s.eggs.speciesOf(id)) === 5 && (await s.eggs.ownerOf(id)) === other.address) {
        phoenixId = id;
        break;
      }
    }
    await s.eggs.connect(other).transferFrom(other.address, collector.address, phoenixId);
    expect((await s.eggs.setStatusOf(collector.address)).complete).to.equal(true);
    await acquireSpecies(s, 1, collector, s.actors, state); // second chicken
    const st = await s.eggs.setStatusOf(collector.address);
    expect(st.counts.map(Number)).to.deep.equal([2, 1, 1, 1, 1]);
    const [freshEgg] = await mintEggIds(s, collector, 1);
    const b0 = await s.eggs.setBonusPendingOf(freshEgg);
    await warp(24 * 3600);
    const b1 = await s.eggs.setBonusPendingOf(freshEgg);
    expect(b1 - b0).to.be.closeTo(U("80"), U("2")); // still exactly +20% of 400/day
  });
});
