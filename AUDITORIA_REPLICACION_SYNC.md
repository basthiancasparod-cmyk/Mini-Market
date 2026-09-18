# Auditoría de replicación del patrón de sincronización cloud

**Repositorio:** `C:\Users\FOLGORESB\Documents\Ciervo_Mini_Market\Mini-Market-GH`
**Alcance:** `inventario.html`, `catalogo.html`, `compras.html`, `cuentas.html`, `config_recibo.html`, `gestion_empresa.html`, `gestion_proveedores.html`, `listado_clientes.html`, `mini_market_pos.html`, `mini_market_pos_resumen.html` + `cloud-access.js` + `sincronizacion.js`.
**Modo:** solo lectura. No se modificó ningún archivo existente de la aplicación; este informe es el único archivo creado por esta auditoría.
**Método:** lectura estática del código. Números de línea **verificados con búsqueda textual sobre la instantánea declarada abajo**; no se ejecutó la aplicación ni se consultó Firebase.

> ## ⚠️ AVISO: el repositorio cambió durante la auditoría
>
> Mientras se realizaba esta auditoría, **otro proceso modificó los archivos auditados** (no fue esta auditoría). Cambios observados:
>
> | Hora | Cambio |
> |---|---|
> | 18:15:46 | Aparece el archivo nuevo **`sincronizacion.js`** (capa de cola de pendientes "FASE_A_SYNC_V1") |
> | 18:15:54 | Se inserta `<script src="sincronizacion.js"></script>` en **las 10 páginas** (+1 línea en cada una) |
> | 18:16:58 | **`mini_market_pos.html`**: +3.291 bytes, migrado a la nueva cola (usa `marcarPendienteSync`, `limpiarPendienteSync`, `hayPendientesSync`, `puedeSobrescribirLocalSync`) |
> | 18:17:14 | **`inventario.html`**: migrado a la nueva cola |
>
> **Estado en esta instantánea: 2 páginas migradas (inventario, POS) y 8 páginas que solo recibieron la etiqueta `<script>` (su código de sync sigue siendo el antiguo).** Los hallazgos de este informe describen ese estado mixto. Si el proceso paralelo continúa, las secciones referidas a las 8 páginas no migradas seguirán siendo válidas (su código no cambió salvo el desplazamiento de +1 línea), pero las de `inventario.html` y `mini_market_pos.html` quedarán obsoletas.
>
> **Instantánea exacta (18:18:51 del 2026-09-18), SHA-256 truncado a 12 dígitos:**
>
> | Archivo | SHA-256 | Modificado |
> |---|---|---|
> | `inventario.html` | `DECC7250E3EF` | 18:17:14 |
> | `mini_market_pos.html` | `2886AFD2E98A` | 18:16:58 |
> | `catalogo.html` | `72F9A06D16FA` | 18:15:54 |
> | `compras.html` | `B5E72916AA90` | 18:15:54 |
> | `cuentas.html` | `C4B74F0E2199` | 18:15:54 |
> | `config_recibo.html` | `85E599ABDBF7` | 18:15:54 |
> | `gestion_empresa.html` | `6C61B76DD7D2` | 18:15:54 |
> | `gestion_proveedores.html` | `BAA72A6F9665` | 18:15:54 |
> | `listado_clientes.html` | `C79108A23FD9` | 18:15:54 |
> | `mini_market_pos_resumen.html` | `184E1F2845B0` | 18:15:54 |
> | `cloud-access.js` | `1DA5DBE4B132` | 11:27:25 |
> | `sincronizacion.js` | `8CB8EC0EFF3F` | 18:15:46 |

> **Convención:** "P1…P9" = los 9 puntos pedidos. "Listener de conexión" = `db.ref('.info/connected').on('value', …)`. "Listener de datos" = `db.ref(<nodo de datos>).on('value', …)`. "MIGRADO" marca las páginas que ya usan `sincronizacion.js`.

---

## 0. Resumen ejecutivo

1. **El patrón NO es idéntico entre las 10 páginas.** Coexisten 4 arquetipos: (a) *subida de arreglo completo + bandera de pendientes + listener de datos*; (b) *solo subida* (`catalogo.html`); (c) *descarga con la nube como autoridad y sin bandera* (`cuentas`, `gestion_empresa`, `config_recibo`, `listado_clientes`, `mini_market_pos_resumen`); (d) *operaciones por identificador sin bandera* (`gestion_proveedores`). Ver §2 y §3.
2. **Hay TRES capas de sincronización simultáneas en la instantánea**: `cloud-access.js` (31 líneas, **anulada en las 10 páginas**), `sincronizacion.js` (133 líneas, **usada solo por 2 páginas**) y las copias locales de cada página (**las 10**). Ver §1.
3. **`cloud-access.js` es código muerto en las 10 páginas.** Todas definen su propia `checkCloudAccess()` como declaración de función de nivel superior en un `<script>` clásico posterior, lo que sustituye el `window.checkCloudAccess` asignado en `cloud-access.js:6`. Ningún HTML del repositorio llama a la versión central (0 referencias fuera de esas 10 páginas). El caché `sessionStorage['cloudSync']` de `cloud-access.js:9-10,22-23` **nunca se lee**, y la llamada a `window.setupConnectionMonitor` de `cloud-access.js:24-26` **nunca se ejecuta**.
4. **`setupConnectionMonitor` sigue sin invocarse en ninguna de las 10 páginas, ni siquiera tras la migración.** Está definido en 8 (`inventario.html:2288`, `compras.html:2321`, `cuentas.html:1414`, `gestion_empresa.html:1588`, `gestion_proveedores.html:1531`, `listado_clientes.html:1045`, `mini_market_pos.html:4785`, `mini_market_pos_resumen.html:2797`) y **la única invocación del repositorio es `gestion_usuario.html:2027`**, página fuera del alcance. El reintento "al reconectar" es código muerto en las 10 páginas; solo queda el reintento en la carga inicial.
5. **En las 8 páginas no migradas persiste el fallo de red que desactiva la nube toda la sesión**: `_cloudAccessChecked` se pone en `true` también en el `catch` (`catalogo.html:757-759`, `compras.html:2283-2285`, `cuentas.html:1468-1470`, `config_recibo.html:723-725`, `gestion_empresa.html:1642-1644`, `gestion_proveedores.html:1582-1584`, `listado_clientes.html:1004-1006`, `mini_market_pos_resumen.html:2766-2768`). **`inventario.html:2247-2249` y `mini_market_pos.html:4675-4677` ya lo corrigen** (Fase A: no cachean el fallo).
6. **Cuatro páginas siguen escribiendo la clave compartida `_pendingFirebaseChanges`** (`inventario`, `catalogo`, `compras`, `mini_market_pos`). El borrado de esa clave ahora ocurre además en `sincronizacion.js:74` vía `limpiarPendienteSync`, y **`inventario.html:2456`/`mini_market_pos.html:4986` la disparan**: una subida exitosa de inventario o del POS **borra la marca de pendientes de compras y de catalogo**, que solo saben expresarse con la clave antigua. Ver §5-A y R2 (riesgo vigente).
7. **El nuevo `sincronizacion.js` convive mal con las 8 páginas no migradas**: `marcarPendienteSync` escribe la marca antigua (`sincronizacion.js:66`), de modo que guardar en inventario/POS hace que compras o catalogo crean que tienen pendientes y **suban su estado local sin descargar** (`compras.html:2095-2096`, `catalogo.html:821-824`). Ver R1.
8. **No existe cola de operaciones con marca de tiempo en el código antiguo** (solo booleanos). La nueva capa sí guarda un **timestamp de módulo** (`sincronizacion.js:65`), pero **nadie lo usa todavía**: `subirConMarcaSync` (`sincronizacion.js:112-122`) no se invoca en ninguna página.
9. **No hay exportación/importación de respaldo en JSON en ninguna página** (§5-D).
10. **Dos nodos distintos para "proveedores"**: `gestion_proveedores.html:1641` escribe `/proveedores` (claves `push`) y `compras.html:2375` escribe `/compras/proveedores` (arreglo con `id` numérico), compartiendo la clave local `ciervo_suppliers`.

---

## 1. Las tres capas de sincronización

### 1.1 `cloud-access.js` — 31 líneas, anulada en las 10 páginas

