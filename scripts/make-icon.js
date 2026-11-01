// Desenha o ícone do Piphin Server: icons/server.png (256). Uso: npm run icon (usa o Electron do Piphin Hub).
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL("about:blank");
  const b64 = await win.webContents.executeJavaScript(`(() => {
    const s = 256, c = document.createElement("canvas"); c.width = c.height = s;
    const g = c.getContext("2d");
    g.beginPath(); g.roundRect(8, 8, 240, 240, 56);
    const bg = g.createLinearGradient(0, 0, s, s); bg.addColorStop(0, "#1b1745"); bg.addColorStop(1, "#0b0a12");
    g.fillStyle = bg; g.fill();
    g.lineWidth = 3; g.strokeStyle = "rgba(99,102,241,.65)"; g.stroke();
    const grad = g.createLinearGradient(50, 60, 206, 200); grad.addColorStop(0, "#4f46e5"); grad.addColorStop(.6, "#6366f1"); grad.addColorStop(1, "#a78bfa");
    // três gavetas de servidor
    g.save(); g.shadowColor = "#6366f1"; g.shadowBlur = 18;
    for (const [i, y] of [[0, 56], [1, 108], [2, 160]].map((x) => x)) {
      g.beginPath(); g.roundRect(48, y, 160, 42, 12); g.fillStyle = grad; g.fill();
      g.fillStyle = "rgba(255,255,255,.18)"; for (let k = 0; k < 4; k++) g.fillRect(70 + k * 14, y + 15, 6, 12);
      g.beginPath(); g.arc(184, y + 21, 7, 0, Math.PI * 2); g.fillStyle = i === 1 ? "#facc15" : "#4ade80"; g.fill();
    }
    g.restore();
    return c.toDataURL("image/png").split(",")[1];
  })()`);
  fs.mkdirSync(path.join(__dirname, "..", "icons"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "icons", "server.png"), Buffer.from(b64, "base64"));
  console.log("ícone: icons/server.png");
  app.quit();
});
