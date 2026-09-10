import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { extractProducts, scrapePage, scrapeTargets } from '../mercadolivre-scraper.mjs';

const url = 'https://www.mercadolivre.com.br/produto-teste/p/MLB12345678';
const money = (whole, cents = '', cls = '') => `<span class="andes-money-amount ${cls}"><span>R$</span><span class="andes-money-amount__fraction">${whole}</span>${cents ? `<span class="andes-money-amount__cents">${cents}</span>` : ''}</span>`;
const card = (body, link = url) => `<article class="poly-card"><a href="${link}"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><h3>Produto de teste para coleta</h3></a>${body}</article>`;
let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); });

async function extract(html) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await extractProducts(page, 'test');
  } finally { await page.close(); }
}

test('DOM: separate cents and ignore installments appearing before the price', async () => {
  const [product] = await extract(card(`<div class="poly-price__installments">10x de ${money('19', '99')}</div>${money('199', '90')}<s>${money('299', '90')}</s><span>33% OFF</span>`));
  assert.equal(product.price_current, 199.9);
  assert.equal(product.price_original, 299.9);
  assert.equal(product.discount_percent, 33);
});

test('DOM: current price plus installments does not fabricate an original price', async () => {
  const [product] = await extract(card(`${money('1.199', '90')}<div class="ui-search-installments">12x de ${money('99', '99')}</div>`));
  assert.equal(product.price_current, 1199.9);
  assert.equal(product.price_original, null);
  assert.equal(product.discount_percent, null);
});

test('DOM: previous class works and financing percentage is not a discount', async () => {
  const [product] = await extract(card(`${money('250', '', 'andes-money-amount--previous')}${money('200')}<div>Juros de 5%</div>`));
  assert.equal(product.price_original, 250);
  assert.equal(product.price_current, 200);
  assert.equal(product.discount_percent, 20);
});

test('JSON-LD fallback: normalize tracking, preserve decimal price and reject other currencies', async () => {
  const json = currency => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', url: url + '?tracking=old', offers: { price: '199.90', priceCurrency: currency } })}</script>`;
  const [product] = await extract(card('', url + '?tracking=new#details') + json('BRL'));
  assert.equal(product.price_current, 199.9);
  assert.equal((await extract(card('') + json('USD'))).length, 0);
});

test('Missing price and installments alone are not accepted as product prices', async () => {
  assert.equal((await extract(card('<div>12x de R$ 19,90</div>'))).length, 0);
  assert.equal((await extract(card(`<div class="poly-price__installments">${money('19', '90')}</div>`))).length, 0);
});

test('HTTP errors: report both pages and close failed pages', async () => {
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => route.fulfill({ status: 403, body: 'Forbidden' }));
    const output = await scrapeTargets(context);
    assert.equal(output.status, 'failed');
    assert.equal(output.total_products, 0);
    assert.equal(output.pages.length, 2);
    assert.ok(output.pages.every(page => /HTTP 403/.test(page.error)));
    assert.equal(context.pages().length, 0);
  } finally { await context.close(); }
});

test('An HTTP 200 empty extraction fails and closes the page', async () => {
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<script type="application/ld+json">{}</script><p>Nenhuma oferta</p>' }));
    await assert.rejects(scrapePage(context, { source: 'test', url }), /Nenhum produto com preço válido/);
    assert.equal(context.pages().length, 0);
  } finally { await context.close(); }
});

test('A partial collection is failed even when another page has valid products', async () => {
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => route.fulfill(route.request().url().includes('lightning')
      ? { status: 503, body: 'Unavailable' }
      : { contentType: 'text/html', body: card(money('199', '90')) }));
    const output = await scrapeTargets(context);
    assert.equal(output.status, 'failed');
    assert.equal(output.total_products, 1);
    assert.equal(output.pages[0].products[0].price_current, 199.9);
    assert.match(output.pages[1].error, /HTTP 503/);
  } finally { await context.close(); }
});

