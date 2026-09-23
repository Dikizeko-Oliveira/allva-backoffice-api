import { ScoreResult } from './score-types';

/**
 * Unified score bundle returned by `CreativeScoringService` for one creative.
 * Exposed in DTOs (insights, list, optimization result).
 */
export type CreativeScoreSet = {
  attention: ScoreResult;
  audienceFit: ScoreResult;
  negativeFeedbackRisk: ScoreResult;
  learningStability: ScoreResult;
  /** Legacy 0..1 values preserved for backwards compatibility. */
  fatigueScore: number;
};
