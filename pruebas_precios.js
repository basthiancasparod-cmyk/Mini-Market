/**
 * pruebas_precios.js
 *
 * Fija el contrato `pricing/2` del módulo precios.js y las etiquetas de F1.
 *
 * El punto que estas pruebas protegen es el que se acordó con Mergen: un
 * porcentaje sin base es un dato inválido; el mark-up se convierte a margen
 * (35 % → 25,93 %), no se reinterpreta; y el `realized` se calcula sobre el
 * precio cobrado, que puede diferir del target por redondeo.
 *
 * También se comprueba que las páginas que calculan precio cargan el módulo y
 * que la etiqueta ya dice "Mark-up" y no "Margen de Ganancia".
 *
 * No necesita navegador ni Firebase.
 * Uso:  node pruebas_precios.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');

let pruebas = 0;
let fallos = 0;

function check(nombre, condicion, detalle) {
    pruebas++;
    if (!condicion) fallos++;
    console.log((condicion ? '  OK   ' : '  FALLA') + ' · ' + nombre +
        (condicion || detalle === undefined ? '' : '   [' + detalle + ']'));
}

function titulo(texto) { console.log('\n=== ' + texto + ' ==='); }

function leer(archivo) { return fs.readFileSync(archivo, 'utf8'); }

function cerca(a, b, tolerancia) {
    const t = tolerancia === undefined ? 0.0001 : tolerancia;
    return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= t;
}

/* El módulo se ejecuta TAL CUAL, en un contexto con su propio `window`. */
const contexto = { window: {} };
vm.createContext(contexto);
vm.runInContext(leer('precios.js'), contexto, { filename: 'precios.js' });
const P = contexto.window.precios;

if (!P) {
    console.log('  FALLA · precios.js no expuso window.precios');
    process.exit(1);
}

const DERIVAR = { ahora: '2026-11-10T18:00:00.000Z' };

/* ------------------------------------------------------------------ */
titulo('1. Conversión entre bases (no reinterpretación)');
{
    check('mark-up 0,35 → margen 0,259259', cerca(P.margenDesdeMarkup(0.35), 0.25925925925925924));
    check('mark-up 35 % → margen 25,93 %', cerca(P.margenDesdeMarkupPct(35), 25.925925925925924));
    check('margen 0,35 → mark-up 0,538461', cerca(P.markupDesdeMargen(0.35), 0.5384615384615384));
    check('margen 35 % → mark-up 53,85 %', cerca(P.markupDesdeMargenPct(35), 53.84615384615385));

    const ida = P.markupDesdeMargen(P.margenDesdeMarkup(0.35));
    check('ida y vuelta mark-up → margen → mark-up', cerca(ida, 0.35));

    check('mark-up -20 % → margen -25 %', cerca(P.margenDesdeMarkupPct(-20), -25));
    check('polo -100 % de mark-up no tiene margen', P.margenDesdeMarkupPct(-100) === null);
    check('margen 100 % no tiene mark-up', P.markupDesdeMargenPct(100) === null);
}

/* ------------------------------------------------------------------ */
titulo('2. Precio según la base declarada');
{
    check('costo 100 + mark-up 35 % = 135,00', P.precioDesde({ basis: 'markup', cost: 100, percent: 35 }) === 135);
    check('costo 100 + margen 35 % = 153,85', P.precioDesde({ basis: 'margin', cost: 100, percent: 35 }) === 153.85);
    check('costo 1,10 + mark-up 35 % = 1,49', P.precioDesde({ basis: 'markup', cost: 1.1, percent: 35 }) === 1.49);
    check('costo 1,10 + margen 35 % = 1,69', P.precioDesde({ basis: 'margin', cost: 1.1, percent: 35 }) === 1.69);
    check('costo 100 + ganancia fija 15 = 115', P.precioDesde({ basis: 'profit', cost: 100, amount: 15 }) === 115);

    check('margen 100 % se rechaza (precio infinito)', P.precioDesde({ basis: 'margin', cost: 100, percent: 100 }) === null);
    check('margen negativo se rechaza', P.precioDesde({ basis: 'margin', cost: 100, percent: -5 }) === null);
    check('mark-up -100 % se rechaza (precio 0)', P.precioDesde({ basis: 'markup', cost: 100, percent: -100 }) === null);
    check('base manual no deriva precio', P.precioDesde({ basis: 'manual', cost: 100, percent: 35 }) === null);
    check('costo nulo no deriva precio', P.precioDesde({ basis: 'markup', cost: null, percent: 35 }) === null);
    check('costo 0 da precio 0', P.precioDesde({ basis: 'markup', cost: 0, percent: 35 }) === 0);
}

