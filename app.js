import {
  loadMusicXmlText,
  parseXmlDocument,
  extractPitchesByMeasureAndDivision,
  peekScoreSettings,
} from "./musicxml.js";
import { formatYeepsText } from "./extract.js";
import { TEMPO_PATTERNS } from "./tempos.js";

const form = document.getElementById("form");
const fileInput = document.getElementById("file");
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

/** Populate tempo <select> from TEMPO_PATTERNS (single source of truth). */
for (const { tempo, spacesPerDivision } of TEMPO_PATTERNS) {
  const opt = document.createElement("option");
  opt.value = String(tempo);
  opt.textContent = `${tempo} (${spacesPerDivision} space${
    spacesPerDivision === 1 ? "" : "s"
  })`;
  if (tempo === 60) opt.selected = true;
  tempoSelect.appendChild(opt);
}

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
    const yeeps = `Yeeps ♩=${settings.suggestedTempo}`;
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
  return `${parts.join("; ")}. Use detected ${noun} and auto divisions?`;
}

/**
 * @param {ReturnType<typeof peekScoreSettings>} settings
 */
function applySuggestion(settings) {
  numDivisionsInput.value = "";
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
  const currentTempo = Number(tempoSelect.value);
  const force = numDivisionsInput.value.trim();
  const tempoMatches =
    settings.suggestedTempo === null || settings.suggestedTempo === currentTempo;
  const divisionsAreAuto = force === "";
    const hasLaterMarks = settings.tempoMarks.length > 1;

  if (
    tempoMatches &&
    divisionsAreAuto &&
    settings.meters.length === 1 &&
    !hasLaterMarks
  ) {
    hideSuggestion();
    return;
  }

  pendingSuggestion = settings;
  suggestText.textContent = buildSuggestionMessage(settings);
  suggestEl.hidden = false;
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

  const tempo = Number(tempoSelect.value);
  const everyDivision = everyDivisionInput.checked;

  let forceDivisions;
  try {
    forceDivisions = readForceDivisions();
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
      extractPitchesByMeasureAndDivision(doc);
    lastText = formatYeepsText(measuresData, {
      tempo,
      everyDivision,
      measureDivisions,
      forceDivisions,
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
