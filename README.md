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
- **Monitoramento**: uso e frequência de cada núcleo, temperaturas, ventoinhas, placa de vídeo NVIDIA, memória, discos (espaço, velocidade e saúde), rede por placa, processos e histórico de 1 e 24 horas, guardado no agente, com alertas de disco cheio, memória, temperatura, serviço com defeito e reinício pendente
- **Sistema**: atualizar o agente com um clique, ver e instalar as atualizações do Ubuntu, reiniciar e desligar parando os servidores do jeito certo, ligar pela rede (Wake-on-LAN), nome, fuso horário e código para parear outro Hub
- **Serviços**: ver, iniciar, parar, reiniciar e escolher quais ligam sozinhos (systemd), com os logs de cada um
- **Rede**: firewall (ufw) com regras, placas de rede e portas abertas
- **Docker**: espaço usado, imagens, contêineres e limpeza
- **Logs**: os logs do sistema, com filtros
- **Terminal**: terminal root da máquina dentro do Hub, com várias sessões, cores e programas como `top` e `nano`; a sessão continua por 10 minutos se o Hub desconectar
- **IA**: com o Piphin LLM, a IA vê as máquinas e servidores, a saúde de cada máquina, lê o console, liga e desliga e manda comandos (sempre pedindo confirmação para ações). Ferramentas no `module/module.json`

## Modelos

| Categoria | Modelos |
|---|---|
| Jogos | Minecraft Java (Paper), Minecraft Java (oficial), Terraria, Valheim |
| Bots | Bot do Discord em Node.js, Bot do Discord em Python |
| Sites e apps | App em Node.js, App em Python, Site estático (nginx), Site PHP (Apache) |
| Bancos de dados | MariaDB, Redis |
| Outros | Personalizado: qualquer imagem do Docker Hub, comando de início e porta |

Cada modelo é um arquivo em `agent/templates/` (variáveis, imagem, script de instalação, comando de início, como parar e a frase que indica que ligou). A versão do Java do Minecraft é escolhida sozinha pela versão do jogo (8, 17, 21 ou 25).

## Meus jogos

Para os seus próprios jogos, como um build Linux da Unreal Engine. No assistente de novo servidor, a aba **Meus jogos**:

1. **Adicionar jogo**: o nome, como o jogo roda e o pacote do PC (`.tar.gz`, `.tar` ou `.zip`). O pacote vai direto para a máquina, com o hash conferido.
2. Clique no jogo para criar quantos servidores quiser. Cada um recebe o pacote extraído na pasta `game`.
3. Para atualizar, envie a versão nova (no cartão do jogo ou na aba Configurações do servidor) e escolha atualizar os servidores. Os ligados desligam, recebem a versão e ligam de novo. A extração é por cima, então os saves e as configurações que o jogo criou continuam. Também dá para voltar para uma das versões guardadas (as 3 mais novas).

Como o jogo roda:

- **Jogo Unreal**: roda o `<Projeto>Server.sh` do pacote (build de servidor dedicado). Sem ele, roda o jogo normal sem tela (`-nullrhi`) hospedando o mapa escolhido, com `?listen`. A porta vai em `-Port` e há um campo para opções extras.
- **Um egg**: para jogos com um jeito próprio de ligar (por exemplo, vários processos ao mesmo tempo). Importe o `.json` do egg no formulário do jogo e envie o pacote.

Os pacotes ficam em `/var/lib/piphin-agent/games`. A extração roda num contêiner, sem rede.

## Eggs do Pterodactyl

