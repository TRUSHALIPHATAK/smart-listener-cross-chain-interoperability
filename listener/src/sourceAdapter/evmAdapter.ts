/**
 * evmAdapter.ts — Source chain EVM adapter
 *
 * Uses ethers.js v6 to subscribe to TransactionSent events from SenderContract.
 * Polls if WebSocket is unavailable (HTTP provider fallback).
 */

import { ethers } from "ethers";
import { TransactionEvent } from "../types";
import { childLogger } from "../logger";
import {
  SOURCE_RPC_URL,
  SENDER_CONTRACT_ADDRESS,
  POLL_INTERVAL_MS,
  CONFIRMATIONS,
} from "../config";

const log = childLogger("evmAdapter");

// Minimal ABI — only the event we care about
const SENDER_ABI = [
  "event TransactionSent(bytes32 indexed txId, address indexed sender, bytes32 indexed destinationChainId, bytes destinationAddress, bytes payload, uint256 nonce, uint256 timestamp)",
  "event TransactionCancelled(bytes32 indexed txId, address indexed sender)",
];

export type EventCallback   = (event: TransactionEvent) => Promise<void>;
export type CancelCallback  = (txId: string, sender: string) => Promise<void>;

export class EvmSourceAdapter {
  private provider!: ethers.JsonRpcProvider | ethers.WebSocketProvider;
  private contract!: ethers.Contract;
  private running = false;
  private lastProcessedBlock = 0;

  async connect(): Promise<void> {
    const url = SOURCE_RPC_URL;
    if (url.startsWith("ws")) {
      this.provider = new ethers.WebSocketProvider(url);
      log.info({ url }, "Connected via WebSocket");
    } else {
      this.provider = new ethers.JsonRpcProvider(url);
      log.info({ url }, "Connected via HTTP (polling)");
    }

    if (!SENDER_CONTRACT_ADDRESS) {
      throw new Error("SENDER_CONTRACT_ADDRESS is not set. Run deploy:local first.");
    }

    this.contract = new ethers.Contract(SENDER_CONTRACT_ADDRESS, SENDER_ABI, this.provider);
    this.lastProcessedBlock = await this.provider.getBlockNumber() - 1;
    log.info({ address: SENDER_CONTRACT_ADDRESS, startBlock: this.lastProcessedBlock }, "SenderContract attached");
  }

  isConnected(): boolean {
    return this.running;
  }

  getLastProcessedBlock(): number {
    return this.lastProcessedBlock;
  }

  /**
   * Start listening for events. Calls onEvent for each confirmed TransactionSent.
   * Falls back to polling every POLL_INTERVAL_MS if real-time subscription fails.
   */
  async listen(onEvent: EventCallback, onCancel: CancelCallback): Promise<void> {
    this.running = true;

    const processEvent = async (
      txId: string,
      sender: string,
      destinationChainId: string,
      destinationAddress: string,
      payload: string,
      nonce: bigint,
      timestamp: bigint,
      eventData: ethers.ContractEventPayload
    ) => {
      try {
        const blockNumber = eventData.log.blockNumber;
        // Wait for configured confirmations
        if (CONFIRMATIONS > 1) {
          await this.provider.waitForTransaction(eventData.log.transactionHash, CONFIRMATIONS);
        }
        const event: TransactionEvent = {
          txId,
          sender,
          destinationChainId,
          destinationAddress,
          payload,
          nonce,
          timestamp,
          blockNumber,
          blockHash: eventData.log.blockHash,
          transactionHash: eventData.log.transactionHash,
        };
        log.info({ txId, blockNumber }, "TransactionSent event received");
        await onEvent(event);
      } catch (err) {
        log.error({ err, txId }, "Error processing TransactionSent event");
      }
    };

    // Subscribe to live events
    this.contract.on("TransactionSent", processEvent);
    this.contract.on("TransactionCancelled", async (txId: string, sender: string) => {
      log.info({ txId, sender }, "TransactionCancelled event received");
      await onCancel(txId, sender);
    });

    // Periodic polling to catch missed events (on HTTP providers)
    if (!SOURCE_RPC_URL.startsWith("ws")) {
      this.startPolling(onEvent, onCancel);
    }

    log.info("Listening for events...");
  }

  private startPolling(onEvent: EventCallback, onCancel: CancelCallback) {
    const poll = async () => {
      if (!this.running) return;
      try {
        const currentBlock = await this.provider.getBlockNumber();
        if (currentBlock > this.lastProcessedBlock) {
          const fromBlock = this.lastProcessedBlock + 1;
          const toBlock   = Math.min(currentBlock, fromBlock + 999); // batch max 1000

          const sentEvents = await this.contract.queryFilter(
            this.contract.filters.TransactionSent(),
            fromBlock, toBlock
          );

          for (const e of sentEvents) {
            const decoded = this.contract.interface.parseLog({ topics: [...e.topics], data: e.data });
            if (!decoded) continue;
            const args = decoded.args;
            await onEvent({
              txId: args.txId,
              sender: args.sender,
              destinationChainId: args.destinationChainId,
              destinationAddress: args.destinationAddress,
              payload: args.payload,
              nonce: args.nonce,
              timestamp: args.timestamp,
              blockNumber: e.blockNumber,
              blockHash: e.blockHash,
              transactionHash: e.transactionHash,
            });
          }

          const cancelEvents = await this.contract.queryFilter(
            this.contract.filters.TransactionCancelled(),
            fromBlock, toBlock
          );
          for (const e of cancelEvents) {
            const decoded = this.contract.interface.parseLog({ topics: [...e.topics], data: e.data });
            if (!decoded) continue;
            await onCancel(decoded.args.txId, decoded.args.sender);
          }

          this.lastProcessedBlock = toBlock;
        }
      } catch (err) {
        log.warn({ err }, "Poll error (will retry)");
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    };

    setTimeout(poll, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.contract.removeAllListeners();
    if (this.provider instanceof ethers.WebSocketProvider) {
      await this.provider.destroy();
    }
    log.info("EVM adapter stopped");
  }
}
