// Testes fora do Linux: uma árvore /proc e /sys de mentira (fixtures) e os comandos do sistema com a saída real do Ubuntu.
//   node fake-system.js <comando> <args>   faz o papel de systemctl, apt, ufw...
//   require("./fake-system").setup(pasta)  cria as pastas e devolve as variáveis de ambiente para o agente
"use strict";
const fs = require("fs");
const path = require("path");

function setup(dir) {
  const proc = path.join(dir, "proc"), sys = path.join(dir, "sys");
  const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  const stat = (b) => `cpu  ${400 * b} 0 ${100 * b} ${1500 * b} 20 0 0 0 0 0\n` + [0, 1, 2, 3].map((i) => `cpu${i} ${(40 + i * 20) * b} 0 ${10 * b} ${(100 - i * 20) * b} 5 0 0 0 0 0\n`).join("") + "intr 1\nctxt 1\n";
  put(path.join(proc, "stat"), stat(1));
  put(path.join(proc, "cpuinfo"), [0, 1, 2, 3].map((i) => `processor\t: ${i}\ncpu MHz\t\t: ${3400 + i * 100}.123\n\n`).join(""));
  put(path.join(proc, "meminfo"), "MemTotal:       32768000 kB\nMemFree:         2000000 kB\nMemAvailable:   20000000 kB\nBuffers:          200000 kB\nCached:          8000000 kB\nSReclaimable:     500000 kB\nSwapTotal:       4096000 kB\nSwapFree:        4000000 kB\n");
  put(path.join(proc, "net", "dev"), "Inter-|   Receive\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n  eno1: 5000000 100 0 0 0 0 0 0 2000000 80 0 0 0 0 0 0\nveth12: 900 1 0 0 0 0 0 0 900 1 0 0 0 0 0 0\n");
  put(path.join(proc, "diskstats"), "   8       0 sda 100 0 2000 50 200 0 4000 80 0 90 130 0 0 0 0 0 0\n   8       1 sda1 50 0 1000 20 100 0 2000 40 0 45 60 0 0 0 0 0 0\n   7       0 loop0 1 0 2 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n");
  put(path.join(proc, "mounts"), `/dev/sda1 ${dir.replace(/\\/g, "/").replace(/ /g, "\\040")} ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/loop0 /snap/x squashfs ro 0 0\n`);
  put(path.join(proc, "1234", "stat"), "1234 (java server) S 1 1234 1234 0 -1 4194560 100 0 0 0 500 100 0 0 20 0 30 0 1000 4000000 250000 18446744073709551615\n");
  put(path.join(proc, "1234", "status"), "Name:\tjava\nUid:\t1000\t1000\t1000\t1000\n");
  put(path.join(proc, "1234", "cmdline"), "java\0-jar\0server.jar\0");
  for (const d of ["sda", "loop0"]) fs.mkdirSync(path.join(sys, "block", d), { recursive: true });
  const h0 = path.join(sys, "class", "hwmon", "hwmon0");
  put(path.join(h0, "name"), "coretemp\n");
  put(path.join(h0, "temp1_input"), "61000\n"); put(path.join(h0, "temp1_label"), "Package id 0\n"); put(path.join(h0, "temp1_crit"), "100000\n");
  put(path.join(h0, "temp2_input"), "58000\n"); put(path.join(h0, "temp2_label"), "Core 0\n"); put(path.join(h0, "temp2_crit"), "100000\n");
  const h1 = path.join(sys, "class", "hwmon", "hwmon1");
  put(path.join(h1, "name"), "nvme\n"); put(path.join(h1, "temp1_input"), "93500\n"); put(path.join(h1, "temp1_label"), "Composite\n"); put(path.join(h1, "temp1_crit"), "95000\n");
  const h2 = path.join(sys, "class", "hwmon", "hwmon2");
  put(path.join(h2, "name"), "nct6798\n"); put(path.join(h2, "fan1_input"), "1180\n");
  const net = path.join(sys, "class", "net", "eno1");
  put(path.join(net, "address"), "aa:bb:cc:dd:ee:ff\n"); put(path.join(net, "operstate"), "up\n"); put(path.join(net, "speed"), "1000\n");
  fs.mkdirSync(path.join(sys, "class", "net", "lo"), { recursive: true });
  const flag = path.join(dir, "reboot-required");
  put(flag, "*** System restart required ***\n"); put(`${flag}.pkgs`, "linux-image-generic\n");
  // as CPUs andando, para o uso por núcleo aparecer
  const timer = setInterval(() => { timer.b = (timer.b || 1) + 1; try { fs.writeFileSync(path.join(proc, "stat"), stat(timer.b)); } catch {} }, 2000); timer.unref();
  return { PIPHIN_PROC: proc, PIPHIN_SYS: sys, PIPHIN_REBOOT_FLAG: flag, PIPHIN_FAKE_CMD: __filename, PIPHIN_FAKE_SHELL: path.join(__dirname, "fake-shell.js"), PIPHIN_FAKE_STATE: path.join(dir, "fake-state.json") };
}
module.exports = { setup };

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2), a = args.join(" ");
  const out = (t) => process.stdout.write(t + "\n");
  const stF = process.env.PIPHIN_FAKE_STATE;
  const st = (() => { try { return JSON.parse(fs.readFileSync(stF, "utf8")); } catch { return { ufw: true, rules: ["8443/tcp", "8444/udp", "22/tcp"], calls: [] }; } })();
  st.calls.push(`${cmd} ${a}`);
  const done = (code = 0) => { fs.writeFileSync(stF, JSON.stringify(st)); process.exitCode = code; };
  const cases = {
    which: () => { if (["smartctl", "ufw"].includes(args[0])) out("/usr/sbin/" + args[0]); else process.exitCode = 1; },
    systemctl: () => {
      if (/list-units.*--state=failed/.test(a)) return out("broken.service loaded failed failed Serviço com defeito");
      if (/^list-units/.test(a)) return out("docker.service loaded active running Docker Application Container Engine\nssh.service loaded active running OpenBSD Secure Shell server\nbroken.service loaded failed failed Serviço com defeito\nnginx.service loaded inactive dead A high performance web server\nsumiu.service not-found inactive dead sumiu.service\npiphin-agent.service loaded active running Piphin Agent");
      if (/^list-unit-files/.test(a)) return out("docker.service enabled enabled\nssh.service enabled enabled\nnginx.service disabled enabled\npiphin-agent.service enabled enabled\nbroken.service enabled enabled");
    },
    apt: () => out("Listing...\ncurl/noble-updates 8.5.0-2ubuntu10.6 amd64 [upgradable from: 8.5.0-2ubuntu10.5]\nopenssl/noble-security 3.0.13-0ubuntu3.5 amd64 [upgradable from: 3.0.13-0ubuntu3.4]"),
    "apt-get": () => { out(`Lendo listas (${args[0]})`); out("Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease"); out("Pronto."); },
    journalctl: () => out(`2026-11-01T10:00:00+0000 ubuntu systemd[1]: Started ${args.includes("-u") ? args[args.indexOf("-u") + 1] : "tudo"} args=[${a}]\n2026-11-01T10:00:01+0000 ubuntu kernel: linha dois`),
    ufw: () => {
      if (args[0] === "status") { out(`Status: ${st.ufw ? "active" : "inactive"}`); if (st.ufw) { out("\n     To                         Action      From\n     --                         ------      ----"); st.rules.forEach((r, i) => out(`[${String(i + 1).padStart(2)}] ${r.padEnd(26)} ${r.startsWith("!") ? "DENY IN " : "ALLOW IN"}    Anywhere`)); } return; }
      if (args[0] === "--force" && args[1] === "enable") { st.ufw = true; return out("Firewall is active and enabled on system startup"); }
      if (args[0] === "disable") { st.ufw = false; return out("Firewall stopped"); }
      if (args[0] === "--force" && args[1] === "delete") { st.rules.splice(Number(args[2]) - 1, 1); return out("Rule deleted"); }
      if (args[0] === "allow" && !st.rules.includes(args[1])) { st.rules.push(args[1]); return out("Rule added"); }
      if (args[0] === "deny") { st.rules.push("!" + args[1]); return out("Rule added"); }
    },
    ss: () => out('tcp   LISTEN 0      4096         0.0.0.0:8443       0.0.0.0:*    users:(("node",pid=900,fd=18))\nudp   UNCONN 0      0            0.0.0.0:8444       0.0.0.0:*    users:(("node",pid=900,fd=19))\ntcp   LISTEN 0      4096               *:22               *:*    users:(("sshd",pid=800,fd=3))\ntcp   LISTEN 0      4096            [::]:8443             [::]:*    users:(("node",pid=900,fd=20))'),
    timedatectl: () => { if (args[0] === "list-timezones") return out("America/Sao_Paulo\nEtc/UTC\nEurope/Lisbon"); if (args[0] === "set-timezone") { st.tz = args[1]; return; } out(/NTP/.test(a) ? "yes" : st.tz || "Etc/UTC"); },
    hostnamectl: () => { st.hostname = args[1]; },
    smartctl: () => { if (args[0] === "--scan-open") return out(JSON.stringify({ devices: [{ name: "/dev/sda" }] })); out(JSON.stringify({ model_name: "Samsung SSD 970", user_capacity: { bytes: 1e12 }, smart_status: { passed: true }, temperature: { current: 41 }, power_on_time: { hours: 12345 }, nvme_smart_health_information_log: { percentage_used: 3 } })); },
    "systemd-run": () => { st.agentUpdate = a; },
  };
  if (!cases[cmd]) { process.stderr.write(`comando desconhecido: ${cmd}\n`); done(127); } else { cases[cmd](); done(process.exitCode || 0); }
}
