import { currentLeader, leaderForRound, leaderRound } from "./leader";

describe("leader rotation", () => {
  it("selects the same leader for every listener from a round", () => {
    expect(leaderForRound(0)).toBe("A");
    expect(leaderForRound(1)).toBe("B");
    expect(leaderForRound(4)).toBe("A");
  });

  it("advances deterministically at the configured round boundary", () => {
    const start = 30_000;
    expect(leaderRound(start)).toBe(1);
    expect(currentLeader(start)).toBe("B");
    expect(currentLeader(start + 30_000)).toBe("C");
  });
});
