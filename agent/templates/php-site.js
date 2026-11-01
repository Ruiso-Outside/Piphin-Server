// Site PHP com Apache (WordPress, Laravel public, scripts PHP): os arquivos ficam na raiz do servidor
module.exports = {
  id: "php-site", order: 23, name: "Site PHP (Apache)", category: "sites", icon: "globe",
  description: "Sites em PHP com Apache, prontos para WordPress e outros sistemas. Use junto com um MariaDB se precisar de banco.",
  image: "php:8.3-apache",
  images: [{ name: "PHP 8.3", image: "php:8.3-apache" }, { name: "PHP 8.4", image: "php:8.4-apache" }, { name: "PHP 8.2", image: "php:8.2-apache" }],
  installImage: "alpine:3.20",
  install: `[ -f /mnt/server/index.php ] || [ -f /mnt/server/index.html ] || cat > /mnt/server/index.php <<'PHP'
<?php echo "<h1>Funcionando no Piphin Server</h1><p>PHP " . PHP_VERSION . "</p>";
PHP`,
  // a imagem já sabe iniciar o Apache; o Apache roda como www-data (33)
  startup: "", mount: "/var/www/html", user: "root", chown: "33:33",
  stop: "SIGWINCH",
  ports: [{ name: "Web", container: 80, protocol: "tcp", default: 8081 }],
  limits: { memory: 512, cpu: 1, disk: 4096 },
  vars: [],
  notes: "Os arquivos do site ficam na raiz do servidor. Para WordPress, envie os arquivos e crie um banco MariaDB.",
};
