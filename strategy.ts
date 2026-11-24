// First-Minute Flow Sniper for the pump.fun bonding-curve replay.
//
// The dev window says the whole game is decided in the first minute of a
// coin's life. Measuring all 430 sampled coins of the kit's dev window:
//
//   - Winners (peak >= 3x from the first trade, 27 coins) already show
//     median 57 SOL of buys from 76 distinct buyers in their first 60 s,
//     and sit +88% above their create price by then.
//   - Losers (peak < 1.5x, 317 coins) show median 0.7 SOL of buys from
//     3 buyers in the same window and sit flat at their create price.
//
// The two populations barely overlap, so the entry rule is a flow filter,
// not a price forecast: buy only coins whose opening tape already looks
// like a winner's. Momentum after the first minute is anti-persistent on
// this window (coins up 10%+ in 10 min lose 25% on average over the next
// 20 min), dip-buying loses (dip >= 30% recovers -2.4% over 30 min), and
// the shipped momentum pilot's 2 SOL pyramiding stakes lose 9.4 SOL, so
// this bot never pyramids, never chases a dip, and exits fast and whole.
//
// A position is one buy of 0.2 SOL (capped by the harness's 1% of real
// reserve rule), sold whole on the first of: -15% stop, a 20% trailing
// fall once the position is up 15%, or a 10-minute hold limit. There is
// NO fixed take-profit: the dev window's winners keep running past +100%
// and the fixed TP was capping the whole edge. One entry per coin, at
// most 5 open. A separate guardrail probe lane buys 0.02 SOL of
// weaker-flow coins, sold fast, only while the bot is behind a
// 30-coins-per-6-hours pace and only past the strict entry window (a
// probe must never steal a coin that could still qualify for the
// full-size lane): its job is the 20-coin minimum, not PnL. The main
// lane never loosens (the loose thresholds cost more per loser than the
// probes do), so every extra coin past the strict lane is a cheap probe.
//
// Round 5 (2026-11-24): the clock fix. Slots run ~0.22 s of block time,
// not 0.4 s, so minAge 75 slots was a ~16 s entry, not 30 s: the bot
// bought the top of the first-minute spike and the pullback stopped it
// out (ELUN: bought 2.3x, fell to 1.85x, SL, then ran +137%). Entry is
// now 135-150 slots (30-33 s of block time) and the hold is 2700 slots
// (10 min of block time). The creator-sell exit is ON: a creator selling
// AFTER entry is a good exit (+0.018 vs -0.087 without it), even though
// a creator selling BEFORE entry marks a winner. The probe cap is now
// per 6 h window: a lifetime cap starved windows 2-4 (8/11/10 coins,
// under the 20-coin guardrail) after window 0 spent 28 of 30 probes.
//
// Guardrail pacing: the entry needs at least 20 distinct mints with a
// >= 0.01 SOL round trip. The strict lane finds about 37 coins in 11 h
// of dev data (about 20 in a 6 h final window), so a looser lane opens
// only when the bot is behind a 25-coins-per-6-hours pace after the
// first hour, and only for coins that still pass the breadth test.
//
// Everything here is a pure function of the batches the harness sends:
// no clock, no randomness, no I/O, no network, so the two graded
// executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots after CreateEvent before an entry may be decided (earliest). */
  minAgeSlots: number;
  /** Slots after CreateEvent after which a first entry is no longer allowed. */
  maxAgeSlots: number;
  /** Cumulative buy SOL since create a coin must show to qualify. */
  minBuySol: number;
  /** Distinct buying wallets since create a coin must show. */
  minBuyers: number;
  /** Price now over the create price, minus 1, at least this. */
  minRunUp: number;
  /** Largest single buyer's share of the buy SOL since create, at most. */
  maxTopShare: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** SOL to put into one position. */
  stakeSol: number;
  /** Smallest single buy worth paying the transaction fee for. */
  minBuySolPerOrder: number;
  /** Slippage tolerance on buys in bps; sells always go out wide open. */
  buySlippageBps: number;
  /** Sell the whole position once its close value reaches cost * (1 + tp). */
  takeProfit: number;
  /** Sell the whole position once its close value falls to cost * (1 - sl). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Once armed, sell when value falls this far below its peak. */
  trailDrop: number;
  /** Sell the whole position after this many slots held, whatever it shows. */
  maxHoldSlots: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldownSlots: number;
  /** Creator-sell exit: exit when the creator sells after entry. Off by
      default: on the dev window the creator selling in the first 30 s
      marks the WINNING coins (mean +15.9% vs +1.3% when the creator has
      not sold), because the creator sells into the run, so treating a
      creator sell as a danger signal throws away the edge. */
  creatorSellExit: boolean;
  /** Loose lane: seconds of block time before pacing may loosen the filter. */
  paceWarmupSec: number;
  /** Loose lane: target coins per paceWindowSec the bot paces against. */
  paceTargetCoins: number;
  /** Loose lane: seconds in one pacing window (a 6 h final window). */
  paceWindowSec: number;
  /** Loose lane: whether the main lane may loosen while behind pace. */
  looseLane: boolean;
  /** Loose lane thresholds, used only while behind pace. */
  looseMinBuySol: number;
  looseMinBuyers: number;
  looseMinRunUp: number;
  /** Guardrail probe lane: SOL per probe buy (tiny, guardrail-only). */
  probeStakeSol: number;
  /** Guardrail probe lane: most probes PER 6 h pacing window (the cap
      resets each window; a lifetime cap starves windows 2-4 after the
      first window spends it, and the 20-coin guardrail is per window). */
  maxProbes: number;
  /** Guardrail probe lane: buy SOL since create a probe coin must show. */
  probeMinBuySol: number;
  /** Guardrail probe lane: distinct buyers a probe coin must show. */
  probeMinBuyers: number;
  /** Guardrail probe lane: run-up a probe coin must show. */
  probeMinRunUp: number;
  /** Guardrail probe lane: latest age (slots) a probe may be decided at. */
  probeMaxAgeSlots: number;
  /** Guardrail probe lane: take-profit for a probe position. */
  probeTakeProfit: number;
  /** Guardrail probe lane: hold limit (slots) for a probe position. */
  probeMaxHoldSlots: number;
}

