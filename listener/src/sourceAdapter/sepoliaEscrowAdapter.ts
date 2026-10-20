import { ethers } from "ethers";
import { CrossChainTransaction, DestinationResult, LISTENER_IDS } from "../types";
import { getDb } from "../db";
import { childLogger } from "../logger";
import {
  LISTENER_ID,
  SEPOLIA_ESCROW_ADDRESS,
  SEPOLIA_LISTENER_MNEMONIC,
  SEPOLIA_RPC_URL,
  SOURCE_CHAIN_ID,
} from "../config";
import { sepoliaEscrowDigest } from "../digest";

const log = childLogger("sepoliaEscrowAdapter");
const ABI = [
  "function deposits(bytes32) view returns (address,address,uint256,bytes32,uint256,uint256,bool,bool)",
  "function release(bytes32,bytes[])",
  "event Released(bytes32 indexed txId,address indexed relayer,uint256 amount)",
];

let contract: ethers.Contract | undefined;

function getContract(): ethers.Contract {
  if (contract) return contract;
  if (!SEPOLIA_RPC_URL || !SEPOLIA_ESCROW_ADDRESS) {
    throw new Error("SEPOLIA_RPC_URL and SEPOLIA_ESCROW_ADDRESS are required");
  }
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const index = LISTENER_IDS.indexOf(LISTENER_ID) + 1;
  const wallet = ethers.HDNodeWallet.fromPhrase(
    SEPOLIA_LISTENER_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`,
  );
  contract = new ethers.Contract(
    SEPOLIA_ESCROW_ADDRESS, ABI, new ethers.NonceManager(wallet.connect(provider)),
  );
  log.info({ relayer: wallet.address, escrow: SEPOLIA_ESCROW_ADDRESS }, "Sepolia escrow coordinator ready");
  return contract;
}

export async function sepoliaEscrowExecute(tx: CrossChainTransaction): Promise<DestinationResult> {
  const started = Date.now();
  try {
    const c = getContract();
    const state = await c.deposits(tx.txId);
    if (state[0] === ethers.ZeroAddress) return { success: false, errorMessage: "Escrow deposit not found" };
    if (state[6] || state[7]) return { success: true, destTxHash: undefined, latencyMs: Date.now() - started };

    const digest = sepoliaEscrowDigest(tx, SEPOLIA_ESCROW_ADDRESS, SOURCE_CHAIN_ID);
    const votes = await (await getDb()).getVotes(tx.txId);
    const signatures = votes
      .filter((v) => v.vote === "APPROVE" && v.signature && v.digest === digest)
      .map((v) => v.signature as string);
    const response = await c.release(tx.txId, signatures);
    const receipt = await response.wait();
    if (!receipt || receipt.status !== 1) {
      return { success: false, errorMessage: "Sepolia escrow release reverted" };
    }
    return {
      success: true,
      destTxHash: receipt.hash,
      latencyMs: Date.now() - started,
      transferredAmountWei: tx.requestedAmountWei,
    };
  } catch (err) {
    const message = (err as { shortMessage?: string }).shortMessage ?? (err as Error).message;
    log.warn({ txId: tx.txId, message }, "Sepolia escrow release failed");
    return { success: false, errorMessage: message };
  }
}