/* ------------------------------------------------------------------ */
titulo('3. Los cuatro ejemplos del acuerdo');
{
    const e1 = P.derivar({ cost: 100, margin: 35, price: 135, profit: 35 }, null, DERIVAR);
    check('Ej.1 base = markup', e1.target.basis === 'markup');
    check('Ej.1 precio = 135', e1.price === 135);
    check('Ej.1 margen realizado = 25,93 %', cerca(e1.realized.margin, 25.925925925925924, 0.001));
    check('Ej.1 mark-up realizado = 35 %', cerca(e1.realized.markup, 35, 0.001));
    check('Ej.1 precio calculado, no manual', e1.priceSource === 'computed');

    const e2 = P.derivar({ cost: 100, margin: null, price: 153.85, profit: 53.85 }, { target: { basis: 'margin', percent: 35 } }, DERIVAR);
    check('Ej.2 base = margin (declarada en el nodo hermano)', e2.target.basis === 'margin');
    check('Ej.2 margen realizado ≈ 35 %', cerca(e2.realized.margin, 35, 0.01));

    const e3 = P.derivar({ cost: 1.1, margin: 35, price: 1.49, profit: 0.39 }, null, DERIVAR);
    check('Ej.3 precio redondeado 1,49 se acepta como calculado', e3.priceSource === 'computed');
    check('Ej.3 margen realizado sobre el precio cobrado = 26,17 %', cerca(e3.realized.margin, 26.174496644295302, 0.01));
    check('Ej.3 el target teórico sigue siendo 25,93 %', cerca(P.margenDesdeMarkupPct(e3.target.percent), 25.925925925925924, 0.001));

    const e4 = P.derivar({ cost: 1.1, margin: null, price: 1.69, profit: 0.59 }, { target: { basis: 'margin', percent: 35 } }, DERIVAR);
    check('Ej.4 margen realizado = 34,91 %', cerca(e4.realized.margin, 34.911242603550295, 0.01));
}

/* ------------------------------------------------------------------ */
titulo('4. Productos reales del inventario');
{
    const normal = P.derivar({ id: 1, code: 'A1', cost: 10, margin: 50, price: 15, profit: 5 }, null, DERIVAR);
    check('producto normal: base markup', normal.target.basis === 'markup');
    check('producto normal: 50 % de mark-up → 33,33 % de margen', cerca(normal.realized.margin, 33.33333333333333, 0.001));
    check('producto normal: schema pricing/2', normal.schema === 'pricing/2');
    check('producto normal: versión 2', normal.pricingVersion === 2);
    check('producto normal: moneda por defecto USD', normal.currency === 'USD');
    check('producto normal: no requiere revisión', normal.needsReview === false);
    check('producto normal: externalId por código', normal.externalId === 'CIERVO-A1');

    const granel = P.derivar({ id: 4, code: 'A4', isBulk: true, unit: 'kg', cost: null, costPerUnit: 4, price: 7, pricePerUnit: 7, profit: 2, profitPerUnit: 2, margin: null }, null, DERIVAR);
    check('granel: costo por unidad = 4', granel.cost === 4);
    check('granel: precio por unidad = 7', granel.price === 7);
    check('granel: base profit (no hay porcentaje)', granel.target.basis === 'profit');
    check('granel: amount = 2', granel.target.amount === 2);
    check('granel: margen realizado = 42,86 %', cerca(granel.realized.margin, 42.857142857142854, 0.001));

    /* Dato viejo: la ganancia solo en `profitPerUnit`, sin `profit`. */
    const granelViejo = P.derivar({ id: 5, isBulk: true, unit: 'kg', cost: null, costPerUnit: 4, price: 6, pricePerUnit: 6, profitPerUnit: 2, margin: null }, null, DERIVAR);
    check('granel sin profit: base profit', granelViejo.target.basis === 'profit');
    check('granel sin profit: amount 2', granelViejo.target.amount === 2);
    check('granel sin profit: precio reconocido como calculado', granelViejo.priceSource === 'computed');

    const manual = P.derivar({ id: 9, cost: 100, margin: 35, price: 120, profit: 20 }, null, DERIVAR);
    check('precio manual no se confunde con calculado', manual.priceSource === 'manual');
    check('precio manual: margen realizado = 16,67 %', cerca(manual.realized.margin, 16.666666666666664, 0.001));
    check('precio manual: el target declarado no se toca', manual.target.percent === 35);

    const huerfano = P.derivar({ id: 'x', cost: 4, price: 6 }, null, DERIVAR);
    check('sin margen ni ganancia: base legacy', huerfano.target.basis === 'legacy');
    check('sin base: needsReview = true', huerfano.needsReview === true);
    check('sin base: priceSource legacy', huerfano.priceSource === 'legacy');
    check('sin base: NUNCA se asume margen', huerfano.target.basis !== 'margin');

    check('realized de producto es estimated (aún no hay ingreso neto)', normal.realized.quality === 'estimated');
}

/* ------------------------------------------------------------------ */
titulo('5. El overlay del nodo hermano manda en la base, no en los números');
{
    const p = { id: 7, cost: 100, margin: 25.93, price: 135, profit: 35 };
    const sin = P.derivar(p, null, DERIVAR);
    check('sin overlay: el campo margin se lee como mark-up', sin.target.basis === 'markup' && sin.target.percent === 25.93);

    /* Par contradictorio: el nodo dice "margin" pero el producto no trae el
       porcentaje. No se inventa: queda marcado para revisión. */
    const cojo = P.derivar({ id: 8, cost: 100, price: 135 }, { target: { basis: 'margin', percent: null } }, DERIVAR);
    check('base porcentual sin porcentaje queda para revisar', cojo.needsReview === true);
    check('y no se deriva precio de la nada', cojo.suggestedPrice === null);

    const con = P.derivar(p, { target: { basis: 'margin', percent: 25.93 } }, DERIVAR);
    check('con overlay: la base declarada manda', con.target.basis === 'margin');
    check('con overlay: el precio guardado no se mueve', con.price === 135);
    check('con overlay: el margen realizado se calcula del precio', cerca(con.realized.margin, 25.925925925925924, 0.001));

    const importado = P.derivar(p, { target: { basis: 'markup', percent: 35 }, priceSource: 'imported' }, DERIVAR);
    check('priceSource del overlay se respeta', importado.priceSource === 'imported');
}

