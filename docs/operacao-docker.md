# Operação com Docker

## 1. Requisitos

- Docker Engine 24+ e Docker Compose v2 (`docker compose version`).
- Acesso de rede do host até a API de telemetria do projeto *Monitoramento UPS*.

Instalação do Docker CE no Ubuntu (repositório oficial — os comandos com `sudo` são executados pelo
operador):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl        # curl não vem instalado por padrão neste host
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"      # requer novo login para valer
```

Se o terminal usado na sessão atual ainda não tiver o grupo `docker` (o `usermod` só vale em um novo
login), as mesmas tarefas podem ser feitas sem relogar com:

```bash
sg docker -c "docker compose up --build -d"
```

## 2. Build e inicialização

```bash
cp .env.example .env        # ajuste UPS_API_BASE_URL e, se quiser, VIEWER_HTTP_PORT
docker compose up --build -d
```

> No host atual (`RTCNOTE2024Q`) o `.env` já existe, com
> `UPS_API_BASE_URL=http://192.168.52.68:8080` e `VIEWER_HTTP_PORT=8090`. Não é preciso recriá-lo.

A interface fica em `http://<ip-do-host>:8090` (ou na porta definida em `VIEWER_HTTP_PORT`).

Operações do dia a dia:

```bash
docker compose logs -f                 # acompanhar os logs
docker compose ps                      # estado + healthcheck
docker compose restart                 # reiniciar sem rebuild
docker compose up --build -d           # rebuild após alterar código
docker compose down                    # encerrar e remover o container
docker compose build --no-cache        # rebuild limpo
```

Verificação rápida:

```bash
curl -s http://localhost:8090/healthz
# {"status":"ok","service":"ups-web-viewer","version":"1.0.0","read_only":true,"uptime_seconds":...}

curl -s http://localhost:8090/api/dashboard | head -c 400
```

## 3. Conectividade container ↔ API no host

Este é o ponto que mais causa erro. **Dentro do container, `localhost` e `127.0.0.1` apontam para o
próprio container** — nunca para a máquina Ubuntu que tem o cabo USB.

| Cenário | `UPS_API_BASE_URL` | Requisito no host |
|---|---|---|
| A | `http://host.docker.internal:8080` | API escutando em `0.0.0.0` |
| B (**em uso**) | `http://192.168.52.68:8080` (IP de rede do host) | API escutando no IP de rede |
| C (Linux, host network) | `http://127.0.0.1:8080` + `network_mode: host` | API escutando em loopback |

> **Neste host vale o cenário B.** O serviço do projeto *Monitoramento UPS* está vinculado apenas ao
> IP de rede (`http_host=192.168.52.68`), não a `0.0.0.0`. Por isso o `.env` aponta para
> `http://192.168.52.68:8080`: o cenário A só funcionaria reiniciando a API com
> `--http-host 0.0.0.0`. Em qualquer caso, o container nunca alcança a API por `127.0.0.1`.

O `compose.yaml` já inclui:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

No Linux isso **não** é automático (diferente do Docker Desktop), e é por isso que a linha acima
existe. No cenário A, suba a API aceitando conexões de fora do loopback:

```bash
cd "Monitoramento UPS/TS_Shara/Universal_UPS_Senoidal_3200VA"
python3 scripts/run_api.py --http-host 0.0.0.0 --http-port 8080
```

Validar de dentro do container:

```bash
docker compose exec ups-web-viewer node -e \
  "fetch(process.env.UPS_API_BASE_URL + '/health').then(r => console.log('HTTP', r.status)).catch(e => console.error('falhou:', e.message))"
```

Ou, mais simples, consultar o que o próprio viewer publica:

```bash
curl -s http://localhost:8090/api/dashboard | grep -o '"reachable":[a-z]*'
# "reachable":true  → o container alcançou a API
```

Se aparecer `"error":{"code":"upstream_unreachable"`, o problema é de rede (endereço ou `--http-host`).
Se aparecer `"code":"upstream_timeout"`, a API está inalcançável ou lenta: aumente
`UPS_API_TIMEOUT_MS`.

Ver a configuração efetiva:

```bash
docker compose exec ups-web-viewer printenv | sort | grep -E 'UPS_|VIEWER_'
```

## 4. Variáveis de ambiente

