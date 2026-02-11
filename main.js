const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const imagePath = args[0];
if (!imagePath) {
  console.error("Usage: electron main.js <image-path> [width]");
  process.exit(1);
}

const targetWidth = parseInt(args[1]) || 80;
const absPath = path.resolve(imagePath);

const htmlContent = `<!DOCTYPE html>
<html>
<head><style>
  * { margin: 0; padding: 0; }
  body { background: #000; }
</style></head>
<body>
<canvas id="glyphCanvas"></canvas>
<canvas id="imgCanvas"></canvas>
<script>
const { ipcRenderer } = require("electron");

// ── Glyph catalog ──────────────────────────────────────────────────
// Every candidate character (or character + combining marks) that we
// will measure for its actual ink pattern.

function buildGlyphCatalog() {
  const glyphs = [];

  // Space (empty)
  glyphs.push(" ");

  // ASCII density ramp (selected chars with distinct densities)
  for (const ch of ".\`·:;!|/\\\\(){}i1tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*WM&8B#@%$") {
    glyphs.push(ch);
  }

  // Block elements - shade characters
  glyphs.push("\\u2591"); // ░ light shade
  glyphs.push("\\u2592"); // ▒ medium shade
  glyphs.push("\\u2593"); // ▓ dark shade
  glyphs.push("\\u2588"); // █ full block

  // Block elements - vertical fractional blocks (lower N/8)
  for (let i = 0x2581; i <= 0x2587; i++) glyphs.push(String.fromCodePoint(i));

  // Block elements - horizontal fractional blocks (left N/8)
  for (let i = 0x2589; i <= 0x258F; i++) glyphs.push(String.fromCodePoint(i));

  // Half blocks
  glyphs.push("\\u2580"); // ▀ upper half
  glyphs.push("\\u2584"); // ▄ lower half
  glyphs.push("\\u258C"); // ▌ left half
  glyphs.push("\\u2590"); // ▐ right half

  // Upper/right 1/8 blocks
  glyphs.push("\\u2594"); // ▔ upper 1/8
  glyphs.push("\\u2595"); // ▕ right 1/8

  // Quadrant blocks (2x2 sub-cell)
  for (let i = 0x2596; i <= 0x259F; i++) glyphs.push(String.fromCodePoint(i));

  // Box drawing - diagonals
  glyphs.push("\\u2571"); // ╱
  glyphs.push("\\u2572"); // ╲
  glyphs.push("\\u2573"); // ╳

  // Braille patterns (all 256)
  for (let i = 0x2800; i <= 0x28FF; i++) glyphs.push(String.fromCodePoint(i));

  // Geometric shapes useful for density
  glyphs.push("\\u25A0"); // ■ black square
  glyphs.push("\\u25A1"); // □ white square
  glyphs.push("\\u25AA"); // ▪ small black square
  glyphs.push("\\u25CF"); // ● black circle
  glyphs.push("\\u25CB"); // ○ white circle
  glyphs.push("\\u25C6"); // ◆ black diamond
  glyphs.push("\\u25E2"); // ◢ lower right triangle
  glyphs.push("\\u25E3"); // ◣ lower left triangle
  glyphs.push("\\u25E4"); // ◤ upper left triangle
  glyphs.push("\\u25E5"); // ◥ upper right triangle

  // Sextant characters (U+1FB00-U+1FB3B) - 2x3 sub-cell
  for (let i = 0x1FB00; i <= 0x1FB3B; i++) glyphs.push(String.fromCodePoint(i));

  // Legacy computing - diagonal fills/wedges (U+1FB3C-U+1FB6F)
  for (let i = 0x1FB3C; i <= 0x1FB6F; i++) glyphs.push(String.fromCodePoint(i));

  // Combining mark compositions on space
  // These add density at specific vertical positions within the cell
  const COMBINING = {
    overline:     "\\u0305",
    dblOverline:  "\\u033F",
    dotAbove:     "\\u0307",
    diaerAbove:   "\\u0308",
    macronAbove:  "\\u0304",
    stroke:       "\\u0336",
    tildeOverlay: "\\u0334",
    vertOverlay:  "\\u20D2",
    underline:    "\\u0332",
    dblUnderline: "\\u0333",
    dotBelow:     "\\u0323",
    diaerBelow:   "\\u0324",
    macronBelow:  "\\u0331",
  };
  
  const base = " ";
  // Single combiners
  for (const c of Object.values(COMBINING)) {
    glyphs.push(base + c);
  }
  // Paired combiners (above + below)
  const aboveMarks = [COMBINING.dotAbove, COMBINING.diaerAbove, COMBINING.
  erline, COMBINING.macronAbove];
  const belowMarks = [COMBINING.dotBelow, COMBINING.diaerBelow, COMBINING.
  derline, COMBINING.macronBelow];
  for (const a of aboveMarks) {
    for (const b of belowMarks) {
      glyphs.push(base + a + b);
    }
  }
  // Triple combiners (above + overlay + below)
  const overlayMarks = [COMBINING.stroke, COMBINING.tildeOverlay];
  for (const a of aboveMarks) {
    for (const o of overlayMarks) {
      for (const b of belowMarks) {
        glyphs.push(base + a + o + b);
      }
    }
  }
  // Overlay + above/below pairs
  for (const o of overlayMarks) {
    for (const a of aboveMarks) {
      glyphs.push(base + a + o);
    }
    for (const b of belowMarks) {
      glyphs.push(base + o + b);
    }
  }

  return glyphs;
}

// ── Glyph measurement ──────────────────────────────────────────────
// Render each glyph to a canvas and capture its pixel coverage pattern.
// We subdivide each cell into a grid (e.g., 4x8) and record the ink
// density in each sub-region. This is the "fingerprint" of the glyph.

function measureGlyphs(glyphs, font, cellW, cellH, gridCols, gridRows) {
  const canvas = document.getElementById("glyphCanvas");
  canvas.width = cellW;
  canvas.height = cellH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const results = [];
  const subW = cellW / gridCols;
  const subH = cellH / gridRows;

  for (const glyph of glyphs) {
    // Clear to white (background)
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cellW, cellH);

    // Draw glyph in black
    ctx.fillStyle = "#000";
    ctx.font = font;
    ctx.textBaseline = "alphabetic";
    // Position: x=0, y at baseline (~75% down the cell)
    const baseline = Math.round(cellH * 0.8);
    ctx.fillText(glyph, 0, baseline);

    const imageData = ctx.getImageData(0, 0, cellW, cellH);
    const pixels = imageData.data;

    // Compute sub-grid densities (0 = white/empty, 1 = black/full ink)
    const grid = new Float32Array(gridCols * gridRows);
    let totalInk = 0;

    for (let gy = 0; gy < gridRows; gy++) {
      for (let gx = 0; gx < gridCols; gx++) {
        const x0 = Math.round(gx * subW);
        const y0 = Math.round(gy * subH);
        const x1 = Math.round((gx + 1) * subW);
        const y1 = Math.round((gy + 1) * subH);
        let sum = 0;
        let count = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const idx = (y * cellW + x) * 4;
            // Luminance (0=black ink, 1=white empty)
            const lum = (pixels[idx] * 0.299 + pixels[idx+1] * 0.587 + pixels[idx+2] * 0.114) / 255;
            sum += (1 - lum); // invert: 1=ink, 0=empty
            count++;
          }
        }
        const density = count > 0 ? sum / count : 0;
        grid[gy * gridCols + gx] = density;
        totalInk += density;
      }
    }

    const avgDensity = totalInk / (gridCols * gridRows);

    // Skip glyphs that are effectively identical to space (no ink rendered)
    // But keep the actual space character
    if (avgDensity < 0.001 && glyph !== " ") continue;

    results.push({ glyph, grid, density: avgDensity });
  }

  return results;
}

// ── Image → art conversion ─────────────────────────────────────────
// For each cell-sized region of the source image, find the glyph whose
// sub-grid pattern best matches the image's luminance pattern.

function convertImage(imgData, imgW, imgH, cellW, cellH, measuredGlyphs, gridCols, gridRows, outputCols, outputRows, dither) {
  // Pre-sample the image into the output grid at sub-cell resolution
  const totalGridW = outputCols * gridCols;
  const totalGridH = outputRows * gridRows;

  // Sample image into a luminance grid at sub-cell resolution
  // Values: 0 = white/bright, 1 = black/dark (ink density space)
  const lumGrid = new Float32Array(totalGridW * totalGridH);

  for (let y = 0; y < totalGridH; y++) {
    for (let x = 0; x < totalGridW; x++) {
      // Map to source image coordinates
      const srcX = (x / totalGridW) * imgW;
      const srcY = (y / totalGridH) * imgH;
      const sx = Math.min(Math.floor(srcX), imgW - 1);
      const sy = Math.min(Math.floor(srcY), imgH - 1);
      const idx = (sy * imgW + sx) * 4;
      const lum = (imgData[idx] * 0.299 + imgData[idx+1] * 0.587 + imgData[idx+2] * 0.114) / 255;
      lumGrid[y * totalGridW + x] = 1 - lum; // invert: 1=dark, 0=bright
    }
  }

  const lines = [];

  for (let row = 0; row < outputRows; row++) {
    let line = "";
    for (let col = 0; col < outputCols; col++) {
      // Extract the sub-grid region for this cell
      const cellGrid = new Float32Array(gridCols * gridRows);
      for (let gy = 0; gy < gridRows; gy++) {
        for (let gx = 0; gx < gridCols; gx++) {
          const x = col * gridCols + gx;
          const y = row * gridRows + gy;
          cellGrid[gy * gridCols + gx] = lumGrid[y * totalGridW + x];
        }
      }

      // Find best matching glyph using weighted spatial + density matching
      let bestGlyph = " ";
      let bestError = Infinity;

      for (const mg of measuredGlyphs) {
        let error = 0;
        for (let i = 0; i < cellGrid.length; i++) {
          const diff = cellGrid[i] - mg.grid[i];
          error += diff * diff;
        }
        // Normalize by grid size
        error /= cellGrid.length;

        if (error < bestError) {
          bestError = error;
          bestGlyph = mg.glyph;
        }
      }

      line += bestGlyph;

      // Floyd-Steinberg dithering: distribute quantization error
      if (dither) {
        // Find the matched glyph's grid to compute error
        const matched = measuredGlyphs.find(m => m.glyph === bestGlyph);
        if (matched) {
          for (let gy = 0; gy < gridRows; gy++) {
            for (let gx = 0; gx < gridCols; gx++) {
              const desired = cellGrid[gy * gridCols + gx];
              const actual = matched.grid[gy * gridCols + gx];
              const err = desired - actual;

              // Distribute error to neighboring sub-pixels
              // Right neighbor (within same cell or next cell)
              const rx = col * gridCols + gx + 1;
              const ry = row * gridRows + gy;
              if (rx < totalGridW) {
                lumGrid[ry * totalGridW + rx] += err * 7 / 16;
              }
              // Below-left
              const blx = col * gridCols + gx - 1;
              const bly = row * gridRows + gy + 1;
              if (blx >= 0 && bly < totalGridH) {
                lumGrid[bly * totalGridW + blx] += err * 3 / 16;
              }
              // Below
              const bx = col * gridCols + gx;
              const by = row * gridRows + gy + 1;
              if (by < totalGridH) {
                lumGrid[by * totalGridW + bx] += err * 5 / 16;
              }
              // Below-right
              const brx = col * gridCols + gx + 1;
              const bry = row * gridRows + gy + 1;
              if (brx < totalGridW && bry < totalGridH) {
                lumGrid[bry * totalGridW + brx] += err * 1 / 16;
              }
            }
          }
        }
      }
    }
    lines.push(line);
  }

  return lines.join("\\n");
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  try {
    const FONT = "16px monospace";
    const CELL_W = 10;  // approximate monospace cell width at 16px
    const CELL_H = 20;  // approximate monospace cell height at 16px
    const GRID_COLS = 4; // sub-cell grid columns
    const GRID_ROWS = 8; // sub-cell grid rows
    const DITHER = ${process.argv.includes("--no-dither") ? "false" : "true"};
    const OUTPUT_COLS = ${targetWidth};

    // Phase 1: Measure all candidate glyphs
    const catalog = buildGlyphCatalog();
    const measured = measureGlyphs(catalog, FONT, CELL_W, CELL_H, GRID_COLS, GRID_ROWS);

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
      const aspect = CELL_W / CELL_H; // terminal char aspect ratio
      const outputRows = Math.round((img.height / img.width) * OUTPUT_COLS * aspect);

      // Render image to canvas at the resolution we need
      const imgCanvas = document.getElementById("imgCanvas");
      const renderW = OUTPUT_COLS * GRID_COLS;
      const renderH = outputRows * GRID_ROWS;
      imgCanvas.width = renderW;
      imgCanvas.height = renderH;
      const ctx = imgCanvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, renderW, renderH);
      const imgData = ctx.getImageData(0, 0, renderW, renderH).data;

      const result = convertImage(
        imgData, renderW, renderH,
        CELL_W, CELL_H,
        uniqueGlyphs, GRID_COLS, GRID_ROWS,
        OUTPUT_COLS, outputRows,
        DITHER
      );

      ipcRenderer.send("result", {
        art: result,
        stats: { totalGlyphs: catalog.length, uniqueGlyphs: uniqueGlyphs.length, outputCols: OUTPUT_COLS, outputRows: outputRows }
      });
    };

    img.onerror = () => ipcRenderer.send("error", "Failed to load image");
    img.src = ${JSON.stringify("file://" + absPath)};
  } catch (e) {
    ipcRenderer.send("error", e.message);
  }
}

main();
</script>
</body></html>`;

const tmpHtml = path.join(os.tmpdir(), "nerd-art-" + process.pid + ".html");
fs.writeFileSync(tmpHtml, htmlContent);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  ipcMain.on("result", (_e, data) => {
    process.stdout.write(data.art + "\n");
    process.stderr.write(
      `[nerd-art] ${data.stats.uniqueGlyphs} unique glyphs (from ${data.stats.totalGlyphs} candidates), ` +
      `output: ${data.stats.outputCols}x${data.stats.outputRows}\n`
    );
    cleanup();
  });

  ipcMain.on("error", (_e, msg) => {
    console.error("[nerd-art] Error:", msg);
    cleanup(1);
  });

  function cleanup(code = 0) {
    try { fs.unlinkSync(tmpHtml); } catch {}
    app.exit(code);
  }

  win.loadFile(tmpHtml);
});
