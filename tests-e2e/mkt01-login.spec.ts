import { expect, test } from '@playwright/test';
import { setupLocalMode } from './helpers';

/**
 * MKT-01 — Login page loads with the owner auth form.
 * MKT-02 — Owner login, invalid email shows the inline validation message.
 * MKT-03 — Owner login, short password shows the inline validation message.
 *
 * Real sign-in / registration is NOT tested here: it needs a Firebase Auth
 * account approved by an admin, and there is no demo account in the repo.
 * These tests only cover the client-side validation that runs before any
 * network call (see tests-e2e/README.md).
 */

test.beforeEach(async ({ page }) => {
  await setupLocalMode(page);
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
});

test('MKT-01 — login page loads with email, password and auth buttons', async ({ page }) => {
  await expect(page).toHaveTitle(/Iniciar Sesión/);
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('#password')).toBeVisible();
  await expect(page.locator('#loginButton')).toBeVisible();
  await expect(page.locator('#registerButton')).toBeVisible();
});

test('MKT-02 — invalid email shows "Formato de email inválido"', async ({ page }) => {
  await page.fill('#email', 'no-es-un-email');
  await page.locator('#email').blur(); // validation runs on blur, not on input
  await expect(page.locator('#email-message')).toContainText('Formato de email inválido');
});

test('MKT-03 — password shorter than 6 chars shows the length message', async ({ page }) => {
  await page.fill('#password', '12345');
  await page.locator('#password').blur(); // validation runs on blur, not on input
  await expect(page.locator('#password-message')).toContainText('al menos 6 caracteres');
});
