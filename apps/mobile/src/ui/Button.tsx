/**
 * The one button.
 *
 * Lifted out of `TableScreen.tsx`, where it was a local, when the shell added
 * four more screens that all needed it. Three variants and no more: `primary`
 * is chip gold and means "the thing this screen is for", `secondary` is
 * outlined in gold and means "the other way out", `pill` is the small control
 * the seat and settings screens use for a choice among several — gold when it
 * is the current choice, quiet when it is not.
 */

import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';

import { C } from './theme';

export type ButtonVariant = 'primary' | 'secondary' | 'pill';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  selected = false,
  style,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  /** `pill` only: this is the current choice. */
  readonly selected?: boolean;
  readonly style?: ViewStyle;
}) {
  const isPill = variant === 'pill';
  const filled = isPill ? selected : variant === 'primary';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={isPill ? { disabled, selected } : { disabled }}
      style={[
        styles.base,
        isPill ? styles.pill : styles.full,
        filled ? styles.filled : isPill ? styles.quiet : styles.outlined,
        disabled && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text
        style={[
          isPill ? styles.pillText : styles.text,
          filled ? styles.textOnFill : isPill ? styles.textQuiet : styles.textOutlined,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  full: { borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16 },
  pill: { borderRadius: 999, paddingVertical: 6, paddingHorizontal: 13 },

  filled: { backgroundColor: C.accent, borderWidth: 1, borderColor: C.accent },
  outlined: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.accent },
  quiet: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.edge },
  disabled: { opacity: 0.35 },

  text: { fontWeight: '700', fontSize: 15 },
  pillText: { fontWeight: '600', fontSize: 12 },
  textOnFill: { color: C.onAccent },
  textOutlined: { color: C.accent },
  textQuiet: { color: C.textFaint },
});
