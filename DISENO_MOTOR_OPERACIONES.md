# Diseño del motor de operaciones (Fase B)

**Estado:** diseño cerrado, **sin implementar**. Este documento no toca código de la aplicación.
**Fecha:** 2026-02 (borrador de trabajo)
**Ámbito:** `BBDD/<emailPath>/...` en Firebase Realtime Database v8, páginas HTML estáticas
(`mini_market_pos.html`, `compras.html`, `inventario.html`, `cuentas.html`, `listado_clientes.html`,
`catalogo.html`, `gestion_empresa.html`, `gestion_proveedores.html`, `mini_market_pos_resumen.html`).

## 0. Problema que resuelve

Hoy (`sincronizacion.js` Fase A + `fbSaveVentas`/`fbSaveCompras`/`fbSaveProductos`):

* Se sube el **arreglo completo**: `db.ref(... + '/ventas/historial').set(ventas)`. Dos equipos que
  suben su arreglo se **pisan** (AUDITORIA_REPLICACION_SYNC.md, C2: sigue abierto).
* Se descarga **reemplazando** lo local (`localStorage.setItem('pos_sales', JSON.stringify(...))`).
* `pos_sales` crece sin techo en `localStorage` (~5 MB por origen) y el histórico se archiva a
  IndexedDB (`almacenamiento.js`) para sobrevivir.

El motor de operaciones sustituye "subir el estado" por "subir los hechos": cada venta, compra,
movimiento o cambio de catálogo es una **operación inmutable** con clave única, que se encola en el
equipo antes de tocar la red y se sube de forma **idempotente**. La nube pasa a ser la fuente de
verdad del histórico; el equipo solo guarda una **ventana caliente** de 30 días.

---

## 1. Operación en la nube

### 1.1 Ruta

```
BBDD/<emailPath>/ops/<tipo>/<deviceId>_<secuencia>
```

| Parte | Valor | Origen |
|---|---|---|
| `emailPath` | correo normalizado | `sanitizeEmailForDb(email)` (ya existe en todas las páginas) |
| `tipo` | `venta` \| `compra` \| `movimiento` \| `cliente` \| `cuenta` \| `producto` | módulo que la produce |
| `deviceId` | 8 caracteres `[A-Z0-9]` | el que ya usa el POS: `localStorage['pos_device_id']` (`getPosDeviceId()`) |
| `secuencia` | entero creciente **por equipo** | el que ya usa el POS: `localStorage['pos_last_sale_number']` |

Ejemplo:

```
BBDD/negocio_at_ejemplo_com/ops/venta/7K3F9QAB_0007
```

### 1.2 Valor (payload de la operación)

```json
{
  "id": "V-LOCAL-7K3F9QAB-0007",
  "tipo": "venta",
  "deviceId": "7K3F9QAB",
  "secuencia": 7,
  "fechaISO": "2026-02-14T15:04:05.123Z",
  "operador": "maria",
  "version": 1,
  "payload": { "...": "el objeto de negocio tal cual lo produce la app" }
}
```

Reglas del payload:

* `id` es la **clave de operación** (también clave de idempotencia). Se guarda dentro del valor
  aunque ya esté en la ruta, para que un nodo leído suelto sea autocontenido.
* `version` empieza en `1`. Si algún día cambia el formato del `payload`, se sube a `2`; **nunca se
  reescribe una operación vieja para "migrarla"**.
* `secuencia` se serializa **sin ceros a la izquierda** en el campo (`7`) y **con relleno de 4** en
  la ruta (`0007`), para que la ruta ordene alfabéticamente y el campo ordene numéricamente.
* **Toda operación lleva `secuencia`**, también las de catálogo (producto/cliente/cuenta). No es un
  contador de ventas: es el **orden de subida de ese equipo**, y es lo que hace que la cola se vacíe
  en orden (§3 y §5). El POS sigue numerando sus ventas con `pos_last_sale_number`; las operaciones
  de catálogo toman el siguiente número de la misma serie. Como la secuencia solo tiene que ser
  única por `deviceId`, compartir la serie no molesta a nadie y evita dos contadores que se puedan
  desincronizar.
* A igualdad de `fechaISO`, `secuencia` + `deviceId` dan un **orden total determinista**: dos equipos
  aplican el log en el mismo orden y llegan al mismo estado (es lo que hace posible el merge de §7).
* No se admiten valores `undefined` (Firebase RTDB los rechaza): todo campo opcional se omite, no se
  escribe `null` "de relleno". Un `deviceId` o una `secuencia` ausentes son un error de programación,
  no un caso a tolerar: una operación sin secuencia rompe el orden de la cola.
* El `payload` de una `venta` es exactamente el objeto `saleData` de `processSale()`
  (`mini_market_pos.html`, ~línea 4195), sin recortes, para que el recibo y el resumen se puedan
  reconstruir sin depender del equipo que la creó.

### 1.3 Regla 1: append-only

* Una operación, una vez escrita, **no se modifica ni se borra**. Ni el equipo, ni la nube, ni el
  índice.
