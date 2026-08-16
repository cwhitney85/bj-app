/**
 * The palette, in one place.
 *
 * Extracted rather than invented per screen: the shell adds four screens to a
 * codebase that had one, and four independent guesses at "the felt green" is how
 * an app stops reading as one product. These are the values `TableScreen.tsx`
 * already used, named.
 *
 * Not a design system. When the real felt lands (SPEC §9's 2.5D table) it will
 * want gradients, elevation and card art, none of which are colours; this file
 * is the flat ground those sit on.
 */

export const C = {
  /** The felt itself, and the ground for every screen. */
  felt: '#0b3d2e',
  /** A raised surface on the felt: a seat, a panel, a row. */
  panel: '#0e4a37',
  /** The player's own surface, one step brighter than a bot's. */
  panelPlayer: '#12563f',
  /** Recessed: the action bar, the stat strip, the rail. */
  well: '#08281e',
  wellSoft: '#0a2b23',
  /** Hairlines and inactive pill borders. */
  edge: '#2c5f4d',

  /** Chip gold — every primary control and every active state. */
  accent: '#e8c56a',
  /** Text on gold. */
  onAccent: '#1a1a1a',

  /** Body text on the felt. */
  text: '#f2f7f4',
  /** Labels and secondary text. */
  textDim: '#cfe8dc',
  /** Captions, units, inactive pills. */
  textFaint: '#8fbfa8',
  textFaintest: '#7ba894',

  /** Money and verdicts. Never the only signal — always paired with a sign. */
  good: '#6fbf8b',
  bad: '#e08b6f',
} as const;
