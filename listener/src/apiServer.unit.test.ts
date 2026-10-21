import {
  isApiOriginAllowed,
  validateSepoliaEscrowMetadata,
  validateSubmissionBody,
} from "./apiServer";

describe("transaction submission validation", () => {
  it("accepts a valid client submission without signing material", () => {
    expect(validateSubmissionBody({
      destinationAddress: "0xrecipient",
      payload: "hello",
    })).toBeNull();
  });

  describe("Sepolia escrow configuration validation", () => {
    const address = "0x1111111111111111111111111111111111111111";

    it("rejects a missing/invalid escrow address", () => {
      expect(validateSepoliaEscrowMetadata("", 11155111, "0x1234", 3n, 4n)).toMatch(/valid EVM address/);
    });

    it("rejects an address checked against the wrong chain", () => {
      expect(validateSepoliaEscrowMetadata(address, 31337, "0x1234", 3n, 4n)).toMatch(/expected 11155111/);
    });

    it("rejects an address without deployed bytecode", () => {
      expect(validateSepoliaEscrowMetadata(address, 11155111, "0x", 3n, 4n)).toMatch(/No contract bytecode/);
    });

    it("accepts a deployed 3-of-4 escrow", () => {
      expect(validateSepoliaEscrowMetadata(address, 11155111, "0x6000", 3n, 4n)).toBeNull();
    });
  });

  it("rejects client-supplied private keys", () => {
    expect(validateSubmissionBody({
      destinationAddress: "0xrecipient",
      payload: "hello",
      privateKey: "client-secret",
    })).toMatch(/privateKey must not be supplied/);
  });

  it("validates explicit nonces", () => {
    expect(validateSubmissionBody({ payload: "ok", nonce: "not-a-number" })).toMatch(/nonce/);
    expect(validateSubmissionBody({ payload: "ok", nonce: "7" })).toBeNull();
  });

  it("rejects missing or blank payloads", () => {
    expect(validateSubmissionBody({ destinationAddress: "0xrecipient" })).toBe("payload is required");
    expect(validateSubmissionBody({ payload: "   " })).toBe("payload is required");
  });

  it("allows the configured local dashboard origins and rejects other origins", () => {
    expect(isApiOriginAllowed("http://localhost:5173")).toBe(true);
    expect(isApiOriginAllowed("http://127.0.0.1:5173")).toBe(true);
    expect(isApiOriginAllowed("https://malicious.example")).toBe(false);
  });
});