* Una corrección (anular una venta, corregir un precio mal tecleado, arreglar un cliente) es una
  **operación nueva** que **referencia a la original**:

```json
{
  "id": "V-LOCAL-7K3F9QAB-0031",
  "tipo": "venta",
  "deviceId": "7K3F9QAB",
  "secuencia": 31,
  "fechaISO": "2026-02-14T16:20:00.000Z",
  "operador": "maria",
  "version": 1,
  "payload": { "anula": "V-LOCAL-7K3F9QAB-0007", "motivo": "error de cobro", "total": 0 }
}
```

* El `payload.anula` crea un **grafo de dependencias**: la operación corregida nunca se "deshace" en
  el histórico; el estado vigente se calcula aplicando el log en orden de `fechaISO` (y, a igualdad,
  de `secuencia` + `deviceId`) y dejando que las correcciones ganen.
* Esto es lo que permite que dos equipos vendan a la vez sin conflictos: **no hay campo compartido
  que pisar**.

### 1.4 Regla 2: idempotencia por clave

* La clave es la ruta completa `ops/<tipo>/<deviceId>_<secuencia>`.
* Escribir dos veces la **misma clave** con el **mismo contenido** es un no-op observable: el
  servidor queda igual y ningún contador cambia. En la práctica: reintentos, reconexiones y
  "reintentar todo lo pendiente" son seguros por construcción.
* Escribir la misma clave con **contenido distinto** es un error de programación (nunca se reutiliza
  una secuencia). El motor lo detecta comparando el valor que ya está en la nube con el que intenta
  subir: si difieren, **no sobrescribe**, deja la operación como `conflicto` en la cola y avisa en
  el punto de estado. Es la única conducta compatible con append-only.
* Implicación práctica: `deviceId` + `secuencia` debe ser único **para siempre** en ese equipo. La
  secuencia no se puede reiniciar mientras existan operaciones de ese `deviceId` en la nube (ver
  §11, "reinicio de fábrica").

### 1.5 Coste

Cada operación es un `set()` sobre una hoja nueva: no hay lectura previa, no hay `transaction`, no
hay carrera con otro equipo. Una venta = 1 escritura. Es más escrituras que hoy (1 por venta en vez
de 1 por arreglo), pero cada una es diminuta y no crece con el histórico; es lo que hace que el
sistema no se degrade con el tiempo.

---

## 2. Índice de agregados `ventas_idx` (opcional pero recomendado)

```
BBDD/<emailPath>/ventas_idx/<AAAA-MM-DD>/<claveOperacion> = { "total": 123.45, "items": 4, "metodo": "usd-cash" }
```

* Se escribe **después** de confirmar la operación (nunca antes) y con clave = la misma clave de
  operación (`<deviceId>_<secuencia a 4 dígitos>`, igual que la ruta), así que también es
  idempotente.
* Sirve para que el resumen del día, `mini_market_pos_resumen.html` y los cierres de caja lean
  **un solo nodo por día** en vez de bajar el log completo de ventas.
* **Nunca es fuente de verdad**: es un caché derivado. Si falta, está viejo o discrepa, se
  **reconstruye** desde `ops/venta/*` (función `reconstruirIndiceVentas(fechaDesde, fechaHasta)`).
  La reconstrucción se dispara cuando el índice del día no existe o cuando **falta alguna clave de
  operación** (no basta con comparar recuentos: una entrada pisada o puesta en `null` deja el nodo
  con el mismo número de claves y el total equivocado). El simulador prueba exactamente eso: se
  borra una entrada, se detecta la clave que falta y se reconstruye con el total correcto
  (`T10` de `pruebas_motor_operaciones.js`).
* El `total` se guarda en la moneda de la venta **y** en una segunda clave `totalUSD` normalizada
  (la tasa está dentro del `payload`), porque la tasa cambia y comparar días en VES sin normalizar
  daría cifras que no cuadran. Decisión ya tomada: `totalUSD` es el número que usan los reportes
  comparativos; `total` se conserva para el recibo.

---

## 3. Cola local (búfer) durable

### 3.1 Formato

Archivo **append-only** `cola.jsonl` en OPFS, una línea JSON por operación:

```json
{"clave":"venta/7K3F9QAB_0007","tipo":"venta","payload":{ "...": "..." },"estado":"pendiente","intentos":0,"ts":"2026-02-14T15:04:05.123Z"}
```

| Campo | Significado |
|---|---|
| `clave` | `tipo/deviceId_secuencia` (lo que falta para armar la ruta de la nube) |
| `tipo` | uno de los 6 tipos |
| `payload` | la operación completa (§1.2), incluido `id`, `fechaISO`, `operador`, `version` |
| `estado` | `pendiente` \| `subiendo` \| `subida` \| `fallo` \| `conflicto` |
| `intentos` | número de intentos de subida (para backoff y diagnóstico) |
| `ts` | momento en que se **encoló** (no el de la operación: puede diferir si se recupera de un respaldo) |

