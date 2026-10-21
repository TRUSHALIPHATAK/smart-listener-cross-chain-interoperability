import { expect } from "chai";
import { ethers } from "hardhat";
import { SenderContract, ReceiverMock, DestinationReceiver, SepoliaEscrow } from "../../typechain-types";
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

    describe("rollbackTransaction", () => {
      it("returns an escrow to the sender after the refund delay", async () => {
        const [ownerSigner, sourceSender] = await ethers.getSigners();
        const Factory = await ethers.getContractFactory("SenderContract");
        const contract = await Factory.deploy();
        await contract.waitForDeployment();
        const tx = await contract.connect(sourceSender).sendCrossChainTransaction(
          DEST_CHAIN_ID,
          DEST_ADDRESS,
          PAYLOAD,
          { value: ethers.parseEther("0.01") },
        );
        const receipt = await tx.wait();
        const event = receipt!.logs
          .map((log) => {
            try { return contract.interface.parseLog({ topics: [...log.topics], data: log.data }); } catch { return null; }
          })
          .find((parsed) => parsed?.name === "TransactionSent");
        const txId = event!.args.txId;

        await expect(contract.connect(ownerSigner).rollbackTransaction(txId))
          .to.be.revertedWithCustomError(contract, "RollbackTooEarly");
        await ethers.provider.send("evm_increaseTime", [60]);
        await ethers.provider.send("evm_mine", []);

        await expect(contract.connect(ownerSigner).rollbackTransaction(txId))
          .to.emit(contract, "TransactionRolledBack")
          .withArgs(txId, sourceSender.address, ethers.parseEther("0.01"));
        expect(await contract.txRolledBack(txId)).to.equal(true);
        expect(await contract.txSenders(txId)).to.equal(ethers.ZeroAddress);

        await expect(contract.connect(ownerSigner).rollbackTransaction(txId)).not.to.be.reverted;
      });
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

  describe("SepoliaEscrow", () => {
    let escrow: SepoliaEscrow;
    let owner: HardhatEthersSigner;
    let sender: HardhatEthersSigner;
    let recipient: HardhatEthersSigner;
    let listeners: HardhatEthersSigner[];
    let listenerWallets: ethers.HDNodeWallet[];
    const payloadHash = ethers.keccak256(ethers.toUtf8Bytes("payload"));
    const txId = ethers.keccak256(ethers.toUtf8Bytes("escrow-tx"));

    beforeEach(async () => {
      [owner, sender, recipient, ...listeners] = await ethers.getSigners();
      listenerWallets = [1, 2, 3, 4].map((index) =>
        ethers.HDNodeWallet.fromPhrase(
          "test test test test test test test test test test test junk",
          undefined, `m/44'/60'/0'/0/${index}`,
        ).connect(ethers.provider),
      );
      const Factory = await ethers.getContractFactory("SepoliaEscrow");
      escrow = await Factory.deploy(listenerWallets.map((x) => x.address), 3);
      await escrow.waitForDeployment();
    });

    async function deposit(deadline?: bigint) {
      const block = await ethers.provider.getBlock("latest");
      const effectiveDeadline = deadline ?? BigInt((block?.timestamp ?? 0) + 3600);
      await escrow.connect(sender).deposit(txId, recipient.address, payloadHash, effectiveDeadline, 11, {
        value: ethers.parseEther("1"),
      });
    }

    async function signatures() {
      const digest = await escrow.digest(txId);
      return listenerWallets.slice(0, 3).map((listener) => listener.signingKey.sign(digest).serialized);
    }

    it("releases the exact amount only with 3 distinct authorized approvals", async () => {
      await deposit();
      const before = await ethers.provider.getBalance(recipient.address);
      await expect(escrow.connect(listenerWallets[0]).release(txId, await signatures()))
        .to.emit(escrow, "Released").withArgs(txId, listenerWallets[0].address, ethers.parseEther("1"));
      expect(await ethers.provider.getBalance(recipient.address)).to.equal(before + ethers.parseEther("1"));
      await expect(escrow.connect(listenerWallets[1]).release(txId, await signatures()))
        .to.be.revertedWithCustomError(escrow, "TransactionAlreadySettled");
    });

    it("rejects one or two approvals, duplicate and unregistered signatures", async () => {
      await deposit();
      const digest = await escrow.digest(txId);
      const one = listenerWallets[0].signingKey.sign(digest).serialized;
      const two = listenerWallets[1].signingKey.sign(digest).serialized;
      await expect(escrow.connect(listenerWallets[0]).release(txId, [one]))
        .to.be.revertedWithCustomError(escrow, "NotEnoughSignatures");
      await expect(escrow.connect(listenerWallets[0]).release(txId, [one, two]))
        .to.be.revertedWithCustomError(escrow, "NotEnoughSignatures");
      await expect(escrow.connect(listenerWallets[0]).release(txId, [one, one, one]))
        .to.be.revertedWithCustomError(escrow, "DuplicateSigner");
      const unauthorized = ethers.HDNodeWallet.fromPhrase(
        "test test test test test test test test test test test junk",
        undefined, "m/44'/60'/0'/0/0",
      ).signingKey.sign(digest).serialized;
      await expect(escrow.connect(listenerWallets[0]).release(txId, [one, two, unauthorized]))
        .to.be.revertedWithCustomError(escrow, "UnauthorizedSigner");
    });

    it("binds approvals to the exact transaction data and supports sender-only timeout refund", async () => {
      await deposit();
      const otherTxId = ethers.keccak256(ethers.toUtf8Bytes("other"));
      const digest = await escrow.digest(txId);
      const sigs = listenerWallets.slice(0, 3).map((listener) => listener.signingKey.sign(digest).serialized);
      await expect(escrow.connect(listenerWallets[0]).release(otherTxId, sigs))
        .to.be.revertedWithCustomError(escrow, "TransactionAlreadySettled");
      await expect(escrow.connect(owner).refund(txId)).to.be.revertedWithCustomError(escrow, "NotSender");
      const block = await ethers.provider.getBlock("latest");
      await ethers.provider.send("evm_setNextBlockTimestamp", [(block?.timestamp ?? 0) + 7200]);
      await ethers.provider.send("evm_mine", []);
      await expect(escrow.connect(sender).refund(txId))
        .to.emit(escrow, "Refunded").withArgs(txId, sender.address, ethers.parseEther("1"));
      await expect(escrow.connect(sender).refund(txId))
        .to.be.revertedWithCustomError(escrow, "TransactionAlreadySettled");
    });
  });

  describe("DestinationReceiver cryptographic consensus", () => {
    let receiver: DestinationReceiver;
    let a: ethers.HDNodeWallet;
    let b: ethers.HDNodeWallet;
    const sourceTxId = ethers.keccak256(ethers.toUtf8Bytes("signed-tx"));
    const route = ethers.encodeBytes32String("dest");
    const payload = ethers.toUtf8Bytes("signed-payload");

    beforeEach(async () => {
      const mnemonic = "test test test test test test test test test test test junk";
      a = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0").connect(ethers.provider);
      b = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/1").connect(ethers.provider);
      const Factory = await ethers.getContractFactory("DestinationReceiver");
      receiver = await Factory.deploy([a.address, b.address], 31337, 2);
      await receiver.waitForDeployment();
    });

    it("rejects a non-majority threshold at deployment", async () => {
      const Factory = await ethers.getContractFactory("DestinationReceiver");
      await expect(Factory.deploy([a.address, b.address], 31337, 1))
        .to.be.revertedWithCustomError(Factory, "InvalidConfiguration");
    });

    async function signatures(nonce = 4n, deadline = 9999999999n) {
      const digest = await receiver.digest(
        sourceTxId, route, ethers.keccak256(payload), ethers.ZeroAddress, 0, 0, nonce, deadline,
      );
      return [a.signingKey.sign(digest).serialized, b.signingKey.sign(digest).serialized];
    }

    it("requires distinct authorized signatures and prevents replay", async () => {
      const deadline = 9999999999n;
      await expect(receiver.execute(sourceTxId, route, payload, 4, deadline, await signatures(4n, deadline)))
        .to.emit(receiver, "InterChainCompleted");
      await expect(receiver.execute(sourceTxId, route, payload, 4, deadline, await signatures(4n, deadline)))
        .to.be.revertedWithCustomError(receiver, "AlreadyExecuted");
    });

    it("rejects tampered payloads and duplicate signers", async () => {
      const sigs = await signatures();
      await expect(receiver.execute(
        sourceTxId, route, ethers.toUtf8Bytes("tampered"), 4, 9999999999n, sigs,
      )).to.be.reverted;
      await expect(receiver.execute(
        sourceTxId, route, payload, 4, 9999999999n, [sigs[0], sigs[0]],
      )).to.be.revertedWithCustomError(receiver, "DuplicateSigner");
    });

    it("rejects insufficient and unauthorized signatures", async () => {
      const sigs = await signatures();
      await expect(receiver.execute(sourceTxId, route, payload, 4, 9999999999n, [sigs[0]]))
        .to.be.revertedWithCustomError(receiver, "InsufficientSignatures");
      const unauthorized = ethers.HDNodeWallet.fromPhrase(
        "test test test test test test test test test test test junk",
        undefined, "m/44'/60'/0'/0/2",
      ).connect(ethers.provider);
      const digest = await receiver.digest(
        ethers.keccak256(ethers.toUtf8Bytes("unauthorized")), route, ethers.keccak256(payload),
        ethers.ZeroAddress, 0, 0, 4, 9999999999n,
      );
      await expect(receiver.execute(
        ethers.keccak256(ethers.toUtf8Bytes("unauthorized")), route, payload, 4, 9999999999n,
        [a.signingKey.sign(digest).serialized, unauthorized.signingKey.sign(digest).serialized],
      )).to.be.revertedWithCustomError(receiver, "UnauthorizedSigner");
    });

    it("rejects malleable high-s signatures", async () => {
      const serialized = (await signatures())[0].slice(2);
      const r = serialized.slice(0, 64);
      const s = BigInt(`0x${serialized.slice(64, 128)}`);
      const v = Number.parseInt(serialized.slice(128, 130), 16);
      const curveOrder = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
      const highS = (curveOrder - s).toString(16).padStart(64, "0");
      const malleable = `0x${r}${highS}${(v === 27 ? 28 : 27).toString(16).padStart(2, "0")}`;
      await expect(receiver.execute(
        sourceTxId, route, payload, 4, 9999999999n, [malleable, (await signatures())[1]],
      )).to.be.revertedWithCustomError(receiver, "InvalidSignature");
    });
  });

  it("executes successfully and records txId", async () => {
    await expect(receiver.connect(executor).execute(SOURCE_TX_ID, PAYLOAD))
      .to.emit(receiver, "CrossChainExecuted")
      .withArgs(SOURCE_TX_ID, executor.address, PAYLOAD, (value: bigint) => value > 0n);

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
