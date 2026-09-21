# Diseño del stock por movimientos

**Estado:** diseño cerrado, **sin implementar**. Este documento no toca código de la aplicación.
**Fecha:** 2026-02 (borrador de trabajo)
**Ámbito:** `BBDD/<emailPath>/...` en Firebase Realtime Database v8, páginas HTML estáticas
(`mini_market_pos.html`, `inventario.html`, `compras.html`, `mini_market_pos_resumen.html`).
**Piezas con las que encaja (no se cambian):** `DISENO_MOTOR_OPERACIONES.md` (Fase B),
`motor_operaciones.js` (E1), `lector_ventas.js` (E2), `almacenamiento.js`, `datos_cuenta.js`.

---

## 0. Problema que resuelve

Hoy el stock es **un número dentro del producto** (`producto.stock`) y se sube con el **arreglo
completo** de productos:

```js
// mini_market_pos.html, updateInventory() (~línea 4403)
inventory[index].stock -= item.quantity;
localStorage.setItem('ciervo_inventory', JSON.stringify(inventory));
fbSaveProductos(inventory);              // db.ref(...+'/productos').set(arreglo COMPLETO)

// inventario.html, ajuste manual (~línea 4276)
product.stock = newStock;
```

Es un **valor compartido que se sobrescribe**. Consecuencia, ya documentada en
`AUDITORIA_REPLICACION_SYNC.md` y en `DISENO_MOTOR_OPERACIONES.md` §0:

* Dos equipos sin conexión que venden el mismo producto se **pisan**: el que sube último gana y la
  venta del otro desaparece del stock. El stock no converge: se pierde.
* El POS además recorta a 0 (`if (stock < 0) stock = 0`), así que un descuadre **se oculta** en vez
  de verse.

**El cambio de modelo:** el stock deja de ser un valor y pasa a ser el **resultado de una suma de
movimientos**. Cada cambio de stock es una operación `movimiento` con clave única e idempotente
(§1), encolada en el equipo antes de tocar la red igual que una venta. Dos equipos que vendan sin
conexión **no se pisan**: sus movimientos son hechos distintos que se suman.

```
stock(p) = saldoBase(p) + Σ movimientos no cubiertos por el saldo base
```

El campo `producto.stock` **no se borra**: se queda como **caché de presentación** (§9), para que
las pantallas que hoy lo leen (POS, inventario, catálogo, reportes) sigan funcionando sin
reescribirse.

---

## 1. Cada cambio de stock es una operación `movimiento`

### 1.1 Ruta y valor (se reutiliza el motor E1 tal cual)

La operación `movimiento` usa exactamente el mismo sobre del motor de operaciones
(`motor_operaciones.js` §1.1/§1.2, decisión cerrada nº 2 — clave con `installId`):

```
BBDD/<emailPath>/ops/movimiento/<deviceId>_<installId>_<secuencia4>
```

Ejemplo:

```
BBDD/negocio_at_ejemplo_com/ops/movimiento/7K3F9QAB_K7M2_0031
```

```json
{
  "id": "MOVIMIENTO-LOCAL-7K3F9QAB-0031",
  "tipo": "movimiento",
  "deviceId": "7K3F9QAB",
  "installId": "K7M2",
  "secuencia": 31,
  "fechaISO": "2026-02-14T15:04:05.123Z",
  "operador": "maria",
  "version": 1,
  "payload": {
    "opId": "M-V-V-LOCAL-7K3F9QAB-0031",
    "productoId": "P-HARINA-PAN",
    "tipoMov": "venta",
    "cantidad": -3,
    "ref": "V-LOCAL-7K3F9QAB-0031",
    "anulaA": "",
    "nota": "",
    "periodo": ""
  }
}
```

**Dónde va cada cosa (corregido tras la auditoría independiente).** El motor E1
(`motor_operaciones.js` ~L1409-1418) construye el sobre con una lista FIJA de campos
(`id`, `tipo`, `deviceId`, `installId`, `secuencia`, `fechaISO`, `operador`, `version`,
`payload`) y **no copia nada del payload a la raíz**. Por tanto los campos de negocio
(`opId`, `productoId`, `tipoMov`, `cantidad`, `ref`, `anulaA`, `periodo`, `saldoContado`)
van **dentro de `payload`**, no en la raíz. Esto mantiene la afirmación del §8 («se
reutiliza tal cual: `registrarOperacion('movimiento', payload)` es toda la API que hace
falta») y no obliga a tocar el sobre del motor:

| Pieza | ¿Se reutiliza tal cual? |
|---|---|
| Sobre de la operación (raíz) | **Sí**, tal cual el de E1 |
| Ruta `ops/<tipo>/<deviceId>_<installId>_<secuencia4>` | **Sí**, tal cual |
| Cola durable, ventana caliente, reintentos, liberación | **Sí**, tal cual |
| Contenido de `payload` (los campos de negocio) | **Nuevo**: lo define este diseño |
| `id` de la operación | El motor respeta `payload.id` si viene (L1402). Si no, genera `MOVIMIENTO-LOCAL-<deviceId>-<pad4>`. El `id` **no** es la clave de negocio: la clave de negocio es `payload.opId` |

Reglas (heredadas del §1.2/§1.3/§1.4 del diseño del motor, **sin cambios**):

* **Append-only**: un movimiento escrito no se modifica ni se borra. Corregir es **otro**
  movimiento que referencia al original (`payload.anulaA`).
* **Idempotencia por clave**: escribir dos veces la misma ruta con el mismo contenido es un no-op
  observable. Con contenido distinto el motor marca `conflicto` y **no** sobrescribe.
* **Orden total**: `(fechaISO, secuencia, deviceId)`. La suma es conmutativa, así que el orden solo
  importa para la política de cierre (§4) y para la presentación.
* `secuencia` sale de la **misma serie** que las ventas (`pos_last_sale_number`), como ya decidió el
  §10.2 del diseño del motor: no se crea un contador nuevo que se pueda desincronizar.
* El `id` de la operación y el `opId` de negocio son **dos cosas distintas** y las dos son
  necesarias (§1.2).

### 1.2 Clave de negocio: el corazón de la idempotencia

Dentro del `payload`, además de la **clave del motor** (`deviceId_installId_secuencia4`, que
garantiza que dos equipos nunca chocan en la ruta), cada movimiento lleva `opId`: la **clave de
negocio determinista** que identifica *el hecho*. Repetir la misma acción produce el mismo `opId`;
la misma clave de negocio = el mismo movimiento = **un solo asiento en la suma**.

| Tipo | `opId` (clave de negocio) | Se repite cuando… |
|---|---|---|
| `inicial` | `MIG-<productoId>` | se reintenta o se repite la migración |
| `venta` | `M-V-<ventaId>` | se reintenta cobrar / reencolar la misma venta |
| `anulacion` | `M-A-<movimientoAnulado>` | se reintenta anular la misma venta |
| `ajuste` | `M-AJ-<productoId>-<sello>` | el operador repite el mismo ajuste con el mismo sello |
| `compra` | `M-C-<compraId>-<productoId>` | se reintenta registrar la misma línea de compra |
| `cierre` | `CIE-<periodo>-<productoId>` | se reintenta cerrar el mismo periodo |

Ejemplo de venta:

```
venta  V-LOCAL-7K3F9QAB-0031
  -> opId  M-V-V-LOCAL-7K3F9QAB-0031     (clave de negocio, dentro de payload)
  -> nodo  ops/movimiento/7K3F9QAB_K7M2_0031   (clave del motor, es la ruta)
```

Ojo con la diferencia entre las dos claves, porque es la que sostiene todo el modelo:

* **`opId`** evita el **doble conteo** del mismo hecho (idempotencia de negocio).
* **`deviceId_installId_secuencia4`** evita la **colisión** entre dos equipos que producen hechos
  distintos (idempotencia de transporte). Si solo hubiera `opId` en la ruta, dos equipos con el
  mismo `deviceId` (respaldo restaurado) chocarían — es el riesgo §11.7 del diseño del motor, ya
  cerrado con `installId`.

**Consecuencia de implementación que la auditoría destapó (importante).** El motor NO deduplica por
`opId`: `registrarOperacion()` reserva una secuencia nueva y escribe un nodo NUEVO cada vez que se le
llama. Si se llama dos veces por la misma venta, quedan **dos nodos** con la misma clave de negocio y
el stock se descuenta dos veces. La idempotencia de negocio hay que **aportarla** antes de llamar al
motor:

