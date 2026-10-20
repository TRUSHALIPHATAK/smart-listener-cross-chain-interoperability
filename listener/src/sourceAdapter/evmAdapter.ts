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
  SOURCE_CHAIN_ID,
  SOURCE_MODE,
  SENDER_CONTRACT_ADDRESS,
  SEPOLIA_ESCROW_ADDRESS,
  POLL_INTERVAL_MS,
  CONFIRMATIONS,
  START_BLOCK,
} from "../config";

const log = childLogger("evmAdapter");

// Minimal ABI — only the event we care about
const SENDER_ABI = [
  "event TransactionSent(bytes32 indexed txId, address indexed sender, bytes32 indexed destinationChainId, bytes destinationAddress, bytes payload, uint256 nonce, uint256 timestamp, uint256 amount, uint256 deadline)",
  "event TransactionCancelled(bytes32 indexed txId, address indexed sender)",
];
const ESCROW_ABI = [
  "event Deposited(bytes32 indexed txId, address indexed sender, address indexed recipient, uint256 amount, bytes32 payloadHash, uint256 deadline, uint256 nonce)",
  "function deposits(bytes32) view returns (address sender,address recipient,uint256 amount,bytes32 payloadHash,uint256 deadline,uint256 nonce,bool released,bool refunded)",
];

export type EventCallback   = (event: TransactionEvent) => Promise<void>;
export type CancelCallback  = (txId: string, sender: string) => Promise<void>;

export class EvmSourceAdapter {
  private provider!: ethers.JsonRpcProvider | ethers.WebSocketProvider;
  private contract!: ethers.Contract;
  private running = false;
  private lastProcessedBlock = 0;
  private cursorReset = false;

  async connect(lastProcessedBlock?: number): Promise<void> {
    const url = SOURCE_RPC_URL;
    if (url.startsWith("ws")) {
      this.provider = new ethers.WebSocketProvider(url);
      log.info({ url }, "Connected via WebSocket");
    } else {
      this.provider = new ethers.JsonRpcProvider(url);
      log.info({ url }, "Connected via HTTP (polling)");
    }

    const network = await this.provider.getNetwork();
    if (Number(network.chainId) !== SOURCE_CHAIN_ID) {
      throw new Error(`Source RPC chain ID ${network.chainId} does not match configured ${SOURCE_CHAIN_ID}`);
    }

    const address = SOURCE_MODE === "sepolia" ? SEPOLIA_ESCROW_ADDRESS : SENDER_CONTRACT_ADDRESS;
    if (!address) {
      throw new Error("SENDER_CONTRACT_ADDRESS is not set. Run deploy:local first.");
    }

    if (await this.provider.getCode(address) === "0x") {
      throw new Error(`No contract code at ${address} on source chain ${SOURCE_CHAIN_ID}`);
    }

    this.contract = new ethers.Contract(address, SOURCE_MODE === "sepolia" ? ESCROW_ABI : SENDER_ABI, this.provider);
    // Resume from the durable cursor when available; otherwise replay from START_BLOCK
    // so events emitted while this listener was down are not lost.
    this.lastProcessedBlock = lastProcessedBlock ?? (START_BLOCK - 1);
    const latestBlock = await this.provider.getBlockNumber();
    if (lastProcessedBlock !== undefined && lastProcessedBlock > latestBlock) {
      this.lastProcessedBlock = START_BLOCK - 1;
      this.cursorReset = true;
      log.warn(
        { savedCursor: lastProcessedBlock, latestBlock, resetTo: this.lastProcessedBlock },
        "Source chain height regressed; resetting stale listener cursor"
      );
    }
    log.info({ address, sourceMode: SOURCE_MODE, startBlock: this.lastProcessedBlock }, "Source contract attached");
  }

  didResetCursor(): boolean {
    return this.cursorReset;
  }

  isConnected(): boolean {
    return this.running;
  }

  getLastProcessedBlock(): number {
    return this.lastProcessedBlock;
  }

  async validateAuthoritativeEvent(event: TransactionEvent): Promise<{ valid: boolean; reason?: string }> {
    if (SOURCE_MODE !== "sepolia") return { valid: true };
    if (event.sourceContractAddress !== SEPOLIA_ESCROW_ADDRESS) {
      return { valid: false, reason: "Unexpected escrow contract address" };
    }
    const d = await this.contract.deposits(event.txId);
    if (d.sender === ethers.ZeroAddress || d.released || d.refunded) {
      return { valid: false, reason: "Escrow deposit is missing or no longer pending" };
    }
    if (
      ethers.getAddress(d.sender) !== ethers.getAddress(event.sender) ||
      ethers.getAddress(d.recipient) !== ethers.getAddress(event.destinationAddress) ||
      d.amount !== event.amount ||
      d.payloadHash.toLowerCase() !== (event.payloadHash ?? event.payload).toLowerCase() ||
      d.deadline !== event.deadline ||
      d.nonce !== event.nonce
    ) {
      return { valid: false, reason: "Escrow storage does not match deposit event" };
    }
    return { valid: true };
  }

