/**
 * Home (SPEC §9).
 *
 * "Play, settings, how to play, lifetime stats summary." Two of those four are
 * here. **How to play and lifetime stats are deliberately absent rather than
 * stubbed**, because a disabled button that says "How to play" is a promise the
 * app does not keep, and a lifetime-stats panel reading all zeros is worse than
 * no panel: it is a claim about the player's history, and this app has no
 * history to make one from until persistence lands (MMKV, SPEC §9). A screen
 * that shows less is honest; a screen that shows placeholders is not.
 *
 * The subtitle is the product thesis, on the first screen, because SPEC §1 says
 * the game is the delivery mechanism and the teaching is the point. A player who
 * reads only this screen should still know what they downloaded.
 */

import { StyleSheet, Text, View } from 'react-native';

import { Button } from '../ui/Button';
import { C } from '../ui/theme';

export function HomeScreen({
  onPlay,
  onSettings,
}: {
  readonly onPlay: () => void;
  readonly onSettings: () => void;
}) {
  return (
    <View style={styles.screen}>
      <View style={styles.masthead}>
        <Text style={styles.title}>Blackjack</Text>
        <Text style={styles.subtitle}>
          Every decision, with the reason and what it costs. Ignore the advice
          whenever you like — the report card is the only one keeping score.
        </Text>
      </View>

      <View style={styles.actions}>
        <Button label="Play" onPress={onPlay} />
        <Button label="Settings" onPress={onSettings} variant="secondary" />
      </View>

      {/* Vegas Strip is fixed for the MVP (SPEC §2) and the strategy chart is
          only correct relative to it, so the rules are stated rather than
          configured. */}
      <Text style={styles.rules}>
        6 decks · dealer stands on soft 17 · blackjack pays 3:2 · double after
        split · no surrender · play money
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: C.felt,
    padding: 28,
    paddingBottom: 40,
    justifyContent: 'space-between',
  },
  masthead: { paddingTop: 72, gap: 12 },
  title: { color: C.text, fontSize: 40, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: C.textDim, fontSize: 15, lineHeight: 22 },
  actions: { gap: 10 },
  rules: { color: C.textFaintest, fontSize: 11, lineHeight: 16, textAlign: 'center' },
});
