# Auditoría del almacenamiento híbrido (local + nube) y del modelo de cobro

Fecha: 2026-09-18 · Alcance: `cloud-access.js`, `mini_market_pos.html` (ruta del dinero), `inventario.html` (módulo patrón), `index.html` (arranque y alta de cuentas), `config.html`, más el contraste con las reglas publicadas de Realtime Database.

---

## 1. Veredicto en una frase

**El concepto es compatible con lo que quieres, la implementación actual no lo cumple.** El esqueleto correcto ya está (primero local, permiso centralizado, subir al reconectar), pero el motor de sincronización sube **estados completos** en vez de **operaciones**, y la marca de "pendiente de subir" no se activa cuando estás sin internet. Resultado: **hoy se pueden perder ventas y movimientos hechos sin conexión**, y con dos dispositivos la última subida borra las ventas del otro. Los arreglos son **generales** (afectan a los 10 módulos), no parches de una página.

Lo que **sí** puedes vender ya: el modo local funciona sin pagar, y el cobro por nube se puede activar/desactivar desde la consola sin tocar código. Lo que **no** puedes prometer todavía: "todas tus operaciones están a salvo en el servidor".

---

## 2. Cómo funciona hoy (verificado en el código)

### 2.1 Piezas

| Pieza | Dónde | Qué hace |
|---|---|---|
| Permiso de nube | `cloud-access.js:6-30` + copia local en cada página (`inventario.html:2232-2246`) | Lee `BBDD/<emailPath>/suscripcion/cloudSync`; si no es `true`, no se toca la nube |
| Datos locales | `localStorage` | `ciervo_inventory`, `ciervo_categories`, `pos_sales`, `ciervo_purchases`, `ciervo_suppliers`, `ciervo_clients`, `ciervo_accounts`, `companyData`, `receiptSettings`… |
| Datos remotos | `BBDD/<emailPath>/...` | `productos`, `categorias`, `ventas/historial`, `ventas/ultimo_numero`, `clientes`, `proveedores`, `empresa`, `suscripcion/cloudSync` |
| Subida | `inventario.html:2330-2342`, `mini_market_pos.html:4812-4852` | `ref(...).set(arreglo COMPLETO)` |
| Bajada | `inventario.html:2371-2405`, `mini_market_pos.html:4884-4917` | Descarga y **reemplaza** el arreglo local |
| Marca de pendientes | `localStorage['_pendingFirebaseChanges']` (una sola, compartida) | `true` cuando una subida falla |
| Reconexión | `inventario.html:2280-2303`, `mini_market_pos.html:4767-4792` | Escucha `.info/connected`; si hay pendientes, sube |
| Estado visible | Punto de color por página (`setFirebaseDot`) | Verde/rojo, nada más |

### 2.2 El dato que lo cambia todo: `.set()` NO se resuelve sin internet

Lo comprobé en el código del propio SDK (`firebase-database.js` 8.10.0, función interna de escritura):

```js
function Es(r,i,e,t,o){                       // set()
  ...
  n = ho(r.serverSyncTree_, i, n, s, !0);      // 1) aplica el cambio en LOCAL (evento optimista)
  r.server_.put(i.toString(), e.val(!0), function(e,t){   // 2) manda al servidor
     ...
     xs(0, o, e, t)                            // 3) SOLO aquí se resuelve/rechaza la promesa
  });
}
```

Es decir: **sin conexión, la promesa queda pendiente** (ni resuelve ni rechaza). El SDK guarda la escritura en memoria y la envía al reconectar. Consecuencia directa en el app:

```js
// mini_market_pos.html:4113
fbSaveVentas(ventas).catch(() => { _fbPending = true; localStorage.setItem('_pendingFirebaseChanges','true'); });
```

Sin internet ese `.catch` **nunca se ejecuta** → la bandera de pendientes **no se marca** → el app cree que todo está subido.

---

## 3. Hallazgos

### C1 — CRÍTICO · Una venta hecha sin internet se pierde si se cierra el navegador antes de reconectar

**Cadena del fallo:**
1. Sin internet, la venta se guarda en `localStorage` (`mini_market_pos.html:4108-4109`) y la subida queda encolada **en memoria** del SDK.
2. La bandera de pendientes no se marca (ver 2.2), porque el error no ocurre.
3. El operador cierra el navegador o apaga el equipo → la cola en memoria **desaparece**.
4. Al día siguiente, al abrir: `if (_fbPending) subir(); else descargar();` (`mini_market_pos.html:2059-2062`, idéntico en `inventario.html:2476-2480`).
5. Como la bandera es `false`, se va por la rama de **descargar**, y la descarga **reemplaza** el arreglo local:
   ```js
   // mini_market_pos.html:4899-4903
   if (data.ventas.historial) { localStorage.setItem('pos_sales', JSON.stringify(data.ventas.historial)); ventas = data.ventas.historial; }
   ```
