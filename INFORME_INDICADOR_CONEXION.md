# Informe · Indicador de conexión único, catálogo con fusión y dos fallos de producción

Fecha: 21/09/2026 · Repositorio: `Mini-Market-GH` · Producción: `ciervoadministrativo.shop` (GitHub Pages, rama `main`)

Este documento describe **tres trabajos** hechos en la misma sesión, con la evidencia
recogida en cada caso. Está escrito para que lo revise una IA experta (o una persona)
sin necesidad de reconstruir el razonamiento: incluye el método de medición, lo que
**no** se pudo verificar y las decisiones que quedan abiertas.

---

## 0. Resumen ejecutivo

| # | Trabajo | Estado | Cómo se probó |
|---|---|---|---|
| 1 | Guardián de cuota en las 3 páginas que faltaban | **desplegado** | 148 comprobaciones + mutación |
| 2 | Catálogo: descarga + fusión por id + escritura quirúrgica | **desplegado** | 43 comprobaciones + mutación + navegador real |
| 3 | `gestion_usuario.html`: sesión de Firebase perdida | **arreglado, sin desplegar** | reproducido antes/después en navegador real |
| 4 | Indicador de conexión: 4 colores a la vez para el mismo estado | **arreglado, sin desplegar** | medido en 11 páginas + suite nueva de 44 |

Verificación acumulada al cerrar este informe:

- **16 suites de Node · 1.429 comprobaciones · 0 fallos.**
- **Suite de navegador real (Playwright): 73 OK · 0 FALLA · 1 saltada** (F.11 es opt-in
  porque escribe en la nube de la cuenta de prueba).
- Preflight: **10 OK · 0 FALLAS**.

---

## 1. Indicador de conexión: el síntoma

Reportado por el usuario: *"el indicador de conexión aparece diferente en distintas
partes del sitio; creo que el que tiene la verdad es el del POS"*.

### 1.1 Cómo se midió (no se supuso)

Script de diagnóstico con Playwright: se inicia sesión **una vez** con la cuenta de
prueba y se abre cada página, esperando 10 s, leyendo
`getComputedStyle(el).backgroundColor` y `el.title` del elemento `#firebaseDot`.

Condiciones del entorno en la medición: `suscripcion/cloudSync = false`,
`suscripcion/modoSync = "operaciones"` (la cuenta de prueba tiene el motor encendido;
los clientes reales lo tienen apagado).

### 1.2 Resultado (ANTES) — mismo instante, misma cuenta

| Página | Color | Título | Qué medía en realidad |
|---|---|---|---|
| `compras.html` | **VERDE** | "Firebase conectado" | el socket (`.info/connected`) |
| `gestion_usuario.html` | **VERDE** | "Firebase conectado" | el socket |
| `inventario.html` | **ÁMBAR** | "Sin conexión con la nube: cambios guardados aquí" | el permiso de nube |
| `mini_market_pos.html` | GRIS | "Modo operaciones · solo en este equipo (sin nube)" | el motor |
| `listado_clientes.html` | GRIS | **"Estado de conexión"** | **nada: texto del HTML** |
| `cuentas.html` | GRIS | **"Estado de conexión"** | **nada: texto del HTML** |
| `gestion_proveedores.html` | GRIS | **"Estado de conexión"** | **nada: texto del HTML** |
| `mini_market_pos_resumen.html` | GRIS | **"Firebase"** | **nada: texto del HTML** |
| `gestion_empresa.html` | GRIS | **"Conectando..."** | **nada: texto del HTML** |
| `catalogo.html` | — | — | no existía el indicador |
| `config_recibo.html` | — | — | no existía el indicador |
| `menu.html` | — | — | no existía el indicador |

**Cuatro colores distintos a la vez**, cinco páginas congeladas en el texto del HTML y
tres sin indicador. El resumen por color: ÁMBAR 1 · GRIS-A 4 · GRIS-B 2 · VERDE 2 · sin
indicador 3.

### 1.3 Las cuatro causas

1. **Tres significados para el mismo semáforo.** Unas páginas miraban
   `.info/connected` (¿hay socket abierto?), otras `checkCloudAccess()` (¿tiene plan de
   nube la cuenta?) y el POS miraba el estado del motor. Son tres preguntas distintas.
2. **El verde mentía.** `.info/connected` es `true` siempre que haya internet, **aunque
   la cuenta no tenga nube**. Con `cloudSync=false` no se sube nada y aun así dos
   páginas decían "Firebase conectado".