### 3.2 Reglas (invariantes duras)

1. **La cola se escribe ANTES de tocar la red.** `encolar()` debe haber hecho `flush` a disco
   (OPFS `write` + `close`) antes de que se dispare cualquier `set()`.
2. **Se marca `subida` SOLO tras la confirmación del servidor** (la promesa de `.set()` resolvió,
   no rechazó, con conexión). Un timeout, un `permission_denied` o un cierre del navegador **no**
   confirman.
3. **Nunca se borra una entrada de la cola sin confirmación.** El único borrado legítimo es el de
   una entrada en estado `subida`, y solo tras el `flush` del archivo recortado (compactación).
4. La cola **no se reordena**: se vacía en orden de `secuencia` (§5). Si la entrada N falla, las
   siguientes esperan (no se salta el orden para no dejar huecos ni alterar el orden causal de las
   operaciones de un mismo equipo).
5. La cola **sobrevive** al cierre del navegador, al `kill` del proceso y al apagón del equipo,
   porque está en disco (OPFS), no en memoria.

### 3.3 Compactación

`cola.jsonl` crece porque es append-only. Cada vez que se confirman entradas y la proporción de
líneas `subida` supera el 50 % (o al arrancar la página, si el archivo tiene más de N líneas), se
**reescribe** el archivo dejando solo las líneas vivas (`pendiente`, `subiendo`, `fallo`,
`conflicto`) y se hace `flush` antes de descartar el original. Es la única operación que reescribe
la cola, y nunca pierde una entrada no confirmada.

---

## 4. Ventana caliente (`caliente/`)

Es el subconjunto de datos que el equipo guarda en disco para poder **operar sin internet**:

| Contenido | Retención | Motivo |
|---|---|---|
| ventas | últimos **30 días** | es lo que se muestra en el POS, el resumen y los cierres recientes |
| compras | últimos **30 días** | alimenta costos y reposición |
| movimientos (inventario) | últimos **30 días** | reconstruye el stock reciente |
| productos | **todos** | sin catálogo no se puede vender |
| clientes | **todos** | son pequeños y se necesitan en el mostrador |
| cuentas | **todas** | ídem |

* Estructura en OPFS: `caliente/ventas.jsonl`, `caliente/compras.jsonl`,
  `caliente/movimientos.jsonl`, `caliente/productos.json`, `caliente/clientes.json`,
  `caliente/cuentas.json`. Los tres primeros son append-only (mismo patrón que la cola); los tres
  últimos son documentos por clave natural/id (se reescriben al fusionar, §7).
* El POS sigue leyendo en memoria una proyección compatible con el formato actual
  (`pos_sales` = arreglo de ventas) para no tocar el render ni el recibo.
* **Liberar de `caliente/` solo se hace si la operación tiene más de 30 días Y está confirmada.**
  Nunca antes (§5, paso 8).

---

## 5. Ciclo de sincronización (máquina de estados)

```
                 ┌──────────────────────────────────────────────────────────┐
                 │                                                          │
  [operación] -> (1) ENCOLAR -> (2) APLICAR LOCAL -> (3) ¿hay red y nube?    │
                     │                  │                     │             │
                     │                  │                     ├─ NO ─> (7) ESPERA
                     │                  │                     │        (la cola crece)
                     │                  │                     └─ SÍ ─> (4) SUBIR EN ORDEN
                     │                  │                                    │
                     │                  │                          ┌─────────┴─────────┐
                     │                  │                     confirmó            falló
                     │                  │                          │                 │
                     │                  │                    (5) MARCAR SUBIDA   (6) MARCAR FALLO
                     │                  │                          │            +intentos/backoff
                     │                  │                          └────> vuelve a (3)
                     │                  │                                    (la entrada sigue en la cola)
                     │                  └──────────► (8) LIBERAR de caliente SOLO si
                     │                                  confirmada Y > 30 días
                     └──────────────────────────────────────────────────────────┘
```

Detalle de cada estado:

| # | Estado | Qué hace | Qué NO hace |
|---|---|---|---|
| 1 | **Encolar** | crea la clave (`deviceId_secuencia`), escribe la línea en `cola.jsonl`, `flush` a disco | no toca la red |
| 2 | **Aplicar local** | mete la operación en memoria + `caliente/` (venta al log, producto al mapa, etc.). La UI ya puede mostrar la venta | no espera a la nube: la venta se cobra aunque no haya internet |
| 3 | **¿Hay red y nube?** | `navigator.onLine !== false` **y** `checkCloudAccess()` verdadero **y** permiso de escritura | — |
| 4 | **Subir en orden** | recorre la cola en orden de `secuencia` y hace `set()` de cada operación pendiente | no salta entradas fallidas |
| 5 | **Marcar subida** | tras la confirmación, marca `subida` y `flush` de la cola | no borra todavía de `caliente` |
| 6 | **Marcar fallo** | `estado='fallo'`, `intentos++`, backoff exponencial (1 s, 2 s, 4 s… tope 5 min). La entrada sigue en la cola | no la descarta, no la marca subida |
| 7 | **Espera** | sin red: nada que hacer. La cola crece y se vacía al reconectar, **en orden** | no se pierde nada, no se bloquea la venta |
| 8 | **Liberar** | quita de `caliente/` lo **confirmado con más de 30 días** | no libera nada sin confirmación ni nada reciente |

