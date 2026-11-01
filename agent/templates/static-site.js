// Site estático com nginx (HTML, CSS, JS, imagens): os arquivos ficam na pasta public
module.exports = {
  id: "static-site", order: 22, name: "Site estático (nginx)", category: "sites", icon: "globe",
  description: "Hospeda páginas HTML, CSS, JavaScript e imagens com o nginx. Coloque os arquivos na pasta public.",
  image: "nginx:alpine", installImage: "alpine:3.20",
  install: `mkdir -p /mnt/server/public /mnt/server/.piphin
[ -f /mnt/server/public/index.html ] || cat > /mnt/server/public/index.html <<'HTML'
<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Meu site</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0b0a11;color:#fff">
<h1>Funcionando no Piphin Server</h1></body></html>
HTML
cat > /mnt/server/.piphin/nginx.template <<'CONF'
worker_processes auto;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events { worker_connections 1024; }
http {
  include /etc/nginx/mime.types;
  client_body_temp_path /tmp/body; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi;
  access_log /dev/stdout;
  sendfile on; gzip on; gzip_types text/css application/javascript application/json image/svg+xml;
  server {
    listen __PORT__;
    root /home/container/public;
    index index.html;
    location / { try_files $uri $uri/ $uri.html =404; }
  }
}
CONF`,
  startup: "sed \"s/__PORT__/{{SERVER_PORT}}/\" .piphin/nginx.template > .piphin/nginx.conf && exec nginx -c /home/container/.piphin/nginx.conf -g 'daemon off;'",
  stop: "SIGTERM",
  ports: [{ name: "Web", container: "same", protocol: "tcp", default: 8080 }],
  limits: { memory: 256, cpu: 1, disk: 2048 },
  vars: [],
  notes: "Os arquivos do site ficam na pasta public. Abra http://IP-da-máquina:porta no navegador.",
};
