const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const imagePath = args[0];
if (!imagePath) {
  console.error("Usage: electron main.js <image-path> [width]");
  process.exit(1);
}

const targetWidth = parseInt(args[1]) || 80;
const dither = !process.argv.includes("--no-dither");
const contrastArg = process.argv.find(a => a.startsWith("--contrast="));
const contrast = contrastArg ? parseFloat(contrastArg.split("=")[1]) : 0;
const absPath = path.resolve(imagePath);

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
    app.exit(0);
  });

  ipcMain.on("error", (_e, msg) => {
    console.error("[nerd-art] Error:", msg);
    app.exit(1);
  });

  const htmlPath = path.join(__dirname, "renderer.html");
  const query = `?cols=${targetWidth}&dither=${dither}&contrast=${contrast}&image=${encodeURIComponent(absPath)}`;
  win.loadFile(htmlPath, { search: query });
});