/* ------------------------------------------------------------------ */
titulo('6. Nodo hermano y reconciliación');
{
    check('ruta del nodo hermano', P.rutaPricing('dueno_at_correo_com') === 'BBDD/dueno_at_correo_com/pricingByProduct');

    const mapa = P.mapaPricing([{ id: 1, cost: 10, margin: 50, price: 15 }, { id: 2, cost: 4, price: 6 }], DERIVAR);
    check('mapa indexado por id como cadena', Object.keys(mapa).sort().join(',') === '1,2');
    check('mapa trae el bloque completo', mapa['1'].schema === 'pricing/2' && mapa['1'].target.basis === 'markup');
    check('producto sin base queda marcado', mapa['2'].needsReview === true);

    check('overlayDe encuentra la entrada', P.overlayDe(mapa, { id: 1 }).target.basis === 'markup');
    check('overlayDe tolera ausencia', P.overlayDe(mapa, { id: 99 }) === null);

    /* Reescribir el nodo no puede DEGRADAR una base ya declarada. */
    const previo = { '1': { target: { basis: 'margin', percent: 25.93 }, priceSource: 'computed' } };
    const reescrito = P.mapaPricing([{ id: 1, cost: 100, margin: 25.93, price: 135 }], { overlay: previo, ahora: '2026-11-10T18:00:00.000Z' });
    check('al reescribir se conserva la base margin', reescrito['1'].target.basis === 'margin');
    check('al reescribir se conserva el priceSource', reescrito['1'].priceSource === 'computed');
    const borrado = P.mapaPricing([{ id: 1, cost: 100, margin: 25.93, price: 135 }], { ahora: '2026-11-10T18:00:00.000Z' });
    check('sin overlay (lectura perdida) degrada a markup, nunca a margin', borrado['1'].target.basis === 'markup');

    /* La importación de Excel renumera ids: el externalId por CÓDIGO sobrevive. */
    const antes = P.externalIdDe({ id: 12, code: 'HAR-01' });
    const despues = P.externalIdDe({ id: 3, code: 'HAR-01' });
    check('externalId estable aunque cambie el id', antes === despues && antes === 'CIERVO-HAR-01');
    check('sin código, externalId usa el id', P.externalIdDe({ id: 5 }) === 'CIERVO-ID-5');
}

/* ------------------------------------------------------------------ */
titulo('7. Validaciones del objetivo');
{
    check('mark-up 30 es válido', P.validarObjetivo('markup', 30).ok === true);
    check('mark-up -100 no es válido', P.validarObjetivo('markup', -100).ok === false);
    check('mark-up -99 es válido (producto gancho)', P.validarObjetivo('markup', -99).ok === true);
    check('margen 95 es válido', P.validarObjetivo('margin', 95).ok === true);
    check('margen 96 no es válido', P.validarObjetivo('margin', 96).ok === false);
    check('margen negativo no es válido', P.validarObjetivo('margin', -1).ok === false);
    check('margen vacío no es válido', P.validarObjetivo('margin', '').ok === false);
    check('base ausente no es válida', P.validarObjetivo(undefined, 35).ok === false);
    check('ganancia fija negativa no es válida', P.validarObjetivo('profit', null, -5).ok === false);
    check('ganancia fija 0 es válida', P.validarObjetivo('profit', null, 0).ok === true);
}

/* ------------------------------------------------------------------ */
titulo('8. Texto para la pantalla');
{
    const t = P.textoEquivalente('markup', 35);
    check('el texto muestra el margen equivalente', t.indexOf('25,93') > -1, t);
    check('el texto dice Mark-up', t.indexOf('Mark-up') > -1, t);
    const t2 = P.textoEquivalente('margin', 35);
    check('en base margen muestra el mark-up equivalente', t2.indexOf('53,85') > -1, t2);
    check('sin base avisa en vez de inventar', P.textoEquivalente(undefined, 35).indexOf('Sin base') > -1);
}

/* ------------------------------------------------------------------ */
titulo('9. Las páginas cargan el módulo y ya no dicen "Margen de Ganancia"');
{
    const paginas = ['inventario.html', 'compras.html', 'menu.html', 'calcular_precio_ven.html'];
    paginas.forEach(function (archivo) {
        const html = leer(archivo);
        check(archivo + ' carga precios.js', html.indexOf('<script src="precios.js"></script>') > -1);
        check(archivo + ' no conserva la etiqueta vieja', html.indexOf('Margen de Ganancia') === -1);
    });

    const inv = leer('inventario.html');
    check('inventario etiqueta el campo como mark-up', inv.indexOf('Mark-up sobre costo (%)') > -1);
    check('inventario explica la base en el tooltip', inv.indexOf('sobre el costo') > -1);
    check('inventario exporta la columna como mark-up', inv.indexOf("'Mark-up (%)'") > -1);
    check('inventario sigue leyendo la columna vieja al importar', inv.indexOf("row['Margen (%)']") > -1);

    const calc = leer('calcular_precio_ven.html');
    check('la calculadora ya no llama "Margen Real" al mark-up', calc.indexOf('Margen Real') === -1);
    check('la calculadora muestra el margen sobre venta', calc.indexOf('Margen sobre venta') > -1);

    const config = leer('config.html');
    check('config ya no ofrece el margen global muerto', config.indexOf('precioDefaultMargin') === -1);
    check('config ya no ofrece el redondeo global muerto', config.indexOf('precioRounding') === -1);
}

