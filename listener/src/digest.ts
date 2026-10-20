import { ethers } from "ethers";
import { CrossChainTransaction, TransferMode } from "./types";

export const DIGEST_DOMAIN = "SmartListenerCrossChain:v1";
const TYPE_HASH = ethers.keccak256(ethers.toUtf8Bytes(
  "SmartListenerCrossChain(bytes32 sourceTxId,uint256 sourceChainId,uint256 destinationChainId,bytes32 destinationRouteId,address receiver,bytes32 payloadHash,address recipient,uint8 transferMode,uint256 amount,uint256 nonce,uint256 deadline)"
));

export interface DigestInput {
  sourceTxId: string;
  sourceChainId: bigint | number;
  destinationChainId: bigint | number;
  destinationRouteId: string;
  receiver: string;
  payloadHash: string;
  recipient: string;
  transferMode: TransferMode;
  amount: bigint | string;
  nonce: bigint | string;
  deadline: bigint | string;
}

export function canonicalDigest(input: DigestInput): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "bytes32", "bytes32", "uint256", "bytes32", "uint256", "bytes32", "address", "bytes32",
      "address", "uint8", "uint256", "uint256", "uint256",
    ],
    [
      ethers.keccak256(ethers.toUtf8Bytes(DIGEST_DOMAIN)),
      TYPE_HASH,
      input.sourceChainId,
      input.sourceTxId,
      input.destinationChainId,
      input.destinationRouteId,
      input.receiver,
      input.payloadHash,
      input.recipient,
      input.transferMode === "ETH_TRANSFER" ? 1 : 0,
      input.amount,
      input.nonce,
      input.deadline,
    ],
  );
  return ethers.keccak256(encoded);
}

export function transactionDigest(
  tx: CrossChainTransaction,
  receiver: string,
  sourceChainId: bigint | number,
  destinationChainId: bigint | number,
  destinationRouteId = tx.destinationChainId,
): string {
  const payloadHash = tx.payloadHash ?? ethers.keccak256(tx.payload);
  const recipient = tx.transferMode === "ETH_TRANSFER"
    ? ethers.getAddress(tx.destinationAddress)
    : ethers.ZeroAddress;
  return canonicalDigest({
    sourceTxId: tx.txId,
    sourceChainId,
    destinationChainId,
    destinationRouteId,
    receiver,
    payloadHash,
    recipient,
    transferMode: tx.transferMode ?? "MESSAGE_ONLY",
    amount: tx.requestedAmountWei ?? "0",
    nonce: tx.nonce,
    deadline: tx.deadline ?? "0",
  });
}

export function sepoliaEscrowDigest(
  tx: CrossChainTransaction,
  escrowAddress: string,
  chainId: bigint | number,
): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "uint256", "bytes32", "address", "address", "uint256", "bytes32", "uint256", "uint256"],
    [
      ethers.keccak256(ethers.toUtf8Bytes("SmartListenerSepoliaEscrow:v1")),
      escrowAddress,
      chainId,
      tx.txId,
      ethers.getAddress(tx.sender),
      ethers.getAddress(tx.destinationAddress),
      tx.requestedAmountWei ?? "0",
      tx.payloadHash ?? ethers.keccak256(tx.payload),
      tx.deadline ?? "0",
      tx.nonce,
    ],
  ));
}
