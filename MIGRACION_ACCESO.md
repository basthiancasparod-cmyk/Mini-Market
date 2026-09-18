# Migración del acceso a Firebase Authentication

Objetivo: que la base de datos deje de estar abierta a internet (hoy cualquiera puede leer y
escribir `users`, `operadores` y `BBDD`) **sin perder la capacidad de ver y corregir los datos
desde la consola de Firebase**.

La clave: **la consola no pasa por las reglas de seguridad**. Puedes cerrar el acceso público y
seguir viendo, editando y aprobando todo desde la consola exactamente como ahora.

---

## 1. Qué cambia en tu forma de trabajar

| Tarea | Antes | Ahora |
|---|---|---|
| Aprobar un cliente | `users` → su registro → `ingreso: true` | `usuarios` → el registro cuyo `email` coincide → `ingreso: true` |
| Ver / dictar una contraseña | `users` → campo `password` | `soporte` → campo `password` (y `email`) |
| Corregir datos del negocio | `BBDD` | `BBDD` (igual) |
| Corregir nombre/teléfono de un operador | `operadores` | `operadores` (igual) |
| Los registros viejos | — | `users` queda como **archivo histórico** de solo lectura; no se borra nada |

> Los clientes ya registrados **se migran solos**: la primera vez que entren con su contraseña
> actual se les crea la cuenta de Authentication, su perfil en `usuarios` y su bóveda en `soporte`.

---

## 2. Paso previo obligatorio (hazlo antes de nada)

## 2. Pasos previos obligatorios (hazlos antes de subir nada)

**2.1 Authentication → Sign-in method → Correo electrónico/contraseña → Habilitar.** ✅ hecho

Comprobado en vivo: antes estaba desactivado (`OPERATION_NOT_ALLOWED`). El nuevo login avisa con
ese texto si vuelve a ocurrir.

**2.2 Realtime Database → Rules → pegar `reglas-fase1.json` → Publicar.** ⬜ pendiente

Necesario y comprobado en vivo: las reglas actuales abren **solo** `users`, `operadores` y `BBDD`;
los nodos nuevos `usuarios` y `soporte` responden **401**, así que el nuevo login no podría guardar
el perfil ni la bóveda (fallaría en silencio y todos los clientes aparecerían como "no aprobados").

`reglas-fase1.json`:
- añade `usuarios` y `soporte` con las reglas **definitivas** (solo el propio dueño, por uid),
- deja `users`, `operadores` y `BBDD` **como están hoy**, para no romper nada todavía.

Es seguro aplicarlo ya, incluso antes de subir el `index.html` nuevo: la app actual no toca esos
nodos. Solo mejora la seguridad (los nodos nuevos nacen cerrados).

**2.3 Subir el `index.html` nuevo y probar (ver "Verificación de la Fase 1").**

---

## 3. Fases

### Fase 1 — `index.html` con Authentication ✅ HECHO

- El propietario se valida contra Firebase Authentication (correo + contraseña).
- Se crean `usuarios/{uid}` (con `ingreso`) y `soporte/{uid}` (correo + contraseña legibles).
- Los propietarios antiguos se migran solos en su primer inicio de sesión.
- El login de operador sigue igual (usuario + clave del negocio), pero **ya no guarda la
  contraseña en el navegador**.
- Arreglos de la auditoría incluidos: XSS del aviso (`textContent`), orden de
  `ensureUserCloudStructure`, correo en minúsculas, `withRetry` eliminado.

**Verificación de la Fase 1 (hazla tú, en 3 minutos):**

1. Con la base todavía abierta, entra a `index.html` **con un correo de prueba nuevo** y regístrate.
2. En la consola: `usuarios` debe tener un registro nuevo con `ingreso: false`, y `soporte` otro
   con el correo y la contraseña que escribiste.
3. Pon `ingreso: true` en ese registro de `usuarios` y entra: debe dejarte pasar.
4. Entra con un cliente real de los antiguos: debe migrar solo y funcionar.
5. Si algo falla, revierte `index.html` desde git y no habrás perdido nada.

### Fase 2 — `config.html` y `gestion_usuario.html` ✅ HECHO

- `config.html`: el paso que pide la contraseña del propietario antes de un restablecimiento ya no
  lee `users`; ahora **reautentica con Authentication** (`reauthenticateWithCredential`), que valida
  la contraseña de verdad sin tocar la sesión, y comprueba la aprobación en `usuarios/{uid}/ingreso`
  (antes miraba un campo `aprobado` que no existe).