```js
 3  const CACHE_KEY = 'cloudSync';
 4  const EMAIL_KEY = 'cloudSyncEmail';
 6  window.checkCloudAccess = async function () {
 9      const cached = sessionStorage.getItem(CACHE_KEY);
10      if (sessionStorage.getItem(EMAIL_KEY) === email && (cached === 'true' || cached === 'false')) return cached === 'true';
19      allowed = (await database.ref('BBDD/' + safeEmail + '/suscripcion/cloudSync').once('value')).val() === true;
21      } catch (_) { allowed = false; }
22      sessionStorage.setItem(EMAIL_KEY, email);
23      sessionStorage.setItem(CACHE_KEY, String(allowed));
24      if (allowed && database && typeof window.setupConnectionMonitor === 'function') {
25          window.setupConnectionMonitor(database);
```

Se carga en el `<head>` de las 10 páginas (`inventario.html:8`, `catalogo.html:12`, `compras.html:8`, `cuentas.html:8`, `config_recibo.html:8`, `gestion_empresa.html:8`, `gestion_proveedores.html:8`, `listado_clientes.html:8`, `mini_market_pos.html:9`, `mini_market_pos_resumen.html:8`) y todas definen después, en un `<script>` **clásico**, su propia `async function checkCloudAccess()`. Una declaración de función de nivel superior en un script clásico se resuelve contra el objeto global y **sustituye** el valor previamente asignado en `window.checkCloudAccess`, porque el script en línea se evalúa después. Consecuencias verificables:

- El caché de sesión de `cloud-access.js:9-10,22-23` **no se usa** en ninguna página.
- La cadena `cloud-access.js:24-26` → `setupConnectionMonitor` **no se dispara nunca**.
- `mini_market_pos.html:4740-4741` e `index.html:1816-1817` borran `sessionStorage['cloudSync']`/`['cloudSyncEmail']` "para que cloud-access.js lea el valor fresco": ese borrado es **inocuo** en esas páginas.
- La única página que usaría la versión central sería una que no definiera la suya; ninguna lo hace. `gestion_usuario.html:2013-2018` define un `setupConnectionMonitor` (invocado en `:2027`) pero **no llama a `checkCloudAccess`**.

*No se puede confirmar en el código la intención* (si `cloud-access.js` debía centralizar y la migración quedó incompleta). Lo verificable es que su comportamiento efectivo es nulo.

### 1.2 `sincronizacion.js` — capa nueva "FASE_A_SYNC_V1", usada solo por 2 páginas

Resumen de lo que implementa:

| Elemento | Línea | Qué hace |
|---|---|---|
| `PREFIJO = '_pendSync_'` | `:27` | Clave por módulo y negocio: `_pendSync_<módulo>_<email normalizado>` (`claveDe` `:46-48`) |
| `MODULOS_CONOCIDOS` | `:29` | `inventario, compras, catalogo, cuentas, clientes, proveedores, empresa, pos, resumen` |
| `window.marcarPendienteSync(modulo)` | `:64-67` | Escribe la clave del módulo con **timestamp ISO** (`:65`) **y además** `_pendingFirebaseChanges = 'true'` (`:66`, compatibilidad) |
| `window.limpiarPendienteSync(modulo)` | `:72-75` | Borra la clave del módulo (`:73`) **y borra `_pendingFirebaseChanges`** (`:74`) |
| `window.hayPendientesSync(modulo)` | `:78-86` | Con módulo: su clave o la marca antigua; sin módulo: cualquier módulo del negocio |
| `window.pendientesSync()` | `:89-101` | Lista los módulos con pendientes del negocio actual |
| `window.puedeSobrescribirLocalSync()` | `:106-108` | `!hayPendientesSync()`: solo se puede pisar lo local si **nada** está pendiente |
| `window.subirConMarcaSync(modulo, subir)` | `:112-122` | Marca antes, limpia solo si el servidor confirma; **no se invoca en ninguna página** |
| Migración (IIFE) | `:126-132` | Si `_pendingFirebaseChanges === 'true'` y **no hay** claves por módulo, marca **los 9 módulos** con el valor `'migrado'` |

**Quién lo usa (instantánea):**

| Página | Usa `sincronizacion.js` | Evidencia |
|---|---|---|
| `inventario.html` | **Sí (migrada)** | `hayPendientesSync` `:2256-2257`, `:2298`; `marcarPendienteSync` `:2306`,`:2459`,`:2752`,`:2943`; `limpiarPendienteSync` `:2303`,`:2456`,`:2755`,`:2946`; `puedeSobrescribirLocalSync` `:2387`,`:2499` |
| `mini_market_pos.html` | **Sí (migrada)** | `hayPendientesSync` `:4652-4653`, `:4794`; `marcarPendienteSync` `:4118`,`:4197`,`:4804`,`:4989`; `limpiarPendienteSync` `:4121`,`:4200`,`:4801`,`:4986`; `puedeSobrescribirLocalSync` `:2059`,`:4915` |
| las otras 8 | **No** (solo reciben la etiqueta `<script>`; su código no la llama) | ausencia total de las funciones en el archivo |

**Problemas de la convivencia entre capas (detalle en §6):** `marcarPendienteSync` escribe la marca antigua (`:66`) y `limpiarPendienteSync` la borra (`:74`), de modo que las 8 páginas no migradas — que solo entienden esa marca — quedan acopladas a las 2 migradas de forma peligrosa en ambos sentidos (R1 y R2).

---

## 2. Matriz comparativa por página (estado actual)

Leyenda: **L** = copia local de `checkCloudAccess` que lee `suscripcion/cloudSync`; **muerto** = definido pero nunca invocado; **MIGRADA** = ya usa `sincronizacion.js`.

