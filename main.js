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

const html = `<!DOCTYPE html>
<html><body>
<canvas id="c"></canvas>
<script>
const { ipcRenderer } = require("electron");
const img = new Image();
img.onload = () => {
  const W = ${targetWidth};
  const aspect = 0.5;
  const H = Math.round((img.height / img.width) * W * aspect);
  const c = document.getElementById("c");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  const chars = " .\\\`:,;'!|\\\\/)({}<>i1tfLCJUYXZO0Qoahkbdpqwm*WMB8&%$#@";
  let lines = [];
  for (let y = 0; y < H; y++) {
    let row = "";
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const lum = (data[idx] * 0.299 + data[idx+1] * 0.587 + data[idx+2] * 0.114) / 255;
      row += chars[Math.floor(lum * (chars.length - 1))];
    }
    lines.push(row);
  }
  ipcRenderer.send("result", lines.join("\\n"));
};
img.onerror = (e) => ipcRenderer.send("error", "Failed to load image");
img.src = ${JSON.stringify("file://" + absPath)};
</script>
</body></html>`;

const tmpHtml = path.join(os.tmpdir(), "nerd-art-" + process.pid + ".html");
fs.writeFileSync(tmpHtml, html);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  ipcMain.on("result", (_e, ascii) => {
    process.stdout.write(ascii + "\n");
    cleanup();
  });

  ipcMain.on("error", (_e, msg) => {
    console.error(msg);
    cleanup(1);
  });

  function cleanup(code = 0) {
    try { fs.unlinkSync(tmpHtml); } catch {}
    app.exit(code);
  }

  win.loadFile(tmpHtml);
});