Disparadores de "vaciar la cola": evento `online`, evento `visibilitychange` a visible, arranque de
cada página (una vez por sesión), y un temporizador de 60 s heredado del reintento de Fase A
(`sincronizacion.js`, `instalarReintento`).

**Un solo vaciador a la vez** (mutex en memoria + marca en `cola.jsonl`): si dos pestañas están
abiertas, la segunda no reescribe la cola de la primera. Una entrada en estado `subiendo` con más
de 2 minutos de antigüedad se considera huérfana (la pestaña murió) y vuelve a `pendiente` al
arrancar.

---

## 6. Equipo nuevo

1. Arranca **vacío**: sin `caliente/` y con `cola.jsonl` inexistente. **No hereda nada** de otro
   equipo (ni `localStorage` de una instalación anterior).
2. Descarga **productos, clientes y cuentas completos** (son pequeños) + las operaciones de
   **ventas/compras/movimientos de los últimos 30 días**. Eso llena `caliente/` y permite vender de
   inmediato.
3. El **histórico anterior se pide bajo demanda y paginado**: `ops/venta` con
   `orderByChild('fechaISO').endAt(hoy - 30 días).limitToLast(200)`, y se sigue paginando hacia
   atrás con `endAt(fechaISO de la primera operación de la página anterior)`. La UI lo pide al abrir
   un reporte viejo (`mini_market_pos_resumen.html` con rango de fechas, búsqueda de un ticket por
   `id`, cierre de mes).
4. La paginación hacia atrás **no** llena `caliente/`: el histórico leído bajo demanda se muestra
   en pantalla y, como mucho, se guarda en un caché aparte (`consulta/`) que se puede tirar sin
   consecuencia.
5. Al terminar la descarga inicial se sube `ventas/ultimo_numero` local solo si es mayor que el de
   la nube (transacción con `Math.max`, como ya hace `fbSaveNumero`), para que el equipo nuevo tome
   el consecutivo correcto.

---

## 7. Unión (merge)

### 7.1 ventas / compras / movimientos

**Unión por id de operación. No hay conflicto posible.** El estado es el conjunto de operaciones;
"fusionar" es unir conjuntos por clave. Dos equipos pueden vender en el mismo segundo, a la misma
hora, sobre el mismo producto: son dos claves distintas y las dos quedan. No se compara por fecha,
no se compara por total, no se "gana" nada.

Regla de aplicación: orden por `fechaISO` y, a igualdad de fecha, por `deviceId` + `secuencia`
(orden total y determinista, igual en todos los equipos → mismo resultado en todos).

### 7.2 productos

Por `id`, **campo a campo**, gana el valor **más reciente por fecha de modificación** del campo.
Es la generalización de lo que ya hace `mergeInventoryWithLocal` (`mini_market_pos.html`, ~línea
5030): hoy el local gana para `description`, `visible` y `specs`, y la nube para el resto; eso es un
merge por campo con un criterio fijo ("gana local"), que en dos equipos produce que un precio
cambiado en A se pierda si B sube su copia vieja. El motor lo reemplaza por:

```
ganaCampo = (mtime_local > mtime_remoto) ? valor_local : valor_remoto
```

* Cada producto lleva `mtime` (ISO) y un mapa `camposMtime` con la fecha del último cambio **por
  campo** (`precio`, `stock`, `nombre`, `visible`, `description`, `specs`, `images`, …).
* El merge se aplica por campo con el `camposMtime` correspondiente; si un lado no tiene
  `camposMtime` (producto viejo o creado por una página no migrada) se usa su `mtime` global, y si
  tampoco hay `mtime` se conserva el local y se marca `sinFecha` en el diagnóstico (conservador:
  no se pierde lo que el dueño acaba de editar).
* Los campos **aditivos** (`images`, `specs`) no se resuelven por fecha: se **unen** (unión de
  claves / concatenación sin duplicados por URL), porque perder una foto subida en otro equipo es
  exactamente el problema que había.
* `mergeInventoryWithLocal` se convierte en un caso particular de esta función: se conserva como
  envoltorio compatible mientras convivan páginas migradas y no migradas.

### 7.3 clientes / cuentas

Por su **clave natural actual** — documento si existe, si no `nombre + teléfono` — con **última
modificación** (`lastSaleDate`/`mtime`). Es la misma clave que ya usa `fbUpsertClient`
(`mini_market_pos.html`, ~línea 4975): `document` o `name + '_' + phone`, con
`[.#$/\[\]]` reemplazados por `_`. La operación `cliente` no reemplaza el nodo completo: lleva el
`payload` con los campos cambiados y su `mtime`, y el merge es por campo (mismo criterio que
productos). Así, dos cajas que editan teléfono y dirección del mismo cliente no se borran los
cambios.

