# Auditoría y eliminación de DATOS DE MUESTRA

Fecha: sesión de limpieza de datos de demostración
Alcance: las 15 páginas HTML + los `.js` del proyecto (app web estática, Firebase RTDB v8).
Estado: **Fase 1 (auditoría), Fase 2 (eliminación), Fase 3 (diagnóstico) y Fase 4 (pruebas) completadas.**
Sin commits ni push. No se tocaron `reglas-firebase.json`, `datos_cuenta.js`, `motor_operaciones.js`,
`lector_ventas.js`, `sincronizacion.js` ni `almacenamiento.js`.

---

## 1. FASE 1 — Auditoría: cada fuente de datos de muestra

Las líneas que se citan son las **originales** (antes de la limpieza); entre paréntesis, el estado actual.

| # | Archivo:línea | Qué era | ¿Pantalla? | ¿localStorage? | ¿Nube? |
|---|---|---|---|---|---|
| 1 | `menu.html:2927-3031` (`loadSampleInventoryData`) | 5 productos de demostración (`sampleData`: Laptop HP Pavilion, Smartphone Samsung Galaxy, Audífonos Sony WH-1000XM4, Camiseta Nike Dri-FIT, Cafetera Nespresso) | **Sí** — quedaban en `dataStore('inventory')` y los pintaba la tabla del módulo + notificaciones | No (el `saveData` ya estaba comentado por la fase anterior) | No |
| 2 | `menu.html:3033-3096` (`loadSampleAccountsData`) | 5 cuentas por cobrar/pagar de demostración (Cliente A, Proveedor X, Empresa B, Arrendador, Cliente C) | **Sí** — `dataStore('accounts')` alimenta las notificaciones de vencidas/por vencer | No (comentado) | No |
| 3 | `menu.html:2845-2851` (`initializeDataStores`) | Métricas de ejemplo: `totalSales: 12450`, `totalCustomers: 324`, `totalItems: 1850`, `totalRevenue: 145320` | No (nadie las leía) | No | No — **código muerto** |
| 4 | `inventario.html:2985-2990` (`loadSampleData`) | Sembrador "vacío" que llamaba a `saveProducts()` | No | **Sí** — `ciervo_inventory` = `[]` (vía `guardarLocalSeguro`) | **Sí** — `BBDD/<email>/productos` y marca `_pendSync_inventario` |
| 5 | `inventario.html:2749-2769` (`loadCategories`) | 10 categorías fijas: Electrónicos, Ropa, Hogar, Deportes, Libros, Belleza, Automotriz, Frutas y Hortalizas (granel), Charcutería (granel), Otros | **Sí** — aparecen en los desplegables de producto, filtro y edición masiva | **Sí** — `ciervo_categories` | **Sí** — `BBDD/<email>/categorias` |
| 6 | `compras.html:2204-2210` (`loadSampleSuppliers`) | 1 proveedor de demostración: Distribuidora Central SAC / 20123456789 / ventas@distribuidoracentral.com / Av. Industrial 123, Lima | **Sí** — pestaña Proveedores | **Sí** — `ciervo_suppliers`, `ciervo_purchases`, `ciervo_inventory_history` (los tres, vía `saveData()`) | **Sí** — `BBDD/<email>/compras/{proveedores,compras,historial}` + `_pendSync_compras` |
| 7 | `compras.html:2164-2171` (`loadData`) | El `if` de "primera vez": llamaba al sembrador cuando la clave no existía | — | — | — |
| 8 | `config_recibo.html:807-815` (`loadCompanyData`) | Empresa de ejemplo: `TIENDA DE EJEMPLO C.A.`, `J-12345678`, `Av. Principal, Edif. Central` | **Sí** — vista previa del ticket | No (solo memoria) | No |
| 9 | `config_recibo.html:620` y usos en `934, 946, 951-955, 962-963, 967-972, 977-978` | `MOCK_EXCHANGE_RATE = 36.50` "para simulación": convertía los importes de la vista previa a Bs | **Sí** — importes y "Tasa: 36.50 Bs/$" | No | No |
| 10 | `config_recibo.html:591-592` (HTML estático) | `Tasa: 36.50 Bs/$` y `Total Ref: Bs. 000.00` pintados antes de que corra el JS | **Sí** | No | No |
| 11 | `config_recibo.html:540` (HTML estático) | `Atendido por: Admin` (resto del usuario demo) | **Sí** | No | No |
| 12 | `config.html:2361` + `2393-2407` (`createDemoAdminUser`) | El reinicio de fábrica creaba en `localStorage` el usuario **Admin / Admin123** (`admin@demo.com`, `DEMO-001`, rol Administrador) | No (nada leía la clave) | **Sí** — `users` | No |
| 13 | `config.html:1783-1784` y `1842-1853` | Textos que prometían y mostraban las credenciales demo | **Sí** | No | No |

