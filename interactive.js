// Interactive mode: opens a window with live controls.
// Usage: electron interactive.js <image-path>

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

app.commandLine.appendSwitch("no-sandbox");

const imagePath = process.argv[2];
if (!imagePath) {
  console.error("Usage: electron interactive.js <image-path>");
  process.exit(1);
}
const absPath = path.resolve(imagePath);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "nerd-art",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  // Handle save dialog request from renderer
  ipcMain.on("save-dialog", async (_e, artText) => {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: "art.txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, artText, "utf-8");
      win.webContents.send("saved", result.filePath);
    }
  });

  const htmlPath = path.join(__dirname, "interactive.html");
  const query = `?image=${encodeURIComponent(absPath)}`;
  win.loadFile(htmlPath, { search: query });
});