6. La venta desaparece **también del equipo** (y el ticket quedó impreso solo en papel).

**Afecta igual a:** inventario (`saveProducts` → `inventario.html:2910-2917` + descarga en `2377-2389`), compras (`compras.html:2176-2185`, `2421-2433`), cuentas, clientes, proveedores.

**Prueba de 3 minutos (la que decide):** con un cliente que tenga nube activa → desconecta el internet del equipo → haz una venta (el punto se pone rojo) → **cierra el navegador** → vuelve a conectar → abre el POS: si la venta no está, se confirma.

**Arreglo (Fase A, quirúrgico):** marcar la bandera **antes** de intentar subir, no en el `catch`.

---

### C2 — CRÍTICO · Con dos dispositivos, el último en subir borra las ventas del otro

- La subida es del **arreglo completo**: `db.ref(... + '/ventas/historial').set(data)` (`mini_market_pos.html:4815`) y `.../productos').set(data)` (`4851`, `inventario.html:2334`).
- El POS **no escucha** `ventas` en tiempo real: sus listeners son solo `productos` y `empresa` (`mini_market_pos.html:4928`, `4941`).
- Secuencia real (dos cajas o caja + teléfono del dueño): A vende (sube su arreglo) → B vende (sube **su** arreglo, que no contiene la venta de A) → **la venta de A desaparece de la nube**; al recargar, A descarga y **la pierde también en local**.

**El mismo problema con el stock:** el stock es un valor absoluto dentro del producto. Si A vende 3 unidades sin conexión y B vende 2, gana la última subida → el stock queda en "inicial − 2" en vez de "inicial − 5". Deriva de inventario silenciosa.

**No hay operaciones, hay estado.** Para cumplir "que todas las operaciones y movimientos se almacenen" hace falta lo contrario: **cada operación como su propio registro** (`push()` con id único de dispositivo + hora), y fusión por **unión**, nunca por reemplazo.

---

### C3 — ALTO · El consecutivo de tickets es frágil y el numerado en la nube está muerto

- `reserveSaleId()` (`mini_market_pos.html:1981-1993`) llama a **`fbReserveSaleNumber()`, que no existe en ningún archivo**. Ese `ReferenceError` cae en el `catch` (`1989-1991`) y el app **siempre** usa el numerado local: todo ticket real es `V-LOCAL-<dispositivo>-<n>` (`1974-1979`, aplicado a la venta en `4050` y `4075`).
- `peekSaleId()` (`1957-1960`) muestra en pantalla el próximo `V-0007`, que **no coincide** con el id que se imprime y guarda: inconsistencia visible para el cliente.
- `fbSaveNumero()` (`4834-4839`) escribe el número local **sin condición**: un equipo con contador atrasado (por ejemplo tras estar offline) puede **bajar** el contador de la nube, y `reserveSaleId` reutilizaría números → **tickets duplicados**.
- Lo bueno: el id `V-LOCAL-<dispositivo>-<n>` evita colisiones entre equipos (idea correcta, es la semilla de la solución).

---

### C4 — ALTO · Una sola bandera de pendientes compartida por todos los módulos

`_pendingFirebaseChanges` la usan **inventario, compras, catalogo, cuentas, gestion_empresa, listado_clientes y el POS** (`inventario.html:2250`, `compras.html:2290`, `mini_market_pos.html:4642`, etc.), y **cualquiera puede borrarla**: `localStorage.removeItem('_pendingFirebaseChanges')` en `inventario.html:2290` y `mini_market_pos.html:4776`.

Efecto: compras hechas sin conexión + una subida de inventario que sale bien = **la bandera se borra** → en la siguiente carga, compras se va por la rama de descarga y **sus movimientos offline se sobrescriben**. Combina con C1 y multiplica la pérdida.

---

### C5 — MEDIO · Sin conexión, la promesa de subida queda colgada (y nadie la espera)

`saveProducts()` (`inventario.html:2910-2917`) hace `await firebaseSaveProducts(...)`: sin internet ese `await` **no termina nunca**. Se salva porque las llamadas no se esperan (`2830, 2923, 3521, 3962, 3994, 4214, 4645`), así que la interfaz no se congela; el daño real es que **la marca de pendientes no se pone** (C1). Cualquier código futuro que sí espere esa promesa se quedará colgado.

