import { ethers } from "hardhat";

async function main() {
  const rawListeners = process.env.SEPOLIA_LISTENER_ADDRESSES;
  if (!rawListeners) throw new Error("Set SEPOLIA_LISTENER_ADDRESSES to four comma-separated listener addresses");
  const listeners = rawListeners.split(",").map((value) => value.trim()).filter(Boolean);
  if (listeners.length !== 4 || listeners.some((address) => !ethers.isAddress(address))) {
    throw new Error("SEPOLIA_LISTENER_ADDRESSES must contain exactly four valid addresses");
  }
  const escrow = await ethers.deployContract("SepoliaEscrow", [listeners, 3]);
  await escrow.waitForDeployment();
  console.log(`SepoliaEscrow deployed at ${await escrow.getAddress()}`);
  console.log(`Listeners: ${listeners.join(",")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