* El equipo mantiene un índice local `opId -> nodo` de los movimientos que ya conoce (propios y
  bajados). Antes de registrar, si el `opId` ya está en el índice, **no se registra nada** y se
  devuelve el movimiento que ya había.
* El cálculo de stock (§2) **también** deduplica por `opId` para los tipos que son "el mismo hecho"
  (`inicial` y `cierre`): agrupa por clave y, si difieren, toma el **menor** y lo delata. Así, aunque
  dos equipos escriban cada uno su nodo, el resultado **converge** (no depende del orden, que es el
  requisito del §2).
* Los tipos que se pueden repetir legítimamente en un día (`venta`, `compra`, `ajuste`) no se
  agrupan: su `opId` ya es único por hecho, y si por un bug se repitiera, el índice local lo corta
  antes de escribir.

### 1.3 Tabla de tipos de movimiento

`cantidad` siempre se guarda **con signo**: positivo = entra, negativo = sale. Es la única regla de
signo; no hay "tipo de operación aritmética" aparte.

| `tipoMov` | `cantidad` | Quién lo produce | Campos propios | Notas |
|---|---|---|---|---|
| `inicial` | saldo de apertura (≥ 0) | la **migración** del stock clásico (§6), una sola vez por producto | `nota` | Si hay varios `inicial` para el mismo producto (dos equipos migraron), la suma toma **el menor** y lo delata (§6.4) |
| `venta` | negativo (`-cantidad` vendida) | el POS al cobrar, **derivado** de la operación `venta` | `ref` = `id` de la venta | No se teclea: se calcula del carrito. Un producto vendido = un movimiento |
| `anulacion` | positivo (devuelve lo vendido) | devolución/anulación de una venta | `anulaA` = `id` del movimiento anulado, `ref` = venta | Nunca borra el original (§1.1) |
| `ajuste` | delta, cualquiera de los dos signos | `inventario.html` (conteo físico, merma, rotura, corrección) | `nota` obligatoria, `sello` | Un "poner 30" se convierte en `30 - stockCalculado` (§1.4) |
| `compra` | positivo | `compras.html` al recibir una compra | `ref` = `id` de la compra + línea | Una compra de 3 productos = 3 movimientos; `opId` = `M-C-<compraId>-<productoId>` |
| `cierre` | delta del cierre (ver §4) | el equipo que cierra el periodo | `periodo`, `saldoContado` | **No** es un `set` de saldo: es la diferencia contra el saldo base vigente |

### 1.4 El ajuste manual: delta hoy, delta con movimientos

`inventario.html` **ya pide una cantidad a sumar o restar** (un delta), no un valor absoluto:

```js
// inventario.html ~L2018: title="Cantidad a sumar o restar del stock actual."
// inventario.html ~L4269:
const newStock = product.stock + quantity;
```

O sea: el camino actual **ya es un delta**. El único cambio es de dónde sale el stock base:

* **Antes**: `producto.stock` (el número compartido que se pisa).
* **Ahora**: el stock **calculado** de la suma de movimientos del equipo.

```
cantidadAjuste = lo que el operador teclea (delta, con signo)   // igual que hoy
```

Y la UI pasa a mostrar el stock calculado en vez del número guardado. El movimiento se fecha en el
instante en que se aplica.

Si algún día una página clásica (o un cliente viejo) manda un **valor absoluto** en el arreglo de
productos, ese `stock` **no** se aplica como número (§9.1): si trae `camposMtime.stock` posterior al
último movimiento, se convierte en un movimiento `ajuste` con `cantidad = valorRecibido -
stockCalculado`; si no, se ignora. Esa conversión **no está probada** por el simulador (`T4` prueba
el delta, que es el camino real) y es una de las cosas a implementar con cuidado.

**Debilidad conocida** (ver §11.2): si dos equipos ajustan por conteo a la vez, cada uno calcula su
delta desde *su* stock y los dos deltas se suman. El resultado es la suma de las dos correcciones.

---

## 2. La verdad es la suma

```
stock(p) = saldoBase(p) + Σ cantidad(m)  para todo m de p no cubierto por el saldo base

saldoBase(p) = MENOR(cantidad de los `inicial` de p)   // 0 si no hay
             + Σ cantidad de los `cierre` de p

cada paso de la suma se redondea a 3 decimales (§2.1)
```

Propiedades que hacen que esto resuelva el problema:

1. **Conmutativa**: el orden de llegada no cambia el resultado. Un movimiento que llega tarde o
   fuera de orden cuadra igual (probado en `T9`).
2. **Sin campo compartido que pisar**: dos ventas simultáneas son dos claves distintas y **las dos
   quedan** (probado en `T1`).
3. **Reconstruible**: el stock se puede recalcular entero desde el log, sin depender de ningún
   equipo. `producto.stock` es solo un atajo de lectura.

### 2.1 Decimales (productos a granel)

El POS vende a granel con **3 decimales** (`mini_market_pos.html`: `item.quantity =
parseFloat(newQuantity.toFixed(3))`, ~línea 2960; cantidades de `0.001` en los botones +/−). Sumar
decimales en coma flotante **acumula error**:

```
10 + (-0.1) + (-0.1) + (-0.1)  =  9.700000000000001     // ⚠ no es 9.7
```

Regla del motor: **cada paso de la suma se redondea a 3 decimales** (`Math.round(n * 1000) / 1000`),
que es exactamente la precisión que el POS admite. Así `9.7` es `9.7` y el stock de un producto a
granel no se compara nunca contra un número con basura en el decimal 15. El simulador lo comprueba
(`T4`, parte "a granel"). Si algún día se admite más precisión (por ejemplo 4 decimales para
líquidos), hay que cambiarlo **en un solo sitio** y versionar el formato (`version: 2`), porque si
no, dos equipos con redondeos distintos calcularían stocks distintos.

### 2.2 El problema del stock negativo

La suma **puede dar negativo**. Hay que decidir qué se hace, porque las dos opciones son legítimas:

* **No truncar nunca** (recomendado). Un stock negativo es información valiosa: significa que este
  equipo vendió (o va a vender) sin tener constancia del stock real, el caso exacto de dos equipos
  sin conexión. En el simulador (`T1`) el equipo B ve **−4** porque aún **no ha bajado el
  `inicial`**: su saldo base es 0 y solo conoce su propia venta de 4. Una vez sincroniza, ve 3, igual
  que A. Truncar a 0 escondería ese estado intermedio y haría que la suma no cuadre con los hechos
  (además de que el estado intermedio *es* la señal de "me faltan datos de otros equipos").
* Truncar a 0 en la **presentación** (lo que hace hoy el POS, `if (stock < 0) stock = 0`), dejando
  la suma intacta.

Este diseño exige: **el cálculo nunca trunca; la pantalla puede avisar**. Si el operador ve un
número negativo, es que hay movimientos sin sincronizar de otro equipo y **debe** verlo.

Aviso relacionado con el §9: hoy el POS sube el arreglo completo con el stock **ya truncado**
(`mini_market_pos.html` ~L4410-4411: `if (inventory[index].stock < 0) inventory[index].stock = 0`
antes de `fbSaveProductos`, ~L4425). En modo operaciones esa caché truncada no puede ser la fuente
de verdad: el número que se publica debe ser el calculado, y el signo se conserva.

---

## 3. Idempotencia y doble conteo (con precisión)

Seis mecanismos, cada uno cubriendo un camino distinto:

