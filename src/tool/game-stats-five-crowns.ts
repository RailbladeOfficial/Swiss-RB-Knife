/* =============================================================================
   GAME STATS: FIVE CROWNS
   -----------------------------------------------------------------------------
   Everything specific to Five Crowns: round structure, the overtime tie-break
   algorithm (the user's own house rule, official Five Crowns rules don't
   define one), and round-label formatting. game-stats.ts owns the generic
   shell (profiles, persistence, views); this file only knows about rounds
   and scores.

   Rules encoded here (confirmed with the user):
     • Rounds 3-13 are fixed (11 rounds); card count == round index.
     • Overtime triggers ONLY on a tie in the final running total after
       Round 13 is entered, not after any of the normal rounds.
     • Only the currently-tied players play an overtime round.
     • After EVERY overtime round, running totals for ALL players are
       recomputed from scratch and tie groups are re-derived, so a player
       who didn't play the previous OT round can still be pulled into the
       next one if they end up newly tied. This is a single continuous
       timeline (round 14, 15, 16...), not separate per-player tracks.
     • Overtime can add rounds automatically, or (per a Preferences toggle)
       only after the user explicitly confirms, reconcileOvertimeRounds()
       reports the round it WOULD add without committing it, so the caller
       can gate that behind a confirm modal. A user who declines marks the
       game `tieAccepted`, which lets a tied result stand as complete.
============================================================================= */

import type { GameInstance, GameType, RoundEntry } from "./game-stats";

export const FIRST_ROUND = 3;
export const LAST_FIXED_ROUND = 13;

/** The 11 fixed rounds (3-13), all players participating, no scores entered. */
export function buildFixedRounds(playerIds: string[]): RoundEntry[] {
  const rounds: RoundEntry[] = [];
  for (let roundIndex = FIRST_ROUND; roundIndex <= LAST_FIXED_ROUND; roundIndex++) {
    rounds.push({
      roundIndex,
      isOvertime: false,
      participantIds: [...playerIds],
      scores: Object.fromEntries(playerIds.map((id) => [id, null])),
    });
  }
  return rounds;
}

/** "3" .. "13" for fixed rounds; "14 (OT)", "15 (2OT)", "16 (3OT)" ... for
 *  overtime rounds, matches the labels the user already uses. */
export function roundLabel(round: RoundEntry): string {
  if (!round.isOvertime) return String(round.roundIndex);
  const otNumber = round.roundIndex - LAST_FIXED_ROUND;
  const suffix = otNumber === 1 ? "OT" : `${otNumber}OT`;
  return `${round.roundIndex} (${suffix})`;
}

/** "Game 176". The display label for a game, derived from its stable,
 *  auto-assigned, never-reused gameNumber rather than free-text title. */
export function gameLabel(game: GameInstance): string {
  return `Game ${game.gameNumber}`;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((id) => bSet.has(id));
}

/** Players sharing an identical total, for totals where 2+ players tie.
 *  Players with a unique total are omitted entirely. */
function tiedPlayerIds(playerIds: string[], totals: Record<string, number>): string[] {
  const byTotal = new Map<number, string[]>();
  for (const pid of playerIds) {
    const group = byTotal.get(totals[pid]) ?? [];
    group.push(pid);
    byTotal.set(totals[pid], group);
  }
  const tied: string[] = [];
  for (const group of byTotal.values()) if (group.length >= 2) tied.push(...group);
  return tied;
}

/**
 * Rebuilds a game's overtime tail (everything after round 13) from scratch
 * based on the fixed rounds' current scores, preserving any already-entered
 * OT scores that are still relevant. Called after every score change so
 * editing an earlier round always leaves the OT tail consistent, appending
 * a newly-needed round, or dropping one that's no longer justified.
 *
 * When `allowNewRounds` is false (the user's "confirm before adding
 * overtime" preference), a round that WOULD need to be created is not
 * added, instead it's returned so the caller can prompt for confirmation
 * first. Rounds that already exist (already confirmed, or created before
 * the preference was turned on) are still preserved/dropped normally either
 * way, since that's just keeping existing structure consistent, not adding
 * new overtime.
 */
export function reconcileOvertimeRounds(
  game: GameInstance,
  allowNewRounds = true,
): RoundEntry | null {
  const fixed = game.rounds.filter((r) => !r.isOvertime);
  const prevOT = game.rounds.filter((r) => r.isOvertime);

  const totals: Record<string, number> = {};
  game.playerIds.forEach((id) => { totals[id] = 0; });
  let fixedComplete = fixed.length === LAST_FIXED_ROUND - FIRST_ROUND + 1;
  for (const round of fixed) {
    for (const pid of round.participantIds) {
      const score = round.scores[pid];
      if (score == null) { fixedComplete = false; continue; }
      totals[pid] += score;
    }
  }

  const newOT: RoundEntry[] = [];
  let pendingNewRound: RoundEntry | null = null;

  if (fixedComplete) {
    let roundIndex = LAST_FIXED_ROUND;
    let tied = tiedPlayerIds(game.playerIds, totals);
    while (tied.length > 0) {
      roundIndex += 1;
      const preserved = prevOT.find(
        (r) => r.roundIndex === roundIndex && sameSet(r.participantIds, tied),
      );
      if (!preserved && !allowNewRounds) {
        pendingNewRound = {
          roundIndex,
          isOvertime: true,
          participantIds: [...tied],
          scores: Object.fromEntries(tied.map((pid) => [pid, null])),
        };
        break;
      }
      const round: RoundEntry = preserved ?? {
        roundIndex,
        isOvertime: true,
        participantIds: [...tied],
        scores: Object.fromEntries(tied.map((pid) => [pid, null])),
      };
      newOT.push(round);

      let complete = true;
      for (const pid of tied) {
        const score = round.scores[pid];
        if (score == null) { complete = false; continue; }
        totals[pid] += score;
      }
      if (!complete) break;
      tied = tiedPlayerIds(game.playerIds, totals);
    }
  }

  game.rounds = [...fixed, ...newOT];
  return pendingNewRound;
}

