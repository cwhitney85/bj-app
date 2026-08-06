/**
 * Prose for a recommendation (SPEC §5.4).
 *
 * A `ReasonCode` says why a chart cell reads the way it does; this file turns
 * that code plus the live EV numbers into something a beginner can read. The
 * text is templated, never generated: instant, offline, free, and — the part
 * that matters — identical every time the same situation comes up, so a player
 * learns a sentence rather than a mood.
 *
 * Three things govern the writing.
 *
 * **One voice.** The templates do not each write their own prose. They compose
 * from a small set of sentence builders — the dealer's bust rate, the chance a
 * hit busts you, a two-action money comparison — so every percentage is rounded
 * by the same function and every hand is described in the same register. Fifteen
 * independently written paragraphs would have drifted apart by the third one.
 *
 * **No sentence may lie.** The `DAMAGE_CONTROL` framing — you lose either way,
 * so pick the cheaper loss — is only honest when both actions really are
 * negative. `moneyComparison` inspects the signs and chooses the wording, so a
 * template cannot assert something false about numbers it did not compute. Every
 * claim in the output is either a fixed fact about the game or a formatted
 * number that came from `ev`/`dealerOutcomes`.
 *
 * **The chart keeps the headline.** Where the exact composition makes the
 * EV-optimal action differ from the book (SPEC §5.3), the recommendation does
 * not change; the disagreement is reported separately as `advancedNote`, so a
 * beginner is never told two different things at once.
 *
 * The single most useful idea the app can transmit is that most blackjack
 * decisions are damage control — the chart's job is to lose you the least, not
 * to find you a winner. That reframing is why `DAMAGE_CONTROL` and
 * `CLOSEST_CALL` exist as codes at all, and their templates carry the most
 * weight here.
 */

import { compIndex, type Card, type CompIndex, type Composition, type Rank } from './cards.js';
import { handTotal, type Action } from './hand.js';
import type { RuleSet } from './rules.js';
import { dealerOutcomes, insuranceEv, type ActionEv, type DealerDistribution, type EvInput } from './ev.js';
import type { Recommendation, ReasonCode } from './strategy.js';

/**
 * What the hint layer renders (SPEC §5.5).
 *
 * `headline` and `summary` are the collapsed hint card; `detail` is the expanded
 * sheet. The two notes are separate fields rather than one because the UI puts
 * them in different places: the advanced note sits under the explanation, the
 * approximation label sits beside the split EV bar.
 */
export type Explanation = {
  /** The recommended action as a sentence: "Stand." */
  readonly headline: string;
  /** One line, for the hint card above the action buttons. */
  readonly summary: string;
  /** The full explanation, populated with live numbers. */
  readonly detail: string;
  /** The EV-optimal action differs from the chart here (SPEC §5.3). Usually null. */
  readonly advancedNote: string | null;
  /** Split EV does not model resplitting, so it is labelled where it is shown. */
  readonly approximationNote: string | null;
};

/**
 * Everything needed to explain one decision.
 *
 * **Precondition:** `ev` came from `evaluateActions(evInput)`. The two travel
 * together because the prose quotes the same numbers the EV bars draw, and a
 * caller that recomputed one of them against a different composition would
 * produce a sheet that silently contradicts itself. Passing the inputs rather
 * than the loose fields is what makes that mistake awkward to write.
 */
export type ExplainInput = {
  readonly evInput: EvInput;
  readonly ev: ActionEv;
  readonly recommendation: Recommendation;
};

// --- Formatting ------------------------------------------------------------

/**
 * A probability as a percentage. "about 41%".
 *
 * The two guards are not pedantry: a rounded 0% reads as impossible and a
 * rounded 100% reads as certain, and both of those are claims the number does
 * not support. Near the ends of the range the honest phrasing is a bound.
 */
function percent(p: number): string {
  const rounded = Math.round(p * 100);
  if (rounded <= 0) return p <= 0 ? 'never' : 'under 1%';
  if (rounded >= 100) return p >= 1 ? 'always' : 'over 99%';
  return `${rounded}%`;
}

/**
 * An EV as cents per dollar wagered, unsigned. The sign is carried by the verb
 * in `moneyPhrase`, because "loses 24¢" reads and "wins -24¢" does not.
 */