3. **Cinco páginas nunca pintaban.** En clientes, cuentas, proveedores, empresa y
   resumen, `setupConnectionMonitor` no llega a ejecutarse al cargar porque su
   `initFirebase()` solo se invoca desde manejadores (líneas 1127/1259, 1476/1494/1519,
   1599-1717 según la página). El punto conserva el texto del HTML para siempre.
4. **`gestion_usuario.html` era la única sin `checkCloudAccess`**: no podía distinguir
   "cliente sin nube" de "hay nube".

### 1.4 Matiz importante sobre el POS

El usuario tiene razón en que el POS era el más veraz, **pero su verdad dependía del
motor**: `actualizarPuntoEstadoOps()` sale en la primera línea si el motor no está
activo (`mini_market_pos.html:5455`). Con el motor apagado —el caso de los 4 clientes
reales— esa función no pinta nada y el POS cae a su listener `.info/connected`, es
decir, al mismo verde engañoso que compras.

---

## 2. El arreglo: una sola autoridad (`conexion.js`)

Módulo nuevo que sustituye a los nueve pintores divergentes. Se apoya en la misma idea
que `tema.js` (un módulo compartido en vez de la misma lógica copiada en cada página).

### 2.1 Los cinco estados

| Estado | Color | Cuándo | Título |
|---|---|---|---|
| `sin-red` | 🔴 `#ef4444` | `navigator.onLine === false` | "Sin internet: los cambios se guardan en este equipo" |
| `sin-nube` | ⚪ `#94a3b8` | la cuenta no tiene nube | "Solo en este equipo (sin nube): los datos se guardan aquí" |
| `pendientes` | 🟡 `#f59e0b` | hay nube y N módulos con cambios sin confirmar | "N cambios sin subir a la nube" |
| `al-dia` | 🟢 `#22c55e` | hay nube y nada pendiente | "Todo subido a la nube" |
| `sin-comprobar` | ⚪ `#6b7280` | todavía no se puede saber | "Estado de la nube: sin comprobar" |

Responde a **una** pregunta, la que le importa al negocio: *"¿están mis datos a
salvo?"*, en lugar de *"¿hay un socket abierto?"*.

### 2.2 Orden de las preguntas (decisión razonada)

1. **¿Hay red?** Es un hecho local y comprobable. Va primero a propósito: evita
   confundir *"no pude leer la nube"* con *"este cliente no tiene nube"*, que asustaría
   a un cliente que **sí** paga la nube.
2. **¿Tiene nube la cuenta?** Si no, manda eso: "sin nube" es una propiedad de la
   CUENTA, no de la red, y a un cliente sin nube no le sirve que se le hable de nube.
3. Con nube: **¿cuántos módulos tienen cambios sin confirmar?** (`pendientesSync()` de
   `sincronizacion.js`).

### 2.3 De dónde saca cada dato

- **Nube:** usa `checkCloudAccess()` de la propia página si existe (cada página ya la
  tiene y ya la cachea). Si no, lee `suscripcion/cloudSync` del RTDB **solo si la app de
  Firebase ya está inicializada**.
- **Red:** `navigator.onLine` + eventos `online`/`offline`.
- **Pendientes:** `pendientesSync()`.
- **El módulo NUNCA inicializa Firebase.** Decisión deliberada: no queremos que una
  página que hoy no toca la nube empiece a conectarse solo por pintar un punto. Hay una
  comprobación que lo fija (T18/T24).

### 2.4 Cómo se instala (una sola autoridad de verdad)

Al cargarse, el módulo hace `window.setFirebaseDot = function () { actualizar(); }`.
Todas las llamadas que las páginas ya hacían a su `setFirebaseDot(color, titulo)`
pasan a significar **"recalcula y pinta"**, y el color/título que pretenda la página se
**ignora**. No hubo que tocar ni una llamada de las páginas, y ninguna puede volver a
divergir. Hay una prueba que lo fija inyectando un color falso desde la página (T15/T16).

### 2.5 Contexto extra: el POS no pierde el error del motor

El POS tenía información propia valiosa (error del motor, cola). Se conserva con un
gancho: el módulo lee `window.conexionDetalle` en cada pintado y **añade** ese texto al
título canónico, nunca lo sustituye.

Verificado de extremo a extremo en el navegador real, simulando un fallo del motor:

```
sin error -> "Solo en este equipo (sin nube): los datos se guardan aquí"
con error -> "Solo en este equipo (sin nube): los datos se guardan aquí · motor: error (fallo simulado)"
color     -> rgb(148,163,184)  (el canónico: el detalle NO cambia el color)
```