---

### C6 — MEDIO · El permiso se cachea por página y, si el primer chequeo falla, no se reintenta

`checkCloudAccess()` guarda `_cloudAccessChecked = true` incluso cuando el fallo es de red (`inventario.html:2232-2246`). Si la página se abre sin internet: la nube queda desactivada **durante toda la vida de esa página** y `setupConnectionMonitor` no se instala (`2281`), así que **no hay subida automática al volver la conexión**: hay que recargar. `cloud-access.js:9-11` cachea además en `sessionStorage` (esto último sí se limpia en cada carga, `index.html:1816`).

---

### C7 — MEDIO · El usuario no ve nada: ni pendientes, ni última sincronización, ni "solo local"

Para el plan local (no paga) la app **no avisa** de que sus datos viven únicamente en ese navegador; para el plan nube solo hay un punto verde/rojo. Un servicio de pago necesita pruebas visibles de sincronización, y un plan gratuito necesita advertencias y respaldo.

---

### C8 — MEDIO · El plan "solo local" es frágil

- `localStorage` ronda los **5 MB**. `ciervo_inventory` guarda **imágenes en base64** dentro de cada producto (ver `mergeInventoryWithLocal`, `inventario.html:2352-2369`) → riesgo real de llenar la cuota.
- **No hay `try/catch`** en los `localStorage.setItem` de guardado: al llenarse, la excepción corta la operación a medias (interfaz y datos quedan descoordinados).
- **No hay exportar/importar respaldo en JSON**: si el usuario limpia los datos del navegador o cambia de equipo, lo pierde todo sin remedio.
- El plan gratuito no tiene ninguna red de seguridad: es exactamente el cliente al que hay que darle un "descargar mi respaldo".

---

### C9 — MEDIO · La configuración del POS no se sincroniza

`config.html:2495-2573` guarda en local (sin nube) `pos_exchange_rate`, `pos_rate_mode`, `pos_apply_iva`, `pos_default_currency`, `pos_sale_prefix`, `inv_default_min_stock`, `cta_reminder_days`, `precio_default_margin`, `precio_rounding`, `sys_session_timeout`, `sys_auto_save`. En un segundo dispositivo el negocio "cambia de personalidad" (prefijo de ticket, IVA, tasa). `companyData` y `receiptSettings` sí viajan (`config_recibo.html:739-757`, `gestion_empresa.html:1674`).

---

### C10 — BAJO · Si le retiras el permiso a un cliente, la degradación es segura pero silenciosa

Con `cloudSync = false`: las lecturas se deniegan por reglas → la descarga falla y **no hay sobrescritura** (bien: sus datos locales quedan intactos), el app sigue operando en local y las subidas son rechazadas → la promesa **sí** rechaza → la bandera se marca (correcto). El único problema es que **nadie le dice al cliente** que perdió la nube; la app reintenta en silencio para siempre.

---

## 4. Lo que está bien y no hay que romper

1. **Local primero, siempre** (`4108-4109`, `2911`): el negocio nunca deja de operar por falta de internet. Es la base correcta.
2. **El permiso está en dos capas**: en el app (`checkCloudAccess`) y en el servidor (las reglas exigen `ingreso: true` y la app consulta `suscripcion/cloudSync`). Un cliente que no paga **no puede** escribir en la nube aunque manipule el navegador.
3. **`ensureUserCloudStructure` es seguro** (`mini_market_pos.html:4688-4722`, `index.html:1794-1822`): solo crea `cloudSync = false` cuando **no existe**; jamás pisa un `true` con un `false`. Tu cobro no se puede "resetear" solo.
4. **Id de venta por dispositivo** (`V-LOCAL-<device>-<n>`, `1974-1979`): evita colisiones entre cajas sin conexión. Es la idea que hay que extender.
5. **`fbUpsertClient` hace leer-fusionar-escribir** (`4818-4832`): dirección correcta (le falta atomicidad y escala).
6. **Cortes breves con la pestaña abierta sí llegan a la nube**: la cola en memoria del SDK se vacía al reconectar. El diseño aguanta una caída de minutos, no un cierre del equipo.

---

## 5. Compatibilidad con tus dos requisitos