function cents(ev: number): string {
  const rounded = Math.round(Math.abs(ev) * 100);
  if (rounded === 0) return 'under a cent';
  return `${rounded}¢`;
}

/** "loses 24¢" · "wins 12¢" · "breaks even". */
function moneyPhrase(ev: number): string {
  if (Math.round(Math.abs(ev) * 100) === 0) return 'breaks even';
  return ev < 0 ? `loses ${cents(ev)}` : `wins ${cents(ev)}`;
}

const GERUND: Readonly<Record<Action, string>> = {
  hit: 'Hitting',
  stand: 'Standing',
  double: 'Doubling',
  split: 'Splitting',
  surrender: 'Surrendering',
};

const IMPERATIVE: Readonly<Record<Action, string>> = {
  hit: 'Hit',
  stand: 'Stand',
  double: 'Double',
  split: 'Split',
  surrender: 'Surrender',
};

/** Lower-case gerund, for mid-sentence use: "hitting loses 24¢". */
function gerund(action: Action): string {
  return GERUND[action].toLowerCase();
}

/**
 * The upcard as the player sees it: "a 4", "an 8", "a King", "an Ace".
 *
 * The article follows the sound, not the letter, which is why the test is an
 * explicit pair and not `/^[aeiou8]/` — "an 8" and "an Ace" take one, "a Jack"
 * does not, and a King is named rather than flattened to the 10 the chart
 * treats it as.
 */
