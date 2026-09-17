/**
 * What a judged assertion reports, kept apart from `judge.ts` so the matcher can
 * name these types without its declarations reaching a module that imports from
 * `ai`. The three fields the SDK owns are left as it returned them.
 */
export type Verdict = {
  /** Null for a lone statement, whose report lines need no name in front. */
  readonly label: string | null;
  readonly instructions: string;
  readonly passed: boolean;
  /** What the model said, in the words a report prints, such as "41% chance". */
  readonly received: string;
  /** What the judgment asked for, such as "at least 80%". */
  readonly needed: string;
};

export type JudgedUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

export type JudgedOutcome = {
  readonly pass: boolean;
  readonly verdicts: readonly Verdict[];
  /** The listing of the last screen judged, which is what a failure message prints. */
  readonly screen: string;
  readonly polls: number;
  /** The last poll's answers, as the SDK returned them. */
  readonly answers: unknown;
  /** Summed over every poll, because a six-poll assertion costs six calls. */
  readonly usage: JudgedUsage;
  readonly providerMetadata: unknown;
  /**
   * Why the polls after the last verdicts produced none, when they failed. A
   * later poll's error is absorbed so a screen mid-transition cannot fail the
   * assertion, and this keeps it from disappearing.
   */
  readonly interrupted: string | null;
};