/* ------------------------------------------------------------------ */
titulo('10. El formulario de inventario: mismo precio y dos bases');
{
    /* Se ejecutan las funciones REALES de inventario.html sobre un DOM falso.
       Lo que se fija: con base mark-up el precio no cambió (100 + 35 % = 135,00),
       con base margen el mismo objetivo da 150,00, y al cambiar de base el
       número se CONVIERTE (50 → 33,33) sin que el precio se mueva. */
    const html = leer('inventario.html');
    const extraer = function (nombre) {
        const re = new RegExp('function ' + nombre + '\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n {8}\\}');
        const m = html.match(re);
        return m ? m[0] : null;
    };

    const fuenteParse = extraer('parseNumber');
    const fuenteBase = extraer('baseElegida');
    const fuenteCalc = extraer('calculatePrice');
    const fuenteEquiv = extraer('actualizarMargenEquivalente');
    const fuenteCambio = extraer('cambiarBasePrecio');
    check('se pudo extraer parseNumber', !!fuenteParse);
    check('se pudo extraer baseElegida', !!fuenteBase);
    check('se pudo extraer calculatePrice', !!fuenteCalc);
    check('se pudo extraer actualizarMargenEquivalente', !!fuenteEquiv);
    check('se pudo extraer cambiarBasePrecio', !!fuenteCambio);

    function montarFormulario(cost, porcentaje, profitFijo, base) {
        const nodos = {
            productCost: { value: String(cost), classList: { add() { }, remove() { } } },
            productMargin: { value: porcentaje === null ? '' : String(porcentaje), style: {}, classList: { add() { }, remove() { } }, setAttribute() { }, removeAttribute() { } },
            productProfitInput: { value: profitFijo === null ? '' : String(profitFijo), style: {}, classList: { add() { }, remove() { } }, setAttribute() { }, removeAttribute() { } },
            productPrice: { value: '' },
            productCalculatedProfit: { value: '' },
            radioMargin: { checked: base === 'markup' },
            radioVenta: { checked: base === 'margin' },
            radioProfit: { checked: base === 'profit' },
            productMarginEquivalent: { textContent: '' }
        };
        const document = { getElementById: (id) => nodos[id] || null };
        const contextoForm = {
            document: document, precios: P, isFinite: isFinite, Number: Number,
            parseFloat: parseFloat, Math: Math, String: String,
            toggleProfitInput: function () { }, showNotification: function () { }
        };
        vm.createContext(contextoForm);
        vm.runInContext('let basePrecioFormulario = "markup";', contextoForm);
        [fuenteParse, fuenteBase, fuenteCalc, fuenteEquiv, fuenteCambio].forEach(function (f, i) {
            if (f) vm.runInContext(f, contextoForm, { filename: 'inventario#f' + i });
        });
        return { nodos: nodos, ctx: contextoForm };
    }

    const a = montarFormulario(100, 35, null, 'markup');
    a.ctx.calculatePrice();
    check('costo 100 + mark-up 35 % sigue dando 135.00', a.nodos.productPrice.value === '135.00', a.nodos.productPrice.value);
    check('la ganancia sigue siendo 35.00', a.nodos.productCalculatedProfit.value === '35.00', a.nodos.productCalculatedProfit.value);
    check('al lado dice Mark-up 35,00 %', a.nodos.productMarginEquivalent.textContent.indexOf('Mark-up 35,00 %') > -1, a.nodos.productMarginEquivalent.textContent);
    check('y muestra el margen sobre venta 25,93 %', a.nodos.productMarginEquivalent.textContent.indexOf('25,93 %') > -1, a.nodos.productMarginEquivalent.textContent);
    check('ya no llama margen al 35', a.nodos.productMarginEquivalent.textContent.indexOf('margen sobre venta 25,93') > -1);

    const b = montarFormulario(100, null, 15, 'profit');
    b.ctx.calculatePrice();
    check('ganancia fija 15 sigue dando 115.00', b.nodos.productPrice.value === '115.00', b.nodos.productPrice.value);
    check('con ganancia fija no se inventa un porcentaje', b.nodos.productMarginEquivalent.textContent.indexOf('Ganancia fija') > -1, b.nodos.productMarginEquivalent.textContent);

    const c = montarFormulario(100, -100, null, 'markup');
    c.ctx.calculatePrice();
    check('mark-up -100 % se bloquea (no da precio 0)', c.nodos.productPrice.value === '', c.nodos.productPrice.value);
    check('y no deja texto de margen colgado', c.nodos.productMarginEquivalent.textContent === '', c.nodos.productMarginEquivalent.textContent);

    const d = montarFormulario(1.1, 35, null, 'markup');
    d.ctx.calculatePrice();
    check('costo 1,10 + mark-up 35 % da 1.49', d.nodos.productPrice.value === '1.49', d.nodos.productPrice.value);
    check('y el margen real sobre el precio redondeado es 26,17 %', d.nodos.productMarginEquivalent.textContent.indexOf('26,17 %') > -1, d.nodos.productMarginEquivalent.textContent);

    /* --- base MARGEN: 34,00 % sobre la venta de un costo 100 → 151,52 --- */
    const e = montarFormulario(100, 34, null, 'margin');
    e.ctx.calculatePrice();
    check('base margen: 34 % sobre venta da 151.52', e.nodos.productPrice.value === '151.52', e.nodos.productPrice.value);
    check('base margen: el texto dice margen y su mark-up', e.nodos.productMarginEquivalent.textContent.indexOf('Margen sobre venta 34,00 %') > -1, e.nodos.productMarginEquivalent.textContent);

    /* --- cambiar de base CONVIERTE el número y el precio no se mueve --- */
    const f = montarFormulario(100, 50, null, 'markup');
    f.ctx.calculatePrice();
    const precioAntes = f.nodos.productPrice.value;
    check('antes del cambio: 50 % de mark-up = 150,00', precioAntes === '150.00', precioAntes);

    f.nodos.radioMargin.checked = false;
    f.nodos.radioVenta.checked = true;
    f.ctx.cambiarBasePrecio('margin');
    const convertido = Number(f.nodos.productMargin.value);
    check('el número se convierte a 33,33 (no sigue 50)', Math.abs(convertido - 33.33) < 0.01, f.nodos.productMargin.value);
    const precioDespues = Number(f.nodos.productPrice.value);
    check('el precio no se mueve al cambiar de base', Math.abs(precioDespues - Number(precioAntes)) <= 0.01, precioAntes + ' → ' + f.nodos.productPrice.value);
    check('el texto ahora explica el mark-up equivalente',
        f.nodos.productMarginEquivalent.textContent.indexOf('mark-up equivalente') > -1, f.nodos.productMarginEquivalent.textContent);

    /* --- y de vuelta a mark-up: 33,33 → 50 --- */
    f.nodos.radioVenta.checked = false;
    f.nodos.radioMargin.checked = true;
    f.ctx.cambiarBasePrecio('markup');
    check('la vuelta convierte 33,33 → 50', Math.abs(Number(f.nodos.productMargin.value) - 50) < 0.02, f.nodos.productMargin.value);
    check('y el precio sigue en 150', Math.abs(Number(f.nodos.productPrice.value) - 150) <= 0.01, f.nodos.productPrice.value);
}

