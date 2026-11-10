/* =====================================================================
   PRECIOS · módulo compartido por las páginas que calculan precio
   (inventario, compras, menú y calculadora).  Schema `pricing/2`.

   POR QUÉ EXISTE
   La app llamaba "Margen de Ganancia (%)" a lo que en realidad era un
   MARK-UP sobre el costo: precio = costo × (1 + m/100). Con costo 100 y
   35 %, daba 135 con una ganancia del 25,93 % sobre la venta, no del 35 %.
   El mismo 35 significaba dos cosas distintas en cada app del negocio.

   REGLAS DE ESTE MÓDULO (acordadas con Mergen)

   1. `basis` es OBLIGATORIA. Un porcentaje sin base es un dato inválido,
      no "un 35". Aquí nunca se adivina margen: si falta la base y hay
      `margin`, se asume MARK-UP; si no hay ni margen ni ganancia, `legacy`.
   2. El número NO se reinterpreta al cambiar de base: se CONVIERTE.
      mark-up 35 % → margen 25,93 % → el mismo precio (135). Para pasar
      de una base a otra se usa `margenDesdeMarkup` / `markupDesdeMargen`,
      jamás el mismo 35 con otra etiqueta.
   3. El precio es un dato GUARDADO, no derivado: este módulo solo
      SUGIERE. Quien decide el precio cobrado es el POS y el usuario.
   4. `realized` se calcula sobre el precio realmente cobrado. Aquí, a
      nivel de producto, ese precio es todavía el de lista (sin descuento
      por línea ni IVA), así que la calidad es `estimated` hasta que la
      venta aporte el ingreso neto (fase F4). No se miente con un
      "realizado" que no lo es.
   5. La base vive en un NODO HERMANO de `productos` (ver `rutaPricing`).
      El POS sube el catálogo con `.set()` del nodo completo: cualquier
      campo nuevo DENTRO del producto lo borra un equipo con la versión
      anterior. La semántica no puede vivir ahí.

   COMPATIBILIDAD
   `margin` sigue siendo el campo numérico de siempre (mark-up). Este
   módulo no lo toca: solo lo interpreta y lo acompaña de su base.
   Todo lo que no se pueda determinar se marca `needsReview: true`.
   ===================================================================== */
