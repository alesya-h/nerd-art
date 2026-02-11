// ── Environment detection ────────────────────────────────────────────
const IS_ELECTRON = typeof process !== "undefined" && process.versions && process.versions.electron;
let ipcRenderer, clipboard;
if (IS_ELECTRON) {
  ({ ipcRenderer, clipboard } = require("electron"));
}

const params = new URLSearchParams(location.search);
const IMAGE_PATH = params.get("image") ? decodeURIComponent(params.get("image")) : null;

const GRID_COLS = 4;
const GRID_ROWS = 8;
const MEASURE_SCALE = 8;
const MEASURE_W = GRID_COLS * MEASURE_SCALE;
const MEASURE_H = GRID_ROWS * MEASURE_SCALE;
const MEASURE_FONT = `${MEASURE_H}px "SauceCodePro Nerd Font Mono", monospace`;
const CELL_ASPECT = 0.5;

// ── Glyph catalog — named groups ────────────────────────────────────
// Each group has: id, label, whether it contains ambiguous-width chars,
// whether it's enabled by default, and a function to produce its glyphs.
const GLYPH_GROUPS = [
  {
    id: "blocks", label: "Blocks", ambiguous: false, defaultOn: true,
    glyphs() {
      const g = [" ", "\u2588"]; // space + full block
      for (let i = 0x2581; i <= 0x2587; i++) g.push(String.fromCodePoint(i)); // lower 1/8–7/8
      for (let i = 0x2589; i <= 0x258F; i++) g.push(String.fromCodePoint(i)); // left 7/8–1/8
      g.push("\u2580", "\u2584", "\u258C", "\u2590"); // half blocks
      g.push("\u2594", "\u2595"); // upper/right 1/8
      return g;
    }
  },
  {
    id: "quadrants", label: "Quadrants", ambiguous: false, defaultOn: true,
    glyphs() {
      const g = [];
      for (let i = 0x2596; i <= 0x259F; i++) g.push(String.fromCodePoint(i));
      return g;
    }
  },
  {
    id: "diagonals", label: "Diagonals", ambiguous: false, defaultOn: true,
    glyphs() { return ["\u2571", "\u2572", "\u2573"]; } // ╱╲╳
  },
  {
    id: "braille", label: "Braille", ambiguous: "width",
    note: "Width doesn't mix well with other characters in some environments",
    defaultOn: false,
    glyphs() {
      const g = [];
      for (let i = 0x2800; i <= 0x28FF; i++) g.push(String.fromCodePoint(i));
      return g;
    }
  },
  {
    id: "triangles", label: "Triangles", ambiguous: "width",
    note: "Grossly unsafe width in pre mode",
    defaultOn: false,
    glyphs() { return ["\u25E2", "\u25E3", "\u25E4", "\u25E5"]; } // ◢◣◤◥
  },
  {
    id: "sextants", label: "Sextants", ambiguous: false, defaultOn: true,
    glyphs() {
      const g = [];
      for (let i = 0x1FB00; i <= 0x1FB3B; i++) g.push(String.fromCodePoint(i));
      return g;
    }
  },
  {
    id: "wedges", label: "Wedges", ambiguous: false, defaultOn: true,
    glyphs() {
      const g = [];
      for (let i = 0x1FB3C; i <= 0x1FB6F; i++) g.push(String.fromCodePoint(i));
      return g;
    }
  },
  {
    id: "ascii_punct", label: "ASCII punctuation", ambiguous: false, defaultOn: true,
    glyphs() {
      const g = [];
      for (let i = 0x21; i <= 0x7E; i++) {
        const c = String.fromCharCode(i);
        if (!((i >= 0x41 && i <= 0x5A) || (i >= 0x61 && i <= 0x7A))) g.push(c); // skip letters
      }
      return g;
    }
  },
  {
    id: "ascii_letters", label: "ASCII letters", ambiguous: false, defaultOn: false,
    glyphs() {
      const g = [];
      for (let i = 0x41; i <= 0x5A; i++) g.push(String.fromCharCode(i)); // A-Z
      for (let i = 0x61; i <= 0x7A; i++) g.push(String.fromCharCode(i)); // a-z
      return g;
    }
  },
  {
    id: "geometric", label: "Geometric shapes", ambiguous: "width",
    note: "Grossly unsafe width — many characters render double-wide",
    defaultOn: false,
    glyphs() {
      const g = [];
      for (let i = 0x25A0; i <= 0x25FF; i++) {
        if (i >= 0x25E2 && i <= 0x25E5) continue; // skip — already in Triangles group
        g.push(String.fromCodePoint(i));
      }
      return g;
    }
  },
  {
    id: "legacy_blocks", label: "Legacy block combos", ambiguous: false, defaultOn: true,
    glyphs() {
      const g = [];
      for (let i = 0x1FB70; i <= 0x1FB9F; i++) {
        if (i === 0x1FB93) continue; // unassigned codepoint — renders as missing glyph
        g.push(String.fromCodePoint(i));
      }
      return g;
    }
  },
  {
    id: "shades", label: "Shades ░▒▓", ambiguous: false, defaultOn: false,
    glyphs() { return ["\u2591", "\u2592", "\u2593"]; }
  },
];