/* ------------------------------------------------------------------ */
titulo('10b. El producto guarda la base sin cambiar el significado de margin');
{
    const html = leer('inventario.html');
    check('el producto guarda pricingBasis', html.indexOf('productData.pricingBasis = baseDelPrecio') > -1);
    check('el objetivo en margen va a marginTarget', html.indexOf('productData.marginTarget = porcentaje') > -1);
    check('margin se guarda convertido a mark-up', html.indexOf('precios.markupDesdeMargenPct(porcentaje)') > -1);
    check('el formulario reabre en la base guardada', html.indexOf('precios.baseDe(product, precios.overlayDe(pricingOverlay, product))') > -1);
    check('el overlay se actualiza al guardar', html.indexOf('pricingOverlay[String(guardado.id)] = precios.derivar') > -1);
    check('los límites del campo dependen de la base', html.indexOf("productMargin.max = esMargen ? '95' : '1000'") > -1);
    check('el margen no admite 100 %', P.validarObjetivo('margin', 100).ok === false);
    check('el mark-up sí admite valores altos', P.validarObjetivo('markup', 300).ok === true);
    check('hay un radio de margen sobre venta', html.indexOf('id="radioVenta"') > -1);

    /* derivar: un producto en base margen conserva su objetivo y su precio. */
    const p = P.derivar({ id: 1, cost: 100, price: 150, profit: 50, margin: 50, marginTarget: 33.33, pricingBasis: 'margin' }, null, { ahora: '2026-11-10T18:00:00.000Z' });
    check('base margin declarada en el producto', p.target.basis === 'margin');
    check('el porcentaje es el de margen (33,33), no el mark-up (50)', Math.abs(p.target.percent - 33.33) < 0.001, p.target.percent);
    check('el precio sugerido sigue siendo ~150', Math.abs(p.suggestedPrice - 150) <= 0.01, p.suggestedPrice);
    check('no requiere revisión si todo cuadra', p.needsReview === false);

    /* Un cliente viejo reescribe price/margin como mark-up: se detecta. */
    const roto = P.derivar({ id: 1, cost: 100, price: 120, profit: 20, margin: 20, marginTarget: 33.33, pricingBasis: 'margin' }, null, { ahora: '2026-11-10T18:00:00.000Z' });
    check('si el precio contradice el objetivo, manda el mark-up', roto.target.basis === 'markup', roto.target.basis);
    check('y el producto queda marcado para revisar', roto.needsReview === true);
}

/* ------------------------------------------------------------------ */
titulo('10c. La calculadora deja elegir la base');
{
    const calc = leer('calcular_precio_ven.html');
    check('la calculadora ofrece la base de mark-up', calc.indexOf('<option value="markup" selected>Mark-up sobre el costo</option>') > -1);
    check('y la de margen sobre venta', calc.indexOf('<option value="margin">Margen sobre la venta</option>') > -1);
    check('el cálculo usa la base elegida', calc.indexOf('precios.precioDesde({ basis: basePrecio,') > -1);
    check('la pista muestra el equivalente', calc.indexOf('precios.textoEquivalente(basePrecio, profitMargin)') > -1);
    check('el historial guarda la base', calc.indexOf('basis: baseGuardar') > -1);
    check('el historial la muestra', calc.indexOf("calc.basis === 'margin' ? 'venta' : 'costo'") > -1);

    /* La cifra de la discordia: 10 al 50 %. */
    check('costo 10, mark-up 50 % → 15', P.precioDesde({ basis: 'markup', cost: 10, percent: 50 }) === 15);
    check('costo 10, margen 50 % → 20', P.precioDesde({ basis: 'margin', cost: 10, percent: 50 }) === 20);
    check('margen 100 % se rechaza en la calculadora', P.precioDesde({ basis: 'margin', cost: 10, percent: 100 }) === null);
}

