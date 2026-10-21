import { ethers } from "ethers";

export const SEPOLIA_CHAIN_ID = 11155111n;
export const SEPOLIA_CHAIN_HEX = "0xaa36a7";
export const SEPOLIA_RPC_CHAIN_NAME = "Sepolia";
export const SEPOLIA_ESCROW_ABI = [
  "function deposit(bytes32 txId,address recipient,bytes32 payloadHash,uint256 deadline,uint256 nonce) payable",
];

export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export function getEthereumProvider(): EthereumProvider | null {
  const provider = window.ethereum;
  return provider ?? null;
}

export function formatAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatBalance(balanceWei: bigint): string {
  return ethers.formatEther(balanceWei);
}

export function explorerTransactionUrl(hash: string): string {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}
