/**
 * pruebas_guardian_cuota_paginas.js
 *
 * Encargo 3: las 6 páginas que todavía no cargaban el guardián de almacenamiento
 * (`compras.html`, `catalogo.html`, `cuentas.html`, `gestion_empresa.html`,
 * `gestion_proveedores.html`, `listado_clientes.html`) ahora:
 *   1. cargan `almacenamiento.js` en el <head>, DESPUÉS de `datos_cuenta.js` y antes
 *      de cualquier bloque de script propio de la página;
 *   2. guardan sus claves de negocio con `guardarLocalSeguro(...)` y conservan el
 *      respaldo con `localStorage.setItem(...)` si el módulo no está cargado;
 *   3. llaman una vez a `avisarSiLleno()` dentro de `DOMContentLoaded`.
 *
 * Comprueba cada página de dos formas:
 *   - ESTÁTICA: orden de los <script>, bloques en línea que compilan (new vm.Script),
 *     cada clave con su guardián + respaldo, y la llamada a avisarSiLleno().
 *   - DINÁMICA: extrae del HTML la función real que guarda y la ejecuta dentro de un
 *     sandbox (a) con el módulo REAL y un localStorage que lanza cuota al escribir, y
 *     (b) sin el módulo. En (a) no debe lanzar, debe registrar el fallo y la página
 *     sigue viva; en (b) el respaldo debe guardar igual.
 *
 * No necesita navegador ni Firebase.
 * Uso:  node pruebas_guardian_cuota_paginas.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = __dirname;
let pruebas = 0;
let fallos = 0;

function check(nombre, condicion) {
    pruebas++;
    if (!condicion) fallos++;
    console.log((condicion ? '  OK   ' : '  FALLA') + ' · ' + nombre);
}

function titulo(texto) {
    console.log('\n=== ' + texto + ' ===');
}

/* ------------------------------------------------------------------ */
/* 1. Utilidades                                                      */
/* ------------------------------------------------------------------ */

function errorDeCuota() {
    const e = new Error('QuotaExceededError: cuota simulada en las pruebas');
    e.name = 'QuotaExceededError';
    e.code = 22;
    return e;
}

function crearStorageFalso(inicial, opciones) {
    const op = opciones || {};
    const datos = new Map();
    if (inicial) {
        Object.keys(inicial).forEach(function (k) { datos.set(String(k), String(inicial[k])); });
    }
    return {
        getItem: function (k) { k = String(k); return datos.has(k) ? datos.get(k) : null; },
        setItem: function (k, v) {
            if (op.fallarSiempre) throw errorDeCuota();
            datos.set(String(k), String(v));
        },
        removeItem: function (k) { datos.delete(String(k)); },
        clear: function () { datos.clear(); },
        key: function (i) {
            const claves = Array.from(datos.keys());
            const n = Number(i);
            return (n >= 0 && n < claves.length) ? claves[n] : null;
        },
        get length() { return datos.size; },
        _datos: datos
    };
}

function crearDocumentoFalso() {
    function crearNodo(etiqueta) {
        const nodo = {
            tagName: String(etiqueta).toUpperCase(),
            style: {},
            hijos: [],
            atributos: {},
            parentNode: null,
            texto: '',
            _html: '',
            appendChild: function (hijo) { hijo.parentNode = nodo; nodo.hijos.push(hijo); return hijo; },
            removeChild: function (hijo) {
                const i = nodo.hijos.indexOf(hijo);
                if (i >= 0) nodo.hijos.splice(i, 1);
                hijo.parentNode = null;
                return hijo;
            },
            setAttribute: function (k, v) { nodo.atributos[k] = v; },
            getAttribute: function (k) { return nodo.atributos[k]; },
            click: function () { if (typeof nodo.onclick === 'function') nodo.onclick(); }
        };
        Object.defineProperty(nodo, 'textContent', {
            get: function () { return nodo.texto; },
            set: function (v) { nodo.texto = String(v); }
        });
        Object.defineProperty(nodo, 'innerHTML', {
            get: function () { return nodo._html; },
            set: function (v) { nodo._html = String(v); nodo.hijos.length = 0; }
        });
        return nodo;
    }
    const elementos = {};
    const documento = {
        body: crearNodo('body'),
        createElement: crearNodo,
        getElementById: function (id) { return elementos[id] || null; }
    };
    Object.defineProperty(documento, '_elementos', { get: function () { return elementos; } });
    return documento;
}