### Páginas revisadas y limpias (sin sembradores)

`cuentas.html` (lee `ciervo_accounts`; con la clave ausente deja la caché vacía y pinta
`emptyStateReceivable`/`emptyStatePayable`), `catalogo.html`, `listado_clientes.html`,
`gestion_proveedores.html` (nube + `ciervo_suppliers`; estado vacío `no-suppliers-message`),
`gestion_empresa.html`, `index.html` (el login es Firebase Authentication; la clave local `users` ya no se
lee), `gestion_usuario.html`, `mini_market_pos.html`, `mini_market_pos_resumen.html`,
`calcular_precio_ven.html`, `estado_tasas.html`, `verificacion.html`, `menu.html` (los guardados
legítimos) y los módulos `.js` (`datos_cuenta.js`, `cuenta_local.js`, `sesion.js`, `cerrar_sesion.js`,
`sincronizacion.js`, `almacenamiento.js`, `motor_operaciones.js`, `lector_ventas.js`, `migrar_cuentas.js`,
`cloud-access.js`).

**Falsos positivos descartados** (no son datos de muestra y se dejaron tal cual):
- `landing.html:124,227` — "Distribuidora Central SAC" dentro de una maqueta de marketing de la página pública (HTML, nunca se guarda).
- `gestion_empresa.html:1050,1710` — `J-12345678-9` es un **ejemplo de formato** del RIF en un `placeholder`/validador.
- `gestion_proveedores.html:1276` — `Ej: 20123456789` es un `placeholder` del campo documento.
- `mini_market_pos_resumen.html:2283,2757` — `Cliente Anónimo` es el rótulo de una venta sin cliente.
- `mini_market_pos.html` — "sample" se refiere a **muestras del histórico de tasas** (BCV/Binance), no a datos de demostración.
- `config_recibo.html:622-648` (`defaultReceiptConfig`) — valores por defecto del diseñador de ticket ("Factura", "FAC-", "¡Gracias por su visita!"): son configuración funcional, y solo se guardan si el usuario los cambia.

---

## 2. FASE 2 — Qué se eliminó o neutralizó y cómo

Criterio: **(a)** nunca escribir en `localStorage` ni en la nube, **(b)** nunca mostrarse, **(c)** cuenta
nueva o reiniciada = pantalla vacía con su estado vacío normal. Se conservaron las funciones que usa el
arranque, convertidas en **vacías** y documentadas (no se borró ninguna función viva).

### `menu.html`
- `loadSampleInventoryData()` y `loadSampleAccountsData()`: se quitó el arreglo de ejemplo. Ahora hacen
  `this.dataStore.set('inventory', [])` / `set('accounts', [])` y devuelven `[]`. **No se muestran**
  (la tabla del módulo usa su `emptyState` y las notificaciones su `notificationEmpty`) y **no persisten**
  (se conservan intactas las dos líneas comentadas `// this.saveData('inventory');` y
  `// this.saveData('accounts');`, que `pruebas_datos_cuenta.js` verifica).
- Métricas de ejemplo de `initializeDataStores()`: **eliminadas** (nadie las leía ni las guardaba → código
  muerto; se dejó un comentario explicando qué había).
- Se corrigieron los comentarios `// Load sample if ...` de `loadSystemData()`, que ya no describían la realidad.

### `inventario.html`
- `loadSampleData()`: ya no llama a `saveProducts()`. Deja `products = []`, `nextProductId = 1` y devuelve
  `products`. **Cero escrituras.**
- `loadCategories()`: se quitó la lista de 10 categorías; ahora solo queda la opción vacía
  (`{ value: "", text: "Seleccionar categoría" }`), que es el rótulo del `<select>`, y **no se persiste**.
  El cliente crea las suyas con el botón "Añadir Categoria" (sigue funcionando: `addCategory()` +
  `saveCategories()`).
- `renderCategoryList()`: se añadió **estado vacío** ("Aún no hay categorías. Agrega la primera abajo.").

