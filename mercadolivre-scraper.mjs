
import { chromium } from "playwright";

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

// parse BR money
function toNumberFromBRL(text) {
  if (!text) return null;

  let s = String(text)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\d.,-]/g, "");

  if (!s) return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  // Sem vírgula e com ponto => ponto é milhar (1.199, 12.990, 1.234.567)
  if (!hasComma && hasDot) {
    s = s.replace(/\./g, "");
  } else if (hasComma && hasDot) {
    // 1.234,56 -> 1234.56
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (hasComma && !hasDot) {
    // 1234,56 -> 1234.56
    s = s.replace(",", ".");
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(original, current) {
  if (original == null || current == null) return null;
  if (!(original > 0) || !(current > 0)) return null;
  if (current >= original) return 0;
  return Math.round(((original - current) / original) * 100);
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

async function extractProducts(page, source) {
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
  const rawCards = await page.evaluate(() => {
    function getMoneyAmount(root) {
      // captura valores de "andes-money-amount" (padrão ML)
      const moneyBlocks = Array.from(root.querySelectorAll(".andes-money-amount"));
      // retorna lista de valores em texto (ex.: "R$ 1.199", "R$ 698")
      const vals = moneyBlocks
        .map((mb) => mb.innerText?.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      return vals;
    }

    function getImage(root) {
      const img = root.querySelector("img");
      if (!img) return null;
      return img.src || img.getAttribute("data-src") || img.getAttribute("srcset")?.split(" ")?.[0] || null;
    }

    // tenta achar containers “de card”: elementos que contenham um link de produto + imagem
    const anchors = Array.from(document.querySelectorAll("a[href]"))
      .filter(a => a.href && /mercadolivre\.com\.br|produto\.mercadolivre\.com\.br/.test(a.href));

    const cardSet = new Set();
    for (const a of anchors) {
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
      const a = el.querySelector("a[href]");
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
      const moneyTexts = getMoneyAmount(el);

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
        moneyTexts,
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

    // (A) tenta pelo DOM money blocks
    let price_original = null;
    let price_current = null;

    const moneyTexts = Array.isArray(c.moneyTexts) ? c.moneyTexts : [];
    // Em geral o ML mostra: [preço riscado, preço atual] ou só [preço atual]
    if (moneyTexts.length >= 2) {
      price_original = toNumberFromBRL(moneyTexts[0]);
      price_current = toNumberFromBRL(moneyTexts[1]);
      // se por acaso inverter (às vezes o atual vem primeiro), corrige
      if (price_original != null && price_current != null && price_current > price_original) {
        const tmp = price_original;
        price_original = price_current;
        price_current = tmp;
      }
    } else if (moneyTexts.length === 1) {
      price_current = toNumberFromBRL(moneyTexts[0]);
    }

    // (B) fallback: embedded JSON (ld+json) por URL (normaliza comparando sem query)
    if (price_current == null) {
      const keyVariants = [
        url,
        url.split("?")[0],
        url.replace(/^https?:\/\/(www\.)?/, "https://")
      ];

      for (const k of keyVariants) {
        const hit = embeddedPriceMap?.[k];
        if (hit?.current) {
          price_current = toNumberFromBRL(hit.current) ?? parseFloat(hit.current);
          break;
        }
      }
    }

    // (C) último fallback: regex em rawText
    if (price_current == null || price_original == null) {
      const text = c.rawText || "";
      const priceMatches = Array.from(text.matchAll(/R\$\s*[\d.]+(?:,\d{2})?/g)).map(m => m[0]);

      if (price_original == null && price_current == null && priceMatches.length >= 2) {
        price_original = toNumberFromBRL(priceMatches[0]);
        price_current = toNumberFromBRL(priceMatches[1]);
        if (price_original != null && price_current != null && price_current > price_original) {
          const tmp = price_original;
          price_original = price_current;
          price_current = tmp;
        }
      } else if (price_current == null && priceMatches.length >= 1) {
        price_current = toNumberFromBRL(priceMatches[0]);
      }
    }

    // desconto
    let discount_percent = null;
    const discMatch = (c.rawText || "").match(/(\d{1,2})\s*%/);
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

async function scrapePage(context, { source, url }) {
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({
    "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);

  // cookies (se aparecer)
  try {
    const cookieBtn = page.locator("button:has-text('Aceitar'), button:has-text('Entendi'), button:has-text('Aceito')");
    if (await cookieBtn.first().isVisible({ timeout: 1500 })) {
      await cookieBtn.first().click({ timeout: 1500 });
      await page.waitForTimeout(700);
    }
  } catch {}

  await autoScroll(page);

  const products = await extractProducts(page, source);
  await page.close();

  return {
    source,
    url,
    products: dedupeProducts(products)
  };
}

/* ---------------- main ---------------- */

(async () => {
  const targets = [
    {
      source: "deal_of_the_day",
      url: "https://www.mercadolivre.com.br/ofertas?promotion_type=deal_of_the_day#filter_applied=promotion_type&filter_position=3&origin=qcat"
    },
    {
      source: "lightning",
      url: "https://www.mercadolivre.com.br/ofertas?promotion_type=lightning#filter_applied=promotion_type&filter_position=3&origin=qcat"
    }
  ];

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 }
  });

  const pages = [];
  for (const t of targets) {
    try {
      const result = await scrapePage(context, t);
      pages.push(result);
    } catch (e) {
      pages.push({
        source: t.source,
        url: t.url,
        products: [],
        error: String(e?.message || e)
      });
    }
  }

  await context.close();
  await browser.close();

  // dedupe global
  const all = dedupeProducts(pages.flatMap(p => p.products || []));

  const output = {
    site: "mercadolivre.com.br",
    captured_at: nowIso(),
    pages,
    total_products: all.length
  };

  // imprime SOMENTE JSON
  process.stdout.write(JSON.stringify(output, null, 2));
})();