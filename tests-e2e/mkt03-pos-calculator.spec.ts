import { expect, test } from '@playwright/test';
import { gotoLocal } from './helpers';

/**
 * MKT-08 — POS: search a seeded product, add it to the cart from the
 *           quantity modal, cart count becomes 1 and the total updates.
 * MKT-09 — Price calculator (ungated page): cost 10 USD at 50% margin
 *           suggests a 15.00 USD sale price.
 * MKT-10 — Sales summary loads in local mode with its metrics and filters.
 *
 * Completing a sale (payment / checkout) is NOT covered: it writes the sale
 * to the cloud when sync is on and needs a real account. See README.
 */

test('MKT-08 — POS: add a searched product to the cart', async ({ page }) => {
  await gotoLocal(page, '/mini_market_pos.html');
  await page.fill('#searchInput', 'Arroz');
  const product = page.locator('.product-item', { hasText: 'Arroz Blanco 1kg' }).first();
  await expect(product).toBeVisible();
  await product.click();
  // Quantity modal: confirm the default quantity of 1.
  await expect(page.locator('#modalQuantity')).toBeVisible();
  await page.locator('button', { hasText: 'Agregar' }).first().click();
  await expect(page.locator('#cartCount')).toHaveText('1');
  await expect(page.locator('#cartItems')).toContainText('Arroz Blanco 1kg');
  // 1 unit at 1.20 USD, IVA on: the total must be greater than zero.
  const total = await page.locator('#total').textContent();
  expect(total).toBeTruthy();
  expect(total).not.toContain('0,00');
});

test('MKT-09 — price calculator: cost 10 at 50% margin suggests 15.00', async ({ page }) => {
  await gotoLocal(page, '/calcular_precio_ven.html');
  await page.fill('#productName', 'Arroz Blanco 1kg');
  await page.fill('#costAmount', '10');
  await page.fill('#profitMargin', '50');
  await page.locator('button', { hasText: 'Calcular Precio' }).click();
  await expect(page.locator('#resultsContainer')).toBeVisible();
  await expect(page.locator('#suggested-price-usd')).toContainText('15');
});

test('MKT-10 — sales summary loads in local mode', async ({ page }) => {
  await gotoLocal(page, '/mini_market_pos_resumen.html');
  await expect(page.locator('h1')).toContainText('Resumen de Ventas');
  await expect(page.locator('#metricsGrid')).toBeVisible();
  await expect(page.locator('#searchInput')).toBeVisible();
  await expect(page.locator('#dateFrom')).toBeVisible();
  await expect(page.locator('#dateTo')).toBeVisible();
});
