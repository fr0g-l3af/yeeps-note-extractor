/**
 * Yeeps timing patterns keyed by quarter-note BPM (♩) and grid resolution.
 * spacesPerDivision = spaces in the Wire/Note loop (including the note wire).
 * every-division spacers are packDelays(spacesPerDivision - 1).join(" + ").
 *
 * Formula: ♩ = round(1200 / (N * S)) where N = notes per quarter, S = spaces 1..9.
 * Max onset rate is 1200/min (1 wire space = 0.05s).
 */

/** @typedef {"8th" | "16th" | "32nd" | "64th"} GridId */

/**
 * @typedef {{ id: GridId, n: number, ql: number, symbol: string, label: string }} GridDef
 */

/** @type {GridDef[]} */
export const GRIDS = [
  { id: "8th", n: 2, ql: 0.5, symbol: "\u{1D160}", label: "8th" },
  { id: "16th", n: 4, ql: 0.25, symbol: "\u{1D161}", label: "16th" },
  { id: "32nd", n: 8, ql: 0.125, symbol: "\u{1D162}", label: "32nd" },
  { id: "64th", n: 16, ql: 0.0625, symbol: "\u{1D163}", label: "64th" },
];

/** Default grid (matches prior fixed-sixteenth behavior). */
export const DEFAULT_GRID_ID = /** @type {GridId} */ ("16th");

/**
 * @param {string} gridId
 * @returns {GridDef}
 */
export function getGrid(gridId) {
  const found = GRIDS.find((g) => g.id === gridId);
  if (!found) {
    throw new Error(
      `Unsupported grid ${gridId}. Use one of: ${GRIDS.map((g) => g.id).join(", ")}`,
    );
  }
  return found;
}

/**
 * Max quarter-note BPM for this grid at 1 space (finest possible).
 * @param {string} gridId
 * @returns {number}
 */
export function maxTempoForGrid(gridId) {
  const { n } = getGrid(gridId);
  return Math.round(1200 / n);
}

/**
 * @param {string} gridId
 * @returns {{ tempo: number, spacesPerDivision: number }[]}
 */
export function patternsForGrid(gridId) {
  const { n } = getGrid(gridId);
  /** @type {{ tempo: number, spacesPerDivision: number }[]} */
  const patterns = [];
  for (let s = 1; s <= 9; s++) {
    patterns.push({
      tempo: Math.round(1200 / (n * s)),
      spacesPerDivision: s,
    });
  }
  return patterns;
}

/** @deprecated Prefer patternsForGrid; kept as 16th-grid alias. */
export const TEMPO_PATTERNS = patternsForGrid(DEFAULT_GRID_ID);

/** @type {number[]} */
export const YEEPS_TEMPOS = TEMPO_PATTERNS.map((p) => p.tempo);

/**
 * @param {number} tempo
 * @param {string} [gridId]
 * @returns {{ tempo: number, spacesPerDivision: number }}
 */
export function getTempoPattern(tempo, gridId = DEFAULT_GRID_ID) {
  const patterns = patternsForGrid(gridId);
  const found = patterns.find((p) => p.tempo === tempo);
  if (!found) {
    throw new Error(
      `Unsupported tempo ${tempo} for ${gridId} grid. Use one of: ${patterns
        .map((p) => p.tempo)
        .join(", ")}`,
    );
  }
  return found;
}

/**
 * Snap a BPM to the nearest Yeeps quarter-note tempo for the grid.
 * @param {number} bpm
 * @param {string} [gridId]
 * @returns {number}
 */
export function snapYeepsTempo(bpm, gridId = DEFAULT_GRID_ID) {
  const tempos = patternsForGrid(gridId).map((p) => p.tempo);
  let best = tempos[0];
  let bestDist = Math.abs(bpm - best);
  for (const t of tempos) {
    const d = Math.abs(bpm - t);
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}
