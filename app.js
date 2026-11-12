import {
  loadMusicXmlText,
  parseXmlDocument,
  extractPitchesByMeasureAndDivision,
  peekScoreSettings,
  onsetsFitGrid,
  detectNeededGrid,
} from "./musicxml.js";
import { formatYeepsText } from "./extract.js";
import {
  DEFAULT_GRID_ID,
  GRIDS,
  getGrid,
  maxTempoForGrid,
  patternsForGrid,
  snapYeepsTempo,
} from "./tempos.js";

const form = document.getElementById("form");
const fileInput = document.getElementById("file");
const gridSelect = document.getElementById("grid");
const tempoSelect = document.getElementById("tempo");
const numDivisionsInput = document.getElementById("numDivisions");
const everyDivisionInput = document.getElementById("everyDivision");
const followTemposInput = document.getElementById("followTempos");
const preview = document.getElementById("preview");
const errorEl = document.getElementById("error");
const downloadBtn = document.getElementById("downloadBtn");
const suggestEl = document.getElementById("suggest");
const suggestText = document.getElementById("suggestText");
const suggestUse = document.getElementById("suggestUse");
const suggestKeep = document.getElementById("suggestKeep");

/** Populate grid <select> from GRIDS. */
for (const grid of GRIDS) {
  const opt = document.createElement("option");
  opt.value = grid.id;
  opt.textContent = `${grid.label} (max ♩=${maxTempoForGrid(grid.id)} at 1 space)`;
  if (grid.id === DEFAULT_GRID_ID) opt.selected = true;
  gridSelect.appendChild(opt);
}

/**
 * Rebuild tempo options for the current grid. Prefer nearest prior ♩.
 * @param {number} [preferTempo]
 */
function rebuildTempoOptions(preferTempo) {
  const gridId = gridSelect.value;
  const patterns = patternsForGrid(gridId);
  const previous = preferTempo ?? Number(tempoSelect.value);
  const target = Number.isFinite(previous)
    ? snapYeepsTempo(previous, gridId)
    : snapYeepsTempo(60, gridId);

  tempoSelect.innerHTML = "";
  for (const { tempo, spacesPerDivision } of patterns) {
    const opt = document.createElement("option");
    opt.value = String(tempo);
    opt.textContent = `${tempo} (${spacesPerDivision} space${
      spacesPerDivision === 1 ? "" : "s"
    })`;
    if (tempo === target) opt.selected = true;
    tempoSelect.appendChild(opt);
  }
}

rebuildTempoOptions(60);

let lastText = "";
let lastBaseName = "yeeps-notes";
/** @type {Document | null} */
let cachedDoc = null;
/** @type {string | null} */
let cachedFileName = null;
/** @type {ReturnType<typeof peekScoreSettings> | null} */
let pendingSuggestion = null;
/** @type {ReturnType<typeof peekScoreSettings> | null} */
let cachedSettings = null;

function syncFollowControl() {
  const markCount = cachedSettings?.tempoMarks?.length ?? 0;
  followTemposInput.disabled = markCount === 0;
  if (markCount === 0) followTemposInput.checked = false;
  followTemposInput.title = markCount
    ? "Use each tempo marking, snapped to the nearest Yeeps tempo"
    : "This score has no numeric tempo marks";
  tempoSelect.disabled = followTemposInput.checked && !followTemposInput.disabled;
}

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
}

function hideSuggestion() {
  suggestEl.hidden = true;
  pendingSuggestion = null;
}

/** @returns {number | null} null = auto from score */
function readForceDivisions() {
  const raw = numDivisionsInput.value.trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("Force divisions must be blank (auto) or a positive number.");
  }
  return n;
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatBpm(n) {
  return String(Math.round(n * 10) / 10);
}

/**
 * @param {ReturnType<typeof peekScoreSettings>["tempoMarks"][number]} mark
 */
function describeMark(mark) {
  const yeeps = `Yeeps ♩=${mark.yeepsTempo}`;
  const where = `m.${mark.measure}`;
  if (mark.metronome) {
    const m = mark.metronome;
    const written = `${m.symbol}=${m.bpm}`;
    const q = Number(formatBpm(m.quarterBpm));
    if (q === mark.yeepsTempo) return `${where} ${written} → ${yeeps}`;
    return `${where} ${written} (♩=${q}) → nearest ${yeeps}`;
  }
  const q = Number(formatBpm(mark.quarterBpm));
  if (q === mark.yeepsTempo) return `${where} ♩=${q} → ${yeeps}`;
  return `${where} ♩=${q} → nearest ${yeeps}`;
}