| Página | P1 permiso | P2 caché `_cloudAccessChecked` (¿false pegajoso?) | P3 claves localStorage | P4 nodos escritos / operación | P5 pendientes: marcar / limpiar | P6 `.info/connected` | P7 listener de datos | P8 re-marca al fallar / avisa | P9 orden en la carga inicial |
|---|---|---|---|---|---|---|---|---|---|
| `inventario.html` **MIGRADA** | L `:2233-2251`, lee `:2244`; **comprueba `.info/connected`** `:2242` | `:2230`,`:2234`,`:2239`; **no pegajoso**: el `catch` `:2247-2249` no marca `checked` | `ciervo_inventory` `:2365`,`:2396`,`:2442`,`:2902`,`:2938`; `ciervo_categories` `:2727`,`:2749`,`:2407`; `_pendingFirebaseChanges` `:2258`; `theme` `:4541`,`:4546` | `/productos` `.set` `:2344`; `/categorias` `.set` `:2352` | `marcarPendienteSync('inventario')` `:2306`,`:2459`,`:2752`,`:2943`; `limpiarPendienteSync` `:2303`,`:2456`,`:2755`,`:2946` (y con ello borra `_pendingFirebaseChanges`) | Definido `:2288`, guarda `:2289`, re-consulta el permiso `:2296-2297`, **muerto** | Sí `/productos` `:2433` (guarda `:2425-2426`); fusiona; **escribe LS** `:2442` | Sí: `catch` `:2458-2461` marca; subida `:2454-2456` solo limpia si `subidaProductos/​subidaCategorias`; aviso al usuario **solo** `file:` | **Bandera** `:2496` → sube; si algo pendiente de otro módulo `:2499-2501` punto ámbar; si no, baja `:2503` |
| `catalogo.html` | L `:747-761`, lee `:754` | **Sí** `:744`,`:753`,`:759` (catch `:757` → pegajoso) | `ciervo_inventory` `:989`,`:1006`; `_pendingFirebaseChanges` `:787` borra, `:791` marca, `:821` lee; var. módulo `:722`; `darkMode` `:1182`,`:1187` | `/productos` `.set` **completo** `:785` | `localStorage.setItem('_pendingFirebaseChanges','true')` `:791`; **`removeItem` `:787` (VIVO)** | **No existe** | **No existe** (nunca descarga) | Marca en `:790-791`; **ningún aviso** | **Solo reintento de subida** si la marca es `'true'` `:821-824`; **nunca descarga** |
| `compras.html` | L `:2273-2287`, lee `:2280` | **Sí** `:2270`,`:2279`,`:2285` (catch `:2283`) | `ciervo_suppliers` `:2154`,`:2177`,`:2422`; `ciervo_purchases` `:2162`,`:2178`,`:2428`; `ciervo_inventory_history` `:2168`,`:2179`,`:2434`; `ciervo_inventory` `:2209`,`:2941`; `ciervo_categories` **solo lectura** `:2199`; `theme` `:2219`,`:2231`; `_pendingFirebaseChanges` `:2291`,`:2330`,`:2337`,`:2186`,`:2946` | `/compras/proveedores` `.set` `:2375`; `/compras/compras` `.set` `:2382`; `/compras/historial` `.set` `:2389`; `/productos` `.set` `:2396`; `/categorias` `.set` `:2403` (**nunca llamada**) | `setItem('_pendingFirebaseChanges','true')` `:2186`,`:2946`,`:2337`; `removeItem` `:2330` (**muerto**) | Definido `:2321`, guarda `:2322`, **muerto** | **No existe** | Marca en `catch` `:2184-2187` y `:2944-2947`; aviso solo `file:`; `uploadToFirebase` `:2455-2458` **no re-marca** | **Bandera** `:2095` → sube; si no, baja `:2098`; si no hay datos, sube `:2100` |
| `cuentas.html` | L `:1458-1472`, lee `:1465` | **Sí** `:1455`,`:1464`,`:1470` (catch `:1468`) | `ciervo_accounts` `:1422`,`:1501`,`:1557`,`:1588`; `_pendingFirebaseChanges_cuentas` `:1420`,`:1482`,`:1486`; `theme` `:2273`,`:2278` | `/cuentas` `.set` **arreglo completo** `:1481` | Clave **propia**: `setItem(...,'true')` `:1486`; `removeItem` `:1482` | Definido `:1414`, guarda `:1415`, **muerto** | **No existe** | Marca en `catch` `:1484-1487`; **solo `console.error`**; **no marca si el permiso es false** `:1476` | `loadAccounts()` local `:1523` + `loadAccountsAsync()` `:1524` → **baja y reemplaza** `:1575-1585`, **sin mirar pendientes** |
| `config_recibo.html` | L `:713-727`, lee `:720` | **Sí** `:710`,`:719`,`:725` (catch `:723`) | `companyData` `:740`,`:758`,`:783`; `receiptSettings` `:814`,`:1047`; `theme` `:975`,`:980` | **Ninguno** (solo lee `.once` `:737`, `.on` `:755`) | **Sin bandera** | **No definido** | Sí `/empresa` `:755`: **reemplaza** LS `:758` y memoria `:759`; sin fusión | N/A (no sube) | Local `:783-797` y luego **la nube sobreescribe** `:798-803`; sin condición de pendientes |
| `gestion_empresa.html` | L `:1632-1646`, lee `:1639` | **Sí** `:1629`,`:1638`,`:1644` (catch `:1642`) | `companyData` `:1596`,`:1675`,`:1835`,`:1978`; `_pendingFirebaseChanges_empresa` `:1594`,`:1656`,`:1660`; `darkMode` `:2049`,`:2053`,`:2069` | `/empresa` `.set` **objeto completo** `:1655` | Clave **propia**: `setItem(...,'true')` `:1660`; `removeItem` `:1656` | Definido `:1588`, guarda `:1589`, **muerto** | **No existe** | Marca en `catch` `:1658-1661`; **sí avisa**: "Guardado local. Datos pendientes de sincronizar con la nube." `:1981`; **no marca si el permiso es false** `:1650` | Local `:1835-1844` y luego **la nube sobreescribe** `:1845-1851`, **sin mirar pendientes** |
| `gestion_proveedores.html` | L `:1572-1586`, lee `:1579` con `getEmailPath` (**minúsculas**) | **Sí** `:1569`,`:1578`,`:1584` (catch `:1582`) | `ciervo_suppliers` `:1616`,`:1635`,`:1649`,`:1659`; `darkMode` `:1709`,`:1724` | `/proveedores`: `.push()` `:1639` + `.set()` `:1641`; `.update()` por id `:1653`; `.remove()` por id `:1663` | **Sin bandera** | Definido `:1531`, guarda `:1532`, **muerto** (solo el punto `:1535`) | **No existe** | **No re-marca (no hay bandera)**; `alert` `:2006`/`:2012`; un fallo de `.set()` **descarta el proveedor** (no va ni a LS) | `await loadSuppliersFromFirebase()` `:1676`: con permiso la nube **reemplaza** todo `:1620-1622`; sin permiso lee LS `:1616` |
| `listado_clientes.html` | L `:994-1008`, lee `:1001` | **Sí** `:991`,`:1000`,`:1006` (catch `:1004`) | `ciervo_clients` `:1101`,`:1237`; `darkMode` `:1203`,`:1218` | `/clientes/{_key}` **`.update()` parcial** `:1242` | **Sin bandera** | Definido `:1045`, guarda `:1046`, **muerto** (solo el punto) | Sí `/clientes` `:1106` (guarda `:1100-1103`): **reemplazo total en memoria**, **no escribe LS** | **No re-marca**; **solo `console.error`** `:1248-1250` | Sin permiso: LS `:1101`; con permiso: **solo listener** `:1104-1111` |
| `mini_market_pos.html` **MIGRADA** | L `:4659-4679`, lee `:4672`; **comprueba `.info/connected`** `:4670` | `:4656`,`:4660`,`:4665`; **no pegajoso**: `catch` `:4675-4677` no marca `checked` | `_pendingFirebaseChanges` `:4654`; `pos_sales` `:4110`,`:4828`,`:4933`; `ciervo_inventory` `:2078`,`:4183`,`:4194`,`:4799`,`:4893`,`:4924`,`:4964`; `ciervo_categories` `:2100`,`:4928`; `companyData` `:4441`,`:4755`,`:4975`; `pos_last_sale_number` `:1959`,`:1978`,`:4856`,`:4937`,`:4939`; `pos_device_id` `:1964`,`:1970`; `pos_held_carts` `:1992`,`:2381`; `pos_apply_iva` `:2031`,`:2038`; `pos_exchange_rate` `:1891`,`:3515`,`:3703`; `pos_exchange_rate_${rateSource}` `:2363`,`:3516`; `pos_exchange_rate_bcv` `:3661`; `pos_rate_mode` `:1892`,`:3647`,`:3694`; `pos_rate_source` `:1893`,`:3649`,`:3711`; `pos_rate_trend_window` `:3220`,`:3467`; `pos_rate_history` / `pos_rate_history_seed` (`RATE_HISTORY_KEY` `:3208`/`:3209`) `:3226`,`:3236`,`:3290`,`:3365`; `receiptSettings` `:4439`; `darkMode` `:2329`,`:2344` | `/ventas/historial` `.set` `:4833`; `/ventas/ultimo_numero` **`.transaction()`** `:4860`; `/productos` `.set` `:4877`; `/clientes` `.set` **objeto completo tras leer** `:4849`; `/suscripcion/cloudSync` `.set(false)` `:4726`,`:4733` | `marcarPendienteSync('pos')` `:4118`,`:4197`,`:4804`,`:4989`; `limpiarPendienteSync` `:4121`,`:4200`,`:4801`,`:4986` | Definido `:4785`, guardas `:4786`+`:4793`, re-consulta `:4792`, **muerto** | Sí `/productos` `:4960` (fusión, escribe LS `:4964`) y `/empresa` `:4973` (reemplaza LS `:4975`) | Sí: venta `:4118-4122`, inventario `:4197-4201`, subida `:4984-4991`; **`fbUpsertClient(...).catch(() => {})` `:4124` no marca ni avisa** | `ensureUserCloudStructure()` `:2052`; **`if (_fbPending)` `:2055` sube**; si otro módulo tiene pendientes `:2059-2061` punto ámbar; si no, baja `:2063`; si no hay datos sube `:2076-2079` |
| `mini_market_pos_resumen.html` | L `:2756-2770`, lee `:2763` | **Sí** `:2753`,`:2762`,`:2768` (catch `:2766`) | `pos_sales` `:1560`,`:2846`,`:2870`; `ciervo_inventory` `:1567`,`:2838`; `ciervo_categories` `:2842`; `theme` `:1492`,`:1497` | **Ninguno** (solo lee `.once` `:2827`, `.on` `:2867`) | **Sin bandera** | Definido `:2797`, guarda `:2798`, **muerto** (solo el punto) | Sí `/ventas/historial` `:2867` (guarda `:2860-2861`): **reemplaza** `pos_sales` completo `:2870` | N/A (no sube) | **Baja primero** `:1557`, luego listener `:1558`; sin condición de pendientes |