/* ------------------------------------------------------------------ */
titulo('11. Ventas: descuento por línea, IVA fuera del ingreso y calidad');
{
    /* --- reparto del descuento --- */
    const r1 = P.repartirDescuento([33.33, 33.33, 33.33], 10);
    check('el reparto suma exactamente el descuento', cerca(r1.reduce((a, b) => a + b, 0), 10, 0.0000001), JSON.stringify(r1));
    check('el reparto es proporcional', r1.every(v => Math.abs(v - 3.333) < 0.02), JSON.stringify(r1));
    check('el reparto no pierde el céntimo', r1.filter(v => v === 3.34).length === 1, JSON.stringify(r1));

    const r2 = P.repartirDescuento([100, 50], 15);
    check('reparto 100/50 con 15 → 10 y 5', r2[0] === 10 && r2[1] === 5, JSON.stringify(r2));

    check('sin líneas no hay reparto', P.repartirDescuento([], 10).length === 0);
    check('descuento 0 → todo 0', JSON.stringify(P.repartirDescuento([10, 20], 0)) === '[0,0]');
    check('descuento del 100 % no se pasa', JSON.stringify(P.repartirDescuento([100], 200)) === '[100]');

    /* --- línea nueva --- */
    const linea = P.lineaDeVenta({
        saleId: 'S-001', lineId: 'S-001-1', productId: '123',
        quantity: 1, grossRevenue: 100, discount: 10, taxRate: 0.16,
        exempt: false, cost: 60, currency: 'USD', exchangeRate: 40,
        snapshotAt: '2026-11-10T18:00:00.000Z'
    });
    check('ingreso neto = 90', linea.netRevenue === 90, linea.netRevenue);
    check('IVA 16 % sobre el neto = 14,40', linea.tax === 14.4, linea.tax);
    check('ganancia = 30', linea.profit === 30, linea.profit);
    check('margen = 33,33 %', linea.margin === 33.33, linea.margin);
    check('taxIncluded es false', linea.taxIncluded === false);
    check('la línea lleva versión de precios', linea.pricingVersion === 2);

    const exenta = P.lineaDeVenta({ quantity: 2, grossRevenue: 100, discount: 0, exempt: true, cost: 30, currency: 'USD' });
    check('producto exento no paga IVA', exenta.tax === 0);
    check('el costo de línea es unitario × cantidad', exenta.cost === 60, exenta.cost);
    check('y la ganancia se calcula sobre el neto', exenta.profit === 40, exenta.profit);

    /* --- venta nueva completa --- */
    const ventaNueva = {
        id: 'S-001', currency: 'USD', exchangeRate: 40, ivaApplied: true, taxRate: 0.16,
        totals: { subtotal: 100, discount: 10, iva: 14.4, total: 104.4 },
        items: [{
            product: { id: 123, name: 'Harina', isIvaExempt: false, cost: 60 },
            quantity: 1, unitPrice: 100, subtotal: 100, currency: 'USD',
            saleId: 'S-001', lineId: 'S-001-1', grossRevenue: 100, discount: 10,
            tax: 14.4, taxRate: 0.16, taxIncluded: false, netRevenue: 90,
            cost: 60, profit: 30, margin: 33.33
        }]
    };
    const rn = P.realizadoDeVenta(ventaNueva);
    check('venta nueva: ingreso neto 90', rn.netRevenue === 90, rn.netRevenue);
    check('venta nueva: ganancia 30', rn.profit === 30, rn.profit);
    check('venta nueva: margen 33,33 % (no 40)', rn.margin === 33.33, rn.margin);
    check('venta nueva: calidad final', rn.quality === 'final');

    /* --- el IVA no es ingreso: no mueve el margen --- */
    const conIva = P.realizadoDeVenta(Object.assign({}, ventaNueva, { ivaApplied: true }));
    const sinIva = P.realizadoDeVenta(Object.assign({}, ventaNueva, { ivaApplied: false, taxRate: 0 }));
    check('el IVA no cambia el margen realizado', conIva.margin === sinIva.margin, conIva.margin + ' vs ' + sinIva.margin);

    /* --- venta legacy (sin campos de línea): se reconstruye --- */
    const ventaLegacy = {
        id: 'S-002', currency: 'USD', exchangeRate: 40, ivaApplied: true,
        totals: { subtotal: 100, discount: 10, iva: 14.4, total: 104.4 },
        items: [{
            product: { id: 123, name: 'Harina', isIvaExempt: false, cost: 60 },
            quantity: 1, unitPrice: 100, subtotal: 100, currency: 'USD'
        }]
    };
    const rl = P.realizadoDeVenta(ventaLegacy);
    check('legacy: descuento reconstruido 10', rl.discount === 10, rl.discount);
    check('legacy: ingreso neto 90', rl.netRevenue === 90, rl.netRevenue);
    check('legacy: ganancia 30', rl.profit === 30, rl.profit);
    check('legacy: margen 33,33 %', rl.margin === 33.33, rl.margin);
    check('legacy con datos completos: calidad final', rl.quality === 'final', rl.reasons.join(','));

    /* --- venta legacy en Bs.: totals es USD, las líneas son Bs. --- */
    const ventaVes = {
        id: 'S-003', currency: 'VES', exchangeRate: 40, ivaApplied: true,
        totals: { subtotal: 100, discount: 10, iva: 14.4, total: 104.4 },
        items: [{
            product: { id: 123, name: 'Harina', isIvaExempt: false, cost: 60 },
            quantity: 1, unitPrice: 4000, subtotal: 4000, currency: 'VES'
        }]
    };
    const rv = P.realizadoDeVenta(ventaVes);
    check('VES: el descuento se convierte a Bs. (10 × 40)', rv.discount === 400, rv.discount);
    check('VES: ingreso neto 3.600', rv.netRevenue === 3600, rv.netRevenue);
    check('VES: costo convertido 2.400', rv.cost === 2400, rv.cost);
    check('VES: margen sigue siendo 33,33 %', rv.margin === 33.33, rv.margin);
    check('VES legacy con descuento: calidad estimada', rv.quality === 'estimated', rv.reasons.join(','));
    check('VES legacy: motivo declarado', rv.reasons.indexOf('legacy_currency_mismatch') > -1);

    /* --- venta vieja sin bandera de IVA --- */
    const sinBandera = P.realizadoDeVenta({
        id: 'S-004', currency: 'USD', exchangeRate: 40,
        totals: { subtotal: 100, discount: 0 },
        items: [{ product: { id: 1, isIvaExempt: false, cost: 60 }, quantity: 1, unitPrice: 100, subtotal: 100 }]
    });
    check('sin ivaApplied: calidad estimada', sinBandera.quality === 'estimated');
    check('sin ivaApplied: se declara el motivo', sinBandera.reasons.indexOf('missing_tax_snapshot') > -1);

    /* --- sin costo no se inventa margen --- */
    const sinCosto = P.realizadoDeVenta({
        id: 'S-005', currency: 'USD', exchangeRate: 40, ivaApplied: true,
        totals: { subtotal: 100, discount: 0 },
        items: [{ product: { id: 1, isIvaExempt: false }, quantity: 1, unitPrice: 100, subtotal: 100 }]
    });
    check('sin costo: ganancia nula', sinCosto.profit === null);
    check('sin costo: margen nulo (no 100 %)', sinCosto.margin === null);
    check('sin costo: calidad estimada', sinCosto.quality === 'estimated');

    /* --- la exención sale del snapshot, no del inventario de hoy --- */
    const exentaVenta = P.realizadoDeVenta({
        id: 'S-006', currency: 'USD', exchangeRate: 40, ivaApplied: true,
        totals: { subtotal: 100, discount: 0 },
        items: [{ product: { id: 1, isIvaExempt: true, cost: 60 }, quantity: 1, unitPrice: 100, subtotal: 100 }]
    });
    check('exento en el snapshot: impuesto 0', exentaVenta.tax === 0, exentaVenta.tax);
    check('exento en el snapshot: margen 40 %', exentaVenta.margin === 40, exentaVenta.margin);

    /* --- varias líneas: el descuento de la venta se reparte entero --- */
    const ventaDos = {
        id: 'S-007', currency: 'USD', exchangeRate: 40, ivaApplied: true,
        totals: { subtotal: 150, discount: 15, iva: 21.6, total: 156.6 },
        items: [
            { product: { id: 1, isIvaExempt: false, cost: 40 }, quantity: 1, unitPrice: 100, subtotal: 100 },
            { product: { id: 2, isIvaExempt: false, cost: 20 }, quantity: 1, unitPrice: 50, subtotal: 50 }
        ]
    };
    const rd = P.realizadoDeVenta(ventaDos);
    check('dos líneas: descuento repartido completo', rd.discount === 15, rd.discount);
    check('dos líneas: descuentos 10 y 5', rd.lines[0].discount === 10 && rd.lines[1].discount === 5,
        rd.lines.map(l => l.discount).join(','));
    check('dos líneas: la suma de descuentos es la de la venta',
        cerca(rd.lines.reduce((a, l) => a + l.discount, 0), rd.discount, 0.0000001));
    check('dos líneas: ingreso neto 135', rd.netRevenue === 135, rd.netRevenue);
    check('dos líneas: ganancia 75', rd.profit === 75, rd.profit);
    check('dos líneas: margen 55,56 %', rd.margin === 55.56, rd.margin);
}

