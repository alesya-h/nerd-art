const { ipcRenderer } = require("electron");

// Read config from query params (set by main process)
const params = new URLSearchParams(location.search);
const OUTPUT_COLS = parseInt(params.get("cols")) || 80;
const DITHER = params.get("dither") !== "false";
const IMAGE_PATH = decodeURIComponent(params.get("image"));

const GRID_COLS = 4; // sub-cell grid columns
const GRID_ROWS = 8; // sub-cell grid rows

// Measurement resolution: render glyphs at high res so each sub-cell
// averages over MEASURE_SCALE² pixels (all sub-cells equal size).
const MEASURE_SCALE = 8;
const MEASURE_W = GRID_COLS * MEASURE_SCALE; // 32 px
const MEASURE_H = GRID_ROWS * MEASURE_SCALE; // 64 px
const MEASURE_FONT = `${MEASURE_H}px "SauceCodePro Nerd Font Mono", monospace`;

// Terminal cell aspect ratio (width:height).
const CELL_ASPECT = 0.5;

// ── Glyph catalog ──────────────────────────────────────────────────
// Every candidate character that we will measure for its actual ink
// pattern. Only geometric Unicode glyphs — no ASCII letters, no
// shade characters (░▒▓), no combining marks on block bases.

function buildGlyphCatalog() {
  const glyphs = [];

  // Space (empty)
  glyphs.push(" ");

  // Full block only (shades ░▒▓ removed — they create flat gray bands
  // that suppress spatial detail from sextants/braille/wedges)
  glyphs.push("\u2588"); // █ full block

  // Block elements - vertical fractional blocks (lower N/8)
  for (let i = 0x2581; i <= 0x2587; i++) glyphs.push(String.fromCodePoint(i));

  // Block elements - horizontal fractional blocks (left N/8)
  for (let i = 0x2589; i <= 0x258F; i++) glyphs.push(String.fromCodePoint(i));

  // Half blocks
  glyphs.push("\u2580"); // ▀ upper half
  glyphs.push("\u2584"); // ▄ lower half
  glyphs.push("\u258C"); // ▌ left half
  glyphs.push("\u2590"); // ▐ right half

  // Upper/right 1/8 blocks
  glyphs.push("\u2594"); // ▔ upper 1/8
  glyphs.push("\u2595"); // ▕ right 1/8

  // Quadrant blocks (2x2 sub-cell)
  for (let i = 0x2596; i <= 0x259F; i++) glyphs.push(String.fromCodePoint(i));

  // Box drawing - diagonals
  glyphs.push("\u2571"); // ╱
  glyphs.push("\u2572"); // ╲
  glyphs.push("\u2573"); // ╳

  // Braille patterns (all 256)
  for (let i = 0x2800; i <= 0x28FF; i++) glyphs.push(String.fromCodePoint(i));

  // Geometric shapes - triangles for diagonal edges
  glyphs.push("\u25E2"); // ◢ lower right triangle
  glyphs.push("\u25E3"); // ◣ lower left triangle
  glyphs.push("\u25E4"); // ◤ upper left triangle
  glyphs.push("\u25E5"); // ◥ upper right triangle

  // Sextant characters (U+1FB00-U+1FB3B) - 2x3 sub-cell
  for (let i = 0x1FB00; i <= 0x1FB3B; i++) glyphs.push(String.fromCodePoint(i));

  // Legacy computing - diagonal fills/wedges (U+1FB3C-U+1FB6F)
  for (let i = 0x1FB3C; i <= 0x1FB6F; i++) glyphs.push(String.fromCodePoint(i));

  return glyphs;
}

// ── Glyph measurement ──────────────────────────────────────────────
// Render each glyph to a canvas and capture its pixel coverage pattern.
// We subdivide each cell into a grid (e.g., 4x8) and record the ink
// density in each sub-region. This is the "fingerprint" of the glyph.

function measureGlyphs(glyphs) {
  const canvas = document.getElementById("glyphCanvas");
  canvas.width = MEASURE_W;
  canvas.height = MEASURE_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const results = [];
  const samplesPerCell = MEASURE_SCALE * MEASURE_SCALE;

  for (const glyph of glyphs) {
    // Clear to white (background)
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, MEASURE_W, MEASURE_H);

    // Draw glyph in black at high resolution
    ctx.fillStyle = "#000";
    ctx.font = MEASURE_FONT;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(glyph, 0, Math.round(MEASURE_H * 0.8));

    const imageData = ctx.getImageData(0, 0, MEASURE_W, MEASURE_H);
    const pixels = imageData.data;

    // Average pixel ink within each sub-cell.
    // Sub-cell (gx, gy) spans exactly MEASURE_SCALE × MEASURE_SCALE pixels,
    // so every sub-cell averages the same number of samples.
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
            const lum = (pixels[idx] * 0.299 +
                         pixels[idx+1] * 0.587 +
                         pixels[idx+2] * 0.114) / 255;
            sum += 1 - lum; // invert: 1=ink, 0=empty
          }
        }
        const density = sum / samplesPerCell;
        grid[gy * GRID_COLS + gx] = density;
        totalInk += density;
      }
    }

    const avgDensity = totalInk / (GRID_COLS * GRID_ROWS);

    // Skip glyphs with no visible ink (but keep space)
    if (avgDensity < 0.001 && glyph !== " ") continue;

    results.push({ glyph, grid, density: avgDensity });
  }

  return results;
}