---

## 3. Fichas por página (detalle P1–P9, con líneas actuales)

### 3.1 `inventario.html` — **MIGRADA a Fase A**

1. **P1** Copia local `async function checkCloudAccess()` `:2233-2251`; **lee** `suscripcion/cloudSync` `:2244`; novedad: comprueba `.info/connected` `:2242` antes de leer el permiso.
2. **P2** `_cloudAccessChecked` `:2230`; consulta `:2234`; `true` en `:2239` y `:2246`; **el `catch` `:2247-2249` ya NO pone `checked`** → un fallo de red **no** queda cacheado (corrige el hallazgo previo). No hay reinicio explícito, pero `:2296` lo pone en `false` al reconectar.
3. **P3** `ciervo_inventory` (`:2365` lectura, `:2396`, `:2442`, `:2902`, `:2938`), `ciervo_categories` (`:2407`, `:2727`, `:2749`), `_pendingFirebaseChanges` (`:2258`), `theme` (`:4541`, `:4546`).
4. **P4** `/productos` → **`.set(data)` arreglo completo** `:2344`; `/categorias` → `.set(data)` `:2352`. Sin `.update`/`.push`/`.remove`.
5. **P5** `_pendingChanges` (`:2256-2258`, vía `hayPendientesSync('inventario')` con respaldo en la clave antigua). Marca: `:2306`, `:2459`, `:2752`, `:2943`. Limpia: `:2303`, `:2456`, `:2755`, `:2946` — **solo si la subida devolvió `true`**, y `limpiarPendienteSync` borra además `_pendingFirebaseChanges` (`sincronizacion.js:74`).
6. **P6** `setupConnectionMonitor` `:2288-2313`, guarda `:2289`, re-consulta el permiso `:2296-2297`, sube solo si hay pendiente propio o `hayPendientesSync('inventario')` `:2298`. **Sigue sin invocarse** en ninguna parte.
7. **P7** `/productos` `.on('value')` `:2433-2445` (guarda `:2425-2426`), **fusiona** con `mergeInventoryWithLocal` `:2364-2381` (`images`, `mainImageIndex`, `imageUrl`, `description` del local `:2374`, `visible` del local `:2375`, `specs` fusionados `:2376`); `stock`/precios vienen de la nube. **Escribe localStorage** `:2442`. Sin listener de `/categorias`.
8. **P8** `saveCategories` `:2748-2759` y `saveProducts` `:2937-2950`: marcan **antes** de subir (`:2751-2752`, `:2942-2943`) y limpian solo si `subida === true` (`:2755`, `:2946`); aviso al usuario solo para `file:`. `uploadToFirebase` `:2450-2463`: si falla, `marcarPendienteSync` `:2459` + punto rojo `:2460`.
9. **P9** `:2490-2514`: `if (_pendingChanges)` `:2496` → **sube** `:2498`; `else if (!puedeSobrescribirLocalSync())` `:2499` → **no descarga** y punto ámbar `:2501`; `else` → **descarga** `:2503`.

### 3.2 `catalogo.html` — solo subida, sin descarga ni listener

1. **P1** Copia local `:747-761`; lee `:754`.
2. **P2** `:744`/`:753`/`:759`; **catch `:757` → `false` pegajoso toda la sesión**.
3. **P3** `ciervo_inventory` (`:989`, `:1006`), `_pendingFirebaseChanges` (`:787`, `:791`, `:821`), `darkMode` (`:1182`, `:1187`).
4. **P4** Único nodo: `/productos` `.set(data)` `:785`, **arreglo completo**.
5. **P5** Variable de módulo `_pendingFirebaseChanges = false` `:722` (no se inicializa desde localStorage). `setItem(...,'true')` `:791`; **`removeItem` `:787`, alcanzable en producción** (`saveProducts` `:1005-1009` → `firebaseSaveProducts` `:779-794` → éxito → borra).
6. **P6** No existe (0 coincidencias de `.info/connected`).
7. **P7** No existe listener ni función de descarga. `loadProducts()` `:988-1003` lee **solo localStorage**.
8. **P8** `catch` `:788-793`: marca `:790-791` salvo `file:`; **ningún aviso al usuario** (la página no tiene `firebaseDot` ni toast).
9. **P9** Sin descarga. `if (localStorage.getItem('_pendingFirebaseChanges') === 'true') setTimeout(() => firebaseSaveProducts(products), 2000)` `:821-824`.

### 3.3 `compras.html`

1. **P1** Copia local `:2273-2287`; lee `:2280`.
2. **P2** `:2270`/`:2279`/`:2285`; catch `:2283` → **pegajoso**.
3. **P3** `ciervo_suppliers` (`:2154`, `:2177`, `:2422`), `ciervo_purchases` (`:2162`, `:2178`, `:2428`), `ciervo_inventory_history` (`:2168`, `:2179`, `:2434`), `ciervo_inventory` (`:2209`, `:2941`), `ciervo_categories` (**solo lectura** `:2199`), `theme` (`:2219`, `:2231`), `_pendingFirebaseChanges` (`:2291`, `:2330`, `:2337`, `:2186`, `:2946`).
4. **P4** `/compras/proveedores` `.set` `:2375`; `/compras/compras` `.set` `:2382`; `/compras/historial` `.set` `:2389`; `/productos` `.set` `:2396`; `/categorias` `.set` `:2403` (**función `firebaseSaveCategories` `:2399-2404` nunca llamada**).
5. **P5** `_pendingChanges` `:2291`. Marca `:2186`, `:2946`, `:2337`. `removeItem` `:2330`, **dentro del monitor muerto** → en la práctica nunca se limpia desde esta página. (Nota: el código nuevo de inventario/POS sí puede borrarla indirectamente, ver R2.)
6. **P6** `:2321-2344`, guarda `:2322`, **nunca invocado**; subiría solo con bandera `:2328`.
7. **P7** Sin listener de datos.
8. **P8** `saveData` `:2184-2187`, `saveInventoryToStorage` `:2944-2947` (marcan; avisan solo `file:`); `uploadToFirebase` `:2448-2459` (catch `:2455-2458`, **no re-marca**). `syncFromFirebase` `:2414-2446` **reemplaza los arreglos completos** (`:2420-2436`), sin fusión.
9. **P9** `:2089-2106`: `if (_pendingChanges)` `:2095` → sube `:2096`; si no → `syncFromFirebase()` `:2098` y si es `false` → `uploadToFirebase()` `:2100`.

### 3.4 `cuentas.html`

1. **P1** Copia local `:1458-1472`; lee `:1465`.
2. **P2** `:1455`/`:1464`/`:1470`; catch `:1468` → **pegajoso**.
3. **P3** `ciervo_accounts` (`:1422`, `:1501`, `:1557`, `:1588`), `_pendingFirebaseChanges_cuentas` (`:1420`, `:1482`, `:1486`), `theme` (`:2273`, `:2278`).
4. **P4** `/cuentas` `.set(data)` `:1481`, **arreglo completo** (incluye `payments`).
5. **P5** Clave propia `_pendingFirebaseChanges_cuentas`: `setItem` `:1486` (solo en el `catch` de `syncToFirebase`); `removeItem` `:1482`. **No se marca si el permiso es `false`** (`:1476` retorna sin marcar).
6. **P6** `:1414-1429` (guarda `:1415`), **nunca invocado**.
7. **P7** Sin listener de datos.
8. **P8** `:1484-1487`: marca + `console.error`; **sin aviso al usuario**.
9. **P9** `:1519-1528`: `loadAccounts()` local `:1523` + `loadAccountsAsync()` `:1524` → `loadFromFirebase()` `:1576` y **reemplazo** `:1577-1584`; **sin condición de pendientes**. `persistAccounts` `:1591-1594` guarda LS `:1592` y sube `:1593`.

### 3.5 `config_recibo.html` — solo lectura

1. **P1** Copia local `:713-727`; lee `:720`.
2. **P2** `:710`/`:719`/`:725`; catch `:723` → **pegajoso**.
3. **P3** `companyData` (`:740`, `:758`, `:783`), `receiptSettings` (`:814`, `:1047`), `theme` (`:975`, `:980`).
4. **P4** **Ninguna escritura remota** (0 `.set/.update/.push/.remove`); solo `.once` `:737` y `.on` `:755`. **`receiptSettings` nunca se respalda en la nube.**
5. **P5** Sin bandera.
6. **P6** No define `setupConnectionMonitor`.
7. **P7** `/empresa` `.on('value')` `:747-766` (guarda `:748`): **reemplaza** LS `:758` y memoria `:759`, sin fusión.
8. **P8** N/A.
9. **P9** `loadCompanyData()` `:782-806`: local `:783-797`, luego `loadCompanyFromFirebase()` `:798` que **sobreescribe** `:799-803`; sin condición de pendientes.