function upcardPhrase(rank: Rank): string {
  const name = rank === 'A' ? 'Ace'
    : rank === 'T' ? '10'
    : rank === 'J' ? 'Jack'
    : rank === 'Q' ? 'Queen'
    : rank === 'K' ? 'King'
    : rank;
  return name === 'Ace' || name === '8' ? `an ${name}` : `a ${name}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A pair named by what it is: "aces", "eights", "tens". */
function pairName(rank: Rank): string {
  switch (rank) {
    case 'A': return 'aces';
    case '2': return 'twos';
    case '3': return 'threes';
    case '4': return 'fours';
    case '5': return 'fives';
    case '6': return 'sixes';
    case '7': return 'sevens';
    case '8': return 'eights';
    case '9': return 'nines';
    default: return 'tens';
  }
}

// --- Derived numbers -------------------------------------------------------

const BUCKETS: readonly CompIndex[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Bucket value with the ace counted *low* — the only way a draw can bust you. */
function lowValue(index: CompIndex): number {
  return index === 0 ? 1 : index === 9 ? 10 : index + 1;
}

/**
 * Chance the very next card busts this hand.
 *
 * Computed from the hard total, so a soft hand answers zero without a special
 * case: a soft total of 21 or less has a hard total of 11 or less, and no single
 * card takes eleven past twenty-one.
 */
function bustChanceIfHit(hard: number, composition: Composition): number {
  let remaining = 0;
  let busting = 0;
  for (const i of BUCKETS) {
    remaining += composition[i];
    if (hard + lowValue(i) > 21) busting += composition[i];
  }
  return remaining === 0 ? 0 : busting / remaining;
}

/** The EV of one action, or null when it is unavailable. */
function evOf(ev: ActionEv, action: Action): number | null {
  switch (action) {
    case 'stand': return ev.stand;
    case 'hit': return ev.hit;
    case 'double': return ev.double;
    case 'split': return ev.split;
    case 'surrender': return null;
  }
}

/** Every action with a number attached, best first. */
function ranked(ev: ActionEv): readonly { action: Action; ev: number }[] {
  const rows: { action: Action; ev: number }[] = [
    { action: 'stand', ev: ev.stand },
    { action: 'hit', ev: ev.hit },
  ];
  if (ev.double !== null) rows.push({ action: 'double', ev: ev.double });
  if (ev.split !== null) rows.push({ action: 'split', ev: ev.split });
  return rows.sort((a, b) => b.ev - a.ev);
}

/**
 * Everything a template is allowed to talk about.
 *
 * Assembled once per explanation so that no template reaches back into the
 * composition or the dealer distribution on its own — which is what keeps the
 * numbers in the prose and the numbers on the EV bars the same numbers.
 */
type Facts = {
  readonly total: number;
  readonly soft: boolean;
  readonly upcard: string;
  readonly pair: string | null;
  /** Dealer busts. Conditioned on the peek, when the dealer has peeked. */
  readonly dealerBust: number;
  /** Dealer reaches 17-21 or a natural — i.e. does not bust. */
  readonly dealerMade: number;
  readonly bustIfHit: number;
  readonly ev: ActionEv;
  readonly action: Action;
  /** Best available action other than the recommended one, for comparisons. */
  readonly alternative: Action | null;
  readonly rules: RuleSet;
};

// --- Shared sentences ------------------------------------------------------

function dealerBustSentence(f: Facts): string {
  return `The dealer busts about ${percent(f.dealerBust)} of the time showing ${f.upcard}.`;
}

function dealerMadeSentence(f: Facts): string {
  return `Showing ${f.upcard}, the dealer finishes with 17 or better about ${percent(f.dealerMade)} of the time.`;
}

/** Only worth saying when a draw can actually bust the hand. */
function bustIfHitSentence(f: Facts): string | null {
  if (f.bustIfHit <= 0) return null;
  return `If you hit, you bust right there ${percent(f.bustIfHit)} of the time.`;
}

/**
 * The single most useful sentence in the app, and the one it is least allowed to
 * get wrong: it may only be said when both numbers really are losses.
 *
 * Most decisions on the chart are between two bad outcomes. Saying so is what
 * stops a beginner reading a correct play that loses as a broken app.
 */
function cheaperLossLine(mine: number, theirs: number): string | null {
  if (mine >= 0 || theirs >= 0) return null;
  return 'You lose money on this hand either way — you are picking the cheaper loss, not a winning play.';
}

/**
 * The recommended action against its closest rival, in money.
 *
 * The wording is chosen from the signs rather than fixed by the caller, so the
 * damage-control framing appears exactly when it is true and never otherwise.
 */
function moneyComparison(f: Facts): string {
  const mine = evOf(f.ev, f.action);
  if (mine === null) return '';
  const theirs = f.alternative === null ? null : evOf(f.ev, f.alternative);
  if (f.alternative === null || theirs === null) {
    return `${GERUND[f.action]} ${moneyPhrase(mine)} per dollar.`;
  }
  const both = `${GERUND[f.action]} ${moneyPhrase(mine)} per dollar, ${gerund(f.alternative)} ${moneyPhrase(theirs)}.`;
  return paragraph(both, cheaperLossLine(mine, theirs));
}

/** Sentences joined into a paragraph, with the empty ones dropped. */
function paragraph(...parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' ');
}

// --- Templates -------------------------------------------------------------

type Copy = { readonly summary: string; readonly detail: string };

/**
 * One template per reason code. `Record<ReasonCode, …>` is the point: a code
 * added to `strategy.ts` without prose here fails to compile rather than
 * reaching a player as a blank hint card.
 */
const TEMPLATES: Readonly<Record<ReasonCode, (f: Facts) => Copy>> = {
  CANT_BUST_ALWAYS_HIT: (f) => ({
    summary: 'You cannot bust — there is no card that hurts you.',
    detail: paragraph(
      `At ${f.total} every card in the shoe leaves you at 21 or under, so drawing costs you nothing.`,
      `Standing here wins only when the dealer busts, and that is about ${percent(f.dealerBust)} of the time showing ${f.upcard}.`,
      moneyComparison(f),
    ),
  }),

  DEALER_WEAK_LET_THEM_BUST: (f) => ({
    summary: `The dealer is the one in trouble — ${f.upcard} busts about ${percent(f.dealerBust)} of the time.`,
    detail: paragraph(
      dealerBustSentence(f),
      'Those are hands you win without drawing a card.',
      bustIfHitSentence(f),
      `Standing keeps a hand that is bad; hitting risks not having one at all.`,
      moneyComparison(f),
    ),
  }),

  DEALER_STRONG_MUST_IMPROVE: (f) => ({
    summary: `${f.total} beats nothing the dealer is likely to make. You have to improve it.`,
    detail: paragraph(
      dealerMadeSentence(f),
      `Your ${f.total} loses to every one of those, so standing is a hand you have already lost.`,
      bustIfHitSentence(f),
      'That is the price of the times you draw a small card and live.',
      moneyComparison(f),
    ),
  }),

  SOFT_HAND_CANT_BUST: (f) => ({
    summary: 'With the ace counted as eleven, one card cannot bust you.',
    detail: paragraph(
      `A soft ${f.total} cannot be broken by a single card — the worst that happens is the ace drops to one and you carry on.`,
      `Standing on it against ${f.upcard} is standing on a hand that mostly loses, so take the free look.`,
      moneyComparison(f),
    ),
  }),

  DOUBLE_WHEN_DEALER_LIKELY_BUSTS: (f) => ({
    summary: `${capitalize(f.upcard)} is weak ground for the dealer — get more money out.`,
    detail: paragraph(
      dealerBustSentence(f),
      'When the dealer is this likely to beat themselves, the move is to have more money on the table, not a better hand.',
      'Doubling puts out a second bet and buys exactly one card, which is the whole trade: you give up the right to draw again in exchange for twice the stake.',
      moneyComparison(f),
    ),
  }),

  DOUBLE_STRONG_TOTAL: (f) => ({
    summary: `${f.total} is a strong total — you are doubling on your own hand, not on a weak dealer.`,
    detail: paragraph(
      `${f.total} is one of the best starting totals in the game: no card can bust it, and any ten-value card makes ${f.total + 10}.`,
      dealerMadeSentence(f),
      'This is not a dealer in trouble, so the extra bet is not going out on their weakness — it is going out on the fact that one card is very likely to leave you with a hand that beats them anyway.',
      moneyComparison(f),
    ),
  }),

  STAND_ON_A_MADE_HAND: (f) => ({
    summary: `${f.total} is a hand worth keeping. Anything you draw is more likely to spoil it.`,
    detail: paragraph(
      `${f.total} already beats most of what the dealer finishes with.`,
      f.soft
        ? 'A soft hand cannot bust on one card, but drawing turns this total into a worse one far more often than a better one.'
        : bustIfHitSentence(f),
      'There is nothing much to gain and a made hand to lose.',
      moneyComparison(f),
    ),
  }),

  SPLIT_TWO_HANDS_BEAT_ONE: (f) => ({
    summary: `A pair of ${f.pair ?? 'these'} is one weak hand or two decent ones. Take the two.`,
    detail: paragraph(
      `Played together, this pair is a ${f.total} — a total you would rather not have against ${f.upcard}.`,
      `Split, each card starts a hand of its own, with a fresh bet behind it.`,
      dealerBustSentence(f),
      'That is why the extra money goes out here and not against a strong upcard.',
      moneyComparison(f),
    ),
  }),

  ALWAYS_SPLIT_ACES: (f) => ({
    summary: 'Always split aces. Two hands starting at eleven is the best position in the game.',
    detail: paragraph(
      'Together, two aces are a soft 12 — a hand that wins almost nothing.',
      'Split, each ace starts at eleven, where every ten-value card makes 21.',
      `You get exactly one card on each and no more, and 21 on a split ace pays even money rather than ${f.rules.blackjackPayout[0]}:${f.rules.blackjackPayout[1]}.`,
      'Both of those are real costs, and splitting is still not close.',
      moneyComparison(f),
    ),
  }),

  ALWAYS_SPLIT_EIGHTS: (f) => ({
    summary: 'Always split eights — even against a ten. Sixteen is the worst hand at the table.',
    detail: paragraph(
      'Sixteen is the worst total in blackjack: too low to win by standing, too high to draw to safely.',
      'Two hands starting at eight are not good hands, but neither of them is 16.',
      moneyComparison(f),
      (evOf(f.ev, f.action) ?? 0) < 0
        ? 'Against an upcard this strong the split is damage control — it is not a winning play, it is the least you can lose.'
        : 'Against an upcard this weak the split is not damage control at all: two fresh bets against a dealer in trouble is where the money is.',
    ),
  }),

  NEVER_SPLIT_TENS: (f) => ({
    summary: 'Never split tens. Twenty is already a winning hand — do not trade it for two unknowns.',
    detail: paragraph(
      `Twenty wins the large majority of the hands it is played, and ${f.upcard} does not change that.`,
      'Splitting breaks up a hand that already wins in order to start two new hands at ten apiece, and puts a second bet behind the worse position.',
      moneyComparison(f),
    ),
  }),

  NEVER_SPLIT_FIVES: (f) => ({
    summary: 'Never split fives. A pair of fives is a hard 10 — one of the best totals you can hold.',
    detail: paragraph(
      'Read this hand as a hard 10, not as a pair: 10 is a total you want, and a five is the card you least want to build a hand on.',
      'Splitting turns one strong hand into two weak ones.',
      moneyComparison(f),
    ),
  }),

  INSURANCE_IS_A_SUCKER_BET: (f) => ({
    summary: 'Insurance is a side bet on the hole card, at a price that always favours the house.',
    detail: paragraph(
      `Insurance pays ${f.rules.insurancePayout[0]}:${f.rules.insurancePayout[1]}, so it needs the hole card to be a ten more than one time in three to break even.`,
      'Ten-value cards are only four ranks in thirteen. The price is worse than the odds, and no hand of yours changes that — it is a bet on the dealer, not on you.',
      '"Even money" on a blackjack is the same losing bet in a friendlier costume.',
    ),
  }),

  CLOSEST_CALL: (f) => ({
    summary: 'This one is genuinely close — the chart wins it, but only just.',
    detail: paragraph(
      closestCallSentence(f),
      // The narrowest cells on the chart are also, without exception, cells
      // where both options lose. Saying only "it is close" would leave the
      // player wondering which of two winners they had missed.
      cheaperLossLine(...closestTwo(f)),
      dealerBustSentence(f),
      bustIfHitSentence(f),
      'The chart has the better side of it and it is the right habit to build, but this is not a cell anyone should feel bad about.',
    ),
  }),

  DAMAGE_CONTROL: (f) => ({
    summary: 'Every option here loses money. This is the cheapest one.',
    detail: paragraph(
      dealerMadeSentence(f),
      `There is no play that turns ${f.total} into a good hand against that.`,
      bustIfHitSentence(f),
      moneyComparison(f),
      'Most blackjack decisions are damage control — the chart is not finding you winners, it is losing you the least.',
    ),
  }),
};

/** The EVs of the two best actions. Equal values when there is only one action. */
function closestTwo(f: Facts): readonly [number, number] {
  const rows = ranked(f.ev);
  const first = rows[0]?.ev ?? 0;
  return [first, rows[1]?.ev ?? first];
}

/** The two contenders and the gap between them, which is the whole point here. */
function closestCallSentence(f: Facts): string {
  const rows = ranked(f.ev);
  const first = rows[0];
  const second = rows[1];
  if (first === undefined || second === undefined) return '';
  const gap = Math.abs(first.ev - second.ev);
  // Below a cent there is no number worth quoting — "about under a cent apart"
  // is not a sentence, and the fact that matters is that they are level.
  const distance =
    Math.round(gap * 100) === 0 ? 'within a cent of each other' : `about ${cents(gap)} apart`;
  return (
    `${GERUND[first.action]} ${moneyPhrase(first.ev)} per dollar and ${gerund(second.action)} ` +
    `${moneyPhrase(second.ev)} — ${distance}.`
  );
}

// --- Assembly --------------------------------------------------------------

/**
 * Explain one recommendation.
 *
 * Postcondition: `headline`, `summary` and `detail` are all non-empty, and every
 * number in them was formatted from `input.ev` or from a dealer distribution
 * over `input.evInput.composition` — the same numbers the EV bars are drawn from.
 */
export function explain(input: ExplainInput): Explanation {
  const { ev, recommendation } = input;
  const copy = TEMPLATES[recommendation.reasonCode](gatherFacts(input));

  return {
    headline: `${IMPERATIVE[recommendation.action]}.`,
    summary: copy.summary,
    // The fallback note leads, when there is one: it changes what the rest of
    // the paragraph is about.
    detail: paragraph(fallbackNote(recommendation), copy.detail),
    advancedNote: advancedNote(recommendation, ev),
    // Labelled wherever a split number is shown, per SPEC §5.2's licence to
    // approximate resplits — the licence is conditional on saying so.
    approximationNote:
      ev.split !== null
        ? 'The split figure is approximate: it values two hands and does not model splitting again.'
        : null,
  };
}

/**
 * The chart wanted something this hand may not do — no funds to match the bet, a
 * third card already drawn, the four-hand limit reached. Said plainly and first,
 * because the alternative is presenting a fallback as the lesson.
 *
 * Which restriction applied is not knowable from here, and guessing wrong would
 * be worse than not saying, so the note names the want and not the reason.
 */
function fallbackNote(recommendation: Recommendation): string | null {
  if (!recommendation.fallback) return null;
  const wanted = CHART_WANT[recommendation.chartAction];
  return `The book wants to ${wanted} here, but that is not available on this hand — this is the best of what is left.`;
}

const CHART_WANT: Readonly<Record<Recommendation['chartAction'], string>> = {
  H: 'hit',
  S: 'stand',
  D: 'double',
  Ds: 'double',
  P: 'split',
  Ph: 'split',
};

/**
 * The composition-dependent disagreement of SPEC §5.3, and nothing else.
 *
 * The chart still owns the headline. This is a note, in the register of an
 * aside, because a beginner told two different things at once learns neither.
 */
function advancedNote(recommendation: Recommendation, ev: ActionEv): string | null {
  if (ev.best === recommendation.action) return null;
  const mine = evOf(ev, recommendation.action);
  if (mine === null) return null;
  const gap = ev.bestEv - mine;
  // Quoting the margin and then calling it small in the same breath would
  // contradict itself at the rounding boundary, so the note states the number
  // and lets it speak.
  return (
    `Advanced: with these exact cards the numbers narrowly prefer ${gerund(ev.best)}, by ` +
    `${cents(gap)} per dollar. The chart's answer is the one to learn — a deviation like this ` +
    `turns on the precise cards showing, and stops being right the moment they change.`
  );
}

