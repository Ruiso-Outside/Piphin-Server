// App Python (site Flask/FastAPI, API, bot): escuta na porta da variável PORT
module.exports = {
  id: "python-app", order: 21, name: "App Python (site ou API)", category: "sites", icon: "code",
  description: "Qualquer programa em Python: Flask, FastAPI, Django, scripts e bots. O programa recebe a porta na variável PORT.",
  image: "python:3.12-slim",
  images: [{ name: "Python 3.12", image: "python:3.12-slim" }, { name: "Python 3.13", image: "python:3.13-slim" }, { name: "Python 3.11", image: "python:3.11-slim" }],
  installImage: "alpine:3.20",
  install: `apk add --no-cache git >/dev/null
if [ -n "$GIT_URL" ]; then
  echo "Clonando $GIT_URL..."
  git clone --depth 1 \${GIT_BRANCH:+--branch "$GIT_BRANCH"} "$GIT_URL" /tmp/repo
  cp -a /tmp/repo/. /mnt/server/
elif [ ! -f /mnt/server/app.py ]; then
  cat > /mnt/server/app.py <<'PY'
# Site de exemplo (só a biblioteca padrão): troque por seu programa. A porta vem da variável PORT.
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers()
        self.wfile.write("<h1>Funcionando no Piphin Server</h1>".encode())
port = int(os.environ["PORT"])
print(f"Ouvindo na porta {port}", flush=True)
HTTPServer(("0.0.0.0", port), H).serve_forever()
PY
fi`,
  startup: "if [ -f requirements.txt ]; then pip install --no-cache-dir --user --disable-pip-version-check -q -r requirements.txt; fi; {{START_COMMAND}}",
  stop: "SIGTERM",
  ports: [{ name: "Web", container: "same", protocol: "tcp", default: 8000 }],
  limits: { memory: 1024, cpu: 1, disk: 4096 },
  vars: [
    { key: "GIT_URL", name: "Repositório Git (opcional)", description: "Vazio = site de exemplo", default: "" },
    { key: "GIT_BRANCH", name: "Branch (opcional)", default: "" },
    { key: "START_COMMAND", name: "Comando para iniciar", default: "python -u app.py", required: true },
  ],
};