### 3.6 `gestion_empresa.html`

1. **P1** Copia local `:1632-1646`; lee `:1639`.
2. **P2** `:1629`/`:1638`/`:1644`; catch `:1642` → **pegajoso**.
3. **P3** `companyData` (`:1596`, `:1675`, `:1835`, `:1978`), `_pendingFirebaseChanges_empresa` (`:1594`, `:1656`, `:1660`), `darkMode` (`:2049`, `:2053`, `:2069`).
4. **P4** `/empresa` `.set(companyInfo)` `:1655`, **objeto completo** (incluye logo base64).
5. **P5** Clave propia: `setItem` `:1660`; `removeItem` `:1656`. **No se marca si el permiso es `false`** (`:1650`).
6. **P6** `:1588-1603` (guarda `:1589`), **nunca invocado**.
7. **P7** Sin listener de datos.
8. **P8** `:1658-1661` marca + `console.error`; y **`if (!ok) showToast('Guardado local. Datos pendientes de sincronizar con la nube.', 'success')` `:1981`** — el **único aviso visible de pendientes de toda la aplicación**.
9. **P9** `loadCompanyData()` `:1834-1852`: local `:1835-1844`, luego `loadFromFirebase()` `:1845` → si difiere, **sobreescribe** `:1846-1851` y avisa "Datos sincronizados desde la nube." `:1849`. **No consulta la bandera de pendientes** → la marca escrita en `:1660` nunca se usa en la carga.

### 3.7 `gestion_proveedores.html` — el más divergente

1. **P1** Copia local `:1572-1586`; lee `:1579` con `getEmailPath(email)` `:1563-1567`, que hace `String(email).trim().toLowerCase()` → **ruta distinta** a la de las demás páginas (`inventario.html:2220`, `mini_market_pos.html:4692`) si el correo tiene mayúsculas.
2. **P2** `:1569`/`:1578`/`:1584`; catch `:1582` → **pegajoso**.
3. **P3** `ciervo_suppliers` (`:1616`, `:1635`, `:1649`, `:1659`), `darkMode` (`:1709`, `:1724`). **Sin bandera.**
4. **P4** `/proveedores`: `.push()` `:1639` + `.set()` `:1641`; `.update()` por id `:1653`; `.remove()` por id `:1663`. **Única página con CRUD por identificador.**
5. **P5** Ninguna.
6. **P6** `:1531-1537` (guarda `:1532`), **nunca invocado**; aun invocado solo cambia el punto `:1535`.
7. **P7** Sin listener de datos.
8. **P8** `loadSuppliersFromFirebase` `:1623-1626`: en error de lectura, `console.error` y **`_suppliersCache = []`** `:1625`. En la rama nube, si `ref.set(supplierData)` `:1641` falla, el `.catch` `:2010-2015` muestra `alert` pero **no persiste el proveedor en ningún lado** → el alta se pierde. La rama sin permiso sí persiste (`:1631-1636`, id `'local_' + Date.now()`), pero `:1620-1622` **no lee ni fusiona el localStorage** cuando hay permiso.
9. **P9** `DOMContentLoaded` `:1667` → `await loadSuppliersFromFirebase()` `:1676`, `filterSuppliers()` `:1677`. Sin condición de pendientes.

### 3.8 `listado_clientes.html`

1. **P1** Copia local `:994-1008`; lee `:1001`.
2. **P2** `:991`/`:1000`/`:1006`; catch `:1004` → **pegajoso**.
3. **P3** `ciervo_clients` (`:1101`, `:1237`), `darkMode` (`:1203`, `:1218`). Sin pendientes.
4. **P4** `/clientes/{updatedClient._key}` `.update({ name, document, phone, email })` `:1242-1247`, **parcial por clave**.
5. **P5** Ninguna.
6. **P6** `:1045-1056` (guarda `:1046`), **nunca invocado**.
7. **P7** `/clientes` `.on('value')` `:1106-1111` (guarda `:1100-1103`): **reemplaza** `allClientsData`; **no escribe localStorage**.
8. **P8** `saveClient` `:1248-1250`: **solo `console.error`**.
9. **P9** `:1083-1115`: sin permiso → LS `:1101`; con permiso → **solo listener** `:1104-1111`. Nadie escribe `ciervo_clients` en modo nube.

### 3.9 `mini_market_pos.html` — **MIGRADA a Fase A**

1. **P1** Copia local `:4659-4679`; lee `:4672`; comprueba `.info/connected` `:4670`.
2. **P2** `:4656`/`:4660`/`:4665`; `true` en `:4665`/`:4674`; **catch `:4675-4677` no marca `checked`** → fallo de red no queda cacheado; `:4792` lo reinicia al reconectar.
3. **P3** Ver matriz §2 (22 claves, incluidas las dinámicas `pos_exchange_rate_${rateSource}` `:2363`/`:3516` y `RATE_HISTORY_KEY`/`RATE_HISTORY_SEED_KEY` = `pos_rate_history`/`pos_rate_history_seed` `:3208-3209`).
4. **P4** `/ventas/historial` `.set` `:4833`; `/ventas/ultimo_numero` **`.transaction()`** `:4860-4863` (novedad Fase A C3: el contador nunca retrocede); `/productos` `.set` `:4877`; `/clientes` `.set(all)` `:4849` sobre objeto leído `:4846-4848` (**leer-modificar-escribir**); `/suscripcion/cloudSync` `.set(false)` `:4726`, `:4733`.
5. **P5** `_fbPending` `:4652-4654`; marca `:4118`, `:4197`, `:4804`, `:4989`; limpia `:4121`, `:4200`, `:4801`, `:4986` (solo con confirmación; `limpiarPendienteSync` borra además la clave antigua).
6. **P6** `:4785-4811`, guardas `:4786` y `:4793`, reinicio del caché de permiso `:4792`, subida condicionada a pendientes `:4794`. **Sigue sin invocarse.**
7. **P7** `/productos` `:4960-4970` (fusión `:4892-4909`, escribe LS `:4964`) y `/empresa` `:4973-4976` (reemplaza LS `:4975`). Gate `:4952`. **No hay listener de `/ventas/historial` ni de `/clientes`.**
8. **P8** Venta `:4118-4122`, inventario `:4197-4201`, subida `:4984-4991` (marca al fallar `:4989`). **`fbUpsertClient(...).catch(() => {})` `:4124` sigue tragando el error** sin marca ni aviso.
9. **P9** `:2050-2088`: `ensureUserCloudStructure()` `:2052`; `if (_fbPending)` `:2055` → sube `:2058`; `else if (!puedeSobrescribirLocalSync())` `:2059` → punto ámbar `:2061`; `else` → descarga `:2063`. Detalle: `uploadToFirebase` `:4979-4992` **solo sube ventas y `ultimo_numero`**, no productos.

### 3.10 `mini_market_pos_resumen.html` — solo lectura

1. **P1** Copia local `:2756-2770`; lee `:2763`.
2. **P2** `:2753`/`:2762`/`:2768`; catch `:2766` → **pegajoso**.
3. **P3** `pos_sales` (`:1560`, `:2846`, `:2870`), `ciervo_inventory` (`:1567`, `:2838`), `ciervo_categories` (`:2842`), `theme` (`:1492`, `:1497`).
4. **P4** **Ninguna escritura remota** (solo `.once` `:2827`, `.on` `:2867`).
5. **P5** Sin bandera.
6. **P6** `:2797-2807` (guarda `:2798`), **nunca invocado**.
7. **P7** `/ventas/historial` `.on('value')` `:2867-2876` (guarda `:2860-2861`): **reemplaza** `pos_sales` completo `:2870` y `allSales` `:2871`.
8. **P8** N/A.
9. **P9** `loadSales()` `:1555-1577` (invocada en `:1459-1460`): **descarga primero** `:1557`, luego listener `:1558`, luego LS `:1560-1572`. **Sin condición de pendientes** (`syncFromFirebase` `:2831-2857` no la consulta).

