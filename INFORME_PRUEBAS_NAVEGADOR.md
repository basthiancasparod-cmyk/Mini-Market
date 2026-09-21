# Informe · Pruebas en navegador real (Playwright)

**Fecha:** 2026-09-21
**Ámbito:** validación en navegador de los cambios de hoy (migración por cuenta, datos de muestra, aislamiento, guardián de cuota, respaldo/contador).
**Origen usado:** `http://127.0.0.1:5500` (servidor local `_servidor_pruebas.js`). **Nunca** se tocó `ciervoadministrativo.shop` ni datos de clientes reales.
**Commits/push:** ninguno. No se modificó ningún archivo de la aplicación.

---

## 1. Resumen ejecutivo

| Punto | Resultado |
|---|---|
| ¿Playwright está en el PC? | **Sí**, versión 1.60.0, en `C:\Users\FOLGORESB\Desktop\TEA\ruta-tea\node_modules\playwright` (instalación previa). Los navegadores están en `%LOCALAPPDATA%\ms-playwright` (chromium-1223, etc.). |
| ¿Se pudo lanzar un navegador? | **No.** El entorno de ejecución de esta sesión (sandbox) **impide crear/conectar *named pipes***, que es el mecanismo de IPC interno de Chromium (Mojo). Evidencia dura más abajo. |
| ¿Se ejecutaron los escenarios A–F en navegador? | **No, ninguno.** No se generaron capturas (`capturas_navegador/` queda creada y vacía a propósito). |
| ¿Se entregó igualmente la suite? | **Sí:** `pruebas_navegador.js` (1349 líneas, CRLF, comentada en español), lista para ejecutar en una consola normal del equipo. |
| ¿Se pudo validar algo de verdad? | **Sí, el preflight completo**: servidor local, las 15 páginas por HTTP 200, Playwright resoluble, **alta y baja real de cuentas en Firebase Auth**, y lectura del propio perfil en la RTDB. Ver §4. |
| Hallazgo nuevo e importante | Con las **reglas desplegadas actualmente**, una cuenta recién creada por Auth REST **no puede iniciar sesión jamás** (no puede autoaprobarse). Detalle en §5.2. |

> Conclusión corta: **el bloqueo es del entorno, no del código de la app**, y hay un **segundo bloqueo real de precondición** (aprobación de cuenta) que hay que resolver antes de que las pruebas de navegador puedan pasar.

---

## 2. PASO 0 · Comprobación de Playwright

- `npx playwright --version` **falla** en este entorno: `npm error code EPERM ... open 'C:\Users\FOLGORESB\AppData\Local\npm-cache\_cacache\tmp\...'` (el sandbox no deja escribir en la caché de npm). No se intentó instalar nada.
- `node -e "require('playwright')"` → `MODULE_NOT_FOUND` (no hay instalación global ni `node_modules` local).
- **Sí existe** una instalación previa usable en el proyecto anterior del dueño:
  `C:\Users\FOLGORESB\Desktop\TEA\ruta-tea\node_modules\playwright` → **1.60.0** (con `playwright-core` 1.60.0).
- Navegadores instalados en `%LOCALAPPDATA%\ms-playwright`: `chromium-1117/1208/1223`, `chromium_headless_shell-1208/1223`, `firefox-1509`, `webkit-2248`, `ffmpeg`, `winldd`.
  (Ojo: Playwright 1.60 pide `firefox-1522` y `webkit-2287`, que **no** están; Chromium sí está completo para 1.60.)
- `pruebas_navegador.js` resuelve Playwright solo, en este orden: `PW_PLAYWRIGHT` → `require('playwright')` → `./node_modules` → global de npm → la ruta conocida de `ruta-tea`. **No hace falta instalar nada.**

---

## 3. Por qué no se pudo abrir el navegador (evidencia)

Se probaron cuatro vías. Ninguna funciona **dentro de esta sesión**:

**3.1 · Lanzamiento normal de Playwright**
```
browserType.launch: spawn EPERM
  - <launching> ...\chromium_headless_shell-1223\...\chrome-headless-shell.exe ... --remote-debugging-pipe
```

**3.2 · Lanzar Chromium a mano con puerto TCP y adjuntarse por CDP** (`--remote-debugging-port=9333`, `stdio: 'ignore'`)
```
CHROME_EXIT 4294930433
[ERROR:crashpad_client_win.cc:421] OpenProcess: Acceso denegado. (0x5)
[FATAL:mojo\public\cpp\platform\platform_channel.cc:108] Check failed: . : Acceso denegado. (0x5)
```
El endpoint HTTP `/json/version` **sí** responde (`HeadlessChrome/148.0.7778.96`), pero **al crear el primer *target*/página** Chromium muere en la comprobación de `platform_channel`: no puede abrir el *named pipe* de Mojo.

**3.3 · `--single-process --no-zygote`** (para evitar procesos hijos): el navegador arranca y escucha en el puerto CDP, pero vuelve a morir con el **mismo** `FATAL platform_channel.cc:108` al crear la página.

**3.4 · Prueba directa del límite del sandbox** (Node, sin navegador):
```
PIPE_SERVER_OK
PIPE_CLIENT_FAIL EPERM
```
Es decir: **se puede crear el named pipe, pero no conectarse como cliente**. Es exactamente lo que necesita el IPC de Chromium (y de Firefox/WebKit). Por eso **ningún navegador puede arrancar aquí**, ni siquiera el Chrome/Brave ya instalado del equipo, porque cualquier proceso que yo lance hereda la restricción.

**Cómo desbloquearlo (cualquiera de las dos):**