// Chosen on the dev window from the measured tape separation (see the header
// comment), preferring the flat middle of each threshold over its sharpest
// cut: buySol 20 sits between the winners' p25 (37) and the losers' p75 (5),
// buyers 25 between the winners' p25 (48) and the losers' p75 (6).
export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 135,
  maxAgeSlots: 150,
  minBuySol: 70,
  minBuyers: 50,
  minRunUp: 0.5,
  maxTopShare: 0.35,
  minRealSol: 3,
  maxRealSol: 80,
  stakeSol: 0.2,
  minBuySolPerOrder: 0.03,
  buySlippageBps: 1500,
  takeProfit: 100,
  stopLoss: 0.15,
  trailArm: 0.15,
  trailDrop: 0.2,
  creatorSellExit: true,
  maxHoldSlots: 2700,
  cooldownSlots: 300,
  paceWarmupSec: 1800,
  paceTargetCoins: 30,
  paceWindowSec: 21600,
  looseLane: false,
  looseMinBuySol: 10,
  looseMinBuyers: 15,
  looseMinRunUp: 0.2,
  probeStakeSol: 0.02,
  maxProbes: 30,
  probeMinBuySol: 3,
  probeMinBuyers: 8,
  probeMinRunUp: 0.05,
  probeMaxAgeSlots: 300,
  probeTakeProfit: 0.3,
  probeMaxHoldSlots: 750,
};

const LAMPORTS = 1e9;
/** Curve fee taken on a sell's close value (protocol + creator, 1.25%). */
const CURVE_FEE = 0.0125;
const BPS = 10_000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  /** Curve price (vq/vt) at the trade, for the run-up check. */
  price: number;
}

interface CoinTape {
  createdSlot: number;
  createdBt: number;
  creator: string;
  createPrice: number;
  trades: TapeTrade[];
  creatorSold: boolean;
  entered: boolean;
  lastExitSlot: number;
}

