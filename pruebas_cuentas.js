/* =====================================================================
   PRUEBAS DEL MÓDULO DE CUENTAS POR COBRAR / POR PAGAR — FASE 0

   Se ejecuta con:  node pruebas_cuentas.js
   Contra otro archivo (para ver el «antes»):  CUENTAS_FUENTE=_cuentas_head.html node pruebas_cuentas.js

   QUÉ SE COMPRUEBA (siempre sobre el CÓDIGO REAL, extraído de cuentas.html y
   ejecutado en `vm`; los dobles son solo el navegador, el almacén y la nube):
     0.1  El estado es DERIVADO: una cuenta pagada a la que le suben el importe deja
          de estar «Pagado» y vuelve a sumar en el tablero.
     0.2  Un registro a medio formar (sin `payments`, con importes de texto, con
          fechas basura) no rompe la pantalla: se sanea al cargar.
     0.3  Puerta de rol en DOS capas: sin perfil de administrador no se ve el módulo
          ni se escribe NADA (alta, abono, borrado, guardado, subida).
     0.4  El flujo de caja cuenta TODOS los abonos (también los parciales) y asigna
          bien el mes (sin sustos de zona horaria).
     0.5  Lápidas persistentes (no se resucita lo borrado, ni en otra pestaña ni
          desde la nube) e ids monótonos persistidos (no se reutiliza un id).
     0.6  Mutaciones: se RESTAURA a propósito cada fallo original y la suite tiene
          que ponerse en rojo (no es una suite vacua).

   La nube llega en forma de ARREGLO o de OBJETO con claves '0','1',… (Realtime
   Database entrega el arreglo disperso en cuanto falta una posición): las dos
   formas se prueban.

   NO es un navegador: no se prueban Chart.js real, el pintado real del DOM ni
   Firebase. Ver AUDITORIA_CUENTAS.md.
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = __dirname;
const ARCHIVO = process.env.CUENTAS_FUENTE
    ? path.resolve(RAIZ, process.env.CUENTAS_FUENTE)
    : path.join(RAIZ, 'cuentas.html');
const ES_EL_REAL = !process.env.CUENTAS_FUENTE;

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
    const salida = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        if (/\bsrc\s*=/.test(m[1] || '')) continue;
        const tipo = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1] || '') || [])[1] || '';
        const t = tipo.toLowerCase();
        if (!(t === '' || t === 'text/javascript' || t === 'application/javascript')) continue;
        salida.push(m[2]);
    }
    return salida;
}

const BYTES = fs.readFileSync(ARCHIVO);
const HTML = BYTES.toString('utf8').replace(/\r\n/g, '\n');
const BLOQUE = bloquesEnLinea(HTML).find(b => /function createAccountRow\s*\(/.test(b));

const FUNCIONES = [
    // --- fase 0: puerta de rol ---
    'leerOperadorActual', 'esSesionDePropietario', 'esOperadorAdministrador', 'permiteVerCuentas',
    'permiteEditarCuentas', 'mostrarAvisoSinAcceso', 'mostrarBannerSoloLectura', 'aplicarPuertaDeRol',
    // --- fase 0: normalizador, saldo y estado derivado ---
    'numeroSeguro', 'fechaHoyIso', 'fechaValida', 'normalizarPago', 'normalizarCuenta',
    'abonosDe', 'abonadoDe', 'saldoPendiente', 'estadoDeCuenta', 'mesDePago',
    // --- fase 0: lápidas e ids ---
    'leerCuentasBorradas', 'guardarCuentasBorradas', 'marcarCuentaBorrada', 'olvidarCuentaBorrada',
    'idEstaLapidado', 'leerUltimoIdCuentas', 'maxIdDeCuentas', 'proximoIdCuenta', 'reservarIdCuenta',
    'sincronizarContadorId', 'compararCuentas', 'mismaCuenta',
    // --- rediseño de la pantalla (solo presentación: vista, filtros, tarjetas) ---
    'diasRecordatorioCuentas', 'fechaMasDias', 'idSeguroCuenta', 'escribirTexto',
    'hayFiltrosCuentas', 'cuentaPasaFiltros', 'cambiarVistaCuentas', 'aplicarOrdenCuentas',
    'alternarChipCuentas', 'limpiarFiltrosCuentas', 'toggleDetalleCuenta', 'filtrarPorContacto',
    'filtrarPorContactoDeCuenta', 'abrirVentaEnResumen', 'abrirDetalleCuentaDestacada',
    'aplicarParametrosCuentas',
    // --- existentes que usan las anteriores ---
    'normalizarCuentas', 'leerCuentasDelAlmacen', 'fusionarCuentasConAlmacen', 'diasDeDeuda',
    'detalleDeudaHtml', 'sortCompare', 'updateAccountStatuses', 'saveAccountsCache',
    'persistAccounts', 'validateForm', 'saveAccount', 'confirmDelete', 'openPaymentModal',
    'openModal', 'fillForm', 'resetForm', 'closeModal', 'deleteAccount', 'closeDeleteModal',
    'closePaymentModal', 'confirmPayment', 'updateDashboard', 'exportAccounts', 'renderAccounts',
    'createAccountRow', 'renderCashFlowChart', 'loadAccounts', 'loadAccountsAsync', 'convertToCSV'
];
const CONSTANTES = ['_cuentasEliminadas', 'CUENTAS_BORRADAS_CLAVE', 'CUENTAS_ULTIMO_ID_CLAVE',
    'CTA_MODO_VENDEDOR'];
/** Estado de la vista (rediseño): se declara tal cual está en la página. */
const VARIABLES = ['vistaCuentas', 'ordenCuentas', 'chipsCuentas', 'cuentaDestacada', 'ORDENES_CUENTAS'];

let FUENTE = null, errorExtraccion = '';
try {
    const trozos = [
        'var _accountsCache = [];',
        'let nextAccountId = 1;',
        'var payingAccountId = null;',
        'var editingAccountId = null;',
        'var deletingAccountId = null;',
        'var cashFlowChartInstance = null;',
        'var currentSort = { key: null, direction: "asc" };'
    ];
    CONSTANTES.forEach(n => trozos.push(extraerDeclaracion(BLOQUE, n)));
    VARIABLES.forEach(n => trozos.push(extraerDeclaracion(BLOQUE, n)));
    FUNCIONES.forEach(n => trozos.push(extraerFuncion(BLOQUE, n)));
    FUENTE = trozos.join('\n\n');
} catch (e) { errorExtraccion = e.message; }

titulo('0. Extracción del código real (' + path.basename(ARCHIVO) + ')');

if (ES_EL_REAL) {
    let crlf = 0, lf = 0;
    for (let i = 0; i < BYTES.length; i++) {
        if (BYTES[i] === 10) { lf++; if (i > 0 && BYTES[i - 1] === 13) crlf++; }
    }
    check('cuentas.html mantiene CRLF en todas sus líneas', lf > 0 && crlf === lf, 'LF=' + lf + ' CRLF=' + crlf);
} else {
    nota('se está probando OTRO archivo (' + process.env.CUENTAS_FUENTE + '): el CRLF no se comprueba');
}
check('se encontró el bloque principal de cuentas.html', !!BLOQUE);
check('se pudieron extraer las funciones y constantes reales', FUENTE !== null, errorExtraccion);

let compila = false, errorCompila = '';
try { new vm.Script(FUENTE); compila = true; } catch (e) { errorCompila = e.message; }
check('las funciones extraídas compilan (new vm.Script)', compila, errorCompila);

if (!FUENTE) {
    console.log('\n================ ' + ok + ' OK, ' + fallos + ' FALLAS ================');
    process.exit(1);
}

/* =====================================================================
   DOBLES (solo lo que NO es la lógica: almacén, sesión, DOM y nube)
   ===================================================================== */

function almacen(inicial) {
    const datos = new Map();
    Object.keys(inicial || {}).forEach(k => datos.set(String(k), String(inicial[k])));
    return {
        _datos: datos,
        getItem: function (k) { k = String(k); return datos.has(k) ? datos.get(k) : null; },
        setItem: function (k, v) { datos.set(String(k), String(v)); },
        removeItem: function (k) { datos.delete(String(k)); },
        clear: function () { datos.clear(); },
        key: function (i) { const ks = Array.from(datos.keys()); return (i >= 0 && i < ks.length) ? ks[i] : null; },
        get length() { return datos.size; }
    };
}

function sesion(inicial) {
    const datos = Object.assign({}, inicial || {});
    return {
        _datos: datos,
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(datos, k) ? datos[k] : null; },
        setItem: function (k, v) { datos[k] = String(v); },
        removeItem: function (k) { delete datos[k]; }
    };
}