function scriptsEnLinea(html) {
    const salida = [];
    const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) salida.push(m[1]);
    return salida;
}

function leer(archivo) {
    return fs.readFileSync(path.join(RAIZ, archivo), 'utf8');
}

/** Genera el código JS a ejecutar extrayéndolo del HTML con una regex. */
function extraerCon(regex) {
    return function (html) {
        const m = html.match(regex);
        return m ? m[0] : null;
    };
}

/* ------------------------------------------------------------------ */
/* 2. Páginas y sus funciones reales de guardado                      */
/* ------------------------------------------------------------------ */

const PAGINAS = [
    {
        archivo: 'compras.html',
        claves: ['ciervo_suppliers', 'ciervo_purchases', 'ciervo_inventory_history', 'ciervo_inventory'],
        globals: {
            suppliers: [],
            purchases: [],
            inventoryHistory: [],
            _pendingChanges: false,
            marcarPendienteSync: function () {},
            limpiarPendienteSync: function () {},
            showNotification: function () {},
            firebaseSaveSuppliers: function () { return Promise.resolve(false); },
            firebaseSavePurchases: function () { return Promise.resolve(false); },
            firebaseSaveHistory: function () { return Promise.resolve(false); },
            firebaseSaveProducts: function () { return Promise.resolve(false); }
        },
        funciones: [
            {
                nombre: 'saveData',
                generar: extraerCon(/async function saveData\(\) \{[\s\S]*?\r?\n {8}\}/),
                args: []
            },
            {
                nombre: 'saveInventoryToStorage',
                generar: extraerCon(/async function saveInventoryToStorage\(inventory\) \{[\s\S]*?\r?\n {8}\}/),
                args: [['P-1']]
            }
        ]
    },
    {
        archivo: 'catalogo.html',
        claves: ['ciervo_inventory'],
        globals: {
            products: [{ id: 'P-1' }],
            marcarPendienteSync: function () {},
            renderAll: function () {},
            firebaseSaveProducts: function () { return null; }
        },
        funciones: [
            {
                nombre: 'saveProducts',
                generar: extraerCon(/function saveProducts\(\) \{[\s\S]*?\r?\n {8}\}/),
                args: []
            }
        ]
    },
    {
        archivo: 'cuentas.html',
        claves: ['ciervo_accounts'],
        globals: {
            _accountsCache: [{ id: 1 }],
            marcarPendienteSync: function () {}
        },
        funciones: [
            {
                nombre: 'saveAccountsCache',
                generar: extraerCon(/function saveAccountsCache\(\) \{[\s\S]*?\r?\n {8}\}/),
                args: []
            }
        ]
    },
    {
        // En gestion_empresa el guardado de companyData vive dentro del manejador del
        // formulario (no hay función con nombre): se extrae el bloque real que escribe.
        archivo: 'gestion_empresa.html',
        claves: ['companyData'],
        globals: {
            marcarPendienteSync: function () {}
        },
        funciones: [
            {
                nombre: 'bloqueGuardadoCompanyData',
                generar: function (html) {
                    const m = html.match(/(?:^|\r?\n) {12}\/\/ Guardián de almacenamiento \(almacenamiento\.js\): avisa si la cuota está llena\.\r?\n([\s\S]*?\r?\n {12}\})(?=\r?\n)/);
                    if (!m) return null;
                    return 'async function bloqueGuardadoCompanyData() {\r\n' +
                           '  const companyInfo = { nombre: "Demo" };\r\n' + m[1] + '\r\n}';
                },
                args: []
            }
        ]
    },
    {
        archivo: 'gestion_proveedores.html',
        claves: ['ciervo_suppliers'],
        globals: {
            _suppliersCache: [],
            checkCloudAccess: function () { return Promise.resolve(false); },
            marcarPendienteSync: function () {}
        },
        funciones: [
            {
                nombre: 'pushSupplierToFirebase',
                generar: extraerCon(/async function pushSupplierToFirebase\(supplierData\) \{[\s\S]*?\r?\n {8}\}/),
                args: [{ nombre: 'Proveedor Demo' }]
            }
        ]
    },
    {
        archivo: 'listado_clientes.html',
        claves: ['ciervo_clients'],
        globals: {
            allClientsData: [{ id: 'C-1', name: 'Cliente Demo' }],
            checkCloudAccess: function () { return Promise.resolve(false); },
            marcarPendienteSync: function () {},
            filterAndRenderClients: function () {}
        },
        funciones: [
            {
                nombre: 'saveClient',
                generar: extraerCon(/async function saveClient\(updatedClient\) \{[\s\S]*?\r?\n {8}\}/),
                args: [{ id: 'C-1', name: 'Cliente Demo' }]
            }
        ]
    }
];

