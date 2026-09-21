/* =====================================================================
   PRUEBAS DE LAS RESERVAS DE CARRITO ENTRE PESTAÑAS Y DE LA RE-LECTURA
   DEL STOCK AL CONFIRMAR LA VENTA

   Se ejecuta con:  node pruebas_reservas_carrito.js

   QUÉ SE PRUEBA
   -------------
   El fallo real: el stock es un número que cada pestaña carga en memoria al
   abrir. Con DOS pestañas se puede vender la última unidad dos veces (la A
   vende y guarda 0; la B no vuelve a leer y cobra igual). El antiguo candado
   `sessionStorage['currentUser']` NO protegía nada (sessionStorage se copia
   entre pestañas y el mismo operador puede entrar en las dos).

   Las dos piezas que se comprueban, SIEMPRE sobre el código REAL del POS
   (se extraen las funciones del HTML y se ejecutan en `vm`):
     A) `processSale` vuelve a leer el inventario del almacén compartido justo
        antes de registrar la venta, descuenta las reservas de OTRAS pestañas,
        avisa con el detalle y pide confirmación (por defecto avisa y permite;
        `BLOQUEAR_SIN_STOCK = true` lo cambia a bloqueo). Si se vende por
        debajo, la venta queda marcada con `ventaSobrestock: true`.
     B) Cada pestaña APARTA en `localStorage['pos_reservas_carrito']` (nunca
        sessionStorage) las unidades de su carrito, con caducidad de 15 minutos.
        El DISPONIBLE para esta pestaña = stock real − reservas de las DEMÁS.

   CÓMO (dos pestañas de verdad, en memoria)
   -----------------------------------------
   Cada "pestaña" es un contexto de `vm` con sus propias variables (`cart`,
   `RESERVA_TAB_ID`, ...) que COMPARTE el mismo objeto localStorage con la otra:
   exactamente lo que ocurre entre dos pestañas del mismo navegador (o dos
   equipos, si comparten el almacén).

   Formato: OK/FALLA por comprobación, resumen final y código de salida.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = __dirname;
const ARCHIVO_POS = path.join(RAIZ, 'mini_market_pos.html');
const ARCHIVO_DATOS_CUENTA = path.join(RAIZ, 'datos_cuenta.js');

let ok = 0, fallos = 0;
const check = (nombre, condicion, extra = '') => {
    if (condicion) { ok++; console.log('OK    ' + nombre); }
    else { fallos++; console.log('FALLA ' + nombre + (extra !== '' ? '  -> ' + extra : '')); }
};
const titulo = (t) => console.log('\n' + t);
const nota = (t) => console.log('      ' + t);

/* =====================================================================
   0. EXTRACCIÓN DEL CÓDIGO REAL DEL POS
   ===================================================================== */

/** Devuelve el bloque `{ ... }` que abre a partir de la posición `desde`. */
function extraerBloque(texto, desde) {
    const abre = texto.indexOf('{', desde);
    if (abre === -1) throw new Error('sin llave de apertura');
    let nivel = 0;
    for (let k = abre; k < texto.length; k++) {
        if (texto[k] === '{') nivel++;
        else if (texto[k] === '}') { nivel--; if (nivel === 0) return texto.slice(desde, k + 1); }
    }
    throw new Error('bloque sin cerrar');
}

/** Extrae una función declarada: `function nombre(...) { ... }` (respeta `async`). */
function extraerFuncion(texto, nombre) {
    const marca = 'function ' + nombre + '(';
    const i = texto.indexOf(marca);
    if (i === -1) throw new Error('no se encontró la función ' + nombre);
    const antes = texto.slice(Math.max(0, i - 6), i);
    return extraerBloque(texto, /async\s$/.test(antes) ? i - 6 : i);
}

/** Extrae una declaración `const|var|let nombre = ...;` del código real. */
function extraerDeclaracion(texto, nombre) {
    const re = new RegExp('(?:const|var|let)\\s+' + nombre + '\\s*=[^;]*;');
    const m = re.exec(texto);
    if (!m) throw new Error('no se encontró la declaración ' + nombre);
    return m[0];
}

/** Bloque <script> en línea (mismo criterio que _diag_sintaxis.js). */
function bloquesEnLinea(html) {
    const bloques = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const atributos = m[1] || '';
        if (/\bsrc\s*=/.test(atributos)) continue;
        const tipo = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(atributos) || [])[1] || '';
        const t = tipo.toLowerCase();
        if (!(t === '' || t === 'text/javascript' || t === 'application/javascript' ||
            t === 'module' || t === 'text/ecmascript')) continue;
        bloques.push({ codigo: m[2], linea: html.slice(0, m.index).split('\n').length });
    }
    return bloques;
}

