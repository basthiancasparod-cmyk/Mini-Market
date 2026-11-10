import { expect, test } from '@playwright/test';
import { gotoLocal, readInventory } from './helpers';

/**
 * MKT-04 — Dashboard (menu) loads in local mode with its module cards.
 * MKT-05 — Inventory renders the seeded products and the stats match.
 * MKT-06 — Create a product through the modal: price is computed from
 *           cost + margin (cost 1.00, margin 30% -> price 1.30) and the
 *           product is persisted in localStorage.
 * MKT-07 — Inventory search filters the table by name.
 */

test('MKT-04 — dashboard loads in local mode with module cards', async ({ page }) => {
  await gotoLocal(page, '/menu.html');
  await expect(page.locator('#dashboard-module')).toBeVisible();
  await expect(page.locator('#operacionesModuleCard')).toBeVisible();
  await expect(page.locator('#inventarioModuleCard')).toBeVisible();
  await expect(page.locator('#salesSummaryModuleCard')).toBeVisible();
});

test('MKT-05 — inventory renders seeded products and stats', async ({ page }) => {
  await gotoLocal(page, '/inventario.html');
  await expect(page.locator('#totalProducts')).toHaveText('2');
  await expect(page.locator('#inventoryTableBody')).toContainText('Arroz Blanco 1kg');
  await expect(page.locator('#inventoryTableBody')).toContainText('Aceite Vegetal 1L');
});

test('MKT-06 — create product: margin math is applied and it persists', async ({ page }) => {
  await gotoLocal(page, '/inventario.html');
  await expect(page.locator('#totalProducts')).toHaveText('2');

  await page.locator('button', { hasText: 'Nuevo Producto' }).first().click();
  await expect(page.locator('#productModal')).toBeVisible();
  await page.fill('#productName', 'Harina de Maíz 1kg');
  await page.fill('#productCode', 'QA-HARINA-003');
  await page.fill('#productCost', '1.00');
  await page.fill('#productMargin', '30');
  await page.fill('#productStock', '40');
  // Cost 1.00 with a 30% margin must compute a 1.30 sale price.
  await expect(page.locator('#productPrice')).toHaveValue('1.30');
  await page.click('#saveButton');

  await expect(page.locator('#totalProducts')).toHaveText('3');
  await expect(page.locator('#inventoryTableBody')).toContainText('Harina de Maíz 1kg');
  const stored = await readInventory(page);
  expect(stored).toHaveLength(3);
  const created = stored.find((p) => p.code === 'QA-HARINA-003');
  expect(created).toBeDefined();
  expect(Number(created!.price)).toBeCloseTo(1.3, 2);
  expect(Number(created!.stock)).toBe(40);
});

test('MKT-07 — inventory search filters by product name', async ({ page }) => {
  await gotoLocal(page, '/inventario.html');
  await expect(page.locator('#inventoryTableBody')).toContainText('Arroz Blanco 1kg');
  await page.fill('#searchInput', 'Aceite');
  await expect(page.locator('#inventoryTableBody')).toContainText('Aceite Vegetal 1L');
  await expect(page.locator('#inventoryTableBody')).not.toContainText('Arroz Blanco 1kg');
});
