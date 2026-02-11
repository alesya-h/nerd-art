// Render art text to PNG using Electron's canvas.
// Usage: electron preview.js <text-file> <output-png> [font-size]

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");

const textFile = process.argv[2];
const outputPng = process.argv[3];
const fontSize = parseInt(process.argv[4]) || 14;

if (!textFile || !outputPng) {
  console.error("Usage: electron preview.js <text-file> <output-png> [font-size]");
  process.exit(1);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 1600,
    height: 1200,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  ipcMain.on("done", () => {
    process.stderr.write(`[preview] Saved to ${outputPng}\n`);
    app.exit(0);
  });

  const htmlPath = path.join(__dirname, "preview.html");
  const absText = path.resolve(textFile);
  const absOut = path.resolve(outputPng);
  const query = `?file=${encodeURIComponent(absText)}&output=${encodeURIComponent(absOut)}&size=${fontSize}`;
  win.loadFile(htmlPath, { search: query });

  setTimeout(() => {
    console.error("[preview] Timeout");
    app.exit(1);
  }, 10000);
});
