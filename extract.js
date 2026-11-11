import { packDelays, paintForPitch } from "./paints.js";
import { getTempoPattern } from "./tempos.js";

/**
 * Format like Python repr of a list of strings.
 * @param {string[]} items
 */
function pyList(items) {
  return `[${items.map((s) => `'${s}'`).join(", ")}]`;
}

/**
 * @param {string} pitch
 * @returns {string}
 */
function paintLabel(pitch) {
  const paint = paintForPitch(pitch);
  if (paint) {
    const display = pitch.replaceAll("-", "♭").replaceAll("#", "♯");
    return `${paint} (${display})`;
  }
  return `No Paint (${pitch})`;
}

/** Musical symbol sixteenth note (matches NoteExtractor.py output). */
const SIXTEENTH = "\u{1D161}";

/**
 * Prefix sums of measure lengths so absoluteOffset is O(1).
 * cumBefore[n] = sixteenths before measure n (sparse object keyed by measure #).
 * @param {Record<number, number>} measureDivisions
 * @param {number | null} forceDivisions
 * @returns {Record<number, number>}
 */
function buildCumBefore(measureDivisions, forceDivisions) {
  const sorted = Object.keys(measureDivisions)
    .map(Number)
    .sort((a, b) => a - b);
  /** @type {Record<number, number>} */
  const cumBefore = {};
  let total = 0;
  for (const n of sorted) {
    cumBefore[n] = total;
    total += forceDivisions ?? measureDivisions[n] ?? 16;
  }
  return cumBefore;
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatBpm(n) {
  return String(Math.round(n * 10) / 10);
}

/**
 * @param {Record<number, Record<number, string[]>>} measuresData
 * @param {{
 *   tempo: number,
 *   everyDivision: boolean,
 *   measureDivisions: Record<number, number>,
 *   forceDivisions: number | null,
 *   followTempoChanges?: boolean,
 *   tempoMarks?: {
 *     measure: number,
 *     divisionIndex: number,
 *     quarterBpm: number,
 *     yeepsTempo: number,
 *   }[],
 * }} options
 * @returns {string}
 */
export function formatYeepsText(measuresData, options) {
  const {
    tempo,
    everyDivision,
    measureDivisions,
    forceDivisions = null,
    followTempoChanges = false,
    tempoMarks = [],
  } = options;
  const useFollow = followTempoChanges && tempoMarks.length > 0;
  const { spacesPerDivision } = getTempoPattern(tempo);
  const everySpacer =
    spacesPerDivision <= 1
      ? ""
      : packDelays(spacesPerDivision - 1).join(" + ");
  const cumBefore = buildCumBefore(measureDivisions, forceDivisions);

  /** @type {string[]} */
  const lines = [];
  let blockCount = 0;
  /** @type {[number, number] | null} */
  let previousDivision = null;

  const measureKeys = Object.keys(measuresData)
    .map(Number)
    .sort((a, b) => a - b);

  /**
   * @param {number} measure
   */
  const slotsFor = (measure) =>
    forceDivisions ?? measureDivisions[measure] ?? 16;

  /**
   * @param {number} measure
   * @param {number} divisionBased
   */
  const absoluteOffset = (measure, divisionBased) =>
    (cumBefore[measure] ?? 0) + divisionBased - 1;

  const sortedMarks = useFollow
    ? tempoMarks
        .map((mark) => {
          const pattern = getTempoPattern(mark.yeepsTempo);
          return {
            abs: absoluteOffset(mark.measure, mark.divisionIndex + 1),
            yeepsTempo: mark.yeepsTempo,
            spacesPerDivision: pattern.spacesPerDivision,
            quarterBpm: mark.quarterBpm,
            measure: mark.measure,
            divisionIndex: mark.divisionIndex,
          };
        })
        .sort((a, b) => a.abs - b.abs)
    : [];

  /**
   * @param {number} abs
   */
  const spacesAt = (abs) => {
    let spd = spacesPerDivision;
    for (const mark of sortedMarks) {
      if (mark.abs <= abs) spd = mark.spacesPerDivision;
      else break;
    }
    return spd;
  };

  /**
   * Latest snapped mark at or before this sixteenth, if follow is on.
   * @param {number} abs
   */
  const markAt = (abs) => {
    /** @type {(typeof sortedMarks)[number] | null} */
    let mark = null;
    for (const candidate of sortedMarks) {
      if (candidate.abs <= abs) mark = candidate;
      else break;
    }
    return mark;
  };

  /** @type {number | null} */
  let previousYeeps = null;

  /**
   * One comment when the Yeeps tempo at this onset differs from the previous onset.
   * @param {number} abs
   * @returns {string | null}
   */
  const tempoChangeComment = (abs) => {
    const mark = markAt(abs);
    const yeeps = mark ? mark.yeepsTempo : tempo;
    if (previousYeeps === null) {
      previousYeeps = yeeps;
      return null;
    }
    if (yeeps === previousYeeps) return null;
    previousYeeps = yeeps;
    if (!mark) return null;
    const spd = mark.spacesPerDivision;
    const beat = mark.divisionIndex + 1;
    const slots = slotsFor(mark.measure);
    const unit = spd === 1 ? "space" : "spaces";
    return `  # tempo change: score ♩=${formatBpm(mark.quarterBpm)} → Yeeps ♩=${yeeps} (${spd} ${unit}) at m.${mark.measure} beat ${beat}/${slots}`;
  };
  
  for (const measure of measureKeys) {
    lines.push(`Measure ${measure}:`);
    const divisions = measuresData[measure];
    const divisionKeys = Object.keys(divisions)
      .map(Number)
      .sort((a, b) => a - b);
    const numDivisions = slotsFor(measure);

    if (everyDivision) {
      for (let i = 0; i < numDivisions; i++) {
        const division = i + 1;
        const pitches = divisions[i] || [];
        const colored = pitches.map(paintLabel);
        let spacerSource = everySpacer;
        if (useFollow) {
          const abs = absoluteOffset(measure, division);
          const comment = tempoChangeComment(abs);
          if (comment) lines.push(comment);
          const spd = spacesAt(abs);
          spacerSource = spd <= 1 ? "" : packDelays(spd - 1).join(" + ");
        }
        const spacer = spacerSource
          ? `\n  ${division}b ${spacerSource}`
          : "";

        if (!pitches.length) {
          lines.push(`  ${division}a AllWire : --No notes--${spacer}`);
        } else {
          lines.push(`  ${division}a AllWire + Note Blocks: ${pyList(colored)}${spacer}`);
        }
        blockCount += 2 + colored.length;
      }
    } else {
      for (const divIndex of divisionKeys) {
        const division = divIndex + 1;
        const pitches = divisions[divIndex] || [];
        const colored = pitches.map(paintLabel);
        /** @type {string[]} */
        let delays = [];
        let spacer = "";

        if (previousDivision === null) {
          previousDivision = [measure, division];
          if (useFollow) {
            const comment = tempoChangeComment(absoluteOffset(measure, division));
            if (comment) lines.push(comment);
          }
        } else {
          const [pM, pD] = previousDivision;
          previousDivision = [measure, division];
          const prevAbs = absoluteOffset(pM, pD);
          const currAbs = absoluteOffset(measure, division);
          const gap = currAbs - prevAbs;
          let spaces;
          if (useFollow) {
            spaces = 0;
            for (let abs = prevAbs + 1; abs <= currAbs; abs++) {
              spaces += spacesAt(abs);
            }
            spaces -= 1;
            const comment = tempoChangeComment(currAbs);
            if (comment) lines.push(comment);
          } else {
            spaces = gap * spacesPerDivision - 1;
          }

          lines.push(`  # spaces: ${spaces}`);
          delays = packDelays(spaces);
          spacer = `  - ${pyList(delays)}\n`;
        }

        lines.push(
          `${spacer}  ${SIXTEENTH} beat ${division}/${numDivisions} AllWire + Note Blocks (${colored.length})`,
        );
        lines.push(`  - ${pyList(colored)}`);
        blockCount += delays.length + colored.length + 1;
      }
    }
  }

  lines.push("");
  lines.push(`Total blocks: ${blockCount}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}