function gatherFacts(input: ExplainInput): Facts {
  const { evInput, ev, recommendation } = input;
  const { total, soft } = handTotal(evInput.playerCards);
  const hard = soft ? total - 10 : total;
  const dealer = dealerOutcomes(
    compIndex(evInput.dealerUpcard.rank),
    evInput.composition,
    evInput.peekedNotBlackjack,
    evInput.rules,
  );

  return {
    total,
    soft,
    upcard: upcardPhrase(evInput.dealerUpcard.rank),
    pair: pairLabel(evInput.playerCards),
    dealerBust: dealer.pBust,
    dealerMade: madeChance(dealer),
    bustIfHit: bustChanceIfHit(hard, evInput.composition),
    ev,
    action: recommendation.action,
    alternative: bestOther(ev, recommendation.action),
    rules: evInput.rules,
  };
}

function madeChance(dealer: DealerDistribution): number {
  return dealer.p17 + dealer.p18 + dealer.p19 + dealer.p20 + dealer.p21 + dealer.pBlackjack;
}

function pairLabel(cards: readonly Card[]): string | null {
  const first = cards[0];
  const second = cards[1];
  if (cards.length !== 2 || first === undefined || second === undefined) return null;
  if (compIndex(first.rank) !== compIndex(second.rank)) return null;
  return pairName(first.rank);
}