/* ------------------------------------------------------------------ */
/* 3. Comprobaciones estáticas                                        */
/* ------------------------------------------------------------------ */

function probarEstatico() {
    titulo('1. Estático: orden de <script>, guardián + respaldo por clave y avisarSiLleno()');

    PAGINAS.forEach(function (pagina) {
        const html = leer(pagina.archivo);

        // 1.a Orden: datos_cuenta.js -> almacenamiento.js -> primer bloque propio.
        const posDatos = html.indexOf('src="datos_cuenta.js"');
        const posAlm = html.indexOf('src="almacenamiento.js"');
        const posFinHead = html.indexOf('</head>');
        const posPrimerInline = html.search(/<script(?![^>]*\bsrc\s*=)[^>]*>/i);
        check(pagina.archivo + ': carga almacenamiento.js después de datos_cuenta.js y en el <head>',
            posDatos !== -1 && posAlm !== -1 && posDatos < posAlm && posFinHead !== -1 && posAlm < posFinHead);
        check(pagina.archivo + ': almacenamiento.js va antes de cualquier bloque de script propio',
            posPrimerInline !== -1 && posAlm < posPrimerInline);

        // 1.b Los bloques en línea compilan.
        let compilan = true;
        let motivo = '';
        const bloques = scriptsEnLinea(html);
        bloques.forEach(function (bloque, i) {
            try {
                new vm.Script(bloque, { filename: pagina.archivo + '#script' + (i + 1) });
            } catch (e) {
                compilan = false;
                motivo = e.message;
            }
        });
        check(pagina.archivo + ': sus ' + bloques.length + ' bloque(s) <script> en línea compilan' +
            (compilan ? '' : ' — ' + motivo), compilan && bloques.length > 0);

        // 1.c Cada clave de negocio: guardián + respaldo, sin escritura ciega.
        pagina.claves.forEach(function (clave) {
            const reSet = new RegExp('localStorage\\.setItem\\(\'' + clave + '\'', 'g');
            const reGuardar = new RegExp('guardarLocalSeguro\\(\'' + clave + '\'', 'g');
            const posiciones = [];
            let m;
            while ((m = reSet.exec(html)) !== null) posiciones.push(m.index);
            const guardadas = (html.match(reGuardar) || []).length;
            check(pagina.archivo + ' [' + clave + ']: usa guardarLocalSeguro y conserva el respaldo a localStorage.setItem',
                guardadas >= 1 && posiciones.length >= 1 && guardadas === posiciones.length);
            const todasProtegidas = posiciones.every(function (pos) {
                const antes = html.slice(Math.max(0, pos - 300), pos);
                return /typeof window\.guardarLocalSeguro === 'function'/.test(antes) && /\}\s*else\s*\{/.test(antes);
            });
            check(pagina.archivo + ' [' + clave + ']: cada localStorage.setItem es el respaldo del guardián (else)',
                todasProtegidas);
        });

        // 1.d Nada de tema/ajustes envuelto: el guardián es solo para datos de negocio.
        check(pagina.archivo + ': no envuelve las escrituras de tema/ajustes (theme, darkMode)',
            !/guardarLocalSeguro\('(?:theme|darkMode)'/.test(html));

        // 1.e avisarSiLleno() una vez, dentro de DOMContentLoaded y sin bloquear.
        const posAviso = html.indexOf('avisarSiLleno()');
        const antesAviso = posAviso === -1 ? '' : html.slice(Math.max(0, posAviso - 400), posAviso);
        check(pagina.archivo + ': llama a avisarSiLleno() dentro de DOMContentLoaded con typeof guard',
            posAviso !== -1 &&
            /addEventListener\('DOMContentLoaded'/.test(antesAviso) &&
            /typeof window\.avisarSiLleno === 'function'/.test(antesAviso));
    });
}

/* ------------------------------------------------------------------ */
/* 4. Comprobaciones dinámicas                                        */
/* ------------------------------------------------------------------ */

function crearSandbox(globals, almacen) {
    const sandbox = {
        console: console,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Promise: Promise,
        JSON: JSON,
        Object: Object,
        Array: Array,
        Error: Error,
        Number: Number,
        String: String,
        Boolean: Boolean,
        Date: Date,
        Math: Math,
        Map: Map,
        Set: Set,
        isFinite: isFinite,
        isNaN: isNaN,
        parseInt: parseInt,
        parseFloat: parseFloat,
        localStorage: almacen,
        sessionStorage: crearStorageFalso(),
        document: crearDocumentoFalso(),
        navigator: {},
        location: { origin: 'https://pruebas.local' },
        dispatchEvent: function () {},
        CustomEvent: function (tipo, opciones) {
            this.type = tipo;
            this.detail = opciones && opciones.detail;
        }
    };
    Object.keys(globals || {}).forEach(function (k) { sandbox[k] = globals[k]; });
    sandbox.window = sandbox;
    return sandbox;
}

async function ejecutarFuncionReal(archivo, definicion, globals, almacen, conModulo) {
    const html = leer(archivo);
    const codigo = definicion.generar(html);
    const resultado = { codigo: codigo, error: null, sandbox: null, guardadas: [], llamada: false };
    if (!codigo) return resultado;

    const sandbox = crearSandbox(globals, almacen);
    sandbox._guardadas = resultado.guardadas;
    vm.createContext(sandbox);
    resultado.sandbox = sandbox;

    if (conModulo) {
        const modulo = leer('almacenamiento.js');
        vm.runInContext(modulo, sandbox, { filename: 'almacenamiento.js' });
        // Se espía el guardián REAL para saber si se llamó y qué devolvió.
        const real = sandbox.guardarLocalSeguro;
        sandbox.guardarLocalSeguro = function (clave, valor) {
            const r = real(clave, valor);
            sandbox._guardadas.push({ clave: clave, ok: r.ok, codigo: r.codigo });
            return r;
        };
    }

    vm.runInContext(codigo, sandbox, { filename: archivo + '#' + definicion.nombre });
    try {
        const r = sandbox[definicion.nombre].apply(null, definicion.args || []);
        if (r && typeof r.then === 'function') await r;
        resultado.llamada = true;
    } catch (e) {
        resultado.error = e;
    }
    // La página sigue viva: se ejecuta una sentencia MÁS después del guardado.
    try {
        vm.runInContext('window.__sigueViva = true;', sandbox);
    } catch (e) {
        resultado.error = resultado.error || e;
    }
    return resultado;
}

async function probarDinamico() {
    titulo('2. Dinámico con cuota llena: la función real de guardado no lanza y la página sigue viva');

    for (const pagina of PAGINAS) {
        for (const definicion of pagina.funciones) {
            const almacen = crearStorageFalso({}, { fallarSiempre: true });
            const r = await ejecutarFuncionReal(pagina.archivo, definicion, pagina.globals, almacen, true);
            const etiqueta = pagina.archivo + '#' + definicion.nombre;
            if (!r.codigo) {
                check(etiqueta + ': se pudo extraer del HTML la función real de guardado', false);
                continue;
            }
            check(etiqueta + ': la función real no lanza con la cuota llena',
                r.llamada === true && r.error === null);
            check(etiqueta + ': el guardián registra el fallo (codigo CUOTA)',
                r.guardadas.length > 0 &&
                r.guardadas.every(function (g) { return g.ok === false && g.codigo === 'CUOTA'; }) &&
                r.guardadas.every(function (g) { return pagina.claves.indexOf(g.clave) !== -1; }));
            check(etiqueta + ': la página sigue viva tras el fallo',
                r.sandbox && r.sandbox.__sigueViva === true);
            check(etiqueta + ': no quedó nada escrito a medias',
                pagina.claves.every(function (k) { return !almacen._datos.has(k); }));
        }
    }
}

async function probarSinModulo() {
    titulo('3. Sin el módulo cargado: el respaldo sigue guardando (nada se rompe)');

    for (const pagina of PAGINAS) {
        for (const definicion of pagina.funciones) {
            const almacen = crearStorageFalso();
            const r = await ejecutarFuncionReal(pagina.archivo, definicion, pagina.globals, almacen, false);
            const etiqueta = pagina.archivo + '#' + definicion.nombre;
            if (!r.codigo) continue;
            const clavesGuardadas = Array.from(almacen._datos.keys());
            check(etiqueta + ': sin guardián, no lanza y guarda con localStorage.setItem',
                r.llamada === true && r.error === null && r.sandbox &&
                typeof r.sandbox.guardarLocalSeguro === 'undefined' &&
                pagina.claves.some(function (k) { return almacen._datos.has(k); }));
            check(etiqueta + ': el respaldo guarda JSON válido bajo una clave de la página (' + clavesGuardadas.join(', ') + ')',
                pagina.claves.some(function (k) {
                    if (!almacen._datos.has(k)) return false;
                    try { JSON.parse(almacen._datos.get(k)); return true; } catch (e) { return false; }
                }));
        }
    }
}

/* ------------------------------------------------------------------ */
/* 5. Sin escrituras de negocio a ciegas (regresión global)            */
/* ------------------------------------------------------------------ */

function probarSinEscriturasCiegas() {
    titulo('4. Ninguna clave de negocio de las 6 páginas queda con escritura ciega');
    PAGINAS.forEach(function (pagina) {
        const html = leer(pagina.archivo);
        const ciegas = [];
        pagina.claves.forEach(function (clave) {
            const reSet = new RegExp('localStorage\\.setItem\\(\'' + clave + '\'', 'g');
            let m;
            while ((m = reSet.exec(html)) !== null) {
                const antes = html.slice(Math.max(0, m.index - 300), m.index);
                if (!/typeof window\.guardarLocalSeguro === 'function'/.test(antes)) ciegas.push(clave);
            }
        });
        check(pagina.archivo + ': todas sus escrituras de negocio están bajo el guardián',
            ciegas.length === 0);
    });
}

/* ------------------------------------------------------------------ */
/* Ejecución                                                          */
/* ------------------------------------------------------------------ */
(async function () {
    console.log('Pruebas del guardián de cuota en las 6 páginas que faltaban');
    console.log('Node ' + process.version + ' · ' + new Date().toISOString());

    probarEstatico();
    await probarDinamico();
    await probarSinModulo();
    probarSinEscriturasCiegas();

    console.log('\n----------------------------------------');
    console.log('RESULTADO: ' + (pruebas - fallos) + '/' + pruebas + ' comprobaciones OK' + (fallos ? ' · ' + fallos + ' FALLA(S)' : ' · sin fallos'));
    process.exit(fallos ? 1 : 0);
})().catch(function (e) {
    console.error('ERROR INESPERADO EN LAS PRUEBAS:', e);
    process.exit(1);
});
