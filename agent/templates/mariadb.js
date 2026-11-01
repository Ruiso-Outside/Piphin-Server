// Banco de dados MariaDB (compatível com MySQL)
module.exports = {
  id: "mariadb", order: 30, name: "MariaDB (MySQL)", category: "bancos", icon: "database",
  description: "Banco de dados compatível com MySQL para sites, bots e sistemas. Os dados ficam na pasta do servidor.",
  image: "mariadb:11", install: null,
  startup: "", mount: "/var/lib/mysql", user: "root", chown: "",
  stop: "SIGTERM", done: "ready for connections",
  ports: [{ name: "Banco", container: 3306, protocol: "tcp", default: 3306 }],
  limits: { memory: 1024, cpu: 1, disk: 10240 },
  env: {},
  envFromVars: { MARIADB_ROOT_PASSWORD: "ROOT_PASSWORD", MARIADB_DATABASE: "DATABASE", MARIADB_USER: "DB_USER", MARIADB_PASSWORD: "DB_PASSWORD" },
  vars: [
    { key: "ROOT_PASSWORD", name: "Senha do administrador (root)", type: "password", default: "", required: true, minLength: 8 },
    { key: "DATABASE", name: "Criar o banco", default: "app" },
    { key: "DB_USER", name: "Criar o usuário", default: "app" },
    { key: "DB_PASSWORD", name: "Senha do usuário", type: "password", default: "", required: true, minLength: 8 },
  ],
  notes: "Conecte com o IP da máquina, a porta, o usuário e a senha. O banco e o usuário são criados na primeira vez.",
};
