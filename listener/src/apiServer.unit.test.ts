import { isApiOriginAllowed, validateSubmissionBody } from "./apiServer";

describe("transaction submission validation", () => {
  it("accepts a valid client submission without signing material", () => {
    expect(validateSubmissionBody({
      destinationAddress: "0xrecipient",
      payload: "hello",
    })).toBeNull();
  });

  it("rejects client-supplied private keys", () => {
    expect(validateSubmissionBody({
      destinationAddress: "0xrecipient",
      payload: "hello",
      privateKey: "client-secret",
    })).toMatch(/privateKey must not be supplied/);
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
