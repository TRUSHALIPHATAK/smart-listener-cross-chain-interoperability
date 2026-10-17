/**
 * Unit tests for consensus.ts — pure function, no mocks needed
 */

import { evaluateConsensus, validateVote } from "./consensus";
import { ListenerVote } from "./types";

const makeVote = (listenerId: "A" | "B" | "C", vote: "APPROVE" | "REJECT"): ListenerVote => ({
  txId: "0xabc",
  listenerId,
  vote,
  votedAt: Date.now(),
});

describe("evaluateConsensus", () => {
  const cfg = { requiredVotes: 2, totalListeners: 3 };

  it("returns undecided with 0 votes", () => {
    const r = evaluateConsensus([], cfg);
    expect(r.approved).toBe(false);
    expect(r.rejected).toBe(false);
    expect(r.decided).toBe(false);
    expect(r.approveCount).toBe(0);
    expect(r.rejectCount).toBe(0);
  });

  it("returns undecided with 1 APPROVE", () => {
    const r = evaluateConsensus([makeVote("A", "APPROVE")], cfg);
    expect(r.approved).toBe(false);
    expect(r.decided).toBe(false);
  });

  it("approves with exactly 2 APPROVE votes", () => {
    const r = evaluateConsensus([makeVote("A", "APPROVE"), makeVote("B", "APPROVE")], cfg);
    expect(r.approved).toBe(true);
    expect(r.decided).toBe(true);
    expect(r.approveCount).toBe(2);
  });

  it("approves with all 3 APPROVE votes", () => {
    const r = evaluateConsensus([
      makeVote("A", "APPROVE"), makeVote("B", "APPROVE"), makeVote("C", "APPROVE")
    ], cfg);
    expect(r.approved).toBe(true);
    expect(r.approveCount).toBe(3);
  });

  it("rejects when 2 REJECTs make approval impossible", () => {
    const r = evaluateConsensus([makeVote("A", "REJECT"), makeVote("B", "REJECT")], cfg);
    expect(r.rejected).toBe(true);
    expect(r.decided).toBe(true);
    expect(r.approved).toBe(false);
  });

  it("undecided with 1 REJECT and 1 APPROVE (can still reach threshold)", () => {
    const r = evaluateConsensus([makeVote("A", "REJECT"), makeVote("B", "APPROVE")], cfg);
    expect(r.approved).toBe(false);
    expect(r.rejected).toBe(false);
    expect(r.decided).toBe(false);
  });

  it("rejects with all 3 REJECT votes", () => {
    const r = evaluateConsensus([
      makeVote("A", "REJECT"), makeVote("B", "REJECT"), makeVote("C", "REJECT")
    ], cfg);
    expect(r.rejected).toBe(true);
    expect(r.approved).toBe(false);
    expect(r.rejectCount).toBe(3);
  });

  it("respects custom threshold (1-of-3)", () => {
    const r = evaluateConsensus([makeVote("A", "APPROVE")], { requiredVotes: 1, totalListeners: 3 });
    expect(r.approved).toBe(true);
  });

  it("respects custom threshold (3-of-3)", () => {
    const r = evaluateConsensus([makeVote("A", "APPROVE"), makeVote("B", "APPROVE")], { requiredVotes: 3, totalListeners: 3 });
    expect(r.approved).toBe(false);
    expect(r.rejected).toBe(false);
  });
});

describe("validateVote", () => {
  const votes: ListenerVote[] = [makeVote("A", "APPROVE")];

  it("returns null for a valid new vote", () => {
    expect(validateVote("0xabc", "B", "APPROVE", votes)).toBeNull();
  });

  it("returns error if listener already voted", () => {
    expect(validateVote("0xabc", "A", "APPROVE", votes)).toMatch(/already voted/);
  });

  it("returns error for invalid listener ID", () => {
    expect(validateVote("0xabc", "D", "APPROVE", votes)).toMatch(/Invalid listenerId/);
  });

  it("returns error for invalid vote value", () => {
    // @ts-expect-error testing invalid value
    expect(validateVote("0xabc", "B", "MAYBE", votes)).toMatch(/Invalid vote value/);
  });

  it("returns error for empty txId", () => {
    expect(validateVote("", "B", "APPROVE", votes)).toMatch(/Invalid txId/);
  });
});