1. **Ejecutar la suite fuera del sandbox**, en una consola normal del equipo:
   ```
   cd C:\Users\FOLGORESB\Documents\Ciervo_Mini_Market\Mini-Market-GH
   node pruebas_navegador.js
   ```
2. **O adjuntarse a un Chrome abierto a mano con depuración** (el sandbox no puede impedir que el usuario lo abra):
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\pw-perfil about:blank
   set PW_CDP=http://127.0.0.1:9222
   node pruebas_navegador.js
   ```

---

## 4. Lo que SÍ se validó (preflight, `--preflight`)

Salida literal completa: `_salida_preflight_navegador.txt`. Resumen:

| Comprobación | Resultado |
|---|---|
| Servidor local arrancado en `http://127.0.0.1:5500` | **OK** |
| Playwright disponible (1.60.0) | **OK** |
| Navegadores de Playwright instalados | **OK** |
| Chromium se lanza y renderiza | **FALLA** → `spawn EPERM` (§3) |
| Las **15 páginas** se sirven por HTTP 200 | **OK** |
| Firebase Auth REST: **crear** cuenta de prueba | **OK** |
| RTDB: la cuenta lee su propio perfil `usuarios/<uid>` | **OK** |
| Sonda de reglas (solo lectura) `GET BBDD/<ruta>` | **HTTP 401 Permission denied** → reglas estrictas (§5.2) |
| Firebase Auth REST: **borrar** la cuenta de prueba | **OK** |

Total preflight: **7 OK · 1 FALLA** (la falla es el lanzamiento del navegador).

---

## 5. Hallazgos que la suite reportará (y que conviene saber YA)

### 5.1 · Escenario D: `navigator.storage.estimate` **no** dispara el aviso de poco espacio
El enunciado pedía: sustituir `navigator.storage.estimate` para devolver un 96 % y comprobar que sale el aviso llano. Leyendo el código, **eso no puede funcionar**:

- `avisarSiLleno()` (`almacenamiento.js:1012`) mide con `medirTodo()` (`:1015`).
- `medirTodo()` (`:1718`) es **síncrona** y calcula con `calcularMedida()` (`:1721`).
- `calcularMedida()` (`:1690`) saca el límite de **`limiteLocalMB()`** (`:1692`), que es: nube → `localStorage['limiteLocalMB']` → **1024 MB por defecto** (`:1670-1683`).
- `navigator.storage.estimate()` solo se usa en `estimarCuota()` (`:327-353`), que **no** participa en `avisarSiLleno()`.

**Consecuencia:** el aviso al 95 % depende del **límite local** (por defecto 1 GB), no de la cuota real del navegador.

Por eso la suite hace **dos** comprobaciones:
- `D.9a` tal cual se pidió (con `estimate` al 96 %) — es probable que **falle**, y esa falla es el hallazgo.
- `D.9c` con la **vía real** (`limiteLocalMB` diminuto, escrito con la API normal de `localStorage`, que con la cuenta activa queda como `cuenta:<ruta>:limiteLocalMB`).
Ninguna de las dos se ha podido ejecutar en navegador; esto es **predicción a nivel de código**, no un resultado medido.

### 5.2 · Bloqueo de precondición: una cuenta REST nueva **no puede entrar**
- `index.html:1214` exige `perfil.ingreso === true`; si no, saca el aviso *"Su cuenta aún no ha sido aprobada por el administrador"*, hace `signOut()` y **no escribe `sesionActiva`**.
- `ensureOwnerProfile()` (`index.html:1109-1116`) crea el perfil con **`ingreso: false`** para cualquier cuenta nueva.
- Sonda de reglas (solo lectura, sin escribir nada): `GET BBDD/<ruta>` con el token de una cuenta recién creada → **HTTP 401 "Permission denied"**. Eso descarta las reglas permisivas de `reglas-fase1.json` (allí `BBDD` es de lectura libre) y encaja con las estrictas de `reglas-firebase.json`, donde `BBDD` exige `usuarios/<uid>/ingreso === true` y el alta de `usuarios/<uid>` exige `newData.child('ingreso').val() === false`.
- Además, **todas** las páginas internas (`inventario`, `config`, `config_recibo`, `mini_market_pos`, …) incluyen `sesion.js`, que exige `sesionActiva` **y** una sesión real de Firebase Auth.

**Consecuencia:** con una cuenta creada al vuelo por Auth REST, el login se rechaza y **A, B, C, D, E y F quedan bloqueados** aunque el navegador funcione.

**Dos salidas, ambas ya soportadas por la suite:**
1. Aprobar la cuenta de prueba en la consola de Firebase (`usuarios/<uid>/ingreso = true`) y ejecutar con `PW_EMAIL_A=<correo> PW_PASS_A=<clave>` (la suite no vuelve a crearla ni la borra).
2. `node pruebas_navegador.js --autoaprobar`: intenta poner `ingreso:true` por REST con el propio token. Funcionará **solo** si las reglas desplegadas lo permiten. **No se ha ejecutado** a propósito: si las reglas fuesen permisivas crearía un nodo `usuarios/<uid>` que las reglas actuales **no dejarían borrar después**, y eso sería dejar basura en la base de producción.

### 5.3 · Nota menor sobre el informe
El código de salida real de Node es **0** (todo OK) / **1** (alguna FALLA) / **2** (no se pudo abrir el navegador) / **3** (no se pudieron preparar las cuentas). En los registros capturados desde PowerShell aparece además `[exit code: 1]`: es un artefacto del *wrapper* de la shell (comprobado: un `node -e "process.exit(2)"` tras `Tee-Object` también reporta 1). El valor real medido fue **`EXIT_REAL=2`** para la suite completa y **`1`** para el preflight.

---

## 6. Qué pasó en cada escenario