(function () {
    'use strict';

    var VERSION = 2;
    var NODO = 'pricingByProduct';

    var BASES = { margin: 1, markup: 1, profit: 1, manual: 1, legacy: 1 };
    var FUENTES = { computed: 1, manual: 1, imported: 1, legacy: 1 };

    /* Límites de validación. El margen sobre venta no puede llegar a 100 %
       (el precio sería infinito) y se corta en 95 % por prudencia comercial.
       El mark-up puede ser negativo (producto gancho), pero nunca -100 %:
       ahí el precio es 0 y la conversión a margen divide por cero. */
    var MARGEN_MIN = 0;
    var MARGEN_MAX = 95;
    var MARKUP_MIN = -99;
    var PASO = 0.01;
    var TOLERANCIA = 0.005;     // medio centavo: diferencia de redondeo aceptada

    /* ------------------------------ utilidades ------------------------------ */

    function numero(valor) {
        if (valor === null || valor === undefined || valor === '') return null;
        var n = Number(valor);
        return isFinite(n) ? n : null;
    }

    function redondear(valor, paso) {
        var p = numero(paso);
        if (!(p > 0)) p = PASO;
        var n = numero(valor);
        if (n === null) return null;
        return Math.round(n / p) * p;
    }

    function aDecimal(porcentaje) {
        var n = numero(porcentaje);
        return n === null ? null : n / 100;
    }

    function aPorcentaje(decimal) {
        var n = numero(decimal);
        return n === null ? null : n * 100;
    }

    /* ---------------------------- conversiones ----------------------------- */

    /**
     * Margen sobre venta (decimal) a partir de mark-up (decimal).
     * mark-up 0,35 → 0,259259…   ·   mark-up -0,20 → -0,25
     * Devuelve null en el polo (-100 %), donde la fórmula divide por cero.
     */
    function margenDesdeMarkup(markup) {
        var mu = numero(markup);
        if (mu === null || mu <= -1) return null;
        return mu / (1 + mu);
    }

    /**
     * Mark-up (decimal) a partir de margen sobre venta (decimal).
     * margen 0,35 → 0,538461…   ·   margen 1 → null (precio infinito)
     */
    function markupDesdeMargen(margen) {
        var m = numero(margen);
        if (m === null || m >= 1) return null;
        return m / (1 - m);
    }

    function margenDesdeMarkupPct(porcentaje) {
        return aPorcentaje(margenDesdeMarkup(aDecimal(porcentaje)));
    }

    function markupDesdeMargenPct(porcentaje) {
        return aPorcentaje(markupDesdeMargen(aDecimal(porcentaje)));
    }

    /* ------------------------------- precio -------------------------------- */

    /**
     * Precio sugerido a partir de la base declarada. No es el precio cobrado.
     * @param {{basis: string, cost: number, percent: (number|null), amount: (number|null), paso: (number|undefined)}} opciones
     * @returns {number|null} null si la base no permite derivarlo o el objetivo es inválido
     */
    function precioDesde(opciones) {
        var o = opciones || {};
        var costo = numero(o.cost);
        if (costo === null || costo < 0) return null;

        var bruto = null;
        if (o.basis === 'margin') {
            var m = aDecimal(o.percent);
            if (m === null || m < 0 || m >= 1) return null;
            bruto = costo / (1 - m);
        } else if (o.basis === 'markup') {
            var mu = aDecimal(o.percent);
            if (mu === null || mu <= -1) return null;
            bruto = costo * (1 + mu);
        } else if (o.basis === 'profit') {
            var g = numero(o.amount);
            if (g === null || g < 0) return null;
            bruto = costo + g;
        } else {
            return null;            // manual / legacy: el precio no se deriva
        }
        return redondear(bruto, o.paso);
    }

    /** Objetivo y base tal como los guarda el producto, con sus valores por unidad. */
    function magnitudes(producto) {
        var p = producto || {};
        var granel = p.isBulk === true;
        var cost = granel ? numero(p.costPerUnit) : numero(p.cost);
        var price = granel ? numero(p.pricePerUnit) : numero(p.price);
        var profit = granel ? numero(p.profitPerUnit) : numero(p.profit);
        /* Datos viejos o importados pueden tener el valor "en el otro sitio":
           para LEER se acepta cualquiera de los dos, sin escribir nada. */
        if (cost === null) cost = numero(p.cost);
        if (price === null) price = numero(p.price);
        if (profit === null) profit = numero(p.profit);
        return { cost: cost, price: price, profit: profit, granel: granel };
    }

    /** Identificador estable para reconciliar entre apps. El `id` NO lo es:
        la importación de Excel renumera 1..N en cada carga. El `code` sí. */
    function externalIdDe(producto) {
        var p = producto || {};
        var codigo = String(p.code == null ? '' : p.code).trim();
        if (codigo) return 'CIERVO-' + codigo;
        if (p.id === null || p.id === undefined) return null;
        return 'CIERVO-ID-' + String(p.id);
    }

    function baseDe(producto, overlay) {
        var p = producto || {};
        var declarada = overlay && overlay.target ? overlay.target.basis : null;
        if (declarada && BASES[declarada]) return declarada;
        if (numero(p.margin) !== null) return 'markup';
        /* La ganancia puede estar solo en `profitPerUnit` (producto a granel
           guardado por una versión anterior): se mira con magnitudes(). */
        if (magnitudes(p).profit !== null) return 'profit';
        return 'legacy';
    }

    /**
     * Bloque `pricing/2` de un producto. No escribe nada: solo describe lo
     * que el producto significa hoy.
     * @param {object} producto
     * @param {object=} overlay  entrada del nodo hermano (target.basis, priceSource)
     * @param {{ahora: (string|undefined), currency: (string|undefined), paso: (number|undefined)}=} opciones
     */
    function derivar(producto, overlay, opciones) {
        var o = opciones || {};
        var p = producto || {};
        var m = magnitudes(p);
        var base = baseDe(p, overlay);

        var percent = null;
        var amount = null;
        if (base === 'markup' || base === 'margin') percent = numero(p.margin);
        if (base === 'profit') amount = m.profit;

        var esperado = precioDesde({ basis: base, cost: m.cost, percent: percent, amount: amount, paso: o.paso });
        var sugerido = esperado === null ? null : redondear(esperado, o.paso);
        var fuente = (overlay && overlay.priceSource && FUENTES[overlay.priceSource]) ? overlay.priceSource : null;
        if (!fuente) {
            if (base === 'legacy') fuente = 'legacy';
            else if (base === 'manual') fuente = 'manual';
            else if (esperado === null || m.price === null) fuente = 'manual';
            else fuente = Math.abs(m.price - esperado) <= TOLERANCIA ? 'computed' : 'manual';
        }

        var margenPct = null;
        var markupPct = null;
        if (m.cost !== null && m.price !== null && m.price > 0) {
            margenPct = aPorcentaje((m.price - m.cost) / m.price);
        }
        if (m.cost !== null && m.cost > 0 && m.price !== null) {
            markupPct = aPorcentaje((m.price - m.cost) / m.cost);
        }

        return {
            schema: 'pricing/2',
            productId: p.id === null || p.id === undefined ? null : String(p.id),
            externalId: externalIdDe(p),
            currency: String(o.currency || p.currency || 'USD'),
            cost: m.cost,
            price: m.price,
            suggestedPrice: sugerido,
            priceSource: fuente,
            target: { basis: base, percent: percent, amount: amount },
            realized: {
                /* A nivel de producto todavía no hay ingreso neto: `price` es el
                   de LISTA. Por eso `quality` es `estimated` hasta F4. */
                revenueNet: m.price,
                margin: margenPct,
                markup: markupPct,
                quality: 'estimated'
            },
            /* Necesita revisión si no hay base, o si la base es porcentual y no
               hay porcentaje con el que calcularla (par contradictorio). */
            needsReview: base === 'legacy' || ((base === 'margin' || base === 'markup') && percent === null),            pricingVersion: VERSION,
            updatedAt: String(o.ahora || new Date().toISOString())
        };
    }

    /* ------------------------- nodo hermano (nube) ------------------------- */

    /**
     * Ruta del nodo hermano. NO se guarda dentro de `productos` a propósito:
     * `firebaseSaveProducts` hace `.set()` del nodo completo y un equipo con
     * la versión anterior borraría cualquier campo nuevo del producto.
     */
    function rutaPricing(emailPath) {
        return 'BBDD/' + String(emailPath || '') + '/' + NODO;
    }

    /** Mapa `{ id: pricing }` listo para escribir en el nodo hermano.
     *  `opciones.overlay` es lo que YA está en la nube: si no se pasa, este mapa
     *  borraría una base declarada (`margin`, `manual`) y la reescribiría como
     *  mark-up, porque `derivar` sin overlay no puede saber que era otra cosa. */
    function mapaPricing(productos, opciones) {
        var o = opciones || {};
        var previo = o.overlay || null;
        var lista = Array.isArray(productos) ? productos : [];
        var mapa = {};
        for (var i = 0; i < lista.length; i++) {
            var p = lista[i];
            if (!p || p.id === null || p.id === undefined) continue;
            mapa[String(p.id)] = derivar(p, previo ? overlayDe(previo, p) : null, o);
        }
        return mapa;
    }

    /** Entrada del nodo hermano para un producto (o null si no hay). */
    function overlayDe(mapa, producto) {
        if (!mapa || !producto || producto.id === null || producto.id === undefined) return null;
        return mapa[String(producto.id)] || null;
    }

    /* ------------------------------ validación ----------------------------- */

    /**
     * Valida un objetivo antes de calcular. Devuelve `{ok, motivo}`.
     * No valida el precio cobrado: eso es del POS.
     */
    function validarObjetivo(basis, percent, amount) {
        if (basis === 'margin') {
            var m = numero(percent);
            if (m === null) return { ok: false, motivo: 'El margen debe ser un número.' };
            if (m < MARGEN_MIN || m > MARGEN_MAX) return { ok: false, motivo: 'El margen debe estar entre 0 % y 95 %.' };
            return { ok: true, motivo: '' };
        }
        if (basis === 'markup') {
            var mu = numero(percent);
            if (mu === null) return { ok: false, motivo: 'El mark-up debe ser un número.' };
            if (mu <= -100) return { ok: false, motivo: 'El mark-up no puede ser -100 % o menor: el precio sería cero.' };
            if (mu < MARKUP_MIN) return { ok: false, motivo: 'El mark-up es demasiado negativo (mínimo -99 %).' };
            return { ok: true, motivo: '' };
        }
        if (basis === 'profit') {
            var g = numero(amount);
            if (g === null) return { ok: false, motivo: 'La ganancia debe ser un número.' };
            if (g < 0) return { ok: false, motivo: 'La ganancia no puede ser negativa.' };
            return { ok: true, motivo: '' };
        }
        if (basis === 'manual' || basis === 'legacy') return { ok: true, motivo: '' };
        return { ok: false, motivo: 'Falta la base del porcentaje (margin o markup).' };
    }

    /* -------------------------------- textos ------------------------------- */

    /** "Mark-up 35 % → margen sobre venta 25,93 %" para mostrar en pantalla. */
    function textoEquivalente(basis, percent, decimales) {
        var d = decimales === undefined ? 2 : decimales;
        var n = numero(percent);
        if (n === null) return '';
        var fmt = function (v) { return (Math.round(v * 100) / 100).toFixed(d).replace('.', ',') + ' %'; };
        if (basis === 'margin') {
            var mu = markupDesdeMargenPct(n);
            return 'Margen sobre venta ' + fmt(n) + ' → mark-up equivalente ' + (mu === null ? '—' : fmt(mu));
        }
        if (basis === 'markup') {
            var m = margenDesdeMarkupPct(n);
            return 'Mark-up ' + fmt(n) + ' → margen sobre venta ' + (m === null ? '—' : fmt(m));
        }
        if (basis === 'profit') return 'Ganancia fija por unidad';
        return 'Sin base declarada: hay que revisarlo';
    }

    /* ------------------------------- ventas -------------------------------- */

    /* Alícuota de IVA. Estaba escrita a mano (0,16) en cuatro sitios del POS y
       del resumen; si cambia, las ventas viejas tienen que seguir cuadrando por
       el `taxRate` que se guarda en cada una. */
    var IVA_RATE = 0.16;

    /**
     * Reparte un descuento global entre líneas, en la MISMA proporción que usa
     * el POS para el IVA, y con reparto por mayor resto para que la suma de las
     * líneas sea exactamente el descuento de la venta (ni un céntimo de más).
     * @param {number[]} subtotales
     * @param {number} descuentoTotal
     * @returns {number[]}
     */
    function repartirDescuento(subtotales, descuentoTotal) {
        var lista = Array.isArray(subtotales)
            ? subtotales.map(function (v) { var n = numero(v); return n === null || n < 0 ? 0 : n; })
            : [];
        if (lista.length === 0) return [];

        var total = 0;
        for (var t = 0; t < lista.length; t++) total += lista[t];

        var descuento = numero(descuentoTotal);
        if (descuento === null || descuento < 0) descuento = 0;
        if (!(total > 0) || !(descuento > 0)) {
            return lista.map(function () { return 0; });
        }
        if (descuento >= total) {
            // Descuento del 100 %: cada línea se lleva exactamente su importe.
            return lista.map(function (v) { return redondear(v); });
        }

        var centavos = Math.round(descuento * 100);
        var exacto = lista.map(function (v) { return (v / total) * centavos; });
        var asignado = exacto.map(function (v) { return Math.floor(v); });
        var repartido = 0;
        for (var i = 0; i < asignado.length; i++) repartido += asignado[i];

        var sobra = centavos - repartido;
        if (sobra > 0) {
            var orden = exacto.map(function (v, idx) {
                return { idx: idx, resto: v - Math.floor(v), subtotal: lista[idx] };
            }).sort(function (a, b) {
                if (b.resto !== a.resto) return b.resto - a.resto;
                if (b.subtotal !== a.subtotal) return b.subtotal - a.subtotal;
                return a.idx - b.idx;             // desempate estable
            });
            for (var k = 0; k < sobra; k++) asignado[orden[k % orden.length].idx] += 1;
        }
        return asignado.map(function (c) { return c / 100; });
    }

    /**
     * Construye una línea de venta con el contrato `sales/2`: ingreso bruto,
     * descuento asignado, impuesto, ingreso neto, costo, ganancia y margen.
     * Todos los importes van en la MONEDA DE LA VENTA; `cost` es el costo total
     * de la línea (unitario × cantidad), no el unitario.
     * @param {{saleId:string, lineId:string, productId:(string|number), externalId:(string|undefined),
     *          quantity:number, grossRevenue:number, discount:number, taxRate:(number|undefined),
     *          exempt:boolean, cost:(number|null), currency:string, exchangeRate:(number|undefined),
     *          snapshotAt:(string|undefined)}} datos
     */
    function lineaDeVenta(datos) {
        var d = datos || {};
        var cantidad = numero(d.quantity);
        if (cantidad === null) cantidad = 0;

        var bruto = redondear(numero(d.grossRevenue) || 0);
        var descuento = redondear(numero(d.discount) || 0);
        if (descuento > bruto) descuento = bruto;
        var neto = redondear(bruto - descuento);

        var tasa = numero(d.taxRate);
        if (tasa === null) tasa = IVA_RATE;
        var exento = d.exempt === true || tasa === 0;
        var impuesto = exento ? 0 : redondear(neto * tasa);

        var costoUnitario = numero(d.cost);
        var costo = costoUnitario === null ? null : redondear(costoUnitario * cantidad);
        var ganancia = costo === null ? null : redondear(neto - costo);
        var margen = (ganancia !== null && neto > 0) ? redondear((ganancia / neto) * 100) : null;

        return {
            saleId: d.saleId === undefined ? null : d.saleId,
            lineId: d.lineId === undefined ? null : d.lineId,
            productId: d.productId === undefined ? null : d.productId,
            externalId: d.externalId === undefined ? null : d.externalId,
            quantity: cantidad,
            grossRevenue: bruto,
            discount: descuento,
            tax: impuesto,
            taxRate: exento ? 0 : tasa,
            taxIncluded: false,
            netRevenue: neto,
            cost: costo,
            currency: String(d.currency || 'USD'),
            exchangeRate: numero(d.exchangeRate),
            profit: ganancia,
            margin: margen,
            pricingVersion: VERSION,
            snapshotAt: String(d.snapshotAt || new Date().toISOString())
        };
    }

    /** Suma segura de una lista de números. */
    function _suma(lista) {
        var total = 0;
        for (var i = 0; i < lista.length; i++) {
            var n = numero(lista[i]);
            if (n !== null) total += n;
        }
        return total;
    }

    /**
     * Margen realizado de una venta completa. Si las líneas ya traen
     * `netRevenue` (ventas nuevas) se usan tal cual; si no, se reconstruyen con
     * las reglas del POS y NUNCA con el inventario actual.
     *
     * Nota de unidades: `venta.totals` se guarda en USD (calculateSaleTotals),
     * mientras las líneas se guardan en la moneda de la venta. El descuento se
     * convierte a la moneda de las líneas antes de repartirlo.
     *
     * @returns {{currency:string, lines:Array, grossRevenue:number, discount:number,
     *            tax:number, netRevenue:number, cost:(number|null), profit:(number|null),
     *            margin:(number|null), quality:string, estimatedLines:number, reasons:string[]}}
     */
    function realizadoDeVenta(venta) {
        var v = venta || {};
        var items = Array.isArray(v.items) ? v.items : [];
        var moneda = String(v.currency || 'USD');
        var tasa = numero(v.exchangeRate) || 0;
        var totales = v.totals || {};
        var razonesVenta = [];

        var nuevas = items.length > 0 && items.every(function (it) { return numero(it.netRevenue) !== null; });
        if (nuevas) {
            var lineasNuevas = items.map(function (it) {
                var neto = numero(it.netRevenue);
                var costo = numero(it.cost);
                var ganancia = costo === null ? null : redondear(neto - costo);
                return {
                    grossRevenue: numero(it.grossRevenue) !== null ? numero(it.grossRevenue) : (numero(it.subtotal) || 0),
                    discount: numero(it.discount) || 0,
                    netRevenue: neto,
                    tax: numero(it.tax) || 0,
                    cost: costo,
                    profit: ganancia,
                    margin: (ganancia !== null && neto > 0) ? redondear((ganancia / neto) * 100) : null,
                    quality: costo === null ? 'estimated' : 'final',
                    reasons: costo === null ? ['missing_cost'] : []
                };
            });
            var netoTotal = redondear(_suma(lineasNuevas.map(function (l) { return l.netRevenue; })));
            var costoTotal = lineasNuevas.some(function (l) { return l.cost === null; })
                ? null
                : redondear(_suma(lineasNuevas.map(function (l) { return l.cost; })));
            var gananciaTotal = costoTotal === null ? null : redondear(netoTotal - costoTotal);
            var estimadas = lineasNuevas.filter(function (l) { return l.quality !== 'final'; }).length;
            return {
                currency: moneda,
                lines: lineasNuevas,
                grossRevenue: redondear(_suma(items.map(function (it) { return numero(it.grossRevenue) || (numero(it.subtotal) || 0); }))),
                discount: redondear(_suma(items.map(function (it) { return numero(it.discount) || 0; }))),
                tax: redondear(_suma(lineasNuevas.map(function (l) { return l.tax; }))),
                netRevenue: netoTotal,
                cost: costoTotal,
                profit: gananciaTotal,
                margin: (gananciaTotal !== null && netoTotal > 0) ? redondear((gananciaTotal / netoTotal) * 100) : null,
                quality: estimadas === 0 ? 'final' : 'estimated',
                estimatedLines: estimadas,
                reasons: estimadas === 0 ? [] : ['line_incomplete']
            };
        }

        /* --- Camino legacy: se reconstruye, no se reescribe la venta --- */
        var brutos = items.map(function (it) {
            var sub = numero(it.subtotal);
            if (sub !== null) return sub;
            var unit = numero(it.unitPrice);
            var qty = numero(it.quantity);
            return (unit === null || qty === null) ? 0 : unit * qty;
        });
        var brutoVenta = redondear(_suma(brutos));

        var descuentoUsd = numero(totales.discount);
        if (descuentoUsd === null) {
            descuentoUsd = 0;
            razonesVenta.push('missing_line_discount');
        }
        var descuentoMoneda = (moneda === 'VES' && tasa > 0) ? descuentoUsd * tasa : descuentoUsd;
        if (moneda === 'VES' && descuentoUsd > 0) {
            // `totals.discount` está en USD y las líneas en Bs.: la conversión es
            // determinista con la tasa guardada, pero es una reconstrucción.
            razonesVenta.push('legacy_currency_mismatch');
        }

        var reparto = repartirDescuento(brutos, descuentoMoneda);
        var ivaConocido = (v.ivaApplied === true || v.ivaApplied === false);
        var ivaAplicado = v.ivaApplied === true;
        var tasaVenta = numero(v.taxRate);
        if (tasaVenta === null) tasaVenta = IVA_RATE;
        if (!ivaConocido) razonesVenta.push('missing_tax_snapshot');

        var lineas = items.map(function (it, idx) {
            var motivos = [];
            var producto = it.product || {};
            var exentoConocido = (typeof producto.isIvaExempt === 'boolean');
            if (!exentoConocido) motivos.push('missing_tax_snapshot');
            if (!ivaConocido) motivos.push('missing_tax_snapshot');

            var bruto = brutos[idx];
            var descuento = reparto[idx] || 0;
            var neto = redondear(bruto - descuento);
            var exento = producto.isIvaExempt === true;
            var impuesto = (ivaAplicado && !exento) ? redondear(neto * tasaVenta) : 0;

            var costoUnit = numero(producto.isBulk ? producto.costPerUnit : producto.cost);
            var qty = numero(it.quantity) || 0;
            /* El costo del inventario está en USD; la línea, en la moneda de la
               venta. Se convierte con la tasa guardada en la propia venta. */
            var factorMoneda = (moneda === 'VES' && tasa > 0) ? tasa : 1;
            var costo = costoUnit === null ? null : redondear(costoUnit * factorMoneda * qty);
            if (costo === null) motivos.push('missing_cost');

            var ganancia = costo === null ? null : redondear(neto - costo);
            if (moneda === 'VES' && descuentoUsd > 0) motivos.push('legacy_currency_mismatch');

            return {
                grossRevenue: bruto,
                discount: descuento,
                netRevenue: neto,
                tax: impuesto,
                cost: costo,
                profit: ganancia,
                margin: (ganancia !== null && neto > 0) ? redondear((ganancia / neto) * 100) : null,
                quality: motivos.length ? 'estimated' : 'final',
                reasons: motivos.filter(function (m, i) { return motivos.indexOf(m) === i; })
            };
        });

        var netoTotalLegacy = redondear(_suma(lineas.map(function (l) { return l.netRevenue; })));
        var costoTotalLegacy = lineas.some(function (l) { return l.cost === null; })
            ? null
            : redondear(_suma(lineas.map(function (l) { return l.cost; })));
        var gananciaTotalLegacy = costoTotalLegacy === null ? null : redondear(netoTotalLegacy - costoTotalLegacy);
        var estimadasLegacy = lineas.filter(function (l) { return l.quality !== 'final'; }).length;

        return {
            currency: moneda,
            lines: lineas,
            grossRevenue: brutoVenta,
            discount: redondear(_suma(reparto)),
            tax: redondear(_suma(lineas.map(function (l) { return l.tax; }))),
            netRevenue: netoTotalLegacy,
            cost: costoTotalLegacy,
            profit: gananciaTotalLegacy,
            margin: (gananciaTotalLegacy !== null && netoTotalLegacy > 0)
                ? redondear((gananciaTotalLegacy / netoTotalLegacy) * 100)
                : null,
            quality: estimadasLegacy === 0 ? 'final' : 'estimated',
            estimatedLines: estimadasLegacy,
            reasons: razonesVenta.filter(function (m, i) { return razonesVenta.indexOf(m) === i; })
        };
    }

    window.precios = {
        VERSION: VERSION,
        NODO: NODO,
        MARGEN_MIN: MARGEN_MIN,
        MARGEN_MAX: MARGEN_MAX,
        MARKUP_MIN: MARKUP_MIN,
        PASO: PASO,
        numero: numero,
        redondear: redondear,
        margenDesdeMarkup: margenDesdeMarkup,
        markupDesdeMargen: markupDesdeMargen,
        margenDesdeMarkupPct: margenDesdeMarkupPct,
        markupDesdeMargenPct: markupDesdeMargenPct,
        precioDesde: precioDesde,
        magnitudes: magnitudes,
        externalIdDe: externalIdDe,
        baseDe: baseDe,
        derivar: derivar,
        IVA_RATE: IVA_RATE,
        repartirDescuento: repartirDescuento,
        lineaDeVenta: lineaDeVenta,
        realizadoDeVenta: realizadoDeVenta,
        rutaPricing: rutaPricing,
        mapaPricing: mapaPricing,
        overlayDe: overlayDe,
        validarObjetivo: validarObjetivo,
        textoEquivalente: textoEquivalente
    };
})();