// ── Image → art conversion ─────────────────────────────────────────
// For each cell-sized region of the source image, find the glyph whose
// sub-grid pattern best matches the image's luminance pattern.

function convertImage(imgData, imgW, imgH, measuredGlyphs, outputCols, outputRows) {
  const totalGridW = outputCols * GRID_COLS;
  const totalGridH = outputRows * GRID_ROWS;

  // Sample image into a luminance grid at sub-cell resolution
  // Values: 0 = white/bright, 1 = black/dark (ink density space)
  const lumGrid = new Float32Array(totalGridW * totalGridH);

  for (let y = 0; y < totalGridH; y++) {
    for (let x = 0; x < totalGridW; x++) {
      const srcX = (x / totalGridW) * imgW;
      const srcY = (y / totalGridH) * imgH;
      const sx = Math.min(Math.floor(srcX), imgW - 1);
      const sy = Math.min(Math.floor(srcY), imgH - 1);
      const idx = (sy * imgW + sx) * 4;
      const lum = (imgData[idx] * 0.299 + imgData[idx+1] * 0.587 + imgData[idx+2] * 0.114) / 255;
      lumGrid[y * totalGridW + x] = 1 - lum; // invert: 1=dark, 0=bright
    }
  }

  const gridSize = GRID_COLS * GRID_ROWS;
  const lines = [];

  for (let row = 0; row < outputRows; row++) {
    let line = "";
    for (let col = 0; col < outputCols; col++) {
      // Extract the sub-grid region for this cell
      const cellGrid = new Float32Array(gridSize);
      for (let gy = 0; gy < GRID_ROWS; gy++) {
        for (let gx = 0; gx < GRID_COLS; gx++) {
          const x = col * GRID_COLS + gx;
          const y = row * GRID_ROWS + gy;
          cellGrid[gy * GRID_COLS + gx] = lumGrid[y * totalGridW + x];
        }
      }

      // Find best matching glyph (minimum MSE across sub-grid)
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

      // Floyd-Steinberg dithering: distribute quantization error
      if (DITHER) {
        const matched = measuredGlyphs.find(m => m.glyph === bestGlyph);
        if (matched) {
          for (let gy = 0; gy < GRID_ROWS; gy++) {
            for (let gx = 0; gx < GRID_COLS; gx++) {
              const desired = cellGrid[gy * GRID_COLS + gx];
              const actual = matched.grid[gy * GRID_COLS + gx];
              const err = desired - actual;

              const rx = col * GRID_COLS + gx + 1;
              const ry = row * GRID_ROWS + gy;
              if (rx < totalGridW)
                lumGrid[ry * totalGridW + rx] += err * 7 / 16;

              const blx = col * GRID_COLS + gx - 1;
              const bly = row * GRID_ROWS + gy + 1;
              if (blx >= 0 && bly < totalGridH)
                lumGrid[bly * totalGridW + blx] += err * 3 / 16;

              const bx = col * GRID_COLS + gx;
              const by = row * GRID_ROWS + gy + 1;
              if (by < totalGridH)
                lumGrid[by * totalGridW + bx] += err * 5 / 16;

              const brx = col * GRID_COLS + gx + 1;
              const bry = row * GRID_ROWS + gy + 1;
              if (brx < totalGridW && bry < totalGridH)
                lumGrid[bry * totalGridW + brx] += err * 1 / 16;
            }
          }
        }
      }
    }
    lines.push(line);
  }

  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  try {
    // Phase 1: Measure all candidate glyphs
    const catalog = buildGlyphCatalog();
    const measured = measureGlyphs(catalog);

    // Deduplicate glyphs with identical patterns (keep shortest string)
    const seen = new Map();
    for (const m of measured) {
      const key = Array.from(m.grid).map(v => v.toFixed(3)).join(",");
      if (!seen.has(key) || m.glyph.length < seen.get(key).glyph.length) {
        seen.set(key, m);
      }
    }
    const uniqueGlyphs = Array.from(seen.values());

    // Phase 2: Load and convert the image
    const img = new Image();
    img.onload = () => {
      const outputRows = Math.round((img.height / img.width) * OUTPUT_COLS * CELL_ASPECT);

      const imgCanvas = document.getElementById("imgCanvas");
      const renderW = OUTPUT_COLS * GRID_COLS;
      const renderH = outputRows * GRID_ROWS;
      imgCanvas.width = renderW;
      imgCanvas.height = renderH;
      const ctx = imgCanvas.getContext("2d", { willReadFrequently: true });
      // Fill with white first so transparent pixels = white = empty (no ink)
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, renderW, renderH);
      ctx.drawImage(img, 0, 0, renderW, renderH);
      const imgData = ctx.getImageData(0, 0, renderW, renderH).data;

      const result = convertImage(imgData, renderW, renderH, uniqueGlyphs, OUTPUT_COLS, outputRows);

      ipcRenderer.send("result", {
        art: result,
        stats: { totalGlyphs: catalog.length, uniqueGlyphs: uniqueGlyphs.length, outputCols: OUTPUT_COLS, outputRows: outputRows }
      });
    };

    img.onerror = () => ipcRenderer.send("error", "Failed to load image: " + IMAGE_PATH);
    img.src = "file://" + IMAGE_PATH;
  } catch (e) {
    ipcRenderer.send("error", e.message);
  }
}

main();