| Escenario | Estado | Motivo |
|---|---|---|
| **A** · Migración en navegador real (7 claves sembradas → prefijo `cuenta:<ruta>:`, valores idénticos, inventario con 3 productos) | **NO EJECUTADO** | No se pudo abrir navegador (§3). Además, sin cuenta aprobada el login se rechaza (§5.2). |
| **B** · Datos de muestra fuera (`menu.html`, `config_recibo.html`) | **NO EJECUTADO** | `config_recibo.html` incluye `sesion.js` → requiere sesión. |
| **C** · Aislamiento entre dos cuentas (aviso de "otra cuenta", lista vacía de B, A intacto) | **NO EJECUTADO** | Idem. |
| **D** · Guardián de cuota (96 %) | **NO EJECUTADO** | Idem. Ver §5.1: además la premisa del enunciado no encaja con el código. |
| **E** · Restaurar respaldo no retrocede el contador | **NO EJECUTADO** | `config.html` incluye `sesion.js`. |
| **F** · Motor de operaciones (`ops/venta/`) | **SALTADO** por diseño | Es opcional; solo corre con `--motor`, porque implica encender `modoSync` en la nube de la cuenta de prueba. |

**Capturas:** `capturas_navegador/` está creada y **vacía** (0 archivos). No hay nada que capturar sin navegador; la suite la llenará sola al ejecutarse.

---

## 7. Entrega

| Archivo | Qué es |
|---|---|
| `pruebas_navegador.js` | La suite (Node + Playwright, autocontenida, comentada en español, **CRLF**, 1349 líneas). No toca archivos de la app. |
| `_salida_preflight_navegador.txt` | Salida literal del preflight (§4). |
| `_salida_pruebas_navegador.txt` | Salida literal de la suite completa en el intento de hoy (falla al abrir Chromium y limpia). |
| `capturas_navegador/` | Carpeta de capturas (vacía hasta que se ejecute con navegador). |
| `_salida_servidor_navegador.log` | Log del servidor local cuando lo arranca la propia suite. |

### Qué hace la suite cuando se pueda ejecutar
- Arranca `_servidor_pruebas.js` si el puerto 5500 está libre (y lo apaga al terminar; si ya había uno, lo respeta y lo dice).
- Crea 2 cuentas `prueba.playwright.<marca>@example.com` por Auth REST y **las borra siempre** al final (incluso si algo falla, vía `finally`).
- Ejecuta A, B, C, D, E (y F con `--motor`), imprime **OK/FALLA** por comprobación y **una captura por hito** en `capturas_navegador/`.
- Termina con `exit 0` solo si no hay fallas, e imprime el recuento de comprobaciones y la lista de las que fallaron.
- Diagnostica por sí misma el fallo de navegador (mensaje `EPERM` + las dos salidas de §3).

---

## 8. Limpieza realizada

- **Cuentas de prueba:** 6 creadas en total entre los tres intentos (`prueba.playwright.a…/b…/pre…@example.com`) y **6 borradas** vía `accounts:delete` (respuesta OK en cada una). No quedan cuentas de prueba activas.
- **RTDB:** **no se escribió nada**. Solo hubo lecturas (`usuarios/<uid>` y la sonda `BBDD/…`, que devolvió 401). No se tocó ningún dato de negocio existente.
- **Servidor local:** apagado (el puerto 5500 está libre).
- **Procesos de Playwright:** ninguno colgado; no se lanzó ningún Chromium (nunca llegó a arrancar) y los archivos temporales de reconocimiento (`_tmp_pw_*`, `_tmp_pw_chrome*.log`) se eliminaron.
- **Git:** sin commits y sin push.

---

## 9. Recomendación

1. Ejecutar la suite **en una consola normal** (fuera del sandbox) o con `PW_CDP`: es el único camino a la validación real.
2. Antes de esa ejecución, **aprobar la cuenta de prueba** en la consola de Firebase y pasar `PW_EMAIL_A`/`PW_PASS_A` (y opcionalmente `PW_EMAIL_B`/`PW_PASS_B`). Sin eso, A–F se caen en el login y no por un fallo de la app.
3. Revisar el punto **§5.1** (el aviso de poco espacio no depende de `navigator.storage.estimate`): el escenario D tal y como estaba enunciado no puede pasar; hay que decidir si el comportamiento actual es el deseado o si `estimarCuota()` debería alimentar el aviso.

---

# Anexo · Segunda iteración (tras la corrida con permiso ampliado)

## A.1 · Qué pasó en la corrida con permiso ampliado

Con acceso completo **Chromium sí arranca** (el preflight dio 8/8, incluido *"Abrir Chromium"*). El bloqueo se movió a la **carga de la página**:

```
A. MIGRACIÓN DE DATOS EN NAVEGADOR REAL
ERROR INESPERADO: page.goto: Timeout 20000ms exceeded.
  - navigating to "http://127.0.0.1:5500/index.html", waiting until "domcontentloaded"
  at escenarioA (pruebas_navegador.js:666)
```

**Causa:** `index.html` trae `<script src="https://…">` **síncronos en el `<head>`** (Firebase, Lucide, Font Awesome, Tailwind, fuentes). Mientras un script síncrono no termina de bajar y ejecutarse, el parser no avanza y **`DOMContentLoaded` no llega nunca**. Esperar por ese evento con 20 s era frágil.

## A.2 · Arreglos aplicados a la suite (no a la app)