---

## 4. Desviaciones encontradas (con `archivo:línea`)

| # | Desviación | Evidencia |
|---|-----------|-----------|
| D1 | **`catalogo.html` no descarga nunca de la nube ni tiene listener de datos**: solo sube. No existe equivalente a `syncFromFirebase`/`firebaseLoadAll`. | `catalogo.html:779-794` (única función Firebase); `:988-1003` (`loadProducts` solo LS) |
| D2 | **`catalogo.html` no tiene `setupConnectionMonitor` ni indicador** (`firebaseDot`) ni aviso de error. | 0 coincidencias de `.info/connected`; `catalogo.html:788-793` |
| D3 | **`compras.html` no tiene listener de datos** pese a escribir 5 nodos. | `compras.html:2323` es el único `.on('value')` y es `.info/connected` |
| D4 | **`config_recibo.html` es de solo lectura**: `receiptSettings` no se respalda en la nube. | `config_recibo.html:729-766`; `:1047` guarda solo en LS |
| D5 | **Nodos e identificadores distintos para "proveedores"**: `/proveedores` con claves `push` vs `/compras/proveedores` con arreglo de `id` numérico; misma clave local `ciervo_suppliers`. | `gestion_proveedores.html:1639-1641` vs `compras.html:2375`; `ciervo_suppliers` en `gestion_proveedores.html:1616,1635,1649,1659` y `compras.html:2154,2177,2422` |
| D6 | **Normalización de correo distinta** (`toLowerCase`) → rutas de BD divergentes. | `gestion_proveedores.html:1566` vs `inventario.html:2220`, `mini_market_pos.html:4691` |
| D7 | **`gestion_proveedores.html` no tiene bandera ni reintento**; un fallo en modo nube descarta el alta. | `:1630-1643`, `:2010-2015` |
| D8 | **`listado_clientes.html` no persiste la lista en LS en modo nube**. | `:1104-1111` (sin `setItem`) vs `:1237` (única escritura, rama sin permiso) |
| D9 | **`cuentas.html` y `gestion_empresa.html` no marcan pendiente si el permiso es `false`**: el retorno temprano no lanza excepción. | `cuentas.html:1476` vs `:1486`; `gestion_empresa.html:1650` vs `:1660` |
| D10 | **Cinco páginas descargan sin consultar pendientes** (la nube sobrescribe lo local). | `cuentas.html:1577-1584`; `gestion_empresa.html:1846-1851`; `config_recibo.html:755-762` y `:798-803`; `listado_clientes.html:1106-1110`; `mini_market_pos_resumen.html:1557` + `:2836-2847` |
| D11 | **En las 8 páginas no migradas, el `catch` de `checkCloudAccess` deja `false` cacheado toda la sesión.** | `catalogo.html:755-759`; `compras.html:2281-2285`; `cuentas.html:1466-1470`; `config_recibo.html:721-725`; `gestion_empresa.html:1640-1644`; `gestion_proveedores.html:1580-1584`; `listado_clientes.html:1002-1006`; `mini_market_pos_resumen.html:2764-2768` |
| D12 | **`uploadToFirebase` no re-marca al fallar** en compras (`:2455-2458`); en inventario (`:2458-2461`) y POS (`:4988-4991`) sí lo hace tras Fase A. | `compras.html:2455-2458` |
| D13 | **`compras.html` define `firebaseSaveCategories` y nunca la llama**, pero lee `ciervo_categories`. | definición `:2399-2404`; lectura `:2199` |
| D14 | **`mini_market_pos.html` traga los errores de `fbUpsertClient`.** | `:4124` (`.catch(() => {})`) |
| D15 | **Dos estrategias sobre `/clientes`**: leer-modificar-escribir del objeto completo (POS) vs `.update()` por clave (listado). | `mini_market_pos.html:4846-4849` vs `listado_clientes.html:1242` |
| D16 | **Nueva operación `.transaction()`** que rompe la homogeneidad del patrón (nadie más la usa). | `mini_market_pos.html:4860` |
| D17 | **Claves de tema inconsistentes**: `theme` vs `darkMode`. | `inventario.html:4541` vs `catalogo.html:1182` |
| D18 | **`mini_market_pos_resumen.html` no fusiona `productos`** (reemplazo en crudo). | `:2838` vs `inventario.html:2364-2381` y `mini_market_pos.html:4892-4909` |
| D19 | **`config.html` (fuera de las 10) borra `pos_customers`, clave que ninguna página usa** (la real es `ciervo_clients`); también borra `_pendingFirebaseChanges`. | `config.html:2259` vs `listado_clientes.html:1101,1237`; `config.html:2334` |
| D20 | **`inventario.html` y `mini_market_pos.html` escuchan ambos `/productos`** y reescriben LS y UI, sin arbitraje entre pestañas. | `inventario.html:2433`; `mini_market_pos.html:4960` |
| D21 | **`mini_market_pos.html` e `index.html` limpian el caché de `cloud-access.js` que ninguna página usa.** | `mini_market_pos.html:4740-4741`; `index.html:1816-1817` |
| D22 | **`subirConMarcaSync` (`sincronizacion.js:112-122`) no se usa**: las 2 páginas migradas reimplementan el patrón a mano. | 0 invocaciones en todo el repositorio |

---

## 5. Respuestas a las preguntas transversales

### A. ¿Cuántas páginas escriben la MISMA clave `_pendingFirebaseChanges` y cuántas hacen `removeItem`?

**Clave compartida `_pendingFirebaseChanges` — la escriben 4 páginas:**

| Página | Pone `'true'` | `removeItem` | ¿Alcanzable? |
|---|---|---|---|
| `inventario.html` | `:2258` (solo lectura), y `marcarPendienteSync` `:2306`,`:2459`,`:2752`,`:2943` → `sincronizacion.js:66` | `limpiarPendienteSync` `:2303`,`:2456`,`:2755`,`:2946` → `sincronizacion.js:74` | **SÍ** (subida confirmada) |
| `catalogo.html` | `:791` | **`:787`** | **SÍ** (subida confirmada de solo `/productos`) |
| `compras.html` | `:2186`, `:2946`, `:2337` | `:2330` | **NO** (monitor nunca invocado) |
| `mini_market_pos.html` | `:4654` (solo lectura), y `marcarPendienteSync` `:4118`,`:4197`,`:4804`,`:4989` | `limpiarPendienteSync` `:4121`,`:4200`,`:4801`,`:4986` | **SÍ** (subida confirmada) |

Fuera del grupo: `config.html:2334` hace `localStorage.removeItem('_pendingFirebaseChanges')` en el reinicio de fábrica.

**Claves separadas del mismo tipo (2 páginas):** `cuentas.html` → `_pendingFirebaseChanges_cuentas` (`:1486` marca / `:1482` limpia, ambos alcanzables); `gestion_empresa.html` → `_pendingFirebaseChanges_empresa` (`:1660` / `:1656`, ambos alcanzables).

**Sin ninguna bandera (4 páginas):** `config_recibo.html`, `gestion_proveedores.html`, `listado_clientes.html`, `mini_market_pos_resumen.html`.

**Sí hay riesgo real de que una página borre la bandera de otra.** En el estado actual el borrado alcanzable de la clave antigua ocurre por tres vías: `catalogo.html:787` (código antiguo) y `inventario.html:2456`/`mini_market_pos.html:4986` vía `limpiarPendienteSync` → `sincronizacion.js:74`. `compras.html` **solo sabe expresar sus pendientes con esa clave antigua** (`:2186`, `:2946`) y **nunca crea una clave `_pendSync_compras_*`**. Por tanto:

> **compras.html marca pendientes → inventario.html (o el POS) sube lo suyo con éxito → `sincronizacion.js:74` borra `_pendingFirebaseChanges` → la próxima vez compras arranca con `_pendingChanges === false` (`compras.html:2091`) y entra por la rama de descarga (`:2098`), que reemplaza sus arreglos locales con los de la nube (`:2420-2436`): las compras que nunca se subieron se pierden.**

### B. ¿Identificadores por operación? ¿Cola de operaciones con marca de tiempo?

**Identificadores por operación — sí, en 3 páginas:**
- `gestion_proveedores.html`: `.push()` `:1639` + `.set()` `:1641`, `.update()` por `id` `:1653`, `.remove()` por `id` `:1663`.
- `listado_clientes.html`: `.update()` parcial sobre `/clientes/{_key}` `:1242`.
- `mini_market_pos.html`: `/clientes/{clave}` mediante leer-modificar-escribir del objeto completo `:4846-4849`.