export type GameState = {
  totals: Record<string, number>;
  /** True once every fixed round is filled and either the final totals are
   *  unique, or a tie stands because the user explicitly accepted it
   *  (game.tieAccepted) instead of playing overtime. */
  isComplete: boolean;
  /** Usually one id; two or more when a tie was accepted rather than
   *  broken by overtime. Every tied-for-lowest player counts as a winner. */
  winnerIds: string[];
};

/** Assumes reconcileOvertimeRounds() has already been run on this game. */
export function deriveGameState(game: GameInstance): GameState {
  const totals: Record<string, number> = {};
  game.playerIds.forEach((id) => { totals[id] = 0; });
  for (const round of game.rounds) {
    for (const pid of round.participantIds) {
      const score = round.scores[pid];
      if (score == null) continue;
      totals[pid] += score;
    }
  }

  const fixed = game.rounds.filter((r) => !r.isOvertime);
  const fixedComplete =
    fixed.length === LAST_FIXED_ROUND - FIRST_ROUND + 1 &&
    fixed.every((r) => r.participantIds.every((pid) => r.scores[pid] != null));

  let isComplete = false;
  if (fixedComplete) {
    const lastRound = game.rounds[game.rounds.length - 1];
    const lastRoundComplete = lastRound.participantIds.every((pid) => lastRound.scores[pid] != null);
    const tied = tiedPlayerIds(game.playerIds, totals);
    isComplete = lastRoundComplete && (tied.length === 0 || !!game.tieAccepted);
  }

  let winnerIds: string[] = [];
  if (isComplete) {
    const minTotal = Math.min(...game.playerIds.map((id) => totals[id]));
    winnerIds = game.playerIds.filter((id) => totals[id] === minTotal);
  }

  return { totals, isComplete, winnerIds };
}

/* =============================================================================
   STATS ENGINE
   -----------------------------------------------------------------------------
   Pure functions over a game list. No DOM, no module state. Only complete
   games count: an in-progress game has no defined winner or final score, so
   it can't contribute to any of these without skewing the numbers. A tied
   result that the user accepted (see GameState.isComplete) counts as a win
   for every tied player, same as a co-championship would in casual play.

   Everything here is computed on demand from the raw game log, never stored,
   so editing or deleting a historical game just changes what these functions
   return next time, there's nothing to keep in sync by hand.
============================================================================= */

export function outsInGame(game: GameInstance, playerId: string): number {
  return game.rounds.filter(
    (r) => r.participantIds.includes(playerId) && r.scores[playerId] === 0,
  ).length;
}

/** Longest run of CONSECUTIVE rounds (among the rounds the player actually
 *  played) with a score of 0, going out over and over rather than just
 *  often. Rounds the player sat out (an overtime round they weren't tied
 *  into) are skipped rather than breaking the streak, since they were never
 *  a chance to NOT go out either. */
