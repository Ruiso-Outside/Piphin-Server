// Redis (cache e filas para bots e sites)
module.exports = {
  id: "redis", order: 31, name: "Redis", category: "bancos", icon: "database",
  description: "Banco em memória para cache, filas e sessões de sites e bots. Salva em disco para não perder os dados.",
  image: "redis:7-alpine", install: null, mount: "/data",
  startup: "exec redis-server --port {{SERVER_PORT}} --appendonly yes --dir /data ${REDIS_PASSWORD:+--requirepass \"$REDIS_PASSWORD\"}",
  stop: "SIGTERM", done: "Ready to accept connections",
  ports: [{ name: "Redis", container: "same", protocol: "tcp", default: 6379 }],
  limits: { memory: 512, cpu: 1, disk: 2048 },
  vars: [{ key: "REDIS_PASSWORD", name: "Senha", type: "password", default: "", required: true, minLength: 8 }],
};