**Ventas y movimientos — no hay identificadores por operación.** Las ventas se guardan como arreglo completo en `/ventas/historial` (`mini_market_pos.html:4833`) con `ventas.push(saleData)` local `:4109`; el número de venta es un contador global (`/ventas/ultimo_numero`, ahora con `.transaction()` `:4860`). Inventario y cuentas también se suben como arreglo completo. Compras sube tres arreglos completos (`:2375`, `:2382`, `:2389`).

**Cola de operaciones con marca de tiempo — no en el código antiguo; sí existe la infraestructura nueva pero sin uso.**
- Ninguna de las 8 páginas no migradas tiene cola: solo booleanos y contadores de módulo.
- `sincronizacion.js:65` **sí guarda un timestamp ISO por módulo** (`new Date().toISOString()`), pero lo trata como simple presencia (`hayPendientesSync` `:78-86` solo comprueba que la clave exista) y **no hay orden de reproducción ni lista de operaciones**. `subirConMarcaSync` `:112-122`, que sería el punto de entrada ordenado, **no se invoca en ninguna página**.
- Las marcas de tiempo existentes (`saleData.timestamp` `mini_market_pos.html:4101`, `companyInfo.lastUpdated` `gestion_empresa.html:1975`, `createdDate` `gestion_proveedores.html:1997`) son del dato, no de una cola.

### C. ¿Alguna página maneja `cloudSync !== true` de forma distinta a "no hacer nada en la nube"? ¿Aviso visible?

**Manejo diferenciado — sí en 2 páginas:**
- `gestion_proveedores.html`: ramas explícitas de modo local con id `'local_' + Date.now()` y persistencia en LS para alta/edición/baja (`:1631-1636`, `:1646-1650`, `:1657-1660`).
- `listado_clientes.html`: rama explícita que escribe `ciervo_clients` `:1236-1238`.

En el resto, la persistencia local ocurre **antes** de llamar a la nube, así que el dato de la sesión no se pierde, pero **no queda marca de que esté sin subir**: `inventario.html:2938` antes de `:2945`; `compras.html:2177-2179` antes de `:2180`; `catalogo.html:1006` antes de `:1007`; `cuentas.html:1588` (vía `:1592`); `gestion_empresa.html:1978` antes de `:1980`; `mini_market_pos.html:4110`/`:4194` antes de `:4120`/`:4199`.

**Avisos visibles: prácticamente inexistentes.**
- **No hay** contador de pendientes, **ni** "última sincronización", **ni** ningún texto que advierta que los datos solo están en el dispositivo (0 coincidencias de `solo en este`, `última sincroniz`, `sin conexi`, `no sincroniz`).
- El único aviso de pendientes es `gestion_empresa.html:1981`: `showToast('Guardado local. Datos pendientes de sincronizar con la nube.', 'success')` (con tipo `'success'`, verde, para un fallo).
- Indicador: un punto de color (`firebaseDot`) en 8 de las 10 páginas (`inventario.html:1456`, `compras.html:1296`, `cuentas.html:973`, `gestion_empresa.html:889`, `gestion_proveedores.html:1137`, `listado_clientes.html:830`, `mini_market_pos.html:1483`, `mini_market_pos_resumen.html:1210`) y **ausente en `catalogo.html` y `config_recibo.html`**. Como el listener de conexión nunca se instala, el punto queda gris salvo que una subida concreta tenga éxito.
- **Fase A añadió un estado ámbar útil**: "Hay cambios pendientes de subir" (`inventario.html:2501`, `mini_market_pos.html:2061`), pero **solo en las 2 páginas migradas**.
- **El punto puede mentir en verde**: `uploadToFirebase` pinta verde aunque las funciones internas hayan devuelto `false` por falta de permiso (`inventario.html:2456-2457` limpia la marca y pinta verde si `subidaProductos` fue `true`, pero si **ambas** son `false` igualmente pinta verde en `:2457`; `mini_market_pos.html:4986-4987` pinta verde aunque `subidaVentas` sea `false`). Un usuario sin suscripción ve el mismo verde que uno sincronizado.

### D. ¿Alguna página exporta/importa respaldo de datos en JSON?

**No. Ninguna de las 10 páginas ofrece exportación ni importación de respaldo en JSON.**
- Única exportación: **CSV de clientes** en `listado_clientes.html:1373-1401` (`exportClientsToCSV`, descarga `listado_clientes.csv`), **sin importación**.
- `inventario.html` tiene **importación de Excel** (`.xlsx`) en `:1541` y `handleFileImport` `:4600-4693`; advierte que sobrescribirá todo el inventario (`:4624`) y llama a `saveProducts()` `:4678` (por tanto sube el arreglo completo a la nube). **No es un respaldo**: no exporta.
- El "respaldo" de `config.html` (`:1478-1580`) genera un **PDF** de inventario (`:2136`), **no reimportable**.
- No existe ninguna función de restauración desde archivo para inventario, ventas, cuentas, proveedores, empresa ni configuración de recibo.

---

## 6. Riesgos concretos de pérdida de datos (ordenados por gravedad)

### R1 — CRÍTICO (introducido por la convivencia de capas): `marcarPendienteSync` escribe la marca antigua y provoca subidas sin descarga en las 8 páginas no migradas

`sincronizacion.js:66` escribe `_pendingFirebaseChanges = 'true'` **cada vez** que inventario o el POS marcan algo. Las páginas no migradas interpretan esa marca como "tengo pendientes **propias**" y, en consecuencia, **suben su estado local sin descargar primero**:

- `compras.html:2091` (`_pendingChanges = localStorage.getItem('_pendingFirebaseChanges') === 'true'`) → rama `:2095-2096` `uploadToFirebase()` → sube `suppliers`, `purchases`, `inventoryHistory` (`:2375`, `:2382`, `:2389`) **con los datos locales que tenga**, pisando la nube, **sin haber descargado**.
- `catalogo.html:821-824` → `firebaseSaveProducts(products)` → `.set` `:785` con el arreglo local completo; `catalogo.html` **nunca descarga** (D1), así que puede sobrescribir en la nube el stock real con el de su propio localStorage.
- `cuentas.html` y `gestion_empresa.html` usan claves propias, por lo que no se ven afectadas por esta vía.

Escenario mínimo: abrir inventario y guardar un producto (marca `:2752`), luego abrir compras → compras sube su arreglo de compras/proveedores sin descargar. Si otro equipo había registrado compras entretanto, esas compras de la nube se pierden.

### R2 — CRÍTICO: una subida exitosa de inventario o del POS borra la marca de pendientes compartida de compras y catalogo

`limpiarPendienteSync` (`sincronizacion.js:72-75`) borra la clave del módulo **y** `_pendingFirebaseChanges` (`:74`). Lo invocan `inventario.html:2456` (y `:2303`, `:2755`, `:2946`) y `mini_market_pos.html:4986` (y `:4121`, `:4200`, `:4801`). Como `compras.html` (`:2186`, `:2946`) y `catalogo.html` (`:791`) **solo** expresan sus pendientes con la marca antigua y nunca crean `_pendSync_compras_*` / `_pendSync_catalogo_*`, sus pendientes quedan **invisibles** para el sistema. Después: `compras.html:2091` arranca en `false` y entra por la rama de descarga (`:2098`), que **reemplaza sus arreglos con los de la nube** (`:2420-2436`) → la compra no subida se pierde. Lo mismo con `catalogo.html`, cuya única protección es el reintento `:821` (que ya no se dispara).

**Nota:** este es el hallazgo que la propia cabecera de `sincronizacion.js:16-20` declara querer arreglar; la corrección es efectiva **entre módulos migrados**, pero **no** entre un módulo migrado y uno no migrado, porque la marca antigua sigue siendo el único canal de los no migrados y `limpiarPendienteSync` la destruye.

### R3 — CRÍTICO en las 8 páginas no migradas: un fallo de red en la primera comprobación desactiva la nube toda la sesión y los cambios no se marcan

