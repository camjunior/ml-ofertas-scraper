
import { pathToFileURL } from "node:url";
import { toNumberFromBRL, toNumberFromJson, computeDiscountPercent } from "./prices.mjs";

/* ---------------- utils ---------------- */

function nowIso() {
  return new Date().toISOString();
}

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function buildAbsoluteUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, "https://www.mercadolivre.com.br").toString();
  } catch {
    return null;
  }
}

function normalizeMercadoLivreUrl(u) {
  if (!u) return null;
  try {
    const urlObj = new URL(u);

    // links rastreados
    if (urlObj.hostname.startsWith("click1.mercadolivre.com.br")) {
      const real = urlObj.searchParams.get("url");
      if (real) return decodeURIComponent(real);
    }
    return u;
  } catch {
    return u;
  }
}

function extractProductIdFromUrl(url) {
  if (!url) return null;
  const m1 = url.match(/MLB-?(\d{6,})/i);
  if (m1) return `MLB${m1[1]}`;
  const m2 = url.match(/\/p\/(MLB\d{6,})/i);
  if (m2) return m2[1].toUpperCase();
  return null;
}

function isLikelyProductUrl(url) {
  if (!url) return false;
  // evita anchors e páginas genéricas
  if (/#root-app|#results/.test(url)) return false;

  // padrões comuns de produto ML
  return (
    /produto\.mercadolivre\.com\.br\/MLB-?\d+/i.test(url) ||
    /mercadolivre\.com\.br\/.+\/p\/MLB\d+/i.test(url) ||
    /MLB-?\d+/i.test(url)
  );
}

/* ---------------- scrolling ---------------- */

async function autoScroll(page, { maxRounds = 35, idleRoundsToStop = 4, step = 1400, waitMs = 800 } = {}) {
  let lastHeight = 0;
  let idle = 0;

  for (let i = 0; i < maxRounds; i++) {
    const height = await page.evaluate(() => document.body.scrollHeight);

    if (height <= lastHeight) idle++;
    else idle = 0;

    lastHeight = height;

    await page.evaluate((s) => window.scrollBy(0, s), step);
    await page.waitForTimeout(waitMs);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(waitMs);

    if (idle >= idleRoundsToStop) break;
  }

  await page.evaluate(() => window.scrollBy(0, -500));
  await page.waitForTimeout(500);
}

/* ---------------- extraction (DOM + embedded JSON) ---------------- */

export async function extractProducts(page, source) {
  const capturedAt = nowIso();

  // 1) Captura possíveis preços via JSON embutido (ld+json)
  const embeddedPriceMap = await page.evaluate(() => {
    const map = new Map(); // url -> { price, original, currency }
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));

    for (const s of scripts) {
      const txt = s.textContent?.trim();
      if (!txt) continue;

      let data;
      try {
        data = JSON.parse(txt);
      } catch {
        continue;
      }

      const arr = Array.isArray(data) ? data : [data];

      for (const obj of arr) {
        // ItemList -> itemListElement[]
        if (obj && obj["@type"] === "ItemList" && Array.isArray(obj.itemListElement)) {
          for (const el of obj.itemListElement) {
            const item = el?.item || el;
            const url = item?.url || item?.["@id"];
            const offers = item?.offers;
            const price = offers?.price != null ? String(offers.price) : null;
            const currency = offers?.priceCurrency || null;
            if (url && price) map.set(url, { current: price, original: null, currency });
          }
        }

        // Product -> offers
        if (obj && obj["@type"] === "Product") {
          const url = obj.url || obj["@id"];
          const offers = obj.offers;
          const price = offers?.price != null ? String(offers.price) : null;
          const currency = offers?.priceCurrency || null;
          if (url && price) map.set(url, { current: price, original: null, currency });
        }
      }
    }

    // retorna objeto simples
    return Object.fromEntries(map.entries());
  });

  // 2) Extrai cards e lê preço pelos elementos de dinheiro (mais confiável)
  const canonicalUrl = value => {
    try {
      const url = new URL(value, 'https://www.mercadolivre.com.br');
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch { return null; }
  };
  const embeddedPrices = new Map(Object.entries(embeddedPriceMap)
    .filter(([, price]) => !price.currency || price.currency === 'BRL')
    .map(([url, price]) => [canonicalUrl(url), price]));
  const rawCards = await page.evaluate(() => {
    function getMoneyAmount(root) {
      // Read fraction/cents separately: innerText may concatenate 199 + 90 as 19990.
      const amounts = [];
      for (const money of root.querySelectorAll(".andes-money-amount")) {
        // Installment amounts are not a product's current or previous price.
        if (money.closest('[class*="installment"], [class*="financing"]')) continue;
        const fraction = money.querySelector('.andes-money-amount__fraction')?.textContent?.trim();
        const cents = money.querySelector('.andes-money-amount__cents')?.textContent?.trim();
        const text = fraction
          ? `${fraction}${cents ? `,${cents}` : ''}`
          : money.textContent?.trim();
        const original = !!money.closest('s, del, .andes-money-amount--previous, [class*="original-price"]');
        amounts.push({ text, original });
      }
      return {
        original: amounts.find(a => a.original)?.text || null,
        current: amounts.find(a => !a.original)?.text || null
      };
    }

    function getImage(root) {
      const img = root.querySelector("img");
      if (!img) return null;
      return img.src || img.getAttribute("data-src") || img.getAttribute("srcset")?.split(" ")?.[0] || null;
    }

    // tenta achar containers “de card”: elementos que contenham um link de produto + imagem
    const anchors = Array.from(document.querySelectorAll("a[href]"))
      .filter(a => a.href && /MLB-?\d{6,}/i.test(a.href) && /mercadolivre\.com\.br/.test(a.href));

    const cardSet = new Set();
    for (const a of anchors) {
      const knownCard = a.closest('.poly-card, .promotion-item, .ui-search-result');
      if (knownCard) {
        cardSet.add(knownCard);
        continue;
      }
      let el = a;
      for (let up = 0; up < 6 && el; up++) {
        const hasImg = !!el.querySelector?.("img");
        const t = (el.innerText || "").trim();
        // heurística: card tem imagem e algum texto
        if (hasImg && t.length >= 20) {
          cardSet.add(el);
          break;
        }
        el = el.parentElement;
      }
    }

    const cards = Array.from(cardSet).slice(0, 300);

    return cards.map((el, idx) => {
      const links = [el, ...el.querySelectorAll('a[href]')];
      const a = links.find(link => link.matches('a[href]') && /MLB-?\d{6,}/i.test(link.href));
      const href = a?.href || null;

      const title =
        el.querySelector("h2")?.innerText?.trim() ||
        el.querySelector("h3")?.innerText?.trim() ||
        a?.getAttribute("title") ||
        a?.innerText?.trim() ||
        null;

      const rawText = (el.innerText || "").trim();
      const img = getImage(el);

      // dinheiro/valores
      const money = getMoneyAmount(el);

      // frete grátis / parcelas / badge do próprio texto
      const freeShipping = /frete\s+gr[aá]tis/i.test(rawText);
      const installmentsMatch = rawText.match(/(\d{1,2}x)\s+de\s+R\$\s*[\d.]+(?:,\d{2})?/i);
      const installments = installmentsMatch ? installmentsMatch[0].trim() : null;

      const badge =
        (rawText.match(/oferta\s+rel[âa]mpago/i)?.[0]) ||
        (rawText.match(/deal\s+do\s+dia/i)?.[0]) ||
        (rawText.match(/últimas\s+unidades/i)?.[0]) ||
        (rawText.match(/estoque\s+limitado/i)?.[0]) ||
        null;

      return {
        position: idx + 1,
        href,
        title,
        img,
        rawText,
        money,
        freeShipping,
        installments,
        badge
      };
    });
  });

  // 3) Monta produtos finais com fallback “cirúrgico”
  const products = [];

  for (const c of rawCards) {
    let url = normalizeMercadoLivreUrl(buildAbsoluteUrl(c.href));
    if (!url) continue;

    // filtra não-produtos
    if (!isLikelyProductUrl(url)) continue;

    const title = pickFirstNonEmpty(c.title);
    if (!title) continue;

    const badTitles = new Set(["Pular para o conteúdo", "Todas"]);
    if (badTitles.has(title)) continue;

    const product_id = extractProductIdFromUrl(url);
    if (!product_id) continue; // força ficar só produto real

    // Explicit roles in the DOM; never infer the original price by ordering amounts.
    let price_original = toNumberFromBRL(c.money?.original);
    let price_current = toNumberFromBRL(c.money?.current);

    // (B) fallback: embedded JSON (ld+json) por URL (normaliza comparando sem query)
    if (price_current == null) {
      const hit = embeddedPrices.get(canonicalUrl(url));
      price_current = toNumberFromJson(hit?.current);
    }

    // Free-text prices can be installments or shipping. Do not guess from rawText.
    if (price_current == null) continue;
    if (price_original != null && price_original <= price_current) price_original = null;

    // desconto
    let discount_percent = null;
    const discMatch = (c.rawText || "").match(/\b(\d{1,2})\s*%\s*(?:OFF|de desconto)\b/i);
    if (discMatch) discount_percent = parseInt(discMatch[1], 10);
    if (discount_percent == null) {
      const calc = computeDiscountPercent(price_original, price_current);
      if (calc != null) discount_percent = calc;
    }

    products.push({
      source,
      captured_at: capturedAt,
      position: c.position,
      title,
      url,
      product_id,
      seller: null,
      price_original,
      price_current,
      discount_percent,
      installments: c.installments || null,
      free_shipping: !!c.freeShipping,
      image: c.img || null,
      rating: null,
      reviews_count: null,
      availability_badge: c.badge || null
    });
  }

  return products;
}

