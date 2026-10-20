import { LISTENER_IDS, ListenerId } from "./types";

export const LEADER_ROUND_SECONDS = Number(process.env.LEADER_ROUND_SECONDS ?? 30);

export function leaderForRound(round: number, total = LISTENER_IDS.length): ListenerId {
  return LISTENER_IDS[((round % total) + total) % total];
}

export function leaderRound(nowMs = Date.now()): number {
  return Math.floor(nowMs / (LEADER_ROUND_SECONDS * 1000));
}

export function currentLeader(nowMs = Date.now()): ListenerId {
  return leaderForRound(leaderRound(nowMs));
}

export function isLeader(listenerId: ListenerId, nowMs = Date.now()): boolean {
  return currentLeader(nowMs) === listenerId;
}
