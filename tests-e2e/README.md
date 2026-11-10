# Mini-Market E2E tests (Playwright + TypeScript)

Browser suite **MKT-01 to MKT-10**. Runs in **local mode: no account, no
Firebase writes**. It complements the existing Node suites (`pruebas_*.js`),
which are untouched.

## How to run

```bash
npm install
npm run test:e2e
```

The config starts the app's own static server (`node _servidor_pruebas.js`)
on http://127.0.0.1:5500 and runs the suite against it.

## How local mode works

Internal pages require the shared `sesionActiva` localStorage mark plus a
Firebase Auth check (`sesion.js`). Real login needs a Firebase account
approved by an admin, and there is **no demo account** in the repo, so the
suite does this instead (see `helpers.ts`):

1. External CDNs (Google Fonts, Firebase SDK) are blocked at the network
   layer, so `sesion.js` reports "sin-comprobacion" and the pages fall back
   to localStorage data instead of redirecting to the login page.
2. A minimal `window.firebase` stub is installed before page scripts run,
   so inline scripts that call `firebase.initializeApp()` /
   `firebase.database()` / `firebase.auth()` do not throw. The stub never
   talks to any server; its `auth()` returns an empty object on purpose,
   which is what makes `sesion.js` take the no-check path.
3. The session mark and two test products are seeded in `localStorage`
   before load (`ciervo_inventory`). No `datosDeCuenta` marker is set, so
   `datos_cuenta.js` stays in transparent mode and the plain keys are
   read as-is.

## Tests

| ID | Test |
|----|------|
| MKT-01 | Login page loads: email, password, login/register buttons |
| MKT-02 | Login validation: invalid email shows "Formato de email inválido" |
| MKT-03 | Login validation: password < 6 chars shows the length message |
| MKT-04 | Dashboard (menu) loads in local mode with its module cards |
| MKT-05 | Inventory renders the seeded products and stats match (2 products) |
| MKT-06 | Create product in the modal: cost 1.00 + 30% margin -> price 1.30, persisted in localStorage |
| MKT-07 | Inventory search filters the table by product name |
| MKT-08 | POS: search a product, add it to the cart, cart count 1, total updates |
| MKT-09 | Price calculator: cost 10 USD at 50% margin suggests 15.00 USD |
| MKT-10 | Sales summary loads in local mode with metrics and filters |

Notes on the tests:

- The login validation runs on `blur`, not on `input` — the tests blur
  the field after filling it. That is a real app behaviour, not a bug.
- A new inventory starts empty by design (sample data neutralised), so
  the suite seeds its own products; nothing it does depends on sample data.

## Deliberately NOT covered (needs a real Firebase test account)

- Real sign-in / registration and operator login (needs an approved
  Firebase Auth account — see `pruebas_navegador.js`, which uses
  `PW_EMAIL_A` / `PW_EMAIL_B`).
- Completing a sale / checkout (writes the sale to the cloud when sync is on).
- Cloud Sync, account approval, PDF import/export, backup restore.
- Run those from a machine with normal internet access, with a dedicated
  test account — never with a personal account.