| # | Situación | Qué lo evita | Comprobado |
|---|---|---|---|
| 1 | **Reintento de subida** (reconexión, doble disparador `online`+60 s) | La clave del motor es la ruta: el segundo `set()` sobre la misma clave con el mismo contenido no cambia nada. El motor lo detecta en el reintento y marca `subida` sin reescribir (§1.4 y desviación 2 de `motor_operaciones.js`) | `T2` |
| 2 | **La misma acción repetida por la app** (se vuelve a llamar a `registrarMovimiento` con la misma venta) | La **cola** ya tiene una entrada con ese `opId` (o el log local ya tiene ese movimiento): devuelve `duplicada:true` y **no** crea otra operación | `T2` |
| 3 | **Venta reenviada desde otro equipo** (dos cajas cobran con el mismo `ventaId`, p. ej. ids copiados) | La clave de negocio `M-V-<ventaId>` es la misma, pero la ruta no (distinto `deviceId`): quedan **dos nodos**. Se detecta como `referencias repetidas` y **`conflicto de clave`** (misma clave de negocio, contenido distinto) y se avisa. **No** se puede resolver solo: hay que enseñarlo | `T3` |
| 4 | **Venta anulada** | La anulación es un movimiento **nuevo** (+n) que **no** borra el original (−n): el neto vuelve al valor correcto y el histórico conserva los dos hechos. Anular dos veces la misma venta da el mismo `opId` → no se aplica dos veces | `T3` |
| 5 | **Doble conteo del saldo base** | Un movimiento **cubierto por un cierre** (su `periodo` ya está cerrado) no se vuelve a sumar (§4) | `T5` |
| 6 | **Migración repetida** | El `inicial` tiene clave determinista `MIG-<productoId>`: dos intentos no crean dos. Dos equipos sí crean dos nodos, pero con la **misma clave de negocio** → la suma toma el **menor** y lo delata | `T6` |

### 3.1 Movimientos que llegan tarde o fuera de orden

El orden total `(fechaISO, secuencia, deviceId)` sirve para **leer** (presentación, trazabilidad),
no para calcular: la suma es conmutativa. Un movimiento con fecha anterior a otros ya aplicados se
suma igual y el total no cambia (`T9`).

**La excepción es el cierre**, que sí depende del tiempo: un movimiento que pertenece a un periodo
**ya cerrado** y que llega **después** del cierre queda absorbido por el saldo base y **se pierde**
de la suma. Es el precio de que el cálculo esté acotado. Medidas (§11.1):

* Un cierre solo se escribe cuando el equipo **sabe** que no queda nada pendiente de ese periodo:
  la cola local está vacía para ese producto (`hayPendientes()` del motor) y, si hay nube, se
  espera a haber bajado `ops/movimiento` del periodo.
* Se registra en el `cierre` la **lista de nodos incluidos** (o, si es grande, el `deviceId` y el
  máximo `(fechaISO, secuencia)` por equipo). El cálculo excluye por rango, y un movimiento
  posterior con fecha dentro del rango **sí se suma**. Es la corrección que convierte "se pierde"
  en "se suma siempre".
* Los movimientos que lleguen tarde y caigan en un periodo cerrado se marcan en el diagnóstico
  (`fueraDeCierre`) para que el dueño vea que hubo una venta que no entró en el conteo.

---

## 4. Cota del cálculo: cierre / snapshot

### 4.1 Por qué hace falta

`venta` es el movimiento más frecuente. Estimación con números de un minimarket:

| Concepto | Valor |
|---|---|
| Productos | 1 000 |
| Ventas/día | 300 |
| Líneas por venta | 2 → **600 movimientos `venta`/día** |
| Movimientos por producto y año | ~220 |
| Nodo de movimiento en RTDB | ~150–250 B |
| **`ops/movimiento` al año** | ~200 000 nodos ≈ **40–50 MB** |

En la nube el crecimiento es lineal y no se borra nunca (append-only): en 5 años, ~1,2 M de nodos.
Un equipo nuevo que tenga que sumar todo eso para pintar el inventario tarda segundos y gasta
tráfico. La ventana caliente de 30 días del motor **no ayuda aquí**: el stock necesita *todo* el
histórico, no 30 días (es justo el problema que el diseño del motor no resuelve).

### 4.2 La política: un cierre por producto y periodo

Un **`cierre`** es un movimiento más, con clave determinista `CIE-<periodo>-<productoId>`, que fija
el saldo base del producto para el periodo cerrado. Como el stock es una **suma**, el cierre **no
lleva el saldo absoluto** (el `inicial` y los cierres anteriores ya están en la suma: se contarían
dos veces). Lleva el **delta** necesario para que la suma acumulada coincida con el saldo contado:

```
cantidadCierre = saldoContado(periodo) - saldoBaseAntesDelCierre
saldoBaseAntesDelCierre = MENOR(inicial) + Σ cierres anteriores
```

Ejemplo (escenario `T5`): `inicial 10 + compra 20 - 12 ventas = 18` al cerrar febrero.
`saldoBaseAntes = 10`, luego `cantidadCierre = 18 - 10 = 8`. Tras el cierre:

```
saldoBase = 10 (inicial) + 8 (cierre) = 18     // stock correcto
movimientos a recorrer: los 13 del periodo ya NO se suman
```

Y el cálculo para un movimiento posterior es `18 + Σ posteriores`.

Consecuencia práctica: **los nodos no se borran** (append-only, el log sigue entero para auditoría),
pero el cálculo deja de recorrerlos. `sumarStock` pasa de `O(todos los movimientos)` a
`O(movimientos desde el último cierre)`. Con cierre **mensual** (la política recomendada) eso son
los movimientos del mes en curso: para un producto concreto, ~20 al mes. Si en cambio se usa el
disparador por umbral (N = 500 movimientos sin cierre), con ~220 movimientos por producto y año el
tope real es **~2 años y 3 meses**, no 12 meses: el número "12 meses" solo se cumple con el cierre
mensual. Las dos cifras son cotas de *aritmética*, no de *transferencia*: ver §4.5.

### 4.3 Quién y cuándo escribe el cierre

| Pregunta | Decisión |
|---|---|
| **¿Quién?** | **Un solo equipo**: el que abre el periodo (el primer arranque del mes) o, si se quiere control manual, el equipo del dueño desde el panel de inventario. Ser el único que escribe el `inicial` y el `cierre` de un periodo es lo que evita la duplicación (§6.4) |
| **¿Cuándo?** | Al abrir un **periodo nuevo** (mes), si el anterior tiene movimientos sin cerrar; o cuando el producto acumula más de **N movimientos sin cierre** (N = 500 propuesto) para los negocios que no cierran por mes |
| **¿Bloquea?** | **No.** El cierre se calcula en segundo plano: la venta nunca espera a un cierre. Mientras no exista, el cálculo simplemente recorre más movimientos (funciona igual, solo más lento) |
| **¿Idempotencia?** | Clave de negocio `CIE-<periodo>-<productoId>`. **Si dos equipos cierran el mismo periodo**, el segundo ya conoce el cierre del primero (lo ha bajado) y **no escribe el suyo**: gana la idempotencia de negocio. Si aun así llegaran a existir dos nodos (cierre escrito a la vez, sin verse), el cálculo **agrupa por clave de negocio y cuenta uno solo** (el menor) y lo marca en el diagnóstico: el resultado no depende del orden, así que los dos equipos convergen. Lo que **no** se hace nunca es sumar los dos |
| **¿Y si el saldo calculado difiere del contado?** | El cierre guarda `payload.saldoContado` y el `payload.cantidad` (el delta) derivado. Si el delta deja el stock calculado lejos del contado, o si hay dos cierres discrepantes, es un aviso para el dueño (puede ser merma no registrada o un producto que se vendió sin descontar) |
| **¿Y si cierro el mismo periodo dos veces?** | **No cambia nada**: la clave de negocio es la misma. Si entre los dos cierres entraron movimientos, esos movimientos pasan a ser *posteriores al saldo base* y **se suman** (el saldo base no se toca). Es el comportamiento correcto: el saldo base es una foto, no un acumulador |
| **¿Quién calcula el delta?** | **El motor, no la página.** La página dice "cierra `producto` en `periodo` con saldo contado X"; el motor calcula `cantidadCierre = X - saldoBaseVigente` con el saldo base que él conoce y escribe el `cierre`. La página **no** calcula el delta: si lo calculara mal, el error entra en el log (append-only) y descuadra el stock para siempre. En el caso normal `X` es el stock calculado del momento (recalcular stock = cerrar), y en un conteo físico `X` es lo que contó el operador |

**Tensión interna que la auditoría señaló (y cómo se resuelve):** el §1.4 dice que el **operador**
teclea el delta del ajuste y el §4.3 dice que la **página no** debe calcular el delta del cierre.
No es contradicción: en el ajuste el delta **es** el dato que aporta la persona (cuánto se rompió,
cuánto apareció); en el cierre el delta es un **derivado** (`contado − saldo base`) que la página no
puede conocer con garantías, porque el saldo base lo manda el motor. Regla: **la página aporta
observaciones (un delta tecleado o un saldo contado); el motor deriva deltas.**