Documentadas em [.env.example](../.env.example) e no [README](../README.md#6-configuração).

Regras de comportamento:

- Variável numérica fora da faixa → o processo encerra com **código 2** e a mensagem `configuração
  inválida: ...` aparece no log; o Compose reinicia o container (política `unless-stopped`) e o
  erro se repete — corrija o `.env`.
- `UPS_DEVICE_ID` vazio (padrão) faz o viewer descobrir o equipamento em `GET /api/v1/ups`. Fixá-lo
  reduz consultas e é útil quando houver mais de um nobreak.
- `VIEWER_GAUGE_THRESHOLDS` com JSON inválido **não** derruba o serviço: as faixas padrão continuam
  valendo e o problema aparece em `threshold_problems` (e como aviso na interface).

## 5. Healthcheck

O `HEALTHCHECK` da imagem e o do Compose consultam `http://127.0.0.1:8080/healthz`, que responde pela
saúde do **próprio container** — não pela API de telemetria. Assim, um nobreak desligado não faz o
Docker marcar o serviço como doente nem reiniciar a aplicação.

```bash
docker inspect --format '{{.State.Health.Status}}' ups-web-viewer
# healthy | starting | unhealthy
```

Para monitorar o nobreak, use `GET /api/dashboard` (campo `viewer.upstream`) — essa é a informação
operacional, separada da saúde do container.

## 6. Portas

| Porta | Onde | Observação |
|---|---|---|
| `8080` | dentro do container | Porta interna do backend do viewer |
| `8090` | host (padrão) | Publicada por `VIEWER_HTTP_PORT`; evita conflito com a API de telemetria |

Não publique a porta `8080` do host enquanto a API de telemetria a estiver usando. Para servir o
dashboard na 8080 do host, a API precisa mudar de porta (`--http-port 8081`) e
`UPS_API_BASE_URL` deve acompanhar.

## 7. Atualizar / remover

```bash
docker compose up --build -d      # atualizar depois de alterar o código
docker compose down               # parar e remover o container
docker image rm ups-web-viewer:1.0.0
docker builder prune              # limpar cache de build, se necessário
```

A aplicação não grava estado: **não há volumes**. O container pode ser removido e recriado a qualquer
momento sem perda de dados.

## 8. Diagnóstico de problemas

| Sintoma | Causa provável | Ação |
|---|---|---|
| Faixa "Serviço do Web Viewer inacessível" | O container está parado ou a porta publicada não responde | `docker compose ps`, `docker compose logs -f` |
| Faixa "API de telemetria indisponível" com `upstream_unreachable` | `UPS_API_BASE_URL` errado, ou a API escutando só em loopback | Neste host use o IP de rede (`http://192.168.52.68:8080`); para usar `host.docker.internal`, suba a API com `--http-host 0.0.0.0` |
| `upstream_timeout` | API lenta ou inacessível | Aumente `UPS_API_TIMEOUT_MS`; verifique a rede |
| `no_devices_configured` (404) | `GET /api/v1/ups` vazio e `/health` sem `device_id` | Configure `UPS_DEVICE_ID` com o identificador correto |
| `device_not_found` (404) | `UPS_DEVICE_ID` não é o identificador da API | Confira em `GET /api/v1/ups` |
| Indicador âmbar "Desatualizado" | Coletor sem leitura nova há mais de `stale_after_s` | Verifique a coleta no projeto de origem (porta serial, permissões) |
| Aviso "Faixas dos gauges ainda não validadas" | `threshold_problems` não está vazio | Revise o JSON de `VIEWER_GAUGE_THRESHOLDS` |
| Container reiniciando em loop | Configuração inválida | `docker compose logs ups-web-viewer` e corrija o `.env` |
| Interface carrega, mas sem dados | `VIEWER_STATIC_DIR` sem a interface compilada | Use a imagem oficial; em dev, o `vite build` precisa ter rodado |

Logs com mais detalhe:

```bash
VIEWER_LOG_LEVEL=debug docker compose up -d
docker compose logs -f ups-web-viewer
```

## 9. Segurança

- A aplicação é **somente leitura**: não envia comandos ao nobreak nem escreve na API.
- O container roda como usuário `node` (não root).
- Nenhum segredo, token ou credencial é usado ou versionado.
- A API de telemetria não oferece autenticação; a aplicação deve permanecer na **rede local de
  gerenciamento** e não ser exposta à internet (escopo §2.3).

## 10. Validação executada

Evidência da última verificação completa, no host `RTCNOTE2024Q` (Ubuntu 24.04, `192.168.52.68`),
com Docker Engine 29.9.2 e Compose v5.6.1:

| Verificação | Comando | Resultado |
|---|---|---|
| Imagem construída | `docker compose build` | `ups-web-viewer:1.0.0` (multi-stage, build OK) |
| Container saudável | `docker compose ps` | `Up (healthy)` em `0.0.0.0:8090->8080/tcp` |
| Usuário não root | `docker exec ups-web-viewer id` | `uid=1000(node)` |
| Saúde do container | `curl localhost:8090/healthz` | `200 {"status":"ok",...,"read_only":true}` |
| Config publicada | `curl localhost:8090/api/config` | `200`, `base_url` = `http://192.168.52.68:8080` |
| Interface servida | `curl localhost:8090/` | `200 text/html` + `/assets/index-*.js` e `*.css` |
| Paleta no bundle | inspeção do CSS compilado | `--brand:#ff3d03`, `--ink-strong:#000032`, `--surface:#ffffff` |
| Container → host (IP de rede) | `docker exec ... fetch('http://192.168.52.68:18080/...')` | `200` |
| Container → host (`host.docker.internal`) | `docker exec ... fetch('http://host.docker.internal:18080/...')` | `200` |
| `127.0.0.1` é o próprio container | `docker exec ... fetch('http://127.0.0.1:8080/healthz')` | `200` (viewer, **não** a API) |
| API de origem fora do ar | `curl localhost:8090/api/dashboard` | `502` `upstream_unreachable`, com `viewer.upstream.error` preenchido e `/healthz` ainda `200` |

Os testes automatizados (`npm test`, 103 casos) e o build (`npm run build`) são executados fora do
container; ver [testes.md](./testes.md).
