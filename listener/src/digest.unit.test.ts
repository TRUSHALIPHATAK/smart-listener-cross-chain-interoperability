import { canonicalDigest, sepoliaEscrowDigest } from "./digest";

describe("canonicalDigest", () => {
  it("matches the published v1 vector", () => {
    expect(canonicalDigest({
      sourceTxId: "0x1111111111111111111111111111111111111111111111111111111111111111",
      sourceChainId: 31337,
      destinationChainId: 31338,
      destinationRouteId: "0x746573742d636861696e00000000000000000000000000000000000000000000",
      receiver: "0x2222222222222222222222222222222222222222",
      payloadHash: "0xebc84cbd75ba5516bf45e7024a9e12bc3c5c880f73e3a5beca7ebba52b2867a7",
      recipient: "0x0000000000000000000000000000000000000000",
      transferMode: "MESSAGE_ONLY",
      amount: 0n,
      nonce: 7n,
      deadline: 3600n,
    })).toBe("0x10f2876f8ab348079039385de7fcc6329b371d07252cce515abb2361dd6a307c");
  });

  describe("sepoliaEscrowDigest", () => {
    it("matches the Solidity escrow vector", () => {
      expect(sepoliaEscrowDigest({
        txId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sender: "0x1111111111111111111111111111111111111111",
        destinationChainId: "0x" + "00".repeat(32),
        destinationAddress: "0x2222222222222222222222222222222222222222",
        payload: "0x",
        payloadHash: "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8",
        nonce: "9",
        deadline: "2000000000",
        sourceTimestamp: 0,
        sourceBlockNumber: 0,
        status: "PENDING",
        createdAt: 0,
        updatedAt: 0,
        approveVotes: 0,
        rejectVotes: 0,
        requestedAmountWei: "1000000000000000",
      }, "0x3333333333333333333333333333333333333333", 11155111))
        .toBe("0xe751e08164217710a6f6f79d0cc2fce60cc020b378397557a264a7f2a71f9f65");
    });
  });
});