/**
 * @param {ReturnType<typeof peekScoreSettings>} settings
 */
function buildSuggestionMessage(settings) {
  const meterParts = settings.meters.map(
    (m) => `${m.beats}/${m.beatType}=${m.numDivisions}`,
  );
  const parts = [];

  if (settings.neededGrid) {
    parts.push(`needs ${settings.neededGrid}s`);
  } else if (settings.gridReason) {
    parts.push(settings.gridReason);
  }

  if (settings.meters.length === 1) {
    parts.push(
      `Detected ${meterParts[0]} divisions per measure (auto from score)`,
    );
  } else {
    parts.push(
      `Detected changing meters: ${meterParts.join(", ")} (each measure uses its own length)`,
    );
  }

  if (settings.tempoMarks.length > 1) {
    parts.push(`tempos: ${settings.tempoMarks.map(describeMark).join("; ")}`);
  } else if (settings.suggestedTempo !== null && settings.scoreTempo !== null) {
    const gridLabel = settings.neededGrid || DEFAULT_GRID_ID;
    const pattern = patternsForGrid(gridLabel).find(
      (p) => p.tempo === settings.suggestedTempo,
    );
    const spaces = pattern ? pattern.spacesPerDivision : "?";
    const yeeps = `Yeeps ♩=${settings.suggestedTempo} (${gridLabel} · ${spaces} space${
      spaces === 1 ? "" : "s"
    })`;
    if (settings.metronome) {
      const m = settings.metronome;
      const mark = `${m.symbol}=${m.bpm}`;
      const q = Math.round(m.quarterBpm * 10) / 10;
      if (q === settings.suggestedTempo) {
        parts.push(`score ${mark} → ${yeeps}`);
      } else {
        parts.push(`score ${mark} (♩=${q}) → nearest ${yeeps}`);
      }
    } else if (settings.scoreTempo === settings.suggestedTempo) {
      parts.push(yeeps);
    } else {
      parts.push(`score ♩=${settings.scoreTempo} → nearest ${yeeps}`);
    }
  } else {
    parts.push("no tempo marking found");
  }

  const noun = settings.tempoMarks.length > 1 ? "tempos" : "tempo";
  return `${parts.join("; ")}. Use detected grid, ${noun}, and auto divisions?`;
}

/**
 * @param {ReturnType<typeof peekScoreSettings>} settings
 */
function applySuggestion(settings) {
  numDivisionsInput.value = "";
  if (settings.neededGrid) {
    gridSelect.value = settings.neededGrid;
    rebuildTempoOptions(settings.suggestedTempo ?? undefined);
  } else if (settings.suggestedTempo != null) {
    rebuildTempoOptions(settings.suggestedTempo);
  }
  if (settings.suggestedTempo != null) {
    tempoSelect.value = String(settings.suggestedTempo);
  }
  if (settings.tempoMarks.length > 0) {
    followTemposInput.checked = true;
  }
  syncFollowControl();
}

/**
 * @param {ReturnType<typeof peekScoreSettings>} settings
 */
function showSuggestion(settings) {
  if (settings.gridReason && !settings.neededGrid) {
    showError(settings.gridReason);
  }

  const currentTempo = Number(tempoSelect.value);
  const currentGrid = gridSelect.value;
  const force = numDivisionsInput.value.trim();
  const tempoMatches =
    settings.suggestedTempo === null || settings.suggestedTempo === currentTempo;
  const gridMatches =
    settings.neededGrid === null || settings.neededGrid === currentGrid;
  const divisionsAreAuto = force === "";
  const hasLaterMarks = settings.tempoMarks.length > 1;

  if (
    tempoMatches &&
    gridMatches &&
    divisionsAreAuto &&
    settings.meters.length === 1 &&
    !hasLaterMarks &&
    !settings.gridReason
  ) {
    hideSuggestion();
    return;
  }

  if (!settings.neededGrid && settings.gridReason) {
    hideSuggestion();
    return;
  }

  pendingSuggestion = settings;
  suggestText.textContent = buildSuggestionMessage(settings);
  suggestEl.hidden = false;
}

/**
 * Validate selected grid/tempo against the loaded score. Throws on failure.
 * @param {Document} doc
 * @param {string} gridId
 * @param {boolean} followTempoChanges
 * @param {{ quarterBpm: number }[]} tempoMarks
 */