### `compras.html`
- `loadSampleSuppliers()`: fuera el proveedor de ejemplo y fuera la llamada a `saveData()` (que escribía
  tres claves y subía a la nube). Ahora `suppliers = []`, `nextSupplierId = 1`, devuelve `suppliers`.
- El alta/edición/borrado real de proveedores y compras (`saveSupplier`, `saveData`,
  `firebaseSaveSuppliers`, importación Excel/CSV) queda **intacto**.

### `config_recibo.html`
- `loadCompanyData()`: sin datos de empresa ya **no se inventa** una empresa; `companyData = {}` y se
  mantiene el aviso `missingDataAlert`. La vista previa cae en sus rótulos neutros ("NOMBRE",
  "Dirección...", "...").
- `MOCK_EXCHANGE_RATE` eliminado → nueva `tasaVistaPrevia()` que lee la tasa real configurada por el POS
  (`pos_exchange_rate`, o `pos_exchange_rate_bcv`); si no hay, devuelve 0.
- La vista previa usa un ayudante `money(usd, mult)` que muestra **"—"** cuando no hay tasa configurada
  (no inventa bolívares). Se ajustaron total, descuento, IVA, total de referencia y el pago móvil
  (antes 73,00 Bs ≈ 2 $ a 36,50).
- Rótulos estáticos del HTML: `Tasa: —`, `Total Ref: —` y `Atendido por: —`.
- La empresa real se sigue guardando igual en `companyData` (local y nube) cuando el usuario la escribe.

### `config.html`
- **`createDemoAdminUser()` eliminada** y su paso del 95 % quitado de la lista `steps` del reinicio
  (se dejó un comentario explicando qué hacía). El reinicio ahora borra la clave `users` (paso del 60 %) y
  **no crea nada**. Nada dependía de ella: el acceso real es Firebase Authentication (`signInWithEmailAndPassword`)
  y los operadores viven en la nube (`operadores`), no en `localStorage`. → **Sustituido por el estado
  vacío / limpieza**, tal como pedía el encargo.
- Textos de la confirmación y de la pantalla de éxito reescritos: ya no prometen ni muestran credenciales demo.

---

## 3. FASE 3 — Datos ya plantados: firma, diagnóstico y limpieza a mano

No se borró nada de lo ya guardado (podría confundirse con datos reales). Se añadió al **panel "Avanzado"**
de `config.html` un diagnóstico **de solo lectura** (`id="almMuestras"`, funciones
`diagnosticoDatosDeMuestra()` y `muestrasPintarDiagnostico()`, refrescado al medir el almacenamiento y con
el botón "Refrescar medición"). **No escribe, no borra y no sube nada.**

### Firma de cada dato de muestra (lo que busca el diagnóstico)

| Dato | Firma |
|---|---|
| Productos | `code` exacto ∈ {`LAP-HP-001`, `TEL-SAM-002`, `AUD-SON-003`, `CAM-NIK-004`, `CAF-NES-005`} con su nombre correspondiente (Laptop HP Pavilion, Smartphone Samsung Galaxy, Audífonos Sony WH-1000XM4, Camiseta Nike Dri-FIT, Cafetera Nespresso). Costos 580/320/180/25/150; precios 783/448/270/40/217,50; márgenes 35/40/50/60/45. Los añadidos por el POS llevan además `stockHistory` con `reason: 'Initial Load'` y `notes: 'Stock inicial cargado'` |
| Cuentas | `description` ∈ {Venta de productos electrónicos, Compra de materia prima, Servicio de consultoría, Alquiler de oficina, Venta de software} **y** `contact` ∈ {Cliente A, Proveedor X, Empresa B, Arrendador, Cliente C}. Importes 1250,75 / 800 / 500 / 1500 / 300; notas "Factura #2023-001", "Orden de compra #PO-005", "Pago de alquiler de Diciembre", "Pagado el 2023-12-01" |
| Proveedores | `name: 'Distribuidora Central SAC'` o `document: '20123456789'` o `email: 'ventas@distribuidoracentral.com'` |
| Categorías | La lista **completa** de 10 (Electrónicos, Ropa, Hogar, Deportes, Libros, Belleza, Automotriz, Frutas y Hortalizas, Charcutería, Otros). Se pide la lista entera para no dar falsos positivos con nombres genéricos como "Hogar" |
| Empresa | `companyName: 'TIENDA DE EJEMPLO C.A.'` o `rif: 'J-12345678'` |
| Usuario | `username: 'Admin'` + `password: 'Admin123'`, o `email: 'admin@demo.com'`, o `document: 'DEMO-001'` |
| Clientes | **No hay firma de ejemplo**: ningún sembrador creó clientes. Los que haya salen de ventas reales del POS (el diagnóstico lo dice explícitamente) |