### 4.4 Coste de lectura esperado (aritmética)

| Operación | Antes (sin cierres) | Con cierre mensual |
|---|---|---|
| Stock de un producto | recorrer todos sus movimientos (miles) | saldo base + movimientos del mes en curso |
| Inventario completo (1 000 productos) | ~200 000 nodos | ~1 000 `inicial` + cierres + movimientos del mes (~18 000) |

### 4.5 El problema GRAVE del §4.4: la transferencia, no la aritmética

**Hallazgo de la auditoría independiente, el más serio de todo el diseño.** La clave de la ruta
`ops/movimiento/<deviceId>_<installId>_<secuencia4>` **no contiene ni el producto ni la fecha**, y
en RTDB no se puede consultar por campos internos del valor sin un índice. Las únicas consultas que
el motor hace hoy son `orderByKey().limitToLast(1)` por `deviceId` (`motor_operaciones.js` ~L1646) y
`orderByChild('timestamp')` sobre el histórico **congelado** de ventas (~L1557). Conclusión:

* El ahorro del cierre es de **CPU local**, no de **tráfico**: para saber el stock de un producto,
  un equipo nuevo (o uno que vuelve de un viaje) tendría que descargar `ops/movimiento` **entero** y
  filtrar en memoria. Con ~200 000 nodos al año eso es inaceptable.
* El «`leerMovimientos(productoId, desde)` análogo a `leerVentas()`» que proponía el §8 (a) **no
  sirve**: `leerVentas()` del motor es un lector **local** de la ventana caliente de 30 días
  (`motor_operaciones.js` ~L1506-1521), no una consulta a la nube.
* Por tanto el §4.4 y el §7.3 («el equipo nuevo descarga el saldo base y el mes en curso») **no son
  alcanzables tal cual**.

**Solución obligatoria (sin diseñar del todo, y sin implementar):** un índice derivado, igual que el
`ventas_idx` del §2 del diseño del motor, pero por producto y periodo:

```
BBDD/<emailPath>/movimientos_idx/<productoId>/<AAAA-MM>/<claveOperacion> = { "cantidad": -3, "tipoMov": "venta" }
```

* Se escribe **después** de confirmar la operación (nunca antes) y con la misma clave que la
  operación, así que es idempotente.
* Permite bajar **solo** los movimientos de un producto y de un periodo, que es lo que hacen falta
  para calcular un stock y para cerrar.
* **Nunca es fuente de verdad**: si falta, está viejo o discrepa, se reconstruye desde
  `ops/movimiento/*` (con el mismo criterio que el §2 del diseño del motor: se detecta por claves
  faltantes, no por recuentos).
* El saldo base (`inicial` + últimos cierres) se lee de un nodo aparte por producto
  (`stock_base/<productoId>`), que es diminuto y se puede cachear entero en el equipo.

Queda **abierto**: el tamaño del índice (una entrada por movimiento: mismo orden que el log, no lo
reduce), si conviene una entrada **agregada** por producto y periodo (un solo nodo con la suma) en
vez de una por movimiento, y quién lo mantiene (el equipo que sube, como `ventas_idx`).

### 4.6 Leer el stock en el equipo (lo que sí funciona sin nube)

Para no depender de la nube en cada venta, el equipo mantiene un **saldo base local** por producto
(`caliente/saldos.json`: `inicial` + cierres + resumen del último periodo cerrado) y, encima, los
movimientos de la ventana caliente (30 días). El stock que se muestra es
`saldoBaseLocal + Σ movimientos locales no cubiertos`, que es correcto para vender sin conexión. El
índice del §4.5 solo hace falta para **traer** el histórico de otro equipo o de otro periodo.

Además, el equipo mantiene un **saldo base local** por producto (`caliente/saldos.json`: `inicial` +
cierres + resumen del último periodo) para no releer la nube en cada venta.

---

## 5. Modo clásico: nada cambia

Regla dura, heredada del §8 del diseño del motor: **ante duda, clásico; nunca al revés**.

| Situación | Comportamiento |
|---|---|
| `suscripcion/modoSync` ausente, `'clasico'`, `false`, un número, un texto raro o error de lectura | **Comportamiento de hoy**: el stock es el número del producto y se sube con el arreglo completo. El motor no arranca, no toca disco, no lee la red, no crea `ops/movimiento` (probado en `T7`) |
| `modoSync = 'operaciones'` y `cloudSync = true` | Motor de movimientos + nube. Los movimientos se encolan y se suben |
| `modoSync = 'operaciones'` y `cloudSync = false` (o ausente) | **Plan local**: los movimientos se acumulan **solo en el equipo** (cola durable + `caliente/movimientos.jsonl`), el stock se calcula bien y **no se escribe nada** en la nube (`T8`). El día que se active la nube, la cola se vacía sola |
| Módulo ausente (página que no carga `motor_operaciones.js`) | Igual que hoy: no hay movimientos, el stock sigue siendo el número |
| `modoSync` cambia a `'operaciones'` **después** de vender en clásico | Las ventas clásicas están en `ventas/historial` y en el `stock` del producto. El paso de **siembra** (§11.4) las convierte en movimientos; hasta entonces el `inicial` congela el stock actual y las ventas viejas no cuentan para el stock (sí para los reportes) |
| Volver de `'operaciones'` a `'clasico'` | La nube no se toca. Las páginas clásicas leen `ventas/historial` y `producto.stock` (que el modo operaciones mantiene **regenerado** como caché, §9). No se pierde nada |

---

## 6. Migración del stock actual

El `stock` que existe hoy en cada producto pasa a ser **un movimiento `inicial`**, creado **una sola
vez** por producto.

### 6.1 Cómo se hace, sin perder ni duplicar

1. **Requiere un solo escritor.** La migración la hace **un único equipo** (el que tenga la marca de
   dueño, o el primero que arranque con `modoSync='operaciones'` y no encuentre ningún `inicial`
   en la nube). No se puede hacer en paralelo desde dos equipos con stocks distintos (§6.4).
2. Se lee el catálogo local (`ciervo_inventory`) tal cual está y se escribe **un** movimiento:

```json
{
  "tipo": "movimiento",
  "payload": {
    "opId": "MIG-P-HARINA-PAN",
    "productoId": "P-HARINA-PAN",
    "tipoMov": "inicial",
    "cantidad": 10,
    "nota": "saldo de apertura (migración del stock clásico)"
  }
}
```

3. **No se borra ni se limpia nada** el día de la migración. El campo `producto.stock` sigue donde
   está y se sigue usando como caché de presentación: si algo falla, el modo clásico sigue
   funcionando con su número intacto. **Cero pérdida por construcción**: la migración solo añade.
4. La migración es **idempotente por el `opId`**: si se repite (la página se recarga a mitad, el
   usuario pulsa dos veces, el `set()` se reintenta), el segundo intento encuentra la clave y no
   crea nada (`T6.a`).
5. Se marca en el equipo `stock_migrado = <hash del catálogo>` para no repetir el barrido en cada
   carga. Es un atajo de velocidad, **no** la garantía: la garantía es la clave del `inicial`, así
   que un equipo que pierda esa marca vuelve a intentarlo y no pasa nada.

### 6.2 Si un equipo se migra dos veces

Nada. Mismo `opId`, mismo nodo, un solo asiento (`T6.a`). Y si el equipo **reintenta con otro
stock** (porque vendió algo entre los dos intentos): el `opId` es el mismo, así que choca con el
nodo ya escrito; el motor lo ve como contenido distinto y lo marca **`conflicto`** en vez de
sobrescribir (§1.4 del motor). El operador ve el conflicto y decide. Nunca se aplican los dos.

### 6.3 Si dos equipos migran el mismo producto

* **Con el mismo stock** (lo normal: el catálogo bajo de la nube, nadie vendió): dos nodos, **una
  sola clave de negocio** `MIG-<producto>`. La suma **no duplica**: los `inicial` se agrupan por
  clave de negocio y se toma **el menor** (10, no 20). El duplicado queda marcado en el
  diagnóstico (`inicialesDuplicados`, `T6.b`).
* **Con stocks distintos** (cada equipo vendió sin conexión antes de migrar): los dos `inicial`
  discrepan. Se toma **el menor** (nunca infla; subestimar es reversible con un `ajuste`, inflar no)
  y se avisa con el detalle para que el dueño corrija con **un** `ajuste` manual (`T6.c`).