| Requisito | ¿Compatible hoy? | Qué falta |
|---|---|---|
| Operar sin internet y **subir todo** al recuperar | Parcial: funciona con la pestaña abierta; **falla si se cierra el equipo** (C1) y **pierde operaciones con 2 dispositivos** (C2) | Cola de operaciones persistente (outbox) + subida por operación + fusión por unión |
| Cobrar por la nube; quien no paga, solo local | **Sí, en lo esencial**: el interruptor `cloudSync` ya gobierna lectura y escritura, y degradar es seguro (C10) | Aviso visible de "solo local", respaldo exportable y protección de cuota (C7, C8) |
| "Cierto periodo" sin internet | **Indefinido y sin política** | Definir ventana (p. ej. 30 días) con `suscripcion/vence` y mostrar cuenta atrás |

---

## 6. Plan recomendado

### Fase A — Parar la pérdida de datos (pocas horas, cambios pequeños en los 10 módulos)
1. **Marcar pendiente antes de subir**, y limpiar la marca solo cuando la subida confirme:
   ```js
   marcarPendiente('inventario');            // ANTES de intentar
   try { await firebaseSaveProducts(products); limpiarPendiente('inventario'); }
   catch (e) { /* la marca ya está puesta */ }
   ```
2. **Una bandera por módulo y por negocio** (por ejemplo `_pendSync_inventario_<emailPath>`), nunca una global.
3. **Nunca descargar encima si hay pendientes**: si `hayPendientes()` → subir primero y **fusionar por unión**, jamás reemplazar el arreglo local.
4. **Arreglar el numerado**: definir `fbReserveSaleNumber` con `ref.transaction()` (o eliminar la llamada muerta) y hacer que `fbSaveNumero` **nunca** escriba un número menor (transacción con `max`).

### Fase B — Motor de sincronización correcto (el trabajo de fondo)
- **Operaciones, no estados**: `BBDD/<path>/ventas/ops/<deviceId>_<uuid>` con `push()`; idempotente, sin colisiones, fusión por unión.
- **Stock por movimientos**: cada ajuste/venta escribe `ServerValue.increment(-3)` (o un registro de movimiento); nunca `.set()` del producto completo.
- **Contadores atómicos**: `transaction()` para el consecutivo; el id impreso (`V-LOCAL-...`) no se reescribe y el consecutivo fiscal se asigna al sincronizar.
- **Outbox persistente** por módulo en `localStorage`: `{op, payload, id, ts, intentos}`; sobrevive al cierre del navegador; se vacía operación por operación al confirmar el servidor.
- **Fusión con política explícita** (`mergeById`): la nube manda en lo que la nube es dueña, lo local se conserva en lo que solo existe en el equipo (imágenes, campos nuevos).
- **Escuchar `ventas`** (o refrescar al reconectar) para que dos cajas se vean entre sí.

### Fase C — Producto
- **Centro de sincronización**: "3 operaciones pendientes · última sincronización hace 2 h" y aviso grande cuando esté en modo solo local.
- **Respaldo para el plan local**: exportar/importar JSON + aviso al abrir si nunca se ha respaldado.
- **Cuota**: `try/catch` en los guardados con mensaje claro ("almacenamiento del navegador lleno: activa la nube o exporta tu respaldo").
- **Vencimiento con gracia**: `suscripcion/cloudSync` + `suscripcion/vence`; reglas que permitan escribir durante N días de gracia y app que muestre "renueva tu nube".
- **Sincronizar la configuración del POS** (C9) para que todos los equipos compartan prefijo, IVA y tasa.

---

## 7. Pruebas de regresión propuestas

| # | Prueba | Qué demuestra |
|---|---|---|
| 1 | Desconectar → vender → **cerrar navegador** → reconectar → abrir POS | Que C1 quedó cerrado (la venta sigue ahí y llega a la nube) |
| 2 | Dos pestañas/dispositivos con la misma cuenta, uno sin conexión; ambos venden; reconectar | Que no se borra ninguna venta (C2) |
| 3 | Dos dispositivos sin conexión vendiendo el mismo producto con poco stock | Que el stock descuenta la suma de ambos (C2, stock) |
| 4 | Retirar `cloudSync` en la consola con el equipo en marcha | Que el app avisa, sigue en local y no pierde nada (C10, C7) |
| 5 | Llenar `localStorage` con imágenes | Que avisa en vez de romper el guardado (C8) |
| 6 | Simulador en Node de N dispositivos + ventanas offline (como las pruebas de tasas ya existentes) | Prueba automatizable del motor nuevo antes de tocar producción |

---

## 8. Respuesta directa a la pregunta

