# Contrato de precios `pricing/2`

Este documento fija lo acordado entre **Ciervo Mini Market (POS)** y **Mergen**
sobre un número que hasta ahora significaba dos cosas distintas: el porcentaje de
ganancia.

Estado: **F0 y F1 entregadas** (se pueden desplegar sin que cambie ningún precio).
F2–F5 pendientes.

---

## 1. El problema, en dos líneas

Con costo 100 y 35 %:

| Fórmula | Precio | Ganancia | Margen sobre venta |
|---|---|---|---|
| `costo × (1 + 35 %)` — **mark-up** | 135,00 | 35,00 | **25,93 %** |
| `costo ÷ (1 − 35 %)` — **margen** | 153,85 | 53,85 | **35,00 %** |

El POS siempre hizo la primera y la llamó "Margen de Ganancia (%)". Mergen hace
la segunda. El mismo 35 no es intercambiable.

Decisión: **margen sobre venta** es la base canónica de reportes y contrato;
**mark-up** se conserva como entrada, con su nombre y su equivalente a la vista.

---

## 2. El contrato

```json
{
  "schema": "pricing/2",
  "productId": "123",
  "externalId": "CIERVO-HAR-01",
  "currency": "USD",
  "cost": 100,
  "price": 135,
  "suggestedPrice": 135,
  "priceSource": "computed",
  "target": { "basis": "markup", "percent": 35, "amount": null },
  "realized": { "revenueNet": 135, "margin": 25.93, "markup": 35, "quality": "estimated" },
  "needsReview": false,
  "pricingVersion": 2,
  "updatedAt": "2026-11-10T18:00:00Z"
}
```

Enumeraciones:

- `target.basis`: `margin` · `markup` · `profit` · `manual` · `legacy`
- `priceSource`: `computed` · `manual` · `imported` · `legacy`
- `realized.quality`: `final` · `estimated`

Reglas:

1. **`basis` es obligatoria.** Un porcentaje sin base es un dato inválido, no un 35.
2. Al cambiar de base se **convierte el número**, no se reinterpreta:
   `markup 35 % ↔ margin 25,93 %`, con el mismo precio.
3. `target` es teórico. `realized` se calcula sobre el **ingreso neto cobrado**
   (precio − descuento de línea, sin IVA, sin comisiones) y es lo que se compara
   entre apps.
4. El POS es dueño de `cost`, `price`, `stock` y `priceHistory`. Mergen es dueño de
   `target`, `suggestedPrice` y `breakEven`. Mergen **no escribe** `price`: envía
   una propuesta y el POS la aplica solo con confirmación del usuario.
5. Los precios históricos no se recalculan. Las ventas ya guardan el producto
   completo en cada línea.

---

## 3. Dónde vive la base (y por qué no dentro del producto)

```
BBDD/<emailPath>/productos/<n>            catálogo operativo (POS)
BBDD/<emailPath>/pricingByProduct/<id>    pricing/2 (nodo HERMANO)
```

`firebaseSaveProducts()` hace `.set()` del nodo `productos` completo. Cualquier
campo nuevo **dentro** del producto lo borra un equipo que siga con la versión
anterior. Por eso la semántica vive en un nodo hermano, que ese `.set()` no toca.

Consecuencias:

- Si un producto no tiene entrada en `pricingByProduct`, se lee como `markup`
  (lo que fue siempre) y **nunca** como margen.
- Al reescribir el nodo se pasa el overlay leído (`mapaPricing` con `overlay`),
  para no degradar a mark-up una base ya declarada; y si el nodo **no se ha
  leído todavía** (por ejemplo, una subida al reconectar antes de la primera
  lectura), directamente no se escribe: mejor no escribir que escribir a ciegas.
- **Límite conocido:** el nodo lo refresca `inventario.html` al subir el catálogo.
  Un producto creado en `compras.html` o en `menu.html` no aparece ahí hasta la
  siguiente subida del inventario. Hasta F5, quien lea la nube debe reconciliar
  por `externalId` contra `productos` y tratar la ausencia como mark-up.

---

## 4. Qué cambió en esta entrega