### Cómo distinguir un dato de muestra de uno real

- Un **producto real** tiene un código que eligió el negocio, precios en su propia escala y aparece con
  movimientos de stock/ventas posteriores. Los 5 de ejemplo tienen exactamente los códigos y precios de la
  tabla de arriba y ningún movimiento real.
- Una **cuenta real** la creó el dueño: descripción propia y un contacto que existe en el negocio. Las 5 de
  ejemplo se reconocen por la pareja descripción+contacto ("Cliente A", "Proveedor X", "Empresa B",
  "Arrendador", "Cliente C") y por esas notas.
- El **proveedor de ejemplo** es exactamente "Distribuidora Central SAC".
- Las **categorías** de ejemplo son exactamente las 10 de la lista.
- La **empresa de ejemplo** es exactamente "TIENDA DE EJEMPLO C.A." con RIF "J-12345678".

### Qué haría el dueño para limpiarlos a mano

1. Abrir `config.html` → sección **Almacenamiento** → botón **Avanzado** (o "Refrescar medición") y leer el
   bloque nuevo: dirá cuántos elementos sospechosos hay y sus nombres.
2. Si son suyos de verdad, no hacer nada. Si no lo son:
   - **Productos**: `inventario.html` → seleccionar la fila → eliminar (o selección múltiple → acción masiva).
   - **Cuentas**: `cuentas.html` → botón de eliminar de cada cuenta.
   - **Proveedores**: `compras.html` (pestaña Proveedores) o `gestion_proveedores.html` → eliminar. Ojo:
     `compras.html` no deja borrar un proveedor con compras asociadas; hay que borrar antes la compra.
   - **Categorías**: `inventario.html` → "Añadir Categoria" abre el gestor → botón ✕ de cada una.
   - **Empresa**: `gestion_empresa.html` → sobrescribir los campos con los datos reales y guardar.
   - **Usuario demo**: si existiera la clave `users` en el navegador, el propio **reinicio de fábrica** de
     `config.html` la borra; no hay que hacer nada más.
3. Como las escrituras pasan por el aislamiento por cuenta de `datos_cuenta.js`, el diagnóstico lee las
   claves **de la cuenta activa de este equipo**. Los borrados manuales se suben a la nube con el flujo
   normal de cada página (marca `_pendSync_*`).

---

## 4. FASE 4 — Pruebas

Nueva suite: `pruebas_sin_datos_muestra.js` (`node pruebas_sin_datos_muestra.js`).
Carga las funciones **reales** extraídas del HTML en un sandbox `vm` con un `localStorage` falso que
anota cada escritura y cada borrado, y comprueba además que ese almacén no cambia.

Salida literal (guardada también en `_salida_pruebas_sin_datos_muestra.txt`):