function crearDocumentoFalso() {
    const nodos = {};
    function nodo(id, tag) {
        const clases = new Set();
        const hijos = [];
        const atributos = {};
        const n = {
            id: id, tagName: tag || 'DIV', textContent: '', innerHTML: '',
            disabled: false, style: {}, dataset: {}, _clases: clases, _hijos: hijos,
            classList: {
                add: (c) => clases.add(c), remove: (c) => clases.delete(c),
                contains: (c) => clases.has(c),
                toggle: (c, f) => { if (f === undefined) { clases.has(c) ? clases.delete(c) : clases.add(c); } else if (f) clases.add(c); else clases.delete(c); }
            },
            // Atributos (el detalle plegable usa hidden/setAttribute/removeAttribute).
            setAttribute: (k, v) => { atributos[String(k)] = String(v === undefined ? '' : v); },
            getAttribute: (k) => (Object.prototype.hasOwnProperty.call(atributos, String(k)) ? atributos[String(k)] : null),
            removeAttribute: (k) => { delete atributos[String(k)]; },
            hasAttribute: (k) => Object.prototype.hasOwnProperty.call(atributos, String(k)),
            appendChild: (h) => { hijos.push(h); return h; },
            insertBefore: (h) => { hijos.unshift(h); return h; },
            get firstChild() { return hijos[0] || null; },
            focus: () => {}, remove: () => {}, reset: () => {}, closest: () => null,
            getContext: () => ({}), querySelector: () => null, querySelectorAll: () => []
        };
        // Como en el navegador: un input SIEMPRE guarda su valor como TEXTO.
        let valor = '';
        Object.defineProperty(n, 'value', {
            get: () => valor,
            set: (v) => { valor = String(v === null || v === undefined ? '' : v); },
            enumerable: true, configurable: true
        });
        return n;
    }
    const body = nodo('body', 'BODY');
    const principal = nodo('_main', 'DIV');
    principal.parentNode = body;
    nodos['_main'] = principal;
    return {
        _nodos: nodos, _body: body, _principal: principal,
        body: body,
        getElementById: (id) => (nodos[id] = nodos[id] || nodo(id)),
        querySelector: (sel) => (sel === '.main-content' ? principal : null),
        querySelectorAll: () => [],
        createElement: (tag) => nodo('_creado_' + tag, String(tag || 'div').toUpperCase()),
        addEventListener: () => {}
    };
}

const PERFILES = {
    admin: { currentUser: JSON.stringify({ username: 'jefa', role: 'Administrador', firstName: 'Jefa', lastName: 'Uno' }) },
    vendedor: { currentUser: JSON.stringify({ username: 'pedro', role: 'Vendedor' }) },
    propietario: { propietarioActual: 'negocio@cielo.com' },
    'solo-sesion': {}
};