function buildGlyphCatalog(enabledGroups) {
  const glyphs = [];
  const seen = new Set();
  for (const group of GLYPH_GROUPS) {
    if (!enabledGroups.has(group.id)) continue;
    for (const g of group.glyphs()) {
      if (!seen.has(g)) { seen.add(g); glyphs.push(g); }
    }
  }
  return glyphs;
}

// ── Glyph measurement ───────────────────────────────────────────────
function measureGlyphs(glyphs) {
  const canvas = document.getElementById("glyphCanvas");
  canvas.width = MEASURE_W;
  canvas.height = MEASURE_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const results = [];
  const samplesPerCell = MEASURE_SCALE * MEASURE_SCALE;

  for (const glyph of glyphs) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, MEASURE_W, MEASURE_H);
    ctx.fillStyle = "#000";
    ctx.font = MEASURE_FONT;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(glyph, 0, Math.round(MEASURE_H * 0.8));

    const pixels = ctx.getImageData(0, 0, MEASURE_W, MEASURE_H).data;
    const grid = new Float32Array(GRID_COLS * GRID_ROWS);
    let totalInk = 0;

    for (let gy = 0; gy < GRID_ROWS; gy++) {
      const y0 = gy * MEASURE_SCALE;
      for (let gx = 0; gx < GRID_COLS; gx++) {
        const x0 = gx * MEASURE_SCALE;
        let sum = 0;
        for (let dy = 0; dy < MEASURE_SCALE; dy++) {
          const rowOff = (y0 + dy) * MEASURE_W;
          for (let dx = 0; dx < MEASURE_SCALE; dx++) {
            const idx = (rowOff + x0 + dx) * 4;
            const lum = (pixels[idx] * 0.299 + pixels[idx+1] * 0.587 + pixels[idx+2] * 0.114) / 255;
            sum += 1 - lum;
          }
        }
        const density = sum / samplesPerCell;
        grid[gy * GRID_COLS + gx] = density;
        totalInk += density;
      }
    }

    const avgDensity = totalInk / (GRID_COLS * GRID_ROWS);
    if (avgDensity < 0.001 && glyph !== " ") continue;
    results.push({ glyph, grid, density: avgDensity });
  }

  return results;
}

// ── Deduplicate ─────────────────────────────────────────────────────
function deduplicateGlyphs(measured) {
  const seen = new Map();
  for (const m of measured) {
    const key = Array.from(m.grid).map(v => v.toFixed(3)).join(",");
    if (!seen.has(key) || m.glyph.length < seen.get(key).glyph.length) {
      seen.set(key, m);
    }
  }
  return Array.from(seen.values());
}