/* ------------------------------------------------------------------ */
titulo('12. El resumen de ventas ya no usa el inventario de hoy');
{
    const html = leer('mini_market_pos_resumen.html');

    function extraerPlana(fuente, nombre) {
        const re = new RegExp('function ' + nombre + '\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n\\}');
        const m = fuente.match(re);
        return m ? m[0] : null;
    }

    const fuenteTotales = extraerPlana(html, 'recalculateTotalFromItems');
    const fuenteRealizado = extraerPlana(html, 'calcularRealizadoVenta');
    check('se pudo extraer recalculateTotalFromItems', !!fuenteTotales);
    check('se pudo extraer calcularRealizadoVenta', !!fuenteRealizado);

    /* El contexto NO define `mainInventory`: si la función volviera a mirar el
       inventario actual, reventaría. Es la prueba de que usa el snapshot. */
    function montar(conMotor) {
        const ctx = { isFinite: isFinite, Number: Number, Math: Math, Array: Array };
        if (conMotor) ctx.precios = P;
        vm.createContext(ctx);
        if (fuenteTotales) vm.runInContext(fuenteTotales, ctx, { filename: 'resumen#recalculateTotalFromItems' });
        if (fuenteRealizado) vm.runInContext(fuenteRealizado, ctx, { filename: 'resumen#calcularRealizadoVenta' });
        return ctx;
    }

    /* --- totales de una venta vieja en USD, con 10 % de descuento --- */
    const venta = {
        currency: 'USD', exchangeRate: 40, ivaApplied: true,
        totals: { subtotal: 100, discount: 10, iva: 14.4, total: 104.4 },
        items: [{ product: { id: 1, isIvaExempt: false, cost: 60 }, quantity: 1, unitPrice: 100, subtotal: 100 }]
    };
    const a = montar(true);
    const t = a.recalculateTotalFromItems(venta);
    check('totales: subtotal 100', t.subtotal === 100, t.subtotal);
    check('totales: descuento 10', t.discount === 10, t.discount);
    check('totales: IVA 14,40', cerca(t.iva, 14.4, 0.0001), t.iva);
    check('totales: total 104,40', cerca(t.total, 104.4, 0.0001), t.total);

    /* --- la misma venta, pero el producto HOY está marcado exento --- */
    const exenta = JSON.parse(JSON.stringify(venta));
    exenta.items[0].product.isIvaExempt = true;
    const te = a.recalculateTotalFromItems(exenta);
    check('exenta en el snapshot: IVA 0', te.iva === 0, te.iva);
    check('exenta en el snapshot: total 90', te.total === 90, te.total);

    /* --- venta en Bs.: totals.discount está en USD y hay que convertirlo --- */
    const ves = {
        currency: 'VES', exchangeRate: 40, ivaApplied: true,
        totals: { subtotal: 100, discount: 10, iva: 14.4, total: 104.4 },
        items: [{ product: { id: 1, isIvaExempt: false, cost: 60 }, quantity: 1, unitPrice: 4000, subtotal: 4000 }]
    };
    const tv = a.recalculateTotalFromItems(ves);
    check('VES: descuento convertido a 400', tv.discount === 400, tv.discount);
    check('VES: total 3.600 + IVA sobre 3.600', cerca(tv.total, 3600 + 3600 * 0.16, 0.0001), tv.total);

    /* --- margen realizado desde el resumen --- */
    const r = a.calcularRealizadoVenta(venta);
    check('resumen: ingreso neto 90', r.netUsd === 90, r.netUsd);
    check('resumen: ganancia 30 (no 40)', r.profitUsd === 30, r.profitUsd);
    check('resumen: calidad final', r.quality === 'final');

    const sinMotor = montar(false);
    const r2 = sinMotor.calcularRealizadoVenta(venta);
    check('sin módulo: cae al cálculo antiguo', r2.profitUsd === 40, r2.profitUsd);
    check('sin módulo: y lo declara estimado, no lo disfraza', r2.quality === 'estimated');

    /* --- estático: el resumen ya no busca la exención en el inventario --- */
    check('el resumen ya no consulta mainInventory para el IVA',
        html.indexOf('mainInventory.find(p => p.id === item.product.id)') === -1);
    check('el resumen usa el módulo de precios', html.indexOf('precios.realizadoDeVenta(sale)') > -1);
    check('el resumen muestra el margen realizado', html.indexOf('Margen realizado') > -1);
    check('el resumen explica las ventas excluidas', html.indexOf('calidad estimada') > -1);
    check('el resumen carga precios.js', html.indexOf('<script src="precios.js"></script>') > -1);
    check('pantalla y PDF usan el mismo margen',
        (html.match(/calcularRealizadoVenta\(sale\)/g) || []).length >= 2);
    check('el POS carga el módulo de precios',
        leer('mini_market_pos.html').indexOf('<script src="precios.js"></script>') > -1);
}