/** The strongest action that is not the recommended one, for the comparison. */
function bestOther(ev: ActionEv, action: Action): Action | null {
  const rows = ranked(ev).filter((row) => row.action !== action);
  return rows[0]?.action ?? null;
}

// --- Insurance -------------------------------------------------------------

/**
 * The insurance offer, which is not a decision about the player's hand at all.
 *
 * Separate entry point because it has no hand to reason about: `composition` is
 * the unseen cards, and the whole argument is the density of tens in it against
 * the price on offer.
 */
export function explainInsurance(composition: Composition, rules: RuleSet): Explanation {
  const ev = insuranceEv(composition, rules);
  let remaining = 0;
  for (const i of BUCKETS) remaining += composition[i];
  const tenDensity = remaining === 0 ? 0 : composition[9] / remaining;
  const [numerator, denominator] = rules.insurancePayout;
  const breakEven = denominator / (numerator + denominator);

  return {
    headline: 'Decline insurance.',
    summary: `Insurance ${moneyPhrase(ev)} per dollar staked. It is a side bet, and a bad one.`,
    detail: paragraph(
      `Insurance is a bet that the dealer's hole card is a ten, paid at ${numerator}:${denominator}.`,
      `At that price it needs to win ${percent(breakEven)} of the time to break even, and ten-value cards are ${percent(tenDensity)} of the cards you have not seen.`,
      `Over time it ${moneyPhrase(ev)} for every dollar you put on it.`,
      'Nothing about your own hand changes this, which is the tell: it is a bet on the dealer wearing the name of a bet on you.',
      '"Even money" on a blackjack is the same bet in a friendlier costume — you are being offered a certain 1:1 in place of a 3:2 that arrives most of the time.',
    ),
    advancedNote: null,
    approximationNote: null,
  };
}