function crearCuentas(op) {
    op = op || {};
    const alm = op.almacen || almacen();
    const ses = sesion(PERFILES[op.perfil || 'admin']);
    const doc = crearDocumentoFalso();
    const registro = { subidas: [], graficos: [], notificaciones: [], marcas: [], limpias: [], csv: [] };

    const ctx = {
        console: { log: () => {}, warn: () => {}, error: () => {} },
        JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Intl, RegExp, Error,
        isNaN, isFinite, parseInt, parseFloat, URLSearchParams,
        localStorage: alm,
        sessionStorage: ses,
        document: doc,
        // El enlace profundo se prueba cambiando `location.search`.
        location: { search: op.urlSearch || '' },
        navigator: { onLine: true },
        __subidas: registro.subidas,
        __graficos: registro.graficos,
        __notificaciones: registro.notificaciones,
        __marcas: registro.marcas,
        __limpias: registro.limpias,
        showNotification: (m, t) => registro.notificaciones.push({ mensaje: String(m), tipo: String(t || '') }),
        closeModal: () => {}, closePaymentModal: () => {}, closeDeleteModal: () => {},
        updateSortIndicators: () => {},
        // La descarga es del navegador: se sustituye por un registrador (el CSV que se
        // habría descargado se comprueba en la prueba).
        downloadCSV: (csv) => registro.csv.push(String(csv)),
        escapeHtml: (s) => String(s == null ? '' : s),
        marcarPendienteSync: (m) => registro.marcas.push(String(m)),
        limpiarPendienteSync: (m) => registro.limpias.push(String(m)),
        checkCloudAccess: () => Promise.resolve(false),
        initFirebase: () => Promise.resolve(null),
        loadFromFirebase: op.loadFromFirebase || (() => Promise.resolve(null)),
        syncToFirebase: (d) => { registro.subidas.push(JSON.parse(JSON.stringify(d))); return Promise.resolve(true); },
        Chart: function (lienzo, cfg) { registro.graficos.push(JSON.parse(JSON.stringify(cfg.data))); }
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    ctx.window.addEventListener = () => {};

    vm.createContext(ctx);
    vm.runInContext(op.fuente || FUENTE, ctx, { filename: path.basename(ARCHIVO) + ' (funciones reales)' });

    return {
        ctx, doc, almacen: alm, sesion: ses, registro,
        leer: (e) => vm.runInContext(e, ctx),
        correr: (c) => vm.runInContext(c, ctx),
        ultimaNotificacion: () => registro.notificaciones.length ? registro.notificaciones[registro.notificaciones.length - 1] : null
    };
}

function mutar(fuente, viejo, nuevo, etiqueta) {
    const veces = fuente.split(viejo).length - 1;
    if (veces !== 1) {
        console.log('      (la mutación «' + etiqueta + '» no es aplicable: ' + veces + ' coincidencias)');
        return null;
    }
    return fuente.replace(viejo, () => nuevo);
}

const HOY = new Date().toISOString().split('T')[0];
const AYER = new Date(Date.now() - 86400000).toISOString().split('T')[0];
const MANANA = new Date(Date.now() + 86400000).toISOString().split('T')[0];

function cuenta(extra) {
    return Object.assign({
        id: 1, type: 'cobrar', description: 'Deuda de prueba', contact: 'Ana',
        amount: 100, dueDate: MANANA, category: 'Ventas', payments: [], status: 'pending',
        createdAt: new Date().toISOString()
    }, extra || {});
}

function sembrarFormulario(c, datos) {
    const d = datos || {};
    c.doc.getElementById('accountType').value = d.type || 'cobrar';
    c.doc.getElementById('accountDescription').value = d.description || 'Deuda de prueba';
    c.doc.getElementById('accountContact').value = d.contact || 'Ana';
    c.doc.getElementById('accountAmount').value = String(d.amount === undefined ? 100 : d.amount);
    c.doc.getElementById('accountDueDate').value = d.dueDate || MANANA;
    c.doc.getElementById('accountCategory').value = d.category || 'Ventas';
    c.doc.getElementById('accountNotes').value = d.notes || '';
}

function idsEnAlmacen(alm) {
    try {
        const v = JSON.parse(alm.getItem('ciervo_accounts') || '[]');
        return (Array.isArray(v) ? v : Object.keys(v || {}).map(k => v[k])).map(x => x.id);
    } catch (e) { return []; }
}

/* =====================================================================
   LAS PRUEBAS
   ===================================================================== */

(async function principal() {

    /* ------------------------------------------------------------------ */
    titulo('1. (0.1) El estado es DERIVADO, no un dato que se queda viejo');
    {
        // El estado unitario, sin tocar nada más.
        const c = crearCuentas();
        check('1 · sin saldo → pagada',
            c.correr('estadoDeCuenta({ amount: 100, payments: [{ amount: 100 }], dueDate: "' + AYER + '" })') === 'paid');
        check('1 · con saldo y vencida → vencida',
            c.correr('estadoDeCuenta({ amount: 100, payments: [{ amount: 40 }], dueDate: "' + AYER + '" })') === 'overdue');
        check('1 · con saldo y sin vencer → pendiente',
            c.correr('estadoDeCuenta({ amount: 100, payments: [{ amount: 40 }], dueDate: "' + MANANA + '" })') === 'pending');
        check('1 · una cuenta de 0 no queda pendiente para siempre',
            c.correr('estadoDeCuenta({ amount: 0, payments: [] })') === 'paid');
        check('1 · el saldo no depende del estado guardado',
            c.correr('saldoPendiente({ amount: 100, status: "paid", payments: [{ amount: 40 }] })') === 60);

        // El caso exacto del fallo: cuenta PAGADA a la que le suben el importe.
        const c2 = crearCuentas();
        c2.correr('_accountsCache = [' + JSON.stringify(cuenta({
            amount: 100, status: 'paid', payments: [{ amount: 100, date: HOY }]
        })) + '];');
        sembrarFormulario(c2, { amount: 250 });
        c2.correr('editingAccountId = 1;');
        await c2.correr('saveAccount(null)');
        check('1 · el importe subió a 250', c2.leer('_accountsCache[0].amount') === 250);
        check('1 · BUG ARREGLADO: deja de estar «Pagado» y vuelve a pendiente/vencido',
            c2.leer('_accountsCache[0].status') !== 'paid', 'status=' + c2.leer('_accountsCache[0].status'));
        check('1 · el saldo pendiente es 150', c2.leer('saldoPendiente(_accountsCache[0])') === 150);
        c2.correr('updateDashboard()');
        check('1 · el tablero ya suma los 150 (antes mostraba $0.00)',
            c2.doc.getElementById('totalReceivable').textContent === '$150.00',
            c2.doc.getElementById('totalReceivable').textContent);

        // Y al revés: abonar hasta cubrir el total la deja pagada sin tocar el estado.
        const c3 = crearCuentas();
        c3.correr('_accountsCache = [' + JSON.stringify(cuenta({
            amount: 100, status: 'pending', payments: [{ amount: 60, date: HOY }]
        })) + '];');
        c3.correr('updateAccountStatuses()');
        check('1 · con 60 de 100 sigue pendiente', c3.leer('_accountsCache[0].status') === 'pending');
        c3.correr('_accountsCache[0].payments.push({ amount: 40, date: "' + HOY + '" }); updateAccountStatuses();');
        check('1 · al cubrir el total pasa a pagada (derivado, no copiado)',
            c3.leer('_accountsCache[0].status') === 'paid');
        c3.correr('updateDashboard()');
        check('1 · y desaparece del tablero', c3.doc.getElementById('totalReceivable').textContent === '$0.00');
    }

    /* ------------------------------------------------------------------ */
    titulo('2. (0.2) Un registro a medio formar no rompe la pantalla');
    {
        const c = crearCuentas();
        check('2 · una cuenta vacía se sanea entera',
            c.correr('JSON.stringify(normalizarCuenta({}))') ===
            JSON.stringify({ id: null, type: 'cobrar', description: '', contact: '', category: 'Otros', notes: '', amount: 0, dueDate: '', payments: [], status: 'pending' }));
        check('2 · los importes de texto se vuelven números',
            c.correr('normalizarCuenta({ amount: "40,5" }).amount') === 0 &&
            c.correr('normalizarCuenta({ amount: "40" }).amount') === 40);
        check('2 · los pagos se sanean (importe y fecha)',
            c.correr('JSON.stringify(normalizarCuenta({ payments: [{ amount: "30" }, {"date": "no-es-fecha"} ] }).payments)') ===
            JSON.stringify([{ amount: 30, date: '' }, { date: '', amount: 0 }]));
        check('2 · se CONSERVAN los campos extra del POS',
            c.correr('normalizarCuenta({ id: 3, saleId: "V-0007", totalBs: 400, exchangeRate: 40, ' +
                'origen: "pos", productos: [{ name: "Harina" }] }).saleId') === 'V-0007' &&
            c.correr('normalizarCuenta({ id: 3, totalBs: 400 }).totalBs') === 400);
        check('2 · un estado inventado cae a pendiente',
            c.correr('normalizarCuenta({ status: "lo-que-sea" }).status') === 'pending');

        // Las cuatro funciones que ANTES lanzaban con `payments` ausente.
        const c2 = crearCuentas();
        c2.correr('_accountsCache = normalizarCuentas([{ id: 1, type: "cobrar", description: "Vieja", ' +
            'contact: "X", amount: 10, dueDate: "2030-01-01" }]);');
        const lanzan = [];
        for (const [nombre, expr] of [
            ['updateDashboard', 'updateDashboard()'],
            ['sortCompare', 'sortCompare(_accountsCache[0], _accountsCache[0], "pendingAmount", "asc")'],
            ['exportAccounts', 'exportAccounts()'],
            ['renderCashFlowChart', 'renderCashFlowChart()'],
            ['createAccountRow', 'createAccountRow(_accountsCache[0])'],
            ['renderAccounts', 'renderAccounts()']
        ]) {
            try { c2.correr(expr); } catch (e) { lanzan.push(nombre + ': ' + e.message); }
        }
        check('2 · BUG ARREGLADO: ninguna función lanza con un registro sin `payments`',
            lanzan.length === 0, lanzan.join(' | '));
        check('2 · la fila se pinta igual con ese registro',
            /Vieja/.test(c2.leer('createAccountRow(_accountsCache[0])')));
        check('2 · el CSV de una cuenta rara sale con sus datos',
            c2.registro.csv.length === 1 && /Vieja/.test(c2.registro.csv[0]),
            String(c2.registro.csv[0]).slice(0, 90));

        // La nube en forma de OBJETO (arreglo disperso de RTDB) SÍ se aplica.
        const c3 = crearCuentas({
            loadFromFirebase: () => Promise.resolve({ '0': cuenta({ id: 4, description: 'de la nube' }), '2': cuenta({ id: 6, description: 'otra de la nube' }) })
        });
        c3.correr('_accountsCache = [' + JSON.stringify(cuenta({ id: 9, description: 'solo local' })) + '];');
        await c3.correr('loadAccountsAsync()');
        check('2 · BUG ARREGLADO: la nube con forma de objeto se aplica',
            c3.leer('_accountsCache.length') === 2 && c3.leer('_accountsCache[1].description') === 'otra de la nube',
            JSON.stringify(c3.leer('_accountsCache.map(a => a.description)')));

        const c4 = crearCuentas();
        c4.almacen.setItem('ciervo_accounts', '{esto no es json');
        let lanzo = '';
        try { c4.correr('loadAccounts()'); } catch (e) { lanzo = e.message; }
        check('2 · un almacén corrupto no lanza (se cae a lista vacía)', lanzo === '' && c4.leer('_accountsCache.length') === 0);

        // Lo que se CARGA queda saneado en memoria: eso es lo que se guarda y se sube.
        const c5 = crearCuentas();
        c5.almacen.setItem('ciervo_accounts', JSON.stringify([
            { id: 1, type: 'cobrar', description: 'Basura', contact: 'X', amount: '40',
              dueDate: 'no-es-fecha', status: 'lo-que-sea' }
        ]));
        c5.correr('loadAccounts()');
        check('2 · al cargar, los datos quedan saneados (número y arreglo, no basura)',
            c5.leer('typeof _accountsCache[0].amount') === 'number' &&
            c5.leer('Array.isArray(_accountsCache[0].payments)') &&
            c5.leer('_accountsCache[0].status') === 'pending' &&
            c5.leer('_accountsCache[0].dueDate') === '',
            'amount=' + c5.leer('typeof _accountsCache[0].amount') +
            ' payments=' + c5.leer('typeof _accountsCache[0].payments') +
            ' status=' + c5.leer('_accountsCache[0].status'));
    }

    /* ------------------------------------------------------------------ */
    titulo('3. (0.4) El flujo de caja cuenta TODOS los abonos, con el mes correcto');
    {
        const c = crearCuentas();
        c.correr('_accountsCache = ' + JSON.stringify([
            cuenta({ id: 1, amount: 100, status: 'pending', payments: [{ amount: 40, date: '2026-03-10' }] }),
            cuenta({ id: 2, type: 'pagar', amount: 50, status: 'pending', payments: [{ amount: 10, date: '2026-03-11' }] }),
            cuenta({ id: 3, amount: 60, status: 'paid', payments: [{ amount: 60, date: '2026-03-12' }] })
        ]) + ';');
        c.correr('renderCashFlowChart()');
        const datos = c.registro.graficos[0] || { datasets: [] };
        check('3 · BUG ARREGLADO: los abonos parciales entran en el gráfico (40 + 60 = 100)',
            datos.datasets && datos.datasets[0].data[0] === 100,
            JSON.stringify(datos.datasets && datos.datasets[0].data));
        check('3 · y los pagos parciales también (10)',
            datos.datasets && datos.datasets[1].data[0] === 10,
            JSON.stringify(datos.datasets && datos.datasets[1].data));

        // El mes, sin zona horaria: '2026-03-01' NO es febrero.
        const c2 = crearCuentas();
        check('3 · el mes sale del texto de la fecha',
            c2.correr('mesDePago({ date: "2026-03-01" })') === '2026-03' &&
            c2.correr('mesDePago({ date: "2026-03-31T23:00:00.000Z" })') === '2026-03');
        c2.correr('_accountsCache = ' + JSON.stringify([
            cuenta({ id: 1, amount: 100, payments: [{ amount: 40, date: '2026-03-01' }] })
        ]) + ';');
        c2.correr('renderCashFlowChart()');
        const d2 = c2.registro.graficos[0] || {};
        check('3 · BUG ARREGLADO: el abono del día 1 cae en marzo (antes podía caer en febrero)',
            (d2.labels || []).length === 1 && /mar/i.test(d2.labels[0]), JSON.stringify(d2.labels));

        // Un abono sin fecha válida no inventa un mes.
        const c3 = crearCuentas();
        c3.correr('_accountsCache = ' + JSON.stringify([
            cuenta({ id: 1, amount: 100, payments: [{ amount: 40, date: 'no-es-fecha' }] })
        ]) + ';');
        c3.correr('renderCashFlowChart()');
        check('3 · un abono sin fecha no inventa un mes',
            ((c3.registro.graficos[0] || {}).labels || []).length === 0);
        check('3 · mesDePago de basura es cadena vacía',
            c3.correr('mesDePago({ date: "" })') === '' && c3.correr('mesDePago(null)') === '');

        // Al abonar con la sección abierta, el gráfico se repinta.
        const c4 = crearCuentas();
        c4.correr('_accountsCache = [' + JSON.stringify(cuenta({ amount: 100 })) + '];');
        c4.correr('payingAccountId = 1;');
        c4.doc.getElementById('paymentAmount').value = '10';
        c4.doc.getElementById('reportsSection').style.display = 'block';
        c4.registro.graficos.length = 0;
        await c4.correr('confirmPayment()');
        check('3 · al registrar un abono se repinta el flujo de caja si está a la vista',
            c4.registro.graficos.length === 1, 'graficos=' + c4.registro.graficos.length);
    }

    /* ------------------------------------------------------------------ */
    titulo('4. (0.5) Ids monótonos: un id borrado no se vuelve a usar');
    {
        const alm = almacen();
        alm.setItem('ciervo_accounts', JSON.stringify([cuenta({ id: 1 }), cuenta({ id: 2 })]));
        const c = crearCuentas({ almacen: alm });
        c.correr('loadAccounts()');
        check('4 · con ids 1 y 2 el siguiente es 3', c.leer('nextAccountId') === 3);

        c.correr('deletingAccountId = 2;');
        await c.correr('confirmDelete()');
        check('4 · la cuenta 2 se borró', idsEnAlmacen(alm).indexOf(2) === -1);
        c.correr('loadAccounts()');
        check('4 · BUG ARREGLADO: tras borrar la última y recargar, el id NO se reutiliza',
            c.leer('nextAccountId') === 3, 'nextAccountId=' + c.leer('nextAccountId'));

        // Y queda persistido en el almacén (sobrevive a la recarga).
        const c2 = crearCuentas({ almacen: alm });
        c2.correr('loadAccounts()');
        check('4 · el contador está persistido (sobrevive a recargar)',
            Number(alm.getItem('cuentas_ultimo_id')) >= 2 && c2.leer('nextAccountId') === 3,
            'contador=' + alm.getItem('cuentas_ultimo_id') + ' siguiente=' + c2.leer('nextAccountId'));

        // Crear una cuenta de verdad usa un id nuevo.
        sembrarFormulario(c2, { amount: 55, description: 'Nueva' });
        await c2.correr('saveAccount(null)');
        const nueva = c2.leer('_accountsCache[_accountsCache.length - 1]');
        check('4 · la cuenta nueva toma el id 3 (no el 2)', nueva.id === 3, 'id=' + nueva.id);
        check('4 · el contador queda en el id entregado (3) y el siguiente es 4',
            alm.getItem('cuentas_ultimo_id') === '3' && c2.leer('nextAccountId') === 4,
            'contador=' + alm.getItem('cuentas_ultimo_id') + ' siguiente=' + c2.leer('nextAccountId'));
    }

    /* ------------------------------------------------------------------ */
    titulo('5. (0.5) Lápidas: lo borrado no resucita (ni con otra pestaña ni la nube)');
    {
        const alm = almacen();
        const base = [cuenta({ id: 1 }), cuenta({ id: 5, description: 'la que se borra' })];
        alm.setItem('ciervo_accounts', JSON.stringify(base));
        const A = crearCuentas({ almacen: alm });
        const B = crearCuentas({ almacen: alm });
        A.correr('_accountsCache = ' + JSON.stringify(base) + '; loadAccounts();');
        B.correr('_accountsCache = ' + JSON.stringify(base) + ';');

        A.correr('deletingAccountId = 5;');
        await A.correr('confirmDelete()');
        check('5 · la lápida está PERSISTIDA en el almacén',
            JSON.parse(alm.getItem('cuentas_borradas') || '{}')['5'] !== undefined,
            String(alm.getItem('cuentas_borradas')));

        // B guarda con su copia vieja en memoria (el caso que resucitaba la cuenta).
        B.correr('_accountsCache[0].payments.push({ amount: 1, date: "' + HOY + '" });');
        await B.correr('persistAccounts()');
        check('5 · BUG ARREGLADO: al guardar en la otra pestaña NO reaparece la cuenta 5',
            idsEnAlmacen(alm).indexOf(5) === -1, JSON.stringify(idsEnAlmacen(alm)));

        // La nube todavía la trae: al descargar, tampoco vuelve.
        const c = crearCuentas({
            almacen: alm,
            loadFromFirebase: () => Promise.resolve([cuenta({ id: 1 }), cuenta({ id: 5, description: 'resucitada' })])
        });
        await c.correr('loadAccountsAsync()');
        check('5 · BUG ARREGLADO: la nube no devuelve a la vida lo borrado',
            c.leer('_accountsCache.map(a => a.id).indexOf(5)') === -1,
            JSON.stringify(c.leer('_accountsCache.map(a => a.id)')));

        // Pero un id nuevo (no lapidado) sí entra, y una creación con ese id limpia la lápida.
        const c2 = crearCuentas({ almacen: almacen() });
        c2.correr('reservarIdCuenta([])');
        check('5 · las lápidas no bloquean ids que nunca se usaron',
            c2.leer('idEstaLapidado(99, leerCuentasBorradas())') === false);
        c2.correr('marcarCuentaBorrada(7);');
        check('5 · se puede olvidar una lápida a propósito',
            c2.leer('idEstaLapidado(7, leerCuentasBorradas())') === true &&
            (c2.correr('olvidarCuentaBorrada(7); idEstaLapidado(7, leerCuentasBorradas())') === false));
    }

    /* ------------------------------------------------------------------ */
    titulo('6. (0.3) Puerta de rol: capa 1 (ver) y capa 2 (escribir)');
    {
        // Capa 1
        const casos = [
            ['Administrador', 'admin', true, true],
            ['propietario sin operador', 'propietario', true, true],
            ['Vendedor', 'vendedor', false, false],
            ['solo marca de sesión compartida', 'solo-sesion', false, false]
        ];
        for (const [etiqueta, perfil, puedeVer, puedeEditar] of casos) {
            const c = crearCuentas({ perfil: perfil });
            const ver = c.correr('aplicarPuertaDeRol()');
            check('6 · ' + etiqueta + (puedeVer ? ' SÍ ve' : ' NO ve') + ' el módulo',
                ver === puedeVer, 'ver=' + ver);
            check('6 · ' + etiqueta + ': permitir editar = ' + puedeEditar,
                c.leer('permiteEditarCuentas()') === puedeEditar);
            if (!puedeVer) {
                check('6 · ' + etiqueta + ': se pinta el aviso y se oculta la pantalla',
                    c.doc._principal.style.display === 'none' &&
                    c.doc._principal.parentNode._hijos.some(h => h.id === 'accesoDenegadoCuentas'),
                    'hijos=' + JSON.stringify(c.doc._principal.parentNode._hijos.map(h => h.id)));
            }
        }

        // Capa 2: un Vendedor no escribe NADA, aunque llame a las funciones a mano.
        const v = crearCuentas({ perfil: 'vendedor' });
        v.correr('_accountsCache = [' + JSON.stringify(cuenta({ id: 1, amount: 100 })) + '];');
        v.almacen.setItem('ciervo_accounts', JSON.stringify(v.leer('_accountsCache')));

        sembrarFormulario(v, { amount: 999, description: 'cuela' });
        await v.correr('saveAccount(null)');
        check('6 · Vendedor: NO se crea ninguna cuenta',
            v.leer('_accountsCache.length') === 1 &&
            !/cuela/.test(JSON.stringify(v.leer('_accountsCache.map(a => a.description)'))));

        v.correr('payingAccountId = 1;');
        v.doc.getElementById('paymentAmount').value = '50';
        await v.correr('confirmPayment()');
        check('6 · Vendedor: NO se registra ningún abono',
            v.leer('_accountsCache[0].payments.length') === 0,
            JSON.stringify(v.leer('_accountsCache[0].payments')));

        v.correr('deletingAccountId = 1;');
        await v.correr('confirmDelete()');
        check('6 · Vendedor: NO se borra ninguna cuenta', v.leer('_accountsCache.length') === 1);

        const persistio = await v.correr('persistAccounts()');
        check('6 · Vendedor: persistAccounts se niega y no sube nada',
            persistio === false && v.registro.subidas.length === 0);
        check('6 · Vendedor: el almacén no se ha tocado',
            JSON.parse(v.almacen.getItem('ciervo_accounts')).length === 1 &&
            JSON.parse(v.almacen.getItem('ciervo_accounts'))[0].amount === 100);
        v.correr('_accountsCache[0].status = "paid"; updateAccountStatuses()');
        check('6 · Vendedor: ni siquiera se marca el módulo como pendiente',
            v.registro.marcas.length === 0, JSON.stringify(v.registro.marcas));
        check('6 · Vendedor: se avisa del motivo',
            /administrador/i.test((v.ultimaNotificacion() || {}).mensaje || ''),
            JSON.stringify(v.ultimaNotificacion()));

        // Control: con Administrador las tres acciones sí funcionan.
        const a = crearCuentas({ perfil: 'admin' });
        a.correr('_accountsCache = [' + JSON.stringify(cuenta({ id: 1, amount: 100 })) + '];');
        a.almacen.setItem('ciervo_accounts', JSON.stringify(a.leer('_accountsCache')));
        sembrarFormulario(a, { amount: 77, description: 'Nueva del jefe' });
        await a.correr('saveAccount(null)');
        check('6 · Administrador: SÍ crea cuentas', a.leer('_accountsCache.length') === 2);
        a.correr('payingAccountId = ' + a.leer('_accountsCache[0].id') + ';');
        a.doc.getElementById('paymentAmount').value = '25';
        await a.correr('confirmPayment()');
        check('6 · Administrador: SÍ registra abonos',
            a.leer('_accountsCache[0].payments.length') === 1 &&
            a.leer('_accountsCache[0].payments[0].amount') === 25);
        const okPersist = await a.correr('persistAccounts()');
        check('6 · Administrador: persistAccounts guarda y sube',
            okPersist === true && a.registro.subidas.length >= 1 &&
            idsEnAlmacen(a.almacen).length === 2,
            'persistio=' + okPersist + ' subidas=' + a.registro.subidas.length + ' ids=' + JSON.stringify(idsEnAlmacen(a.almacen)));

        // Modo 'solo-consulta': ve, pero no toca (una línea del código).
        const soloLectura = mutar(FUENTE, "const CTA_MODO_VENDEDOR = 'sin-acceso';",
            "const CTA_MODO_VENDEDOR = 'solo-consulta';", 'modo solo-consulta');
        check('6 · el modo del vendedor es una sola línea', soloLectura !== null);
        if (soloLectura) {
            const sl = crearCuentas({ perfil: 'vendedor', fuente: soloLectura });
            const ver = sl.correr('aplicarPuertaDeRol()');
            check('6 · solo-consulta: el Vendedor SÍ ve el módulo', ver === true);
            check('6 · solo-consulta: pero NO puede escribir', sl.leer('permiteEditarCuentas()') === false);
            check('6 · solo-consulta: se avisa en pantalla y se ocultan las acciones',
                sl.doc.body.classList.contains('cuentas-solo-lectura') &&
                sl.doc._principal._hijos.some(h => h.id === 'bannerSoloLecturaCuentas'));
        }
    }

    /* ------------------------------------------------------------------ */
    titulo('7. La marca de «pendiente de subir» solo se pone cuando hay algo que subir');
    {
        const c = crearCuentas();
        c.correr('_accountsCache = [' + JSON.stringify(cuenta({ id: 1 })) + '];');
        c.correr('saveAccountsCache()');
        check('7 · guardar un cambio real SÍ marca el módulo',
            c.registro.marcas.indexOf('cuentas') !== -1, JSON.stringify(c.registro.marcas));

        c.registro.marcas.length = 0;
        c.correr('saveAccountsCache({ sinMarca: true })');
        check('7 · guardar algo derivado/descargado NO marca nada',
            c.registro.marcas.length === 0, JSON.stringify(c.registro.marcas));

        c.registro.marcas.length = 0;
        c.correr('_accountsCache[0].amount = 250; updateAccountStatuses()');
        check('7 · recalcular estados (cambio derivado) tampoco marca',
            c.registro.marcas.length === 0, JSON.stringify(c.registro.marcas));

        const c2 = crearCuentas({
            loadFromFirebase: () => Promise.resolve([cuenta({ id: 2, description: 'de la nube' })])
        });
        await c2.correr('loadAccountsAsync()');
        check('7 · DESCARGAR de la nube no deja el equipo «con cambios sin subir»',
            c2.registro.marcas.length === 0, JSON.stringify(c2.registro.marcas));
        check('7 · y lo descargado queda en la caché local',
            c2.leer('_accountsCache.length') === 1 && c2.leer('_accountsCache[0].description') === 'de la nube');
    }

    /* ------------------------------------------------------------------ */
    titulo('8. Invariantes del código (que nadie deshaga esto sin darse cuenta)');
    {
        const src = BLOQUE;
        check('8 · el estado se recalcula SIEMPRE (no queda el «si ya estaba pagada, no lo toco»)',
            src.indexOf("if (oldStatus !== 'paid')") === -1);
        check('8 · el saldo es la única fuente (el estado no decide el importe)',
            /function saldoPendiente[\s\S]{0,220}?abonadoDe\(cuenta\)/.test(src) &&
            !/saldoPendiente[\s\S]{0,120}?status/.test(src));
        check('8 · el tablero usa el saldo, no el estado',
            /saldoPendiente\(a\)/.test(src) && !/(^|[^a-zA-Z])a\.status !== 'paid'/.test(src));
        check('8 · el flujo de caja usa TODOS los abonos',
            /abonosDe\(account\)\.forEach/.test(src) &&
            !/if \(account\.status === 'paid'\) \{/.test(src));
        check('8 · el borrado deja lápida persistida',
            /function confirmDelete[\s\S]{0,800}?marcarCuentaBorrada\(deletingAccountId\)/.test(src));
        check('8 · la unión salta lo lapidado',
            /idEstaLapidado\(clave, lapidas\)/.test(src));
        check('8 · el id se reserva con contador persistido (y se fija al cargar)',
            /localStorage\.setItem\(CUENTAS_ULTIMO_ID_CLAVE/.test(src) &&
            /sincronizarContadorId\(_accountsCache\)/.test(src) &&
            !/nextAccountId = _accountsCache\.length > 0 \? Math\.max/.test(src));
        check('8 · la nube ya no se descarta por su forma',
            !/Array\.isArray\(fbData\)/.test(src));
        check('8 · se sanea al cargar (local y nube)',
            /lista\.map\(normalizarCuenta\)/.test(src));
        check('8 · la puerta está en las 5 escrituras y en el modo solo-consulta',
            (src.match(/if \(!permiteEditarCuentas\(\)\)/g) || []).length === 6,
            'veces=' + (src.match(/if \(!permiteEditarCuentas\(\)\)/g) || []).length);
        check('8 · el arranque pasa por la puerta antes de cargar',
            /if \(!aplicarPuertaDeRol\(\)\) return;/.test(src));
        check('8 · el modo del vendedor es una constante de una línea',
            /const CTA_MODO_VENDEDOR = '(sin-acceso|solo-consulta)';/.test(src));
        check('8 · el rol sale de sessionStorage (por pestaña), no de userSettings',
            /sessionStorage\.getItem\('currentUser'\)/.test(src) &&
            !/getData\('userSettings'\)/.test(src) &&
            src.indexOf('ciervo_user_settings') === -1);
    }

    /* ------------------------------------------------------------------ */
    titulo('8b. Rediseño de la pantalla: tarjetas, filtros, pestañas y enlace profundo');
    {
        // Tres cuentas para que los filtros tengan algo que separar.
        const SEMILLA = [
            cuenta({ id: 1, description: 'Fiado del POS', contact: 'Ana', amount: 100, dueDate: AYER,
                status: 'overdue', origen: 'pos', saleId: 'V-0001', vendedor: 'Jefa',
                totalBs: 4000, exchangeRate: 40, category: 'Ventas',
                payments: [{ amount: 40, date: HOY }],
                productos: [{ name: 'Harina', quantity: 2, unit: 'unidades', subtotal: 20 }] }),
            cuenta({ id: 2, description: 'Cuenta a mano', contact: 'Luis', amount: 50, dueDate: MANANA,
                status: 'pending', category: 'Otros' }),
            cuenta({ id: 3, type: 'pagar', description: 'Proveedor', contact: 'Distribuidora', amount: 80,
                dueDate: AYER, status: 'overdue', category: 'Operaciones' })
        ];
        function pintar(opciones) {
            const c = crearCuentas(opciones || {});
            c.correr('_accountsCache = ' + JSON.stringify(SEMILLA) + ';');
            c.correr('updateAccountStatuses(); renderAccounts();');
            return c;
        }

        // Tarjeta: la información queda agrupada y el detalle está plegado.
        const c = pintar();
        const htmlCobrar = c.doc.getElementById('receivableTableBody').innerHTML;
        const htmlPagar = c.doc.getElementById('payableTableBody').innerHTML;
        check('8b · se pintan tarjetas (no filas de tabla) para cada cuenta',
            (htmlCobrar.match(/class="fila-cuenta/g) || []).length === 2 &&
            (htmlPagar.match(/class="fila-cuenta/g) || []).length === 1,
            'cobrar=' + (htmlCobrar.match(/class="fila-cuenta/g) || []).length +
            ' pagar=' + (htmlPagar.match(/class="fila-cuenta/g) || []).length);
        check('8b · cada tarjeta trae identidad, dinero, estado y acciones',
            /fila-identidad/.test(htmlCobrar) && /fila-dinero/.test(htmlCobrar) &&
            /fila-estado/.test(htmlCobrar) && /fila-acciones/.test(htmlCobrar));
        check('8b · la tarjeta enseña el saldo (no solo el total)', /dato-saldo/.test(htmlCobrar) &&
            /\$60\.00/.test(htmlCobrar), 'saldo esperado 60.00 (100 − 40)');
        check('8b · el monto en Bs y la tasa salen solo cuando la cuenta los trae',
            /Bs\. \(tasa 40\.00\)/.test(htmlCobrar) && /4000\.00/.test(htmlCobrar) &&
            (htmlPagar.match(/dato-bs/g) || []).length === 0);
        check('8b · el detalle va PLEGADO (hidden) con productos, abonos y datos',
            /fila-detalle" id="detalle-cuenta-1" hidden/.test(htmlCobrar) &&
            /Productos:/.test(htmlCobrar) && /Abonos \(1\):/.test(htmlCobrar) &&
            /Datos de la cuenta/.test(htmlCobrar));
        check('8b · los chips resumen el origen, el ticket y los abonos',
            /chip-pos/.test(htmlCobrar) && /Ticket V-0001/.test(htmlCobrar) && /1 abono/.test(htmlCobrar));
        check('8b · la barra de progreso refleja lo abonado (40%)',
            /title="40% abonado"/.test(htmlCobrar));
        check('8b · la tarjeta de pagar no enseña acciones de cobro (mismas acciones, otro tipo)',
            /openPaymentModal/.test(htmlPagar));

        // Pestañas: una lista a la vista y la otra oculta, con contadores.
        check('8b · los contadores de las pestañas cuadran (2 cobrar · 1 pagar)',
            c.doc.getElementById('contadorCobrar').textContent === '2' &&
            c.doc.getElementById('contadorPagar').textContent === '1',
            JSON.stringify({ cobrar: c.doc.getElementById('contadorCobrar').textContent,
                pagar: c.doc.getElementById('contadorPagar').textContent }));
        check('8b · la pestaña activa es «por cobrar» y la otra lista está oculta',
            c.doc.getElementById('receivableTableBody').hidden === false &&
            c.doc.getElementById('payableTableBody').hidden === true);
        check('8b · el resumen de la lista dice cuántas son y su saldo',
            c.doc.getElementById('resumenListaTexto').textContent === '2 cuentas' &&
            c.doc.getElementById('resumenListaSaldo').textContent === 'Saldo de lo mostrado: $110.00',
            c.doc.getElementById('resumenListaSaldo').textContent);
        c.correr("cambiarVistaCuentas('pagar')");
        check('8b · al cambiar de pestaña se intercambian las listas',
            c.doc.getElementById('receivableTableBody').hidden === true &&
            c.doc.getElementById('payableTableBody').hidden === false &&
            c.doc.getElementById('tabPagar').classList.contains('activo'));
        check('8b · el resumen de la lista se recalcula con la pestaña',
            c.doc.getElementById('resumenListaSaldo').textContent === 'Saldo de lo mostrado: $80.00',
            c.doc.getElementById('resumenListaSaldo').textContent);

        // Filtros.
        const c2 = pintar();
        c2.doc.getElementById('estadoFilter').value = 'overdue';
        c2.correr('renderAccounts()');
        check('8b · filtrar por estado deja solo las vencidas',
            (c2.doc.getElementById('receivableTableBody').innerHTML.match(/class="fila-cuenta/g) || []).length === 1,
            'vencidas=' + (c2.doc.getElementById('receivableTableBody').innerHTML.match(/class="fila-cuenta/g) || []).length);
        c2.doc.getElementById('estadoFilter').value = '';
        c2.doc.getElementById('origenFilter').value = 'pos';
        c2.correr('renderAccounts()');
        check('8b · filtrar por origen deja solo las del POS',
            (c2.doc.getElementById('receivableTableBody').innerHTML.match(/class="fila-cuenta/g) || []).length === 1 &&
            /Fiado del POS/.test(c2.doc.getElementById('receivableTableBody').innerHTML));
        c2.doc.getElementById('origenFilter').value = '';
        c2.doc.getElementById('searchInput').value = 'V-0001';
        c2.correr('renderAccounts()');
        check('8b · el buscador encuentra por TICKET (conexión con la venta)',
            (c2.doc.getElementById('receivableTableBody').innerHTML.match(/class="fila-cuenta/g) || []).length === 1);
        c2.doc.getElementById('searchInput').value = 'Luis';
        c2.correr('renderAccounts()');
        check('8b · el buscador encuentra por contacto',
            /Cuenta a mano/.test(c2.doc.getElementById('receivableTableBody').innerHTML));
        c2.doc.getElementById('searchInput').value = '';
        c2.correr("alternarChipCuentas('con-abonos')");
        check('8b · el chip «con abonos» deja solo las que tienen abonos',
            (c2.doc.getElementById('receivableTableBody').innerHTML.match(/class="fila-cuenta/g) || []).length === 1 &&
            /Fiado del POS/.test(c2.doc.getElementById('receivableTableBody').innerHTML));
        check('8b · con filtros activos se avisa en el resumen',
            /con filtros/.test(c2.doc.getElementById('resumenListaTexto').textContent),
            c2.doc.getElementById('resumenListaTexto').textContent);
        c2.correr('limpiarFiltrosCuentas()');
        check('8b · «limpiar filtros» deja otra vez todo a la vista',
            (c2.doc.getElementById('receivableTableBody').innerHTML.match(/class="fila-cuenta/g) || []).length === 2 &&
            c2.doc.getElementById('searchInput').value === '' &&
            Object.keys(c2.leer('chipsCuentas')).length === 0);
        check('8b · el vacío explica que el problema son los filtros',
            /Ninguna cuenta coincide/.test(c2.correr(
                "document.getElementById('estadoFilter').value = 'paid'; renderAccounts(); " +
                "document.getElementById('tituloVacio').textContent")),
            'título del vacío');

        // Orden.
        const c3 = pintar();
        c3.correr("aplicarOrdenCuentas('saldo')");
        const primera = (c3.doc.getElementById('receivableTableBody').innerHTML.match(/data-account-id="(\d+)"/) || [])[1];
        check('8b · ordenar por saldo pone primero la de mayor saldo (100 − 40 = 60)',
            primera === '1', 'primera=' + primera);
        c3.correr("aplicarOrdenCuentas('contacto')");
        const porContacto = (c3.doc.getElementById('receivableTableBody').innerHTML.match(/data-account-id="(\d+)"/) || [])[1];
        check('8b · ordenar por contacto pone primero a Ana', porContacto === '1', 'primera=' + porContacto);

        // Detalle plegable. El doble de DOM no interpreta innerHTML, así que el nodo del
        // detalle se crea con el atributo que el HTML ya trae (`hidden`) y se comprueba
        // que la función real lo quita y lo vuelve a poner.
        const c4 = pintar();
        check('8b · el detalle sale PLEGADO en el HTML',
            /fila-detalle" id="detalle-cuenta-1" hidden/.test(
                c4.doc.getElementById('receivableTableBody').innerHTML));
        c4.doc.getElementById('detalle-cuenta-1').setAttribute('hidden', '');
        c4.doc.getElementById('btn-detalle-1').textContent = 'Ver detalle ▾';
        check('8b · el detalle empieza cerrado',
            c4.doc.getElementById('detalle-cuenta-1').hasAttribute('hidden') === true);
        c4.correr("toggleDetalleCuenta('1')");
        check('8b · el botón abre el detalle y cambia su texto',
            c4.doc.getElementById('detalle-cuenta-1').hasAttribute('hidden') === false &&
            /Ocultar/.test(c4.doc.getElementById('btn-detalle-1').textContent),
            c4.doc.getElementById('btn-detalle-1').textContent);
        c4.correr("toggleDetalleCuenta('1')");
        check('8b · y lo vuelve a cerrar',
            c4.doc.getElementById('detalle-cuenta-1').hasAttribute('hidden') === true &&
            /Ver detalle/.test(c4.doc.getElementById('btn-detalle-1').textContent));

        // Enlace profundo.
        const c5 = pintar({ urlSearch: '?estado=overdue&tipo=pagar' });
        c5.correr('aplicarParametrosCuentas(); renderAccounts();');
        check('8b · el enlace profundo aplica estado y pestaña',
            c5.doc.getElementById('estadoFilter').value === 'overdue' &&
            c5.leer('vistaCuentas') === 'pagar' &&
            c5.doc.getElementById('payableTableBody').hidden === false,
            JSON.stringify({ estado: c5.doc.getElementById('estadoFilter').value, vista: c5.leer('vistaCuentas') }));
        const c6 = pintar({ urlSearch: '?q=V-0001' });
        c6.correr('aplicarParametrosCuentas(); renderAccounts();');
        check('8b · el enlace profundo busca por ticket',
            c6.doc.getElementById('searchInput').value === 'V-0001' &&
            (c6.doc.getElementById('receivableTableBody').innerHTML.match(/class="fila-cuenta/g) || []).length === 1);
        const c7 = pintar({ urlSearch: '?id=1' });
        c7.correr('aplicarParametrosCuentas(); renderAccounts();');
        check('8b · el enlace profundo destaca la cuenta y abre su detalle (arregla el enlace del menú)',
            /fila-destacada/.test(c7.doc.getElementById('receivableTableBody').innerHTML) &&
            c7.doc.getElementById('detalle-cuenta-1').hasAttribute('hidden') === false);

        // KPIs reales.
        const c8 = pintar();
        c8.leer('_accountsCache[0].payments = [{ amount: 25, date: "' + HOY + '" }]');
        c8.correr('updateAccountStatuses(); updateDashboard();');
        check('8b · el KPI «por vencer» usa cta_reminder_days y solo los cobros',
            c8.doc.getElementById('porVencerCuentas').textContent === '1' &&
            /en 7 días/.test(c8.doc.getElementById('porVencerMonto').textContent),
            JSON.stringify({ cuentas: c8.doc.getElementById('porVencerCuentas').textContent,
                monto: c8.doc.getElementById('porVencerMonto').textContent }));
        check('8b · el KPI «cobrado este mes» suma los abonos del mes en curso',
            c8.doc.getElementById('cobradoMesCuentas').textContent === '$25.00' &&
            /1 abono este mes/.test(c8.doc.getElementById('cobradoMesDetalle').textContent),
            c8.doc.getElementById('cobradoMesCuentas').textContent);
        check('8b · los KPIs de vencidas traen número y monto',
            c8.doc.getElementById('overdueReceivable').textContent === '1' &&
            /\$75\.00 pendientes/.test(c8.doc.getElementById('overdueReceivableMonto').textContent),
            c8.doc.getElementById('overdueReceivable').textContent + ' · ' +
            c8.doc.getElementById('overdueReceivableMonto').textContent);
        check('8b · se quitaron los porcentajes inventados de las tarjetas',
            !/stat-change/.test(HTML) && !/\+5%/.test(HTML));
        check('8b · la pantalla ya no usa la tabla de 9 columnas',
            HTML.indexOf('id="receivableTable"') === -1 &&
            HTML.indexOf('class="lista-cuentas" id="receivableTableBody"') !== -1 &&
            HTML.indexOf('data-sort-key') === -1 &&
            HTML.indexOf('<thead>') === -1);
        check('8b · el modo solo-consulta sigue ocultando las acciones por CSS',
            /body\.cuentas-solo-lectura .action-buttons-cell/.test(HTML));
    }

    /* ------------------------------------------------------------------ */
    titulo('8c. Los botones de la tarjeta (los ids llegan como TEXTO)');
    {
        // Los botones de la tarjeta escriben el id dentro de un atributo `onclick`, así
        // que llega como CADENA. Estas comprobaciones existen porque los tres botones
        // (abonar, editar y borrar) no hacían NADA: comparaban con `===` contra el id
        // numérico. Ninguna prueba de `vm` lo vio porque llamaban con el id numérico.
        const c = crearCuentas();
        c.correr('_accountsCache = ' + JSON.stringify([
            cuenta({ id: 1, description: 'De la tarjeta', contact: 'Ana', amount: 100,
                payments: [{ amount: 40, date: HOY }], dueDate: MANANA })
        ]) + ';');

        // Abonar: el modal se abre y el importe sugerido es el saldo.
        c.correr("openPaymentModal('1')");
        check('8c · abonar con el id en TEXTO: el modal se abre y sugiere el saldo',
            c.doc.getElementById('paymentModal').classList.contains('show') &&
            c.doc.getElementById('paymentAmount').value === '60.00',
            JSON.stringify({ modal: c.doc.getElementById('paymentModal').classList.contains('show'),
                importe: c.doc.getElementById('paymentAmount').value,
                admin: c.leer('permiteEditarCuentas()'),
                cuentas: c.leer('_accountsCache.length'),
                mismo: c.correr('typeof mismaCuenta'),
                avisos: c.registro.notificaciones }));
        c.correr("payingAccountId = '1'; document.getElementById('paymentAmount').value = '15'");
        await c.correr('confirmPayment()');
        check('8c · confirmar el abono con el id en TEXTO lo registra',
            c.leer('_accountsCache[0].payments.length') === 2 &&
            c.leer('saldoPendiente(_accountsCache[0])') === 45,
            'pagos=' + c.leer('_accountsCache[0].payments.length') +
            ' saldo=' + c.leer('saldoPendiente(_accountsCache[0])'));

        // Editar: el modal se abre RELLENO con esa cuenta.
        c.correr("openModal('edit', null, '1')");
        check('8c · editar con el id en TEXTO: el modal se abre relleno',
            c.doc.getElementById('accountModal').classList.contains('show') &&
            c.doc.getElementById('accountDescription').value === 'De la tarjeta' &&
            c.doc.getElementById('accountAmount').value === '100',
            JSON.stringify({ modal: c.doc.getElementById('accountModal').classList.contains('show'),
                desc: c.doc.getElementById('accountDescription').value }));
        check('8c · y guardar la edición encuentra la cuenta',
            c.correr("editingAccountId = '1'; _accountsCache.findIndex(a => mismaCuenta(a, editingAccountId))") === 0);

        // Borrar: el modal se abre y confirmar borra ESA cuenta.
        c.correr("deleteAccount('1')");
        check('8c · borrar con el id en TEXTO: se abre la confirmación',
            c.doc.getElementById('deleteModal').classList.contains('show'));
        await c.correr('confirmDelete()');
        check('8c · confirmar borra la cuenta (antes no borraba nada)',
            c.leer('_accountsCache.length') === 0 &&
            !/De la tarjeta/.test(JSON.stringify(idsEnAlmacen(c.almacen) && c.leer('_accountsCache.map(a => a.description)'))));

        // Y las dos causas de que los botones "no hicieran nada", como invariantes.
        check('8c · el botón «Guardar Cuenta» está asociado a su formulario (si no, no envía)',
            /<button type="submit" form="accountForm"/.test(HTML),
            'el submit está en el footer, fuera del <form>: sin `form=` no envía nada');
        check('8c · el detalle plegado vuelve a ocultarse (display gana a hidden)',
            /\.fila-detalle\[hidden\] \{ display: none !important; \}/.test(HTML));
        check('8c · la identidad de cuenta se compara en un solo sitio (mismaCuenta)',
            (BLOQUE.match(/mismaCuenta\(/g) || []).length >= 5 &&
            !/a\.id === (accountId|editingAccountId|payingAccountId|deletingAccountId)/.test(BLOQUE),
            'usos=' + (BLOQUE.match(/mismaCuenta\(/g) || []).length);
    }

    /* ------------------------------------------------------------------ */
    titulo('9. MUTACIONES: cada fallo original se restaura y la suite lo nota');
    {
        // M1 · El estado deja de ser derivado (el fallo original, literal).
        const m1 = mutar(FUENTE,
            '                const nuevo = estadoDeCuenta(a, hoy);\n' +
            '                if (a.status !== nuevo) { a.status = nuevo; cambio = true; }',
            '                const nuevo = (a.status === "paid") ? "paid" : estadoDeCuenta(a, hoy);\n' +
            '                if (a.status !== nuevo) { a.status = nuevo; cambio = true; }',
            'estado no derivado');
        check('9 · la mutación «estado no derivado» se pudo aplicar', m1 !== null);
        if (m1) {
            const c = crearCuentas({ fuente: m1 });
            c.correr('_accountsCache = [' + JSON.stringify(cuenta({ amount: 100, status: 'paid', payments: [{ amount: 100, date: HOY }] })) + '];');
            sembrarFormulario(c, { amount: 250 });
            c.correr('editingAccountId = 1;');
            await c.correr('saveAccount(null)');
            c.correr('updateDashboard()');
            check('9 · MUTACIÓN DETECTADA: con el estado viejo, la cuenta sigue «Pagado» y la fila lo dice',
                c.leer('_accountsCache[0].status') === 'paid' &&
                /Pagado/.test(c.leer('createAccountRow(_accountsCache[0])')),
                'status=' + c.leer('_accountsCache[0].status'));
        } else { check('9 · MUTACIÓN DETECTADA: la deuda invisible', false); }

        // M2 · El flujo de caja vuelve a mirar solo las cuentas pagadas.
        const m2 = mutar(FUENTE, '            _accountsCache.forEach(account => {\n' +
            '                abonosDe(account).forEach(payment => {',
            '            _accountsCache.forEach(account => {\n' +
            '                if (account.status !== "paid") return;\n' +
            '                abonosDe(account).forEach(payment => {', 'flujo solo con pagadas');
        check('9 · la mutación «flujo solo con pagadas» se pudo aplicar', m2 !== null);
        if (m2) {
            const c = crearCuentas({ fuente: m2 });
            c.correr('_accountsCache = [' + JSON.stringify([
                cuenta({ id: 1, amount: 100, status: 'pending', payments: [{ amount: 40, date: '2026-03-10' }] })
            ]) + '];');
            c.correr('renderCashFlowChart()');
            check('9 · MUTACIÓN DETECTADA: el abono parcial desaparece del gráfico',
                ((c.registro.graficos[0] || {}).labels || []).length === 0);
        } else { check('9 · MUTACIÓN DETECTADA: el abono parcial desaparece', false); }

        // M3 · La unión deja de mirar las lápidas (resurrección).
        const m3 = mutar(FUENTE, '                if (clave && idEstaLapidado(clave, lapidas)) return; // no resucitar lo borrado',
            '                if (false) return;', 'unión sin lápidas');
        check('9 · la mutación «unión sin lápidas» se pudo aplicar', m3 !== null);
        if (m3) {
            const alm = almacen();
            const base = [cuenta({ id: 1 }), cuenta({ id: 5 })];
            alm.setItem('ciervo_accounts', JSON.stringify(base));
            const A = crearCuentas({ almacen: alm, fuente: m3 });
            const B = crearCuentas({ almacen: alm, fuente: m3 });
            A.correr('_accountsCache = ' + JSON.stringify(base) + ';');
            B.correr('_accountsCache = ' + JSON.stringify(base) + ';');
            A.correr('deletingAccountId = 5;');
            await A.correr('confirmDelete()');
            await B.correr('persistAccounts()');
            check('9 · MUTACIÓN DETECTADA: la cuenta borrada vuelve al guardar en la otra pestaña',
                idsEnAlmacen(alm).indexOf(5) !== -1, JSON.stringify(idsEnAlmacen(alm)));
        } else { check('9 · MUTACIÓN DETECTADA: la cuenta resucita', false); }

        // M4 · El id vuelve a recalcularse al cargar (se reutiliza).
        const m4 = mutar(FUENTE, '                    nextAccountId = proximoIdCuenta(_accountsCache);   // ids monótonos',
            '                    nextAccountId = _accountsCache.length > 0 ? Math.max(..._accountsCache.map(a => a.id)) + 1 : 1;',
            'id recalculado');
        check('9 · la mutación «id recalculado» se pudo aplicar', m4 !== null);
        if (m4) {
            // Estado directo: el contador recuerda que el 2 ya se entregó (la cuenta se
            // borró), y solo queda la 1 en el almacén.
            const alm = almacen();
            alm.setItem('ciervo_accounts', JSON.stringify([cuenta({ id: 1 })]));
            alm.setItem('cuentas_ultimo_id', '2');
            const c = crearCuentas({ almacen: alm, fuente: m4 });
            c.correr('loadAccounts()');
            check('9 · MUTACIÓN DETECTADA: con el id recalculado, el 2 se reutiliza',
                c.leer('nextAccountId') === 2, 'nextAccountId=' + c.leer('nextAccountId'));
        } else { check('9 · MUTACIÓN DETECTADA: el id se reutiliza', false); }

        // M5 · Sin puerta en el abono (capa 2).
        const m5 = mutar(FUENTE, '            if (!permiteEditarCuentas()) {\n' +
            "                showNotification('Solo un administrador puede registrar abonos.', 'error');\n" +
            '                closePaymentModal();\n' +
            '                return;\n' +
            '            }\n' +
            '            const paymentInput = document.getElementById(\'paymentAmount\');',
            '            const paymentInput = document.getElementById(\'paymentAmount\');',
            'abono sin puerta');
        check('9 · la mutación «abono sin puerta» se pudo aplicar', m5 !== null);
        if (m5) {
            const v = crearCuentas({ perfil: 'vendedor', fuente: m5 });
            v.correr('_accountsCache = [' + JSON.stringify(cuenta({ id: 1, amount: 100 })) + '];');
            v.correr('payingAccountId = 1;');
            v.doc.getElementById('paymentAmount').value = '50';
            await v.correr('confirmPayment()');
            check('9 · MUTACIÓN DETECTADA: sin la puerta, el Vendedor cobra',
                v.leer('_accountsCache[0].payments.length') === 1);
        } else { check('9 · MUTACIÓN DETECTADA: el Vendedor cobra', false); }

        // M6 · Sin saneador: la basura entra tal cual en memoria (y viajaría así al
        // almacén y a la nube). Los consumidores son defensivos a propósito, pero el
        // CONTRATO del dato se rompe; aquí es donde se nota.
        // (El anclaje empieza en la SEGUNDA línea de la función: al extraerla, la primera
        //  pierde su indentación de 8 espacios.)
        const m6 = mutar(FUENTE,
            "            if (!cuenta || typeof cuenta !== 'object') return null;",
            "            if (!cuenta || typeof cuenta !== 'object') return null;\n" +
            '            if (true) return cuenta;   // mutación: sin sanear',
            'sin normalizador');
        check('9 · la mutación «sin normalizador» se pudo aplicar', m6 !== null);
        if (m6) {
            const alm = almacen();
            alm.setItem('ciervo_accounts', JSON.stringify([
                { id: 1, type: 'cobrar', description: 'Basura', amount: '40', dueDate: 'no-es-fecha' }
            ]));
            const c = crearCuentas({ almacen: alm, fuente: m6 });
            c.correr('loadAccounts()');
            check('9 · MUTACIÓN DETECTADA: sin saneador, en memoria queda el importe de texto y sin abonos',
                c.leer('typeof _accountsCache[0].amount') === 'string' &&
                c.leer('typeof _accountsCache[0].payments') === 'undefined',
                'amount=' + c.leer('typeof _accountsCache[0].amount') +
                ' payments=' + c.leer('typeof _accountsCache[0].payments'));
        } else { check('9 · MUTACIÓN DETECTADA: la basura entra sin sanear', false); }
    }

    /* ------------------------------------------------------------------ */
    console.log('\n================ ' + ok + ' OK, ' + fallos + ' FALLAS ================');
    console.log('      Nota: los dobles simulan el navegador, el almacén y la nube. No se');
    console.log('      prueban Chart.js real, el pintado real del DOM ni Firebase.');
    process.exit(fallos ? 1 : 0);
})();
