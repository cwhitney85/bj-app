/**
 * The felt (SPEC §9): a 2.5D table, the dealer at the flat side, seven chairs
 * arced around them.
 *
 * Everything drawn here comes off the `ShownTable` the hook folds out of the
 * event stream — never `session.state`, which is the future (M4 decision 34).
 * The geometry is `seatArc.ts`, the chips are `chips.ts`, and both are tested;
 * this file is the arrangement.
 *
 * **The table does not rotate.** The player sits in the chair they picked and
 * the chairs stay where they are, so left-to-right on screen is turn order,
 * always. What that costs is SPEC §9's "your cards render larger and nearer",
 * which used to come free when the player was pinned to the near point of the
 * arc — it is now `PLAYER_EMPHASIS`, an explicit bump applied to whichever chair
 * they took. See `seatArc.ts` for the full reasoning.
 */

import { StyleSheet, Text, View } from 'react-native';
import type { RuleSet, ShownDealer, ShownHand, ShownSeat, ShownTable } from '@bj/engine';

import { C } from '../../ui/theme';
import { Badge } from './Badge';
import { ChipStack } from './ChipStack';
import { CardFan } from './PlayingCard';
import { status, tone, total } from './handRead';
import { seatArc, seatName } from './seatArc';
import { Shoe } from './Shoe';
import { formatMoney, formatSignedMoney } from '../../ui/money';

/** A card's width at the near point of the arc, before perspective. */
const CARD_WIDTH = 28;

/**
 * The size the player's own chair always draws at, whichever chair it is.
 *
 * **A constant, not a multiplier on the arc's perspective, and the difference is
 * SPEC §9's requirement surviving the table not rotating.** §9 asks that "your
 * cards render larger and nearer"; with a fixed table they cannot be nearer, so
 * they have to be reliably larger. A multiplier does not deliver that — at the
 * ends of the arc `scale` is `MIN_SCALE`, so a player at first base would draw
 * *smaller* than the bots in the middle of the table and the felt's focus would
 * be on somebody else's hand. Driving it is what showed this: at 1.3× the player
 * at first base was the same size as the bot at seat 4.
 *
 * So perspective applies to the bots, and the player is a fixed size above all
 * of them. That is POV consistency achieved by scale rather than by position,
 * which is the only axis the fixed table leaves.
 */
const PLAYER_EMPHASIS = 1.25;

/** A seat's box, at full scale. Fixed so a growing hand fans rather than spreads. */
const SEAT_WIDTH = 104;

export function Felt({
  felt,
  rules,
  playerSeat,
  jerkSeat,
}: {
  readonly felt: ShownTable;
  readonly rules: RuleSet;
  readonly playerSeat: number;
  /** Who is playing badly right now (SPEC §6), so the felt can say so. */
  readonly jerkSeat: number | null;
}) {
  const placements = seatArc(felt.seats.length);

  return (
    <View style={styles.felt}>
      <View style={styles.dealerRow}>
        {/* The two pieces of table furniture, in the corners at the dealer's end
            where the arc never reaches. Both are positioned rather than laid
            out, so neither competes with the chairs for height when the hint
            sheet expands and the felt gives some up.

            The rules are read off the rule set rather than typed in: the app
            teaches strategy relative to these rules (SPEC §2), so a felt stating
            a different one would be teaching a different game. */}
        <View style={styles.printedSlot}>
          <Text style={styles.printed}>BLACKJACK PAYS {rules.blackjackPayout[0]} TO {rules.blackjackPayout[1]}</Text>
          <Text style={styles.printed}>
            DEALER {rules.dealerHitsSoft17 ? 'HITS' : 'STANDS'} ON SOFT 17
          </Text>
        </View>
        <Dealer dealer={felt.dealer} />
        <View style={styles.shoeSlot}>
          <Shoe rules={rules} shoeIndex={felt.shoeIndex} shufflePending={felt.shufflePending} />
        </View>
      </View>

      <View style={styles.arc}>
        {felt.seats.map((seat) => {
          const placement = placements[seat.index];
          if (placement === undefined) return null;
          return (
            <Chair
              key={seat.index}
              seat={seat}
              seatCount={felt.seats.length}
              x={placement.x}
              y={placement.y}
              scale={placement.scale}
              isPlayer={seat.index === playerSeat}
              isActing={seat.index === felt.turnSeat}
              isJerk={seat.index === jerkSeat}
            />
          );
        })}
      </View>
    </View>
  );
}

// --- The dealer -------------------------------------------------------------

function Dealer({ dealer }: { readonly dealer: ShownDealer }) {
  return (
    <View style={styles.dealer}>
      <View style={styles.dealerPlate}>
        <Text style={styles.dealerName}>DEALER</Text>
      </View>
      <View style={styles.dealerCards}>
        {dealer.cards.length === 0 ? (
          <View style={{ height: CARD_WIDTH * 1.5 * 1.4 }} />
        ) : (
          <CardFan cards={dealer.cards} width={CARD_WIDTH * 1.5} />
        )}
      </View>
      {dealer.total === null && !dealer.busted ? null : (
        <Badge
          text={dealer.busted ? 'BUST' : total(dealer.total, dealer.soft)}
          tone={dealer.busted ? 'bad' : 'plain'}
        />
      )}
    </View>
  );
}

// --- A chair ----------------------------------------------------------------