- **¿Es compatible la lógica con lo que quieres?** El planteamiento sí; el motor actual no. Tal como está, **no pasa la auditoría** para el requisito "todas las operaciones y movimientos se almacenan en el servidor".
- **¿Habrá que hacer cambios generales?** Sí. El patrón está replicado, así que el arreglo también debe replicarse: **Fase A sí o sí** (es donde hoy se pierden datos) y **Fase B** para poder vender la nube con garantías. En cuanto a la estructura de datos, `BBDD/<emailPath>/...` y el interruptor `suscripcion/cloudSync` **se conservan**; lo que cambia es **cómo** se escribe dentro (operaciones en vez de arreglos completos).

---

## Anexo A — Evidencia rápida (archivo:línea)

| Tema | Evidencia |
|---|---|
| Promesa de `.set()` solo al confirmar el servidor | `firebase-database.js` 8.10.0, función interna `Es` → `xs(0,o,e,t)` dentro del callback de `server_.put` |
| Bandera de pendientes en el `catch` | `mini_market_pos.html:4113-4116`, `inventario.html:2910-2917`, `compras.html:2176-2185` |
| Rama de carga: subir o descargar | `mini_market_pos.html:2059-2062`, `inventario.html:2476-2480` |
| Descarga que reemplaza lo local | `mini_market_pos.html:4899-4903`, `inventario.html:2377-2389` |
| Subida de arreglo completo | `mini_market_pos.html:4815`, `4851`; `inventario.html:2334`, `2341` |
| Listeners que no incluyen ventas | `mini_market_pos.html:4919-4945` |
| Bandera compartida y borrada | `inventario.html:2250`, `2290`; `mini_market_pos.html:4642`, `4776`; `compras.html:2290` |
| Permiso cacheado | `inventario.html:2232-2246`, `cloud-access.js:9-11` |
| Consecutivo muerto | `mini_market_pos.html:1983` (`fbReserveSaleNumber` no existe), `4834-4839` |
| Sin `try/catch` en guardados locales | `inventario.html:2911`, `mini_market_pos.html:4109` |
| Estructura inicial segura | `mini_market_pos.html:4688-4722`, `index.html:1794-1822` |

---

## Anexo B — Auditoría de replicación entre los 10 módulos

Un segundo análisis independiente comparó las 10 páginas (informe completo en `AUDITORIA_REPLICACION_SYNC.md`, 20 desviaciones y 12 riesgos). Lo esencial:

### El patrón NO estaba replicado de forma idéntica
Cada página tiene su propia copia de `checkCloudAccess`, del monitor de conexión y de las funciones de subida, y difieren: `catalogo.html` solo sube (nunca descarga y no tiene monitor), `compras.html` no tiene listener de datos, `config_recibo.html` es de solo lectura, `listado_clientes.html` no persiste la lista en local cuando hay nube, y `cuentas.html`, `gestion_empresa.html`, `config_recibo.html`, `listado_clientes.html` y `mini_market_pos_resumen.html` **descargan sin consultar pendientes**.

### Tres hallazgos que obligaron a ampliar la Fase A
1. **El reintento al reconectar era código muerto.** `setupConnectionMonitor` está definido en 8 páginas y **no se invocaba en ninguna**: la única llamada (`cloud-access.js:24`) quedaba anulada porque cada página define su propia `checkCloudAccess` de nivel superior, que sobrescribe la del archivo común. → Fase A: instalarlo explícitamente y no saltárselo cuando el permiso no se pudo confirmar.
2. **`catalogo.html` subía stock sin haber descargado nunca**: podía sobrescribir el inventario real con su copia local antigua. → Fase A: marca de pendientes + guardia de descarga.
3. **`gestion_proveedores.html` descartaba el alta si fallaba la nube** (no la guardaba ni en memoria ni en local). → Fase A: guardar siempre en local antes de intentar la nube.
4. `config.html` (reinicio de fábrica) borraba `pos_customers`, clave que **ninguna** página usa, y dejaba intacta la real (`ciervo_clients`). → corregido.

### Lo que queda para la Fase B
- **Proveedores partidos en dos nodos**: `/proveedores` (claves `push`) en `gestion_proveedores.html` frente a `/compras/proveedores` (arreglo con `id` numérico) en `compras.html`, sobre la misma clave local `ciervo_suppliers`. `compras.html` calcula `Math.max(...ids)+1` sobre ids que pueden ser cadenas → `NaN` y ids corruptos.
- **`/clientes` con dos estrategias incompatibles**: leer-modificar-escribir del objeto completo al cerrar cada venta (POS) frente a `update()` parcial por clave (listado).
- **`receiptSettings` no se respalda** en la nube.
- **El reinicio de fábrica no toca los nodos remotos**: lo borrado "reaparece" al recargar.
- **Tema oscuro con dos claves** (`theme` y `darkMode`) según la página: cosmético.
