# Coleta de ofertas do Mercado Livre

Script Node.js com Playwright que coleta ofertas do dia e ofertas relâmpago,
sem banco de dados. O workflow publica `resultado.json` no GitHub Pages.

## Execução local

Requer Node.js 24 e as dependências do Chromium:

```bash
npm ci
npx playwright install --with-deps chromium
npm test
node mercadolivre-scraper.mjs > resultado.json
```

O JSON vai para a saída padrão; mensagens de diagnóstico vão para stderr.
O processo retorna código 1 quando uma página falha, não possui produtos com
preço válido ou o navegador não inicia. Uma coleta parcial também falha, para
que o workflow preserve a última publicação em vez de publicar dados incompletos.
HTTP 403, redirecionamentos para login/verificação e alterações de layout devem
ser investigados; o scraper não tenta resolver verificações de acesso.

## Preços e testes

- HTML: lê fração e centavos separadamente e interpreta `1.199,90` como 1199.90.
- JSON-LD: interpreta `199.90` como 199.90 e aceita BRL ou moeda não informada.
- Preço anterior: usa marcação de preço riscado/anterior, não a ordem dos valores.
- Parcelamento: exclui elementos de parcelas/financiamento. Não infere preços
  de texto livre, que pode conter juros, frete ou parcelas.
- Sem preço atual válido: o produto é descartado. Se nenhum produto válido
  restar em uma das páginas, a execução falha.
- `npm test`: valida conversões, extração em HTML controlado usando Chromium,
  erros HTTP, coleta parcial, fechamento de páginas e código de saída.
  Os testes interceptam as requisições; não consultam ofertas reais.

O contrato mantém `site`, `captured_at`, `pages` e `total_products` e acrescenta
`status` (`success` ou `failed`). O total conta produtos únicos entre as páginas;
as listas de cada página mantêm sua própria origem.

## GitHub Actions e retomada do agendamento

O cron `0 11 * * *` agenda a coleta diariamente às 08h de Brasília (11h UTC).
O GitHub pode atrasar execuções. O workflow de testes roda nos pull requests;
a publicação só ocorre quando o workflow de coleta roda em `main` e todos os
testes e a coleta terminam com sucesso. Execuções manuais em outras branches
geram o artefato, mas não publicam no Pages.

Em 10/09/2026, a API do GitHub informou `disabled_inactivity` para o workflow
de coleta. O GitHub desativa agendamentos de repositórios públicos após 60 dias
sem atividade. Depois de integrar a correção:

1. Abra **Actions → Scrape Mercado Livre Offers (Pages)**.
2. Clique em **Enable workflow**, se estiver desativado.
3. Use **Run workflow** na branch `main`.
4. Confira os totais de cada origem no log e a data do JSON publicado.

Não basta um indicador verde de uma execução antiga: valide `captured_at`,
`status`, `total_products` e eventuais `pages[].error`.

Referências:
- [Workflow do projeto](https://github.com/camjunior/ml-ofertas-scraper/actions/workflows/scraper.yml)
- [Resultado publicado](https://camjunior.github.io/ml-ofertas-scraper/resultado.json)
- [GitHub: desativar e reativar workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)
