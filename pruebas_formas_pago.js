/* =====================================================================
   PRUEBAS DE LAS DOS FORMAS DE PAGO NUEVAS DEL POS
     · «POR COBRAR»     (fiado: crea la deuda en ciervo_accounts)
     · «CONSUMO INTERNO» (descuenta stock, NO es venta ni ingreso)

   Se ejecuta con:  node pruebas_formas_pago.js

   QUÉ SE COMPRUEBA (siempre sobre el CÓDIGO REAL, extraído de los archivos y
   ejecutado en `vm`; los dobles son solo el navegador y la nube):
     1. Puerta de administrador en DOS capas: la parrilla de métodos no pinta los
        botones de dueño sin perfil de administrador y `processSale` RECHAZA el
        cobro aunque la llamada llegue por otra vía. Un operador 'Vendedor' no
        puede usarlos; un 'Administrador' y el propietario sí.
     2. «Por cobrar»: la venta queda marcada (`porCobrar`), la deuda se crea en
        `ciervo_accounts` con el MISMO modelo que cuentas.html (tercero, ticket,
        productos, USD, Bs, tasa, fecha, días de recordatorio, estado) y sobrevive
        a las operaciones reales de cuentas.html (estado, fila, abono, guardado).
     3. «Consumo interno»: descuenta stock, NO crea deuda y queda FUERA de los
        totales de venta (lector de ventas y página de resumen), informado aparte.
     4. Una venta normal no cambia en nada.
     5. Las reservas de carrito se liberan igual que en una venta normal.
     6. Funciona en los DOS modos del motor: clásico y operaciones.
     7. Mutaciones: se rompe a propósito cada comprobación clave y se exige que el
        comportamiento cambie (la suite no es vacua).

   NO es un navegador: no se prueban OPFS/IndexedDB, Firebase real ni el pintado
   real del DOM. Ver el informe.
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = __dirname;
const ARCHIVO_POS = path.join(RAIZ, 'mini_market_pos.html');
const ARCHIVO_CUENTAS = path.join(RAIZ, 'cuentas.html');
const ARCHIVO_LECTOR = path.join(RAIZ, 'lector_ventas.js');
const ARCHIVO_MOTOR = path.join(RAIZ, 'motor_operaciones.js');
const ARCHIVO_RESUMEN = path.join(RAIZ, 'mini_market_pos_resumen.html');

let ok = 0, fallos = 0;
const check = (nombre, condicion, extra = '') => {
    if (condicion) { ok++; console.log('OK    ' + nombre); }
    else { fallos++; console.log('FALLA ' + nombre + (extra !== '' ? '  -> ' + extra : '')); }
};
const titulo = (t) => console.log('\n' + t);
const nota = (t) => console.log('      ' + t);

/* =====================================================================
   0. EXTRACCIÓN DEL CÓDIGO REAL
   ===================================================================== */

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

function extraerFuncion(texto, nombre) {
    const marca = 'function ' + nombre + '(';
    const i = texto.indexOf(marca);
    if (i === -1) throw new Error('no se encontró la función ' + nombre);
    const antes = texto.slice(Math.max(0, i - 6), i);
    return extraerBloque(texto, /async\s$/.test(antes) ? i - 6 : i);
}

function extraerDeclaracion(texto, nombre) {
    const re = new RegExp('(?:const|var|let)\\s+' + nombre + '\\s*=[^;]*;');
    const m = re.exec(texto);
    if (!m) throw new Error('no se encontró la declaración ' + nombre);
    return m[0];
}

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