Solo se aporta lo que el mensaje canónico no dice ya (el error y la cola). "Sin nube" o
"todo subido" no se repiten.

---

## 3. Trampas encontradas (lo más importante del informe)

### 3.1 El "false" pegajoso de `checkCloudAccess` — riesgo de romper las subidas

**Hallazgo:** varias páginas tienen `getCurrentUserEmail()` leyendo **solo
`sessionStorage`**:

- `cuentas.html`, `listado_clientes.html`, `compras.html`, `mini_market_pos_resumen.html`,
  `gestion_empresa.html`: `sessionStorage.propietarioActual` → `currentOwner` → `null`.

Y quien escribe `sessionStorage.propietarioActual` es **`sesion.js`, que se carga DESPUÉS**
que `conexion.js`. Si el módulo preguntaba la nube antes de eso, esas páginas entraban en

```js
if (!email) { _cloudAccessChecked = true; _cloudAccess = false; return false; }
```

y se quedaban con un **`false` pegajoso que les impedía subir durante toda la sesión**.
Es decir: el arreglo del indicador habría roto la sincronización de cinco páginas.

**Mitigación implementada:** el módulo espera a `window.sesionLista` (lo expone
`sesion.js`) antes de preguntar; si todavía no existe, **no pregunta nada** y reintenta.
Comprobado con pruebas dedicadas (T38-T41) y con un contador de llamadas reales a
`checkCloudAccess`.

*Nota:* el resto del caché **no** es pegajoso ante fallos de red (las páginas hacen
`if (valor === null) return false;` sin marcar `_cloudAccessChecked`), así que la única
vía peligrosa era el "sin email".

### 3.2 El orden de carga en el POS

El primer intento de registrar el detalle del motor se puso **dentro del `<script>` de la
página**, que corre **antes** de `conexion.js` (cargado al final del body). Resultado
medido en el navegador: `detalle registrado: false` — **nunca se registraba**.

**Corregido** con una asignación directa de `window.conexionDetalle` (independiente del
orden de carga). Verificado después: `detalle registrado: true`.

### 3.3 Dos guardias de prueba vacuas (el mismo error, dos veces)

Al comprobar "ninguna página inyecta `firebase-app.js` sin `firebase-auth.js`" y "el POS
no llama a `conexion.detalle()`", las **dos** guardias pasaban en falso porque buscaban
el texto en **comentarios** del propio código:

1. La primera mencionaba `firebase-auth.js` en un comentario → la guardia habría pasado
   con el fallo reintroducido.
2. La segunda mencionaba `window.conexion.detalle()` en un comentario **de bloque**, y
   la limpieza solo quitaba comentarios de línea.

**Lección aplicada:** las comprobaciones que buscan código deben ignorar los comentarios,
y hay que **verificarlas con mutaciones** (quitar el código y comprobar que la guardia
se pone roja). Ambas quedaron verificadas así.

### 3.4 Consultas duplicadas en el arranque

`actualizar()` se llama varias veces seguidas (al cargar, en `DOMContentLoaded` y desde
la primera llamada heredada a `setFirebaseDot`). Sin serializar, la pregunta a la nube se
hacía 2-3 veces. Se añadió `_preguntandoNube` (promesa en vuelo compartida). Lo detectó
la prueba T41.

### 3.5 `menu.html` no puede saberlo

`menu.html` **no carga el SDK de Firebase** ni tiene `checkCloudAccess`. La única salida
honesta sería "sin comprobar", que es exactamente la inconsistencia que se está
arreglando. Se comprobó que **no existe ningún espejo local** del permiso (el caché
`sessionStorage['cloudSync']` de `cloud-access.js` es **código muerto**: ninguna página
lo lee). Por eso **se le quita el punto a `menu.html`**, en lugar de inventarle un color
distinto. Queda fijado en las pruebas T30b/T30c.

---

## 4. Archivos

### 4.1 Nuevos

| Archivo | Qué es |
|---|---|
| `conexion.js` | El módulo (una sola autoridad del indicador). |
| `pruebas_indicador_conexion.js` | 44 comprobaciones: estados, orden, autoridad, "no inicializa Firebase", espera a la sesión, detalle, invariantes de archivo. |
| `INFORME_INDICADOR_CONEXION.md` | Este documento. |

### 4.2 Modificados

