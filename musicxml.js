/**
 * Slim MusicXML score-partwise loader/walker for simple Yeeps songs.
 */

import {
  DEFAULT_GRID_ID,
  GRIDS,
  getGrid,
  snapYeepsTempo,
} from "./tempos.js";

/** Onset must land within this fraction of a grid slot. */
const GRID_EPS = 1e-6;

/**
 * @param {string} xmlText
 * @returns {Document}
 */
export function parseXmlDocument(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) {
    throw new Error("Invalid XML: " + (err.textContent || "parse error").trim());
  }
  return doc;
}

/**
 * @param {string | Document} xmlTextOrDoc
 * @returns {Document}
 */
function asDocument(xmlTextOrDoc) {
  return typeof xmlTextOrDoc === "string"
    ? parseXmlDocument(xmlTextOrDoc)
    : xmlTextOrDoc;
}

/**
 * @param {Document} doc
 * @returns {Element}
 */
function scorePartwise(doc) {
  const score = doc.querySelector("score-partwise");
  if (!score) {
    throw new Error("Only score-partwise MusicXML is supported");
  }
  return score;
}

/**
 * @param {File|Blob|ArrayBuffer} fileOrBuffer
 * @param {string} [fileName]
 * @returns {Promise<string>}
 */
export async function loadMusicXmlText(fileOrBuffer, fileName = "") {
  const name = (
    fileName || (fileOrBuffer instanceof File ? fileOrBuffer.name : "")
  ).toLowerCase();
  const buffer =
    fileOrBuffer instanceof ArrayBuffer
      ? fileOrBuffer
      : await fileOrBuffer.arrayBuffer();
  if (name.endsWith(".mxl") || looksLikeZip(buffer)) {
    return unzipMxl(buffer);
  }
  return new TextDecoder("utf-8").decode(buffer);
}

/**
 * @param {ArrayBuffer} buffer
 */
