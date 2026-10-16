import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Demo script: fires several cross-chain transactions at the SenderContract.
 * Run after `npm run deploy:local` while `npx hardhat node` is running.
 */
async function main() {
  const [sender] = await ethers.getSigners();

  const deploymentPath = path.join(__dirname, "..", "deployments", "localhost.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("No deployment found. Run `npm run deploy:local` first.");
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const senderAddress = deployment.contracts.SenderContract;
  console.log("Using SenderContract at:", senderAddress);

  const SenderContract = await ethers.getContractAt("SenderContract", senderAddress);

  // Destination chain: simulated EVM mock chain (bytes32 label)
  const DEST_CHAIN_ID = ethers.encodeBytes32String("simulated-evm-chain");
  const DEST_ADDRESS  = ethers.toUtf8Bytes("0xRecipientAddressOnDest");

  const transactions = [
    { label: "Token Transfer", payload: ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["transfer", ethers.parseEther("1.0")]) },
    { label: "NFT Bridge",     payload: ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["nft_bridge", 42n]) },
    { label: "Message Relay",  payload: ethers.toUtf8Bytes("Hello from source chain!") },
  ];

  for (const tx of transactions) {
    console.log(`\n→ Sending: ${tx.label}`);
    const txn = await SenderContract.sendCrossChainTransaction(
      DEST_CHAIN_ID,
      DEST_ADDRESS,
      tx.payload
    );
    const receipt = await txn.wait();
    const event = receipt?.logs
      .map((log) => {
        try { return SenderContract.interface.parseLog(log); } catch { return null; }
      })
      .find((e) => e?.name === "TransactionSent");

    if (event) {
      console.log("  txId:", event.args.txId);
      console.log("  nonce:", event.args.nonce.toString());
      console.log("  block:", receipt?.blockNumber);
    }
  }

  console.log("\n✓ All demo transactions sent. Watch the Listener logs and dashboard.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