| Archivo | Cambio |
|---|---|
| `compras, cuentas, gestion_empresa, gestion_proveedores, listado_clientes, mini_market_pos_resumen, inventario, mini_market_pos, gestion_usuario` `.html` | Añaden `<script src="conexion.js">` **antes** de `sesion.js`. |
| `catalogo.html`, `config_recibo.html` | Además, se les **añade** el punto `#firebaseDot` (no lo tenían). |
| `menu.html` | Solo se le añade el módulo (no tiene punto, ver §3.5). |
| `mini_market_pos.html` | Además, registra `window.conexionDetalle` con el estado del motor. |
| `pruebas_navegador.js` | Escenario **G.16** (cubre `gestion_usuario.html`, que no abría ninguna prueba) y **G.17** (las 11 páginas dicen lo mismo). |
| `gestion_usuario.html` | **Además**, el arreglo del §5 (firebase-auth). |

---

## 5. Los otros dos fallos de la misma sesión

### 5.1 `gestion_usuario.html`: "permission_denied at /operadores"

Reportado por el usuario como error de consola. Diagnóstico:

- **Reproducido** en local: `auth.currentUser = null` con la app inicializada
  (`apps = 1`), consulta a `/operadores` **DENEGADA**, `alert("Error al cargar los
  usuarios.")` y lista vacía.
- **Causa raíz:** era **la única de las 10 páginas con `loadFirebaseSDK` que inyectaba
  `firebase-app.js` + `firebase-database.js` SIN `firebase-auth.js`**. La segunda carga
  del SDK rehace el espacio de nombres `firebase` sin el componente de autenticación;
  `sesion.js` no puede comprobar la sesión (`sin-comprobacion`), el envoltorio de
  `initFirebase` entrega la base sin sesión, y la consulta sale **sin token**. La regla
  exige `auth != null`, de ahí el `permission_denied`.
- **Arreglo:** una línea (añadir la URL que faltaba), igual que en las otras 9 páginas.
- **¿Lo causó el despliegue?** **No.** Se creó un *git worktree* de la versión anterior
  (`ab374e8`), se sirvió en otro puerto y se corrió el mismo diagnóstico: resultado
  **idéntico línea por línea**. Era preexistente.
- **Verificado después:** sesión restaurada, `usuarios/<uid>` legible, consulta OK
  (1 operador), sin alerta y sin error.

### 5.2 Los otros dos mensajes de consola eran ruido

- `sesion.js:72 [sesion] No se pudo comprobar la sesión de Firebase: ... app/no-app` →
  es un `console.warn` **capturado a propósito** (el script corre antes de que exista la
  app) y el envoltorio reintenta después. No rompe nada.
- `Firebase is already defined in the global scope` → el `<head>` carga el SDK y
  `loadFirebaseSDK` lo vuelve a inyectar. Cosmético (una descarga de más). **No se ha
  tocado**: cambiarlo es un cambio de comportamiento mayor y el arreglo de una línea ya
  restaura la corrección.

---

## 6. Verificación

### 6.1 Suites de Node — 16 suites, 1.429 comprobaciones, 0 fallos

| Suite | Comprobaciones |
|---|---|
| `pruebas_datos_cuenta.js` | 202 |
| `_pruebas_historial_almacenamiento.js` | 161 |
| `pruebas_guardian_cuota_paginas.js` | 148 |
| `pruebas_motor_real.js` | 127 |
| `pruebas_reservas_carrito.js` | 114 |
| `pruebas_cuenta_local.js` | 93 |
| `pruebas_sincronizacion.js` | 84 |
| `pruebas_sin_datos_muestra.js` | 82 |
| `pruebas_acceso.js` | 65 |
| `pruebas_lector_ventas.js` | 64 |
| `pruebas_stock_movimientos.js` | 56 |
| `pruebas_restaurar_respaldo.js` | 55 |
| `pruebas_motor_operaciones.js` | 49 |
| `pruebas_indicador_conexion.js` | 44 |
| `pruebas_catalogo_fusion.js` | 43 |
| `pruebas_sesion.js` | 42 |

### 6.2 Navegador real (Playwright, servidor local) — 73 OK · 0 FALLA · 1 saltada

Resultado de **G.17** (la comprobación que pedía el reporte del usuario):

```
OK  G.17a Las 11 páginas tienen el indicador de conexión
OK  G.17b El color es EL MISMO en las 11 (antes había 4 colores a la vez)
OK  G.17c El mensaje de fondo es el mismo en las 11
INFO     las 11 dicen: "Solo en este equipo (sin nube): los datos se guardan aquí"
```

Que es la **verdad** para esa cuenta (`cloudSync = false`).

### 6.3 Pruebas de mutación (para que las suites no sean vacuas)