function looksLikeZip(buffer) {
  if (buffer.byteLength < 4) return false;
  const u8 = new Uint8Array(buffer);
  return u8[0] === 0x50 && u8[1] === 0x4b;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
async function unzipMxl(buffer) {
  if (typeof JSZip === "undefined") {
    throw new Error("JSZip is required to read .mxl files");
  }
  const zip = await JSZip.loadAsync(buffer);
  const containerFile = zip.file("META-INF/container.xml");
  if (containerFile) {
    const containerXml = await containerFile.async("string");
    const containerDoc = parseXmlDocument(containerXml);
    const rootFile = containerDoc.querySelector("rootfile");
    const fullPath = rootFile?.getAttribute("full-path");
    if (fullPath) {
      const scoreFile = zip.file(fullPath);
      if (scoreFile) {
        return scoreFile.async("string");
      }
    }
  }

  const names = Object.keys(zip.files).filter(
    (n) =>
      !zip.files[n].dir &&
      (n.toLowerCase().endsWith(".xml") ||
        n.toLowerCase().endsWith(".musicxml")) &&
      !n.toLowerCase().includes("meta-inf"),
  );
  if (!names.length) {
    throw new Error("No MusicXML score found inside .mxl");
  }
  names.sort((a, b) => a.length - b.length);
  return zip.file(names[0]).async("string");
}

/**
 * @param {number} alter
 * @returns {string}
 */
function alterToAccidental(alter) {
  if (!alter) return "";
  if (alter > 0) return "#".repeat(alter);
  return "-".repeat(-alter);
}

/**
 * @param {Element} pitchEl
 * @returns {string}
 */
export function pitchElementToName(pitchEl) {
  const step = pitchEl.querySelector("step")?.textContent?.trim() || "";
  const octave = pitchEl.querySelector("octave")?.textContent?.trim() || "";
  const alterText = pitchEl.querySelector("alter")?.textContent?.trim();
  const alter =
    alterText === undefined || alterText === "" ? 0 : Number(alterText);
  if (!step || octave === "") {
    throw new Error("Incomplete pitch element");
  }
  return `${step}${alterToAccidental(alter)}${octave}`;
}

/**
 * music21-compatible beat / bar helpers; gridQl is the timing slot size.
 * @param {number} beats
 * @param {number} beatType
 * @param {number} [gridQl]
 */
export function meterInfo(beats, beatType, gridQl = 0.25) {
  const compound = beatType === 8 && beats % 3 === 0;
  const beatQl = compound ? 1.5 : 4 / beatType;
  const barQl = compound ? (beats / 3) * 1.5 : beats * (4 / beatType);
  const sixteenthQl = gridQl;
  return { beatQl, barQl, sixteenthQl, gridQl };
}

/** MusicXML beat-unit to quarter lengths */
const BEAT_UNIT_QL = {
  maxima: 32,
  longa: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
  "64th": 0.0625,
  "128th": 0.03125,
  "256th": 0.015625,
  "512th": 0.0078125,
  "1024th": 0.00390625,
};

/** Display symbols for common metronome units */
const BEAT_UNIT_SYMBOL = {
  whole: "\u{1D15D}",
  half: "\u{1D15E}",
  quarter: "\u2669",
  eighth: "\u{1D160}",
  "16th": "\u{1D161}",
  "32nd": "\u{1D162}",
};

/**
 * @param {string} unit
 * @param {boolean} dotted
 * @returns {string}
 */
export function beatUnitSymbol(unit, dotted = false) {
  const base = BEAT_UNIT_SYMBOL[unit] || unit;
  return dotted ? `${base}.` : base;
}

/**
 * Convert a metronome marking to quarter-note BPM.
 * @param {string} unit
 * @param {number} bpm
 * @param {boolean} dotted
 * @returns {number | null}
 */
export function metronomeToQuarterBpm(unit, bpm, dotted = false) {
  let ql = BEAT_UNIT_QL[unit];
  if (ql === undefined || !Number.isFinite(bpm) || bpm <= 0) return null;
  if (dotted) ql *= 1.5;
  return bpm * ql;
}

/**
 * @typedef {Object} TempoMark
 * @property {number} measure
 * @property {number} divisionIndex 0-based grid slot where the mark takes effect
 * @property {number} quarterBpm Score tempo in quarter-note BPM
 * @property {number} yeepsTempo Nearest Yeeps tempo
 * @property {{
 *   unit: string,
 *   bpm: number,
 *   dotted: boolean,
 *   symbol: string,
 *   quarterBpm: number,
 * } | null} metronome Printed metronome, or null when the mark is sound tempo only
 */

/**
 * @param {Document|Element} scope
 * @returns {{
 *   unit: string,
 *   bpm: number,
 *   dotted: boolean,
 *   symbol: string,
 *   quarterBpm: number,
 * } | null}
 */
function readMetronome(scope) {
  const metro = scope.querySelector("metronome");
  if (!metro) return null;
  const unit = metro.querySelector("beat-unit")?.textContent?.trim();
  const perMinText = metro.querySelector("per-minute")?.textContent?.trim();
  if (!unit || !perMinText) return null;
  const bpm = Number(perMinText);
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  const dotted = !!metro.querySelector("beat-unit-dot");
  const quarterBpm = metronomeToQuarterBpm(unit, bpm, dotted);
  if (quarterBpm === null) return null;
  return {
    unit,
    bpm,
    dotted,
    symbol: beatUnitSymbol(unit, dotted),
    quarterBpm,
  };
}

/**
 * Direction offset in divisions. Does not move the note cursor.
 * @param {Element} directionEl
 * @returns {number}
 */
function readOffsetDivisions(directionEl) {
  for (const child of directionEl.children) {
    if (!child.tagName || child.tagName.toLowerCase() !== "offset") continue;
    const n = Number(child.textContent?.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Numeric tempo on a direction (metronome, else sound@tempo) or a bare sound.
 * Words-only marks (rit., accel.) return null.
 * @param {Element} el
 * @returns {{
 *   quarterBpm: number,
 *   metronome: TempoMark["metronome"],
 *   offsetDiv: number,
 * } | null}
 */
function readTempoEvent(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "direction") {
    const offsetDiv = readOffsetDivisions(el);
    const metronome = readMetronome(el);
    if (metronome) {
      return { quarterBpm: metronome.quarterBpm, metronome, offsetDiv };
    }
    const soundEl = el.querySelector("sound[tempo]");
    if (!soundEl) return null;
    const t = Number(soundEl.getAttribute("tempo"));
    if (!Number.isFinite(t) || t <= 0) return null;
    return { quarterBpm: t, metronome: null, offsetDiv };
  }
  if (tag === "sound") {
    const t = Number(el.getAttribute("tempo"));
    if (!Number.isFinite(t) || t <= 0) return null;
    return { quarterBpm: t, metronome: null, offsetDiv: 0 };
  }
  return null;
}

/**
 * @param {number} offsetQl
 * @param {number} gridQl
 * @returns {boolean}
 */
function fitsGrid(offsetQl, gridQl) {
  const slots = offsetQl / gridQl;
  return Math.abs(slots - Math.round(slots)) < GRID_EPS;
}

/**
 * Collect absolute-in-measure onset offsets (QL) across all parts.
 * Same note rules as extract: skip grace, skip tie stops, chords share onset.
 * @param {string | Document} xmlTextOrDoc
 * @returns {number[]}
 */
function collectOnsetOffsetQls(xmlTextOrDoc) {
  const score = scorePartwise(asDocument(xmlTextOrDoc));
  const parts = score.querySelectorAll("part");
  /** @type {number[]} */
  const offsets = [];

  for (const part of parts) {
    const measureEls = [...part.children].filter(
      (el) => el.tagName && el.tagName.toLowerCase() === "measure",
    );
    if (!measureEls.length) continue;

    let divisions = 1;
    let beats = 4;
    let beatType = 4;
    const firstMeasureNumber = Number(
      measureEls[0].getAttribute("number") || "1",
    );

    for (const measureEl of measureEls) {
      const measureNumber = Number(measureEl.getAttribute("number") || "0");
      let cursor = 0;
      let maxCursor = 0;
      let lastNoteOnset = 0;
      /** @type {number[]} */
      const onsetDivs = [];

      for (const child of measureEl.children) {
        const tag = child.tagName.toLowerCase();

        if (tag === "attributes") {
          const divEl = child.querySelector("divisions");
          if (divEl?.textContent) {
            divisions = Number(divEl.textContent.trim()) || divisions;
          }
          const timeEl = child.querySelector("time");
          if (timeEl) {
            const b = timeEl.querySelector("beats")?.textContent;
            const bt = timeEl.querySelector("beat-type")?.textContent;
            if (b) beats = Number(b.trim()) || beats;
            if (bt) beatType = Number(bt.trim()) || beatType;
          }
          continue;
        }

        if (tag === "backup") {
          const d = Number(child.querySelector("duration")?.textContent || "0");
          cursor = Math.max(0, cursor - d);
          continue;
        }

        if (tag === "forward") {
          const d = Number(child.querySelector("duration")?.textContent || "0");
          cursor += d;
          maxCursor = Math.max(maxCursor, cursor);
          continue;
        }

        if (tag !== "note") continue;
        if (child.querySelector("grace")) continue;

        const isChord = !!child.querySelector("chord");
        const duration = Number(
          child.querySelector("duration")?.textContent || "0",
        );
        const isRest = !!child.querySelector("rest");
        const ties = [...child.querySelectorAll("tie")];
        const isTieContinuation = ties.some(
          (t) => t.getAttribute("type") === "stop",
        );

        if (isChord) {
          if (!isRest && !isTieContinuation && child.querySelector("pitch")) {
            onsetDivs.push(lastNoteOnset);
          }
          continue;
        }

        lastNoteOnset = cursor;
        if (!isRest && !isTieContinuation && child.querySelector("pitch")) {
          onsetDivs.push(cursor);
        }
        cursor += duration;
        maxCursor = Math.max(maxCursor, cursor);
      }

      const { barQl } = meterInfo(beats, beatType);
      const measureDurationQl = maxCursor / divisions;
      let offsetAdjustment = 0;
      if (
        measureNumber === firstMeasureNumber &&
        measureDurationQl < barQl - 1e-9
      ) {
        offsetAdjustment = barQl - measureDurationQl;
      }

      for (const div of onsetDivs) {
        offsets.push(div / divisions + offsetAdjustment);
      }
    }
  }

  return offsets;
}

/**
 * Coarsest grid among 8th through 64th that places every onset on an integer slot.
 * @param {string | Document} xmlTextOrDoc
 * @returns {{
 *   neededGrid: import("./tempos.js").GridId | null,
 *   gridReason: string | null,
 * }}
 */
export function detectNeededGrid(xmlTextOrDoc) {
  const offsets = collectOnsetOffsetQls(xmlTextOrDoc);
  if (!offsets.length) {
    return { neededGrid: DEFAULT_GRID_ID, gridReason: null };
  }

  for (const grid of GRIDS) {
    if (offsets.every((ql) => fitsGrid(ql, grid.ql))) {
      return { neededGrid: grid.id, gridReason: null };
    }
  }

  return {
    neededGrid: null,
    gridReason:
      "Some onsets fall off the 64th grid (tuplets or finer rhythms). Simplify the score first.",
  };
}

/**
 * Whether every onset fits the given grid.
 * @param {string | Document} xmlTextOrDoc
 * @param {string} gridId
 * @returns {boolean}
 */
export function onsetsFitGrid(xmlTextOrDoc, gridId) {
  const { ql } = getGrid(gridId);
  const offsets = collectOnsetOffsetQls(xmlTextOrDoc);
  return offsets.every((o) => fitsGrid(o, ql));
}

/**
 * Light peek: meters + tempo markings + needed grid.
 * @param {string | Document} xmlTextOrDoc
 * @param {{ gridId?: string }} [options]
 * @returns {{
 *   beats: number,
 *   beatType: number,
 *   numDivisions: number,
 *   meters: { beats: number, beatType: number, numDivisions: number }[],
 *   metronome: { unit: string, bpm: number, dotted: boolean, symbol: string, quarterBpm: number } | null,
 *   scoreTempo: number | null,
 *   suggestedTempo: number | null,
 *   tempoMarks: TempoMark[],
 *   neededGrid: import("./tempos.js").GridId | null,
 *   gridReason: string | null,
 * }}
 */
export function peekScoreSettings(xmlTextOrDoc, options = {}) {
  const doc = asDocument(xmlTextOrDoc);
  const score = scorePartwise(doc);
  const { neededGrid, gridReason } = detectNeededGrid(doc);
  const gridId = options.gridId || neededGrid || DEFAULT_GRID_ID;
  const { ql: gridQl } = getGrid(gridId);

  /** @type {{ beats: number, beatType: number, numDivisions: number }[]} */
  const meters = [];
  let beats = 4;
  let beatType = 4;

  const part = score.querySelector("part");
  if (part) {
    for (const measureEl of part.children) {
      if (!measureEl.tagName || measureEl.tagName.toLowerCase() !== "measure") {
        continue;
      }
      for (const child of measureEl.children) {
        if (!child.tagName || child.tagName.toLowerCase() !== "attributes") {
          continue;
        }
        const timeEl = child.querySelector("time");
        if (!timeEl) continue;
        const b = timeEl.querySelector("beats")?.textContent;
        const bt = timeEl.querySelector("beat-type")?.textContent;
        if (b) beats = Number(b.trim()) || beats;
        if (bt) beatType = Number(bt.trim()) || beatType;
        const { barQl } = meterInfo(beats, beatType, gridQl);
        const numDivisions = Math.max(1, Math.round(barQl / gridQl));
        const last = meters[meters.length - 1];
        if (!last || last.beats !== beats || last.beatType !== beatType) {
          meters.push({ beats, beatType, numDivisions });
        }
      }
    }
  }

  if (!meters.length) {
    const { barQl } = meterInfo(4, 4, gridQl);
    meters.push({
      beats: 4,
      beatType: 4,
      numDivisions: Math.max(1, Math.round(barQl / gridQl)),
    });
  }

  /** @type {TempoMark[]} */
  let tempoMarks = [];
  if (score.querySelector("part")) {
    tempoMarks = extractPitchesByMeasureAndDivision(doc, { gridId }).tempoMarks;
  }
  const earliest = tempoMarks[0] ?? null;
  const metronome = earliest?.metronome ?? null;
  const scoreTempo = earliest ? earliest.quarterBpm : null;
  const snapGrid = neededGrid || DEFAULT_GRID_ID;
  const suggestedTempo = earliest
    ? snapYeepsTempo(earliest.quarterBpm, snapGrid)
    : null;

  const first = meters[0];
  return {
    beats: first.beats,
    beatType: first.beatType,
    numDivisions: first.numDivisions,
    meters,
    metronome,
    scoreTempo,
    suggestedTempo,
    tempoMarks,
    neededGrid,
    gridReason,
  };
}

/**
 * @param {string | Document} xmlTextOrDoc
 * @param {{ gridId?: string }} [options]
 * @returns {{
 *   measuresData: Record<number, Record<number, string[]>>,
 *   measureDivisions: Record<number, number>,
 *   tempoMarks: TempoMark[],
 * }}
 */
export function extractPitchesByMeasureAndDivision(xmlTextOrDoc, options = {}) {
  const gridId = options.gridId || DEFAULT_GRID_ID;
  const { ql: gridQl } = getGrid(gridId);
  const score = scorePartwise(asDocument(xmlTextOrDoc));
  /** @type {Record<number, Record<number, string[]>>} */
  const measuresData = {};
  /** @type {Record<number, number>} */
  const measureDivisions = {};
  /**
   * One mark per measure + grid slot. Same part: last mark in that slot wins.
   * A later part does not replace a mark the first part already placed there.
   * @type {Map<string, TempoMark & { partIndex: number }>}
   */
  const marksBySlot = new Map();
  const parts = score.querySelectorAll("part");
  if (!parts.length) {
    throw new Error("No parts found in score");
  }

  /**
   * @param {number} partIndex
   * @param {number} measure
   * @param {number} divisionIndex
   * @param {number} quarterBpm
   * @param {TempoMark["metronome"]} metronome
   */
  const putTempoMark = (partIndex, measure, divisionIndex, quarterBpm, metronome) => {
    if (!Number.isFinite(divisionIndex)) return;
    const key = `${measure}:${divisionIndex}`;
    const existing = marksBySlot.get(key);
    if (existing && existing.partIndex < partIndex) return;
    marksBySlot.set(key, {
      partIndex,
      measure,
      divisionIndex,
      quarterBpm,
      yeepsTempo: snapYeepsTempo(quarterBpm, gridId),
      metronome,
    });
  };

  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex];
    const measureEls = [...part.children].filter(
      (el) => el.tagName && el.tagName.toLowerCase() === "measure",
    );
    if (!measureEls.length) continue;

    let divisions = 1;
    let beats = 4;
    let beatType = 4;
    const firstMeasureNumber = Number(
      measureEls[0].getAttribute("number") || "1",
    );

    for (const measureEl of measureEls) {
      const measureNumber = Number(measureEl.getAttribute("number") || "0");
      if (!measuresData[measureNumber]) {
        measuresData[measureNumber] = {};
      }

      let cursor = 0;
      let maxCursor = 0;
      let lastNoteOnset = 0;
      /** @type {{ offsetDiv: number, pitch: string }[]} */
      const events = [];
      /** @type {{ offsetDiv: number, quarterBpm: number, metronome: TempoMark["metronome"] }[]} */
      const pendingTempos = [];

      for (const child of measureEl.children) {
        const tag = child.tagName.toLowerCase();
        if (tag === "direction" || tag === "sound") {
          const tempoEv = readTempoEvent(child);
          if (tempoEv) {
            pendingTempos.push({
              offsetDiv: cursor + tempoEv.offsetDiv,
              quarterBpm: tempoEv.quarterBpm,
              metronome: tempoEv.metronome,
            });
          }
          continue;
        }

        if (tag === "attributes") {
          const divEl = child.querySelector("divisions");
          if (divEl?.textContent) {
            divisions = Number(divEl.textContent.trim()) || divisions;
          }
          const timeEl = child.querySelector("time");
          if (timeEl) {
            const b = timeEl.querySelector("beats")?.textContent;
            const bt = timeEl.querySelector("beat-type")?.textContent;
            if (b) beats = Number(b.trim()) || beats;
            if (bt) beatType = Number(bt.trim()) || beatType;
          }
          continue;
        }

        if (tag === "backup") {
          const d = Number(child.querySelector("duration")?.textContent || "0");
          cursor = Math.max(0, cursor - d);
          continue;
        }

        if (tag === "forward") {
          const d = Number(child.querySelector("duration")?.textContent || "0");
          cursor += d;
          maxCursor = Math.max(maxCursor, cursor);
          continue;
        }

        if (tag !== "note") continue;
        if (child.querySelector("grace")) continue;

        const isChord = !!child.querySelector("chord");
        const duration = Number(
          child.querySelector("duration")?.textContent || "0",
        );
        const isRest = !!child.querySelector("rest");
        const ties = [...child.querySelectorAll("tie")];
        const isTieContinuation = ties.some(
          (t) => t.getAttribute("type") === "stop",
        );

        if (isChord) {
          if (!isRest && !isTieContinuation) {
            const pitchEl = child.querySelector("pitch");
            if (pitchEl) {
              events.push({
                offsetDiv: lastNoteOnset,
                pitch: pitchElementToName(pitchEl),
              });
            }
          }
          continue;
        }

        lastNoteOnset = cursor;
        if (!isRest && !isTieContinuation) {
          const pitchEl = child.querySelector("pitch");
          if (pitchEl) {
            events.push({
              offsetDiv: cursor,
              pitch: pitchElementToName(pitchEl),
            });
          }
        }
        cursor += duration;
        maxCursor = Math.max(maxCursor, cursor);
      }

      const { barQl } = meterInfo(beats, beatType, gridQl);
      const slots = Math.max(1, Math.round(barQl / gridQl));
      measureDivisions[measureNumber] = slots;
      const measureDurationQl = maxCursor / divisions;

      let offsetAdjustment = 0;
      if (
        measureNumber === firstMeasureNumber &&
        measureDurationQl < barQl - 1e-9
      ) {
        offsetAdjustment = barQl - measureDurationQl;
      }

      for (const ev of events) {
        const offsetQl = ev.offsetDiv / divisions + offsetAdjustment;
        const divisionIndex = Math.floor(offsetQl / gridQl + 1e-9);
        if (!measuresData[measureNumber][divisionIndex]) {
          measuresData[measureNumber][divisionIndex] = [];
        }
        measuresData[measureNumber][divisionIndex].push(ev.pitch);
      }

      for (const tempoEv of pendingTempos) {
        const divisionIndex = Math.floor(
          (tempoEv.offsetDiv / divisions + offsetAdjustment) / gridQl + 1e-9,
        );
        putTempoMark(
          partIndex,
          measureNumber,
          divisionIndex,
          tempoEv.quarterBpm,
          tempoEv.metronome,
        );
      }
    }
  }

  const tempoMarks = [...marksBySlot.values()]
    .map(({ measure, divisionIndex, quarterBpm, yeepsTempo, metronome }) => ({
      measure,
      divisionIndex,
      quarterBpm,
      yeepsTempo,
      metronome,
    }))
    .sort((a, b) => a.measure - b.measure || a.divisionIndex - b.divisionIndex);

  return { measuresData, measureDivisions, tempoMarks };
}