function Chair({
  seat,
  seatCount,
  x,
  y,
  scale,
  isPlayer,
  isActing,
  isJerk,
}: {
  readonly seat: ShownSeat;
  readonly seatCount: number;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly isPlayer: boolean;
  readonly isActing: boolean;
  readonly isJerk: boolean;
}) {
  const draw = isPlayer ? PLAYER_EMPHASIS : scale;
  const width = SEAT_WIDTH * draw;
  const empty = seat.occupant.kind === 'empty';

  return (
    <View
      style={[
        styles.chair,
        {
          left: `${x * 100}%`,
          bottom: `${(1 - y) * 100}%`,
          width,
          marginLeft: -width / 2,
          // The player draws over their neighbours, and the acting seat over
          // everyone: on a crowded arc the chairs overlap, and the one being
          // looked at must be the one on top.
          zIndex: isActing ? 30 : isPlayer ? 20 : 10,
        },
      ]}
      pointerEvents="none"
    >
      {empty ? (
        <View style={[styles.emptyChair, { width: width * 0.5, height: width * 0.16 }]} />
      ) : (
        <>
          <View style={styles.hands}>
            {seat.hands.length === 0 ? null : (
              seat.hands.map((hand, index) => (
                <Hand
                  key={index}
                  hand={hand}
                  cardWidth={CARD_WIDTH * draw}
                  isActing={isActing && seat.activeHandIndex === index}
                  compact={seat.hands.length > 1}
                />
              ))
            )}
          </View>

          <View style={styles.bets}>
            {seat.baseBet > 0 && seat.hands.length === 0 ? (
              <ChipStack amount={seat.baseBet} size={22 * draw} />
            ) : null}
            {seat.insuranceBet > 0 ? (
              <ChipStack
                amount={seat.insuranceBet}
                size={16 * draw}
                label={`ins ${formatMoney(seat.insuranceBet)}`}
              />
            ) : null}
          </View>

          <View
            style={[
              styles.plate,
              isPlayer && styles.platePlayer,
              isActing && styles.plateActing,
            ]}
          >
            <Text
              style={[styles.plateName, { fontSize: 11 * Math.max(0.85, draw) }]}
              numberOfLines={1}
            >
              {seatName(seat.index, seatCount, isPlayer)}
              {isJerk ? ' ⚠' : ''}
            </Text>
            <Text style={[styles.plateBankroll, { fontSize: 10 * Math.max(0.85, draw) }]}>
              {formatMoney(seat.bankroll)}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

function Hand({
  hand,
  cardWidth,
  isActing,
  compact,
}: {
  readonly hand: ShownHand;
  readonly cardWidth: number;
  readonly isActing: boolean;
  /** This seat has split, so its hands share the width. */
  readonly compact: boolean;
}) {
  const width = compact ? cardWidth * 0.72 : cardWidth;

  return (
    <View style={[styles.hand, isActing && styles.handActing]}>
      <CardFan cards={hand.cards.map((card) => ({ facing: 'up' as const, card }))} width={width} />
      <Badge text={status(hand)} tone={tone(hand)} />
      {hand.bet > 0 ? <ChipStack amount={hand.bet} size={18 * (compact ? 0.8 : 1)} /> : null}
      {hand.net === null ? null : (
        <Text style={[styles.net, hand.net >= 0 ? styles.good : styles.bad]}>
          {formatSignedMoney(hand.net)}
        </Text>
      )}
    </View>
  );
}

// --- Styles -----------------------------------------------------------------

const styles = StyleSheet.create({
  felt: {
    flex: 1,
    backgroundColor: C.felt,
    // The table's curved edge. The dealer is at the flat top; the arc below is
    // the near rail the chairs sit against.
    borderBottomLeftRadius: 180,
    borderBottomRightRadius: 180,
    borderBottomWidth: 6,
    borderBottomColor: '#5a3a24',
    overflow: 'hidden',
    paddingTop: 10,
  },

  dealerRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 14 },
  shoeSlot: { position: 'absolute', right: 12, top: 4 },
  dealer: { flex: 1, alignItems: 'center', gap: 5 },
  dealerPlate: {
    paddingHorizontal: 12,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: C.well,
    borderWidth: 1,
    borderColor: C.edge,
  },
  dealerName: { color: C.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  dealerCards: { alignItems: 'center', minHeight: CARD_WIDTH * 1.5 * 1.4 },

  printedSlot: { position: 'absolute', left: 12, top: 4, maxWidth: 110 },
  printed: { color: '#3f7a62', fontSize: 8, fontWeight: '700', letterSpacing: 0.8 },

  /**
   * Everything in here is absolutely placed by `seatArc`.
   *
   * `minHeight` is what stops the arc collapsing into the dealer when the hint
   * sheet expands and the felt gives up height. Below it the whole screen
   * scrolls off the bottom, which is honest; chairs stacked on the dealer is not.
   */
  arc: { flex: 1, minHeight: 170, marginTop: 6, zIndex: 1 },
  chair: { position: 'absolute', alignItems: 'center', gap: 3 },
  emptyChair: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(0,0,0,0.12)',
  },

  hands: { flexDirection: 'row', gap: 4, alignItems: 'flex-end', justifyContent: 'center' },
  hand: { alignItems: 'center', gap: 2 },
  handActing: {
    // A ring rather than a colour change: the acting hand is a *cursor*, and it
    // must read the same on a busted hand as on a fresh one.
    borderWidth: 1,
    borderColor: C.accent,
    borderRadius: 6,
    padding: 2,
  },

  bets: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, minHeight: 4 },

  plate: {
    alignItems: 'center',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: C.well,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  platePlayer: { backgroundColor: C.panelPlayer, borderColor: C.edge },
  plateActing: { borderColor: C.accent },
  plateName: { color: C.textDim, fontWeight: '700' },
  plateBankroll: { color: C.textFaint },

  net: { fontSize: 10, fontWeight: '700' },
  good: { color: C.good },
  bad: { color: C.bad },
});