```
================ 1. Ninguna página ni .js conserva arreglos de datos de ejemplo ================
OK    se revisan las páginas y los .js del proyecto (30 archivos)
OK    ninguna página/.js (sin contar config.html) tiene datos de muestra
OK    config.html · las firmas de ejemplo viven solo dentro del diagnóstico
OK    config.html · el diagnóstico de muestras no escribe ni borra nada
OK    config.html · el reinicio sigue borrando la clave local "users" (restos de versiones viejas)

================ 2. Los sembradores reales, con almacén vacío: cero escrituras y vacío ================
OK    inventario.html · loadSampleData() no escribe ninguna clave
OK    inventario.html · loadSampleData() deja products vacío
OK    inventario.html · loadSampleData() devuelve un arreglo vacío
OK    inventario.html · loadSampleData() reinicia el contador de ids
OK    inventario.html · loadCategories() no escribe ninguna clave
OK    inventario.html · loadCategories() deja solo el rótulo vacío
OK    inventario.html · la única opción es la vacía
OK    compras.html · loadSampleSuppliers() no escribe ninguna clave
OK    compras.html · loadSampleSuppliers() deja suppliers vacío
OK    compras.html · loadSampleSuppliers() devuelve un arreglo vacío
OK    compras.html · loadSampleSuppliers() reinicia el contador de ids
OK    menu.html · los sembradores no escriben en localStorage
OK    menu.html · el inventario de ejemplo queda vacío
OK    menu.html · las cuentas de ejemplo quedan vacías
OK    menu.html · los sembradores devuelven arreglos vacíos
OK    menu.html · los sembradores tocan SOLO el almacén en memoria (inventory, accounts)
OK    config_recibo.html · loadCompanyData() no escribe ninguna clave
OK    config_recibo.html · sin datos de empresa NO se inventa una empresa
OK    config_recibo.html · se avisa de que faltan los datos de empresa

================ 3. Arranque real con almacén vacío: listas vacías y CERO escrituras ================
OK    inventario.html · arranque sin datos: 0 escrituras
OK    inventario.html · arranque sin datos: lista vacía
OK    inventario.html · arranque sin datos: se pinta el estado vacío
OK    cuentas.html · arranque sin datos: 0 escrituras
OK    cuentas.html · arranque sin datos: lista vacía
OK    cuentas.html · arranque sin datos: se pinta la lista vacía
OK    cuentas.html · arranque sin datos: NO se guarda la caché
OK    gestion_proveedores.html · arranque sin datos: 0 escrituras
OK    gestion_proveedores.html · arranque sin datos: lista vacía
OK    gestion_proveedores.html · tiene estado vacío propio para la lista
OK    menu.html · arranque sin datos: 0 escrituras en localStorage
OK    menu.html · arranque sin datos: inventario vacío
OK    menu.html · arranque sin datos: cuentas vacías

================ 4. El reinicio de fábrica ya no crea ningún usuario de ejemplo ================
OK    config.html · ya no define createDemoAdminUser
OK    config.html · ya no escribe la clave "users" en localStorage
OK    config.html · ningún paso del reinicio crea usuarios de ejemplo
OK    config.html · la pantalla de éxito ya no muestra credenciales demo
OK    config.html · el aviso previo ya no promete un usuario demo
OK    config.html · el arranque del login no depende de la clave local "users"
OK    config.html · los pasos del reinicio son extraíbles
OK    config.html · el reinicio no escribe NINGUNA clave
OK    config.html · el reinicio borra el usuario de ejemplo que hubiera
OK    config.html · el reinicio borra inventario, proveedores, cuentas, categorías y empresa
OK    config.html · el reinicio borra las marcas de sincronización pendientes
OK    config.html · y NO crea ningún usuario nuevo (no se escribe "users")

================ 5. El diagnóstico de datos sospechosos detecta y NO borra ================
OK    config.html · las firmas del diagnóstico son extraíbles
OK    diagnóstico · cuenta 3 productos de ejemplo (ignora el producto real)
OK    diagnóstico · nombra los productos sospechosos y no el real
OK    diagnóstico · cuenta 2 cuentas de ejemplo (ignora la real)
OK    diagnóstico · cuenta 1 proveedor de ejemplo (ignora el real)
OK    diagnóstico · detecta la lista completa de 10 categorías de demostración
OK    diagnóstico · detecta los datos de empresa de ejemplo
OK    diagnóstico · detecta el usuario administrador demo
OK    diagnóstico · avisa de que los clientes no tienen firma de ejemplo
OK    diagnóstico · resume el total y deja claro que es de solo lectura
OK    diagnóstico · NO escribe ninguna clave
OK    diagnóstico · NO borra ninguna clave
OK    diagnóstico · el almacén queda EXACTAMENTE igual
OK    diagnóstico · con datos reales el total es 0 (sin falsos positivos)
OK    diagnóstico · con datos reales lo dice claramente
OK    diagnóstico · tampoco escribe con datos reales
OK    diagnóstico · ni cambia el almacén con datos reales

================ 6. Integridad de las páginas tocadas ================
OK    las páginas tocadas conservan CRLF
OK    menu.html · sintaxis de sus 1 bloque(s) en línea
OK    inventario.html · sintaxis de sus 2 bloque(s) en línea
OK    compras.html · sintaxis de sus 1 bloque(s) en línea
OK    config_recibo.html · sintaxis de sus 1 bloque(s) en línea
OK    config.html · sintaxis de sus 2 bloque(s) en línea
OK    menu.html · los dos sembradores siguen existiendo (los usa el arranque)
OK    menu.html · los sembradores ya no persisten en la clave del usuario
OK    menu.html · los guardados legítimos del usuario siguen intactos
OK    inventario.html · el alta real sigue guardando el inventario
OK    inventario.html · el gestor de categorías sigue guardando lo que el usuario crea
OK    compras.html · el alta real de proveedores sigue guardando
OK    config_recibo.html · la vista previa ya no usa una tasa de mentira
OK    config_recibo.html · la empresa sigue guardándose desde el formulario real
OK    config.html · el diagnóstico cuelga del panel Avanzado (id almMuestras)
OK    config.html · el panel refresca el diagnóstico al medir

================ 82 OK, 0 FALLAS ================
```

