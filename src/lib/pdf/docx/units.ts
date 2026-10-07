/**
 * The measuring frame lays everything out at SCALE times its real size, so the
 * browser's rounding of character widths (to 1/64 of a pixel) stays far below
 * anything that could move a line break. Measurements are scaled back.
 */
export const SCALE = 4;
/** A length in points, as CSS at the frame's scale. */
export const pt = (n: number) => `${Math.round(n * SCALE * 1000) / 1000}pt`;
/** Points per CSS pixel in the frame. */
export const PX = 0.75 / SCALE;