1. **Navegación sin depender de `domcontentloaded`.**
   - `page.goto(..., { waitUntil: OPCIONES.waitUntil })` con `PW_WAITUNTIL` (**por defecto `commit`**) y `PW_TIMEOUT` (**por defecto 60000 ms**).
   - `PW_TIMEOUT_DOM` (por defecto 15000 ms) es solo una espera *opcional* a `DOMContentLoaded` que **nunca hace fallar** la prueba.
   - `page.setDefaultTimeout` / `setDefaultNavigationTimeout` usan `PW_TIMEOUT` en todas las páginas.
2. **Esperas por selector/estado, no por evento.** El login espera `#email` (hasta `PW_TIMEOUT`); A.1 espera a que el script de arranque esté vivo (`window.__crudo`); y `asentar(page, ms, selector)` espera el elemento concreto de cada escenario (`#inventoryTableBody`, `#ticketPreview`, `#almBtnAvanzado`) en vez de un evento de carga.
3. **Diagnóstico antes de fallar.** Cada página lleva un vigilante (`vigilar()`) que registra consola, errores de JS, peticiones **en vuelo**, peticiones fallidas y respuestas HTTP con error. `diagnosticoDePagina()` vuelca todo eso, el `readyState` y los hosts externos contactados, y **guarda una captura**. Se dispara al fallar una navegación, al no aparecer `#email` y cuando una página acaba en otro sitio (rebote al login).
4. **Nueva comprobación A.1b** — "index.html completó su carga (los CDN responden en el navegador)": distingue de un vistazo *CDN lento* de *servidor* o *app*.
5. **Preflight: sonda de CDN desde el navegador.** Prueba los 6 CDN que usa la app (`www.gstatic.com` Firebase, `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `cdn.tailwindcss.com`, `fonts.googleapis.com`) con `fetch(..., {mode:'no-cors'})` + límite de 12 s. Si alguno falla, lo dice con nombre y apellido y **explica que no es un fallo de la aplicación**.
6. **Modo `--sin-cdn` (`PW_SIN_CDN=1`).** Aborta todas las rutas externas para ver hasta dónde llega el HTML, el sembrado y el aislamiento. Avisa en pantalla de que **el login con Firebase no funcionará** en ese modo.
7. **Aislamiento de fallos.** Cada escenario corre dentro de `correr()`: una excepción se reporta como FALLA y **ya no aborta la suite entera** (antes el `page.goto` tumbaba A–F de golpe).
8. **CDP más seguro.** Con `PW_CDP` ya no se cierran las pestañas del navegador del usuario ni se cierra su Chrome; el contexto se reutiliza.

## A.3 · Comprobado sin navegador (esta iteración)

- `node --check pruebas_navegador.js` → **OK**.
- `node pruebas_navegador.js --preflight` → **7 OK · 1 FALLA** (la única falla sigue siendo "Chromium se lanza", `spawn EPERM` en *este* entorno) — salida en `_salida_preflight_navegador.txt`. La sonda de CDN se salta aquí porque no hay navegador; **en tu entorno sí se ejecutará**.
- Archivo de nuevo en **CRLF** (1641 líneas) y sin `waitUntil: 'domcontentloaded'` fijo en ninguna navegación.

## A.4 · Comando exacto para la corrida con permiso ampliado

Primero el preflight (no necesita credenciales: crea y borra su propia cuenta), que es donde se ve si el navegador alcanza los CDN:

```powershell
cd C:\Users\FOLGORESB\Documents\Ciervo_Mini_Market\Mini-Market-GH
node pruebas_navegador.js --preflight
```

Después la suite completa (la cuenta A **no** se crea ni se borra; B sí se crea y se borra):

```powershell
cd C:\Users\FOLGORESB\Documents\Ciervo_Mini_Market\Mini-Market-GH
$env:PW_EMAIL_A='correo-aprobado@dominio.com'
$env:PW_PASS_A='la-clave'
node pruebas_navegador.js
```

Variantes útiles:

```powershell
# si la primera carga es muy lenta (CDN fríos)
$env:PW_TIMEOUT='120000'; node pruebas_navegador.js

# ver el navegador mientras corre
$env:PW_HEADFUL='1'; node pruebas_navegador.js

# comprobar hasta dónde llega la app si los CDN no responden (el login NO funcionará)
node pruebas_navegador.js --sin-cdn

# adjuntarse a un Chrome ya abierto con depuración
$env:PW_CDP='http://127.0.0.1:9222'; node pruebas_navegador.js
```

En `cmd.exe` es `set PW_EMAIL_A=...` en vez de `$env:...`.

**Nota sobre el código de salida:** el valor real de Node es 0 (todo OK) / 1 (alguna FALLA) / 2 (no se pudo abrir el navegador) / 3 (no se pudieron preparar las cuentas). Si lo lanzas por una tubería de PowerShell (`| Tee-Object`), verás `[exit code: 1]` aunque Node haya salido con 2: es un artefacto de la shell, ya comprobado.

## A.5 · Recordatorio del otro bloqueo

Aunque el navegador arranque y los CDN respondan, **la cuenta A debe estar aprobada** (`usuarios/<uid>/ingreso = true`). Con las reglas desplegadas hoy, una cuenta recién creada por Auth REST no puede entrar: ninguna página interna se abre y A–F fallan en el login (§5.2). Con `PW_EMAIL_A`/`PW_PASS_A` de una cuenta ya aprobada, ese bloqueo desaparece.

---

# Anexo · Tercera iteración (tras la corrida real: 30 OK · 6 FALLA · 1 saltada)

**Resultado de la corrida:** la suite se ejecutó de verdad en navegador. Pasaron las tres pruebas clave: la **migración** (claves prefijadas + valores idénticos), el **aviso de cuenta ajena** con los datos de A intactos (C.7a–d) y el **aislamiento** (C.8a, B ve la lista vacía con `cuenta:<A>:ciervo_inventory` intacto), más el **contador de tickets que no retrocede** (E.10, *"se conservó el contador más alto: 7"*).

Las 6 fallas eran **suposiciones equivocadas de la prueba**, no fallos de la aplicación. Corregidas así:

## B.1 · A.4b / A.4c / C.8d — el supuesto estaba mal
- **Qué asumía mal:** que los 3 productos sembrados sobrevivirían. En **modo clásico la nube se descarga y REEMPLAZA lo local**, así que con una cuenta con datos reales (la cuenta real de prueba) ganan los de la nube. Eso es **correcto**.
- **Segundo error detectado al revisar:** la tabla de `inventario.html` está **paginada** — `rowsPerPage = 10` (`inventario.html:2176`) — y `#pageInfo` muestra *"Página X de Y (N productos)"*. Comparar `filas` con el tamaño total del arreglo habría fallado igualmente con más de 10 productos.
- **Cómo se mide ahora:**
  - `A.4b` — **lo que la app declara** en `#pageInfo` (`N productos`) debe coincidir con el número de productos del almacén **de esa cuenta** (`localStorage.getItem('ciervo_inventory')`, leído con el aislamiento activo). Valida `migración → almacén de la cuenta → pantalla` sin depender de quién gane (nube o sembrado).
  - `A.4c` — las filas pintadas deben ser `min(10, N)` y **cada fila debe contener el nombre de un producto del inventario de la app**.
  - `A.4d` — sigue comprobando que no aparezca ningún dato de muestra.
  - `INFO` con `#pageInfo`, filas pintadas, productos en el almacén, primeros nombres y **cuántos de los 3 sembrados siguen vivos** (informativo), más captura.
  - `C.8d` aplica exactamente el mismo criterio al volver al marcador de A.
- **Sobre el "sembrado determinista":** no se puede hacer determinista en esta página sin desactivar la sincronización de la cuenta, y no se toca la configuración de un cliente. La prueba **determinista del sembrado es A.3** (los 7 valores idénticos a los sembrados, ya verdes); A.4 pasa a ser la comprobación *almacén → pantalla*.

## B.2 · C.8c — era un error de la prueba
Que B **tenga sus propias claves** (vacías) es precisamente el aislamiento. Ya no se exige que no existan: ahora se **comparan valores** — `cuenta:<B>:ciervo_inventory` no puede contener los datos de A (ni los nombres sembrados) y debe diferir del de A. Se añade `INFO` con las claves propias de B y su inventario.

## B.3 · D.9a — eliminada por premisa falsa
El aviso de poco espacio **no usa `navigator.storage.estimate`**: la cadena real es `avisarSiLleno()` (`almacenamiento.js:1012`) → `medirTodo()` (`:1718`) → `calcularMedida()` (`:1690`) → `limiteLocalMB()` (`:1670`), que toma la nube, luego `localStorage['limiteLocalMB']` y, si no hay nada, **1024 MB**. `estimate` solo alimenta `estimarCuota()` (`:327`), que no participa. Simular `estimate` **no podía** disparar nada, así que esa comprobación se ha **eliminado** y queda únicamente la vía real.

## B.4 · D.9c — reescrita y con diagnóstico
Orden nuevo, tal y como se pidió:
1. `D.9a` iniciar sesión y **esperar a que `datosCuenta.estado().activa === true`** (si se escribe el límite antes, la clave cae sin prefijo).
2. `D.9b` abrir el POS y **comprobar que es el POS** (no un rebote al login) y que existen `avisarSiLleno`/`medirTodo`/`limiteLocalMB`; `INFO` con el entorno.
3. `D.9c` calcular un límite pequeño a partir de **lo que la app mide de verdad** (`medirAlmacenamiento().totalBytes / 0,97`), escribirlo y **releerlo**; `INFO` con el valor releído, el efectivo y los bytes. Avisa si `limiteLocalMB().origen === 'consola'` (la nube manda).
4. `D.9d` **recargar el POS** y comprobar el aviso llano (*"le queda muy poco espacio"*), con `INFO` de `medirTodo()` y captura.
5. `D.9e` que el aviso hable de "copia de seguridad" (sin tecnicismos).
6. `D.9f` **discriminante**: si al recargar no salió, se llama `avisarSiLleno()` **a mano**. Si así sí sale, el guardián funciona y lo que falla es el **cableado de la página**; si tampoco, el problema está en el guardián. En ambos casos se vuelca el diagnóstico completo.
7. Se **restaura el `limiteLocalMB` anterior** de la cuenta (A es real) y se recorta la ventana con el límite pequeño para no dar tiempo a la política de espacio.

## B.5 · Verificado sin navegador en esta iteración
- `node --check pruebas_navegador.js` → **OK**, **CRLF** (1787 líneas, 0 LF sueltos).
- `node pruebas_navegador.js --preflight` → **7 OK · 1 FALLA** (la de siempre: "Chromium se lanza", `spawn EPERM` en este entorno). Salida en `_salida_preflight_navegador.txt`.
- `F` sigue siendo *opt-in* (`--motor`), la limpieza sigue igual (B se crea y se borra; **A nunca se toca**) y no se modificó ningún archivo de la aplicación.

## B.6 · Comando para repetir la corrida

```powershell
cd C:\Users\FOLGORESB\Documents\Ciervo_Mini_Market\Mini-Market-GH
$env:PW_EMAIL_A='correo-aprobado@dominio.com'
$env:PW_PASS_A='la-clave'
node pruebas_navegador.js
```

(Opcional: `node pruebas_navegador.js --preflight` antes, y `$env:PW_HEADFUL='1'` para verlo.)

---

# Anexo · Cuarta iteración · DOS FALLOS REALES ARREGLADOS

> **Aviso de alcance:** en el encargo inicial se me pidió **no tocar los archivos de la aplicación** y, ante un fallo, **reportarlo con la evidencia**. En esta iteración el agente coordinador pidió explícitamente **arreglar la app** y actualizar sus pruebas. Se ha hecho: los únicos archivos de la aplicación modificados son **`datos_cuenta.js`** y su suite **`pruebas_datos_cuenta.js`**. Ningún otro archivo de la app se ha tocado, y no hay commits ni push.

Las dos fallas que encontró la corrida **eran reales** (no suposiciones de la prueba). Confirmadas primero en el código y arregladas después.

## C.1 · FALLO 1 · Las páginas rebotaban al login tras activarse el aislamiento

**Evidencia de la corrida:** `D.9b` → `{"url":".../index.html","medirTodo":false,"avisarSiLleno":false,"limiteLocalMB":false,"activa":true}`; `D.9f` → `"no existe avisarSiLleno"`; `A.4b`/`C.8d` → `#pageInfo: null` y 0 filas.

**Causa (confirmada en `datos_cuenta.js`):** el SDK de Firebase Auth persiste la sesión en `localStorage` como `firebase:authUser:<apiKey>:[DEFAULT]` **durante** `signInWithEmailAndPassword`, es decir **antes** de que `activarYMigrar()` active el prefijo. Esa clave quedaba SIN prefijo. Al activarse el aislamiento, `fisicaDe()` la prefijaba, así que las lecturas posteriores del SDK iban a `cuenta:<ruta>:firebase:authUser:...` (vacía) → el SDK creía que no había sesión → `sesion.js` devolvía la página al login. El comentario del propio módulo afirmaba lo contrario ("Todo lo demás se prefija, incluidas las claves de Firebase Auth").

**Arreglo:** nuevo `PREFIJOS_DE_EQUIPO = ['firebase:', 'firebaseLocalStorage']`. `esClaveDeEquipo()` ahora cubre la lista exacta **y** esos prefijos. La sesión de Auth vuelve a ser del **equipo**, no del negocio, y el guardián de fase 1 (`cuenta_local.js`) sigue impidiendo que otra cuenta use el equipo. `estado()` publica `prefijosDeEquipo` para que quede visible.

## C.2 · FALLO 2 · Claves huérfanas sin prefijo que la cuenta siguiente reclamaba

**Evidencia de la corrida:** `cuenta:<B>:ciervo_inventory` contenía *"Producto sembrado 1/2/3"*.

**Causa (confirmada en `datos_cuenta.js:368-372`):** cuando el destino `cuenta:<ruta>:<clave>` ya existía, la migración hacía `omitidas++` y **dejaba la original sin prefijo**. Esa original quedaba expuesta y la migración de la **cuenta siguiente** la copiaba a su espacio: fuga entre cuentas. (La cuenta A es real y ya tenía claves de ejecuciones anteriores, así que el destino existía.)

**Arreglo:** prefijo **reservado** de cuarentena `_legacy_:<clave>`. Si el destino ya existe, la original se **mueve** ahí conservando el valor (con sufijo `_2`, `_3`… si el hueco está ocupado). La cuarentena:
- la **ignora** la migración,
- **no** la borra `limpiarCuenta()`,
- **no** cuenta como clave de ninguna cuenta (`estado().clavesEnCuarentena` la cuenta aparte),
- `fisicaDe()` la trata como nombre reservado (nunca la prefija).

Criterio documentado en el módulo: **si el destino existía → cuarentena; si no existía → copia + borrado de la original (como hasta ahora)**.

## C.3 · Pruebas añadidas/actualizadas

`pruebas_datos_cuenta.js` (**+15 comprobaciones**, de 187 a **202**):
- `C7` · las claves del SDK (`firebase:authUser:...`, `firebase:host:...`, `firebase:previous_websocket_failure`, `firebaseLocalStorageDb`) **no se prefijan** con la cuenta activa.
- `C8` · se leen igual con otra cuenta activa y sin ninguna cuenta.
- `C9` · `estado()` publica `prefijosDeEquipo` y `clavesEnCuarentena`.
- `D13` reescrita (antes consagraba el fallo: exigía que la original siguiera expuesta) + `D13b` (cuarentena con valor intacto) + `D13c` (la cuenta sigue viendo SU clave y la cuarentena se cuenta aparte).
- **Bloque D-bis nuevo (R1–R7): la regresión exacta del fallo 2** — sembrar → migrar para A cuando A **ya** tenía esa clave → **ninguna** clave de negocio sin prefijo → activar B → **B ve su inventario vacío** → lo de A y la cuarentena intactos → idempotente.
- `E5b` · `limpiarCuenta()` no borra la cuarentena.
- 2 comprobaciones estáticas nuevas (trata las claves del SDK como de equipo; reserva `_legacy_:`).

`pruebas_navegador.js`: `A.3b` ahora exige que **ninguna clave de negocio** quede sin prefijo, admitiendo solo claves de equipo (lista + prefijos, incluida la sesión de Firebase) y restos en cuarentena; e informa de ambos grupos.

## C.4 · Regresión completa (13 suites, 0 fallos)

Salida literal en `_salida_regresion_completa.txt`:

| Suite | Resultado |
|---|---|
| `pruebas_datos_cuenta.js` | **202 OK · 0 FALLAS** |
| `pruebas_cuenta_local.js` | **79 OK · 0 FALLAS** |
| `pruebas_acceso.js` | **65 OK · 0 FALLAS** |
| `pruebas_sesion.js` | **42 OK · 0 FALLAS** |
| `pruebas_sin_datos_muestra.js` | **82 OK · 0 FALLAS** |
| `pruebas_guardian_cuota_paginas.js` | **96/96 OK** |
| `pruebas_restaurar_respaldo.js` | **55/55 OK** |
| `pruebas_sincronizacion.js` | **83 OK · 0 FALLAS** |
| `pruebas_lector_ventas.js` | **64 OK · 0 FALLAS** |
| `pruebas_motor_operaciones.js` | **49 OK · 0 FALLAS** |
| `pruebas_stock_movimientos.js` | **56 OK · 0 FALLAS** |
| `_pruebas_historial_almacenamiento.js` | **161/161 OK** |
| `pruebas_motor_real.js` | **127 OK · 0 FALLAS** |
| **TOTAL** | **1161 OK · 0 FALLAS** |

`datos_cuenta.js` y las dos suites editadas quedan en **CRLF**. `node --check` OK. `pruebas_navegador.js --preflight` sigue en 7 OK · 1 FALLA (solo el lanzamiento de Chromium en el entorno del agente).

## C.5 · Comando para la validación completa con permiso ampliado

```powershell
cd C:\Users\FOLGORESB\Documents\Ciervo_Mini_Market\Mini-Market-GH
$env:PW_EMAIL_A='correo-aprobado@dominio.com'
$env:PW_PASS_A='la-clave'
node pruebas_navegador.js
```

Y, si se quiere la regresión completa sin navegador:

```powershell
foreach ($s in @('pruebas_datos_cuenta.js','pruebas_cuenta_local.js','pruebas_acceso.js','pruebas_sesion.js','pruebas_sin_datos_muestra.js','pruebas_guardian_cuota_paginas.js','pruebas_restaurar_respaldo.js','pruebas_sincronizacion.js','pruebas_lector_ventas.js','pruebas_motor_operaciones.js','pruebas_stock_movimientos.js','_pruebas_historial_almacenamiento.js','pruebas_motor_real.js')) { node $s }
```

**Qué debería verse ahora en la corrida de navegador:** `A.4`/`C.8d` con `#pageInfo` y filas reales (las páginas ya no rebotan al login), `C.8c` en verde (B vacío) y `D.9` con el POS abierto de verdad, sus números y el aviso llano por la vía real.

---

# Anexo · Quinta iteración · MEDIDO, no supuesto: DOS FALLOS REALES DE LA APP

**Resultado con la cuenta real de prueba (correo omitido a propósito: este documento se publica en la web):**

| | Antes | Después del arreglo |
|---|---|---|
| Comprobaciones | 36 OK · **7 FALLA** · 1 saltada | **42 OK · 0 FALLA · 1 saltada** |
| Código de salida de Node | 1 | **0** |
| La saltada | `F.11` (opcional, `--motor`, escribe en la nube) | igual: `F.11`, a propósito |

Regresión sin navegador (13 suites): **1161 OK · 0 FALLAS**, idéntica a la línea base. Sin commits ni push.

## D.1 · La hipótesis de la fase 1 quedó DESCARTADA midiendo

El diagnóstico anterior apuntaba a que `cuenta_local.js` (fase 1) declaraba "cuenta ajena" y bloqueaba.
Se midió con una sonda de Playwright (`_sonda_login.js`) y **es falso**. Con la cuenta real, en
`inventario.html`:

- `cuentaLocal.reclamarOComprobar(<correo de la cuenta real>)` → `estado: "coincide"`, **nunca "ajena"**.
- `datosDeCuenta` (física y lógica) = `<ruta-de-la-cuenta-real>`; `sesionActiva` presente.
- `datosCuenta.estado()` → `activa:true, migrada:true, interceptado:true, error:null`.
- `cuenta:...:firebase:*` → **ninguna** (el arreglo de la cuarta iteración funciona).
- Claves de negocio sin prefijo → **ninguna**. Cuarentena → ninguna.
- Ni `#avisoCuentaAjena` ni el aviso "Sesión no activa": **la página no rebota**.
- La página propia SÍ arranca: `avisarSiLleno`, `medirTodo`, `limiteLocalMB` existen.

Conclusión: el aislamiento por cuenta está **bien**. Las 7 fallas eran **dos defectos de la app**
ajenos al aislamiento, y **los dos existen también en el commit de producción `87c7d9f`**.

## D.2 · FALLO 1 · `inventario.html` reventaba al pintar (A.4b, A.4c, C.8d)

**Evidencia medida** (`_sonda_arranque.js`, pila real del error, no deducción):

```
TypeError: Cannot read properties of undefined (reading 'toLocaleString')
    at inventario.html:3105:54
    at Array.map (<anonymous>)
    at renderProducts (inventario.html:3097:49)
    at loadProducts (inventario.html:2965:13)
```

El almacén de la cuenta **sí** tenía los 3 productos (`inventarioEnAlmacen: 3`) pero
`#pageInfo` se quedaba con el texto INICIAL del HTML (`Página 1 de 1`, sin el `(N productos)`)
y 0 filas **para siempre**: se muestreó 30 s y nunca pintó. **No era un problema de tiempo de
espera** — por eso subir los `asentar(3000)` de la suite no habría arreglado nada.

**Causa exacta (línea 3104):**

```js
const marginValue = product.margin !== null ? product.margin : (product.profit / (product.cost || 1)) * 100;
const marginDisplay = `${marginValue.toLocaleString('es-ES', {...})}%`;
```

Un producto **sin la clave `margin`** (importado del catálogo, restaurado de un respaldo viejo o
creado por una versión anterior) tiene `margin === undefined`, y **`undefined !== null` es TRUE**:
el ternario devolvía `undefined` en vez de calcular el margen. `undefined.toLocaleString(...)`
lanzaba el `TypeError` **dentro del `.map()` de las filas**, así que **un solo producto sin margen
abortaba la tabla entera** y, como `loadProducts()` llama a `renderProducts()`, tumbaba el arranque
de la página: inventario vacío en pantalla con los datos intactos en disco.

**Arreglo:** dos funciones nuevas y numéricamente seguras — `margenNumerico(product)` (devuelve
siempre un número finito) y `margenDeclarado(product)` — usadas en los 5 puntos donde estaba el
guardián roto: el pintado de filas, el orden por margen, el modal de edición, el PDF de producto y
la exportación a Excel.

## D.3 · FALLO 2 · El POS echaba al login a un usuario con sesión válida (D.9b, D.9d, D.9e, D.9f)

**Evidencia medida:** al abrir `mini_market_pos.html` en una **pestaña nueva** con la sesión ya
válida, la sonda capturó el `alert()` y la navegación:

```
+   201 ms  /mini_market_pos.html   currentUser=null  sesionActiva=sí  avisarSiLleno=function
alert(): "No se ha iniciado sesión. Redirigiendo al login."   (a los 353 ms)
NAVEGA a: /mini_market_pos.html -> /index.html
```

A los 201 ms el POS **estaba vivo** (`avisarSiLleno` ya existía) y **la sesión compartida estaba
presente**. Aun así se iba al login.

**Causa exacta (`mini_market_pos.html:2078-2082`):**

```js
const currentUser = sessionStorage.getItem('currentUser');
if (!currentUser) { alert("No se ha iniciado sesión..."); window.location.href = 'index.html'; }
```

Dos problemas sumados:

1. `currentUser` es la marca del **OPERADOR**, y **solo la escribe `index.html`** (~línea 1758) en
   el login de operador. Un **propietario** con sesión perfectamente válida nunca la tiene.
2. `sessionStorage` es **POR PESTAÑA**: en una pestaña nueva (o al reabrir el navegador) no está,
   aunque la sesión siga viva.

Consecuencia real para un cliente: el POS se cierra solo, con un aviso alarmante, y no se puede
cobrar. No tiene nada que ver con el aislamiento por cuenta.

**Arreglo:** la puerta ahora acepta la sesión de verdad — la marca **compartida**
`localStorage['sesionActiva']`, que `sesion.js` ya exige junto con Firebase Auth — y solo manda al
login cuando **no hay ninguna de las dos** (ni operador ni sesión compartida). El operador se sigue
usando para el nombre del vendedor y para el motor de operaciones, y ambos **ya toleraban su
ausencia** (líneas ~4697 y ~5079, verificado antes de tocar nada).

## D.4 · Herramientas entregadas

| Archivo | Qué es |
|---|---|
| `_sonda_login.js` | Sonda pedida: inicio de sesión + volcado de URL, avisos visibles, `sesionActiva`/`datosDeCuenta` (lógica y física), claves sin prefijo / `cuenta:*` / `cuenta:...:firebase:*`, `datosCuenta.estado()`, veredicto de `reclamarOComprobar` (real y solo-lectura), `firebase.currentUser`, `sessionStorage`, captura y línea de tiempo. |
| `_sonda_arranque.js` | Sonda de las dos preguntas abiertas: (1) cronología del pintado de `inventario.html`; (2) el POS en pestaña nueva, con captura del `alert()` y de la navegación. |
| `_diag_sintaxis.js` | Valida la sintaxis de los `<script>` **en línea** de las 18 páginas con el parser de Node (`vm.Script`), sin navegador. 27 bloques, 0 errores. |
| `_salida_pruebas_navegador.txt` | Salida literal de la corrida limpia (42 OK · 0 FALLA). |
| `_salida_regresion_completa.txt` | Salida literal de las 13 suites (1161 OK · 0 FALLAS). |
| `_sonda_login_salida.txt` / `_sonda_login_volcado.json` | Volcado de la primera sonda (la que descartó la fase 1). |
| `_sonda_arranque_salida.txt` / `_sonda_arranque_volcado.json` | Volcado de la segunda (causas de A.4 y D.9). |

## D.5 · Qué NO se pudo verificar

- **`F.11`** (motor de operaciones con `modoSync`): sigue **sin ejecutar**, porque escribe en la
  nube de la cuenta de prueba y es opt-in (`--motor`). No se pidió.
- **Clientes reales**: todo se midió contra `http://127.0.0.1:5500` con el servidor local. **No se
  tocó producción** ni ningún dato de cliente. Los dos arreglos están sin commitear y sin desplegar.
- **`currentUser` ausente en el POS**: se comprobó por lectura que el nombre del vendedor cae a
  `saleData.seller || 'Cajero'` y que el motor de operaciones omite el operador, pero **no se cobró
  una venta de verdad** para verlo de punta a punta (eso es `F.11`).
- **Los 3 procesos `node` que siguen vivos** no se pudieron atribuir a esta sesión (el sandbox negó
  `Get-CimInstance`): se comprobó que el **puerto 5500 está libre**, así que no es un servidor de
  prueba colgado. No se mató ninguno por no poder identificarlos.
- **Capturas obsoletas**: en `capturas_navegador/` siguen quedando capturas de las corridas CON
  fallos (`04_A4_inventario_con_los_3_productos.png`, `09_C8d_A_recupera_sus_3_productos.png`,
  `10_D9_aviso_poco_espacio_estimate.png`, `11_D9c_...`, `12_diagnostico_...`,
  `13_diagnostico_...`). **No se borró nada**; las capturas de la corrida limpia son las que
  coinciden con los nombres numerados que genera la suite.