No assistente de novo servidor, a aba **Eggs** mostra o catálogo de [eggs.pterodactyl.io](https://eggs.pterodactyl.io/) (mais de 300 jogos e aplicativos), com busca. Ao clicar num egg, o Hub baixa o arquivo e o agente guarda como um modelo da máquina. Também dá para importar um arquivo `.json` de egg de qualquer lugar.

O agente faz o que o painel do Pterodactyl faria:

- roda o script de instalação do egg no contêiner dele, com a pasta do servidor em `/mnt/server`
- usa as imagens do egg, que recebem a linha de início na variável `STARTUP`
- transforma as regras das variáveis em campos do formulário (lista, número, Sim/Não, obrigatório) e não mostra as variáveis fixas
- ajusta os arquivos de configuração do egg a cada início (`properties`, `ini`, `json`, `yaml`, `xml` e `file`)
- pede o aceite do EULA quando o egg exige
- abre a porta principal em TCP e UDP, as portas das opções (como `QUERY_PORT`) e as **portas extras** que você informar

Eggs importados ficam em `/var/lib/piphin-agent/eggs`. Os textos dos eggs vêm em inglês. Um egg roda um script dentro de um contêiner, então só importe arquivos de quem você confia.

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

Depois, no Hub, abra o Piphin Server, clique em **Procurar na rede** e digite o código. Se o roteador der outro IP à máquina, o Hub a acha de novo sozinho na rede, pelo certificado. Para desinstalar: `sudo bash install.sh --uninstall`.

Para atualizar o agente, rode o mesmo comando de instalação de novo: os servidores continuam ligados, e a configuração e o pareamento são mantidos.

### Comandos do agente

```bash
sudo piphin-agent pair      # novo código de pareamento (vale 30 minutos)
sudo piphin-agent status    # versão, Docker e servidores
sudo piphin-agent clients   # Hubs pareados
sudo piphin-agent revoke ID # tira o acesso de um Hub
```

## Segurança

- Tudo passa por HTTPS. O Hub guarda a impressão digital do certificado no pareamento e, antes de mandar qualquer coisa, confere se é a mesma. Se não for, a conexão é cortada e o token não sai do PC
- Um Hub pareado é administrador da máquina (root): tem terminal, atualiza o sistema e desliga. Pareie só os seus. Para tirar o terminal de uma máquina, coloque `"terminal": false` em `/etc/piphin-agent/config.json` e reinicie o serviço
- As ações na máquina (terminal aberto, serviços, firewall, energia) ficam no log do agente: `journalctl -u piphin-agent`
- A IA do Piphin LLM não tem acesso ao terminal nem às ações da máquina, só à leitura da saúde
- O pareamento usa um código de 8 letras, de uso único, que só aparece no terminal da máquina. 5 tentativas erradas bloqueiam o IP por 15 minutos
- O agente guarda só o hash dos tokens dos Hubs
- Os arquivos de cada servidor ficam presos na pasta dele (links que saem dela são recusados)
- Cada servidor roda num contêiner com limite de memória e processador

## Estrutura

- `agent/src/`: `main.js` (linha de comando, API HTTPS, eventos ao vivo, descoberta), `system.js` (monitoramento e controle da máquina), `terminal.js` (terminal num pseudo-terminal, pelo comando `script`), `docker.js` (API do Docker pelo socket), `servers.js` (ciclo de vida), `files.js`, `backups.js`, `schedules.js`, `host.js`, `auth.js`, `templates.js`, `eggs.js` (eggs do Pterodactyl)
- `agent/templates/`: os modelos (`unreal-game.js` é o dos Meus jogos)
- `agent/src/games.js`: os Meus jogos (pacotes e versões)
- `agent/install.sh`: o instalador
- `module/`: `module.json`, `backend.js` (conversa com os agentes) e `pinned.js` (conexão presa à impressão digital)
- `web/`: a tela (`js/app.js`, `js/machine.js`, `js/games.js` e `vendor/` com o [xterm.js](https://xtermjs.org), licença MIT)
- `test/`: `fake-docker.js` (Docker falso para testar no Windows), `agent-test.js` (teste completo do agente), `fake-system.js` e `fake-shell.js` (`/proc`, `/sys`, comandos do sistema e shell de mentira), `dev-env.js` (agente local para testar a tela)
- `scripts/`: `make-module.js` (gera `dist/piphin-module-server-<versão>.zip`), `make-agent.js` (gera `dist/piphin-agent.tar.gz` e `dist/install.sh`), `make-icons.js`, `make-icon.js`

```bash
npm run module
npm run agent
npm test
```