**Decisión de producto pedida:** lo correcto es que la migración **se coordine** (un solo equipo, o
una marca en la nube `stock/migracion = { equipo, fechaISO }` que el resto respeta). El
comportamiento por defecto (menor + aviso) es la red de seguridad, no el plan.

### 6.4 Por qué el `inicial` no puede ser "el stock que veo ahora"

Porque el stock que ve cada equipo es distinto justo en el caso que queremos arreglar. La regla es:
**el `inicial` congela un instante acordado** (la fecha de activación del modo operaciones), no "lo
que hay ahora". Si dos equipos no pueden acordar el instante, el diseño elige el menor y avisa.

---

## 7. Offline: qué ve el operador y cómo no vende de más

### 7.1 Qué calcula y qué ve

* Mientras no hay red, el equipo calcula el stock con **sus** movimientos locales (cola +
  `caliente/movimientos.jsonl`) más el **saldo base** que ya tenía. Es un stock **provisional**: le
  faltan los movimientos de los otros equipos.
* La pantalla debe distinguirlo, porque si no, el operador cree que un `-4` es un error de la app:

```
Harina PAN 1kg
   stock  7  (provisional)        <- ámbar, con los movimientos que faltan por confirmar
   stock 12  (confirmado)         <- gris, el último valor con todo sincronizado
   ⚠ 2 operaciones sin subir (última hace 3 h)
```

* El punto de estado del header (el que ya existe en el diseño del motor, §10.3) refleja la cola:
  verde = cola vacía, ámbar = pendientes, rojo = fallo o conflicto.

### 7.2 Cómo se evita vender de más

No se puede impedir del todo (vender sin conexión es el requisito), así que la estrategia es
**avisar y degradar**, nunca bloquear:

1. **Aviso de stock provisional** en cuanto hay cola pendiente que afecte al producto.
2. **Stock "teórico" del equipo** (sin contar lo que otros pudieran haber vendido) y
   **stock "peor caso"** (restando los pendientes de subir). Si el peor caso llega a 0, el POS
   muestra un aviso destacado en la línea del carrito ("este equipo ya no tiene constancia de
   stock") y **permite cobrar** con confirmación explícita del operador.
3. **Prohibición de vender en negativo silenciosa nunca**: hoy el POS recorta a 0
   (`if (stock < 0) stock = 0`); con movimientos, el signo se conserva y el negativo se muestra.
4. **Sugerencia de no operar sin conexión** si `navigator.storage.persisted() === false` y hay
   muchos pendientes (el riesgo de purga de iOS del §11.2 del motor), pero sin bloquear la venta.

### 7.3 La convergencia al reconectar

1. Al volver la red, el equipo **sube su cola en orden** (motor E1, §5).
2. **Baja** `ops/movimiento` del periodo y de los 30 días que falten, y **funde por nodo**: los que
   ya tenía no se vuelven a sumar.
3. Recalcula el stock (suma conmutativa) → los dos equipos llegan al **mismo** número
   (`T1`).
4. Avisa de los **descuadres** (`conflictosDeClave`, `referenciasRepetidas`) y de los productos que
   hayan quedado en negativo, para que el dueño ajuste.

---

## 8. Compatibilidad con lo ya hecho

| Pieza existente | Qué pasa |
|---|---|
| `motor_operaciones.js` (E1) | **Se reutiliza tal cual** el sobre, la ruta, la cola, la ventana caliente y `registrarOperacion('movimiento', payload)`: el tipo `movimiento` ya está en `TIPOS` y ya va al log caliente. Los campos de negocio van **dentro del payload** (§1.1), así que no hay que tocar el sobre. **Ampliar (esto sí es código nuevo):** (a) `leerMovimientos(productoId, periodo)` que consulte el **índice** de §4.5 (no basta copiar `leerVentas()`, que es un lector local de 30 días); (b) `leerSaldosBase()`; (c) que la liberación de 30 días **no** se lleve los `inicial`/`cierre` (§11.3); (d) un índice local `opId -> nodo` para no registrar dos veces el mismo hecho (§1.2) |
| Ventana caliente de 30 días | Se aplica igual. **Ojo**: los `inicial` y `cierre` **no** son "calientes", son el saldo base: hay que conservarlos **siempre** (son pocos: 1 por producto + 1 por producto y periodo) y liberar solo las ventas/ajustes viejos |
| `lector_ventas.js` (E2) | **No se toca**: une el histórico congelado con `ops/venta`. El stock no pasa por ahí (los reportes de ventas no cambian). **Ampliar (opcional):** una vista de movimientos para el informe de inventario |
| **`inventario.html`** | **Hoy NO carga `motor_operaciones.js` ni lee `modoSync`.** Es el productor natural de los movimientos `ajuste` (§1.4) y quien pinta el stock: si no se toca, en modo operaciones sus correcciones **no generan movimiento** (la suma nunca las ve) y su `firebaseSaveProducts(products)` (~L2968-2986) sigue subiendo el arreglo completo con el `stock` que tenga. **Hay que migrarla** en la fase de implementación: cargar el motor, leer el `stock` calculado y registrar `ajuste` en vez de escribir el número |
| **`compras.html`** | Igual: **no carga el motor** y hace `stock += item.quantity` + `set()` del arreglo completo (~L2413-2417, L2973, L3013/3021). Sin migrarla, **el movimiento `compra` no existe** y las entradas de mercancía se pierden para la suma |
| **`catalogo.html`** | Igual: guarda productos con el arreglo completo (~L786-794, L839/L1025) y **no carga el motor**. Ni siquiera figuraba en el Ámbito del §0 de este documento: **hay que incluirlo** |
| **`mini_market_pos.html`** | El POS es el productor de los movimientos `venta` (derivados del cobro) y de la caché de presentación. Hoy `updateInventory()` (~L4403) no tiene puerta de modo, recorta a 0 (~L4410-4411) y sube el arreglo completo (~L4425). **Hay que:** no crear movimientos ahí (los crea el cobro, una vez), no truncar el cálculo y no publicar la caché truncada |
| `mergeInventoryWithLocal` (POS, ~L5432) | Propaga el `stock` de la nube sin mirarlo (`...fbProd`). En modo operaciones **no puede seguir haciéndolo tal cual**: el `stock` que llega es caché y se sustituye por el calculado (§9.1) |
| Política de 1 GB (`almacenamiento.js`) | Se hereda, pero hay que **ampliarla en dos sentidos**: (a) `aplicarPoliticaAlmacenamiento` recorta por antigüedad y **no puede recortar un `inicial` ni un `cierre`** (son el saldo base; los movimientos viejos sí, **solo si** existe un `cierre` posterior que los cubra); y (b) **hoy no mide OPFS**: `medirTodoAsync` = `medirAlmacenamiento()` (solo `localStorage`, ~L292-315) + `tamanoHistorial()` (solo IndexedDB), así que la cola y `caliente/` **no cuentan** para el «% de tu límite» que ve el dueño, y `puedeTocarArchivoLocal` devuelve PERMITIDO justo con nube + modo operaciones (~L1663-1668). El % que se muestra es **falso** y el límite efectivo no existe: hay que medir `navigator.storage.estimate()`/OPFS antes de dar esta política por buena |
| Respaldo/restauración (`almacenamiento.js`) | `CLAVES_NEGOCIO` (~L61-87) **no incluye** OPFS: la cola, `caliente/` y los movimientos locales **no están en el respaldo `.json`**. Tres problemas concretos: (a) con `cloudSync = false` (plan local, §5) **no hay nube** desde la que reconstruir: perder OPFS es perder **todos** los movimientos, y `ciervo_inventory.stock` (que sí se respalda) seguiría mostrando números; (b) `pos_last_sale_number` **sí** está en `CLAVES_NEGOCIO` (~L68) y `restaurarRespaldo` escribe con `localStorage.setItem` (~L718-721): restaurar un respaldo viejo **retrocede el contador**, el motor reutiliza claves de nodo ya escritas y §1.4 responde `conflicto` → los movimientos nuevos **nunca llegan a la nube**; la mitigación ya existe (`reservarSecuenciaDesdeNube()`) pero está **desactivada**: solo corre con `opciones.reservarSecuencia === true` (`motor_operaciones.js` ~L1347) y el POS no la pasa (`mini_market_pos.html` ~L5082-5089). **Hay que:** respaldar `inicial`/`cierre` vigentes + la cola, y activar la reserva de secuencia al arrancar. (c) restaurar **no** debe pisar OPFS |
| Aislamiento por cuenta (`datos_cuenta.js`) | Intercepta `Storage.prototype`: **solo cubre `localStorage`/`sessionStorage`** (solo actúa si `almacen === window.localStorage`, ~L161-165), no OPFS. Los datos del motor viven en `navigator.storage.getDirectory()` con nombres pelados (`cola.jsonl`, `caliente/movimientos.jsonl`) → **hoy no están aislados por cuenta**, y `limpiarCuenta` (~L402) tampoco limpia OPFS. **Hallazgo, hay que arreglarlo**: el directorio raíz de OPFS del motor debe llevar el `emailPath` (p. ej. `cuenta/<emailPath>/cola.jsonl`), o `datos_cuenta.js` debe exponer un prefijo que `motor_operaciones.js` consulte. Sin esto, la cuenta B puede subir la cola de la cuenta A a `BBDD/<emailPathB>` (la ruta se arma con `_emailPath` **en el momento de subir**) |
| `sincronizacion.js` (marcas de Fase A) | Igual que en el diseño del motor (§10.1): las marcas por módulo quedan subordinadas a la cola. `puedeSobrescribirLocalSync()` sigue devolviendo `false` mientras haya pendientes |
| `camposMtime` (merge por campo, §7.2 del motor) | **Hallazgo de la auditoría: HOY NO LO ESCRIBE NINGUNA PÁGINA.** El único sitio donde aparece es `motor_operaciones.js` (~L836/L845). El §9.1 se apoya en él para distinguir «un ajuste clásico de verdad» de «una caché vieja», así que **mientras ninguna página escriba `camposMtime.stock`, la fila «se convierte en un `ajuste`» no se puede aplicar** y esas correcciones se descartarían en silencio. Es trabajo obligatorio de la fase de implementación |
| `stockHistory` / `priceHistory` de los productos | **No se tiran.** Son historiales locales de presentación (se muestran en el modal de inventario). El movimiento es la fuente de verdad; `stockHistory` se puede seguir rellenando como caché local o dejar de usarse. Decisión: **se conserva durante la convivencia y se deja de escribir** cuando el modo operaciones esté validado |
| Reglas de Firebase | El nodo `ops/*` ya está cubierto por las reglas por dueño. **No hace falta cambiarlas** (y el encargo prohíbe tocarlas). Convendría un `.validate` de `tipoMov`/`cantidad`, pendiente |

---

## 9. Convivencia con el modelo clásico de productos

Mientras el catálogo y los precios sigan por el camino clásico (arreglo completo), el problema es
evidente: **el arreglo completo lleva dentro `producto.stock`**, así que una escritura clásica
(vieja, de una página no migrada o de otro equipo) puede machacar el stock calculado.

### 9.1 La regla exacta (y DÓNDE se aplica, que es lo que faltaba)

> **En `modoSync = 'operaciones'`, el campo `producto.stock` es de SOLO LECTURA.
> Ninguna escritura clásica de productos puede aplicarlo. El único que escribe `producto.stock` es
> el recalculador de caché (§9.2), y siempre con el valor de la suma.**

Formalmente, al aplicar (subir o bajar) un producto en modo operaciones:

```
stockRecibido  := producto.stock del arreglo clásico
producto.stock := stockCalculadoPorMovimientos(producto.id)     // se IGNORA stockRecibido
```

**Punto de aplicación (obligatorio, hoy NO existe).** La regla no se puede aplicar «en general»: hay
que ponerla en el **único camino** por el que hoy se escribe el stock, y ese camino está duplicado en
tres páginas. La propuesta concreta es una función compartida en el motor y sustituir las llamadas:

| Hoy | Dónde | Qué debe pasar en modo operaciones |
|---|---|---|
| `fbSaveProductos(data)` (POS, ~L5414) | POS → `set()` del arreglo completo | Envolver: si el motor está activo, **sanear** el arreglo (reemplazar cada `stock` por el calculado y poner `stockMtime`) antes del `set()`, o no subirlo si no cambió nada más |
| `firebaseSaveProducts(products)` | `inventario.html` (~L2968-2986), `catalogo.html` (~L786-794) | Lo mismo; y el ajuste manual de inventario debe registrarse como movimiento `ajuste` |
| `set()` del arreglo en `compras.html` (~L2413-2417) | recepción de compra | Convertir el `stock += item.quantity` en un movimiento `compra` |
| `mergeInventoryWithLocal` (POS, ~L5432) | bajada de productos | Sustituir el `stock` recibido por el calculado antes de guardar en `localStorage` |

Mientras eso no esté hecho, el modo operaciones **no se puede activar** sin descuadrar el stock. Es
la conclusión más importante de la auditoría: el diseño tenía la regla, pero no el sitio donde se
aplica.

Y el signo de que una escritura clásica trae un stock "de verdad" (un ajuste hecho en clásico) es
`camposMtime.stock` (§7.2 del diseño del motor). **Ojo: hoy NINGUNA página escribe `camposMtime`**
(solo existe en `motor_operaciones.js`): mientras siga así, esa columna no se puede aplicar y hay que
elegir la opción conservadora (ignorar el `stock` recibido y avisar). Regla fina:

| Caso | Qué se hace |
|---|---|
| El arreglo clásico trae el `stock` **sin** `camposMtime.stock` y sin `mtime` posterior al inicio del modo operaciones | Se ignora ese `stock` (es un valor viejo o una caché). Se aplican los demás campos |
| El arreglo clásico trae `camposMtime.stock` **posterior** al último movimiento del producto | Se acepta como un **ajuste manual** y se **convierte** en un movimiento `ajuste` con `cantidad = valorRecibido - stockCalculado`. Así un equipo en clásico (o una página no migrada) no pierde su corrección. **Sin probar en el simulador** (requiere `camposMtime`, que hoy no existe en ninguna página) |
| El arreglo clásico trae `camposMtime.stock` **anterior** al último movimiento | Se ignora (el movimiento es más nuevo) y se avisa en el diagnóstico |
| Cualquier caso | El `stock` resultante que se **sube** es siempre el calculado. Nunca el recibido |

### 9.2 Caché de presentación

* El POS/inventario recalcula `producto.stock` tras cada movimiento propio y tras cada bajada de
  movimientos, y lo escribe **solo** en `localStorage` (para pintar rápido y sin conexión).
* El valor **calculado** se publica en la nube con una operación `producto` normal (o con una
  escritura clásica, da igual: por §9.1 su `stock` se acepta porque coincide con la suma). Así las
  páginas que leen `producto.stock` (POS, catálogo, reportes, `mini_market_pos_resumen.html`) ven un
  número coherente sin saber nada del modelo nuevo.
* `stockMtime` se escribe con el instante del último movimiento aplicado, para que el merge por
  campo (§7.2 del motor) no deje ganar a un valor viejo.
* **Nunca un bucle**: la caché que se escribe es la que se recalcula de los movimientos; escribirlo
  no genera un movimiento nuevo. La regla que lo garantiza: **`updateInventory()` no crea
  movimientos**; los movimientos los crea el cobro de la venta (`processSale`), una sola vez.

---

## 10. Ejemplos completos

### 10.1 Dos equipos sin conexión (el caso del enunciado)

Inicial 10. A vende 3 sin conexión, B vende 4 sin conexión.

| Equipo | Momento | `ops/movimiento` (nodo) | `opId` | `cantidad` |
|---|---|---|---|---|
| A | 10:00:00 | `AAAA1111_K7M2_0001` | `MIG-P-HARINA-PAN` | +10 |
| A | 10:00:05 | `AAAA1111_K7M2_0002` | `M-V-V-LOCAL-AAAA1111-0007` | −3 |
| B | 10:00:10 | `BBBB2222_K7M2_0001` | `M-V-V-LOCAL-BBBB2222-0009` | −4 |

Clásico: la nube acaba en **6** (o **7**), la venta de uno se pierde.
Movimientos: `10 − 3 − 4 = 3` en los dos equipos y en cualquier equipo nuevo (`T1`).

### 10.2 Compra + ventas + ajuste + cierre

```
inicial   +10
compra    +24      (compra C-0001, recibida)
venta      -3      (V-…-0007)
venta      -4      (V-…-0008)
ajuste     -2      (conteo físico: 2 rotas)
------------------------------
stock      25

cierre 2026-02: saldoContado 25, saldoBaseAntes 10 -> cantidadCierre +15
  saldoBase = 10 + 15 = 25   (los 5 movimientos del periodo ya no se suman)
venta 2026-03  -5  ->  stock = 25 - 5 = 20
```

### 10.3 Venta anulada

```
venta      V-…-0007  -> M-V-V-…-0007   -3
anulacion  (anulaA M-V-V-…-0007)       +3
stock = 10 - 3 + 3 = 10
```

El nodo de la venta original **sigue en la nube**: la anulación es un hecho nuevo.

---

## 11. Riesgos y lo que queda abierto

### 11.1 Movimientos que llegan después de un cierre

**Riesgo (el más serio del diseño).** El cierre acota el cálculo a los movimientos posteriores al
periodo cerrado. Un movimiento con fecha *dentro* del periodo cerrado que llegue **después** del
cierre ya está absorbido por el saldo base y **no se suma**: una venta se pierde para el stock
(queda en el log y en los reportes, pero no en el stock). **El simulador lo reproduce y lo deja
fijado como comportamiento indeseado** (`T9`, tramo «HUECO §11.1»: cierre de 2026-02 con saldo 10,
llega después una venta fechada el 2026-02-20 y el stock sigue en 10).

**Mitigación propuesta.** El `cierre` guarda la lista de nodos incluidos (o `deviceId` + máximo
`(fechaISO, secuencia)` por equipo); el cálculo excluye **por rango de claves**, no por periodo, así
que un nodo posterior con fecha dentro del rango sí se suma. Es más código y un nodo de cierre más
grande. **Sin decidir y sin implementar.**

### 11.2 Ajustes por conteo simultáneos en dos equipos

**Riesgo.** El ajuste es un **delta** contra el stock que ese equipo ve. Si A ajusta a 30 (desde
25 → +5) y B ajusta a 32 (desde 20 → +12, porque ve otro stock), la suma de deltas da 25 + 5 + 12 =
42, no 32 ni 30. Dos conteos físicos simultáneos no se pueden fusionar con deltas.

**Alternativas.** (a) Dejar el ajuste como delta y **prohibir** que dos equipos cuenten a la vez (la
práctica real: se cuenta con un solo equipo, sin conexión, y se sube antes de que el otro abra);
(b) aceptar el ajuste como **absoluto** (`cantidad` no se suma, se usa como nuevo saldo base, como
un mini-cierre) y dejar que gane el más reciente por `mtime`, perdiendo el otro; (c) guardar el
delta **y** el `saldoContado` para que el diagnóstico detecte la incoherencia (`5 + 12 ≠ 32 - 25`).
**Decisión pendiente.** Recomiendo (a) + (c): delta con aviso, y que el dueño no cuente en dos
equipos a la vez. Nota: el `cierre` **ya** guarda `payload.saldoContado` (§4.3), pero el `ajuste`
no; si se elige (c) hay que añadírselo.

### 11.3 La ventana caliente de 30 días vs. el saldo base

**Riesgo.** `liberarCaliente()` de E1 borra los movimientos confirmados de más de 30 días. Si se
lleva por delante un `inicial` o un `cierre`, el stock calculado **baja de golpe** (se pierde el
saldo de apertura). Es un bug de implementación casi garantizado si no se toca E1.

**Agravante que la auditoría señaló.** `verificarLiberadasRecientes()` (E1, ~L952-1001) **vuelve a
subir a la nube** lo que se acaba de soltar en local: o sea que la nube conservaría el saldo base y
el **cálculo offline** lo perdería. El resultado sería un equipo que ve un stock distinto al de la
nube sin ningún aviso.

**Mitigación.** El saldo base (`inicial` + `cierre` vigentes) vive en un archivo aparte
(`caliente/saldos.json`, que hoy **no existe**) que **nunca se libera**, y la liberación de
movimientos solo puede tocar movimientos **cubiertos por un cierre ya aplicado**. Falta implementarlo
(es una ampliación de E1, §8).

### 11.4 Siembra del histórico clásico

Igual que el §11.5 del diseño del motor, y sigue **abierto**: al activar `'operaciones'` en un
negocio con años de ventas clásicas, el `inicial` congela el stock actual pero las ventas viejas no
existen como movimientos (no hacen falta para el stock, **sí** para el histórico). Si algún día se
quiere reconstruir el stock desde cero (auditoría), haría falta convertir `ventas/historial` en
movimientos `venta`, y **no está diseñado**.

### 11.4b El transporte no filtra por producto ni por fecha

Ver §4.5: es el riesgo **crítico** del diseño (el ahorro del cierre es de aritmética, no de
tráfico, y el §4.4 no es alcanzable sin un índice `movimientos_idx/<producto>/<periodo>`). Se deja
aquí el puntero porque, sin resolverlo, el modelo «el equipo nuevo baja el saldo base y el mes en
curso» **no existe**.

### 11.4c `ajuste` y `compra` no tienen productor hoy

Ver §8: `inventario.html`, `compras.html` y `catalogo.html` **no cargan el motor** y suben el arreglo
completo. Sin migrarlas, en modo operaciones las correcciones manuales y las entradas de compra **no
existen como movimientos** (la suma nunca las ve) y el POS sigue publicando un `stock` truncado como
caché. Es el segundo trabajo obligatorio de la fase de implementación (el primero es el §9.1).

### 11.5 Dos equipos con el mismo `deviceId`

Ya cubierto por `installId` en la clave del motor (decisión cerrada nº 2 de E1). Sin embargo, si el
`localStorage` se copia de un equipo a otro, los dos comparten `deviceId` **e** `installId` y vuelve
el riesgo de colisión. La mitigación de E1 (recuperar la secuencia de la nube) no cierra la ventana:
los dos pueden reservar la misma secuencia antes de subir. **Sigue abierto** (es el §11.7 del
diseño del motor).

### 11.6 OPFS no está aislado por cuenta

**Hallazgo nuevo de este diseño.** `datos_cuenta.js` prefija las claves de `localStorage`, pero
**NO** toca OPFS (no puede: intercepta `Storage.prototype`). La cola y la ventana caliente del motor
viven en `navigator.storage.getDirectory()` **sin prefijo de cuenta**, así que dos cuentas en el
mismo equipo comparten archivos: la cuenta B podría leer/subir movimientos de la cuenta A (a otra
ruta `BBDD/<emailPath>`, sí, pero con datos de A en disco) o, peor, la liberación de una cuenta
podría borrar el saldo base de la otra.

**Mitigación.** Incluir el `emailPath` en la ruta OPFS del motor (`cuenta/<emailPath>/…`) o exponer
un prefijo desde `datos_cuenta.js` y que `motor_operaciones.js` lo use. **Sin implementar y sin
probar en el simulador** (el simulador no modela OPFS ni el aislamiento por cuenta).

### 11.7 El `stock` en caché puede quedar viejo

Si la caché de presentación (§9.2) no se regenera (página cerrada, error), un equipo clásico lee un
número viejo. No afecta a la verdad (que es la suma de movimientos) pero **sí** a lo que ve el
operador. **Mitigación:** la caché lleva `stockMtime` y el POS/inventario avisa cuando
`stockMtime` es anterior al último movimiento conocido del producto.

### 11.8 Otros

* **Crecimiento del log.** Nunca se borra: ~40–50 MB/año por negocio. Con cierres, el *cálculo* es
  barato, pero el *almacenamiento* en la nube crece lineal. No hay plan de exportación/archivado
  por año (**sin diseñar**).
* **Coste de subir un movimiento por línea de venta.** Una venta de 8 líneas son 8 operaciones más
  la venta = 9 escrituras. Se puede agrupar en **una** operación `movimiento` con un arreglo de
  líneas (misma idempotencia por `opId`), pero se pierde la trazabilidad por línea y complica la
  anulación parcial. **Sin decidir**; hoy el diseño dice una operación por producto vendido.
* **Reglas de Firebase.** `ops/movimiento` no tiene `.validate`: un cliente con un bug puede
  escribir `cantidad: "tres"`. El cálculo lo ignora (`Number(...) || 0`), pero convendría validar
  en reglas (el encargo prohíbe tocar reglas en esta fase).
* **Desfase de relojes.** El cierre depende de `fechaISO`. Un equipo con el reloj mal puede fechar
  un movimiento en un periodo ya cerrado (ver §11.1). Mitigación propuesta (heredada del §11.6 del
  motor): usar `serverTimestamp`/`.sv` para estimar el offset. **Sin implementar.**

---

## 12. Cómo se validó este diseño y qué NO prueba el simulador

`pruebas_stock_movimientos.js` (Node, sin dependencias, no toca archivos de la app) modela los dos
motores sobre el mismo mock del SDK v8 y ejecuta **56 comprobaciones** `OK`/`FALLA`.

**Este documento y el simulador fueron auditados por un revisor independiente** (sin acceso a mi
razonamiento) que encontró errores reales, ya corregidos en esta revisión: el escenario `clasico`
hacía una subida que era un no-op y una de sus dos ramas era inalcanzable; los campos de negocio
estaban en la raíz de la operación aunque el motor no los copia; el `cierre` perdía `saldoContado`;
el cálculo sumaba dos veces los cierres de dos equipos; el ajuste clásico se modelaba como valor
absoluto cuando `inventario.html` manda un delta; el mock sobrescribía en `ops/*` (no era
append-only) y contaba escrituras idénticas; y varias comprobaciones eran tautológicas. Lo que
sigue es la versión corregida.

| Escenario | Qué demuestra |
|---|---|
| T1 | Dos equipos sin conexión: en `clasico` la nube **depende del orden de subida** (6 si sube B al final, 7 si sube A) y la venta del que sube primero se pierde; con `movimientos` los dos equipos y un equipo nuevo calculan **3** |
| T2 | Reintento del mismo movimiento: la cola lo reconoce, reenviarlo no escribe (0 escrituras), el mismo nodo con **otro** contenido se rechaza como conflicto, y el stock sigue en 7 |
| T3 | Venta anulada: la anulación es un nodo nuevo, el original no se borra, el stock vuelve a 10; la venta replicada y el conflicto de clave se detectan |
| T4 | Compra + 2 ventas + ajuste manual (delta, 25 → 30) + **a granel** (3 decimales exactos: 9.7, no 9.700000000000001) |
| T5 | Cierre/snapshot de 2026-02 contra un **oráculo independiente** (10 + 20 − 12 = 18): el stock no cambia, los 13 movimientos del periodo dejan de sumarse, dos equipos cerrando lo mismo **no** duplican, dos cierres discrepantes se cuentan una vez (el menor), y la suma ingenua descuadra (33 ≠ 13) |
| T6 | Migración: el `inicial` no se duplica en el mismo equipo; dos equipos con stock **distinto** (10 y 12) → se toma el **menor** (10, ni 12 ni 22) + aviso |
| T7 | Modo clásico: **solo** el valor exacto `'operaciones'` enciende el motor (probado con el positivo incluido); la venta y el ajuste (delta) clásicos se comportan igual y **no** se escribe ni un `ops/movimiento` |
| T8 | Plan local (sin nube): 4 movimientos en el equipo, stock 18, **cero** escrituras en la nube, y al activar la nube la cola se sube y el stock no cambia |
| T9 | Movimientos fuera de orden (indexados por nodo y recibidos al revés): mismo stock (12 → 10). **Y fija el HUECO §11.1**: una venta que llega tras el cierre de su propio periodo **no** se suma |
| T10 | Un arreglo clásico de productos con `stock` viejo **no** cambia la verdad calculada (7 antes y después de la escritura); el campo queda como caché de presentación |

**Comprobaciones que el revisor señaló como débiles y que se corrigieron o se dejan declaradas:**

| Antes (débil) | Ahora |
|---|---|
| «el stock final es incorrecto» (`trasB !== 3`) | Se comprueban los **dos** órdenes de subida (6 y 7) y que difieren |
| La rama `=== 7` era inalcanzable | Alcanzable (se montan las dos órdenes) |
| El ajuste se comprobaba con un delta calculado por el propio test | Se comprueba contra el stock anterior y se declara que si el ajuste se perdiera el resultado sería otro |
| «sin redondear no es exacto» probaba IEEE-754, no el simulador | Se mantiene, pero **declarado**: es una nota de por qué el motor redondea |
| «el cierre no cambia el stock» era identidad por construcción | Se contrasta contra un **oráculo independiente** escrito a mano |
| La idempotencia del cierre se probaba en el mismo equipo | Se prueba con **dos equipos** y con **dos cierres discrepantes** |
| «se toma el MENOR» con dos valores iguales (10 y 10) | Se usan **10 y 12** (distingue de «el primero», «el mayor» y «la suma») |
| El caso positivo del interruptor no se probaba | Se añade `'operaciones'` a la lista |
| «NO se toca el campo de caché» no examinaba ninguna caché | Renombrada a lo que sí comprueba (log local y cola) |
| El mock no era append-only y contaba escrituras idénticas | `ops/*` es append-only con camino `conflicto`; el resto (productos) **sí** pisa, como RTDB |
| La unión de movimientos era por `opId` (descartaba duplicados) | Unión por **nodo** (como la ruta real) y el cálculo deduplica por `opId` |

**Simplificaciones del simulador (importante, no son pruebas de producción):**

1. **Es monohilo y en memoria.** No prueba OPFS real, ni dos pestañas, ni el `flush` a disco antes
   de la red (la suposición más fuerte de todo el modelo).
2. **El cierre se modela por periodo exacto**, no con la lista de nodos incluidos del §11.1. El
   agujero del movimiento tardío está **fijado como comportamiento indeseado** (`T9`), no resuelto:
   falta decidir e implementar la exclusión por rango.
3. **El ajuste por conteo se modela secuencial** (un solo equipo ajustando). El caso de dos conteos
   simultáneos (§11.2) **no** se prueba: el simulador no lo resolvería.
4. **La caché de presentación se modela a mano** (`T10` la regenera explícitamente), y la conversión
   «`stock` absoluto de un cliente viejo → movimiento `ajuste`» **no** se prueba (necesita
   `camposMtime`, que hoy no escribe ninguna página).
5. **No se modela el aislamiento por cuenta** (§11.6), ni Firebase real, ni las reglas, ni el
   índice `movimientos_idx` de §4.5 (que es justo lo que hace falta para que el diseño funcione a
   escala).
6. **Los tipos `inicial`/`cierre` no se prueban contra la ventana caliente de 30 días** (§11.3):
   `liberarCaliente()` no está en el simulador.
7. **Medición de tamaño**: las cifras de §4.1 son estimaciones de orden de magnitud, **no medidas**
   con un negocio real.
8. **El cierre lo calcula el llamante en el simulador** (se le pasa `saldoBaseAntes`), porque es un
   modelo del *cálculo*, no del motor. En la implementación real la función pública debe ser
   `cerrar(productoId, periodo, saldoContado)` y el motor calcula el delta (§4.3). El simulador
   **no** prueba esa API.
9. **El redondeo a 3 decimales se prueba, pero no su versión en el motor real**: el POS clásico
   sigue restando en coma flotante (`inventory[index].stock -= item.quantity`) y ese
   comportamiento no se toca en modo clásico (§5, regresión).
10. **El «escenario clásico» es una simplificación del POS real.** Modela `fbSaveProductos` (subida
    del arreglo completo) y la descarga que reemplaza, pero **no** modela la resubida al reconectar
    de Fase A (`mini_market_pos.html` ~L5334-5340) ni el guardián `puedeSobrescribirLocalSync`. La
    conclusión (el que sube último gana y se pierde la venta del otro) se mantiene, pero el camino
    exacto del POS no está simulado.
11. **El simulador es un modelo de mi propio diseño**: que sus 56 comprobaciones pasen no valida el
    diseño contra el mundo, solo su coherencia interna. Las dos cosas que de verdad decidirían si
    esto sirve —el índice de §4.5 y la puerta de escritura del §9.1— **no están en el simulador**.

---

## 13. Qué NO cambia en esta fase

* Ningún archivo de la aplicación se modifica (ni `.html`, ni los `.js` de la app, ni las reglas de
  Firebase).
* `modoSync` **no se crea** en la nube: al no existir, todos los negocios siguen en `'clasico'`.
* El campo `producto.stock` sigue existiendo y las pantallas siguen leyéndolo: lo único que cambia
  (cuando se implemente) es **quién manda** sobre él.