### Verificación obligatoria

| Comprobación | Resultado |
|---|---|
| `node --check pruebas_sin_datos_muestra.js` | exit 0 |
| `new vm.Script` de los bloques en línea de `menu.html`, `inventario.html`, `compras.html`, `config_recibo.html`, `config.html` | todos compilan OK (1, 2, 1, 1 y 2 bloques) |
| CRLF | `menu.html` 4111/0, `inventario.html` 4736/0, `compras.html` 3305/0, `config_recibo.html` 1088/0, `config.html` 3253/0, `pruebas_sin_datos_muestra.js` 582/0 (CRLF / LF sueltos) |
| `pruebas_datos_cuenta.js` | 187 OK, 0 FALLAS (exit 0) |
| `pruebas_cuenta_local.js` | 79 OK, 0 FALLAS (exit 0) |
| `pruebas_motor_real.js` | 127 OK, 0 FALLAS (exit 0) |
| `_pruebas_historial_almacenamiento.js` | 161/161 OK, sin fallos (exit 0) |
| `pruebas_sincronizacion.js` | 83 OK, 0 FALLAS (exit 0) |
| `pruebas_lector_ventas.js` | 64 OK, 0 FALLAS (exit 0) |
| `pruebas_motor_operaciones.js` | 49 OK, 0 FALLAS (exit 0) |
| `pruebas_acceso.js` | 65 OK, 0 FALLAS (exit 0) |
| `pruebas_sesion.js` | 42 OK, 0 FALLAS (exit 0) |
| `pruebas_sin_datos_muestra.js` | 82 OK, 0 FALLAS (exit 0) |

`git diff --stat` de lo tocado en esta limpieza:

```
 compras.html       |  24 ++++--
 config.html        | 241 +++++++++++++++++++++++++++++++++++++++++++++--------
 config_recibo.html |  68 ++++++++++++-----
 inventario.html    |  46 ++++++++----
 menu.html          | 198 +++++------------------------------------
 5 files changed, 331 insertions(+), 246 deletions(-)
```

(No hay commits ni push; el árbol de trabajo sigue con los cambios pendientes, como pedía el encargo.)

---

## 5. Qué quedó sin verificar / limitaciones

1. **No hubo navegador real ni Firebase real**: todo se comprobó de forma estática y ejecutando funciones
   reales en `vm` con almacenes falsos. No se verificaron contra el proyecto Firebase en vivo ni el
   comportamiento de dos pestañas a la vez.
2. **La vista previa del ticket de `config_recibo.html` sigue siendo una maqueta**: conserva artículos de
   ejemplo ("HARINA PAN", "QUESO SEMIDURO"), `Nº: FAC-V-0045`, la fecha `07/12/2025 10:30 AM` y
   "Caja Principal". Se decidió **no quitarlos** porque son el andamiaje visual del diseñador de tickets y
   **no se guardan en ningún sitio**; lo que sí se quitó fue la identidad de empresa falsa, la tasa
   inventada y el "Atendido por: Admin".
3. **No se tocaron los datos ya plantados** en el navegador de nadie (por diseño): el diagnóstico solo los
   lista. La limpieza real es manual (pasos en el punto 3).
4. **El diagnóstico lee las claves de la cuenta activa** de este equipo (las prefija `datos_cuenta.js`). Si
   el módulo no hubiera activado ninguna cuenta en ese instante, leería las claves sin prefijo (los restos
   anteriores al aislamiento). En el uso normal `activarPerezoso()` ya ha activado la cuenta al cargar la
   página.
5. **`landing.html`** conserva textos de maqueta ("Distribuidora Central SAC", "Harina PAN 1kg") por ser
   una página pública de marketing sin datos guardados; no se consideraron datos de muestra de la app.
6. No se ejecutaron las importaciones Excel/CSV (no había navegador); se verificó **por texto** que los
   flujos de importación y el alta/edición real siguen en pie (`saveSupplier`, `saveProducts`,
   `addCategory`, `saveCategories`, `setItem('companyData')`).
