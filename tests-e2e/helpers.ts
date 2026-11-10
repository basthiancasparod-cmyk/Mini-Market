import { expect, Page } from '@playwright/test';

/**
 * Mini-Market E2E helpers — local mode, no account, no Firebase writes.
 *
 * How the app works: internal pages (menu, POS, inventory, reports) require
 * the shared `sesionActiva` localStorage mark plus a Firebase Auth check
 * (sesion.js). Real login needs a Firebase account approved by an admin, and
 * there is NO demo account in the repo, so the suite runs in local mode:
 *
 *  1. External CDNs (Google Fonts, Firebase SDK) are blocked at the network
 *     layer, so `sesion.js` reports "sin-comprobacion" and the pages fall back
 *     to localStorage data instead of redirecting to the login page.
 *  2. A minimal `window.firebase` stub is installed before page scripts run,
 *     so the inline scripts that call `firebase.initializeApp()` /
 *     `firebase.database()` / `firebase.auth()` do not throw. The stub never
 *     talks to any server; its `auth()` returns an empty object on purpose,
 *     which is what makes sesion.js take the no-check path.
 *  3. The session mark and the inventory are seeded in localStorage before
 *     load. No `datosDeCuenta` marker is set, so datos_cuenta.js stays in
 *     transparent mode and the plain keys are read as-is.
 *
 * Anything that needs a real Firebase account (real sign-in / registration,
 * operator login, Cloud Sync, account approval) is NOT covered here and needs
 * a dedicated test account on a machine with normal internet access.
 */

export const QA_EMAIL = 'qa-local@example.com';

export interface QaProduct {
  id: number;
  name: string;
  code: string;
  brand: string;
  category: string;
  cost: number;
  price: number;
  stock: number;
  minStock: number;
  isBulk: boolean;
  emoji: string;
}

export const SEED_PRODUCTS: QaProduct[] = [
  {
    id: 1,
    name: 'Arroz Blanco 1kg',
    code: 'QA-ARROZ-001',
    brand: 'Ciervo',
    category: 'Alimentos',
    cost: 0.8,
    price: 1.2,
    stock: 50,
    minStock: 5,
    isBulk: false,
    emoji: '🍚',
  },
  {
    id: 2,
    name: 'Aceite Vegetal 1L',
    code: 'QA-ACEITE-002',
    brand: 'Ciervo',
    category: 'Alimentos',
    cost: 2.0,
    price: 3.0,
    stock: 30,
    minStock: 5,
    isBulk: false,
    emoji: '🫙',
  },
];

const FIREBASE_STUB = `(() => {
  if (window.firebase) return;
  const refStub = () => ({
    once: async () => ({ val: () => null, exists: () => false }),
    on: () => {},
    set: async () => {},
    update: async () => {},
    orderByChild: () => ({ equalTo: () => refStub() }),
  });
  window.firebase = {
    apps: [],
    initializeApp: () => {},
    database: () => ({ ref: refStub }),
    auth: () => ({}),
  };
})();`;

/** Block external CDNs and install the local-mode Firebase stub. */
export async function setupLocalMode(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (
      url.includes('googleapis.com') ||
      url.includes('gstatic.com') ||
      url.includes('fonts.gstatic.com')
    ) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.addInitScript(FIREBASE_STUB);
}

/** Seed the shared session mark (what sesion.js requires) before load. */
export async function seedSession(page: Page, email = QA_EMAIL): Promise<void> {
  await page.addInitScript(
    (data: { email: string }) => {
      localStorage.setItem(
        'sesionActiva',
        JSON.stringify({ email: data.email, uid: 'local-qa', desde: new Date().toISOString() }),
      );
      sessionStorage.setItem('propietarioActual', data.email);
      sessionStorage.setItem(
        'currentOwner',
        JSON.stringify({ email: data.email, uid: 'local-qa', id: 'local-qa' }),
      );
    },
    { email },
  );
}

/** Seed the inventory (plain key; datos_cuenta.js stays in transparent mode). */
export async function seedInventory(page: Page, products: QaProduct[] = SEED_PRODUCTS): Promise<void> {
  await page.addInitScript(
    (data: QaProduct[]) => {
      localStorage.setItem('ciervo_inventory', JSON.stringify(data));
    },
    products,
  );
}

/** Full local-mode setup for an internal page: block CDNs, seed session + inventory. */
export async function gotoLocal(page: Page, path: string, products?: QaProduct[]): Promise<void> {
  await setupLocalMode(page);
  await seedSession(page);
  await seedInventory(page, products);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
}

/** Read the seeded inventory back from localStorage. */
export async function readInventory(page: Page): Promise<QaProduct[]> {
  const raw = await page.evaluate(() => localStorage.getItem('ciervo_inventory'));
  return raw ? (JSON.parse(raw) as QaProduct[]) : [];
}

export { expect };
