/**
 * A `ReasonCode` as the lesson it names.
 *
 * The report card ranks mistakes by the *book answer the player declined*, not
 * by what they did instead (report.ts): "you were being told to stand because
 * the dealer is weak" is one lesson whether they hit or doubled. So these are
 * phrased as the lesson, in the second person, and each one should be readable
 * on its own line with a dollar figure beside it.
 *
 * **Why here and not in `explain.ts`.** `explain` produces sentences populated
 * with live EV numbers for one hand at one instant; a report card has neither —
 * it is looking back at eleven hands that shared a reason code and nothing else.
 * There is no composition to quote. These are labels, and labels are view copy.
 *
 * **The completeness check is the type.** `Record<ReasonCode, string>` is total,
 * so a reason code added to `strategy.ts` fails this file at compile time rather
 * than rendering as a raw `SCREAMING_SNAKE` constant on the one screen the
 * player is meant to learn from.
 */

import type { ReasonCode } from '@bj/engine';

export const LESSON: Record<ReasonCode, string> = {
  CANT_BUST_ALWAYS_HIT: 'Always hit a hand that cannot bust',
  DEALER_WEAK_LET_THEM_BUST: 'Stand and let a weak dealer bust',
  DEALER_STRONG_MUST_IMPROVE: 'Improve your hand against a strong dealer',
  SOFT_HAND_CANT_BUST: 'A soft hand is free to draw',
  DOUBLE_WHEN_DEALER_LIKELY_BUSTS: 'Double when the dealer is likely to bust',
  DOUBLE_STRONG_TOTAL: 'Double a strong total',
  STAND_ON_A_MADE_HAND: 'Stand on a made hand',
  SPLIT_TWO_HANDS_BEAT_ONE: 'Split when two hands beat one',
  ALWAYS_SPLIT_ACES: 'Always split aces',
  ALWAYS_SPLIT_EIGHTS: 'Always split eights',
  NEVER_SPLIT_TENS: 'Never split tens',
  NEVER_SPLIT_FIVES: 'Never split fives',
  INSURANCE_IS_A_SUCKER_BET: 'Insurance is a sucker bet',
  CLOSEST_CALL: 'The closest calls on the chart',
  DAMAGE_CONTROL: 'Damage control — take the cheaper loss',
};