**Lo que no se puede resolver con claves naturales:** dos equipos crean el mismo cliente por
caminos distintos (uno con documento, otro solo con nombre) y quedan dos registros. El motor no lo
detecta solo; se resuelve con una operación explícita de **fusión de clientes** (`tipo: cliente`,
`payload.fusiona: [claveA, claveB]`), que es lo que ya se hace a mano hoy.

---

## 8. Interruptor por cliente

```
BBDD/<emailPath>/suscripcion/modoSync = 'clasico' | 'operaciones'
```

* `'clasico'` = **comportamiento de hoy** (arreglos completos, Fase A). Es el **valor por defecto**.
* `'operaciones'` = motor nuevo.
* **Si el nodo no existe, si la lectura falla o si el valor es cualquier otra cosa → `'clasico'`.**
  El modo nuevo nunca se activa por accidente ni por un error de red.
* Se lee **una vez por carga de página**, junto a `checkCloudAccess()`
  (`cloud-access.js`), y se cachea en `sessionStorage` con el correo como clave (igual patrón que
  `cloudSync`/`cloudSyncEmail`). Nunca en `localStorage`: un modo pegado en disco sobreviviría a un
  cambio hecho en la consola.
* Si la lectura falla, **no se cachea el fallo**: el siguiente intento vuelve a preguntar (el bug
  C6 de la auditoría, que en `cloud-access.js` ya está resuelto con `pendingCheck`, se respeta).
* Es un interruptor **por negocio**, no por equipo: dos cajas del mismo negocio no pueden estar en
  modos distintos, porque compartirían mal la nube. La página muestra el modo activo en el punto de
  estado del header.
* Pasar de `clasico` a `operaciones` requiere un paso de **siembra**: las ventas que ya están en
  `ventas/historial` se convierten en operaciones (§11.5). Sin ese paso, el motor nuevo vería la
  nube vacía. Volver de `operaciones` a `clasico` es seguro (la nube no se toca), pero las páginas
  clásicas seguirían leyendo `ventas/historial`, que el motor nuevo mantiene actualizado como
  espejo de compatibilidad precisamente para esto.

---

## 9. Límites

| Situación | Límite | Política |
|---|---|---|
| **Plan gratuito** (sin nube) | **1 GB** local (`limiteLocalMB()` de `almacenamiento.js`, por defecto 1024 MB) | la ya probada y auditada: al 80 % aviso; al 100 % exige respaldo la primera vez y después **borra lo más antiguo** en lotes de 100 hasta bajar del 90 % (`aplicarPoliticaAlmacenamiento`) |
| **Plan con nube** (`modoSync='operaciones'` y `cloudSync=true`) | **sin límite práctico** | se **libera tras confirmar** y se conservan los **30 días** de `caliente/`; el histórico vive en la nube y se pide paginado |

Notas:

* En plan gratuito, el borrado de lo más antiguo **nunca toca la nube** (no hay nube) y se apoya en
  el respaldo previo, que es la garantía contra la pérdida. El motor de operaciones no cambia esa
  política: la **hereda**.
* En plan con nube, si `caliente/` se acercara al límite igualmente (por ejemplo, un negocio con
  200 000 ventas en 30 días), se aplica el mismo recorte por antigüedad pero **con la condición
  añadida de que la operación esté confirmada**; y antes de recortar se avisa.
* `limiteLocalMB` sigue siendo configurable desde la consola de Firebase
  (`BBDD/<emailPath>/suscripcion/limiteLocalMB`), sin cambios.

---

## 10. Compatibilidad con lo ya hecho

### 10.1 Marca de pendientes por módulo (`sincronizacion.js`)

* `marcarPendienteSync(modulo)` / `limpiarPendienteSync(modulo)` / `hayPendientesSync()` /
  `puedeSobrescribirLocalSync()` **siguen existiendo con la misma firma**. Las páginas siguen
  cargando `sincronizacion.js` y llamándolas.
* Con `modoSync='clasico'` nada cambia: mismas marcas, mismo comportamiento (regresión garantizada
  por el escenario T7 del simulador).