- `gestion_usuario.html`: carga el SDK de Authentication y espera la sesión. Su consulta a
  `operadores` por `propietario` es justo la que permiten las reglas finales: no hizo falta más.

### Fase 3 — las 10 páginas de datos ✅ HECHO

`catalogo`, `cuentas`, `compras`, `config_recibo`, `gestion_empresa`, `gestion_proveedores`,
`inventario`, `listado_clientes`, `mini_market_pos`, `mini_market_pos_resumen` + `config.html` y
`gestion_usuario.html` ya cargan `firebase-auth.js` y `sesion.js`.

`sesion.js` (nuevo) hace dos cosas, sin tocar la lógica de las páginas:
1. Envuelve `initFirebase()`: primero deja que la página cargue e inicialice el SDK (en 9 páginas
   es **dinámico**, desde un array de URLs) y **después** exige la sesión. Si no hay sesión, manda
   al login y no le entrega la base a la página.
2. Si la pestaña no tiene la ruta de datos (p. ej. abriste el módulo en otra pestaña), la restaura
   leyendo `usuarios/{uid}`. Antes eso te echaba al login.

`menu.html` no toca la base de datos: no necesita nada.

Y `cerrar_sesion.js` (nuevo) cierra la sesión **de verdad**: borrar `sessionStorage` no cerraba la
de Firebase, así que después de "Cerrar sesión" las páginas internas seguían abriéndose. Se usa en
`menu.html` (que no carga el SDK: lo carga al vuelo si hace falta) y en `config.html`. En
`index.html` el cierre de sesión ya espera a que Firebase confirme.

**Detalles del control de sesión que costó descubrir (no volver a romperlos):**

1. **La sesión de la aplicación vive en `localStorage` (`sesionActiva`), no en `sessionStorage`.**
   El navegador **copia** el `sessionStorage` a las pestañas nuevas que abre la app, así que una
   pestaña abierta antes de cerrar sesión conservaba su copia y seguía entrando.
2. **El control frena el arranque de la página SIEMPRE** (interceptando `DOMContentLoaded` en fase
   de captura), no solo dentro de `initFirebase`. Motivo: varias páginas pintan sus datos desde
   `localStorage` y **no llaman a Firebase** cuando el Cloud Sync está apagado o no hay sesión
   (`inventario.html:2281`, `cloud-access.js:8`), así que envolver `initFirebase` no bastaba y la
   página se abría con los datos locales.
3. **`localhost:5500` y `127.0.0.1:5500` son orígenes distintos** para el navegador: la sesión no
   se comparte entre ellos. Para probar, usar siempre el mismo host.
4. `cerrar_sesion.js` solo borra la clave `sesionActiva` de `localStorage`: ese almacén guarda
   además el inventario, las ventas y la configuración, y **no se debe vaciar**.

> ⚠️ **Sube `index.html` y estas páginas JUNTAS.** Si publicas las páginas sin el `index.html`
> nuevo, nadie tendrá sesión de Authentication y el `sesion.js` devolverá a todo el mundo al login.

### Fase 4 — Migrar a todos los clientes y aplicar las reglas

**4.0 Migración ya ejecutada:** `node migrar_cuentas.js --aplicar` → **5 de 5 clientes migrados
y verificados** (su contraseña actual ya funciona en Authentication, perfil aprobado en
`usuarios/{uid}` y bóveda creada en `soporte/{uid}`). Comprobado también que ni el perfil ni la
bóveda se pueden leer sin sesión.

> ⚠️ **ORDEN IMPORTANTE: publica primero, cierra después.**
> Al aplicar `reglas-firebase.json`, la versión **publicada** actual (la vieja, sin Authentication)
> dejaría de funcionar: lee `users` y `BBDD` sin sesión. Por eso:
> 1. Publica `index.html` + las 12 páginas + `sesion.js` + `cerrar_sesion.js` **juntos**.
> 2. Comprueba en la web publicada que el login y los módulos funcionan.
> 3. **Después** aplica las reglas.
>
> Hasta ese momento la base sigue abierta a internet (y las contraseñas siguen expuestas), así que
> conviene no dejar pasar días entre un paso y otro.

**4.1 Antes de cerrar nada: `node migrar_cuentas.js`** (simulación, solo lista) y después
**`node migrar_cuentas.js --aplicar`**. ✅ ya hecho

Es imprescindible: al cerrar las reglas, `users` solo será legible por quien ya tenga cuenta de
Authentication. Un cliente que no haya entrado durante la transición **se quedaría sin poder entrar
nunca**. Este script crea su cuenta de Authentication con su clave actual y le escribe
`usuarios/{uid}` y `soporte/{uid}` respetando las reglas. No imprime contraseñas y es idempotente.