function assertConvertible(doc, gridId, followTempoChanges, tempoMarks) {
  const { neededGrid, gridReason } = detectNeededGrid(doc);
  if (!neededGrid) {
    throw new Error(
      gridReason ||
        "Score onsets do not fit any supported grid (8th–64th). Simplify the score first.",
    );
  }
  if (!onsetsFitGrid(doc, gridId)) {
    throw new Error(
      `Selected ${gridId} grid cannot place every onset. This score needs the ${neededGrid} grid (or finer).`,
    );
  }
  if (followTempoChanges && tempoMarks.length > 0) {
    const maxQ = maxTempoForGrid(gridId);
    const tooFast = tempoMarks.filter((m) => m.quarterBpm > maxQ);
    if (tooFast.length) {
      const examples = tooFast
        .slice(0, 3)
        .map((m) => `♩=${formatBpm(m.quarterBpm)}`)
        .join(", ");
      throw new Error(
        `Follow-tempo: score tempo ${examples} exceeds max ♩=${maxQ} for the ${gridId} grid (1-space limit). Choose a coarser grid or slow the score.`,
      );
    }
  }
}

/**
 * Load file + parse once + cache Document + settings.
 * @param {File} file
 */
async function loadScore(file) {
  const xmlText = await loadMusicXmlText(file, file.name);
  const doc = parseXmlDocument(xmlText);
  cachedDoc = doc;
  cachedFileName = file.name;
  const settings = peekScoreSettings(doc);
  cachedSettings = settings;
  return { doc, settings };
}

gridSelect.addEventListener("change", () => {
  rebuildTempoOptions();
});

fileInput.addEventListener("change", async () => {
  hideSuggestion();
  showError("");
  cachedDoc = null;
  cachedFileName = null;
  cachedSettings = null;
  followTemposInput.checked = false;
  syncFollowControl();
  downloadBtn.disabled = true;
  lastText = "";

  const file = fileInput.files?.[0];
  if (!file) return;

  try {
    preview.textContent = "Reading score settings…";
    const { settings } = await loadScore(file);
    syncFollowControl();
    showSuggestion(settings);
    preview.textContent = "Output will appear here.";
  } catch (err) {
    console.error(err);
    cachedSettings = null;
    syncFollowControl();
    preview.textContent = "Output will appear here.";
    showError(err?.message || String(err));
  }
});

followTemposInput.addEventListener("change", () => {
  tempoSelect.disabled = followTemposInput.checked && !followTemposInput.disabled;
});

suggestUse.addEventListener("click", () => {
  if (pendingSuggestion) applySuggestion(pendingSuggestion);
  hideSuggestion();
});

suggestKeep.addEventListener("click", () => {
  hideSuggestion();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  downloadBtn.disabled = true;
  showError("");

  const file = fileInput.files?.[0];
  if (!file) {
    showError("Choose a MusicXML or MXL file.");
    return;
  }

  const gridId = gridSelect.value;
  const tempo = Number(tempoSelect.value);
  const everyDivision = everyDivisionInput.checked;

  let forceDivisions;
  try {
    forceDivisions = readForceDivisions();
    getGrid(gridId);
    patternsForGrid(gridId); // validate grid
  } catch (err) {
    showError(err?.message || String(err));
    return;
  }

  try {
    preview.textContent = "Converting…";
    let doc = cachedDoc;
    if (!doc || cachedFileName !== file.name) {
      ({ doc } = await loadScore(file));
      syncFollowControl();
    }
    const { measuresData, measureDivisions, tempoMarks } =
      extractPitchesByMeasureAndDivision(doc, { gridId });
    assertConvertible(doc, gridId, followTemposInput.checked, tempoMarks);
    lastText = formatYeepsText(measuresData, {
      tempo,
      everyDivision,
      measureDivisions,
      forceDivisions,
      gridId,
      followTempoChanges: followTemposInput.checked,
      tempoMarks,
    });
    lastBaseName =
      file.name.replace(/\.(mxl|musicxml|xml)$/i, "") || "yeeps-notes";
    preview.textContent = lastText;
    downloadBtn.disabled = !lastText;
  } catch (err) {
    console.error(err);
    preview.textContent = "Output will appear here.";
    showError(err?.message || String(err));
  }
});

downloadBtn.addEventListener("click", () => {
  if (!lastText) return;
  const blob = new Blob([lastText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${lastBaseName}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});
