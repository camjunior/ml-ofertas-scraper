import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { toNumberFromBRL, toNumberFromJson } from '../prices.mjs';

test('HTML: preserve Brazilian thousands and cents', () => {
  for (const [input, expected] of [['R$ 1.199,90', 1199.9], ['1.199', 1199], ['199,90', 199.9], ['R$\u00a0597,91', 597.91]]) {
    assert.equal(toNumberFromBRL(input), expected);
  }
  for (const input of ['', null, '199.90', '12x de R$ 19,90', '0', '-1', '199,90 39,90']) {
    assert.equal(toNumberFromBRL(input), null);
  }
});

test('JSON-LD: decimal point is not a thousands separator', () => {
  assert.equal(toNumberFromJson('199.90'), 199.9);
  assert.equal(toNumberFromJson(1199.9), 1199.9);
  for (const input of [null, true, '199,90', '199.90invalid', '', 0, -1, Infinity]) {
    assert.equal(toNumberFromJson(input), null);
  }
});

test('CLI: failed result exits 1, keeps stdout JSON and sends diagnostics to stderr', () => {
  const moduleUrl = new URL('../mercadolivre-scraper.mjs', import.meta.url).href;
  const run = output => spawnSync(process.execPath, ['--input-type=module', '-e', `import { writeResult } from ${JSON.stringify(moduleUrl)}; writeResult(${JSON.stringify(output)});`], { encoding: 'utf8' });
  const failed = run({ status: 'failed', total_products: 0, pages: [{ source: 'test', products: [], error: 'HTTP 403' }] });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).status, 'failed');
  assert.match(failed.stderr, /HTTP 403/);
  const success = run({ status: 'success', total_products: 1, pages: [{ source: 'test', products: [{}] }] });
  assert.equal(success.status, 0);
  assert.equal(JSON.parse(success.stdout).total_products, 1);
});
