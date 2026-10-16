import { expect } from "chai";
import { ethers } from "hardhat";
import { SenderContract, ReceiverMock } from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("SenderContract", () => {
  let sender: SenderContract;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;

  const DEST_CHAIN_ID = ethers.encodeBytes32String("test-chain");
  const DEST_ADDRESS  = ethers.toUtf8Bytes("0xDestAddress");
  const PAYLOAD       = ethers.toUtf8Bytes("test-payload");

  beforeEach(async () => {
    [owner, alice] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("SenderContract");
    sender = await Factory.deploy();
    await sender.waitForDeployment();
  });

  describe("sendCrossChainTransaction", () => {
    it("emits TransactionSent with correct fields", async () => {
      const tx = await sender.connect(alice).sendCrossChainTransaction(
        DEST_CHAIN_ID, DEST_ADDRESS, PAYLOAD
      );
      const receipt = await tx.wait();
      const event = receipt?.logs
        .map((log) => { try { return sender.interface.parseLog(log); } catch { return null; } })
        .find((e) => e?.name === "TransactionSent");

      expect(event).to.not.be.null;
      expect(event!.args.sender).to.equal(alice.address);
      expect(event!.args.destinationChainId).to.equal(DEST_CHAIN_ID);
      expect(event!.args.nonce).to.equal(0n);
    });

    it("produces unique txIds for consecutive calls from same sender", async () => {
      const tx1 = await sender.connect(alice).sendCrossChainTransaction(DEST_CHAIN_ID, DEST_ADDRESS, PAYLOAD);
      const tx2 = await sender.connect(alice).sendCrossChainTransaction(DEST_CHAIN_ID, DEST_ADDRESS, PAYLOAD);
      const r1 = await tx1.wait();
      const r2 = await tx2.wait();

      const parse = (receipt: typeof r1) =>
        receipt?.logs
          .map((l) => { try { return sender.interface.parseLog(l); } catch { return null; } })
          .find((e) => e?.name === "TransactionSent");

      const e1 = parse(r1);
      const e2 = parse(r2);
      expect(e1!.args.txId).to.not.equal(e2!.args.txId);
      expect(e1!.args.nonce).to.equal(0n);
      expect(e2!.args.nonce).to.equal(1n);
    });

    it("increments nonce per sender independently", async () => {
      await sender.connect(alice).sendCrossChainTransaction(DEST_CHAIN_ID, DEST_ADDRESS, PAYLOAD);
      await sender.connect(alice).sendCrossChainTransaction(DEST_CHAIN_ID, DEST_ADDRESS, PAYLOAD);
      await sender.connect(owner).sendCrossChainTransaction(DEST_CHAIN_ID, DEST_ADDRESS, PAYLOAD);

      expect(await sender.getNonce(alice.address)).to.equal(2n);
      expect(await sender.getNonce(owner.address)).to.equal(1n);
    });

    it("reverts with EmptyDestinationAddress", async () => {
      await expect(
        sender.sendCrossChainTransaction(DEST_CHAIN_ID, "0x", PAYLOAD)
      ).to.be.revertedWithCustomError(sender, "EmptyDestinationAddress");
    });

    it("reverts with EmptyPayload", async () => {
      await expect(
        sender.sendCrossChainTransaction(DEST_CHAIN_ID, DEST_ADDRESS, "0x")
      ).to.be.revertedWithCustomError(sender, "EmptyPayload");
    });

    it("reverts when paused", async () => {
      await sender.connect(owner).setPaused(true);
      await expect(
        sender.connect(alice).sendCrossChainTransaction(DEST_CHAIN_ID, DEST_ADDRESS, PAYLOAD)
      ).to.be.revertedWithCustomError(sender, "ContractPaused");
    });
  });

  describe("cancelTransaction", () => {
    it("emits TransactionCancelled", async () => {
      const tx = await sender.connect(alice).sendCrossChainTransaction(DEST_CHAIN_ID, DEST_ADDRESS, PAYLOAD);
      const receipt = await tx.wait();
      const event = receipt?.logs
        .map((l) => { try { return sender.interface.parseLog(l); } catch { return null; } })
        .find((e) => e?.name === "TransactionSent");

      const txId = event!.args.txId;

      await expect(sender.connect(alice).cancelTransaction(txId))
        .to.emit(sender, "TransactionCancelled")
        .withArgs(txId, alice.address);
    });

    it("reverts when non-sender tries to cancel", async () => {
      const tx = await sender.connect(alice).sendCrossChainTransaction(DEST_CHAIN_ID, DEST_ADDRESS, PAYLOAD);
      const receipt = await tx.wait();
      const event = receipt?.logs
        .map((l) => { try { return sender.interface.parseLog(l); } catch { return null; } })
        .find((e) => e?.name === "TransactionSent");

      const txId = event!.args.txId;

      await expect(
        sender.connect(owner).cancelTransaction(txId)
      ).to.be.revertedWithCustomError(sender, "NotTxSender");
    });
  });
});

describe("ReceiverMock", () => {
  let receiver: ReceiverMock;
  let executor: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const SOURCE_TX_ID = ethers.keccak256(ethers.toUtf8Bytes("test-tx-id"));
  const PAYLOAD      = ethers.toUtf8Bytes("execute-me");

  beforeEach(async () => {
    [executor, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ReceiverMock");
    receiver = await Factory.deploy(executor.address);
    await receiver.waitForDeployment();
  });

  it("executes successfully and records txId", async () => {
    await expect(receiver.connect(executor).execute(SOURCE_TX_ID, PAYLOAD))
      .to.emit(receiver, "CrossChainExecuted")
      .withArgs(SOURCE_TX_ID, executor.address, PAYLOAD, await ethers.provider.getBlock("latest").then(b => b!.timestamp + 1));

    expect(await receiver.wasExecuted(SOURCE_TX_ID)).to.be.true;
    expect(await receiver.getExecutionCount()).to.equal(1n);
  });

  it("reverts on duplicate execution (replay protection)", async () => {
    await receiver.connect(executor).execute(SOURCE_TX_ID, PAYLOAD);
    await expect(
      receiver.connect(executor).execute(SOURCE_TX_ID, PAYLOAD)
    ).to.be.revertedWithCustomError(receiver, "AlreadyExecuted");
  });

  it("reverts when called by non-executor", async () => {
    await expect(
      receiver.connect(other).execute(SOURCE_TX_ID, PAYLOAD)
    ).to.be.revertedWithCustomError(receiver, "NotExecutor");
  });

  it("reverts on empty payload", async () => {
    await expect(
      receiver.connect(executor).execute(SOURCE_TX_ID, "0x")
    ).to.be.revertedWithCustomError(receiver, "EmptyPayload");
  });
});
