/**
 * Settings (SPEC §9), as a modal over whatever is showing.
 *
 * **Why a modal and not a route.** Leaving the table route unmounts
 * `TableScreen`, and with it the session, the event log and the report being
 * accumulated from it. Hint mode is the one setting a player is most likely to
 * change *mid-hand* — that is what "on request" and "after the fact" are for —
 * so the screen that owns it must not cost them the session to open. See
 * `route.ts`.
 *
 * **Why hint mode is the only live control.** SPEC §9 lists sound, animation
 * speed, counting and reset-bankroll alongside it. Counting is M7 and is one
 * flag (`CoachSettings.knownCards`) whose UI obligation is a running-count
 * display, not a toggle. The other three are either unimplemented subsystems or
 * meaningless without persistence: a bankroll reset that survives nothing is
 * indistinguishable from starting a new session, which the report card's "play
 * again" already is. They are named in the footer rather than stubbed, for the
 * reason `HomeScreen` gives.
 */

import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';

import { HINT_MODES, type HintMode } from '../table/tableState';
import { Button } from '../ui/Button';
import { C } from '../ui/theme';

/** SPEC §5.5's four modes, and what each one actually does. */
const HINT_MODE_COPY: Record<HintMode, { readonly label: string; readonly blurb: string }> = {
  always: {
    label: 'Always shown',
    blurb: 'The book answer and a one-line reason, before every decision.',
  },
  'on-request': {
    label: 'On request',
    blurb: 'A Hint button on the action bar. Nothing until you ask.',
  },
  after: {
    label: 'After the fact',
    blurb: 'Play first, then see whether you were right and what it cost.',
  },
  off: {
    label: 'Off',
    blurb: 'No coaching during play. The report card still scores every decision.',
  },
};

export function SettingsScreen({
  hintMode,
  onHintMode,
  onClose,
}: {
  readonly hintMode: HintMode;
  readonly onHintMode: (mode: HintMode) => void;
  readonly onClose: () => void;
}) {
  return (
    <Modal visible animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={styles.screen}>
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.title}>Settings</Text>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Hints</Text>
            <View style={styles.options}>
              {HINT_MODES.map((mode) => (
                <Option
                  key={mode}
                  label={HINT_MODE_COPY[mode].label}
                  blurb={HINT_MODE_COPY[mode].blurb}
                  selected={mode === hintMode}
                  onPress={() => onHintMode(mode)}
                />
              ))}
            </View>
            {/* SPEC §5.5. Worth saying on the screen where a player turns
                coaching off, because "off" is the mode most likely to be chosen
                by someone who expects to be nagged. */}
            <Text style={styles.fieldHint}>
              Deviating from the advice is never blocked and never scolded. It is
              recorded, and priced on the report card.
            </Text>
          </View>

          <Text style={styles.footer}>
            Sound, animation speed, counting mode and bankroll reset are not built
            yet. Nothing is stored between launches, so every session starts fresh.
          </Text>
        </ScrollView>

        <View style={styles.actions}>
          <Button label="Done" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function Option({
  label,
  blurb,
  selected,
  onPress,
}: {
  readonly label: string;
  readonly blurb: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <View style={[styles.option, selected && styles.optionSelected]}>
      <Button
        variant="pill"
        label={label}
        selected={selected}
        onPress={onPress}
        style={styles.optionButton}
      />
      <Text style={styles.optionBlurb}>{blurb}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.felt },
  body: { padding: 20, paddingTop: 56, paddingBottom: 32, gap: 24 },
  title: { color: C.text, fontSize: 26, fontWeight: '700' },

  field: { gap: 10 },
  fieldLabel: {
    color: C.accent,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  fieldHint: { color: C.textFaintest, fontSize: 12, lineHeight: 17 },

  options: { gap: 8 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: 10,
    backgroundColor: C.wellSoft,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  optionSelected: { borderColor: C.accent, backgroundColor: C.panel },
  optionButton: { minWidth: 108 },
  optionBlurb: { color: C.textDim, fontSize: 12, lineHeight: 16, flex: 1 },

  footer: { color: C.textFaintest, fontSize: 11, lineHeight: 16 },

  actions: { padding: 16, paddingBottom: 28, backgroundColor: C.well },
});
