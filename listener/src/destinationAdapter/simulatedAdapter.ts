/**
 * simulatedAdapter.ts — [SIMULATED] Destination adapter
 *
 * This is explicitly labelled as a SIMULATED adapter for development.
 * In production, replace with fabricAdapter.ts or a real EVM receiver.
 *
 * The simulated adapter introduces artificial latency and can be configured
 * to fail randomly to test retry/failure recovery paths.
 */

import { DestinationResult, CrossChainTransaction } from "../types";
import { childLogger } from "../logger";

const log = childLogger("simulatedAdapter");

export interface SimulatedConfig {
  /** Simulated network latency in ms (default: 200–800ms random) */
  minLatencyMs: number;
  maxLatencyMs: number;
  /** Probability [0, 1] of a simulated failure (default: 0.05 = 5%) */
  failureProbability: number;
}

const DEFAULT_CONFIG: SimulatedConfig = {
  minLatencyMs: 200,
  maxLatencyMs: 800,
  failureProbability: parseFloat(process.env.SIMULATED_FAILURE_RATE ?? "0.05"),
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * [SIMULATED] Execute a cross-chain transaction on the destination.
 *
 * Returns a fake transaction hash. In production this would submit a
 * real blockchain transaction or Fabric invoke.
 */
export async function simulatedExecute(
  tx: CrossChainTransaction,
  config: SimulatedConfig = DEFAULT_CONFIG
): Promise<DestinationResult> {
  const startMs = Date.now();

  // Simulate network latency
  const latency = config.minLatencyMs + Math.random() * (config.maxLatencyMs - config.minLatencyMs);
  await sleep(latency);

  // Simulate occasional failures for resilience testing
  if (Math.random() < config.failureProbability) {
    const err = "SIMULATED: Destination network error — connection refused";
    log.warn({ txId: tx.txId, err }, "[SIMULATED] Execution failed");
    return { success: false, errorMessage: err };
  }

  // Produce a deterministic-ish fake tx hash
  const fakeHash = "0xSIM" + Buffer.from(tx.txId.slice(2, 18)).toString("hex").toUpperCase();
  const latencyMs = Date.now() - startMs;

  log.info({ txId: tx.txId, destTxHash: fakeHash, latencyMs }, "[SIMULATED] Execution succeeded");

  return {
    success: true,
    destTxHash: fakeHash,
    latencyMs,
  };
}
