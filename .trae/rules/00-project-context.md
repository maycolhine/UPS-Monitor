---
description: Contexto, objetivo e limites do projeto UPS Monitor — Web Viewer
globs:
alwaysApply: true
---

# 00 — Contexto do projeto

## O que é

Dashboard web de **leitura** que exibe a telemetria de nobreaks publicada pela API REST local do
projeto **Monitoramento UPS** (`GET /health`, `GET /api/v1`, `GET /api/v1/ups`,
`GET /api/v1/ups/{device_id}/telemetry`, `GET /api/v1/ups/{device_id}/identity`) e permite, **por
ação explícita do usuário**, pedir o teste de bateria do contrato 3.0 (`POST/GET
/api/v1/ups/{device_id}/tests`): `duration_10s` (janela fixa de ~10 s) ou `discharge_20pct` (descarga
até a carga chegar a 20 % ou o teto de 30 min, o que vier primeiro — só onde a API o declara). Nenhum
teste é disparado de forma autônoma.

O escopo oficial é [UPS_Web_Viewer_Scope.md](../../UPS_Web_Viewer_Scope.md) e deve ser seguido.
Documentação: [README.md](../../README.md) e [docs/](../../docs).

## Contexto de integração

- O projeto irmão **Monitoramento UPS** lê os nobreaks por USB serial (protocolos `megatec-q1` e
  `sms-1phase`) e publica a telemetria em HTTP/JSON por uma API unificada. Ele **não** pode ser
  alterado por este projeto.
- Já foram validados nobreaks de **dois protocolos**: TS Shara Universal UPS Senoidal 3200VA
  (`device_id` `tsshara-3200va-01`, `/dev/ttyACM0`, `0483:5740`, `megatec-q1`) e SMS Power Sinus
  NG uPS3200S (`sms-ups3200s-01`, USB-Serial, `sms-1phase`). O projeto **não deve se limitar** a
  esses modelos: novas marcas/modelos devem funcionar sem alterar o frontend.
- Consequência prática: nada de marca/modelo fixo em código. Os equipamentos são descobertos em
  `GET /api/v1/ups` (a API unificada publica N nobreaks, em protocolos diferentes) e a interface
  permite escolher **um por vez** (`GET /api/dashboard?device_id=`); os campos são lidos pelo contrato.

## Limites de responsabilidade (não ultrapassar)

O Web Viewer **não**:

- lê ou controla a porta USB;
- implementa os protocolos dos nobreaks (Megatec/Q1, `sms-1phase`);
- executa o coletor serial ou envia comandos/desligamento ao nobreak — o **pedido** de teste de
  bateria é repassado à API de origem (que comanda o equipamento), e só por ação do usuário;
- altera a API de origem ou seus arquivos;
- persiste histórico nesta versão (o histórico de testes vive em memória na API de origem);
- configura o Zabbix;
- expõe a API diretamente à internet.

## Idioma

Todo o projeto — código, comentários, mensagens de erro, interface e documentação — em
**português do Brasil**.