/* ------------------------------------------------------------------ */
titulo('13. El POS escribe las líneas con ingreso neto');
{
    const pos = leer('mini_market_pos.html');
    check('el POS usa el módulo para las líneas', pos.indexOf('precios.lineaDeVenta(') > -1);
    check('el POS reparte el descuento por línea', pos.indexOf('precios.repartirDescuento(') > -1);
    check('el POS guarda el esquema de ventas', pos.indexOf('salesSchema: 2') > -1);
    check('el POS guarda la alícuota en la venta', pos.indexOf('taxRate: applyIVA ? IVA_RATE : 0') > -1);
    check('el POS guarda el descuento aplicado', pos.indexOf('discountPercent: currentDiscount') > -1);
    check('los totales guardados son los mismos que se calcularon', pos.indexOf('totals: totalesVenta') > -1);
    check('la alícuota ya no está escrita a mano', pos.indexOf('* 0.16') === -1);
    check('la alícuota vive en una constante', pos.indexOf('const IVA_RATE = 0.16;') > -1);
    /* La línea conserva lo que ya leían el ticket y el resto de la app. */
    check('la línea conserva product/unitPrice/subtotal', pos.indexOf('unitPrice: l.unitPrice,') > -1 && pos.indexOf('subtotal: l.subtotal,') > -1);
}

/* ------------------------------------------------------------------ */
console.log('\n' + '='.repeat(60));
console.log('RESUMEN: ' + pruebas + ' comprobaciones · ' + (pruebas - fallos) + ' OK · ' + fallos + ' fallos');
console.log('='.repeat(60));
process.exit(fallos === 0 ? 0 : 1);