// ── Image → art conversion ──────────────────────────────────────────
function convertImage(imgData, imgW, imgH, measuredGlyphs, outputCols, outputRows, contrast, dither) {
  const totalGridW = outputCols * GRID_COLS;
  const totalGridH = outputRows * GRID_ROWS;
  const lumGrid = new Float32Array(totalGridW * totalGridH);

  for (let y = 0; y < totalGridH; y++) {
    for (let x = 0; x < totalGridW; x++) {
      const srcX = (x / totalGridW) * imgW;
      const srcY = (y / totalGridH) * imgH;
      const sx = Math.min(Math.floor(srcX), imgW - 1);
      const sy = Math.min(Math.floor(srcY), imgH - 1);
      const idx = (sy * imgW + sx) * 4;
      const lum = (imgData[idx] * 0.299 + imgData[idx+1] * 0.587 + imgData[idx+2] * 0.114) / 255;
      lumGrid[y * totalGridW + x] = 1 - lum;
    }
  }

  if (contrast !== 0) {
    const factor = (1 + contrast) / (1 - Math.min(contrast, 0.99));
    for (let i = 0; i < lumGrid.length; i++) {
      lumGrid[i] = Math.max(0, Math.min(1, factor * (lumGrid[i] - 0.5) + 0.5));
    }
  }

  const gridSize = GRID_COLS * GRID_ROWS;
  const lines = [];

  for (let row = 0; row < outputRows; row++) {
    let line = "";
    for (let col = 0; col < outputCols; col++) {
      const cellGrid = new Float32Array(gridSize);
      for (let gy = 0; gy < GRID_ROWS; gy++) {
        for (let gx = 0; gx < GRID_COLS; gx++) {
          cellGrid[gy * GRID_COLS + gx] = lumGrid[(row * GRID_ROWS + gy) * totalGridW + col * GRID_COLS + gx];
        }
      }

      let bestGlyph = " ";
      let bestError = Infinity;
      for (const mg of measuredGlyphs) {
        let error = 0;
        for (let i = 0; i < gridSize; i++) {
          const diff = cellGrid[i] - mg.grid[i];
          error += diff * diff;
        }
        error /= gridSize;
        if (error < bestError) {
          bestError = error;
          bestGlyph = mg.glyph;
        }
      }

      line += bestGlyph;

      if (dither) {
        const matched = measuredGlyphs.find(m => m.glyph === bestGlyph);
        if (matched) {
          for (let gy = 0; gy < GRID_ROWS; gy++) {
            for (let gx = 0; gx < GRID_COLS; gx++) {
              const desired = cellGrid[gy * GRID_COLS + gx];
              const actual = matched.grid[gy * GRID_COLS + gx];
              const err = desired - actual;
              const rx = col * GRID_COLS + gx + 1;
              const ry = row * GRID_ROWS + gy;
              if (rx < totalGridW) lumGrid[ry * totalGridW + rx] += err * 7 / 16;
              const blx = col * GRID_COLS + gx - 1;
              const bly = row * GRID_ROWS + gy + 1;
              if (blx >= 0 && bly < totalGridH) lumGrid[bly * totalGridW + blx] += err * 3 / 16;
              const bx = col * GRID_COLS + gx;
              const by = row * GRID_ROWS + gy + 1;
              if (by < totalGridH) lumGrid[by * totalGridW + bx] += err * 5 / 16;
              const brx = col * GRID_COLS + gx + 1;
              const bry = row * GRID_ROWS + gy + 1;
              if (brx < totalGridW && bry < totalGridH) lumGrid[bry * totalGridW + brx] += err * 1 / 16;
            }
          }
        }
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// ── State ───────────────────────────────────────────────────────────
let uniqueGlyphs = null;
let sourceImg = null;
let lastArt = "";
let renderTimer = null;
let remeasureTimer = null;
let enabledGroups = new Set(GLYPH_GROUPS.filter(g => g.defaultOn).map(g => g.id));

const artEl = document.getElementById("art");
const statusEl = document.getElementById("status");
const widthSlider = document.getElementById("widthSlider");
const widthVal = document.getElementById("widthVal");
const contrastSlider = document.getElementById("contrastSlider");
const contrastVal = document.getElementById("contrastVal");
const ditherCheck = document.getElementById("ditherCheck");
const previewMode = document.getElementById("previewMode");
const copyBtn = document.getElementById("copyBtn");
const saveBtn = document.getElementById("saveBtn");
const groupsEl = document.getElementById("groups");

// ── Build group checkboxes ──────────────────────────────────────────
for (const group of GLYPH_GROUPS) {
  const div = document.createElement("div");
  div.className = "group-toggle";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.id = "group_" + group.id;
  cb.checked = group.defaultOn;
  cb.addEventListener("change", () => {
    if (cb.checked) enabledGroups.add(group.id);
    else enabledGroups.delete(group.id);
    scheduleRemeasure();
  });

  const lbl = document.createElement("label");
  lbl.htmlFor = cb.id;
  lbl.textContent = group.label;

  div.appendChild(cb);
  div.appendChild(lbl);

  if (group.ambiguous) {
    const badge = document.createElement("span");
    badge.className = "ambiguous";
    badge.textContent = "(width⚠)";
    badge.title = group.note || "Width issues in some environments";
    div.appendChild(badge);
  }

  groupsEl.appendChild(div);
}

function remeasure() {
  const catalog = buildGlyphCatalog(enabledGroups);
  const measured = measureGlyphs(catalog);
  uniqueGlyphs = deduplicateGlyphs(measured);
  render();
}

function render() {
  if (!uniqueGlyphs || !sourceImg) return;

  const outputCols = parseInt(widthSlider.value);
  const contrast = parseInt(contrastSlider.value) / 100;
  const dither = ditherCheck.checked;
  const mode = previewMode.value;

  const outputRows = Math.round((sourceImg.height / sourceImg.width) * outputCols * CELL_ASPECT);

  const imgCanvas = document.getElementById("imgCanvas");
  const renderW = outputCols * GRID_COLS;
  const renderH = outputRows * GRID_ROWS;
  imgCanvas.width = renderW;
  imgCanvas.height = renderH;
  const ctx = imgCanvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, renderW, renderH);
  ctx.drawImage(sourceImg, 0, 0, renderW, renderH);
  const imgData = ctx.getImageData(0, 0, renderW, renderH).data;

  const t0 = performance.now();
  lastArt = convertImage(imgData, renderW, renderH, uniqueGlyphs, outputCols, outputRows, contrast, dither);
  const elapsed = (performance.now() - t0).toFixed(0);

  if (mode === "pre") {
    artEl.className = "pre-mode";
    artEl.textContent = lastArt;
  } else {
    artEl.className = "";
    const htmlLines = lastArt.split("\n").map(line => {
      const chars = [...line];
      const spans = chars.map(c => `<span>${c === "&" ? "&amp;" : c === "<" ? "&lt;" : c}</span>`).join("");
      return `<div class="art-line">${spans}</div>`;
    });
    artEl.innerHTML = htmlLines.join("");
  }
  statusEl.textContent = `${outputCols}×${outputRows} | ${uniqueGlyphs.length} glyphs | ${elapsed}ms`;
}

function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 50);
}

function scheduleRemeasure() {
  if (remeasureTimer) clearTimeout(remeasureTimer);
  remeasureTimer = setTimeout(remeasure, 100);
}

// ── Controls ────────────────────────────────────────────────────────
widthSlider.addEventListener("input", () => {
  widthVal.textContent = widthSlider.value;
  scheduleRender();
});

contrastSlider.addEventListener("input", () => {
  contrastVal.textContent = (parseInt(contrastSlider.value) / 100).toFixed(2);
  scheduleRender();
});

ditherCheck.addEventListener("change", scheduleRender);
previewMode.addEventListener("change", render); // no re-render needed, just re-display

copyBtn.addEventListener("click", async () => {
  if (IS_ELECTRON) {
    clipboard.writeText(lastArt);
  } else {
    await navigator.clipboard.writeText(lastArt);
  }
  statusEl.textContent = "Copied to clipboard!";
});

saveBtn.addEventListener("click", () => {
  if (IS_ELECTRON) {
    ipcRenderer.send("save-dialog", lastArt);
  } else {
    const blob = new Blob([lastArt], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "art.txt";
    a.click();
    URL.revokeObjectURL(url);
  }
});

// ── Load image ──────────────────────────────────────────────────────
function loadImageFromSrc(src) {
  statusEl.textContent = "Loading image…";
  sourceImg = new Image();
  sourceImg.onload = () => {
    statusEl.textContent = "Ready";
    render();
  };
  sourceImg.onerror = () => {
    statusEl.textContent = "Failed to load image";
  };
  sourceImg.src = src;
}

// Called from file picker in web mode
function loadImageFromFile(file) {
  const url = URL.createObjectURL(file);
  loadImageFromSrc(url);
}

// Expose for the HTML file picker
window.loadImageFromFile = loadImageFromFile;

// ── Init ────────────────────────────────────────────────────────────
function init() {
  statusEl.textContent = "Measuring glyphs…";

  const catalog = buildGlyphCatalog(enabledGroups);
  const measured = measureGlyphs(catalog);
  uniqueGlyphs = deduplicateGlyphs(measured);

  statusEl.textContent = `${uniqueGlyphs.length} glyphs measured.`;

  if (IMAGE_PATH) {
    // Electron mode: load from file path
    const prefix = IMAGE_PATH.startsWith("/") ? "file://" : "";
    loadImageFromSrc(prefix + IMAGE_PATH);
  } else {
    statusEl.textContent = `${uniqueGlyphs.length} glyphs measured. Drop an image or use the file picker.`;
  }
}

init();
