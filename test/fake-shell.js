// O bash dos testes: mostra um prompt, ecoa o que recebe e entende alguns comandos. O tamanho vem como \u0001resize.
"use strict";
let size = process.argv.slice(2).join("x");
const prompt = () => process.stdout.write("\x1b[1;32mroot@ubuntu-teste\x1b[0m:~# ");
process.stdout.write("Shell de teste\r\n"); prompt();
let line = "";
process.stdin.on("data", (d) => {
  for (const ch of d.toString("utf8")) {
    if (ch === "\r" || ch === "\n") {
      process.stdout.write("\r\n");
      const m = /\u0001resize (\d+) (\d+)/.exec(line);
      if (m) { size = `${m[1]}x${m[2]}`; line = ""; continue; }
      if (line === "exit") process.exit(0);
      if (line === "tamanho") process.stdout.write(size + "\r\n");
      else if (line === "acentos") process.stdout.write("ação ✓\r\n");
      else if (line) process.stdout.write(`voce digitou: ${line}\r\n`);
      line = ""; prompt();
    } else if (ch === "\u007f") { if (line) { line = line.slice(0, -1); process.stdout.write("\b \b"); } } else { line += ch; if (ch !== "\u0001" && !line.includes("\u0001")) process.stdout.write(ch); }
  }
});
process.on("SIGHUP", () => process.exit(0));