* Con `modoSync='operaciones'`, las marcas por módulo quedan **subordinadas a la cola**: la fuente
  fina de verdad es `cola.jsonl`. La marca por módulo pasa a ser un **resumen derivado** ("¿queda
  algo pendiente de este módulo?"), que se calcula como `cola.jsonl` tiene entradas de ese tipo sin
  confirmar. Se conserva porque varias páginas y el punto de estado del header la consultan, y
  porque `puedeSobrescribirLocalSync()` es la guardia que impide que una página clásica descargue
  encima: en modo operaciones sigue devolviendo `false` mientras haya cola pendiente.
* `olvidarPendientesSync()` (reinicio de fábrica) pasa a vaciar también `cola.jsonl` y `caliente/`,
  con la advertencia de §11.4 sobre la secuencia.

### 10.2 Id de venta `V-LOCAL-<equipo>-<n>`

* Se **conserva tal cual**. `reserveLocalSaleId()` (`mini_market_pos.html`, ~línea 1998) ya produce
  `V-LOCAL-` + `getPosDeviceId()` + secuencia de 4 dígitos. Ese string pasa a ser el `id` de la
  operación y su `payload.id`.
* No se rompe la numeración fiscal ni los recibos ya impresos: los ids siguen siendo únicos por
  equipo y el `id` no se reutiliza nunca (append-only).
* `pos_last_sale_number` sigue siendo el contador local y ahora también la `secuencia` de la
  operación, así que **no hace falta un contador nuevo**.
* `ventas/ultimo_numero` de la nube se mantiene con `transaction` + `Math.max` (como ya está) para
  que un equipo atrasado no baje el consecutivo.
* Ojo: `peekSaleId()` (el "próximo número" que se muestra antes de cobrar) devuelve `V-0007`, sin
  equipo; el id definitivo se reserva al confirmar la venta (`reserveSaleId()`). El motor **no**
  cambia eso: la operación se crea con el id definitivo, y el número mostrado antes de cobrar puede
  repetirse entre cajas sin consecuencias (nunca se usó para la operación).

### 10.3 Monitor de conexión

* `setupConnectionMonitor(db)` (9 páginas) y el `online`/60 s de `sincronizacion.js` se
  **reutilizan como disparadores** del vaciado de cola (§5). No se duplica el monitor.
* En modo operaciones, el punto de estado del header pasa a reflejar la cola: verde = cola vacía,
  ámbar = hay pendientes (con el número), rojo = hay fallos o conflictos. Es información que hoy no
  existe y es la que permite al dueño saber si puede apagar el equipo.

### 10.4 Almacén local grande (`almacenamiento.js` / IndexedDB → OPFS)

* `almacenamiento.js` expone una API de almacén (`abrirHistorial`, `guardarEnHistorial`,
  `leerHistorial`, `borrarDelHistorial`, `tamanoHistorial`, `historialDisponible`,
  `contarHistorial`) sobre IndexedDB. El motor **no la rompe**.
* Camino de migración: se implementa el mismo conjunto de funciones sobre OPFS
  (`navigator.storage.getDirectory()`) y se mantiene la firma. `almacenamiento.js` decide la
  implementación con una comprobación de capacidad y **un solo punto de cambio**; las páginas no se
  enteran.
* Durante la convivencia, `archivarVentasAntiguas()` (IndexedDB) sigue funcionando para el modo
  clásico. En modo operaciones el archivado deja de ser necesario para ventas (van a la nube y a
  `caliente/` con 30 días), pero **se sigue llamando**: es idempotente y evita dejar dos políticas
  de espacio a la vez.
* El motor de operaciones **no** escribe en `localStorage` más que las claves de siempre
  (`pos_device_id`, `pos_last_sale_number`, ajustes). La cola y la ventana caliente van a OPFS, que
  es lo que resuelve el problema de los 5 MB.

---

## 11. Riesgos y decisiones abiertas

### 11.1 Pérdida de datos si se libera sin confirmación

**Riesgo.** Es el riesgo central del diseño. Si el motor quita de `caliente/` una operación que no
está confirmada en la nube (bug, timeout mal interpretado, `set()` que "parece" resuelto tras una
reconexión), esa operación existe **solo** en ese equipo y en su cola. Si el equipo se pierde, se
pierde la venta.

**Mitigaciones ya en el diseño.** (a) la cola se escribe antes de la red; (b) la liberación exige
`>30 días` **y** confirmación, en ese orden de comprobaciones; (c) el índice `ventas_idx` no se usa
como fuente de verdad; (d) la máquina de estados no tiene ninguna transición que borre una entrada
no confirmada.

**Lo que queda abierto.** No existe todavía una **verificación de confirmación independiente**: si
Firebase resuelve la promesa y el dato no llegó a disco en el servidor (caso raro pero real en
móviles), el equipo cree que subió. Se propone una **doble comprobación diferida**: para las
operaciones liberadas hace menos de 48 h, releer su clave en la nube antes del recorte. Coste: una
lectura por operación recortada. Está **sin decidir** por el coste en planes gratuitos de Firebase.

### 11.2 Comportamiento en Safari / iOS (purga de almacenamiento)

**Riesgo.** iOS/Safari purga el almacenamiento del origen (incluido OPFS/IndexedDB) tras **7 días
sin uso** para sitios sin persistencia concedida. Un minimarket que cierra una semana puede
encontrar el equipo sin cola y sin `caliente/`. Además, en iOS la cuota de OPFS ha sido
históricamente menor que en escritorio.

**Mitigaciones.** (a) llamar a `navigator.storage.persist()` (ya existe
`pedirPersistencia()` en `almacenamiento.js`) en el primer arranque y comprobar
`navigator.storage.persisted()`; (b) ventana caliente de solo 30 días (menos bytes que hoy); (c)
avisar en pantalla si `persisted()===false`; (d) en modo operaciones la nube es la copia de
seguridad, así que perder el disco local **no borra el histórico**: solo obliga a redescargar.

**Abierto.** No hay forma de garantizar persistencia en iOS sin que el usuario instale la PWA en la
pantalla de inicio y la use periódicamente. **Decisión pendiente:** si un equipo con
`persisted()===false` debe tener prohibido operar sin conexión (mostrar aviso "vende con internet"),
o si se acepta el riesgo con aviso. Yo recomiendo aceptarlo con aviso y recordatorio semanal.

### 11.3 El cliente supera 1 GB sin nube

**Riesgo.** Sin nube, el histórico solo existe en ese equipo. Al llegar al 100 % del límite, la
política probada **borra lo más antiguo** (tras exigir un respaldo la primera vez). Un respaldo
`.json` descargado al escritorio es la única copia: si el usuario no lo guarda, al recortar se
pierden ventas para siempre.

**Lo que el diseño hace.** No empeora nada respecto a hoy: el motor en modo gratuito puede incluso
**no usarse** (`modoSync` por defecto es `clasico`). Si un negocio gratuito activa operaciones, la
cola y `caliente/` son más pequeñas que el `pos_sales` actual, así que el límite se alcanza más
tarde.

**Abierto.** (a) ¿Cuántas ventas caben en 1 GB? Una venta ronda 1–3 KB con los `items` completos;
1 GB ≈ 300 000–1 000 000 de ventas, es decir, años para un minimarket. La estimación **no está
medida todavía** con datos reales y debería medirse antes de decidir si el plan gratuito necesita
siquiera una política de recorte agresiva. (b) ¿Se puede comprimir `caliente/` (una venta por
línea, sin repetir el objeto `product` completo en cada `item`)? Sería un ahorro grande y **rompe el
formato actual** del recibo, así que queda fuera de esta fase.

### 11.4 Reinicio de fábrica y `deviceId`

**Riesgo.** `config.html` borra `pos_last_sale_number` y `_pendingFirebaseChanges`. Si además se
regenera `pos_device_id` (o el usuario reinstala la PWA y `crypto.randomUUID()` da otro id), el
equipo **empieza de cero** y puede reutilizar claves de operación que ya existen en la nube
(`<mismo deviceId>_<misma secuencia>`). Con idempotencia por clave, eso no duplica: **ignora la
operación nueva**, que es peor (una venta "desaparece" silenciosamente).

**Mitigación.** Al arrancar, el equipo comprueba si existe `ops/<tipo>/<deviceId>_*` con su
`deviceId`; si existe, **recupera la secuencia** desde la nube (`limitToLast(1)`) y continúa. Y
`deviceId` **nunca se regenera** si ya hay un `deviceId` guardado. El reinicio de fábrica debe
borrar el `deviceId` (equipo "nuevo") o conservarlo (mismo equipo): **decisión pendiente** de
producto; recomiendo conservarlo y borrar solo el contador, recalculándolo desde la nube.

### 11.5 Siembra del histórico existente (clásico → operaciones)

**Riesgo.** Al activar `operaciones` en un negocio que ya tiene años en `ventas/historial`, la nube
no tiene operaciones. Un equipo nuevo no vería el histórico.

**Abierto.** El plan de siembra (leer `ventas/historial` y convertirlo en operaciones
`V-SEED-<deviceId>_<n>`) **no está detallado**: falta decidir si se hace en el primer arranque de
la página (bloquea al usuario unos minutos), si se hace desde la consola, o si simplemente se deja
`ventas/historial` como espejo para las consultas viejas y el motor empieza a contar desde la fecha
de activación. **Esta es, a mi juicio, la decisión abierta más importante del proyecto**, porque
determina si el histórico antiguo se puede consultar paginado o queda en un formato distinto al
nuevo.

### 11.6 Conflicto de edición simultánea de un producto en dos equipos

**Escenario.** Equipo A cambia el precio de "Harina PAN" a las 10:00:05; equipo B cambia el stock
del mismo producto a las 10:00:06, ambos sin conexión.

**Resolución del diseño (§7.2).** Merge **por campo** con `camposMtime`: `precio` viene de A y
`stock` de B. Los dos cambios sobreviven. Si los dos tocan **el mismo campo**, gana el `mtime` más
reciente (B), y el valor perdedor **no se pierde del todo**: queda en el log de operaciones
`ops/producto/*` y se puede auditar/recuperar. Para que esto funcione, cada página que edite
productos debe (a) escribir `camposMtime[campo]` al cambiar y (b) **no** escribir el producto
completo sin camposMtime. Eso obliga a tocar `inventario.html` y `catalogo.html` en la fase de
implementación.

**Abierto.** (a) Los relojes de dos equipos pueden estar desfasados; si el reloj de A va 5 minutos
adelantado, A gana siempre. Mitigación propuesta: guardar también el `serverTimestamp` de Firebase
(`.sv: 'timestamp'`) y usar la diferencia medida para corregir el `mtime` local (offset estimado en
el *handshake* de sincronización). **Sin implementar y sin validar.** (b) Conflictos de **borrado**:
una operación `producto` con `payload.eliminado: true` gana sobre cualquier alta si su `mtime` es
mayor; si un equipo sigue vendiendo un producto borrado en otro, se registra la venta y se marca el
producto como "borrado con ventas posteriores" en el diagnóstico. **Decisión pendiente** de si eso
debe bloquear la venta (recomiendo que no: nunca bloquear una venta).

### 11.7 Otros riesgos menores

* **Crecimiento de `ops/` en la nube.** Nunca se borra (append-only). En plan de pago es
  aceptable, pero conviene un proceso de exportación/archivado por año hacia Storage. **Sin
  diseñar.**
* **Reglas de Firebase.** El diseño agrega los nodos `ops/*`, `ventas_idx/*` y `suscripcion/modoSync`
  dentro de `BBDD/$owner`, que ya tiene `.read`/`.write` por dueño (`reglas-firebase.json`, líneas
  48–53). **No hace falta cambiar reglas**, pero sí conviene añadir validación de forma
  (`.validate` de `tipo`, `version`, `deviceId`) para que un cliente con un bug no escriba basura
  en el log. **Sin implementar** (el enunciado prohíbe tocar reglas en esta fase).
* **Doble pestaña.** Dos pestañas del mismo origen comparten OPFS. El mutex de §5 lo cubre, pero un
  `cola.jsonl` a medio compactar por una pestaña mientras otra hace `append` es un caso a probar
  con un test de integración real (no está en el simulador, que es monohilo).
* **`flush` real en OPFS.** El diseño depende de que la línea de la cola esté **en disco** antes de
  intentar la red. `FileSystemWritableFileStream.write()` + `close()` cumplen, pero un `flush` a
  disco físico no está garantizado por el navegador. El simulador da el `flush` por hecho: es la
  suposición más fuerte de todo el modelo y no se puede validar con un test de Node (necesita un
  navegador real y un corte de energía).
* **Coste de vaciar una cola larga.** Cada operación es un `set()` independiente: una cola de 500
  operaciones son 500 escrituras. Sin agrupar (`update()` con varias rutas) el coste en una
  reconexión larga puede ser notable. Agrupar en lotes de N operaciones de **tipos distintos** es
  compatible con append-only, pero **no está diseñado**.
* **Ventas con el mismo `deviceId` en dos equipos.** Si alguien copia `localStorage` de un equipo a
  otro (respaldo restaurado), hay dos equipos con el mismo `deviceId` y las secuencias chocan:
  idempotencia por clave → una de las dos ventas **se ignora**. Mitigación ya prevista: recuperar la
  secuencia de la nube al arrancar reduce la ventana, pero no la cierra (los dos podrían reservar la
  misma secuencia antes de subir). **Decisión pendiente:** incluir en la clave un componente
  aleatorio por instalación (`installId`, 4 caracteres más) manteniendo `deviceId` para la lectura
  humana. Rompe la clave "bonita" pero elimina la clase de bug.

---

## 12. Qué NO cambia en esta fase

* Ningún archivo de la aplicación se modifica.
* `modoSync` **no se crea** en la nube: al no existir, todos los negocios siguen en `'clasico'`, que
  es exactamente el comportamiento de hoy.
* Las reglas de Firebase no se tocan.

## 13. Cómo se validó este diseño

`pruebas_motor_operaciones.js` (Node, sin dependencias, no toca archivos de la app) modela los dos
motores sobre el mismo mock del SDK v8 y ejecuta 10 escenarios (49 comprobaciones `OK`/`FALLA`):

| Escenario | Qué demuestra |
|---|---|
| T1 | en `clasico` la venta sin conexión se pierde al cerrar la pestaña; en `operaciones` ya está en disco |
| T2 | en `clasico` un equipo pisa al otro; en `operaciones` la nube conserva las tres ventas y los dos equipos convergen |
| T3 | reintentar la misma clave no duplica; el mismo contenido no reescribe; contenido distinto no pisa |
| T4 | si la subida falla, la operación no se marca subida, no se libera y la cola no se salta el orden |
| T5 / T5b | se libera solo lo confirmado y con más de 30 días; sin confirmación no se libera nunca |
| T6 | equipo nuevo: arranca vacío, baja productos + 30 días, vende, y el histórico se pide paginado |
| T7 | sin `modoSync` (o con un valor inválido) todo se comporta como hoy; el reinicio de fábrica no sube nada |
| T8 | al 1 GB se borra lo más antiguo sin tocar la nube; con nube se libera tras confirmar |
| T9 | dos equipos editando el mismo producto: el merge por campo conserva los dos cambios |
| T10 | forma de la ruta y del valor, índice reconstruible desde las operaciones |

Limitación importante: el simulador es **monohilo y en memoria**. No prueba OPFS real, ni dos
pestañas a la vez, ni la semántica de reconexión de Firebase (solo la reproduce), ni cortes de
energía. Es un simulador del **diseño**, no del motor.