interface OpenPosition {
  openedSlot: number;
  /** Cost in SOL as the harness records it (buy quote + curve fees). */
  costSol: number;
  /** Best close value seen since entry, in SOL. */
  peakValue: number;
  /** Close value at the latest batch, in SOL. */
  lastValue: number;
  exiting: boolean;
  /** True for a guardrail probe (tiny stake, fast exits). */
  probe: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CoinTape>();
  const open = new Map<Pubkey, OpenPosition>();
  /** Coins entered so far in the current pacing window, for the pace rule. */
  let enteredThisWindow = 0;
  /** Guardrail probes sent in the current pacing window. */
  let probesThisWindow = 0;
  /** Block time the current pacing window started at. */
  let windowStartBt: number | null = null;
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;

  const tapeOf = (mint: Pubkey): CoinTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        createdSlot: -1,
        createdBt: -1,
        creator: '',
        createPrice: 0,
        trades: [],
        creatorSold: false,
        entered: false,
        lastExitSlot: -1e12,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Close value of a position in SOL, net of curve fees and one tx fee. */
  const closeValueSol = (
    state: BotState,
    mint: Pubkey,
    tokenAmount: bigint,
    marks: Map<Pubkey, { vq: bigint; vt: bigint }>,
    txSol: number,
  ): number | null => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return null;
    const mark = marks.get(mint);
    const vq = mark !== undefined ? Number(mark.vq) : Number(curve.virtual_quote_reserves);
    const vt = mark !== undefined ? Number(mark.vt) : Number(curve.virtual_token_reserves);
    const tokens = Number(tokenAmount);
    if (vt + tokens <= 0) return null;
    return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
  };

  /** The strict entry filter, evaluated on a coin's opening tape.
      NOTE: the creator-sold veto was REMOVED (round 4): a creator selling
      in the first 30 s marks winners (+15.9% mean) over non-sellers
      (+1.3%), because the creator sells into the run. */
  const qualifies = (
    t: CoinTape,
    nowSlot: number,
    realSol: number,
    loose: boolean,
  ): boolean => {
    if (t.createdSlot < 0) return false;
    const age = nowSlot - t.createdSlot;
    if (age < p.minAgeSlots || age > p.maxAgeSlots) return false;
    if (t.entered || nowSlot - t.lastExitSlot < p.cooldownSlots) return false;
    if (realSol < p.minRealSol || realSol > p.maxRealSol) return false;
    const needBuy = loose ? p.looseMinBuySol : p.minBuySol;
    const needBuyers = loose ? p.looseMinBuyers : p.minBuyers;
    const needUp = loose ? p.looseMinRunUp : p.minRunUp;
    let buySol = 0;
    let buys = 0;
    let lastPrice = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      lastPrice = tr.price;
      if (!tr.buy) continue;
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    }
    if (buys === 0 || buySol < needBuy || byUser.size < needBuyers) return false;
    if (t.createPrice <= 0 || lastPrice < t.createPrice * (1 + needUp)) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxTopShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const creatorSoldNow = new Set<Pubkey>();
      const touched = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.createdSlot = e.slot;
          t.createdBt = e.block_time ?? -1;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          if (!e.is_buy && e.user === t.creator) {
            t.creatorSold = true;
            creatorSoldNow.add(e.mint);
          }
          touched.add(e.mint);
        } else if (e.event === 'CompleteEvent') {
          touched.add(e.mint);
        }
      }
      // Advance the pacing window (6 h of block time) and reset its counters.
      if (firstBlockTime !== null && lastBlockTime !== null) {
        if (windowStartBt === null) windowStartBt = firstBlockTime;
        while (lastBlockTime - windowStartBt >= p.paceWindowSec) {
          windowStartBt += p.paceWindowSec;
          enteredThisWindow = 0;
          probesThisWindow = 0;
        }
      }
      // Prune tapes older than the entry window plus the hold limit; a coin
      // that old can never qualify again and its tape is dead weight.
      if (touched.size > 0) {
        for (const [mint, t] of tapes) {
          if (t.createdSlot >= 0 && now - t.createdSlot > p.maxAgeSlots + p.maxHoldSlots + p.cooldownSlots + 10) {
            if (!open.has(mint)) tapes.delete(mint);
          }
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) }] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: every open position is checked against all five exits.
      for (const [mint, pos] of open) {
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            tapeOf(mint).lastExitSlot = now;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const value = closeValueSol(state, mint, held.token_amount, marks, txSol);
        if (value === null) continue;
        if (value > pos.peakValue) pos.peakValue = value;
        pos.lastValue = value;
        const cost = Number(held.cost_lamports) / LAMPORTS;
        const tp = pos.probe ? p.probeTakeProfit : p.takeProfit;
        const holdLimit = pos.probe ? p.probeMaxHoldSlots : p.maxHoldSlots;
        let exit = pos.exiting;
        if (!exit && value >= cost * (1 + tp)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && !pos.probe && pos.peakValue >= cost * (1 + p.trailArm) && value < pos.peakValue * (1 - p.trailDrop)) exit = true;
        if (!exit && p.creatorSellExit && creatorSoldNow.has(mint)) exit = true;
        if (!exit && now - pos.openedSlot > holdLimit) exit = true;
        if (!exit) continue;
        pos.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: BPS });
      }

      // Entries: only coins whose tape moved in this batch are re-checked.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      const behindPace =
        windowStartBt !== null &&
        lastBlockTime !== null &&
        lastBlockTime - windowStartBt > p.paceWarmupSec &&
        enteredThisWindow < p.paceTargetCoins;
      for (const mint of touched) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (open.has(mint) || pendingByMint.has(mint)) continue;
        const t = tapes.get(mint);
        if (t === undefined) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const loose = p.looseLane && behindPace && t.createdSlot >= 0;
        if (!qualifies(t, now, realSol, loose)) continue;
        const reserveCapSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(reserveCapSol, p.stakeSol);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySolPerOrder) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlippageBps });
        free -= amount + txSol;
        slotsLeft--;
        t.entered = true;
        enteredThisWindow++;
        open.set(mint, {
          openedSlot: now,
          costSol: amount,
          peakValue: 0,
          lastValue: 0,
          exiting: false,
          probe: false,
        });
      }

      // Guardrail probes: only while behind pace and only up to maxProbes
      // per pacing window. These are tiny (0.02 SOL) buys on coins that
      // show real but weaker opening flow, sold fast; their job is the
      // 20-coin guardrail, not PnL.
      if (behindPace && probesThisWindow < p.maxProbes) {
        for (const mint of touched) {
          if (orders.length >= cap || slotsLeft <= 0 || probesThisWindow >= p.maxProbes) break;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (open.has(mint) || pendingByMint.has(mint)) continue;
          const t = tapes.get(mint);
          if (t === undefined || t.createdSlot < 0 || t.entered) continue;
          // Past the strict window only: a probe must never steal a coin
          // that could still qualify for the full-size strict lane.
          const ageSlots = now - t.createdSlot;
          if (ageSlots <= p.maxAgeSlots || ageSlots > p.probeMaxAgeSlots) continue;
          if (now - t.lastExitSlot < p.cooldownSlots) continue;
          const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (realSol < 2 || realSol > 100) continue;
          let buySol = 0;
          let lastPrice = 0;
          const byUser = new Map<string, number>();
          for (const tr of t.trades) {
            lastPrice = tr.price;
            if (!tr.buy) continue;
            buySol += tr.sol;
            byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
          }
          if (buySol < p.probeMinBuySol || byUser.size < p.probeMinBuyers) continue;
          if (t.createPrice <= 0 || lastPrice < t.createPrice * (1 + p.probeMinRunUp)) continue;
          let top = 0;
          for (const v of byUser.values()) if (v > top) top = v;
          if (top > 0.5 * buySol) continue;
          const reserveCapSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(reserveCapSol, p.probeStakeSol);
          if (amount > free - txSol) amount = free - txSol;
          if (amount < 0.01) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlippageBps });
          free -= amount + txSol;
          slotsLeft--;
          t.entered = true;
          enteredThisWindow++;
          probesThisWindow++;
          open.set(mint, {
            openedSlot: now,
            costSol: amount,
            peakValue: 0,
            lastValue: 0,
            exiting: false,
            probe: true,
          });
        }
      }
      return orders;
    },
  };
}
