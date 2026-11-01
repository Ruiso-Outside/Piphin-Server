# Piphin Server

Painel de hospedagem, módulo do [Piphin Hub](https://github.com/Ruiso-Outside/Piphin-Hub). Transforma um PC com **Ubuntu Server** da sua rede numa máquina de hospedagem, parecido com o Pterodactyl: servidores de jogos, bots, sites, APIs e bancos de dados, cada um isolado num contêiner Docker e controlado pelo Hub.

São duas partes:

- **Piphin Agent** (`agent/`): roda no Ubuntu, como serviço do sistema. Cria e controla os contêineres pelo Docker, guarda os arquivos, faz backups e executa os agendamentos, mesmo com o Hub fechado.
- **Módulo do Hub** (`module/` e `web/`): a tela no Windows. Acha as máquinas na rede, pareia, e mostra tudo de cada servidor.

## O que dá para fazer

- **Máquinas**: várias máquinas no mesmo Hub, com processador, memória, disco, rede e tempo ligado ao vivo
- **Servidores**: criar pelo assistente escolhendo um modelo, ligar, desligar, reiniciar e forçar a parada; reinicia sozinho se cair (até 4 vezes em 5 minutos) e liga junto com a máquina
- **Console**: a saída ao vivo e o envio de comandos (o `stop` do Minecraft, por exemplo)
- **Arquivos**: navegar, editar texto (Ctrl+S salva), criar, renomear, apagar, enviar arrastando do Windows (até 512 MB pelo arrastar, sem limite pelo botão) e baixar
- **Backups**: `.tar.gz` guardado na própria máquina, com nota; restaurar e baixar para o PC. Os automáticos guardam os 7 mais novos
- **Agendamentos**: reiniciar, ligar, desligar, backup ou comando no console, com atalhos (todo dia, toda semana, a cada N horas) ou cron
- **Configurações**: opções do modelo, versão, imagem do Docker, comando de início, portas, limite de memória, processador e disco
- **IA**: com o Piphin LLM, a IA vê as máquinas e servidores, lê o console, liga e desliga e manda comandos (sempre pedindo confirmação para ações). Ferramentas no `module/module.json`

## Modelos

| Categoria | Modelos |
|---|---|
| Jogos | Minecraft Java (Paper), Minecraft Java (oficial), Terraria, Valheim |
| Bots | Bot do Discord em Node.js, Bot do Discord em Python |
| Sites e apps | App em Node.js, App em Python, Site estático (nginx), Site PHP (Apache) |
| Bancos de dados | MariaDB, Redis |
| Outros | Personalizado: qualquer imagem do Docker Hub, comando de início e porta |

Cada modelo é um arquivo em `agent/templates/` (variáveis, imagem, script de instalação, comando de início, como parar e a frase que indica que ligou). A versão do Java do Minecraft é escolhida sozinha pela versão do jogo (8, 17, 21 ou 25).

## Instalar na máquina Ubuntu

No terminal do Ubuntu (ou por SSH):

```bash
curl -fsSL https://github.com/Ruiso-Outside/Piphin-Server/releases/latest/download/install.sh | sudo bash
```

O instalador:

1. instala o Docker (se faltar) e o Node.js 22 (conferindo o sha256)
2. coloca o agente em `/opt/piphin-agent`, a configuração em `/etc/piphin-agent/config.json` e os dados em `/var/lib/piphin-agent`
3. cria um certificado próprio para o HTTPS e o serviço `piphin-agent` do systemd
4. libera as portas 8443/tcp (painel) e 8444/udp (descoberta) no ufw, se ele estiver ligado
5. mostra o código de pareamento

Depois, no Hub, abra o Piphin Server, clique em **Procurar na rede** e digite o código. Para desinstalar: `sudo bash install.sh --uninstall`.

### Comandos do agente

```bash
sudo piphin-agent pair      # novo código de pareamento (vale 30 minutos)
sudo piphin-agent status    # versão, Docker e servidores
sudo piphin-agent clients   # Hubs pareados
sudo piphin-agent revoke ID # tira o acesso de um Hub
```

## Segurança

- Tudo passa por HTTPS. O Hub guarda a impressão digital do certificado no pareamento e recusa qualquer outro depois disso
- O pareamento usa um código de 8 letras, de uso único, que só aparece no terminal da máquina. 5 tentativas erradas bloqueiam o IP por 15 minutos
- O agente guarda só o hash dos tokens dos Hubs
- Os arquivos de cada servidor ficam presos na pasta dele (links que saem dela são recusados)
- Cada servidor roda num contêiner com limite de memória e processador

## Estrutura

- `agent/src/`: `main.js` (linha de comando, API HTTPS, eventos ao vivo, descoberta), `docker.js` (API do Docker pelo socket), `servers.js` (ciclo de vida), `files.js`, `backups.js`, `schedules.js`, `host.js`, `auth.js`, `templates.js`
- `agent/templates/`: os modelos
- `agent/install.sh`: o instalador
- `module/`: `module.json` e `backend.js` (conversa com os agentes)
- `web/`: a tela
- `test/`: `fake-docker.js` (Docker falso para testar no Windows), `agent-test.js` (teste completo do agente), `dev-env.js` (agente local para testar a tela)
- `scripts/`: `make-module.js` (gera `dist/piphin-module-server-<versão>.zip`), `make-agent.js` (gera `dist/piphin-agent.tar.gz` e `dist/install.sh`), `make-icons.js`, `make-icon.js`

```bash
npm run module
npm run agent
npm test
```