| Mutación | Resultado |
|---|---|
| Reintroducir el `.set()` del nodo entero en el catálogo | 5 FALLOS en 3 capas |
| Quitar `firebase-auth.js` del cargador de `gestion_usuario.html` | la guardia lo marca |
| Mencionar el script en un **comentario** en vez de inyectarlo | la guardia lo marca |
| Volver a llamar a `conexion.detalle()` en el POS | la guardia lo marca |
| Romper el guardián de cuota de `config_recibo.html` | 5 FALLOS en 3 capas |

### 6.4 Otras comprobaciones

- **CRLF:** 0 LF sueltos en los 15 archivos tocados.
- **Sintaxis:** los 29 `.js` versionados pasan `node --check`.
- **Seguridad de publicación:** ni un correo personal ni un uid real en el diff; la
  clave de la cuenta de prueba no aparece en ningún archivo del repositorio.
- **Alcance:** 13 archivos modificados + 2 nuevos. `landing.html` y los dos artefactos de
  desarrollo de otra sesión quedan **sin versionar** a propósito.

---

## 7. Límites conocidos y lo que NO se ha verificado

1. **El camino de escritura del catálogo contra Firebase real no se ha ejecutado nunca.**
   La cuenta de prueba tiene `cloudSync = false`, así que `suscripcionCatalogoConNube()`
   no llega a la nube. El `.update()` está probado contra un RTDB **simulado**: sé que el
   *payload* es correcto, **no** que el servidor lo acepte. Probarlo de verdad exige
   encender `cloudSync` en esa cuenta (una escritura deliberada en su nube).
2. **El empate de imágenes entre dos equipos no está resuelto.** Si el equipo A edita las
   imágenes y el equipo B guarda después sin haber descargado, B pisa las de A. Necesita
   fusión por campo con marca de tiempo (otra fase). Documentado en el código y fijado en
   una prueba.
3. **`sin-comprobar` no distingue "no hay nube" de "aún no lo sé" por color**: ambos son
   grises distintos a propósito (`#94a3b8` vs `#6b7280`). Con la espera a `sesionLista`
   (T38-T41), en la práctica se resuelve en segundos; pero en una página que no pueda
   saberlo nunca, ese estado sería permanente.
4. **El indicador no mide OPFS/IndexedDB.** Si algún día se enciende el motor de
   operaciones con almacenamiento propio, "todo subido" no diría nada del almacén
   caliente del motor.
5. **No se ha mirado el indicador con un cliente CON nube.** La cuenta de prueba no tiene
   nube. Los estados `pendientes` y `al-dia` están probados en el sandbox (T5-T9) y en la
   suite de Node, **no** en un navegador contra un cliente real de pago.
6. **No se ha verificado visualmente el aspecto del punto nuevo** en `catalogo.html` y
   `config_recibo.html` (se añadió el `<span>`): las capturas de la suite existen
   (`capturas_navegador/13_G_*.png`) pero **no las he inspeccionado como imagen**.

---

## 8. Preguntas abiertas para quien revise

1. **¿Es correcto el orden "red antes que nube"?** Elegí que un cliente sin nube y sin
   internet vea "Sin internet" en vez de "Solo en este equipo (sin nube)". El argumento
   es que el segundo es una propiedad de la cuenta y el primero un hecho más urgente;
   pero para un cliente local, "sin nube" sería más informativo. Alternativa: invertir el
   orden y que "sin nube" mande siempre.
2. **¿Dos grises distintos (`sin-nube` vs `sin-comprobar`) o uno solo?** Hoy son
   distintos para que "no lo sé" no se confunda con "no hay nube". Un revisor podría
   preferir uno solo con el matiz únicamente en el texto.
3. **¿Debería `menu.html` tener indicador?** Se le quitó porque no puede saberlo. La
   alternativa sería que `menu.html` cargara el SDK (más peso en el hub) o introducir un
   espejo local del permiso (con riesgo de quedarse obsoleto).
4. **¿Conviene eliminar los `setFirebaseDot` locales de las páginas?** Hoy quedan como
   código inerte (el módulo los sustituye). Se dejaron a propósito: si `conexion.js` no
   cargara, la página pintaría a su manera antigua en vez de quedarse sin punto. Un
   revisor podría preferir borrarlos para que no haya dos rutas.
5. **¿El módulo debería estar en el `<head>` en vez de antes de `sesion.js`?** Se puso
   antes de `sesion.js` para que sustituya a `setFirebaseDot` después de que la página lo
   defina. En el `<head>` el override lo pisaría la declaración de la página.