/* ---------------- dedupe ---------------- */

function dedupeProducts(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const key = p.product_id ? `id:${p.product_id}` : `url:${p.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/* ---------------- page runner ---------------- */

export async function scrapePage(context, { source, url }) {
  const page = await context.newPage();
  try {
    await page.setExtraHTTPHeaders({ "accept-language": "pt-BR,pt;q=0.9,en;q=0.8" });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!response || !response.ok()) {
      throw new Error(`Falha HTTP ${response?.status() ?? 'sem resposta'} ao abrir ${url}`);
    }
    if (/\/(?:login|account-verification|challenge|captcha)(?:[/?#]|$)/i.test(page.url())) {
      throw new Error(`A coleta foi redirecionada para uma verificação de acesso: ${page.url()}`);
    }
    await page.waitForTimeout(1500);
    try {
      const cookieBtn = page.locator("button:has-text('Aceitar'), button:has-text('Entendi'), button:has-text('Aceito')").first();
      if (await cookieBtn.isVisible()) await cookieBtn.click({ timeout: 1500 });
    } catch { /* Cookie banners are optional. */ }

    await page.locator('.andes-money-amount, script[type="application/ld+json"]').first()
      .waitFor({ state: 'attached', timeout: 15000 });
    await autoScroll(page);
    const products = dedupeProducts(await extractProducts(page, source));
    if (products.length === 0) {
      throw new Error('Nenhum produto com preço válido encontrado. Verifique o layout ou uma possível restrição de acesso.');
    }
    return { source, url, products };
  } finally {
    await page.close();
  }
}

export const targets = [
  { source: "deal_of_the_day", url: "https://www.mercadolivre.com.br/ofertas?promotion_type=deal_of_the_day" },
  { source: "lightning", url: "https://www.mercadolivre.com.br/ofertas?promotion_type=lightning" }
];

export async function scrapeTargets(context, selectedTargets = targets) {
  const pages = [];
  for (const target of selectedTargets) {
    try {
      pages.push(await scrapePage(context, target));
    } catch (error) {
      pages.push({ ...target, products: [], error: String(error?.message || error) });
    }
  }
  const all = dedupeProducts(pages.flatMap(page => page.products));
  return {
    site: "mercadolivre.com.br",
    captured_at: nowIso(),
    status: pages.length > 0 && pages.every(page => !page.error && page.products.length > 0) ? 'success' : 'failed',
    pages,
    total_products: all.length
  };
}

export function writeResult(output) {
  process.stdout.write(JSON.stringify(output, null, 2));
  for (const page of output.pages) {
    console.error(`[${page.source}] ${page.error || `${page.products.length} produtos coletados`}`);
  }
  if (output.status !== 'success' || output.total_products === 0) process.exitCode = 1;
}

export async function main() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const context = await browser.newContext({
      locale: 'pt-BR',
      viewport: { width: 1366, height: 768 }
    });
    try {
      writeResult(await scrapeTargets(context));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Falha na execução: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
