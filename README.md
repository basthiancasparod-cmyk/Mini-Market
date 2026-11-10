# Mini-Market — POS & Store Management (Ciervo Administrativo)

Point-of-sale and store management system for a small shop: sales (POS),
inventory with stock movements, customers, suppliers, accounts receivable,
purchases, price calculator, sales reports and a management dashboard.
Vanilla JavaScript + HTML/CSS with Firebase (Auth + Realtime Database) for
accounts and optional Cloud Sync. Data also lives in `localStorage`, so the
app keeps working offline and syncs when the account has Cloud Sync enabled.

Live site: https://ciervoadministrativo.shop (GitHub Pages, `main` branch)

## Stack

- Vanilla JavaScript (ES modules in single-file pages), HTML, CSS — no build step
- Firebase 8.10.0: Authentication + Realtime Database (client SDK via CDN)
- Node.js: local static server (`_servidor_pruebas.js`) and the test suites
- Playwright + TypeScript: browser end-to-end tests (`tests-e2e/`)

## How to run locally

```bash
node _servidor_pruebas.js   # serves http://127.0.0.1:5500 (first free port from 5500)
```

Open http://127.0.0.1:5500/index.html — that is the login page. The
dashboard is `menu.html`; the POS is `mini_market_pos.html`; inventory is
`inventario.html`; the price calculator is `calcular_precio_ven.html`;
the sales summary is `mini_market_pos_resumen.html`.

## Access / demo

There is **no demo account** in this repo. Real access needs a Firebase
Auth account that an admin has approved (`ingreso: true` in the owner
profile); a freshly created account cannot sign in until it is approved —
see the finding in `INFORME_PRUEBAS_NAVEGADOR.md` §5.2.

To explore the app without an account, the E2E suite runs in **local mode**:
it seeds the shared `sesionActiva` session mark in `localStorage` and two
test products in `ciervo_inventory`, blocks the Firebase/Google CDNs, and
the pages fall back to local data (see `tests-e2e/README.md`). No real
account is created and nothing is written to Firebase.

## Tests

- **Browser E2E (Playwright + TypeScript)** — `tests-e2e/`, suite MKT-01 to
  MKT-10: login page + validation, dashboard, inventory (render, create
  product with margin math, search), POS add-to-cart, price calculator,
  sales summary. Runs in local mode, no account, no Firebase writes.
  ```bash
  npm install
  npm run test:e2e
  ```
- **Node suites (existing)** — 21 files, `pruebas_*.js` (19) plus
  `_pruebas_*.js` (2): access, local account, session, menu, inventory,
  stock movements, sales engine, payment methods, sync, backups, and the
  browser suite `pruebas_navegador.js` (needs real Firebase test accounts
  via `PW_EMAIL_A` / `PW_EMAIL_B` env vars — see its header and
  `INFORME_PRUEBAS_NAVEGADOR.md`).
  ```bash
  node pruebas_sesion.js        # example: run one suite
  ```

## Audit reports

- `INFORME_PRUEBAS_NAVEGADOR.md` — real-browser validation report,
  including the documented finding that a newly created account cannot
  sign in under the deployed rules until an admin approves it.
- `AUDITORIA_ALMACENAMIENTO.md`, `AUDITORIA_DATOS_MUESTRA.md`,
  `AUDITORIA_REPLICACION_SYNC.md` — storage, sample-data and sync audits.
- `DISENO_MOTOR_OPERACIONES.md`, `DISENO_STOCK_MOVIMIENTOS.md` — design
  notes for the operations engine and stock movements.
- `MIGRACION_ACCESO.md`, `INFORME_INDICADOR_CONEXION.md` — access
  migration and connection-indicator notes.

## Repo notes

- The repo is served in full by GitHub Pages, so anything committed here
  becomes public. Test outputs, diagnostic probes and screenshots are
  git-ignored (see `.gitignore`) because they can contain real account
  emails and UIDs.
- A new inventory starts **empty** — sample data was neutralised on
  purpose (see `loadSampleData` in `inventario.html`).