export function mostOutsInARowInGame(game: GameInstance, playerId: string): number {
  let best = 0;
  let current = 0;
  for (const round of game.rounds) {
    if (!round.participantIds.includes(playerId)) continue;
    if (round.scores[playerId] === 0) {
      current++;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
}

/** Every player's running total after each round, in round order. The basis
 *  for the round-entry grid's Total columns and for every stat that cares
 *  about the shape of a game over time (pace to a threshold, lead changes,
 *  comebacks) rather than just its final scores. */
export function computeRunningTotalsPerRound(game: GameInstance): Record<string, number>[] {
  const totals: Record<string, number> = {};
  game.playerIds.forEach((id) => { totals[id] = 0; });
  return game.rounds.map((round) => {
    for (const pid of round.participantIds) {
      const score = round.scores[pid];
      if (score != null) totals[pid] += score;
    }
    return { ...totals };
  });
}

/** Ids tied for the lowest running total at a point in the game. Usually one;
 *  more when the lead is shared. */
function leadersAt(playerIds: string[], totals: Record<string, number>): string[] {
  const best = Math.min(...playerIds.map((id) => totals[id]));
  return playerIds.filter((id) => totals[id] === best);
}

/**
 * How many times the lead changed hands over a game.
 *
 * A change is counted whenever the set of players tied for the lowest running
 * total differs from the previous round's set, so a shared lead forming or
 * breaking counts, which is what "the lead changed" means at the table. The
 * first round only establishes a leader, so counting starts from the second.
 */
export function leadChangesInGame(game: GameInstance): number {
  const snapshots = computeRunningTotalsPerRound(game);
  let changes = 0;
  let previous: string | null = null;
  for (const totals of snapshots) {
    const key = leadersAt(game.playerIds, totals).sort().join("|");
    if (previous !== null && key !== previous) changes++;
    previous = key;
  }
  return changes;
}

/**
 * The deepest hole an eventual winner climbed out of: how far behind THE
 * LEADER they were at their worst, which winner it was, and the round it
 * happened in. All three travel together, a bare number leaves the reader
 * working out who it refers to and when, and the leader at that moment isn't
 * always the player who finished second.
 *
 * Returns null for a game nobody won yet. `deficit` is 0 when the winner led
 * or shared the lead the whole way, which callers read as "no comeback".
 */
export function comebackInGame(
  game: GameInstance,
): { deficit: number; playerId: string; round: RoundEntry } | null {
  const state = deriveGameState(game);
  if (!state.isComplete || state.winnerIds.length === 0) return null;
  const snapshots = computeRunningTotalsPerRound(game);
  let best = { deficit: 0, playerId: state.winnerIds[0], round: game.rounds[0] };
  snapshots.forEach((totals, i) => {
    const lowest = Math.min(...game.playerIds.map((id) => totals[id]));
    for (const winnerId of state.winnerIds) {
      const deficit = totals[winnerId] - lowest;
      if (deficit > best.deficit) best = { deficit, playerId: winnerId, round: game.rounds[i] };
    }
  });
  return best;
}

/** True when one player held the lead outright, never tied, never passed,
 *  from the first round through to the win. */
export function isWireToWire(game: GameInstance): boolean {
  const state = deriveGameState(game);
  if (!state.isComplete || state.winnerIds.length !== 1) return false;
  const winnerId = state.winnerIds[0];
  return computeRunningTotalsPerRound(game).every((totals) => {
    const leaders = leadersAt(game.playerIds, totals);
    return leaders.length === 1 && leaders[0] === winnerId;
  });
}

/** Standard competition ranking (1224) by final total, lowest first, so two
 *  players tied for the lead both place 1st and the next player places 3rd. */
export function finishPosition(game: GameInstance, playerId: string): number {
  const { totals } = deriveGameState(game);
  const mine = totals[playerId];
  return game.playerIds.filter((id) => totals[id] < mine).length + 1;
}

/** The round a player's running total first reached `threshold`, or null if
 *  they finished the game under it. Returned as the round itself so callers
 *  can show the label the user writes on paper ("Rd 7") rather than an
 *  index into an array. */
export function roundReachingThreshold(
  game: GameInstance,
  playerId: string,
  threshold: number,
): RoundEntry | null {
  const snapshots = computeRunningTotalsPerRound(game);
  for (let i = 0; i < snapshots.length; i++) {
    if (snapshots[i][playerId] >= threshold) return game.rounds[i];
  }
  return null;
}

/**
 * A "table" is one exact roster playing one specific game. BOTH halves
 * matter. Dropping a player changes the game (score variance, who could have
 * won), so {T,V} is a different table from {T,V,S}, not a subset of it. And a
 * different game type is a different scoresheet pad entirely, so the same
 * three people playing something else start their own count at 1 rather than
 * continuing the Five Crowns sequence.
 *
 * This key is what game numbers count within, what head-to-head stats group
 * by, and what the win chart plots, see nextGameNumber() in game-stats.ts.
 */
export function tableKey(gameType: GameType, playerIds: string[]): string {
  return `${gameType}::${[...playerIds].sort().join("|")}`;
}

/** Convenience for the common "this game's own table" lookup. */
export function tableKeyOf(game: GameInstance): string {
  return tableKey(game.gameType, game.playerIds);
}

export function gamesForTable(
  allGames: GameInstance[],
  gameType: GameType,
  playerIds: string[],
): GameInstance[] {
  const key = tableKey(gameType, playerIds);
  return allGames.filter((g) => tableKeyOf(g) === key);
}

/**
 * Play order for a list of games.
 *
 * Within a single table, `gameNumber` IS play order by construction (each new
 * game takes that table's highest number + 1), so it's used directly,
 * authoritative, and immune to games being left undated or re-entered later.
 * That matters because dates are optional and many users never set one.
 *
 * Across tables there's no shared counter (a T/V/S Game 40 and an A/B/C
 * Game 40 say nothing about each other) so those fall back to date, then to
 * record creation time for undated games.
 */
export function sortChronologically(list: GameInstance[]): GameInstance[] {
  const distinctTables = new Set(list.map(tableKeyOf));
  if (distinctTables.size <= 1) return [...list].sort((a, b) => a.gameNumber - b.gameNumber);
  return [...list].sort((a, b) =>
    a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date.localeCompare(b.date),
  );
}

// gameNumber travels alongside the display label so multi-game lists (ties
// for a record) can be formatted compactly as "Games 5, 51, 77" instead of
// "Game 5, Game 51, Game 77", see game-stats.ts's formatGameRefs().
export type GameReference = { gameId: string; gameNumber: number; gameTitle: string };

function refFor(game: GameInstance): GameReference {
  return { gameId: game.id, gameNumber: game.gameNumber, gameTitle: gameLabel(game) };
}

/** Tracks every game tied for a record, not just the first one found,
 *  `metric` extracts the comparable number from an entry (its own value for
 *  most records, `.margin` for MarginGame), `better(a, b)` says whether `a`
 *  should replace `b` outright (a strictly new record clears the list; an
 *  exact tie appends to it). */
function updateRecordList<T>(
  list: T[],
  entry: T,
  metric: (t: T) => number,
  better: (a: number, b: number) => boolean,
): T[] {
  if (list.length === 0) return [entry];
  const current = metric(list[0]);
  const next = metric(entry);
  if (better(next, current)) return [entry];
  if (next === current) return [...list, entry];
  return list;
}

// Every career record can be tied across multiple games (e.g. two games
// both hit the player's all-time highest score), so each field is a list,
// usually one entry, occasionally more.
export type CareerRecords = {
  highestScoreGame: (GameReference & { value: number })[];
  lowestScoreGame: (GameReference & { value: number })[];
  highestScoreRound: (GameReference & { value: number; roundLabel: string })[];
  mostOutsGame: (GameReference & { value: number })[];
  fewestOutsGame: (GameReference & { value: number })[];
  mostOutsInARow: (GameReference & { value: number })[];
  highestWinningScore: (GameReference & { value: number })[];
  lowestLosingScore: (GameReference & { value: number })[];
  /** Pace to each scoring milestone, see PaceStats. */
  pace: Record<PaceThreshold, PaceStats>;
};

/** Thresholds whose PACE is tracked (which round a player crossed them in),
 *  as distinct from the 200/300 MILESTONE counts, which only ask whether a
 *  final score got there at all. */
export const PACE_THRESHOLDS = [100, 200, 300] as const;
export type PaceThreshold = (typeof PACE_THRESHOLDS)[number];

export type PaceEntry = GameReference & { value: number; roundLabel: string };

/**
 * How fast a player piles up points, which in Five Crowns is a measure of
 * damage rather than progress: `quickest` is their worst blow-up (fewest
 * rounds to cross the threshold), `slowest` their most disciplined game among
 * those that crossed it at all.
 *
 * Games that finished under the threshold are excluded from both, there's no
 * round number to report for a line that was never crossed, and treating them
 * as "infinitely slow" would make `slowest` a proxy for the lowest final
 * score, which Lowest Score (Game) already reports.
 */
export type PaceStats = { quickest: PaceEntry[]; slowest: PaceEntry[] };

export type Streak = { length: number; fromGameId: string; toGameId: string };

export type RateStats = {
  gamesPlayed: number;
  wins: number;
  winPct: number;
  totalPoints: number;
  avgPointsPerGame: number;
  avgPointsPerRound: number;
  outsPerGame: number;
  count200: number;
  games200: GameReference[];
  count300: number;
  games300: GameReference[];
  longestWinStreak: Streak | null;
  longestLossStreak: Streak | null;
  currentStreak: { type: "win" | "loss" | "none"; length: number };
  /** Mean points ahead of the closest opponent, over wins only. A tie
   *  accepted by every player (nobody left to be "ahead of") is excluded
   *  rather than counted as 0. Same reasoning as avgMarginInLosses below. */
  avgMarginInWins: number;
  /** Mean points behind the winner, over losses only. Wins are excluded
   *  rather than counted as 0, including them would just re-encode win %
   *  and flatten the number this is meant to expose. */
  avgMarginInLosses: number;
  /** How many times the player finished in each place (standard competition
   *  ranking, ties for the lead both place 1st). Keyed by place number;
   *  only entries the player has actually reached exist. Place 1 duplicates
   *  `wins` and isn't displayed separately. This exists for "Runner Up",
   *  "Third Place", etc., which only make sense at a table big enough for
   *  that many distinct standings (see maxPlayersInAnyGame). */
  placeCounts: Record<number, number>;
  /** The most players in any single completed game this player appears in,
   *  within whatever scope computePlayerStats was called with (global
   *  history, or one table's games). Gates which place-count stats
   *  (Runner Up, Third Place...) are worth showing at all, place N only
   *  exists as a distinct standing once a game has had N+1 players. */
  maxPlayersInAnyGame: number;
};

export type PlayerStats = { career: CareerRecords; rates: RateStats };

/** Rate & Cumulative stats get best/worst highlighting in the Compare view
 *  (see game-stats.ts Phase 6); Career Records don't, they're "which game
 *  it happened in" facts, not a rate that's meaningful to rank. Polarity
 *  follows from Five Crowns' lower-total-wins rule; "neutral" stats (plain
 *  counts/totals) aren't ranked at all. longestWinStreak/longestLossStreak
 *  are compared by their `.length`, currentStreak isn't ranked (its meaning
 *  depends on type, not just magnitude), and the games200/games300 lists
 *  aren't ranked either (their counts are, via count200/count300). */
export type StatPolarity = "higher-better" | "lower-better" | "neutral";

export const RATE_STAT_POLARITY: Record<keyof RateStats, StatPolarity> = {
  gamesPlayed: "neutral",
  wins: "neutral",
  winPct: "higher-better",
  totalPoints: "neutral",
  avgPointsPerGame: "lower-better",
  avgPointsPerRound: "lower-better",
  outsPerGame: "higher-better",
  count200: "lower-better",
  games200: "neutral",
  count300: "lower-better",
  games300: "neutral",
  longestWinStreak: "higher-better",
  longestLossStreak: "lower-better",
  currentStreak: "neutral",
  avgMarginInWins: "higher-better",
  avgMarginInLosses: "lower-better",
  placeCounts: "neutral",
  maxPlayersInAnyGame: "neutral",
};

type StreakSegment = { type: "win" | "loss"; length: number; fromGameId: string; toGameId: string };

/** Every consecutive win/loss run in order, win and loss segments alike.
 *  The shared basis for both the longest-streak record (computeStreaks) and
 *  the full per-type breakdown behind the Stats double-click detail
 *  (streakListDetail), so the two can't drift apart. */
function computeStreakSegments(
  chronologicalCompletedGames: GameInstance[],
  playerId: string,
): StreakSegment[] {
  const segments: StreakSegment[] = [];
  let curType: "win" | "loss" | "none" = "none";
  let curLen = 0;
  let curStartId = "";
  let curEndId = "";

  for (const game of chronologicalCompletedGames) {
    const state = deriveGameState(game);
    const type: "win" | "loss" = state.winnerIds.includes(playerId) ? "win" : "loss";
    if (type === curType) {
      curLen++;
      curEndId = game.id;
    } else {
      if (curType !== "none") segments.push({ type: curType, length: curLen, fromGameId: curStartId, toGameId: curEndId });
      curType = type;
      curLen = 1;
      curStartId = game.id;
      curEndId = game.id;
    }
  }
  if (curType !== "none") segments.push({ type: curType, length: curLen, fromGameId: curStartId, toGameId: curEndId });

  return segments;
}

function computeStreaks(
  chronologicalCompletedGames: GameInstance[],
  playerId: string,
): {
  longestWin: Streak | null;
  longestLoss: Streak | null;
  current: { type: "win" | "loss" | "none"; length: number };
} {
  const segments = computeStreakSegments(chronologicalCompletedGames, playerId);
  // Stable sort keeps the earliest-occurring streak on top of a length tie,
  // matching the previous strictly-greater-only replacement logic.
  const longestWin = segments.filter((s) => s.type === "win").sort((a, b) => b.length - a.length)[0] ?? null;
  const longestLoss = segments.filter((s) => s.type === "loss").sort((a, b) => b.length - a.length)[0] ?? null;
  const last = segments[segments.length - 1];

  return {
    longestWin: longestWin && { length: longestWin.length, fromGameId: longestWin.fromGameId, toGameId: longestWin.toGameId },
    longestLoss: longestLoss && { length: longestLoss.length, fromGameId: longestLoss.fromGameId, toGameId: longestLoss.toGameId },
    current: last ? { type: last.type, length: last.length } : { type: "none", length: 0 },
  };
}

/** Every win (or loss) streak the player has ever had, longest first. The
 *  ranked breakdown behind double-clicking Longest Win/Losing Streak in
 *  Stats, same pattern as the other career-record detail lists. */
export function streakListDetail(
  chronologicalCompletedGames: GameInstance[],
  playerId: string,
  type: "win" | "loss",
): Streak[] {
  return computeStreakSegments(chronologicalCompletedGames, playerId)
    .filter((s) => s.type === type)
    .map((s) => ({ length: s.length, fromGameId: s.fromGameId, toGameId: s.toGameId }))
    .sort((a, b) => b.length - a.length);
}

/** `allGames` should already be scoped to whatever's being measured, pass
 *  the full log for a player's global stats, or gamesForTable(...) for their
 *  stats at one specific table. Either way this only looks at games the
 *  player actually appears in, so a table-scoped list "just works". */
export function computePlayerStats(allGames: GameInstance[], playerId: string): PlayerStats {
  const completed = sortChronologically(
    allGames.filter((g) => g.playerIds.includes(playerId) && deriveGameState(g).isComplete),
  );

  const career: CareerRecords = {
    highestScoreGame: [],
    lowestScoreGame: [],
    highestScoreRound: [],
    mostOutsGame: [],
    fewestOutsGame: [],
    mostOutsInARow: [],
    highestWinningScore: [],
    lowestLosingScore: [],
    pace: {
      100: { quickest: [], slowest: [] },
      200: { quickest: [], slowest: [] },
      300: { quickest: [], slowest: [] },
    },
  };

  let wins = 0;
  let totalPoints = 0;
  let totalRoundsPlayed = 0;
  let totalOuts = 0;
  let lossCount = 0;
  let lossMarginSum = 0;
  let winMarginCount = 0;
  let winMarginSum = 0;
  let maxPlayersInAnyGame = 0;
  const placeCounts: Record<number, number> = {};
  const games200: GameReference[] = [];
  const games300: GameReference[] = [];

  for (const game of completed) {
    const state = deriveGameState(game);
    const total = state.totals[playerId];
    const isWinner = state.winnerIds.includes(playerId);
    const ref = refFor(game);

    maxPlayersInAnyGame = Math.max(maxPlayersInAnyGame, game.playerIds.length);
    const place = finishPosition(game, playerId);
    placeCounts[place] = (placeCounts[place] ?? 0) + 1;

    if (isWinner) {
      wins++;
      // The "field" for a margin is everyone NOT tied for the win, with a
      // solo winner that's everyone else; with an accepted tie among all
      // players there's nobody left to have beaten, so it's excluded below
      // rather than scored as a 0-point margin.
      const others = game.playerIds.filter((id) => !state.winnerIds.includes(id));
      if (others.length > 0) {
        winMarginCount++;
        winMarginSum += Math.min(...others.map((id) => state.totals[id])) - total;
      }
    }
    totalPoints += total;

    if (!isWinner) {
      lossCount++;
      const winningTotal = Math.min(...game.playerIds.map((id) => state.totals[id]));
      lossMarginSum += total - winningTotal;
    }

    for (const threshold of PACE_THRESHOLDS) {
      const round = roundReachingThreshold(game, playerId, threshold);
      if (!round) continue;
      const entry: PaceEntry = { ...ref, value: round.roundIndex, roundLabel: roundLabel(round) };
      const bucket = career.pace[threshold];
      bucket.quickest = updateRecordList(bucket.quickest, entry, (e) => e.value, (a, b) => a < b);
      bucket.slowest = updateRecordList(bucket.slowest, entry, (e) => e.value, (a, b) => a > b);
    }
    if (total >= 200) games200.push(ref);
    if (total >= 300) games300.push(ref);

    career.highestScoreGame = updateRecordList(career.highestScoreGame, { ...ref, value: total }, (e) => e.value, (a, b) => a > b);
    career.lowestScoreGame = updateRecordList(career.lowestScoreGame, { ...ref, value: total }, (e) => e.value, (a, b) => a < b);
    if (isWinner) {
      career.highestWinningScore = updateRecordList(career.highestWinningScore, { ...ref, value: total }, (e) => e.value, (a, b) => a > b);
    } else {
      career.lowestLosingScore = updateRecordList(career.lowestLosingScore, { ...ref, value: total }, (e) => e.value, (a, b) => a < b);
    }

    const outs = outsInGame(game, playerId);
    totalOuts += outs;
    career.mostOutsGame = updateRecordList(career.mostOutsGame, { ...ref, value: outs }, (e) => e.value, (a, b) => a > b);
    career.fewestOutsGame = updateRecordList(career.fewestOutsGame, { ...ref, value: outs }, (e) => e.value, (a, b) => a < b);

    const outsInARow = mostOutsInARowInGame(game, playerId);
    career.mostOutsInARow = updateRecordList(career.mostOutsInARow, { ...ref, value: outsInARow }, (e) => e.value, (a, b) => a > b);

    for (const round of game.rounds) {
      if (!round.participantIds.includes(playerId)) continue;
      const score = round.scores[playerId];
      if (score == null) continue;
      totalRoundsPlayed++;
      career.highestScoreRound = updateRecordList(
        career.highestScoreRound,
        { ...ref, value: score, roundLabel: roundLabel(round) },
        (e) => e.value,
        (a, b) => a > b,
      );
    }
  }

  const gamesPlayed = completed.length;
  const streaks = computeStreaks(completed, playerId);

  const rates: RateStats = {
    gamesPlayed,
    wins,
    winPct: gamesPlayed ? (wins / gamesPlayed) * 100 : 0,
    totalPoints,
    avgPointsPerGame: gamesPlayed ? totalPoints / gamesPlayed : 0,
    avgPointsPerRound: totalRoundsPlayed ? totalPoints / totalRoundsPlayed : 0,
    outsPerGame: gamesPlayed ? totalOuts / gamesPlayed : 0,
    count200: games200.length,
    games200,
    count300: games300.length,
    games300,
    longestWinStreak: streaks.longestWin,
    longestLossStreak: streaks.longestLoss,
    currentStreak: streaks.current,
    avgMarginInWins: winMarginCount ? winMarginSum / winMarginCount : 0,
    avgMarginInLosses: lossCount ? lossMarginSum / lossCount : 0,
    placeCounts,
    maxPlayersInAnyGame,
  };

  return { career, rates };
}

export type MarginGame = GameReference & {
  margin: number;
  firstPlaceId: string;
  firstScore: number;
  secondPlaceId: string;
  secondScore: number;
};

export type OvertimeGameRef = GameReference & { otCount: number };

export type TableStats = {
  gamesPlayed: number;
  headToHead: Record<string, { wins: number; winPct: number }>;
  highestCombinedScore: (GameReference & { value: number })[];
  lowestCombinedScore: (GameReference & { value: number })[];
  closestGame: MarginGame[];
  mostLopsidedGame: MarginGame[];
  overtimeGames: OvertimeGameRef[];
  mostLeadChanges: (GameReference & { value: number })[];
  /** The largest deficit an eventual winner dug themselves out of, who it
   *  was, and the round they were at their worst. */
  biggestComeback: (GameReference & { value: number; playerId: string; roundLabel: string })[];
  /** Games led outright from the first round to the last. The opposite
   *  shape of a comeback, and the one a scoresheet never makes obvious. */
  wireToWireGames: GameReference[];
  /** Every point anyone has ever scored at this table, summed across its
   *  whole history, unlike highest/lowestCombinedScore, which are each a
   *  single game's total, this is the running grand total. */
  totalPointsAllTime: number;
};

/** Describes the table as a whole rather than any one player, so nothing
 *  here gets compare-highlighting, there's no "best" combined score. */
export function computeTableStats(
  allGames: GameInstance[],
  gameType: GameType,
  playerIds: string[],
): TableStats {
  const games = gamesForTable(allGames, gameType, playerIds).filter((g) => deriveGameState(g).isComplete);

  const headToHead: Record<string, { wins: number; winPct: number }> = {};
  playerIds.forEach((id) => { headToHead[id] = { wins: 0, winPct: 0 }; });

  let highestCombinedScore: TableStats["highestCombinedScore"] = [];
  let lowestCombinedScore: TableStats["lowestCombinedScore"] = [];
  let closestGame: MarginGame[] = [];
  let mostLopsidedGame: MarginGame[] = [];
  const overtimeGames: OvertimeGameRef[] = [];
  let mostLeadChanges: TableStats["mostLeadChanges"] = [];
  let biggestComeback: TableStats["biggestComeback"] = [];
  const wireToWireGames: GameReference[] = [];
  let totalPointsAllTime = 0;

  for (const game of games) {
    const state = deriveGameState(game);
    state.winnerIds.forEach((id) => { headToHead[id].wins++; });

    const ref = refFor(game);
    const combined = playerIds.reduce((sum, id) => sum + state.totals[id], 0);
    totalPointsAllTime += combined;
    highestCombinedScore = updateRecordList(highestCombinedScore, { ...ref, value: combined }, (e) => e.value, (a, b) => a > b);
    lowestCombinedScore = updateRecordList(lowestCombinedScore, { ...ref, value: combined }, (e) => e.value, (a, b) => a < b);

    const rankedIds = [...playerIds].sort((a, b) => state.totals[a] - state.totals[b]);
    const [firstId, secondId] = rankedIds;
    const margin = state.totals[secondId] - state.totals[firstId];
    const marginEntry: MarginGame = {
      ...ref,
      margin,
      firstPlaceId: firstId,
      firstScore: state.totals[firstId],
      secondPlaceId: secondId,
      secondScore: state.totals[secondId],
    };
    closestGame = updateRecordList(closestGame, marginEntry, (e) => e.margin, (a, b) => a < b);
    mostLopsidedGame = updateRecordList(mostLopsidedGame, marginEntry, (e) => e.margin, (a, b) => a > b);

    const otCount = game.rounds.filter((r) => r.isOvertime).length;
    if (otCount > 0) overtimeGames.push({ ...ref, otCount });

    const changes = leadChangesInGame(game);
    mostLeadChanges = updateRecordList(mostLeadChanges, { ...ref, value: changes }, (e) => e.value, (a, b) => a > b);

    const comeback = comebackInGame(game);
    if (comeback) {
      biggestComeback = updateRecordList(
        biggestComeback,
        { ...ref, value: comeback.deficit, playerId: comeback.playerId, roundLabel: roundLabel(comeback.round) },
        (e) => e.value,
        (a, b) => a > b,
      );
    }

    if (isWireToWire(game)) wireToWireGames.push(ref);
  }

  const gamesPlayed = games.length;
  playerIds.forEach((id) => {
    headToHead[id].winPct = gamesPlayed ? (headToHead[id].wins / gamesPlayed) * 100 : 0;
  });

  return {
    gamesPlayed,
    headToHead,
    highestCombinedScore,
    lowestCombinedScore,
    closestGame,
    mostLopsidedGame,
    overtimeGames,
    mostLeadChanges,
    biggestComeback,
    wireToWireGames,
    totalPointsAllTime,
  };
}

export type WinChartPoint = {
  gameId: string;
  gameNumber: number;
  // Whoever won THIS specific game, mirrors the "1" in the winning
  // player's own column in the user's original Win Chart sheet.
  wonThisGame: Record<string, boolean>;
  cumulativeWins: Record<string, number>;
};

/** One point per completed game at this table, in play order, carrying both
 *  who won that specific game and each player's running win total through
 *  that point, mirrors the user's original spreadsheet's "Win Chart" sheet
 *  (table + line chart source). */
export function computeWinChart(
  allGames: GameInstance[],
  gameType: GameType,
  playerIds: string[],
): WinChartPoint[] {
  const games = sortChronologically(
    gamesForTable(allGames, gameType, playerIds).filter((g) => deriveGameState(g).isComplete),
  );

  const cumulative: Record<string, number> = {};
  playerIds.forEach((id) => { cumulative[id] = 0; });

  return games.map((game) => {
    const state = deriveGameState(game);
    state.winnerIds.forEach((id) => { cumulative[id]++; });
    const wonThisGame: Record<string, boolean> = {};
    playerIds.forEach((id) => { wonThisGame[id] = state.winnerIds.includes(id); });
    return { gameId: game.id, gameNumber: game.gameNumber, wonThisGame, cumulativeWins: { ...cumulative } };
  });
}

/* =============================================================================
   SPREADSHEET FORMAT
   -----------------------------------------------------------------------------
   The layout of a Five Crowns scoresheet as a worksheet, in both directions:
   the template the app hands out, and the strict parse of a workbook coming
   back in. The shape is the one the author already keeps by hand, so an
   existing log imports without being reformatted first:

     • One sheet per game, named "Game <n>". The sheet NAME carries the game
       number. Sheets named anything else are ignored, which is what lets a
       workbook keep a Read Me, a Template, chart sheets and so on alongside.
     • Column A holds round labels: 3-13, then "14 (OT)", "15 (2OT)", ...
     • Each player owns a "<Name>▲" column of per-round scores. Anything
       without the ▲ marker is ignored, in the author's own sheets the plain
       "<Name>" column beside it is a running total, which is recomputed here
       rather than read, so a stale formula result can't contaminate an import.
     • A blank score in an overtime row means that player wasn't in that
       overtime; a blank in rounds 3-13 means the game is unfinished.

   Parsing reports EVERY problem it finds rather than stopping at the first,
   because the fix happens in Excel: one round trip listing ten bad cells beats
   ten round trips listing one.
============================================================================= */

/** Marks a column as holding that player's per-round scores. Kept as a shared
 *  literal so the template writes exactly what the parser looks for. */
export const SCORE_COLUMN_MARKER = "▲";

/** Column headings for one blank game sheet, given placeholder player names. */
function templateHeaderRow(playerNames: string[]): string[] {
  return ["Round", ...playerNames.map((name) => `${name}${SCORE_COLUMN_MARKER}`)];
}

/** The Template sheet: headings plus one empty row per fixed round. */
export function templateGameRows(playerNames: string[]): string[][] {
  const rows = [templateHeaderRow(playerNames)];
  for (let i = FIRST_ROUND; i <= LAST_FIXED_ROUND; i++) {
    rows.push([String(i), ...playerNames.map(() => "")]);
  }
  return rows;
}

export function templateReadmeRows(): string[][] {
  const marker = SCORE_COLUMN_MARKER;
  return [
    ["Five Crowns Game Log: import format"],
    [],
    ["1.", "Copy the Template sheet once per game."],
    ["2.", 'Rename each copy "Game 1", "Game 2", and so on. The sheet NAME is the game number.'],
    ["3.", `Replace "Player 1" etc. in row 1 with real names, keeping the ${marker} on each score column.`],
    ["4.", "Enter every player's score for every round. Rounds 3-13 must all be filled in."],
    ["5.", "Import the finished workbook from Game Stats → Setup → Preferences."],
    [],
    ["Notes"],
    ["", `Only columns whose heading ends in ${marker} are read. Add your own totals or notes columns freely.`],
    ["", "If players tie after round 13, keep adding rows with the round number going up: 14, 15, and so on."],
    ["", "In an overtime row, leave a player's cell blank if they weren't in that overtime."],
    ["", "Every round needs one player with a score of 0, whoever went out that round."],
    ["", 'Sheets not named "Game <number>" are ignored, so this sheet can stay where it is.'],
    ["", "Players are matched to profiles by name; a name that's new to the app gets a new profile."],
    ["", "Nothing is imported unless every sheet passes. Problems are listed for you to fix first."],
  ];
}

/** A game recovered from a worksheet, still in spreadsheet terms, player
 *  NAMES rather than profile ids, because resolving those (and creating any
 *  profile that doesn't exist yet) must not happen until every sheet in the
 *  workbook has validated. */
export type ParsedSheetGame = {
  sheetName: string;
  gameNumber: number;
  playerNames: string[];
  /** In round order: the label's numeric part, and a score for each player
   *  who took part in that round, keyed by name. */
  rounds: { roundIndex: number; isOvertime: boolean; scores: Record<string, number> }[];
};

export type SheetParseResult =
  | { ok: true; game: ParsedSheetGame }
  | { ok: false; errors: string[] };

/** "Game 12" -> 12. Anything else -> null, which is how non-game sheets get
 *  skipped rather than reported as broken. */
export function gameNumberFromSheetName(name: string): number | null {
  const match = /^\s*game\s+(\d+)\s*$/i.exec(name);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/** "3" -> 3, "14 (OT)" -> 14. The parenthetical is decoration; the leading
 *  number is what orders the round. */
function roundIndexFromLabel(label: string): number | null {
  const match = /^\s*(\d+)/.exec(label);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function parseGameSheet(sheetName: string, rows: string[][]): SheetParseResult {
  const errors: string[] = [];
  const where = (detail: string) => `${sheetName}: ${detail}`;

  const gameNumber = gameNumberFromSheetName(sheetName);
  if (gameNumber == null) return { ok: false, errors: [where('sheet name must be "Game <number>".')] };

  const header = rows[0] ?? [];
  const playerColumns: { name: string; column: number }[] = [];
  header.forEach((cell, column) => {
    if (!cell.endsWith(SCORE_COLUMN_MARKER)) return;
    const name = cell.slice(0, -SCORE_COLUMN_MARKER.length).trim();
    if (name) playerColumns.push({ name, column });
  });

  if (playerColumns.length < 2) {
    errors.push(
      where(
        `needs at least 2 player columns in row 1, each headed "<Name>${SCORE_COLUMN_MARKER}". Found ${playerColumns.length}.`,
      ),
    );
  }
  const duplicated = [
    ...new Set(
      playerColumns.map((p) => p.name.toLowerCase()).filter((name, i, all) => all.indexOf(name) !== i),
    ),
  ];
  if (duplicated.length > 0) {
    errors.push(where(`the same player heads more than one column (${duplicated.join(", ")}).`));
  }
  // Without a trustworthy column map nothing below can be interpreted, so the
  // row-level checks are skipped rather than made to guess.
  if (errors.length > 0) return { ok: false, errors };

  const parsedRounds: ParsedSheetGame["rounds"] = [];
  const seenRoundIndexes = new Set<number>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const label = (row[0] ?? "").trim();
    // A wholly blank row is padding, not a mistake, spreadsheets accumulate them.
    if (label === "" && playerColumns.every((p) => (row[p.column] ?? "").trim() === "")) continue;

    const roundIndex = roundIndexFromLabel(label);
    if (roundIndex == null) {
      errors.push(where(`row ${r + 1} has an unrecognised round label ("${label}").`));
      continue;
    }
    if (seenRoundIndexes.has(roundIndex)) {
      errors.push(where(`round ${roundIndex} appears more than once.`));
      continue;
    }
    seenRoundIndexes.add(roundIndex);

    const isOvertime = roundIndex > LAST_FIXED_ROUND;
    const scores: Record<string, number> = {};
    // Tracks whether any cell in this row already failed validation, so the
    // "someone must go out" check below (which needs a complete, valid row
    // to mean anything) doesn't pile a confusing second error on top of it.
    let rowHasScoreError = false;
    for (const { name, column } of playerColumns) {
      const raw = (row[column] ?? "").trim();
      if (raw === "") {
        // Blank is legitimate only in overtime, where it means "sat this one
        // out". In a fixed round it means the game was never finished.
        if (!isOvertime) {
          errors.push(where(`round ${roundIndex} has no score for ${name}.`));
          rowHasScoreError = true;
        }
        continue;
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        errors.push(where(`round ${roundIndex}, ${name}: "${raw}" isn't a whole score of 0 or more.`));
        rowHasScoreError = true;
        continue;
      }
      scores[name] = value;
    }

    if (isOvertime && Object.keys(scores).length < 2) {
      errors.push(where(`overtime round ${roundIndex} needs at least 2 players' scores.`));
    } else if (!rowHasScoreError && !Object.values(scores).some((v) => v === 0)) {
      // Every round ends when someone goes out, and going out scores 0, a
      // round where nobody has a 0 means a score was mistyped or misattributed.
      errors.push(where(`round ${roundIndex} has no player with a score of 0, someone always goes out.`));
    }
    parsedRounds.push({ roundIndex, isOvertime, scores });
  }

  for (let i = FIRST_ROUND; i <= LAST_FIXED_ROUND; i++) {
    if (!seenRoundIndexes.has(i)) errors.push(where(`round ${i} is missing.`));
  }

  // Overtime is one continuous timeline appended to round 13, so a gap in it
  // (a "16 (3OT)" with no "15") means rounds were deleted or mislabelled.
  [...seenRoundIndexes]
    .filter((i) => i > LAST_FIXED_ROUND)
    .sort((a, b) => a - b)
    .forEach((index, i) => {
      const expected = LAST_FIXED_ROUND + 1 + i;
      if (index !== expected) {
        errors.push(where(`overtime rounds must run consecutively. Expected round ${expected}, found ${index}.`));
      }
    });

  if (errors.length > 0) return { ok: false, errors };

  parsedRounds.sort((a, b) => a.roundIndex - b.roundIndex);
  return {
    ok: true,
    game: { sheetName, gameNumber, playerNames: playerColumns.map((p) => p.name), rounds: parsedRounds },
  };
}