| Archivo | Cambio |
|---|---|
| `precios.js` (nuevo) | Conversión, precio por base, `derivar`, validación, nodo hermano. |
| `pruebas_precios.js` (nuevo) | 191 comprobaciones: conversión, 4 ejemplos, formulario real, ventas y resumen. |
| `inventario.html` | Etiqueta "Mark-up sobre costo (%)"; margen equivalente en vivo; lectura y escritura de `pricingByProduct`; columnas `Base`, `Mark-up (%)`, `Margen s/ venta (%)`; el PDF muestra los dos porcentajes. |
| `compras.html` | Etiqueta y cálculo por el módulo. |
| `menu.html` | Etiqueta, encabezado de tabla y exportación. |
| `calcular_precio_ven.html` | La tarjeta "Margen Real" (que mostraba el mark-up) pasa a "Margen sobre venta" con el valor realizado; el historial guarda el mark-up y no el margen. |
| `config.html` | Retirados "Margen de Ganancia (%)" y "Redondeo" globales: no los leía ninguna pantalla. |
| `mini_market_pos.html` | **F4a:** cada línea guarda ingreso bruto, descuento repartido, IVA del snapshot, ingreso neto, costo en moneda de la venta y margen; la venta guarda `salesSchema`, `taxRate` y `discountPercent`. |
| `mini_market_pos_resumen.html` | **F4b/F4c:** ganancia y margen sobre ingreso neto; el IVA sale del snapshot; tarjeta "Margen realizado"; el PDF usa el mismo número; las ventas incompletas se marcan `estimated` y se excluyen del margen oficial. |

Ningún precio cambia: con costo 100 y 35 % se sigue guardando 135,00, y con 1,10
se sigue guardando 1,49.

### 4.1 Cómo queda una línea de venta (`sales/2`)

```json
{
  "saleId": "000123", "lineId": "000123-1", "productId": "7",
  "externalId": "CIERVO-HAR-01", "quantity": 1,
  "grossRevenue": 100, "discount": 10, "tax": 14.4, "taxRate": 0.16,
  "taxIncluded": false, "netRevenue": 90, "cost": 60, "currency": "USD",
  "exchangeRate": 40.5, "profit": 30, "margin": 33.33,
  "pricingVersion": 2, "snapshotAt": "2026-11-10T18:00:00Z"
}
```

Se conservan `product`, `unitPrice` y `subtotal` para el ticket y el resto de la
app. El descuento se reparte por mayor resto, así que la suma de las líneas es
**exactamente** el descuento de la venta.

### 4.2 La trampa de las unidades (corregida)

`sale.totals` se guarda en **USD** (así lo hacía `calculateSaleTotals`), pero las
líneas se guardan en la **moneda de la venta**. El resumen restaba un descuento
en USD a un subtotal en Bs.: en una venta en bolívares con descuento, el total
quedaba inflado por la tasa. Ahora el descuento se convierte antes de repartirlo,
tanto en la venta nueva como al reconstruir una vieja.

### 4.3 Calidad (`quality`)

| Caso | Calidad | Entra en el margen oficial |
|---|---|---|
| Venta con `sales/2` y costo presente | `final` | Sí |
| Venta vieja con `ivaApplied`, snapshot de exención y costo | `final` | Sí |
| Venta vieja sin `ivaApplied` o sin snapshot | `estimated` | No (se cuenta aparte) |
| Línea sin costo | `estimated`, margen `null` | No |

Nunca se reescribe una venta guardada: la calidad se calcula al leer.

---

## 5. Lo que falta

- **F2** Selector mark-up / margen con conversión del número y vista previa.
- **F3** Edición masiva y compras con vista previa y `priceHistory`; quitar el
  30 % silencioso de `compras.html` cuando el producto no tiene margen.
- **F5** JSON versionado `products[]` / `sales[]` / `meta{}`, y XLSX con columnas
  separadas. La importación ya lee la columna vieja "Margen (%)" y la nueva
  "Mark-up (%)"; todavía **no** lee una base explícita.
- **F4** hecho: líneas con ingreso neto, resumen por línea, IVA del snapshot y
  calidad `final`/`estimated`. Queda pendiente de tu confirmación el punto 2 de
  §6 (`realized` a nivel de producto).

---

## 6. Puntos abiertos con Mergen

1. `externalId`: en este POS el `id` **no** es estable (la importación de Excel
   renumera 1..N). El identificador estable es el **código** del producto; por eso
   `externalId` es `CIERVO-<código>`. Si un producto no tiene código, cae a
   `CIERVO-ID-<id>` y puede romperse en una importación.
2. `realized` a nivel de producto: aquí todavía no hay ingreso neto por producto,
   así que `revenueNet` es el precio de lista y `quality` es `estimated`. La
   propuesta es dejarlo así y usar `realized` **solo** en las líneas de venta,
   donde sí existe el descuento asignado.
3. `margin` sigue siendo el campo numérico heredado (mark-up). Renombrarlo
   rompería respaldos y páginas antiguas: se conserva y la base va aparte.

---

## 7. Cómo se comprueba

```
node pruebas_precios.js          # 115 comprobaciones
pwsh -File _correr_todas_las_suites.ps1
```

Las cuatro comprobaciones de aceptación del acuerdo están en la sección 3 de
`pruebas_precios.js`, y el formulario real de inventario se ejecuta sobre un DOM
falso en la sección 10 (mismo precio, margen equivalente correcto).