const BYTES_POS = fs.readFileSync(ARCHIVO_POS);
const HTML_POS = BYTES_POS.toString('utf8').replace(/\r\n/g, '\n');
const BLOQUES_POS = bloquesEnLinea(HTML_POS);
const BLOQUE_APP = BLOQUES_POS.find(b => /function processSale\s*\(/.test(b.codigo));

titulo('0. Extracción del código real del POS y compilación de los bloques en línea');

let crlf = 0, lf = 0;
for (let i = 0; i < BYTES_POS.length; i++) {
    if (BYTES_POS[i] === 10) { lf++; if (i > 0 && BYTES_POS[i - 1] === 13) crlf++; }
}
check('mini_market_pos.html mantiene CRLF en todas sus líneas',
    lf > 0 && crlf === lf, 'LF=' + lf + ' CRLF=' + crlf);

check('se encontró el bloque principal del POS', !!BLOQUE_APP);

let bloquesCompilan = true, detalleCompilacion = '';
BLOQUES_POS.forEach(function (b, i) {
    try {
        new vm.Script(b.codigo, { filename: 'mini_market_pos.html#script' + (i + 1) });
    } catch (e) {
        bloquesCompilan = false;
        detalleCompilacion = 'script #' + (i + 1) + ': ' + e.message;
    }
});
check('los bloques en línea de mini_market_pos.html compilan (new vm.Script)',
    bloquesCompilan, detalleCompilacion);

/* Funciones reales que forman el núcleo de A y B. */
const FUNCIONES_NUCLEO = [
    'leerInventarioReal', 'stockRealDe', 'leerReservasCrudas', 'escribirReservas',
    'reservasVigentes', 'reservasDeOtrasPestanas', 'disponibleParaPestana',
    'refrescarReservasCarrito', 'liberarReservasPropias', 'textoCantidad', 'textoApartadas',
    'avisoSinDisponible', 'limiteDisponibleActual', 'openQuantityModal',
    'confirmQuantity', 'revisarStockParaVenta',
    'detalleFaltantesStock', 'pedirConfirmacionSinStock', 'reactivarBotonConfirmar',
    'parseNumber', 'addToCart', 'removeFromCart', 'updateQuantity', 'updateInventory',
    'calculateSaleTotals', 'processSale', 'resetSale'
];
const CONSTANTES_NUCLEO = [
    'RESERVAS_CLAVE', 'RESERVA_CADUCIDAD_MS', 'RESERVA_TAB_ID', 'RESERVA_EPSILON',
    'BLOQUEAR_SIN_STOCK'
];

/** Extrae el registro real del manejador de `pagehide`. */
function extraerRegistroPagehide(texto) {
    const i = texto.indexOf("window.addEventListener('pagehide'");
    if (i === -1) throw new Error('no se encontró el registro de pagehide');
    const fin = texto.indexOf('});', i);
    if (fin === -1) throw new Error('registro de pagehide sin cerrar');
    return texto.slice(i, fin + 3);
}

/** Fuente con las CONSTANTES + el manejador de pagehide + las funciones reales. */
function construirFuenteReal(bloque) {
    const trozos = [];
    CONSTANTES_NUCLEO.forEach(n => trozos.push(extraerDeclaracion(bloque, n)));
    trozos.push(extraerRegistroPagehide(bloque));
    FUNCIONES_NUCLEO.forEach(n => trozos.push(extraerFuncion(bloque, n)));
    return trozos.join('\n\n');
}

let FUENTE_REAL = null, errorExtraccion = '';
try { FUENTE_REAL = construirFuenteReal(BLOQUE_APP.codigo); }
catch (e) { errorExtraccion = e.message; }

check('se pudieron extraer las funciones y constantes reales del POS',
    FUENTE_REAL !== null, errorExtraccion);

let fuenteCompila = false, errorFuente = '';
try { new vm.Script(FUENTE_REAL); fuenteCompila = true; } catch (e) { errorFuente = e.message; }
check('las funciones extraídas compilan (new vm.Script)', fuenteCompila, errorFuente);

FUNCIONES_NUCLEO.forEach(function (n) {
    check('extraída del POS: function ' + n + '()',
        FUENTE_REAL !== null && FUENTE_REAL.indexOf('function ' + n + '(') !== -1);
});

/* =====================================================================
   1. ALMACÉN COMPARTIDO Y "PESTAÑAS"
   ===================================================================== */

/** localStorage compartido por las "pestañas" (mismo objeto para todas). */
function almacenCompartido(inicial) {
    const datos = new Map();
    Object.keys(inicial || {}).forEach(k => datos.set(String(k), String(inicial[k])));
    return {
        _datos: datos,
        getItem: function (k) { k = String(k); return datos.has(k) ? datos.get(k) : null; },
        setItem: function (k, v) { datos.set(String(k), String(v)); },
        removeItem: function (k) { datos.delete(String(k)); },
        clear: function () { datos.clear(); },
        key: function (i) {
            const ks = Array.from(datos.keys());
            const n = Number(i);
            return (n >= 0 && n < ks.length) ? ks[n] : null;
        },
        get length() { return datos.size; }
    };
}

/** Documento falso mínimo (solo lo que tocan las funciones reales). */
function crearDocumentoFalso() {
    const nodos = {};
    function crearNodo(id) {
        const clases = new Set();
        return {
            id: id, value: '', textContent: '', innerHTML: '', disabled: false,
            dataset: {}, style: {}, _clases: clases,
            classList: {
                add: function (c) { clases.add(c); },
                remove: function (c) { clases.delete(c); },
                contains: function (c) { return clases.has(c); },
                toggle: function (c, f) {
                    if (f === undefined) { if (clases.has(c)) clases.delete(c); else clases.add(c); }
                    else if (f) clases.add(c); else clases.delete(c);
                }
            },
            focus: function () {}, appendChild: function () {}, remove: function () {},
            querySelectorAll: function () { return []; }, querySelector: function () { return null; }
        };
    }
    return {
        _nodos: nodos,
        body: crearNodo('body'),
        getElementById: function (id) {
            if (!nodos[id]) nodos[id] = crearNodo(id);
            return nodos[id];
        },
        querySelectorAll: function () { return []; },
        querySelector: function () { return null; },
        createElement: function (etiqueta) { return crearNodo('_' + etiqueta); },
        addEventListener: function () {}
    };
}

/* Estado y dobles mínimos que el POS real ya tiene en la página. */
const STUBS = `
    var ventas = [];
    var cart = [];
    var inventoryProducts = [];
    var currentProductToAdd = null;
    var currentCurrency = 'USD';
    var exchangeRate = 36.5;
    var currentDiscount = 0;
    var applyIVA = false;
    var selectedPaymentMethod = 'usd-cash';
    var paymentDetails = {};
    var customerData = null;
    var heldCarts = [];
    var saleId = 'V-0001';
    var rateMode = 'manual';
    var rateSource = 'bcv';
    var _opsModo = 'clasico';
    var _fbPending = false;

    function showToast(m) { __avisos.push(String(m)); }
    function updateCartUI() {}
    function updateTotals() {}
    function toggleTotalsDetails() {}
    function peekSaleId() { return 'V-0001'; }
    function reserveSaleId() { return Promise.resolve('V-0001'); }
    function showConfirmModal() {}
    function closeConfirmModal() {}
    function closeProcessModal() {}
    function printReceipt() {}
    function loadInventoryProducts() {}
    function renderProductList() {}
    function marcarPendienteSync() {}
    function limpiarPendienteSync() {}
    function fbSaveVentas() { return Promise.resolve(true); }
    function fbSaveProductos() { return Promise.resolve(true); }
    function fbUpsertClient() { return Promise.resolve(true); }
    function modoOperacionesActivo() { return false; }
    function esperarModoSync() {}
    function actualizarPuntoEstadoOps() {}
    function anotarVentaSinOperacion() {}
    function setFirebaseDot() {}
    function calculateFinalTotalInUsd() { return 0; }
    function getStockLevel() { return 'high'; }
    function escapeHtml(s) { return String(s == null ? '' : s); }
`;

/**
 * Crea una "pestaña": contexto de vm con su propio carrito y su propio id, que
 * comparte el localStorage con las demás pestañas.
 */
function crearPestana(almacen, tabId, opciones) {
    const op = opciones || {};
    const avisos = [];
    const errores = [];
    const confirmaciones = [];
    const manejadores = {};
    const usosSession = [];
    const documento = crearDocumentoFalso();

    const sessionStorageFalso = {
        getItem: function (k) { usosSession.push('getItem:' + k); return null; },
        setItem: function (k) { usosSession.push('setItem:' + k); },
        removeItem: function (k) { usosSession.push('removeItem:' + k); }
    };

    const ctx = {
        console: {
            log: function () {},
            warn: function () {},
            error: function () { errores.push(Array.prototype.slice.call(arguments).map(String).join(' ')); }
        },
        JSON: JSON, Date: Date, Math: Math, Object: Object, Array: Array,
        String: String, Number: Number, Boolean: Boolean,
        isFinite: isFinite, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
        Promise: Promise,
        setTimeout: function () { return 0; }, clearTimeout: function () {},
        localStorage: almacen,
        sessionStorage: sessionStorageFalso,
        document: documento,
        __avisos: avisos,
        confirm: function (mensaje) {
            confirmaciones.push(mensaje);
            return op.confirmar === true;
        }
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    ctx.window.addEventListener = function (evento, fn) {
        if (!manejadores[evento]) manejadores[evento] = [];
        manejadores[evento].push(fn);
    };

    vm.createContext(ctx);
    vm.runInContext(STUBS, ctx, { filename: 'mini_market_pos.html (estado del POS)' });
    vm.runInContext(op.fuente || FUENTE_REAL, ctx, { filename: 'mini_market_pos.html (funciones reales)' });
    vm.runInContext('RESERVA_TAB_ID = ' + JSON.stringify(String(tabId)) + ';', ctx);

    return {
        tabId: tabId,
        ctx: ctx,
        avisos: avisos,
        errores: errores,
        confirmaciones: confirmaciones,
        manejadores: manejadores,
        usosSession: usosSession,
        documento: documento,
        leer: function (expresion) { return vm.runInContext(expresion, ctx); },
        correr: function (codigo) { return vm.runInContext(codigo, ctx); },
        ultimoAviso: function () { return avisos.length ? avisos[avisos.length - 1] : ''; },
        limpiarAvisos: function () { avisos.length = 0; }
    };
}

/* ------------------------------ utilidades ------------------------------ */

function producto(id, nombre, stock, extra) {
    return Object.assign({
        id: id, name: nombre, stock: stock, price: 1, isBulk: false, unit: 'unidades'
    }, extra || {});
}

const HARINA1 = producto('p1', 'Harina P.A.N.', 1);
const ARROZ5 = producto('p5', 'Arroz Mary', 5);

function inventario(almacen, lista) {
    almacen.setItem('ciervo_inventory', JSON.stringify(lista));
}

function stockEnDisco(almacen, id) {
    try {
        const lista = JSON.parse(almacen.getItem('ciervo_inventory') || '[]');
        const p = lista.find(x => String(x.id) === String(id));
        return p ? Number(p.stock) : null;
    } catch (e) { return null; }
}

function leerReservas(almacen) {
    try { return JSON.parse(almacen.getItem('pos_reservas_carrito') || 'null'); }
    catch (e) { return null; }
}

function reservaDe(almacen, tabId, productoId) {
    const r = leerReservas(almacen);
    if (!r || !r[tabId] || !r[tabId][productoId]) return 0;
    return Number(r[tabId][productoId].cantidad) || 0;
}

function disponible(tab, prod) {
    return tab.correr('disponibleParaPestana(' + JSON.stringify(prod) + ')');
}

function agregar(tab, prod, cantidad) {
    tab.correr('addToCart(' + JSON.stringify(prod) + ', ' + cantidad + ", 'unidades')");
}

/* =====================================================================
   LAS PRUEBAS
   ===================================================================== */

(async function principal() {

    /* ------------------------------------------------------------------ */
    titulo('1. Stock 1 con DOS pestañas: A aparta la última unidad y B no puede agregarla');
    {
        const almacen = almacenCompartido();
        inventario(almacen, [HARINA1]);
        const A = crearPestana(almacen, 'tab-A');
        const B = crearPestana(almacen, 'tab-B');

        agregar(A, HARINA1, 1);
        check('A agregó 1 unidad al carrito',
            A.leer('cart.length') === 1 && A.leer('cart[0].quantity') === 1);
        check('A dejó su reserva en localStorage (compartida entre pestañas)',
            reservaDe(almacen, 'tab-A', 'p1') === 1);
        const r = leerReservas(almacen);
        check('la reserva guarda su caducidad (ts numérico)',
            !!r && typeof r['tab-A'].p1.ts === 'number');
        check('el stock en disco NO se altera al agregar al carrito',
            stockEnDisco(almacen, 'p1') === 1);
        check('B ve disponible 0 (la unidad está apartada por A)',
            disponible(B, HARINA1) === 0);

        agregar(B, HARINA1, 1);
        check('B no pudo agregar (su carrito queda vacío)', B.leer('cart.length') === 0);
        check('B recibió un aviso claro con el detalle',
            /quedan 0 unidades/.test(B.ultimoAviso()) && /otra pestaña/.test(B.ultimoAviso()),
            B.ultimoAviso());
        nota('aviso que ve B: ' + B.ultimoAviso());

        /* Y por la puerta normal de la interfaz (el modal de cantidad): */
        B.correr('inventoryProducts = [' + JSON.stringify(HARINA1) + ']');
        B.correr("openQuantityModal('p1')");
        check('el modal de cantidad no se abre para B',
            B.documento.getElementById('quantityModal').classList.contains('active') === false);
        check('el modal avisa con el detalle en castellano llano',
            /quedan 0 unidades/.test(B.ultimoAviso()) && /otra pestaña/.test(B.ultimoAviso()),
            B.ultimoAviso());
        check('B nunca tocó sessionStorage', B.usosSession.length === 0);
    }

    /* ------------------------------------------------------------------ */
    titulo('2. A vacía el carrito → B vuelve a ver la unidad');
    {
        const almacen = almacenCompartido();
        inventario(almacen, [HARINA1]);
        const A = crearPestana(almacen, 'tab-A');
        const B = crearPestana(almacen, 'tab-B');

        agregar(A, HARINA1, 1);
        A.correr("removeFromCart('p1')");
        check('A quitó el producto del carrito', A.leer('cart.length') === 0);
        check('la reserva de A se liberó', reservaDe(almacen, 'tab-A', 'p1') === 0);
        check('B vuelve a ver disponible 1', disponible(B, HARINA1) === 1);
        agregar(B, HARINA1, 1);
        check('B ya puede agregar la unidad', B.leer('cart[0].quantity') === 1);

        /* Vaciado por la vía real del POS (resetSale es lo que vacía el carrito): */
        const almacen2 = almacenCompartido();
        inventario(almacen2, [HARINA1]);
        const A2 = crearPestana(almacen2, 'tab-A2');
        const B2 = crearPestana(almacen2, 'tab-B2');
        agregar(A2, HARINA1, 1);
        check('antes de vaciar, B2 no ve la unidad', disponible(B2, HARINA1) === 0);
        A2.correr('resetSale(false)');
        check('vaciar el carrito (resetSale) libera la reserva',
            reservaDe(almacen2, 'tab-A2', 'p1') === 0);
        check('B2 vuelve a ver disponible 1 tras vaciar', disponible(B2, HARINA1) === 1);
    }

    /* ------------------------------------------------------------------ */
    titulo('3. Reserva caducada: se ignora y las unidades vuelven a estar disponibles');
    {
        const almacen = almacenCompartido();
        inventario(almacen, [HARINA1]);
        const B = crearPestana(almacen, 'tab-B');

        almacen.setItem('pos_reservas_carrito', JSON.stringify({
            'tab-Z': { p1: { cantidad: 1, ts: Date.now() - (15 * 60 * 1000 + 5000) } }
        }));
        check('B ve disponible 1 (la reserva caducada no cuenta)',
            disponible(B, HARINA1) === 1);
        check('la reserva caducada se limpió del almacén compartido',
            reservaDe(almacen, 'tab-Z', 'p1') === 0);
        agregar(B, HARINA1, 1);
        check('B puede agregar la unidad', B.leer('cart[0].quantity') === 1);

        /* Control: una reserva RECIENTE de otra pestaña sí aparta. */
        almacen.setItem('pos_reservas_carrito', JSON.stringify({
            'tab-Z': { p1: { cantidad: 1, ts: Date.now() } }
        }));
        check('una reserva reciente sí aparta la unidad (control)',
            disponible(B, HARINA1) === 0);
    }

    /* ------------------------------------------------------------------ */
    titulo('4. Stock 5: A aparta 2, B agrega 3 (permitido); B intentando 4 recibe aviso');
    {
        const almacen = almacenCompartido();
        inventario(almacen, [ARROZ5]);
        const A = crearPestana(almacen, 'tab-A');
        const B = crearPestana(almacen, 'tab-B');

        agregar(A, ARROZ5, 2);
        check('A apartó 2', reservaDe(almacen, 'tab-A', 'p5') === 2);
        check('B ve disponible 3 (5 − 2)', disponible(B, ARROZ5) === 3);

        agregar(B, ARROZ5, 3);
        check('B pudo agregar 3', B.leer('cart[0].quantity') === 3);
        check('las reservas de las dos pestañas suman 5',
            reservaDe(almacen, 'tab-A', 'p5') + reservaDe(almacen, 'tab-B', 'p5') === 5);
        check('el stock en disco sigue siendo 5 (nadie ha vendido)',
            stockEnDisco(almacen, 'p5') === 5);

        B.correr("removeFromCart('p5')");
        check('B liberó sus 3 (disponible 3 otra vez)',
            disponible(B, ARROZ5) === 3 && reservaDe(almacen, 'tab-B', 'p5') === 0);

        B.limpiarAvisos();
        agregar(B, ARROZ5, 4);
        check('B NO pudo agregar 4 (solo hay 3 disponibles)', B.leer('cart.length') === 0);
        check('el aviso dice cuánto queda', /quedan 3 unidades/.test(B.ultimoAviso()),
            B.ultimoAviso());
        nota('aviso que ve B: ' + B.ultimoAviso());

        agregar(B, ARROZ5, 1);
        B.correr("updateQuantity('p5', 5)");
        check('cambiar la cantidad a 5 se corta en el disponible (3)',
            B.leer('cart[0].quantity') === 3);
        check('las reservas siguen cuadrando (2 + 3 = 5)',
            reservaDe(almacen, 'tab-A', 'p5') + reservaDe(almacen, 'tab-B', 'p5') === 5);
    }

    /* ------------------------------------------------------------------ */
    titulo('5. Confirmar la venta con el carrito desactualizado (otra pestaña vendió antes)');
    {
        /* (a) El vendedor CONFIRMA: la venta se registra y queda marcada. */
        const almacen = almacenCompartido();
        inventario(almacen, [HARINA1]);
        const A = crearPestana(almacen, 'tab-A', { confirmar: true });
        agregar(A, HARINA1, 1);
        /* Otra pestaña vendió la última unidad: el almacén compartido ya está en 0. */
        inventario(almacen, [producto('p1', 'Harina P.A.N.', 0)]);

        A.limpiarAvisos();
        await A.correr('processSale()');

        check('el POS no lanzó ningún error', A.errores.length === 0, A.errores.join(' | '));
        check('se pidió confirmación ANTES de registrar la venta',
            A.confirmaciones.length === 1);
        check('el aviso trae el detalle pedido ("En el sistema quedan N unidades de «X»")',
            /En el sistema quedan 0 unidades de «Harina P\.A\.N\.»/.test(A.confirmaciones[0] || ''),
            (A.confirmaciones[0] || '').split('\n')[0]);
        nota('detalle del aviso: ' +
            ((A.confirmaciones[0] || '').split('\n').filter(l => l.trim() !== '')[1] || ''));

        const ventasA = A.leer('ventas');
        check('la venta se registró', Array.isArray(ventasA) && ventasA.length === 1);
        check('la venta queda marcada con ventaSobrestock: true',
            !!ventasA[0] && ventasA[0].ventaSobrestock === true);
        check('la venta se guardó en pos_sales',
            JSON.parse(almacen.getItem('pos_sales') || '[]').length === 1);
        check('las reservas de la pestaña se liberaron al cerrar la venta',
            reservaDe(almacen, 'tab-A', 'p1') === 0);

        /* (b) El vendedor CANCELA: no se registra nada y el carrito queda intacto. */
        const almacen2 = almacenCompartido();
        inventario(almacen2, [HARINA1]);
        const B = crearPestana(almacen2, 'tab-B', { confirmar: false });
        agregar(B, HARINA1, 1);
        inventario(almacen2, [producto('p1', 'Harina P.A.N.', 0)]);
        B.limpiarAvisos();
        await B.correr('processSale()');

        check('no se registró ninguna venta', B.leer('ventas.length') === 0);
        check('no se escribió pos_sales', almacen2.getItem('pos_sales') === null);
        check('el carrito queda intacto (1 unidad)',
            B.leer('cart.length') === 1 && B.leer('cart[0].quantity') === 1);
        check('se avisó de la cancelación', /Venta cancelada/.test(B.ultimoAviso()),
            B.ultimoAviso());
        check('el botón de confirmar quedó usable otra vez',
            B.documento.getElementById('confirmActionBtn').disabled === false);

        /* (b2) El interruptor de bloqueo (una sola línea) bloquea la venta. */
        const fuenteBloqueo = FUENTE_REAL.replace(
            'const BLOQUEAR_SIN_STOCK = false;', 'const BLOQUEAR_SIN_STOCK = true;');
        check('el interruptor BLOQUEAR_SIN_STOCK se puede poner en true (una línea)',
            fuenteBloqueo !== FUENTE_REAL);
        const almacen3 = almacenCompartido();
        inventario(almacen3, [HARINA1]);
        const C = crearPestana(almacen3, 'tab-C', { confirmar: true, fuente: fuenteBloqueo });
        agregar(C, HARINA1, 1);
        inventario(almacen3, [producto('p1', 'Harina P.A.N.', 0)]);
        await C.correr('processSale()');
        check('con BLOQUEAR_SIN_STOCK = true la venta NO se registra',
            C.leer('ventas.length') === 0);
        check('con BLOQUEAR_SIN_STOCK = true no se pregunta nada',
            C.confirmaciones.length === 0);
        check('con BLOQUEAR_SIN_STOCK = true se avisa y el carrito queda intacto',
            /Venta bloqueada/.test(C.ultimoAviso()) && C.leer('cart.length') === 1);

        /* (c) Regresión: con stock suficiente la venta es la de siempre. */
        const almacen4 = almacenCompartido();
        inventario(almacen4, [ARROZ5]);
        const D = crearPestana(almacen4, 'tab-D', { confirmar: true });
        agregar(D, ARROZ5, 2);
        await D.correr('processSale()');
        const ventasD = D.leer('ventas');
        check('con stock suficiente no se pide confirmación', D.confirmaciones.length === 0);
        check('la venta normal NO lleva ventaSobrestock',
            ventasD.length === 1 && !('ventaSobrestock' in ventasD[0]));
        check('el stock del almacén bajó de 5 a 3', stockEnDisco(almacen4, 'p5') === 3);
        check('la reserva de la pestaña se liberó tras vender',
            reservaDe(almacen4, 'tab-D', 'p5') === 0);
    }

    /* ------------------------------------------------------------------ */
    titulo('6. pagehide / cierre de la pestaña libera sus reservas');
    {
        const almacen = almacenCompartido();
        inventario(almacen, [producto('p2', 'Café', 2)]);
        const CAFE2 = producto('p2', 'Café', 2);
        const A = crearPestana(almacen, 'tab-A');
        const B = crearPestana(almacen, 'tab-B');

        agregar(A, CAFE2, 1);
        check('A registró un manejador de pagehide',
            (A.manejadores.pagehide || []).length === 1);
        check('mientras A está abierta, B solo ve 1', disponible(B, CAFE2) === 1);

        A.manejadores.pagehide[0]();   // el navegador cierra/oculta la pestaña de A
        check('al cerrarse A se liberan sus reservas', reservaDe(almacen, 'tab-A', 'p2') === 0);
        check('B vuelve a ver las 2 unidades', disponible(B, CAFE2) === 2);
    }

    /* ------------------------------------------------------------------ */
    titulo('7. Una sola pestaña: comportamiento idéntico al de hoy (regresión)');
    {
        const almacen = almacenCompartido();
        inventario(almacen, [ARROZ5]);
        const A = crearPestana(almacen, 'tab-unica', { confirmar: true });

        check('sin otras pestañas el disponible es el stock bruto',
            disponible(A, ARROZ5) === 5);
        agregar(A, ARROZ5, 3);
        agregar(A, ARROZ5, 2);
        check('se pueden agregar 3 + 2 = 5 (igual que siempre)',
            A.leer('cart[0].quantity') === 5);

        A.limpiarAvisos();
        agregar(A, ARROZ5, 1);
        check('la sexta unidad se rechaza con aviso',
            A.leer('cart[0].quantity') === 5 && /quedan 5 unidades/.test(A.ultimoAviso()),
            A.ultimoAviso());

        A.correr("updateQuantity('p5', 9)");
        check('la cantidad se corta en el stock (5)', A.leer('cart[0].quantity') === 5);
        A.correr("updateQuantity('p5', 0)");
        check('bajar la cantidad a 0 quita el producto', A.leer('cart.length') === 0);
        check('y libera la reserva de la pestaña', reservaDe(almacen, 'tab-unica', 'p5') === 0);

        agregar(A, ARROZ5, 2);
        await A.correr('processSale()');
        check('el POS no lanzó ningún error', A.errores.length === 0, A.errores.join(' | '));
        check('la venta se registra igual que siempre', A.leer('ventas.length') === 1);
        check('la venta normal NO lleva ventaSobrestock',
            !('ventaSobrestock' in A.leer('ventas[0]')));
        check('el stock baja a 3 en el almacén', stockEnDisco(almacen, 'p5') === 3);
        check('no se pidió ninguna confirmación extra', A.confirmaciones.length === 0);
        check('la reserva se liberó al cerrar la venta', reservaDe(almacen, 'tab-unica', 'p5') === 0);
    }

    /* ------------------------------------------------------------------ */
    titulo('8. Invariantes: clave de negocio, nada de sessionStorage y bloques que compilan');

    const SECCION_RESERVAS = BLOQUE_APP.codigo.slice(
        BLOQUE_APP.codigo.indexOf('RESERVAS DE CARRITO COMPARTIDAS ENTRE PESTAÑAS (B)'),
        BLOQUE_APP.codigo.indexOf('// ===== CARRITO ====='));

    check('la sección de reservas está en el POS', SECCION_RESERVAS.length > 500);
    check('la clave de las reservas es de negocio: pos_reservas_carrito',
        /RESERVAS_CLAVE\s*=\s*'pos_reservas_carrito'/.test(BLOQUE_APP.codigo));
    check('la sección de reservas NO usa sessionStorage (solo lo menciona en el comentario)',
        !/sessionStorage\s*[.\[]/.test(SECCION_RESERVAS));
    check('ninguna llamada a sessionStorage toca la clave de las reservas',
        !/sessionStorage[^\n]*pos_reservas_carrito/.test(BLOQUE_APP.codigo));
    check('la sección de reservas usa localStorage (almacén compartido)',
        /localStorage\.(get|set|remove)Item/.test(SECCION_RESERVAS));
    check('la caducidad declarada es de 15 minutos',
        /RESERVA_CADUCIDAD_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/.test(BLOQUE_APP.codigo));
    check('BLOQUEAR_SIN_STOCK es un interruptor de una línea (por defecto false)',
        /const BLOQUEAR_SIN_STOCK\s*=\s*false\s*;/.test(BLOQUE_APP.codigo));
    check('processSale marca la venta por debajo del stock',
        /saleData\.ventaSobrestock\s*=\s*true/.test(BLOQUE_APP.codigo));

    const FUENTE_PROCESS_SALE = extraerFuncion(BLOQUE_APP.codigo, 'processSale');
    check('processSale relee el stock ANTES de escribir pos_sales',
        FUENTE_PROCESS_SALE.indexOf('revisarStockParaVenta()') !== -1 &&
        FUENTE_PROCESS_SALE.indexOf('revisarStockParaVenta()') <
        FUENTE_PROCESS_SALE.indexOf("localStorage.setItem('pos_sales'"));

    /* Dinámico: un carrito completo sin tocar sessionStorage. */
    {
        const almacen = almacenCompartido();
        inventario(almacen, [ARROZ5]);
        const T = crearPestana(almacen, 'tab-S');
        agregar(T, ARROZ5, 1);
        T.correr("updateQuantity('p5', 2)");
        T.correr('refrescarReservasCarrito()');
        T.manejadores.pagehide[0]();
        check('todo el ciclo de reservas funciona sin tocar sessionStorage',
            T.usosSession.length === 0, T.usosSession.join(', '));
    }

    /* Con el aislamiento por cuenta activo, la clave queda PREFIJADA (por negocio). */
    {
        const FUENTE_DATOS_CUENTA = fs.readFileSync(ARCHIVO_DATOS_CUENTA, 'utf8');
        const datos = new Map();
        function Storage() {}
        const proto = {
            getItem: function (k) { k = String(k); return datos.has(k) ? datos.get(k) : null; },
            setItem: function (k, v) { datos.set(String(k), String(v)); },
            removeItem: function (k) { datos.delete(String(k)); },
            key: function (i) {
                const ks = Array.from(datos.keys());
                const n = Number(i);
                return (n >= 0 && n < ks.length) ? ks[n] : null;
            },
            clear: function () { datos.clear(); }
        };
        Object.defineProperty(proto, 'length', { configurable: true, get: function () { return datos.size; } });
        Storage.prototype = proto;
        const almacen = Object.create(proto);

        const ctx = {
            console: { log: function () {}, warn: function () {}, error: function () {} },
            JSON: JSON, Date: Date, Math: Math, Object: Object, Array: Array,
            String: String, Number: Number, Boolean: Boolean, Storage: Storage,
            isFinite: isFinite, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
            Promise: Promise
        };
        ctx.localStorage = almacen;
        ctx.window = ctx;
        vm.createContext(ctx);
        vm.runInContext(FUENTE_DATOS_CUENTA, ctx, { filename: 'datos_cuenta.js' });

        check('datos_cuenta.js intercepta localStorage',
            !!ctx.datosCuenta && ctx.datosCuenta.estado().interceptado === true);
        check('se activa la cuenta del negocio',
            ctx.datosCuenta.activarPara('negocio@cielo.com') === true);

        ctx.localStorage.setItem('pos_reservas_carrito',
            JSON.stringify({ 'tab-A': { p1: { cantidad: 1, ts: 1 } } }));
        const fisicas = Array.from(datos.keys());
        check('pos_reservas_carrito es clave de NEGOCIO (queda prefijada por cuenta)',
            fisicas.indexOf('cuenta:negocio_at_cielo_com:pos_reservas_carrito') !== -1,
            fisicas.join(', '));
        check('no queda ninguna pos_reservas_carrito sin prefijo (sin fuga entre cuentas)',
            fisicas.indexOf('pos_reservas_carrito') === -1);
        check('la lectura devuelve el mismo valor (ida y vuelta por el prefijo)',
            JSON.parse(ctx.localStorage.getItem('pos_reservas_carrito'))['tab-A'].p1.cantidad === 1);
        nota('claves físicas: ' + fisicas.join(', '));
    }

    /* ------------------------------------------------------------------ */
    console.log('\n================ ' + ok + ' OK, ' + fallos + ' FALLAS ================');
    process.exit(fallos ? 1 : 0);
})();
