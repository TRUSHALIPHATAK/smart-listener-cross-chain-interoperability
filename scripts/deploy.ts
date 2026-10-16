import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // ── Deploy SenderContract ────────────────────────────────────────────────
  const SenderFactory = await ethers.getContractFactory("SenderContract");
  const sender = await SenderFactory.deploy();
  await sender.waitForDeployment();
  const senderAddress = await sender.getAddress();
  console.log("✓ SenderContract deployed at:", senderAddress);

  // ── Deploy ReceiverMock (executor = deployer for local demo) ─────────────
  const ReceiverFactory = await ethers.getContractFactory("ReceiverMock");
  const receiver = await ReceiverFactory.deploy(deployer.address);
  await receiver.waitForDeployment();
  const receiverAddress = await receiver.getAddress();
  console.log("✓ ReceiverMock deployed at:", receiverAddress);

  // ── Persist addresses for listener / scripts ─────────────────────────────
  const deploymentInfo = {
    network: (await ethers.provider.getNetwork()).name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      SenderContract: senderAddress,
      ReceiverMock: receiverAddress,
    },
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "localhost.json");
  fs.writeFileSync(outFile, JSON.stringify(deploymentInfo, null, 2));
  console.log("✓ Deployment info saved to:", outFile);

  // Copy to listener config dir so listener process can read it
  const listenerOutDir = path.join(__dirname, "..", "listener", "config");
  fs.mkdirSync(listenerOutDir, { recursive: true });
  fs.copyFileSync(outFile, path.join(listenerOutDir, "deployment.json"));
  console.log("✓ Copied to listener/config/deployment.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
