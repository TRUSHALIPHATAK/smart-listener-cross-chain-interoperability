import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const requiredPositiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

/**
 * Deploys DestinationReceiver on the DESTINATION chain (run with --network destination).
 * Must run AFTER scripts/deploy.ts (it merges into listener/config/deployment.json).
 * Hardhat accounts #1..#4 become the allowed executors (Listeners A..D).
 */
async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const executors = signers.slice(1, 5).map((s) => s.address);
  const net = await ethers.provider.getNetwork();
  const sourceChainId = requiredPositiveInt("SOURCE_CHAIN_ID", 31337);
  const requiredVotes = requiredPositiveInt("REQUIRED_VOTES", 3);
  const totalListeners = requiredPositiveInt("TOTAL_LISTENERS", 4);
  if (totalListeners !== executors.length || requiredVotes > totalListeners || requiredVotes <= totalListeners / 2) {
    throw new Error(`Invalid consensus configuration: ${requiredVotes}/${totalListeners}`);
  }

  console.log("Destination chainId:", net.chainId.toString());
  console.log("Deployer:", deployer.address);
  console.log("Executors (A-D):", executors.join(", "));

  const Factory = await ethers.getContractFactory("DestinationReceiver");
  const receiver = await Factory.deploy(executors, sourceChainId, requiredVotes);
  await receiver.waitForDeployment();
  const address = await receiver.getAddress();
  console.log("DestinationReceiver deployed at:", address);
  const reserveTx = await deployer.sendTransaction({
    to: address,
    value: ethers.parseEther("100"),
  });
  await reserveTx.wait();
  console.log("DestinationReceiver reserve funded with 100 ETH");

  const file = path.join(__dirname, "..", "listener", "config", "deployment.json");
  if (!fs.existsSync(file)) {
    throw new Error("listener/config/deployment.json not found - run scripts/deploy.ts on the source chain first.");
  }
  const info = JSON.parse(fs.readFileSync(file, "utf8"));
  info.contracts.DestinationReceiver = address;
  info.destination = {
    chainId: net.chainId.toString(),
    deployer: deployer.address,
    executors,
    reserveWei: ethers.parseEther("100").toString(),
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(info, null, 2));

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(file, path.join(outDir, "localhost.json"));
  console.log("Saved to listener/config/deployment.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