  /**
   * Start listening for events. Calls onEvent for each confirmed TransactionSent.
   * Falls back to polling every POLL_INTERVAL_MS if real-time subscription fails.
   */
  async listen(
    onEvent: EventCallback,
    onCancel: CancelCallback,
    onBlockProcessed?: (blockNumber: number) => Promise<void>,
  ): Promise<void> {
    this.running = true;

    const processEvent = async (
      txId: string,
      sender: string,
      destinationChainId: string,
      destinationAddress: string,
      payload: string,
      nonce: bigint,
      timestamp: bigint,
      amount: bigint,
      deadline: bigint,
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
          amount,
          deadline,
          blockNumber,
          blockHash: eventData.log.blockHash,
          transactionHash: eventData.log.transactionHash,
          sourceContractAddress: SOURCE_MODE === "sepolia" ? SEPOLIA_ESCROW_ADDRESS : SENDER_CONTRACT_ADDRESS,
        };
        log.info({ txId, blockNumber }, "TransactionSent event received");
        await onEvent(event);
      } catch (err) {
        log.error({ err, txId }, "Error processing TransactionSent event");
      }
    };

    // Hardhat's HTTP filter subscriptions can return malformed results through
    // ethers' FilterIdEventSubscriber. Polling is authoritative for HTTP.
    if (SOURCE_RPC_URL.startsWith("ws")) {
      if (SOURCE_MODE === "sepolia") {
        this.contract.on("Deposited", async (
          txId: string, sender: string, recipient: string, amount: bigint,
          payloadHash: string, deadline: bigint, nonce: bigint,
          eventData: ethers.ContractEventPayload,
        ) => {
          const block = await this.provider.getBlock(eventData.log.blockNumber);
          await processEvent(
            txId, sender, ethers.zeroPadValue(ethers.toBeHex(SOURCE_CHAIN_ID), 32),
            recipient, payloadHash, nonce, BigInt(block?.timestamp ?? 0), amount, deadline, eventData,
          );
        });
      } else {
      this.contract.on("TransactionSent", processEvent);
      this.contract.on("TransactionCancelled", async (txId: string, sender: string) => {
        log.info({ txId, sender }, "TransactionCancelled event received");
        await onCancel(txId, sender);
      });
      }
    }

    // Periodic polling to catch missed events (on HTTP providers)
    if (!SOURCE_RPC_URL.startsWith("ws")) {
      this.startPolling(onEvent, onCancel, onBlockProcessed);
    }

    log.info("Listening for events...");
  }

  private startPolling(
    onEvent: EventCallback,
    onCancel: CancelCallback,
    onBlockProcessed?: (blockNumber: number) => Promise<void>,
  ) {
    const poll = async () => {
      if (!this.running) return;
      try {
        const currentBlock = await this.provider.getBlockNumber();
        if (currentBlock > this.lastProcessedBlock) {
          const fromBlock = this.lastProcessedBlock + 1;
          const toBlock   = Math.min(currentBlock, fromBlock + 999); // batch max 1000

          const eventName = SOURCE_MODE === "sepolia" ? "Deposited" : "TransactionSent";
          const sentEvents = await this.contract.queryFilter(
            this.contract.filters[eventName](),
            fromBlock, toBlock
          );

          for (const e of sentEvents) {
            const decoded = this.contract.interface.parseLog({ topics: [...e.topics], data: e.data });
            if (!decoded) continue;
            const args = decoded.args;
            const block = SOURCE_MODE === "sepolia"
              ? await this.provider.getBlock(e.blockNumber)
              : null;
            await onEvent(SOURCE_MODE === "sepolia" ? {
              txId: args.txId,
              sender: args.sender,
              destinationChainId: ethers.zeroPadValue(ethers.toBeHex(SOURCE_CHAIN_ID), 32),
              destinationAddress: args.recipient,
              payload: args.payloadHash,
              payloadHash: args.payloadHash,
              nonce: args.nonce,
              timestamp: BigInt(block?.timestamp ?? 0),
              amount: args.amount,
              deadline: args.deadline,
              blockNumber: e.blockNumber,
              blockHash: e.blockHash,
              transactionHash: e.transactionHash,
              sourceContractAddress: SEPOLIA_ESCROW_ADDRESS,
            } : {
              txId: args.txId,
              sender: args.sender,
              destinationChainId: args.destinationChainId,
              destinationAddress: args.destinationAddress,
              payload: args.payload,
              nonce: args.nonce,
              timestamp: args.timestamp,
              amount: args.amount ?? 0n,
              deadline: args.deadline ?? 0n,
              blockNumber: e.blockNumber,
              blockHash: e.blockHash,
              transactionHash: e.transactionHash,
              sourceContractAddress: SENDER_CONTRACT_ADDRESS,
            });
          }

          if (SOURCE_MODE !== "sepolia") {
            const cancelEvents = await this.contract.queryFilter(
              this.contract.filters.TransactionCancelled(),
              fromBlock, toBlock
            );
            for (const e of cancelEvents) {
              const decoded = this.contract.interface.parseLog({ topics: [...e.topics], data: e.data });
              if (!decoded) continue;
              await onCancel(decoded.args.txId, decoded.args.sender);
            }
          }

          if (onBlockProcessed) await onBlockProcessed(toBlock);
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
