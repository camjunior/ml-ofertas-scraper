// HTML uses Brazilian formatting; JSON-LD uses decimal numbers. Never mix them.
export function toNumberFromBRL(value) {
  if (value == null) return null;
  const text = String(value).replace(/R\$/g, '').replace(/\s/g, '');
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text)) return null;
  const number = Number(text.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function toNumberFromJson(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!/^\d+(?:\.\d+)?$/.test(String(value).trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function computeDiscountPercent(original, current) {
  if (!(original > 0) || !(current > 0) || current >= original) return null;
  return Math.round(((original - current) / original) * 100);
}
