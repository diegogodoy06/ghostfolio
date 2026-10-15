# Ghostfolio + automação para o Brasil

Tudo sobe com um comando, nesta pasta:

```bash
docker compose up -d --build
```

Isso inicia o Ghostfolio oficial (app, Postgres e Redis), o serviço `ghostfolio-sync`, que roda ao iniciar, todo dia às 9h (Brasília) e sempre que a pasta `extratos/` muda, e os **relatórios** em http://localhost:3334.

## Relatórios (localhost:3334)

Extensão do Ghostfolio com o mesmo visual (barra superior com os links dele e menu lateral), com relatórios no estilo das corretoras brasileiras. Entre com o mesmo token de segurança do Ghostfolio (fica salvo no aparelho; no celular, use o IP do computador e "Adicionar à tela inicial").

- **Resumo**: patrimônio, valorização, proventos, desempenho contra CDI, Ibovespa, IPCA, IPCA + 6%, IFIX e dólar (nominal ou real), alocação e evolução do patrimônio.
- **Carteira**: categorias (Ações por setor, FIIs por tipo, ETFs, Exterior, Tesouro, Renda Fixa) com cada ativo: quantidade, preço médio, preço, retorno, proventos, % da classe e % da carteira.
- **Proventos**: evolução mensal por categoria, recebidos × estimados, quem mais pagou, por tipo e por ano.
- **Rentabilidade**: tabela mês a mês com % do CDI e estatísticas (volatilidade, maior queda, melhor/pior mês, Sharpe).
- **Simulação** (dentro de Carteira, seletor "Carteira atual | Simulação", como a conta simulação do TradeMap): metas por categoria, novo aporte e boletas de compra e venda (botões C/V em cada ativo ou "+ Boleta" para qualquer ticker, inclusive novos). O dinheiro que sobra das boletas é distribuído automaticamente, primeiro para o que está mais longe da meta; categorias acima da meta não recebem aporte (ou vendem o excedente, se ligado). Cada ativo mostra o que muda e como fica depois. A simulação salva aparece também no Resumo e é sempre recalculada com a carteira atual (fica no volume `relatorios-data`).

- **Tudo / Carteira / Reserva** (seletor no topo): a reserva de emergência é o que tiver o marcador **Fundo de Emergência** no Ghostfolio (Portfólio → Atividades → editar → Marcadores). "Carteira" mostra tudo menos a reserva, e é a visão que a simulação e o MCP usam.
- **Analisar com Claude** (botão no topo): monta um prompt com os dados da carteira (desempenho, risco, alocação, posições, proventos, metas e simulação) para uma análise escolhida (diagnóstico, estratégia, proventos, riscos ou pergunta livre). Copie e cole no Claude, ou baixe o .md. A opção "Só percentuais" tira valores em R$ e quantidades. O olho oculta os valores na tela (só neste aparelho).

### Claude Desktop / Claude Code (MCP "carteira")

O container dos relatórios também tem um servidor MCP (só leitura), que funciona com a assinatura do Claude e dispensa a API. Ferramentas: `resumo_carteira`, `posicoes`, `proventos`, `desempenho` e `simular_aporte` (não salva nada). Ele também traz prompts prontos de análise.

Claude Desktop (Configurações → Desenvolvedor → Editar configuração, `claude_desktop_config.json`):

```json
{ "mcpServers": { "carteira": { "command": "/usr/local/bin/docker", "args": ["exec", "-i", "ghostfolio-relatorios", "node", "mcp.js"] } } }
```

Claude Code: `claude mcp add carteira -- docker exec -i ghostfolio-relatorios node mcp.js`

Os containers precisam estar rodando. Os dados vão para o Claude como em qualquer conversa.

A rentabilidade é por cota (ponderada no tempo) e **inclui proventos**, como Rico e TradeMap; por isso difere do gráfico de Análise do Ghostfolio, que exclui proventos. Categorias podem ser ajustadas em `extratos/categorias.json`, por exemplo `{ "ITSA4": { "subcategoria": "Financeiro" } }` ou, para mudar a categoria, `{ "IVVB11": { "categoria": "Exterior" } }`.

## Primeira vez

1. Gere os segredos do Ghostfolio em `.env` (veja `.env.example`) e suba com o comando acima.
2. Abra http://localhost:3333, crie a conta (a primeira é admin) e guarde o **token de segurança**.
3. Coloque o token em `custom/sync/sync.env` (`GHOSTFOLIO_ACCESS_TOKEN=...`) e rode o comando de novo.
4. Exporte da B3 (Área do Investidor) os extratos de **Movimentação** (um por ano, desde a primeira compra) e a **Posição**, e solte os `.xlsx` em `extratos/`.

O serviço configura sozinho: moeda BRL, moeda base, câmbio histórico, importação dos extratos, proventos, Tesouro Direto, os benchmarks da tela Análise (CDI, IPCA, IPCA + 6%, IFIX, Ibovespa e dólar) e o país dos ativos que o Yahoo não informa (mapa de regiões em Alocações). ETFs da B3 que replicam índice de fora (IVVB11, ALUG11, NASD11…) recebem o país do índice; se você editar o país de um ativo pela interface, o serviço não sobrescreve.

## Dia a dia

- **Comprou ou vendeu?** Exporte a Movimentação do período e solte em `extratos/`. Em até um minuto as contas da B3 são atualizadas, e os proventos estimados viram os valores reais do extrato.
- **Proventos** entram sozinhos, estimados pelo Yahoo, com o comentário "Auto (Yahoo)".
- **Outras corretoras** (ex.: Nomad): cadastre direto no Ghostfolio, em uma conta própria. O serviço nunca altera contas que não vêm da B3; só adiciona os proventos automáticos.

## extratos/ajustes.json

Para o que a B3 não informa (preço de subscrição, entradas sem histórico). Os avisos no log (`docker logs ghostfolio-sync`) já trazem a linha pronta para colar:

```json
[
  { "tipo": "SUBSCRICAO", "ativo": "ABCD12", "data": "2026-04-14", "quantidade": 10, "preco": 95.00 },
  { "tipo": "ENTRADA", "ativo": "WXYZ11", "data": "2025-07-23", "quantidade": 5, "preco": 100.00 },
  { "tipo": "PRECO", "ativo": "ABCD3", "data": "2023-11-01", "preco": 4.50 }
]
```

Tipos: `ENTRADA`, `SUBSCRICAO`, `COMPRA`, `VENDA`, `CONVERSAO` (`ativo_destino`, `quantidade_destino`, `sobra`) e `PRECO` (corrige uma entrada sem preço no extrato).

## Importante

- As contas da B3 são **espelho dos extratos**: edições feitas nelas pela interface são desfeitas na próxima sincronização. Corrija via `ajustes.json`.
- Se a sincronização fosse remover mais de 30% das atividades (ex.: extratos apagados por engano), ela para e avisa no log. Para confirmar uma mudança grande de propósito: `docker compose run --rm -e FORCE_RESYNC=1 -e RUN_ONCE=1 ghostfolio-sync`.
- Simular sem gravar: `docker compose run --rm -e DRY_RUN=1 -e RUN_ONCE=1 ghostfolio-sync`.
- Proventos estimados usam a data ex e valores brutos do Yahoo, com 15% de IR em ativos que pagam JCP e 30% de retenção nos EUA.