const BYTES_CUENTAS = fs.readFileSync(ARCHIVO_CUENTAS);
const HTML_CUENTAS = BYTES_CUENTAS.toString('utf8').replace(/\r\n/g, '\n');
const BLOQUES_CUENTAS = bloquesEnLinea(HTML_CUENTAS);
const BLOQUE_CUENTAS = BLOQUES_CUENTAS.find(b => /function createAccountRow\s*\(/.test(b.codigo));

const BYTES_RESUMEN = fs.readFileSync(ARCHIVO_RESUMEN);
const HTML_RESUMEN = BYTES_RESUMEN.toString('utf8').replace(/\r\n/g, '\n');
const BLOQUE_RESUMEN = bloquesEnLinea(HTML_RESUMEN).find(b => /function applyFilters\s*\(/.test(b.codigo));

const FUENTE_LECTOR = fs.readFileSync(ARCHIVO_LECTOR, 'utf8').replace(/\r\n/g, '\n');
const FUENTE_MOTOR = fs.readFileSync(ARCHIVO_MOTOR, 'utf8').replace(/\r\n/g, '\n');

titulo('0. Extracción del código real y CRLF');

let crlf = 0, lf = 0;
for (let i = 0; i < BYTES_POS.length; i++) {
    if (BYTES_POS[i] === 10) { lf++; if (i > 0 && BYTES_POS[i - 1] === 13) crlf++; }
}
check('mini_market_pos.html mantiene CRLF en todas sus líneas', lf > 0 && crlf === lf,
    'LF=' + lf + ' CRLF=' + crlf);
for (const [ruta, bytes] of [['cuentas.html', BYTES_CUENTAS],
    ['mini_market_pos_resumen.html', BYTES_RESUMEN],
    ['lector_ventas.js', fs.readFileSync(ARCHIVO_LECTOR)],
    ['motor_operaciones.js', fs.readFileSync(ARCHIVO_MOTOR)]]) {
    const t = bytes.toString('utf8');
    check(ruta + ' mantiene CRLF (sin LF sueltos)',
        t.replace(/\r\n/g, '').indexOf('\n') === -1);
}

check('se encontró el bloque principal del POS', !!BLOQUE_APP);
check('se encontró el bloque principal de cuentas.html', !!BLOQUE_CUENTAS);
check('se encontró el bloque principal del resumen', !!BLOQUE_RESUMEN);

let compilan = true, detalleCompilacion = '';
BLOQUES_POS.concat(BLOQUES_CUENTAS).concat(bloquesEnLinea(HTML_RESUMEN)).forEach(function (b, i) {
    try { new vm.Script(b.codigo, { filename: 'bloque#' + i }); }
    catch (e) { compilan = false; detalleCompilacion = e.message; }
});
check('los bloques en línea de las tres páginas compilan (new vm.Script)', compilan, detalleCompilacion);

/* --- funciones reales que se ejecutan en las pruebas --- */
const FUNCIONES_POS = [
    // puerta de administrador
    'leerOperadorActual', 'esSesionDePropietario', 'esOperadorAdministrador',
    'metodoSoloAdmin', 'puedeUsarMetodoPago',
    // métodos de pago y modal
    'loadModalPaymentMethods', 'selectModalPaymentMethod', 'updateConfirmButton',
    'confirmSale', 'hideAllPaymentSections', 'calculateFinalTotalInUsd', 'parseNumber',
    'formatCurrency', 'mostrarSeccionPorCobrar', 'mostrarSeccionConsumoInterno',
    // cuentas por cobrar (el fiado)
    'diasRecordatorioCuentas', 'fechaVencimientoFiado', 'nombreClienteFiado',
    'normalizarCuentas', 'leerCuentasLocales', 'guardarCuentasLocales', 'unirCuentasPorId',
    'siguienteIdCuenta', 'nombreVendedorActual', 'detalleProductosVenta',
    // Fase 0 de cuentas en el POS: lápidas y contador de ids compartidos.
    'leerCuentasBorradasPos', 'idLapidadoPos', 'leerUltimoIdCuentasPos', 'reservarIdCuentaPos',
    'agregarCuentaPorCobrar', 'sincronizarCuentasConNube', 'sanitizeEmailForDb',
    // la venta
    'processSale', 'calculateSaleTotals', 'updateInventory', 'resetSale',
    'addToCart', 'removeFromCart', 'updateQuantity',
    'revisarStockParaVenta', 'detalleFaltantesStock', 'pedirConfirmacionSinStock',
    'reactivarBotonConfirmar',
    // reservas de carrito (para comprobar que se liberan igual)
    'leerInventarioReal', 'stockRealDe', 'leerReservasCrudas', 'escribirReservas',
    'reservasVigentes', 'reservasDeOtrasPestanas', 'disponibleParaPestana',
    'refrescarReservasCarrito', 'liberarReservasPropias', 'textoCantidad', 'textoApartadas',
    'avisoSinDisponible', 'limiteDisponibleActual',
    // el ticket
    'printReceipt'
];
const CONSTANTES_POS = [
    'RESERVAS_CLAVE', 'RESERVA_CADUCIDAD_MS', 'RESERVA_TAB_ID', 'RESERVA_EPSILON',
    'BLOQUEAR_SIN_STOCK', 'METODOS_SOLO_ADMIN', 'paymentMethods', 'CUENTAS_CLAVE',
    // Fase 0 de cuentas: claves compartidas con cuentas.html.
    'CUENTAS_BORRADAS_CLAVE', 'CUENTAS_ULTIMO_ID_CLAVE'
];

function construirFuentePos(bloque) {
    const trozos = [];
    CONSTANTES_POS.forEach(n => trozos.push(extraerDeclaracion(bloque, n)));
    FUNCIONES_POS.forEach(n => trozos.push(extraerFuncion(bloque, n)));
    return trozos.join('\n\n');
}

let FUENTE_POS = null, errorExtraccion = '';
try { FUENTE_POS = construirFuentePos(BLOQUE_APP.codigo); }
catch (e) { errorExtraccion = e.message; }
check('se pudieron extraer las funciones y constantes reales del POS',
    FUENTE_POS !== null, errorExtraccion);

const FUNCIONES_CUENTAS = [
    // Fase 0 de cuentas: puerta de rol, saneador, saldo derivado, lápidas y contador.
    'leerOperadorActual', 'esSesionDePropietario', 'esOperadorAdministrador', 'permiteVerCuentas',
    'permiteEditarCuentas', 'numeroSeguro', 'fechaHoyIso', 'fechaValida', 'normalizarPago',
    'normalizarCuenta', 'abonosDe', 'abonadoDe', 'saldoPendiente', 'estadoDeCuenta', 'mesDePago',
    'leerCuentasBorradas', 'guardarCuentasBorradas', 'marcarCuentaBorrada', 'olvidarCuentaBorrada',
    'idEstaLapidado', 'leerUltimoIdCuentas', 'maxIdDeCuentas', 'proximoIdCuenta', 'reservarIdCuenta',
    'sincronizarContadorId',
    // Rediseño de la pantalla (solo presentación: tarjetas, filtros y KPIs).
    'diasRecordatorioCuentas', 'fechaMasDias', 'idSeguroCuenta', 'escribirTexto',
    'hayFiltrosCuentas', 'cuentaPasaFiltros', 'compararCuentas', 'mismaCuenta',
    // Las de siempre.
    'normalizarCuentas', 'leerCuentasDelAlmacen', 'fusionarCuentasConAlmacen', 'diasDeDeuda',
    'detalleDeudaHtml', 'sortCompare', 'updateAccountStatuses', 'saveAccountsCache',
    'persistAccounts', 'confirmPayment', 'createAccountRow', 'updateDashboard', 'renderCashFlowChart'
];
const CONSTANTES_CUENTAS = ['_cuentasEliminadas', 'CUENTAS_BORRADAS_CLAVE',
    'CUENTAS_ULTIMO_ID_CLAVE', 'CTA_MODO_VENDEDOR', 'ORDENES_CUENTAS'];
/** Estado de la vista (rediseño): se declara tal cual está en la página. */
const VARIABLES_CUENTAS = ['vistaCuentas', 'ordenCuentas', 'chipsCuentas', 'cuentaDestacada'];

function construirFuenteCuentas(bloque) {
    const trozos = [
        'var _accountsCache = [];',
        'let nextAccountId = 1;',
        'var payingAccountId = null;',
        'var currentSort = { key: null, direction: "asc" };'
    ];
    CONSTANTES_CUENTAS.forEach(n => trozos.push(extraerDeclaracion(bloque, n)));
    VARIABLES_CUENTAS.forEach(n => trozos.push(extraerDeclaracion(bloque, n)));
    FUNCIONES_CUENTAS.forEach(n => trozos.push(extraerFuncion(bloque, n)));
    return trozos.join('\n\n');
}

let FUENTE_CUENTAS = null, errorCuentas = '';
try { FUENTE_CUENTAS = construirFuenteCuentas(BLOQUE_CUENTAS.codigo); }
catch (e) { errorCuentas = e.message; }
check('se pudieron extraer las funciones reales de cuentas.html',
    FUENTE_CUENTAS !== null, errorCuentas);

const FUNCIONES_RESUMEN = [
    'esConsumoInternoVenta', 'esVentaPorCobrar', 'recalculateTotalFromItems',
    'formatCurrency', 'applyFilters', 'calculateSalesByDay', 'calculatePaymentMethods',
    'getPaymentMethodName'
];

function construirFuenteResumen(bloque) {
    const trozos = [
        'var allSales = [];',
        'var mainInventory = [];',
        'var filteredSales = [];',
        'var ventasContablesFiltradas = [];',
        'var currentPage = 1;',
        'var currentFilters = { search: "", dateFrom: "", dateTo: "", paymentMethod: "", currency: "", amountMin: "", amountMax: "", category: "", product: "", customer: "", tag: "" };'
    ];
    FUNCIONES_RESUMEN.forEach(n => trozos.push(extraerFuncion(bloque, n)));
    return trozos.join('\n\n');
}

let FUENTE_RESUMEN = null, errorResumen = '';
try { FUENTE_RESUMEN = construirFuenteResumen(BLOQUE_RESUMEN.codigo); }
catch (e) { errorResumen = e.message; }
check('se pudieron extraer las funciones reales del resumen', FUENTE_RESUMEN !== null, errorResumen);

/* los dobles del navegador solo sustituyen lo que NO es la lógica que se prueba */
const STUBS = `
    var ventas = [];
    var cart = [];
    var inventoryProducts = [];
    var currentProductToAdd = null;
    var currentCurrency = 'USD';
    var exchangeRate = 40;
    var currentDiscount = 0;
    var applyIVA = false;
    var selectedPaymentMethod = null;
    var paymentDetails = {};
    var customerData = null;
    var heldCarts = [];
    var saleId = 'V-0001';
    var rateMode = 'manual';
    var rateSource = 'bcv';
    var _opsModo = 'clasico';
    var _opsActivo = false;
    var _fbPending = false;
    var opMotor = false;
    var __cloud = false;
    var __db = null;
    var __contadorVenta = 0;
    var __marcas = [];
    var __limpias = [];
    var __confirmCallback = null;
    var __impresas = [];

    function showToast(m) { __avisos.push(String(m)); }
    function updateCartUI() {}
    function updateTotals() {}
    function toggleTotalsDetails() {}
    function toggleSection() {}
    function peekSaleId() { return 'V-0000'; }
    function reserveSaleId() { __contadorVenta++; return 'V-' + ('0000' + __contadorVenta).slice(-4); }
    function showConfirmModal(t, m, cb) { __avisos.push('pide-confirmacion'); __confirmCallback = cb; }
    function closeConfirmModal() { __confirmCallback = null; }
    function closeProcessModal() {}
    function printReceiptStub(saleData) { __impresas.push(saleData); }
    function loadInventoryProducts() {}
    function renderProductList() {}
    function marcarPendienteSync(m) { __marcas.push(String(m)); }
    function limpiarPendienteSync(m) { __limpias.push(String(m)); }
    function fbSaveVentas() { __llamadas.ventasSubidas++; return Promise.resolve(true); }
    function fbSaveProductos() { __llamadas.productosSubidos++; return Promise.resolve(true); }
    function fbUpsertClient() { __llamadas.clientes++; return Promise.resolve(true); }
    function modoOperacionesActivo() { return _opsActivo === true; }
    function esperarModoSync() { return Promise.resolve(_opsModo); }
    function actualizarPuntoEstadoOps() {}
    function anotarVentaSinOperacion() {}
    function setFirebaseDot() {}
    function asegurarMotorOps() { return Promise.resolve(opMotor === true); }
    function checkCloudAccess() { return Promise.resolve(__cloud); }
    function initFirebase() { return Promise.resolve(__db); }
    function getCurrentUserEmail() { return 'negocio@cielo.com'; }
    function handleUsdCashPayment() {}
    function handleCombinedPayment() {}
    function subirConMarcaSync(modulo, subir) {
        __marcas.push('subir:' + modulo);
        return subir().then(function () { __limpias.push(String(modulo)); return true; },
                            function () { return false; });
    }
`;

/* ------------------------------ dobles ------------------------------ */

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

function crearDocumentoFalso() {
    const nodos = {};
    function crearNodo(id) {
        const clases = new Set();
        return {
            id: id, value: '', disabled: false, dataset: {}, style: {},
            _texto: '', _clases: clases,
            innerHTML: '',
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
        // Los elementos CREADOS imitan a un div: `textContent` se guarda y `innerHTML`
        // lo devuelve escapado (así `escapeHtml`/`esc` del POS funcionan de verdad).
        createElement: function () {
            const n = crearNodo('_creado');
            Object.defineProperty(n, 'textContent', {
                get: function () { return n._texto; },
                set: function (v) { n._texto = String(v == null ? '' : v); }
            });
            Object.defineProperty(n, 'innerHTML', {
                get: function () {
                    return String(n._texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                }
            });
            return n;
        },
        addEventListener: function () {}
    };
}

function crearSessionStorage(inicial) {
    const datos = Object.assign({}, inicial || {});
    return {
        _datos: datos,
        usos: [],
        getItem: function (k) { this.usos.push('get:' + k); return Object.prototype.hasOwnProperty.call(datos, k) ? datos[k] : null; },
        setItem: function (k, v) { this.usos.push('set:' + k); datos[k] = String(v); },
        removeItem: function (k) { this.usos.push('del:' + k); delete datos[k]; }
    };
}

/* =====================================================================
   1. EL POS REAL EN UN SANDBOX
   ===================================================================== */

function crearPos(opciones) {
    const op = opciones || {};
    const almacen = op.almacen || almacenCompartido();
    const avisos = [];
    const errores = [];
    const confirmaciones = [];
    const llamadas = { motor: [], ventasSubidas: 0, productosSubidos: 0, clientes: 0, cuentasSubidas: [] };
    const documento = crearDocumentoFalso();
    const sesion = op.sesion || crearSessionStorage(op.sesionDatos || {});
    const manejadores = {};

    const ctx = {
        console: {
            log: function () {},
            warn: function () {},
            error: function () { errores.push([].slice.call(arguments).map(String).join(' ')); }
        },
        JSON: JSON, Date: Date, Math: Math, Object: Object, Array: Array,
        String: String, Number: Number, Boolean: Boolean, RegExp: RegExp, Error: Error,
        isFinite: isFinite, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
        Promise: Promise, Intl: Intl,
        localStorage: almacen,
        sessionStorage: sesion,
        document: documento,
        navigator: { onLine: true },
        __avisos: avisos,
        __llamadas: llamadas,
        __ticket: { html: '' },
        setTimeout: function () { return 0; },
        clearTimeout: function () {},
        alert: function (m) { avisos.push('ALERT:' + String(m)); },
        confirm: function (mensaje) {
            confirmaciones.push(String(mensaje));
            return op.confirmar === true;
        }
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    ctx.window.addEventListener = function (ev, fn) {
        if (!manejadores[ev]) manejadores[ev] = [];
        manejadores[ev].push(fn);
    };
    ctx.motorOperaciones = {
        registrarOperacion: function (tipo, payload) {
            llamadas.motor.push({ tipo: tipo, payload: JSON.parse(JSON.stringify(payload)) });
            return Promise.resolve({ ok: true, clave: 'op-1' });
        },
        estado: function () { return { activo: false, modo: 'local' }; }
    };
    ctx.open = function () {
        const ventana = {
            document: {
                write: function (h) { ctx.__ticket.html += String(h); },
                close: function () {}
            },
            focus: function () {}, print: function () {}
        };
        return ventana;
    };

    vm.createContext(ctx);
    vm.runInContext(STUBS, ctx, { filename: 'mini_market_pos.html (dobles del navegador)' });
    vm.runInContext(op.fuente || FUENTE_POS, ctx, { filename: 'mini_market_pos.html (funciones reales)' });

    return {
        ctx: ctx,
        almacen: almacen,
        sesion: sesion,
        documento: documento,
        avisos: avisos,
        errores: errores,
        confirmaciones: confirmaciones,
        llamadas: llamadas,
        manejadores: manejadores,
        leer: function (expr) { return vm.runInContext(expr, ctx); },
        correr: function (codigo) { return vm.runInContext(codigo, ctx); },
        ultimoAviso: function () { return avisos.length ? avisos[avisoFinal()] : ''; },
        avisosCon: function (texto) { return avisos.filter(a => String(a).indexOf(texto) !== -1); },
        limpiarAvisos: function () { avisos.length = 0; },
        ticket: function () { return ctx.__ticket.html; },
        confirmarVenta: function () {
            const cb = ctx.__confirmCallback;
            ctx.__confirmCallback = null;
            return cb ? cb() : null;
        }
    };

    function avisoFinal() { return avisos.length - 1; }
}

/* --------------------------- utilidades --------------------------- */

function producto(id, nombre, stock, extra) {
    return Object.assign({
        id: id, name: nombre, stock: stock, price: 10, cost: 5, isBulk: false, unit: 'unidades'
    }, extra || {});
}

const HARINA = producto('p1', 'Harina P.A.N.', 10);
const ARROZ = producto('p5', 'Arroz Mary', 8);

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

function cuentasEnDisco(almacen) {
    try {
        const v = JSON.parse(almacen.getItem('ciervo_accounts') || '[]');
        if (Array.isArray(v)) return v;
        if (v && typeof v === 'object') return Object.keys(v).map(k => v[k]);
        return [];
    } catch (e) { return []; }
}

function reservasDe(almacen, tabId) {
    try {
        const r = JSON.parse(almacen.getItem('pos_reservas_carrito') || 'null');
        return (r && r[tabId]) || {};
    } catch (e) { return {}; }
}

function agregarAlCarrito(pos, prod, cantidad) {
    pos.correr('addToCart(' + JSON.stringify(prod) + ', ' + cantidad + ", 'unidades')");
}

const HOY = new Date();
const HOY_ISO = HOY.toISOString().split('T')[0];

function esperarMicrotareas() {
    return new Promise(resolve => setImmediate(resolve));
}

/**
 * Escenario base: un carrito con 2 productos, stock suficiente y una pestaña con el
 * perfil que se pida. Devuelve el POS listo para cobrar.
 */
function escenario(opciones) {
    const op = opciones || {};
    const almacen = op.almacen || almacenCompartido();
    const perfil = op.perfil || {};
    inventario(almacen, [Object.assign({}, HARINA), Object.assign({}, ARROZ)]);
    if (op.recordatorio !== undefined) almacen.setItem('cta_reminder_days', String(op.recordatorio));
    // Claves de EQUIPO (localStorage) que el perfil necesite, p. ej. sesionActiva.
    Object.keys(perfil.local || {}).forEach(k => almacen.setItem(k, perfil.local[k]));

    const pos = crearPos({
        almacen: almacen,
        // El operador y el propietario viven en sessionStorage (POR pestaña).
        sesionDatos: perfil.sesion || {},
        fuente: op.fuente,
        confirmar: op.confirmar === true
    });
    pos.correr('currentCurrency = ' + JSON.stringify(op.currency || 'USD') + '; exchangeRate = 40;');

    // Productos y carrito, por las funciones reales del POS.
    pos.correr('inventoryProducts = ' + JSON.stringify([HARINA, ARROZ]) + ';');
    agregarAlCarrito(pos, HARINA, 2);      // 2 x $10 = $20
    agregarAlCarrito(pos, ARROZ, 1);       // 1 x $10 = $10
    // Otra pestaña aparta unidades DESPUÉS de armar el carrito (para provocar la
    // relectura de stock al confirmar sin que addToCart lo rechace antes).
    if (op.reservaAjena) {
        almacen.setItem('pos_reservas_carrito', JSON.stringify(op.reservaAjena));
    }
    if (op.customer) {
        pos.correr('customerData = ' + JSON.stringify(op.customer) + ';');
        pos.documento.getElementById('customerName').value = op.customer.name || '';
    } else if (op.clienteEnFormulario) {
        pos.documento.getElementById('customerName').value = op.clienteEnFormulario;
    }
    if (op.metodo) pos.correr('selectedPaymentMethod = ' + JSON.stringify(op.metodo) + ';');
    if (op.modo === 'operaciones') {
        pos.correr('_opsModo = "operaciones"; _opsActivo = true; opMotor = true;');
    }
    return pos;
}

const OPERADOR_ADMIN = JSON.stringify({ username: 'jefa', role: 'Administrador', firstName: 'Jefa', lastName: 'Uno' });
const OPERADOR_VENDEDOR = JSON.stringify({ username: 'pedro', role: 'Vendedor', firstName: 'Pedro', lastName: 'Dos' });
/* Perfiles tal como los deja index.html: el operador y el propietario en sessionStorage
   (por pestaña) y la marca compartida 'sesionActiva' en localStorage. */
const PERFIL_ADMIN = { sesion: { currentUser: OPERADOR_ADMIN } };
const PERFIL_VENDEDOR = { sesion: { currentUser: OPERADOR_VENDEDOR } };
const PERFIL_PROPIETARIO = { sesion: { propietarioActual: 'negocio@cielo.com' } };
const PERFIL_SOLO_SESION = { local: { sesionActiva: JSON.stringify({ email: 'negocio@cielo.com', uid: 'u1' }) } };

/* =====================================================================
   LAS PRUEBAS
   ===================================================================== */

(async function principal() {

    /* ------------------------------------------------------------------ */
    titulo('1. Puerta de administrador · capa 1: la parrilla de métodos');
    {
        for (const [etiqueta, perfil, esperado] of [
            ['Administrador', PERFIL_ADMIN, true],
            ['Vendedor', PERFIL_VENDEDOR, false],
            ['propietario (sin operador)', PERFIL_PROPIETARIO, true],
            ['solo sesión compartida (sin operador ni propietario)', PERFIL_SOLO_SESION, false]
        ]) {
            const pos = escenario({ perfil: perfil });
            pos.correr('loadModalPaymentMethods()');
            const html = pos.documento.getElementById('modalPaymentMethods').innerHTML;
            const vePorCobrar = html.indexOf('Por Cobrar') !== -1;
            const veConsumo = html.indexOf('Consumo Interno') !== -1;
            check('1 · ' + etiqueta + (esperado ? ' VE' : ' NO ve') + ' los dos métodos de dueño',
                vePorCobrar === esperado && veConsumo === esperado,
                'porCobrar=' + vePorCobrar + ' consumo=' + veConsumo);
            // Los métodos normales siguen ahí para todos.
            check('1 · ' + etiqueta + ' sigue viendo los métodos normales',
                html.indexOf('Efectivo USD') !== -1 && html.indexOf('Zelle') !== -1);
            check('1 · ' + etiqueta + ': esOperadorAdministrador() = ' + esperado,
                pos.leer('esOperadorAdministrador()') === esperado);
        }

        // El rol manda sobre la marca de propietario (el login de operador va ENCIMA
        // de la sesión de Firebase del dueño).
        const mixto = escenario({
            perfil: { sesion: { currentUser: OPERADOR_VENDEDOR, propietarioActual: 'negocio@cielo.com' } }
        });
        check('1 · un operador Vendedor NO se cuela aunque haya marca de propietario',
            mixto.leer('esOperadorAdministrador()') === false);
    }

    /* ------------------------------------------------------------------ */
    titulo('2. Puerta de administrador · capa 2: processSale rechaza el cobro');
    {
        for (const metodo of ['por-cobrar', 'consumo-interno']) {
            const pos = escenario({
                perfil: PERFIL_VENDEDOR,
                metodo: metodo,
                clienteEnFormulario: 'Ana Pérez'
            });
            pos.limpiarAvisos();
            await pos.correr('processSale()');

            check('2 · Vendedor + ' + metodo + ': NO se registra ninguna venta',
                pos.leer('ventas.length') === 0, 'ventas=' + pos.leer('ventas.length'));
            check('2 · Vendedor + ' + metodo + ': no se escribe pos_sales',
                pos.almacen.getItem('pos_sales') === null);
            check('2 · Vendedor + ' + metodo + ': no se crea ninguna cuenta por cobrar',
                pos.almacen.getItem('ciervo_accounts') === null);
            check('2 · Vendedor + ' + metodo + ': el stock NO se toca',
                stockEnDisco(pos.almacen, 'p1') === 10);
            check('2 · Vendedor + ' + metodo + ': no se consume número de ticket',
                pos.leer('__contadorVenta') === 0);
            check('2 · Vendedor + ' + metodo + ': el carrito queda intacto',
                pos.leer('cart.length') === 2);
            check('2 · Vendedor + ' + metodo + ': se avisa del rechazo',
                pos.avisosCon('solo para administradores').length >= 1, pos.avisos.join(' | '));
            check('2 · Vendedor + ' + metodo + ': el botón de confirmar vuelve a estar usable',
                pos.documento.getElementById('confirmActionBtn').disabled === false);
        }

        // La misma venta, con Administrador, sí se registra (control).
        const admin = escenario({ perfil: PERFIL_ADMIN, metodo: 'consumo-interno' });
        await admin.correr('processSale()');
        check('2 · control: con Administrador la misma venta SÍ se registra',
            admin.leer('ventas.length') === 1, admin.errores.join(' | '));

        // El propietario también puede.
        const dueno = escenario({ perfil: PERFIL_PROPIETARIO, metodo: 'consumo-interno' });
        await dueno.correr('processSale()');
        check('2 · el propietario (sin operador) también puede cobrar consumo interno',
            dueno.leer('ventas.length') === 1);
    }

    /* ------------------------------------------------------------------ */
    titulo('3. «Por cobrar»: la deuda se crea en el modelo de cuentas.html');
    {
        const almacen = almacenCompartido();
        const pos = escenario({
            almacen: almacen,
            perfil: PERFIL_ADMIN,
            metodo: 'por-cobrar',
            customer: { name: 'Ana Pérez', document: 'V12345678', phone: '04140000000' },
            recordatorio: 7
        });
        pos.limpiarAvisos();
        await pos.correr('processSale()');
        await esperarMicrotareas();

        check('3 · el POS no lanzó ningún error', pos.errores.length === 0, pos.errores.join(' | '));

        const ventas = pos.leer('ventas');
        const v0 = ventas[0] || {};
        check('3 · la venta se registró', ventas.length === 1);
        check('3 · la venta queda con el método por-cobrar',
            v0.paymentMethod === 'por-cobrar');
        check('3 · la venta lleva la marca propia porCobrar: true',
            v0.porCobrar === true);
        check('3 · la venta NO lleva la marca de consumo interno',
            !('consumoInterno' in v0));
        check('3 · la venta guarda al cliente', !!v0.customer && v0.customer.name === 'Ana Pérez');
        const totalUsd = (v0.totals || {}).total;
        check('3 · el total de la venta es 30 USD', totalUsd === 30, 'total=' + totalUsd);

        const cuentas = cuentasEnDisco(almacen);
        check('3 · se creó UNA cuenta por cobrar', cuentas.length === 1, JSON.stringify(cuentas));
        // `|| {}` para que un sabotaje se VEA como fallos y no tumbe la suite.
        const c = cuentas[0] || {};
        check('3 · la cuenta es de tipo cobrar', c.type === 'cobrar');
        check('3 · la cuenta dice A QUIÉN se le vendió', c.contact === 'Ana Pérez');
        check('3 · la cuenta referencia el ticket de la venta', c.saleId === v0.id,
            'saleId=' + c.saleId + ' venta=' + v0.id);
        check('3 · el monto del modelo (USD) es el total de la venta', c.amount === 30);
        check('3 · el monto en bolívares es total × tasa', c.totalBs === 1200,
            'totalBs=' + c.totalBs + ' tasa=' + c.exchangeRate);
        check('3 · se guardó la tasa usada', c.exchangeRate === 40);
        check('3 · se guardó la fecha de la deuda', c.fecha === v0.timestamp);
        check('3 · la cuenta nace PENDIENTE', c.status === 'pending');
        check('3 · la cuenta nace sin abonos', Array.isArray(c.payments) && c.payments.length === 0);
        check('3 · la cuenta es del modelo de cuentas.html (categoría válida)',
            c.category === 'Ventas' && typeof c.description === 'string' && !!c.description);
        check('3 · el vencimiento usa los días de recordatorio (7)',
            c.dueDate === fechaMasDias(HOY_ISO, 7), c.dueDate + ' vs ' + fechaMasDias(HOY_ISO, 7));
        check('3 · el detalle de productos viaja en la cuenta',
            Array.isArray(c.productos) && c.productos.length === 2 &&
            (c.productos[0] || {}).name === 'Harina P.A.N.' && c.productos[0].quantity === 2 &&
            c.productos[0].subtotal === 20 && (c.productos[1] || {}).name === 'Arroz Mary');
        check('3 · la cuenta apunta de dónde salió', c.origen === 'pos');
        check('3 · la cuenta guarda el vendedor', c.vendedor === 'Jefa Uno', String(c.vendedor));
        check('3 · se marcó "cuentas" como pendiente de subir',
            pos.leer('__marcas').indexOf('cuentas') !== -1, pos.leer('__marcas').join(','));
        check('3 · el stock bajó (2 de harina y 1 de arroz)',
            stockEnDisco(almacen, 'p1') === 8 && stockEnDisco(almacen, 'p5') === 7);
        check('3 · las reservas de esta pestaña se liberaron',
            Object.keys(reservasDe(almacen, pos.leer('RESERVA_TAB_ID'))).length === 0);
        check('3 · se avisa de la venta a crédito',
            pos.avisosCon('Cuentas por Cobrar').length >= 1, pos.avisos.join(' | '));

        // Idempotencia: la misma venta no puede generar dos deudas.
        const antes = cuentasEnDisco(almacen).length;
        if (ventas[0]) pos.correr('agregarCuentaPorCobrar(' + JSON.stringify(ventas[0]) + ')');
        check('3 · registrar dos veces la misma venta NO duplica la deuda',
            cuentasEnDisco(almacen).length === antes, 'antes=' + antes);

        // Sin cliente no hay fiado.
        const sinCliente = escenario({ perfil: PERFIL_ADMIN, metodo: 'por-cobrar' });
        await sinCliente.correr('processSale()');
        check('3 · «por cobrar» SIN cliente no registra la venta',
            sinCliente.leer('ventas.length') === 0);
        check('3 · «por cobrar» SIN cliente no crea ninguna deuda',
            sinCliente.almacen.getItem('ciervo_accounts') === null);
        check('3 · «por cobrar» SIN cliente avisa claro',
            sinCliente.avisosCon('exige el nombre del cliente').length >= 1,
            sinCliente.avisos.join(' | '));

        // Los días de recordatorio son configurables (ajuste que ya existía).
        const conTres = escenario({
            perfil: PERFIL_ADMIN, metodo: 'por-cobrar',
            customer: { name: 'Luis' }, recordatorio: 3
        });
        await conTres.correr('processSale()');
        await esperarMicrotareas();
        const c3 = cuentasEnDisco(conTres.almacen)[0] || {};
        check('3 · cta_reminder_days = 3 se respeta en el vencimiento',
            c3.dueDate === fechaMasDias(HOY_ISO, 3), c3.dueDate);
        check('3 · la cuenta guarda los días de recordatorio usados', c3.diasRecordatorio === 3);
    }

    /* ------------------------------------------------------------------ */
    titulo('4. «Consumo interno»: descuenta stock, NO es venta y no crea deuda');
    {
        const almacen = almacenCompartido();
        const pos = escenario({
            almacen: almacen, perfil: PERFIL_ADMIN, metodo: 'consumo-interno'
        });
        pos.limpiarAvisos();
        await pos.correr('processSale()');

        check('4 · el POS no lanzó ningún error', pos.errores.length === 0, pos.errores.join(' | '));
        const ventas = pos.leer('ventas');
        const v4 = ventas[0] || {};
        check('4 · la venta se registró en pos_sales', ventas.length === 1 &&
            JSON.parse(almacen.getItem('pos_sales')).length === 1);
        check('4 · el método es consumo-interno',
            v4.paymentMethod === 'consumo-interno');
        check('4 · lleva la marca propia consumoInterno: true',
            v4.consumoInterno === true);
        check('4 · NO lleva la marca de fiado', !('porCobrar' in v4));
        check('4 · NO se crea ninguna cuenta por cobrar',
            almacen.getItem('ciervo_accounts') === null);
        check('4 · SÍ descuenta stock (el producto sale físicamente)',
            stockEnDisco(almacen, 'p1') === 8 && stockEnDisco(almacen, 'p5') === 7);
        check('4 · NO pide cliente (no hace falta para consumo de los dueños)',
            v4.customer === null || v4.customer === undefined);
        check('4 · se avisa de que no cuenta como venta',
            pos.avisosCon('no cuenta como venta').length >= 1, pos.avisos.join(' | '));
        check('4 · las reservas se liberaron igual',
            Object.keys(reservasDe(almacen, pos.leer('RESERVA_TAB_ID'))).length === 0);
        check('4 · consume número de ticket como cualquier registro',
            pos.leer('__contadorVenta') === 1);

        // El ticket lleva la marca de agua (aunque se oculte el detalle del pago).
        const ticketHtml = pos.ticket();
        check('4 · el ticket dice CONSUMO INTERNO',
            /CONSUMO INTERNO/.test(ticketHtml), ticketHtml.slice(0, 80));
        check('4 · el ticket avisa de que NO es una venta',
            /NO ES UNA VENTA/.test(ticketHtml));
        check('4 · el ticket no lo presenta como un cobro',
            !/MÉTODO DE PAGO:<br>CONSUMO-INTERNO: /.test(ticketHtml));
    }

    /* ------------------------------------------------------------------ */
    titulo('5. Una venta normal no cambia en nada (regresión)');
    {
        const almacen = almacenCompartido();
        const pos = escenario({
            almacen: almacen, perfil: PERFIL_VENDEDOR, metodo: 'ves-cash'
        });
        pos.limpiarAvisos();
        await pos.correr('processSale()');

        const ventas = pos.leer('ventas');
        const v5 = ventas[0] || {};
        check('5 · la venta normal se registra igual', ventas.length === 1);
        check('5 · el método es el elegido', v5.paymentMethod === 'ves-cash');
        check('5 · no lleva marcas de dueño',
            !('porCobrar' in v5) && !('consumoInterno' in v5));
        check('5 · no crea cuentas por cobrar', almacen.getItem('ciervo_accounts') === null);
        check('5 · descuenta stock', stockEnDisco(almacen, 'p1') === 8);
        check('5 · libera las reservas',
            Object.keys(reservasDe(almacen, pos.leer('RESERVA_TAB_ID'))).length === 0);
        check('5 · el aviso es el de siempre',
            pos.avisosCon('¡Venta procesada exitosamente!').length === 1, pos.avisos.join(' | '));
        // Un método normal no necesita saber el rol: el cortocircuito de
        // `puedeUsarMetodoPago` evita tocar sessionStorage en el caso corriente.
        pos.sesion.usos.length = 0;
        check('5 · un método normal no consulta el rol (no toca sessionStorage)',
            pos.correr('puedeUsarMetodoPago("ves-cash")') === true && pos.sesion.usos.length === 0,
            pos.sesion.usos.join(','));
        check('5 · los métodos de dueño SÍ consultan el rol',
            (pos.correr('puedeUsarMetodoPago("por-cobrar")'), pos.sesion.usos.length > 0));
    }

    /* ------------------------------------------------------------------ */
    titulo('6. Reservas: la venta libera lo suyo y respeta lo de las demás pestañas');
    {
        const almacen = almacenCompartido();
        const pos = escenario({
            almacen: almacen, perfil: PERFIL_ADMIN, metodo: 'por-cobrar',
            customer: { name: 'Ana' }, confirmar: true,
            // Otra pestaña tiene apartadas 9 de las 10 harinas: al confirmar, la
            // relectura de stock detecta que solo queda 1 para esta venta.
            reservaAjena: { 'tab-OTRA': { p1: { cantidad: 9, ts: Date.now() } } }
        });
        await pos.correr('processSale()');
        check('6 · la venta con reserva ajena se registra (el vendedor confirma)',
            pos.leer('ventas.length') === 1, pos.avisos.join(' | '));
        check('6 · se pidió confirmación con el detalle del stock',
            pos.confirmaciones.length === 1 &&
            /En el sistema quedan 1 unidad de «Harina P\.A\.N\.»/.test(pos.confirmaciones[0]),
            (pos.confirmaciones[0] || '').split('\n')[1] || '(sin detalle)');
        check('6 · la reserva de la OTRA pestaña no se toca',
            reservasDe(almacen, 'tab-OTRA').p1 && reservasDe(almacen, 'tab-OTRA').p1.cantidad === 9);
        check('6 · la reserva propia se liberó',
            Object.keys(reservasDe(almacen, pos.leer('RESERVA_TAB_ID'))).length === 0);
        check('6 · la venta queda marcada como hecha por debajo del stock',
            pos.leer('ventas[0].ventaSobrestock') === true);
        check('6 · la deuda del fiado se crea igual aunque se venda por debajo',
            cuentasEnDisco(almacen).length === 1);

        const almacen2 = almacenCompartido();
        const pos2 = escenario({ almacen: almacen2, perfil: PERFIL_ADMIN, metodo: 'consumo-interno' });
        await pos2.correr('processSale()');
        check('6 · el consumo interno también libera su reserva',
            Object.keys(reservasDe(almacen2, pos2.leer('RESERVA_TAB_ID'))).length === 0);
    }

    /* ------------------------------------------------------------------ */
    titulo('7. «Por cobrar» sobrevive a cuentas.html (modelo REAL)');
    {
        const almacen = almacenCompartido();
        const pos = escenario({
            almacen: almacen, perfil: PERFIL_ADMIN, metodo: 'por-cobrar',
            customer: { name: 'Ana Pérez', document: 'V12345678' }
        });
        await pos.correr('processSale()');
        await esperarMicrotareas();
        // Los `|| {}` no son adorno: si algo de esto se rompe (o se sabotea a
        // propósito), la suite debe REPORTAR fallos, no morir con un TypeError.
        const cuenta = cuentasEnDisco(almacen)[0] || {};
        const venta = pos.leer('ventas[0]') || {};
        const VACIA = '{ id: 0, type: "cobrar", description: "", contact: "", amount: 0, ' +
            'dueDate: "2030-01-01", category: "Otros", payments: [], status: "pending" }';

        const cuentas = crearCuentas({ almacen: almacen });
        cuentas.correr('_accountsCache = normalizarCuentas(JSON.parse(localStorage.getItem("ciervo_accounts")));');

        // (a) El estado que calcula cuentas.html respeta la deuda del POS.
        cuentas.correr('updateAccountStatuses()');
        check('7 · cuentas.html deja la deuda del POS en pending (vence en el futuro)',
            cuentas.leer('(_accountsCache[0] || {}).status') === 'pending');
        check('7 · el estado se guardó en el almacén compartido',
            (cuentasEnDisco(almacen)[0] || {}).status === 'pending');

        // (b) Los días de la deuda se calculan desde la fecha del POS.
        check('7 · diasDeDeuda cuenta los días desde la fecha del POS',
            cuentas.leer('diasDeDeuda(_accountsCache[0] || {})') === 0);
        check('7 · una deuda de hace 5 días dice 5',
            cuentas.leer('diasDeDeuda({ fecha: new Date(Date.now() - 5*86400000).toISOString() })') === 5);
        check('7 · sin fecha no se inventa un número',
            cuentas.leer('diasDeDeuda({})') === null);

        // (c) La fila de la tabla enseña todo lo pedido.
        const fila = cuentas.leer('createAccountRow(_accountsCache[0] || ' + VACIA + ')');
        check('7 · la fila muestra A QUIÉN se le vendió', fila.indexOf('Ana P') !== -1, fila);
        check('7 · la fila muestra el monto en USD', fila.indexOf('30.00') !== -1);
        check('7 · la fila muestra el ticket de la venta', fila.indexOf(venta.id) !== -1);
        check('7 · la fila muestra el monto en Bs y la tasa',
            fila.indexOf('1200.00') !== -1 && fila.indexOf('40.00') !== -1);
        check('7 · la fila lista los productos', /Productos:/.test(fila) &&
            fila.indexOf('Harina P.A.N.') !== -1 && fila.indexOf('Arroz Mary') !== -1);
        check('7 · la fila tiene la columna Días', /cell-dias/.test(fila));
        check('7 · la fila no muestra abonos todavía', !/Abonos/.test(fila));

        // (d) Un ABONO por la vía real de cuentas.html.
        cuentas.correr('payingAccountId = (_accountsCache[0] || { id: 0 }).id;');
        cuentas.documento.getElementById('paymentAmount').value = '10';
        await cuentas.correr('confirmPayment()');

        const trasAbono = cuentasEnDisco(almacen)[0] || {};
        check('7 · el abono se guardó en el almacén compartido',
            Array.isArray(trasAbono.payments) && trasAbono.payments.length === 1 &&
            trasAbono.payments[0].amount === 10,
            JSON.stringify(trasAbono.payments));
        check('7 · el abono conserva TODOS los campos del POS (ticket, productos, Bs)',
            trasAbono.saleId === venta.id && Array.isArray(trasAbono.productos) &&
            trasAbono.productos.length === 2 && trasAbono.totalBs === 1200);
        check('7 · la deuda sigue pendiente (abono parcial)',
            trasAbono.status === 'pending' && trasAbono.amount === 30);
        const fila2 = cuentas.leer('createAccountRow(_accountsCache[0] || ' + VACIA + ')');
        check('7 · la fila ya enseña el detalle de los abonos', /Abonos \(1\)/.test(fila2) &&
            fila2.indexOf('10.00') !== -1, fila2);

        // (e) La unión por id: cuentas.html NO puede borrar el fiado que creó el POS.
        const almacen3 = almacenCompartido();
        almacen3.setItem('ciervo_accounts', JSON.stringify([
            { id: 7, type: 'cobrar', description: 'Vieja', contact: 'X', amount: 5,
              dueDate: '2030-01-01', category: 'Otros', payments: [], status: 'pending' },
            cuenta
        ]));
        const cuentas3 = crearCuentas({ almacen: almacen3 });
        // La página tenía en memoria SOLO la cuenta vieja (como si el POS acabara de
        // crear el fiado en otra pestaña después de su carga inicial).
        cuentas3.correr('_accountsCache = [{ id: 7, type: "cobrar", description: "Vieja", contact: "X", ' +
            'amount: 5, dueDate: "2030-01-01", category: "Otros", payments: [], status: "pending" }];');
        await cuentas3.correr('persistAccounts()');
        const fusionadas = cuentasEnDisco(almacen3);
        check('7 · guardar en cuentas.html NO borra el fiado del POS (unión por id)',
            fusionadas.length === 2 && fusionadas.some(x => x.saleId === venta.id),
            'cuentas=' + fusionadas.length);
        check('7 · la lista unida es la que se sube a la nube',
            cuentas3.leer('__subidas').length === 1 && cuentas3.leer('__subidas')[0].length === 2);
        check('7 · nextAccountId no repite ids tras la unión',
            cuentas3.leer('nextAccountId') >= 8, 'nextAccountId=' + cuentas3.leer('nextAccountId'));

        // (e2) LIMITACIÓN DOCUMENTADA: si dos equipos acuñan el mismo id a la vez, la
        // unión conserva UNA de las dos versiones (la de memoria). No se puede evitar
        // sin un contador compartido; se comprueba que la unión no duplica el id.
        const almacen4 = almacenCompartido();
        almacen4.setItem('ciervo_accounts', JSON.stringify([
            { id: 1, description: 'del otro equipo', saleId: 'V-OTRO' }
        ]));
        const cuentas4 = crearCuentas({ almacen: almacen4 });
        cuentas4.correr('_accountsCache = [{ id: 1, description: "el mio" }];');
        await cuentas4.correr('persistAccounts()');
        check('7 · (limitación) con el MISMO id no se duplica: gana la copia en memoria',
            cuentasEnDisco(almacen4).length === 1 &&
            (cuentasEnDisco(almacen4)[0] || {}).description === 'el mio');

        // (f) Lo borrado en cuentas.html no resucita al unir.
        cuentas3.correr('_cuentasEliminadas[String(_accountsCache[0].id)] = true; ' +
            '_accountsCache = _accountsCache.filter(a => a.id !== 7);');
        await cuentas3.correr('persistAccounts()');
        check('7 · una cuenta borrada en cuentas.html no resucita con la unión',
            cuentasEnDisco(almacen3).length === 1 &&
            (cuentasEnDisco(almacen3)[0] || {}).saleId === venta.id,
            JSON.stringify(cuentasEnDisco(almacen3).map(x => x.id)));

        // (g) Ordenar por días.
        const orden = cuentas.leer('[{ id: 1, fecha: new Date(Date.now() - 3*86400000).toISOString() },' +
            ' { id: 2, fecha: new Date().toISOString() }].sort((a, b) => sortCompare(a, b, "dias", "desc"))');
        check('7 · ordenar por días funciona (desc: la más antigua primero)',
            orden[0].id === 1 && orden[1].id === 2, JSON.stringify(orden.map(x => x.id)));
    }

    /* ------------------------------------------------------------------ */
    titulo('8. Reportes: el consumo interno NO altera los totales de venta');
    {
        const V_NORMAL = {
            id: 'V-0001', timestamp: '2026-05-10T10:00:00.000Z', currency: 'USD',
            exchangeRate: 40, paymentMethod: 'usd-cash',
            totals: { subtotal: 100, discount: 0, iva: 0, total: 100 },
            items: [{ product: { name: 'Harina', isBulk: false }, quantity: 1, unitPrice: 100,
                subtotal: 100, currency: 'USD' }]
        };
        const V_CONSUMO = Object.assign({}, V_NORMAL, {
            id: 'V-0002', paymentMethod: 'consumo-interno', consumoInterno: true,
            totals: { subtotal: 50, discount: 0, iva: 0, total: 50 },
            items: [{ product: { name: 'Café', isBulk: false }, quantity: 1, unitPrice: 50,
                subtotal: 50, currency: 'USD' }]
        });
        const V_FIADO = Object.assign({}, V_NORMAL, {
            id: 'V-0003', paymentMethod: 'por-cobrar', porCobrar: true,
            totals: { subtotal: 30, discount: 0, iva: 0, total: 30 },
            items: [{ product: { name: 'Arroz', isBulk: false }, quantity: 1, unitPrice: 30,
                subtotal: 30, currency: 'USD' }]
        });

        const lector = crearLector(FUENTE_LECTOR);

        // (a) Camino de RECÁLCULO (sin índice).
        const r = await lector.resumenDelDia('2026-05-10', {
            modoSync: 'clasico',
            fuentes: { historico: () => ({ ok: true, ventas: [V_NORMAL, V_CONSUMO, V_FIADO] }) }
        });
        check('8 · el resumen del día se calcula bien', r.ok === true, JSON.stringify(r.error));
        check('8 · el consumo interno NO cuenta como transacción', r.cantidad === 2, 'cantidad=' + r.cantidad);
        check('8 · el total NO incluye el consumo interno (130, no 180)', r.total === 130, 'total=' + r.total);
        check('8 · el total en USD tampoco lo incluye', r.totalUSD === 130, 'totalUSD=' + r.totalUSD);
        check('8 · el consumo interno NO aparece como método de pago',
            !r.porMetodo['consumo-interno'], JSON.stringify(Object.keys(r.porMetodo)));
        check('8 · el consumo interno se informa APARTE',
            r.consumoInterno.cantidad === 1 && r.consumoInterno.total === 50 &&
            r.consumoInterno.totalUSD === 50, JSON.stringify(r.consumoInterno));
        check('8 · el fiado SÍ cuenta como venta', !!r.porMetodo['por-cobrar'] &&
            r.porMetodo['por-cobrar'].total === 30);
        check('8 · y se informa aparte como NO cobrado',
            r.porCobrar.cantidad === 1 && r.porCobrar.total === 30, JSON.stringify(r.porCobrar));

        // (b) Camino del ÍNDICE del motor (ventas_idx), que ahora lleva las banderas.
        const ops = { ok: true, ventas: [V_NORMAL, V_CONSUMO, V_FIADO], nodos: ['n1', 'n2', 'n3'] };
        const indice = {
            ok: true,
            entradas: {
                n1: { total: 100, totalUSD: 100, metodo: 'usd-cash', items: 1 },
                n2: { total: 50, totalUSD: 50, metodo: 'consumo-interno', consumoInterno: true, items: 1 },
                n3: { total: 30, totalUSD: 30, metodo: 'por-cobrar', porCobrar: true, items: 1 }
            }
        };
        const rIdx = await lector.resumenDelDia('2026-05-10', {
            modoSync: 'operaciones',
            fuentes: {
                ops: () => ops,
                historico: () => ({ ok: true, ventas: [] }),
                indice: () => indice,
                caliente: () => ({ ok: true, ventas: [] }),
                posSales: () => ({ ok: true, ventas: [] })
            }
        });
        check('8 · el índice se usó como caché del día', rIdx.indexado === true && rIdx.completo === true,
            JSON.stringify({ indexado: rIdx.indexado, completo: rIdx.completo }));
        check('8 · con índice, el consumo interno sigue fuera de los totales',
            rIdx.cantidad === 2 && rIdx.total === 130, 'cantidad=' + rIdx.cantidad + ' total=' + rIdx.total);
        check('8 · con índice, el consumo interno se informa aparte',
            rIdx.consumoInterno.cantidad === 1 && rIdx.consumoInterno.totalUSD === 50);
        check('8 · con índice, el fiado se informa aparte',
            rIdx.porCobrar.cantidad === 1 && rIdx.porCobrar.total === 30);

        // Índice viejo (sin banderas): el método de pago es la segunda señal.
        const indiceViejo = { ok: true, entradas: {
            n1: { total: 100, totalUSD: 100, metodo: 'usd-cash', items: 1 },
            n2: { total: 50, totalUSD: 50, metodo: 'consumo-interno', items: 1 }
        } };
        const rViejo = await lector.resumenDelDia('2026-05-10', {
            modoSync: 'operaciones',
            fuentes: {
                ops: () => ({ ok: true, ventas: [V_NORMAL, V_CONSUMO], nodos: ['n1', 'n2'] }),
                historico: () => ({ ok: true, ventas: [] }),
                indice: () => indiceViejo,
                caliente: () => ({ ok: true, ventas: [] }),
                posSales: () => ({ ok: true, ventas: [] })
            }
        });
        check('8 · un índice SIN la bandera también excluye el consumo interno (método de pago)',
            rViejo.total === 100 && rViejo.consumoInterno.cantidad === 1,
            'total=' + rViejo.total);

        // (c) Rango completo.
        const rr = await lector.resumenRango('2026-05-10', '2026-05-10', {
            modoSync: 'clasico',
            fuentes: { historico: () => ({ ok: true, ventas: [V_NORMAL, V_CONSUMO, V_FIADO] }) }
        });
        check('8 · el rango tampoco suma el consumo interno', rr.total === 130, 'total=' + rr.total);
        check('8 · el rango lo informa aparte',
            rr.consumoInterno.cantidad === 1 && rr.consumoInterno.total === 50);
        check('8 · el rango informa el fiado aparte', rr.porCobrar.total === 30);
        check('8 · el día del rango trae sus propios grupos',
            rr.dias[0].consumoInterno.cantidad === 1 && rr.dias[0].total === 130,
            JSON.stringify(rr.dias[0]));

        // (d) El lector expone la clasificación (la usa el resumen).
        check('8 · el lector expone esConsumoInterno/esPorCobrar',
            typeof lector.esConsumoInterno === 'function' && typeof lector.esPorCobrar === 'function');
        check('8 · esConsumoInterno reconoce la bandera y el método',
            lector.esConsumoInterno(V_CONSUMO) === true &&
            lector.esConsumoInterno({ paymentMethod: 'consumo-interno' }) === true &&
            lector.esConsumoInterno(V_NORMAL) === false);
        check('8 · esPorCobrar reconoce la bandera y el método',
            lector.esPorCobrar(V_FIADO) === true &&
            lector.esPorCobrar({ paymentMethod: 'por-cobrar' }) === true &&
            lector.esPorCobrar(V_CONSUMO) === false);
    }

    /* ------------------------------------------------------------------ */
    titulo('9. La página de resumen: tarjetas y gráficos sin consumo interno');
    {
        const V_NORMAL = {
            id: 'V-0001', timestamp: '2026-05-10T10:00:00.000Z', currency: 'USD',
            exchangeRate: 40, paymentMethod: 'usd-cash', ivaApplied: false,
            totals: { subtotal: 100, discount: 0, iva: 0, total: 100 },
            items: [{ product: { name: 'Harina', isBulk: false, cost: 5 }, quantity: 1,
                unitPrice: 100, subtotal: 100, currency: 'USD' }]
        };
        const V_CONSUMO = Object.assign({}, V_NORMAL, {
            id: 'V-0002', paymentMethod: 'consumo-interno', consumoInterno: true,
            totals: { subtotal: 50, discount: 0, iva: 0, total: 50 },
            items: [{ product: { name: 'Café', isBulk: false, cost: 5 }, quantity: 1,
                unitPrice: 50, subtotal: 50, currency: 'USD' }]
        });
        const V_FIADO = Object.assign({}, V_NORMAL, {
            id: 'V-0003', paymentMethod: 'por-cobrar', porCobrar: true,
            totals: { subtotal: 30, discount: 0, iva: 0, total: 30 },
            items: [{ product: { name: 'Arroz', isBulk: false, cost: 5 }, quantity: 1,
                unitPrice: 30, subtotal: 30, currency: 'USD' }]
        });

        const resumen = crearResumen(FUENTE_RESUMEN);
        resumen.correr('allSales = ' + JSON.stringify([V_NORMAL, V_CONSUMO, V_FIADO]) + ';');
        resumen.correr('applyFilters()');

        check('9 · la lista de resultados muestra las TRES ventas (no se esconden)',
            resumen.leer('filteredSales.length') === 3);
        check('9 · solo DOS cuentan para los totales',
            resumen.leer('ventasContablesFiltradas.length') === 2);

        const metricas = resumen.leer('__metricas');
        const porTitulo = {};
        metricas.forEach(m => { porTitulo[m.title] = m; });
        check('9 · las tarjetas se pintaron', metricas.length >= 7, 'tarjetas=' + metricas.length);
        check('9 · «Ventas en USD» excluye el consumo interno (130, no 180)',
            porTitulo['Ventas en USD (Filtro)'].value === '$ 130.00',
            porTitulo['Ventas en USD (Filtro)'].value);
        check('9 · «Transacciones» cuenta solo las ventas (2)',
            porTitulo['Transacciones del Filtro'].value === 2,
            String(porTitulo['Transacciones del Filtro'].value));
        check('9 · la tarjeta de transacciones avisa de lo que queda fuera',
            /consumo interno/.test(porTitulo['Transacciones del Filtro'].subtitle),
            porTitulo['Transacciones del Filtro'].subtitle);
        check('9 · hay tarjeta propia de «Por Cobrar» con el monto fiado',
            !!porTitulo['Por Cobrar (Fiado)'] &&
            porTitulo['Por Cobrar (Fiado)'].value === '$ 30.00' &&
            /NO cobrada/.test(porTitulo['Por Cobrar (Fiado)'].subtitle),
            JSON.stringify(porTitulo['Por Cobrar (Fiado)']));
        check('9 · hay tarjeta propia de «Consumo Interno» que dice que NO es venta',
            !!porTitulo['Consumo Interno'] &&
            porTitulo['Consumo Interno'].value === 1 &&
            /NO es venta/.test(porTitulo['Consumo Interno'].subtitle),
            JSON.stringify(porTitulo['Consumo Interno']));
        check('9 · el producto más vendido no cuenta el consumo interno',
            porTitulo['Producto Más Vendido'].value === 'Harina',
            porTitulo['Producto Más Vendido'].value);

        const porDia = resumen.leer('JSON.stringify(calculateSalesByDay())');
        check('9 · el gráfico por día solo suma las ventas reales (5200 Bs = 130 USD × 40)',
            porDia.indexOf('5200') !== -1, porDia);
        check('9 · el consumo interno NO aparece en el gráfico por día (no hay 2000 Bs)',
            porDia.indexOf('2000') === -1, porDia);
        const porMetodo = resumen.leer('JSON.stringify(calculatePaymentMethods())');
        check('9 · el gráfico de métodos no tiene una barra de consumo interno',
            porMetodo.indexOf('consumo-interno') === -1 && porMetodo.indexOf('Consumo Interno') === -1,
            porMetodo);
        check('9 · el gráfico de métodos sí tiene la barra del fiado',
            porMetodo.indexOf('Por Cobrar') !== -1, porMetodo);

        check('9 · la clasificación de la página coincide con la del lector',
            resumen.correr('esConsumoInternoVenta(allSales[1])') === true &&
            resumen.correr('esVentaPorCobrar(allSales[2])') === true);
        check('9 · el filtro por etiqueta «consumo interno» existe en la página',
            /value="consumo-interno"/.test(HTML_RESUMEN) && /value="por-cobrar"/.test(HTML_RESUMEN));
    }

    /* ------------------------------------------------------------------ */
    titulo('10. Los DOS modos del motor (clásico y operaciones)');
    {
        // (a) Modo CLÁSICO: la venta se sube como siempre y no toca el motor.
        const clasico = escenario({
            perfil: PERFIL_ADMIN, metodo: 'por-cobrar', customer: { name: 'Ana' }
        });
        await clasico.correr('processSale()');
        check('10 · clásico: la venta se sube por el camino de siempre',
            clasico.llamadas.ventasSubidas === 1, String(clasico.llamadas.ventasSubidas));
        check('10 · clásico: el motor NO recibe la venta',
            clasico.llamadas.motor.length === 0);
        check('10 · clásico: la deuda se crea igual',
            cuentasEnDisco(clasico.almacen).length === 1);

        // (b) Modo OPERACIONES: la venta viaja como operación idempotente CON las
        //     banderas, y la deuda se crea igual.
        const opsFiado = escenario({
            perfil: PERFIL_ADMIN, metodo: 'por-cobrar', customer: { name: 'Ana' },
            modo: 'operaciones'
        });
        await opsFiado.correr('processSale()');
        check('10 · operaciones: la venta se registra como operación',
            opsFiado.llamadas.motor.length === 1 &&
            opsFiado.llamadas.motor[0].tipo === 'venta', JSON.stringify(opsFiado.llamadas.motor.length));
        check('10 · operaciones: el payload lleva la marca porCobrar',
            opsFiado.llamadas.motor[0] && opsFiado.llamadas.motor[0].payload.porCobrar === true);
        check('10 · operaciones: NO se sube además el arreglo clásico de ventas',
            opsFiado.llamadas.ventasSubidas === 0, String(opsFiado.llamadas.ventasSubidas));
        check('10 · operaciones: la deuda se crea en el almacén compartido',
            cuentasEnDisco(opsFiado.almacen).length === 1);
        check('10 · operaciones: el stock baja igual',
            stockEnDisco(opsFiado.almacen, 'p1') === 8);

        const opsConsumo = escenario({
            perfil: PERFIL_ADMIN, metodo: 'consumo-interno', modo: 'operaciones'
        });
        await opsConsumo.correr('processSale()');
        check('10 · operaciones: el consumo interno llega al motor con su marca',
            opsConsumo.llamadas.motor.length === 1 &&
            opsConsumo.llamadas.motor[0].payload.consumoInterno === true &&
            opsConsumo.llamadas.motor[0].payload.paymentMethod === 'consumo-interno');
        check('10 · operaciones: el consumo interno no crea deuda',
            opsConsumo.almacen.getItem('ciervo_accounts') === null);

        // (c) El índice del motor lleva las banderas (el lector las usa).
        const fuenteIndice = extraerFuncion(FUENTE_MOTOR, 'escribirIndiceVenta');
        check('10 · el índice del motor marca consumoInterno',
            /consumoInterno:\s*p\.consumoInterno\s*===\s*true/.test(fuenteIndice));
        check('10 · el índice del motor marca porCobrar',
            /porCobrar:\s*p\.porCobrar\s*===\s*true/.test(fuenteIndice));
        check('10 · el motor sigue sin tocar el resto del índice (total/items/metodo)',
            /total:\s*total/.test(fuenteIndice) && /items:/.test(fuenteIndice) && /metodo:/.test(fuenteIndice));
    }

    /* ------------------------------------------------------------------ */
    titulo('11. La nube de cuentas no pisa lo de otro equipo (unión por id)');
    {
        const almacen = almacenCompartido();
        const pos = escenario({
            almacen: almacen, perfil: PERFIL_ADMIN, metodo: 'por-cobrar',
            customer: { name: 'Ana' }
        });
        // La nube ya tiene una cuenta de OTRO equipo; el POS no la conoce todavía.
        const cuentaAjena = {
            id: 77, type: 'pagar', description: 'Proveedor', contact: 'Distribuidora',
            amount: 500, dueDate: '2030-01-01', category: 'Operaciones', payments: [], status: 'pending'
        };
        const subidas = [];
        pos.correr('__cloud = true;');
        pos.correr('__db = { ref: function (ruta) { return { ' +
            'once: function () { return Promise.resolve({ val: function () { return __nube; } }); }, ' +
            'set: function (v) { __llamadas.cuentasSubidas.push(v); return Promise.resolve(true); } }; } };');
        pos.correr('var __nube = [ ' + JSON.stringify(cuentaAjena) + ' ];');

        await pos.correr('processSale()');
        await esperarMicrotareas();
        await esperarMicrotareas();

        const enDisco = cuentasEnDisco(almacen);
        check('11 · la deuda del POS está en el almacén', enDisco.length === 2,
            'cuentas=' + enDisco.length);
        check('11 · la cuenta del OTRO equipo no se perdió al subir',
            enDisco.some(c => c.id === 77));
        check('11 · se subió a la nube el arreglo unido',
            pos.llamadas.cuentasSubidas.length === 1 &&
            pos.llamadas.cuentasSubidas[0].length === 2,
            'subidas=' + pos.llamadas.cuentasSubidas.length);
        check('11 · la subida va con la marca de pendiente compartida (subirConMarcaSync)',
            pos.leer('__marcas').indexOf('subir:cuentas') !== -1, pos.leer('__marcas').join(','));

        // Sin permiso de nube (cloudSync false) NO se escribe en la nube.
        const almacen2 = almacenCompartido();
        const sinNube = escenario({
            almacen: almacen2, perfil: PERFIL_ADMIN, metodo: 'por-cobrar',
            customer: { name: 'Ana' }
        });
        sinNube.correr('__db = { ref: function () { return { ' +
            'once: function () { return Promise.resolve({ val: function () { return null; } }); }, ' +
            'set: function (v) { __llamadas.cuentasSubidas.push(v); return Promise.resolve(true); } }; } };');
        await sinNube.correr('processSale()');
        await esperarMicrotareas();
        check('11 · sin permiso de nube NO se escribe en la nube',
            sinNube.llamadas.cuentasSubidas.length === 0);
        check('11 · pero la deuda queda igualmente en el almacén local',
            cuentasEnDisco(almacen2).length === 1);
    }

    /* ------------------------------------------------------------------ */
    titulo('12. Unión por id (unidad): no se pierde nada de lo que ya había');
    {
        const pos = escenario({ perfil: PERFIL_ADMIN });
        const union = pos.correr('unirCuentasPorId([{ id: 1, description: "memoria" }], ' +
            '[{ id: 1, description: "otra copia" }, { id: 2, description: "añadida por otro" }])');
        check('12 · la unión conserva la versión en memoria', union.length === 2 &&
            (union[0] || {}).description === 'memoria');
        check('12 · la unión añade lo que solo estaba en el almacén',
            (union[1] || {}).description === 'añadida por otro');
        check('12 · la unión no modifica las listas de entrada',
            pos.correr('(function(){ var a=[{id:1}]; var b=[{id:2}]; unirCuentasPorId(a,b); ' +
                'return a.length === 1 && b.length === 1; })()') === true);
        check('12 · el siguiente id se calcula sobre la lista más grande',
            pos.correr('siguienteIdCuenta([{ id: 4 }, { id: 9 }])') === 10);
        check('12 · normalizarCuentas acepta el objeto con claves numéricas de la nube',
            pos.correr('normalizarCuentas({ "0": { id: 1 }, "1": { id: 2 } }).length') === 2);
        check('12 · normalizarCuentas acepta un arreglo',
            pos.correr('normalizarCuentas([{ id: 1 }]).length') === 1);
        check('12 · normalizarCuentas no revienta con basura',
            pos.correr('normalizarCuentas(null).length') === 0 &&
            pos.correr('normalizarCuentas("texto").length') === 0);
    }

    /* ------------------------------------------------------------------ */
    titulo('13. MUTACIONES: cada comprobación clave se rompe y se nota');

    /* M1 · Quitar la puerta de administrador de processSale. */
    {
        const mut = mutar(FUENTE_POS,
            "                if (!puedeUsarMetodoPago(selectedPaymentMethod)) {\n" +
            "                    showToast('Ese método de pago es solo para administradores.');\n" +
            "                    reactivarBotonConfirmar();",
            "                if (false) {\n" +
            "                    showToast('Ese método de pago es solo para administradores.');\n" +
            "                    reactivarBotonConfirmar();",
            'quitar la puerta de processSale');
        check('13 · la mutación «sin puerta en processSale» se pudo aplicar', mut !== null);
        if (mut) {
            const pos = escenario({
                perfil: PERFIL_VENDEDOR, metodo: 'consumo-interno', fuente: mut
            });
            await pos.correr('processSale()');
            check('13 · MUTACIÓN DETECTADA: sin la puerta, el Vendedor cobra consumo interno',
                pos.leer('ventas.length') === 1 && stockEnDisco(pos.almacen, 'p1') === 8);
        } else { check('13 · MUTACIÓN DETECTADA: sin la puerta, el Vendedor cobra', false); }
    }

    /* M2 · Hacer que la parrilla no filtre los métodos de dueño. */
    {
        const mut = mutar(FUENTE_POS, '.filter(method => puedeUsarMetodoPago(method.id));',
            '.filter(method => true);', 'quitar el filtro de la parrilla');
        check('13 · la mutación «parrilla sin filtro» se pudo aplicar', mut !== null);
        if (mut) {
            const pos = escenario({ perfil: PERFIL_VENDEDOR, fuente: mut });
            pos.correr('loadModalPaymentMethods()');
            const html = pos.documento.getElementById('modalPaymentMethods').innerHTML;
            check('13 · MUTACIÓN DETECTADA: sin filtro, el Vendedor VE el botón de fiado',
                html.indexOf('Por Cobrar') !== -1);
        } else { check('13 · MUTACIÓN DETECTADA: el botón del fiado se cuela', false); }
    }

    /* M3 · Hacer que cualquier perfil sea administrador. */
    {
        const mut = mutar(FUENTE_POS,
            "return METODOS_SOLO_ADMIN.indexOf(String(idMetodo || '')) !== -1;",
            "return false;   // mutación: nada es solo-admin", 'neutralizar metodoSoloAdmin');
        check('13 · la mutación «todo el mundo es admin» se pudo aplicar', mut !== null);
        if (mut) {
            const pos = escenario({ perfil: PERFIL_VENDEDOR, fuente: mut });
            check('13 · MUTACIÓN DETECTADA: sin la lista de métodos de dueño, cualquiera pasa',
                pos.leer('puedeUsarMetodoPago("por-cobrar")') === true &&
                pos.leer('puedeUsarMetodoPago("consumo-interno")') === true);
        } else { check('13 · MUTACIÓN DETECTADA: cualquiera pasa', false); }
    }

    /* M4 · No marcar la venta como consumo interno. */
    {
        const mut = mutar(FUENTE_POS,
            "if (selectedPaymentMethod === 'consumo-interno') saleData.consumoInterno = true;",
            "if (false) saleData.consumoInterno = true;", 'quitar la marca consumoInterno');
        check('13 · la mutación «sin marca de consumo interno» se pudo aplicar', mut !== null);
        if (mut) {
            const pos = escenario({ perfil: PERFIL_ADMIN, metodo: 'consumo-interno', fuente: mut });
            await pos.correr('processSale()');
            check('13 · MUTACIÓN DETECTADA: la venta queda sin la marca propia consumoInterno',
                pos.leer('ventas[0].consumoInterno') !== true);
        } else { check('13 · MUTACIÓN DETECTADA: falta la marca propia', false); }
    }

    /* M5 · No marcar el fiado. */
    {
        const mut = mutar(FUENTE_POS,
            "if (selectedPaymentMethod === 'por-cobrar') saleData.porCobrar = true;",
            "if (false) saleData.porCobrar = true;", 'quitar la marca porCobrar');
        check('13 · la mutación «sin marca de fiado» se pudo aplicar', mut !== null);
        if (mut) {
            const pos = escenario({
                perfil: PERFIL_ADMIN, metodo: 'por-cobrar', customer: { name: 'Ana' }, fuente: mut
            });
            await pos.correr('processSale()');
            check('13 · MUTACIÓN DETECTADA: la venta fiada queda sin su marca',
                pos.leer('ventas[0].porCobrar') !== true);
        } else { check('13 · MUTACIÓN DETECTADA: falta la marca del fiado', false); }
    }

    /* M6 · No crear la deuda. */
    {
        const mut = mutar(FUENTE_POS,
            '                if (saleData.porCobrar) {\n' +
            '                    const deuda = agregarCuentaPorCobrar(saleData);',
            '                if (false) {\n' +
            '                    const deuda = agregarCuentaPorCobrar(saleData);',
            'quitar la creación de la deuda');
        check('13 · la mutación «sin deuda» se pudo aplicar', mut !== null);
        if (mut) {
            const pos = escenario({
                perfil: PERFIL_ADMIN, metodo: 'por-cobrar', customer: { name: 'Ana' }, fuente: mut
            });
            await pos.correr('processSale()');
            check('13 · MUTACIÓN DETECTADA: sin crear la deuda no hay cuenta por cobrar',
                pos.almacen.getItem('ciervo_accounts') === null);
        } else { check('13 · MUTACIÓN DETECTADA: no se crea la deuda', false); }
    }

    /* M7 · Perder lo que otro proceso añadió (unión por id rota). */
    {
        const mut = mutar(FUENTE_POS,
            '            (Array.isArray(otras) ? otras : []).forEach(c => {',
            '            if (true) return lista;   // mutación: se pierde lo que solo está en `otras`\n' +
            '            (Array.isArray(otras) ? otras : []).forEach(c => {',
            'romper la unión por id del POS');
        check('13 · la mutación «unión por id rota» se pudo aplicar', mut !== null);
        if (mut) {
            const pos = escenario({ perfil: PERFIL_ADMIN, fuente: mut });
            const union = pos.correr('unirCuentasPorId([{ id: 1 }], [{ id: 1 }, { id: 2 }])');
            check('13 · MUTACIÓN DETECTADA: con la unión rota se pierde lo añadido por otro',
                union.length === 1);
        } else { check('13 · MUTACIÓN DETECTADA: se pierde lo de otro', false); }
    }

    /* M8 · Perder la idempotencia del fiado. */
    {
        const mut = mutar(FUENTE_POS, 'if (referencia) {\n                    const ya = cuentas.find',
            'if (false) {\n                    const ya = cuentas.find', 'quitar la idempotencia');
        check('13 · la mutación «sin idempotencia» se pudo aplicar', mut !== null);
        if (mut) {
            const almacen = almacenCompartido();
            const pos = escenario({
                almacen: almacen, perfil: PERFIL_ADMIN, metodo: 'por-cobrar',
                customer: { name: 'Ana' }, fuente: mut
            });
            await pos.correr('processSale()');
            const venta = pos.leer('ventas[0]');
            pos.correr('agregarCuentaPorCobrar(' + JSON.stringify(venta) + ')');
            check('13 · MUTACIÓN DETECTADA: sin idempotencia la misma venta crea DOS deudas',
                cuentasEnDisco(almacen).length === 2);
        } else { check('13 · MUTACIÓN DETECTADA: la venta genera dos deudas', false); }
    }

    /* M9 · Ignorar los días de recordatorio configurados. */
    {
        const mut = mutar(FUENTE_POS,
            "                return (isNaN(dias) || dias < 0) ? 7 : dias;",
            "                return 7;   // mutación: se ignora cta_reminder_days",
            'ignorar cta_reminder_days');
        check('13 · la mutación «recordatorio fijo» se pudo aplicar', mut !== null);
        if (mut) {
            const almacen = almacenCompartido();
            const pos = escenario({
                almacen: almacen, perfil: PERFIL_ADMIN, metodo: 'por-cobrar',
                customer: { name: 'Ana' }, recordatorio: 3, fuente: mut
            });
            await pos.correr('processSale()');
            await esperarMicrotareas();
            const c = cuentasEnDisco(almacen)[0];
            check('13 · MUTACIÓN DETECTADA: el vencimiento deja de respetar los 3 días',
                (c || {}).dueDate !== fechaMasDias(HOY_ISO, 3), c && c.dueDate);
        } else { check('13 · MUTACIÓN DETECTADA: el vencimiento cambia', false); }
    }

    /* M10 · El lector deja de excluir el consumo interno. */
    {
        const mut = mutar(FUENTE_LECTOR,
            '                    if (esConsumoInterno(venta)) {\n' +
            '                        sumarGrupo(res.consumoInterno, t, u);\n' +
            '                        continue;   // no es una venta: no entra en los totales',
            '                    if (false) {\n' +
            '                        sumarGrupo(res.consumoInterno, t, u);\n' +
            '                        continue;   // no es una venta: no entra en los totales',
            'quitar la exclusión del consumo interno');
        check('13 · la mutación «lector sin exclusión» se pudo aplicar', mut !== null);
        if (mut) {
            const lector = crearLector(mut);
            const V_CONSUMO = {
                id: 'V-0002', timestamp: '2026-05-10T10:00:00.000Z', currency: 'USD',
                exchangeRate: 40, paymentMethod: 'consumo-interno', consumoInterno: true,
                totals: { subtotal: 50, discount: 0, iva: 0, total: 50 }, items: []
            };
            const r = await lector.resumenDelDia('2026-05-10', {
                modoSync: 'clasico', fuentes: { historico: () => ({ ok: true, ventas: [V_CONSUMO] }) }
            });
            check('13 · MUTACIÓN DETECTADA: sin la exclusión el consumo interno suma como venta',
                r.total === 50 && r.consumoInterno.cantidad === 0,
                'total=' + r.total + ' grupo=' + r.consumoInterno.cantidad);
        } else { check('13 · MUTACIÓN DETECTADA: el consumo interno suma', false); }
    }

    /* M11 · La página de resumen deja de filtrar el consumo interno. */
    {
        const mut = mutar(FUENTE_RESUMEN,
            'ventasContablesFiltradas = filteredSales.filter(sale => !esConsumoInternoVenta(sale));',
            'ventasContablesFiltradas = filteredSales.slice();',
            'quitar el filtro contable del resumen');
        check('13 · la mutación «resumen sin filtro contable» se pudo aplicar', mut !== null);
        if (mut) {
            const V_NORMAL = {
                id: 'V-0001', timestamp: '2026-05-10T10:00:00.000Z', currency: 'USD',
                exchangeRate: 40, paymentMethod: 'usd-cash', ivaApplied: false,
                totals: { subtotal: 100, discount: 0, iva: 0, total: 100 },
                items: [{ product: { name: 'Harina', isBulk: false, cost: 5 }, quantity: 1,
                    unitPrice: 100, subtotal: 100, currency: 'USD' }]
            };
            const V_CONSUMO = Object.assign({}, V_NORMAL, {
                id: 'V-0002', paymentMethod: 'consumo-interno', consumoInterno: true,
                totals: { subtotal: 50, discount: 0, iva: 0, total: 50 },
                items: [{ product: { name: 'Café', isBulk: false, cost: 5 }, quantity: 1,
                    unitPrice: 50, subtotal: 50, currency: 'USD' }]
            });
            const resumen = crearResumen(mut);
            resumen.correr('allSales = ' + JSON.stringify([V_NORMAL, V_CONSUMO]) + ';');
            resumen.correr('applyFilters()');
            const m = resumen.leer('__metricas');
            const ventas = m.filter(x => x.title === 'Ventas en USD (Filtro)')[0];
            check('13 · MUTACIÓN DETECTADA: sin el filtro, el consumo interno entra en las ventas',
                ventas && ventas.value === '$ 150.00', ventas && ventas.value);
        } else { check('13 · MUTACIÓN DETECTADA: el consumo entra en las ventas', false); }
    }

    /* M12 · cuentas.html deja de unir por id antes de guardar. */
    {
        const mut = mutar(FUENTE_CUENTAS,
            '            _accountsCache = fusionarCuentasConAlmacen(_accountsCache);',
            '            // mutación: sin unión por id',
            'quitar la unión por id de cuentas.html');
        check('13 · la mutación «cuentas.html sin unión» se pudo aplicar', mut !== null);
        if (mut) {
            const almacen = almacenCompartido();
            const fiado = { id: 5, type: 'cobrar', description: 'Venta a crédito (fiado) V-0001',
                contact: 'Ana', amount: 30, dueDate: '2030-01-01', category: 'Ventas',
                payments: [], status: 'pending', saleId: 'V-0001', origen: 'pos' };
            almacen.setItem('ciervo_accounts', JSON.stringify([fiado]));
            const cuentas = crearCuentas({ almacen: almacen, fuente: mut });
            cuentas.correr('_accountsCache = [{ id: 1, type: "cobrar", description: "Vieja", ' +
                'contact: "X", amount: 5, dueDate: "2030-01-01", category: "Otros", ' +
                'payments: [], status: "pending" }];');
            await cuentas.correr('persistAccounts()');
            check('13 · MUTACIÓN DETECTADA: sin la unión, guardar en cuentas.html borra el fiado',
                cuentasEnDisco(almacen).length === 1 &&
                !cuentasEnDisco(almacen).some(x => x.saleId === 'V-0001'));
        } else { check('13 · MUTACIÓN DETECTADA: el fiado se borra', false); }
    }

    /* M13 · El ticket deja de avisar. */
    {
        const mut = mutar(FUENTE_POS,
            "            html += `<div class=\"c b\" style=\"margin-top:6px\">*** CONSUMO INTERNO — NO ES UNA VENTA ***</div>`;",
            '            html += ``;', 'quitar el aviso del ticket');
        check('13 · la mutación «ticket sin aviso» se pudo aplicar', mut !== null);
        if (mut) {
            const pos = escenario({ perfil: PERFIL_ADMIN, metodo: 'consumo-interno', fuente: mut });
            await pos.correr('processSale()');
            check('13 · MUTACIÓN DETECTADA: sin el aviso, el ticket parece un cobro normal',
                !/NO ES UNA VENTA/.test(pos.ticket()));
        } else { check('13 · MUTACIÓN DETECTADA: el ticket avisa', false); }
    }

    /* ------------------------------------------------------------------ */
    titulo('14. Invariantes del código');
    {
        const proc = extraerFuncion(BLOQUE_APP.codigo, 'processSale');
        check('14 · processSale comprueba la puerta ANTES de releer el stock',
            proc.indexOf('puedeUsarMetodoPago(selectedPaymentMethod)') !== -1 &&
            proc.indexOf('puedeUsarMetodoPago(selectedPaymentMethod)') < proc.indexOf('revisarStockParaVenta()'));
        check('14 · processSale NO se fía de la interfaz (la puerta está en el cobro)',
            /if \(!puedeUsarMetodoPago\(selectedPaymentMethod\)\) \{/.test(proc));
        check('14 · «por cobrar» exige cliente también en processSale',
            /selectedPaymentMethod === 'por-cobrar' && !nombreClienteFiado\(\)/.test(proc));
        check('14 · la deuda se crea DESPUÉS de guardar la venta',
            proc.indexOf('agregarCuentaPorCobrar(saleData)') > proc.indexOf("guardarLocalSeguro('pos_sales'") ||
            proc.indexOf('agregarCuentaPorCobrar(saleData)') > proc.indexOf('ventas.push(saleData)'));
        check('14 · la creación de la deuda NO se espera (no frena el cobro)',
            !/await agregarCuentaPorCobrar/.test(proc));

        const puerta = extraerFuncion(BLOQUE_APP.codigo, 'esOperadorAdministrador');
        check('14 · el rol del operador manda cuando existe', /operador\.role === 'Administrador'/.test(puerta));
        check('14 · sin operador decide la marca de propietario', /esSesionDePropietario\(\)/.test(puerta));
        check('14 · solo la marca compartida NO concede permisos de dueño',
            !/sesionActiva/.test(extraerFuncion(BLOQUE_APP.codigo, 'esSesionDePropietario')));

        check('14 · los dos métodos están declarados como solo-admin',
            /METODOS_SOLO_ADMIN = \['por-cobrar', 'consumo-interno'\]/.test(BLOQUE_APP.codigo));
        check('14 · los dos métodos están en las dos monedas con soloAdmin',
            (BLOQUE_APP.codigo.match(/id: 'por-cobrar', name: 'Por Cobrar', icon: '📝', soloAdmin: true/g) || []).length === 2 &&
            (BLOQUE_APP.codigo.match(/id: 'consumo-interno', name: 'Consumo Interno', icon: '🏠', soloAdmin: true/g) || []).length === 2);
        check('14 · la clave de las cuentas es la MISMA que usa cuentas.html',
            /CUENTAS_CLAVE = 'ciervo_accounts'/.test(BLOQUE_APP.codigo) &&
            /localStorage\.getItem\('ciervo_accounts'\)/.test(BLOQUE_CUENTAS.codigo));
        check('14 · el POS usa guardarLocalSeguro (guardián de cuota) para las cuentas',
            /guardarLocalSeguro\(CUENTAS_CLAVE/.test(BLOQUE_APP.codigo));
        check('14 · cuentas.html conserva los campos extra al editar (spread + saneado)',
            /normalizarCuenta\(\{ \.\.\._accountsCache\[index\], \.\.\.accountData \}\)/.test(BLOQUE_CUENTAS.codigo));
        check('14 · el lector clasifica por bandera propia Y por método',
            /v\.consumoInterno === true/.test(FUENTE_LECTOR) &&
            /paymentMethod \|\| ''\) === 'consumo-interno'/.test(FUENTE_LECTOR) &&
            /v\.porCobrar === true/.test(FUENTE_LECTOR) &&
            /paymentMethod \|\| ''\) === 'por-cobrar'/.test(FUENTE_LECTOR));
        check('14 · el resumen usa la lista contable en sus tres cálculos',
            (BLOQUE_RESUMEN.codigo.match(/ventasContablesFiltradas\.forEach/g) || []).length === 4);
        check('14 · el resumen conserva la lista completa para mostrar (filteredSales)',
            /filteredSales = allSales\.filter/.test(BLOQUE_RESUMEN.codigo));
        // El POS clásico SÍ escribe ventas/historial (fbSaveVentas, camino de siempre):
        // lo que se comprueba es que el camino NUEVO de las cuentas no lo toca y que el
        // motor sigue sin escribir en ese nodo congelado.
        const fuenteCuentas = extraerFuncion(BLOQUE_APP.codigo, 'agregarCuentaPorCobrar') +
            extraerFuncion(BLOQUE_APP.codigo, 'sincronizarCuentasConNube');
        check('14 · el camino nuevo de las cuentas no toca ventas/historial',
            fuenteCuentas.indexOf('ventas/historial') === -1);
        check('14 · el motor no escribe en ventas/historial (solo lo lee)',
            !/ventas\/historial[^\n]*\.(set|update|remove)\s*\(/.test(FUENTE_MOTOR));
        check('14 · el POS no escribe en BBDD/... nada que no sea cuentas desde este cambio',
            /BBDD\/' \+ sanitizeEmailForDb\(email\) \+ '\/cuentas'/.test(BLOQUE_APP.codigo));
    }

    /* ------------------------------------------------------------------ */
    console.log('\n================ ' + ok + ' OK, ' + fallos + ' FALLAS ================');
    console.log('      Nota: los dobles simulan el navegador, la nube y el motor. No se');
    console.log('      prueban OPFS/IndexedDB, Firebase real, el pintado real del DOM ni');
    console.log('      la impresora. Ver INFORME_FORMAS_PAGO.md.');
    process.exit(fallos ? 1 : 0);
})();

/* =====================================================================
   Apoyos de la suite
   ===================================================================== */

function fechaMasDias(isoDia, dias) {
    const t = Date.parse(isoDia + 'T00:00:00.000Z') + dias * 24 * 60 * 60 * 1000;
    return new Date(t).toISOString().split('T')[0];
}

/** Aplica una mutación al código real; null si el texto no aparece exactamente una vez. */
function mutar(fuente, viejo, nuevo, etiqueta) {
    const veces = fuente.split(viejo).length - 1;
    if (veces !== 1) {
        console.log('      (la mutación «' + etiqueta + '» no es aplicable: ' + veces + ' coincidencias)');
        return null;
    }
    return fuente.replace(viejo, () => nuevo);
}

function crearLector(fuente) {
    const almacen = almacenCompartido();
    const entorno = {
        console: { log: function () {}, warn: function () {}, error: function () {} },
        JSON: JSON, Date: Date, Math: Math, Object: Object, Array: Array,
        String: String, Number: Number, Boolean: Boolean, isFinite: isFinite, isNaN: isNaN,
        parseInt: parseInt, parseFloat: parseFloat, Promise: Promise,
        localStorage: almacen,
        sessionStorage: crearSessionStorage({}),
        navigator: { onLine: true }
    };
    entorno.window = entorno;
    entorno.globalThis = entorno;
    vm.createContext(entorno);
    vm.runInContext(fuente, entorno, { filename: 'lector_ventas.js' });
    return entorno.lectorVentas;
}

function crearCuentas(opciones) {
    const op = opciones || {};
    const almacen = op.almacen || almacenCompartido();
    const documento = crearDocumentoFalso();
    const errores = [];
    const ctx = {
        console: {
            log: function () {}, warn: function () {},
            error: function () { errores.push([].slice.call(arguments).map(String).join(' ')); }
        },
        JSON: JSON, Date: Date, Math: Math, Object: Object, Array: Array,
        String: String, Number: Number, Boolean: Boolean, isFinite: isFinite, isNaN: isNaN,
        parseInt: parseInt, parseFloat: parseFloat, Promise: Promise, Intl: Intl,
        localStorage: almacen,
        // Fase 0 de cuentas: la página tiene puerta de rol. Aquí se simula una pestaña
        // de ADMINISTRADOR (el caso normal de quien usa el módulo) para que las
        // comprobaciones de compatibilidad sigan siendo válidas.
        sessionStorage: crearSessionStorage({
            currentUser: JSON.stringify({ username: 'jefa', role: 'Administrador' })
        }),
        Chart: function () {},
        document: documento,
        __subidas: [],
        showNotification: function () {},
        renderAccounts: function () {},
        updateDashboard: function () {},
        closePaymentModal: function () {},
        marcarPendienteSync: function () {},
        limpiarPendienteSync: function () {},
        escapeHtml: function (s) {
            return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
        // La nube se sustituye por un registrador: lo que se prueba aquí es el
        // arreglo que la página HABRÍA subido (unión por id incluida).
        syncToFirebase: function (data) {
            ctx.__subidas.push(JSON.parse(JSON.stringify(data)));
            return Promise.resolve(true);
        }
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    ctx.window.addEventListener = function () {};
    vm.createContext(ctx);
    vm.runInContext(op.fuente || FUENTE_CUENTAS, ctx, { filename: 'cuentas.html (funciones reales)' });
    return {
        ctx: ctx,
        documento: documento,
        errores: errores,
        leer: function (expr) { return vm.runInContext(expr, ctx); },
        correr: function (codigo) { return vm.runInContext(codigo, ctx); }
    };
}

function crearResumen(fuente) {
    const documento = crearDocumentoFalso();
    const ctx = {
        console: { log: function () {}, warn: function () {}, error: function () {} },
        JSON: JSON, Date: Date, Math: Math, Object: Object, Array: Array,
        String: String, Number: Number, Boolean: Boolean, isFinite: isFinite, isNaN: isNaN,
        parseInt: parseInt, parseFloat: parseFloat, Promise: Promise, Intl: Intl,
        document: documento,
        localStorage: almacenCompartido(),
        navigator: { onLine: true },
        __metricas: [],
        // Solo se sustituye el PINTADO; los cálculos son los reales de la página.
        renderMetrics: function (metricas) { ctx.__metricas = metricas; },
        loadCharts: function () {},
        renderResults: function () {},
        renderPagination: function () {},
        actualizarAvisoDatos: function () {},
        showToast: function () {},
        _lecturaActual: null,
        _modoLectura: 'clasico'
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    ctx.window.lectorVentas = null;
    vm.createContext(ctx);
    vm.runInContext(fuente, ctx, { filename: 'mini_market_pos_resumen.html (funciones reales)' });
    return {
        ctx: ctx,
        leer: function (expr) { return vm.runInContext(expr, ctx); },
        correr: function (codigo) { return vm.runInContext(codigo, ctx); }
    };
}