Cadena completa (idéntica en las 8):
1. Primer `checkCloudAccess()` con red caída → `catch` → `_cloudAccess = false` (`catalogo.html:757`, `compras.html:2283`, `cuentas.html:1468`, `config_recibo.html:723`, `gestion_empresa.html:1642`, `gestion_proveedores.html:1582`, `listado_clientes.html:1004`, `mini_market_pos_resumen.html:2766`) y a continuación `_cloudAccessChecked = true` (`:759`, `:2285`, `:1470`, `:725`, `:1644`, `:1584`, `:1006`, `:2768`) → **`false` cacheado el resto de la carga de página**; nunca se reinicia.
2. Las funciones de subida retornan silenciosamente sin lanzar excepción: `if (!await checkCloudAccess()) return;` (`inventario.html` ya devuelve `false` y lo propaga, pero en las 8 antiguas es un `return` simple: `compras.html:2372`, `cuentas.html:1476`, `gestion_empresa.html:1650`, etc.).
3. Los llamadores solo marcan pendiente en el `catch` (`compras.html:2184-2187`, `cuentas.html:1484-1487`, `gestion_empresa.html:1658-1661`), que **nunca se ejecuta** porque no hubo excepción → **sin marca**.
4. En la siguiente carga, si la nube responde, se descarga y **se sobrescribe lo local sin mirar pendientes**: `cuentas.html:1577-1584`, `gestion_empresa.html:1846-1851`, `config_recibo.html:755-762` y `:798-803`, `listado_clientes.html:1106-1110`, `mini_market_pos_resumen.html:2836-2847`, `compras.html:2419-2436` (arreglos completos). En inventario y POS esto ya no ocurre (Fase A: `inventario.html:2496-2501`, `mini_market_pos.html:2055-2061`, `:4915-4918`).

**Resultado:** en las 8 páginas no migradas, ventas/compras/cobros/ediciones hechas durante una caída de red pueden desaparecer sin aviso.

### R4 — ALTO: `gestion_proveedores.html` descarta proveedores y no tiene reintento

- Fallo de `ref.set(supplierData)` `:1641` en la rama nube → `.catch` `:2010-2015` muestra `alert` pero **no guarda el proveedor ni en memoria ni en LS**: el alta se pierde.
- Proveedores creados sin permiso (`id: 'local_' + Date.now()`, `:1631-1635`) solo viven en `ciervo_suppliers`; cuando el permiso pasa a `true`, `:1620-1622` **reemplaza el caché con el nodo de la nube sin leer ni fusionar el LS** → desaparecen de la vista.
- Error de lectura → `_suppliersCache = []` `:1625` y la tabla queda vacía (`:1677`); si el usuario vuelve a cargarlos, se duplican o se pisan claves.

### R5 — ALTO: las páginas de descarga-sin-bandera pisan cambios locales en cuanto el permiso se resuelve

`cuentas.html:1577-1584`, `gestion_empresa.html:1846-1851`, `config_recibo.html:798-803` (+ listener inmediato `:755-762`), `listado_clientes.html:1106-1110` y `mini_market_pos_resumen.html:2836-2847` no consultan ninguna bandera: la nube es autoridad absoluta. En `gestion_empresa.html` esto anula explícitamente la marca que sí se escribe en `:1660`, cuyo único lector está en el monitor muerto `:1594`.

### R6 — MEDIO: el reintento automático al reconectar sigue siendo código muerto

`setupConnectionMonitor` está definido en 8 páginas y **no se invoca en ninguna** (0 llamadas; la única del repositorio, `gestion_usuario.html:2027`, es de otra página). Todo el bloque "al volver la conexión subo lo pendiente" (`inventario.html:2288-2313`, `mini_market_pos.html:4785-4811`, `compras.html:2321-2344`, `cuentas.html:1414-1429`, `gestion_empresa.html:1588-1603`) nunca se ejecuta. Solo queda el reintento en la carga inicial, y solo en inventario (`:2496`), compras (`:2095`) y POS (`:2055`).

### R7 — MEDIO: escrituras de arreglo completo con "último escritor gana"

`/productos` se escribe completo desde `inventario.html:2344`, `compras.html:2396`, `catalogo.html:785` y `mini_market_pos.html:4877`; `/cuentas` completo `cuentas.html:1481`; `/ventas/historial` completo `mini_market_pos.html:4833`; `/empresa` completo `gestion_empresa.html:1655`; `/compras/*` completos `compras.html:2375,2382,2389`. Dos pestañas o dos dispositivos que editen a la vez se pisan por completo. Agravado por `catalogo.html`, que sube sin haber descargado nunca (D1).

### R8 — MEDIO: `/clientes` con dos estrategias incompatibles y errores silenciados

`mini_market_pos.html:4846-4849` hace leer-modificar-escribir del objeto completo en cada venta; `listado_clientes.html:1242` hace `.update()` parcial por clave. Ventas simultáneas pueden perder clientes en la ventana entre lectura y escritura, y el fallo se traga en `mini_market_pos.html:4124` sin marca ni aviso.

### R9 — MEDIO: proveedores partidos en dos nodos con esquemas de id distintos

`gestion_proveedores.html:1641` (`/proveedores`, claves `push` string) y `compras.html:2375` (`/compras/proveedores`, arreglo con `id` numérico) sobre la misma clave local `ciervo_suppliers`. `gestion_proveedores.html:1616` puede cargar como propios los proveedores numéricos de compras y `compras.html:2157` hace `Math.max(...suppliers.map(s => s.id), 0) + 1` sobre ids que pueden ser cadenas `push` (→ `NaN`). Añádase D6 (mayúsculas/minúsculas en el correo).

### R10 — MEDIO-BAJO: `receiptSettings` no se respalda en la nube

`config_recibo.html:1047` guarda la configuración de recibo solo en LS; la página no tiene escrituras remotas (D4). Sin respaldo JSON (§5-D), limpiar el navegador la pierde.

### R11 — BAJO: reinicio de fábrica incoherente con la nube

`config.html:2234-2261` borra claves locales sin tocar los nodos remotos y borra la marca de pendientes `:2334`. Las páginas de descarga-sin-bandera (R5) restaurarán esos datos desde la nube en la siguiente carga. Además borra `pos_customers` `:2259`, **clave que ninguna página usa** (la real es `ciervo_clients`, `listado_clientes.html:1101,1237`), por lo que los clientes locales sobreviven al reinicio. *(config.html está fuera del alcance auditado y también fue modificado por el proceso paralelo a las 18:20:25; sus líneas se verificaron de nuevo en ese momento.)*

### R12 — BAJO: indicador de estado engañoso

El punto puede quedar verde sin que se haya subido nada por falta de permiso (`inventario.html:2457`, `mini_market_pos.html:4987`) y, al no instalarse el listener de conexión, nunca refleja una caída posterior. No hay contador de pendientes ni marca de última sincronización.

---

## 7. Lo que no se pudo confirmar en el código

- **La intención del diseño** y qué capa es la canónica: si `cloud-access.js` debía centralizar y `sincronizacion.js` es su sucesor, o si conviven deliberadamente. Solo se puede afirmar el comportamiento efectivo (§1).
- **Si el proceso paralelo continuará** migrando las 8 páginas restantes. Si eso ocurre, los hallazgos R1–R3 y D10–D12 sobre esas páginas dejarán de aplicar, y el acoplamiento descrito en R1/R2 entre páginas migradas y no migradas desaparecerá cuando **todas** usen claves por módulo (momento en el que `limpiarPendienteSync` debería dejar de borrar la marca antigua compartida).
- **El estado real de la base de datos** (reglas de seguridad, valor de `BBDD/{email}/suscripcion/cloudSync` para usuarios reales, contenido de `/proveedores` vs `/compras/proveedores`) y el comportamiento en ejecución (si `checkCloudAccess` falla de verdad por red, si llegaron a borrarse banderas ajenas). Todo el análisis es **estático**.
- **Ausencia de otras escrituras remotas**: verificado con búsqueda de `.set(`, `.update(`, `.push(`, `.remove(`, `.transaction(` y `.on('value'` en los 10 archivos, y de `localStorage.*Item(` para las claves. Una escritura construida de forma dinámica no aparecería; no se encontró indicio de ello.
- **Páginas fuera del alcance** (`config.html`, `menu.html`, `index.html`, `gestion_usuario.html`, `calcular_precio_ven.html`, `landing.html`, `verificacion.html`) se consultaron solo cuando aportaban evidencia sobre claves o nodos compartidos (D19, D21, R11, §1.1); no se auditaron en profundidad.
