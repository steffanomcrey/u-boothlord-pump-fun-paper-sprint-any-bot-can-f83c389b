// First-Minute Flow Sniper: a pump.fun trading bot for the agent-fun/replay/v2
// harness. The strategy lives in strategy.ts; this file only wires it to the
// kit's SDK runner, which speaks the hello / batch / orders protocol with
// the grader over stdin and stdout.
//
// Run by the grader as `node /bot/main.ts` with this directory mounted at
// /bot. Node 22 runs TypeScript as it is; no build step, no dependencies,
// no network, no clock, no randomness, so the two graded executions agree
// byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// Pre-flight: the graded run is worthless if the strategy cannot even
// start, so fail loudly here instead of silently trading nothing. The
// guardrail needs at least 20 coins per 6 h window; the probe lane is
// capped at maxProbes per window, so the cap must clear that bar on its
// own, and the main lane must be able to enter at least one coin.
if (DEFAULT_PARAMS.maxProbes < 20) {
  throw new Error(`probe cap ${DEFAULT_PARAMS.maxProbes} cannot clear the 20-coin guardrail`);
}
if (DEFAULT_PARAMS.minAgeSlots >= DEFAULT_PARAMS.maxAgeSlots) {
  throw new Error(`empty entry window ${DEFAULT_PARAMS.minAgeSlots}-${DEFAULT_PARAMS.maxAgeSlots}`);
}
if (DEFAULT_PARAMS.stakeSol <= 0 || DEFAULT_PARAMS.probeStakeSol < 0.01) {
  throw new Error('stake below the 0.01 SOL round-trip minimum');
}

await runBot(createStrategy(DEFAULT_PARAMS));