**4.2 Realtime Database → Rules → pegar `reglas-firebase.json` → Publicar.**

**Verificación inmediata (imprescindible):**

```bash
# 1. Sin credenciales debe estar cerrado (esto es lo urgente)
curl -s -o /dev/null -w "%{http_code}\n" https://mini-market-ciervo-index-default-rtdb.firebaseio.com/users.json
curl -s -o /dev/null -w "%{http_code}\n" https://mini-market-ciervo-index-default-rtdb.firebaseio.com/operadores.json
curl -s -o /dev/null -w "%{http_code}\n" https://mini-market-ciervo-index-default-rtdb.firebaseio.com/BBDD.json
# Las tres deben responder 401

# 2. Escritura anónima denegada
curl -s -X PUT -d '{"x":1}' https://mini-market-ciervo-index-default-rtdb.firebaseio.com/users/prueba.json
# Debe responder Permission denied
```

3. Con la app: iniciar sesión, abrir cada módulo y comprobar que carga datos.
4. **Caso especial a probar**: registrar un correo con **varios puntos** (por ejemplo
   `a.b.c@ejemplo.com`). La regla que autoriza `BBDD` valida la ruta del correo; si este caso
   fallara, hay que cambiar el esquema de rutas (avísame y lo ajusto).

**Rollback:** si algo se rompe, vuelve a poner las reglas anteriores desde la consola
(Realtime Database → Rules) y todo vuelve a estar como ahora. Guárdalas antes de cambiarlas:

```json
{ "rules": { ".read": false, ".write": false,
  "users": { ".read": true, ".write": true, ".indexOn": ["email"] },
  "operadores": { ".read": true, ".write": true, ".indexOn": ["propietario"] },
  "BBDD": { ".read": true, ".write": true } } }
```

*(No es exactamente tu configuración actual, que no puedo leer; cópiala de la consola antes de
tocar nada.)*

### Fase 5 — Rotar contraseñas y cambio de clave en la app

Las 5 + 5 contraseñas estuvieron públicas, así que hay que cambiarlas. Además conviene añadir un
"cambiar mi contraseña" en la app que actualice a la vez Authentication y la bóveda `soporte`
(si no, al resetear desde la consola la bóveda queda desactualizada).

---

## 4. Limitación conocida (importante para tu soporte)

La contraseña real vive **hasheada** en Authentication (no se puede leer, por diseño) y una copia
legible en `soporte/{uid}` para que puedas dictarla. Se escriben juntas al registrarse y al
migrar, así que coinciden.

- Si cambias la clave del cliente desde **Authentication → Reset password**, la bóveda quedará con
  la clave vieja. En ese caso actualiza también `soporte/{uid}/password`.
- Mientras no exista el flujo de "cambiar mi contraseña" en la app (Fase 5), la forma limpia de
  asignar una clave nueva es usar el restablecimiento por correo y luego corregir la bóveda.

---

## 5. Pruebas automatizadas

- `node pruebas_acceso.js` → **65 comprobaciones** de la autenticación de `index.html` con Firebase
  simulado (registro, migración, aprobación, claves incorrectas, anti-suplantación, login de
  operador sin guardar la clave, XSS del aviso, estructura de nube, cierre de sesión y el respaldo
  de errores).
- `node pruebas_sesion.js` → **25 comprobaciones** de `sesion.js` y `cerrar_sesion.js`: manda al
  login sin sesión, envuelve `initFirebase` en el orden correcto (SDK primero, sesión después),
  comprueba la sesión una sola vez, no pisa la ruta de la pestaña, no bloquea la página si falta el
  SDK, frena el arranque en las páginas sin `initFirebase`, y el cierre de sesión cierra Firebase
  (incluso desde una página que no carga el SDK, y aunque el SDK no se pueda descargar).
- **Comprobado en vivo contra tu proyecto** (cuentas desechables, borradas y verificadas):
  - el proveedor de correo/contraseña ya funciona;
  - el proyecto **oculta** si falló el correo o la clave: devuelve `INVALID_LOGIN_CREDENTIALS`, que
    el SDK v8.10.0 no conoce y convierte en `auth/internal-error`. Por eso el respaldo que migra a
    los clientes antiguos ahora se activa ante **cualquier** error de credenciales, no solo ante
    `user-not-found`/`wrong-password` (si no, ningún cliente antiguo podría migrar);
  - las reglas actuales abren `users`, `operadores` y `BBDD` (lectura **y** escritura, sin
    credenciales) y **cierran** `usuarios` y `soporte` → de ahí el paso 2.2.
