/* =====================================================================
   PRUEBAS DEL MOTOR DE OPERACIONES REAL (etapa E1, ámbito POS)

   Se ejecuta con:  node pruebas_motor_real.js

   QUÉ PRUEBA
   ----------
   El MOTOR REAL (`motor_operaciones.js`, el archivo que carga
   mini_market_pos.html), no el modelo del diseño. Ese modelo ya está validado
   por `pruebas_motor_operaciones.js` (49 comprobaciones); esto comprueba que el
   código de verdad se comporta como el modelo.

   CÓMO LO PRUEBA
   --------------
   * El archivo real se carga dentro de un contexto de `vm` con un `window`
     falso, un `navigator` con OPFS falso (`navigator.storage.getDirectory()`),
     un `localStorage`/`sessionStorage` falsos y un `indexedDB` falso para
     comprobar la caída automática de OPFS a IndexedDB.
   * La nube es un mock del SDK v8 con la semántica ya verificada en
     `pruebas_sincronizacion.js`: `.set()` resuelve al confirmar el servidor;
     SIN conexión la promesa queda PENDIENTE y la escritura vive solo en la cola
     en memoria del SDK (se va con la pestaña); las reglas pueden negar con
     `PERMISSION_DENIED`. También implementa `orderByChild().endAt()
     .limitToLast().once('value')` para poder comprobar la paginación real del
     histórico.
   * "Cerrar el navegador" = se tira el contexto de `vm` (se pierde la memoria
     del motor y la cola en memoria del SDK) y se abre uno nuevo sobre el MISMO
     disco falso (los archivos de OPFS y el localStorage quedan).
   * En P11 se carga además el POS REAL: los bloques <script> en línea de
     `mini_market_pos.html` (los mismos que se comprueban con `new vm.Script`)
     junto al motor, con un DOM mínimo, y se llama a `processSale()` de verdad
     para ver el reparto de caminos en los dos modos.

   CASOS (los 8 obligatorios del encargo + los extra)
   --------------------------------------------------
   P1  la cola sobrevive a "cerrar el navegador" antes de subir
   P2  reenviar la misma operación no duplica (y el conflicto no pisa)
   P3  no se libera sin confirmación (aunque tenga más de 30 días)
   P4  dos equipos con el mismo negocio conservan las dos ventas
   P5  installId distinto evita la colisión de claves
   P6  la verificación de liberadas recientes re-sube lo que falte (y se poda a 48 h)
   P7  el interruptor modoSync: el booleano true y la cadena 'operaciones' activan
       el motor; false, 'clasico', un valor raro o un fallo de lectura -> clásico
   P8  el histórico antiguo se lee paginado y no se reescribe
   P9  caída automática de OPFS a IndexedDB (extra)
   P10 sin ningún almacén durable el motor no arranca (extra)
   P11 el POS real de punta a punta: processSale en clásico y en operaciones (extra)
   P12 sin permiso de nube (cloudSync != true) el motor es SOLO-LOCAL (extra)
   P13 el campo modoSync se crea solo en false y NUNCA se pisa si ya existe (extra)

   Formato: OK/FALLA por comprobación, resumen final y código de salida.
   ===================================================================== */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

let ok = 0, fallos = 0;
const check = (nombre, condicion, extra = '') => {
    if (condicion) { ok++; console.log('OK    ' + nombre); }
    else { fallos++; console.log('FALLA ' + nombre + (extra !== '' ? '  -> ' + extra : '')); }
};
const nota = (t) => console.log('      ' + t);
const aviso = (t) => console.log('      [!] ' + t);
const titulo = (t) => console.log('\n' + t);
const json = (v) => JSON.stringify(v);

const DIA = 24 * 60 * 60 * 1000;
const EMAIL_PATH = 'negocio_at_ejemplo_com';
const RAIZ = 'BBDD/' + EMAIL_PATH;
const RUTA_HISTORIAL = RAIZ + '/ventas/historial';
const CODIGO_MOTOR = fs.readFileSync(path.join(__dirname, 'motor_operaciones.js'), 'utf8');
const RUTA_POS = path.join(__dirname, 'mini_market_pos.html');

/* =====================================================================
   1. Utilidades de copia y JSON
   ===================================================================== */

function clonar(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }

function escribirEn(raiz, ruta, valor) {
    const partes = ruta.split('/').filter(Boolean);
    let nodo = raiz;
    for (let i = 0; i < partes.length - 1; i++) {
        if (nodo[partes[i]] === null || typeof nodo[partes[i]] !== 'object') nodo[partes[i]] = {};
        nodo = nodo[partes[i]];
    }
    nodo[partes[partes.length - 1]] = clonar(valor);
}

function leerDe(raiz, ruta) {
    let nodo = raiz;
    for (const p of ruta.split('/').filter(Boolean)) {
        if (nodo === null || typeof nodo !== 'object') return null;
        nodo = nodo[p];
    }
    return nodo === undefined ? null : clonar(nodo);
}

/** Un nodo de RTDB puede llegar como arreglo o como objeto con claves. */
function listaDe(valor) {
    if (!valor) return [];
    if (Array.isArray(valor)) return valor.filter((v) => v !== null && v !== undefined);
    if (typeof valor !== 'object') return [];
    return Object.keys(valor)
        .sort((a, b) => {
            const na = parseInt(a, 10), nb = parseInt(b, 10);
            if (isFinite(na) && isFinite(nb)) return na - nb;
            return a.localeCompare(b);
        })
        .map((k) => valor[k])
        .filter((v) => v !== null && v !== undefined);
}

/** Trozo de texto que va desde una firma de función hasta la siguiente. */
function bloqueDeFuncion(texto, firma) {
    const i = texto.indexOf(firma);
    if (i === -1) return '';
    const resto = texto.slice(i + firma.length);
    const m = /\n {8}(?:async )?function |\n {8}let |\n {8}const |\n {8}\/\/ =====/.exec(resto);
    return texto.slice(i, i + firma.length + (m ? m.index : resto.length));
}

/* =====================================================================
   2. Nube falsa (mock del SDK v8, con consultas)
   ===================================================================== */

function crearNube(opciones = {}) {
    return {
        datos: {},
        online: opciones.online !== false,   // false = .set() queda PENDIENTE (semántica v8)
        negar: false,                        // reglas: PERMISSION_DENIED
        negarLecturas: false,
        escrituras: [],                      // { ruta, valor } de cada set confirmado
        lecturas: [],                        // rutas de cada once('value') resuelto
        consultas: []                        // { ruta, campo, endAt, limitToLast }
    };
}

function crearDbFalso(servidor) {
    const pendienteEterna = () => new Promise(() => { /* sin conexión: nunca resuelve ni rechaza */ });

    function crearConsulta(ruta, campo) {
        const consulta = { ruta, campo, endAtValor: undefined, lim: null };
        const api = {
            endAt(v) { consulta.endAtValor = v; return api; },
            limitToLast(n) { consulta.lim = n; return api; },
            async once() {
                if (!servidor.online) return pendienteEterna();
                servidor.lecturas.push(ruta);
                servidor.consultas.push({ ruta, campo, endAt: consulta.endAtValor, limitToLast: consulta.lim });
                let lista = listaDe(leerDe(servidor.datos, ruta));
                if (campo) {
                    lista = lista.filter((x) => x && x[campo] !== undefined &&
                        (consulta.endAtValor === undefined || String(x[campo]) <= String(consulta.endAtValor)));
                    lista.sort((a, b) => String(a[campo]).localeCompare(String(b[campo])));
                }
                if (consulta.lim) lista = lista.slice(Math.max(0, lista.length - consulta.lim));
                const valor = {};
                lista.forEach((x, i) => { valor[String(i)] = x; });
                return { val: () => (lista.length ? clonar(valor) : null), exists: () => lista.length > 0 };
            }
        };
        return api;
    }

    function ref(ruta) {
        return {
            async set(valor) {
                if (!servidor.online) return pendienteEterna();
                if (servidor.negar) {
                    const e = new Error('PERMISSION_DENIED: rules denied write at ' + ruta);
                    e.code = 'PERMISSION_DENIED';
                    throw e;
                }
                servidor.escrituras.push({ ruta, valor: clonar(valor) });
                escribirEn(servidor.datos, ruta, valor);
                return true;
            },
            async once() {
                if (!servidor.online) return pendienteEterna();
                if (servidor.negarLecturas) {
                    const e = new Error('PERMISSION_DENIED: rules denied read at ' + ruta);
                    e.code = 'PERMISSION_DENIED';
                    throw e;
                }
                servidor.lecturas.push(ruta);
                const v = leerDe(servidor.datos, ruta);
                return { val: () => clonar(v), exists: () => v !== null && v !== undefined };
            },
            async transaction(fn) {
                if (!servidor.online) return pendienteEterna();
                const actual = leerDe(servidor.datos, ruta);
                const nuevo = fn(actual);
                servidor.escrituras.push({ ruta, valor: clonar(nuevo) });
                escribirEn(servidor.datos, ruta, nuevo);
                return { committed: true, snapshot: { val: () => clonar(nuevo) } };
            },
            on() { return () => {}; },
            orderByChild(campo) { return crearConsulta(ruta, campo); },
            orderByKey() { return crearConsulta(ruta, null); }
        };
    }

    return { ref };
}

/* =====================================================================
   3. Disco falso: OPFS y localStorage
   ===================================================================== */

function crearDisco() { return { archivos: {}, lecturas: 0, escrituras: 0 }; }

/** Lee el texto crudo de un archivo del disco falso (para mirar la cola real). */
function textoEnDisco(disco, nombre) { return disco.archivos[nombre] === undefined ? null : disco.archivos[nombre]; }

function crearNavigatorOPFS(disco, opciones = {}) {
    function archivoFalso(clave) {
        return {
            async getFile() {
                const t = disco.archivos[clave] || '';
                return { size: t.length, async text() { disco.lecturas++; return disco.archivos[clave] || ''; } };
            },
            async createWritable(o) {
                disco.escrituras++;
                let contenido = (o && o.keepExistingData) ? (disco.archivos[clave] || '') : '';
                let pos = contenido.length;
                return {
                    async seek(p) { pos = Number(p) || 0; },
                    async write(d) {
                        const texto = String(d);
                        contenido = contenido.slice(0, pos) + texto + contenido.slice(pos + texto.length);
                        pos += texto.length;
                    },
                    async close() { disco.archivos[clave] = contenido; }
                };
            }
        };
    }

    function dirFalso(prefijo) {
        return {
            async getDirectoryHandle(nombre, o) {
                const clave = prefijo + nombre + '/';
                if (o && o.create) disco.archivos['dir:' + clave] = true;
                else if (!disco.archivos['dir:' + clave]) {
                    const e = new Error('NotFoundError: ' + clave);
                    e.name = 'NotFoundError';
                    throw e;
                }
                return dirFalso(clave);
            },
            async getFileHandle(nombre, o) {
                const clave = prefijo + nombre;
                if (o && o.create) { if (!(clave in disco.archivos)) disco.archivos[clave] = ''; return archivoFalso(clave); }
                if (!(clave in disco.archivos)) {
                    const e = new Error('NotFoundError: ' + clave);
                    e.name = 'NotFoundError';
                    throw e;
                }
                return archivoFalso(clave);
            },
            async removeEntry(nombre) { delete disco.archivos[prefijo + nombre]; }
        };
    }

    const nav = { onLine: opciones.onLine !== false };
    if (opciones.sinOPFS !== true) {
        nav.storage = {
            async getDirectory() { return dirFalso(''); },
            async persist() { return true; },
            async persisted() { return true; }
        };
    }
    return nav;
}

function crearLocalStorageFalso(inicial = {}) {
    const datos = Object.assign({}, inicial);
    return {
        _datos: datos,
        getItem: (k) => (k in datos ? datos[k] : null),
        setItem: (k, v) => { datos[k] = String(v); },
        removeItem: (k) => { delete datos[k]; },
        key: (i) => Object.keys(datos)[i],
        get length() { return Object.keys(datos).length; }
    };
}

/* =====================================================================
   4. IndexedDB falso (solo lo que usa el motor)
   ===================================================================== */

const DATOS_IDB = {};

function crearIndexedDBFalso() {
    function hacerDb(nombre) {
        return {
            objectStoreNames: { contains: (n) => Object.prototype.hasOwnProperty.call(DATOS_IDB[nombre] || {}, n) },
            createObjectStore(n) {
                DATOS_IDB[nombre] = DATOS_IDB[nombre] || {};
                DATOS_IDB[nombre][n] = DATOS_IDB[nombre][n] || {};
                return {};
            },
            transaction(nombreStore) {
                DATOS_IDB[nombre] = DATOS_IDB[nombre] || {};
                const store = DATOS_IDB[nombre][nombreStore] = DATOS_IDB[nombre][nombreStore] || {};
                const tx = { oncomplete: null, onerror: null, onabort: null };
                const terminar = () => { setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0); };
                const api = {
                    get(clave) {
                        const req = {};
                        setTimeout(() => { req.result = (clave in store) ? store[clave] : undefined; if (req.onsuccess) req.onsuccess(); terminar(); }, 0);
                        return req;
                    },
                    put(valor, clave) {
                        const req = {};
                        setTimeout(() => { store[clave] = valor; if (req.onsuccess) req.onsuccess(); terminar(); }, 0);
                        return req;
                    },
                    delete(clave) {
                        const req = {};
                        setTimeout(() => { delete store[clave]; if (req.onsuccess) req.onsuccess(); terminar(); }, 0);
                        return req;
                    }
                };
                tx.objectStore = () => api;
                return tx;
            }
        };
    }

    return {
        open(nombre) {
            const req = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
            setTimeout(() => {
                DATOS_IDB[nombre] = DATOS_IDB[nombre] || {};
                req.result = hacerDb(nombre);
                try { if (req.onupgradeneeded) req.onupgradeneeded(); } catch (e) { /* nada */ }
                try { if (req.onsuccess) req.onsuccess(); } catch (e) { /* nada */ }
            }, 0);
            return req;
        }
    };
}

/* =====================================================================
   5. Entorno de ejecución del motor real
   ===================================================================== */

function crearEntorno(opciones = {}) {
    const disco = opciones.disco || crearDisco();
    const nav = opciones.nav || crearNavigatorOPFS(disco, opciones);
    const local = opciones.local || crearLocalStorageFalso(opciones.localInicial || {});
    const sesion = opciones.sesion || crearLocalStorageFalso();
    const avisos = [];
    const ctx = {
        console: {
            log: () => {},
            warn: (m) => { avisos.push(String(m)); },
            error: () => {}
        },
        JSON, Object, Array, String, Number, Boolean, Math, Date, Promise, Error,
        isFinite, isNaN, parseInt, parseFloat, setTimeout, clearTimeout, Uint8Array,
        crypto: { getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; } },
        navigator: nav,
        localStorage: local,
        sessionStorage: sesion,
        indexedDB: opciones.indexedDB
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(CODIGO_MOTOR, ctx, { filename: 'motor_operaciones.js' });
    return { ctx, motor: ctx.window.motorOperaciones, disco, nav, local, sesion, avisos };
}

/* =====================================================================
   6. Entorno del POS REAL (mini_market_pos.html + el motor, en el mismo vm)

   Aquí no se prueba el motor en aislado: se cargan en el MISMO contexto el
   motor real y los bloques <script> en línea del POS real, con un DOM mínimo,
   los mismos mocks de OPFS/Firebase, y se llama a `processSale()`, que es la
   función que cobra de verdad. Lo que se comprueba es el reparto de caminos:
   en 'clasico' el POS hace exactamente lo de hoy; en 'operaciones' la venta va
   a la cola y NUNCA se sube el arreglo completo.
   ===================================================================== */

const POS_BLOQUES = (() => {
    const html = fs.readFileSync(RUTA_POS, 'utf8').replace(/\r\n/g, '\n');
    return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
})();

function elementoFalso() {
    const el = {
        style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', innerText: '', checked: false, disabled: false,
        classList: {
            add() {}, remove() {}, toggle() {}, contains() { return false; }, replace() {}, item() { return null; }, length: 0
        },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        appendChild() {}, removeChild() {}, replaceChild() {}, insertBefore() {}, append() {}, prepend() {},
        insertAdjacentHTML() {}, insertAdjacentElement() {}, insertAdjacentText() {},
        remove() {}, focus() {}, click() {}, blur() {}, select() {}, scrollIntoView() {}, scrollTo() {},
        setAttribute() {}, getAttribute() { return null; }, hasAttribute() { return false; }, removeAttribute() {},
        matches() { return false; }, closest() { return null; }, cloneNode() { return elementoFalso(); },
        replaceChildren() {}, animate() { return { cancel() {} }; },
        getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
        querySelector() { return elementoFalso(); }, querySelectorAll() { return []; },
        contains() { return false; }, write() {}, close() {}, print() {}, toDataURL() { return ''; }
    };
    return el;
}

function crearEntornoPOS(opciones = {}) {
    const servidor = opciones.servidor || crearNube();
    const disco = opciones.disco || crearDisco();
    const nav = opciones.nav || crearNavigatorOPFS(disco);
    const local = opciones.local || crearLocalStorageFalso(opciones.localInicial || {});
    const sesion = opciones.sesion || crearLocalStorageFalso({
        currentUser: JSON.stringify({ name: 'maria', email: 'cliente@ejemplo.com' }),
        propietarioActual: 'cliente@ejemplo.com'
    });
    const dbMock = crearDbFalso(servidor);
    const avisos = [];
    const marcas = { pendientes: {}, llamadas: [] };
    const dbg = { processSaleError: '' };

    const elementos = {};                 // un elemento falso por id: permite leer el punto de estado
    const documentStub = {
        addEventListener() {}, removeEventListener() {},
        getElementById(id) { if (!elementos[id]) elementos[id] = elementoFalso(); return elementos[id]; },
        createElement() { return elementoFalso(); },
        querySelector() { return elementoFalso(); },
        querySelectorAll() { return []; },
        head: elementoFalso(), body: elementoFalso(), documentElement: elementoFalso(), title: ''
    };

    const ctx = {
        console: {
            log: () => {},
            warn: (m) => { avisos.push(String(m)); },
            error: (...a) => {
                dbg.processSaleError = a.map((x) => (x && x.stack) ? x.stack : String(x)).join(' | ');
                avisos.push('error: ' + dbg.processSaleError);
            }
        },
        JSON, Object, Array, String, Number, Boolean, Math, Date, Promise, Error, RegExp, Map, Set, Intl,
        isFinite, isNaN, parseInt, parseFloat, setTimeout, clearTimeout, setInterval, clearInterval,
        encodeURIComponent, decodeURIComponent, Uint8Array,
        crypto: {
            randomUUID: () => '11112222-3333-4444-5555-666677778888',
            getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; }
        },
        navigator: nav,
        localStorage: local,
        sessionStorage: sesion,
        indexedDB: opciones.indexedDB,
        document: documentStub,
        location: { protocol: 'https:', href: 'https://ejemplo/mini_market_pos.html' },
        alert: () => {},
        open: () => elementoFalso(),
        // El POS carga motor_operaciones.js por <script src>: aquí se carga a mano.
        firebase: { apps: [{}], initializeApp() {}, database: () => dbMock },
        // Ayudante real de Fase A: se sustituye por un espía (no se toca el archivo).
        marcarPendienteSync: (m) => { marcas.pendientes[m] = new Date().toISOString(); marcas.llamadas.push('marcar:' + m); },
        limpiarPendienteSync: (m) => { delete marcas.pendientes[m]; marcas.llamadas.push('limpiar:' + m); },
        hayPendientesSync: (m) => !!marcas.pendientes[m],
        puedeSobrescribirLocalSync: () => true
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(CODIGO_MOTOR, ctx, { filename: 'motor_operaciones.js' });
    vm.runInContext(POS_BLOQUES[POS_BLOQUES.length - 1], ctx, { filename: 'mini_market_pos.html#script' });

    /** Prepara el carrito y el cobro (las variables del POS son `let` globales). */
    function prepararVenta() {
        vm.runInContext([
            'cart = [{ product: { id: "P1", name: "Harina PAN", price: 2, isBulk: false, isIvaExempt: false }, quantity: 1, unit: "unidades" }];',
            'selectedPaymentMethod = "usd-cash";',
            'paymentDetails = { amount: 2 };',
            'currentCurrency = "USD";',
            'exchangeRate = 36.5;',
            'rateMode = "manual";',
            'rateSource = "manual";',
            'currentDiscount = 0;',
            'applyIVA = false;',
            'customerData = null;'
        ].join('\n'), ctx);
    }

    return { ctx, servidor, disco, nav, local, sesion, marcas, avisos, dbg, dbMock, elementos, prepararVenta };
}

/* =====================================================================
   7. Datos de ejemplo
   ===================================================================== */

/** Una venta con la forma exacta de `saleData` de processSale(). */
function venta(id, total, extra = {}) {
    return Object.assign({
        id: id,
        items: [{
            product: { id: 'P1', name: 'Harina PAN', price: 1, isBulk: false },
            quantity: 2, unit: 'unidades', unitPrice: 1, subtotal: 2, currency: 'USD'
        }],
        paymentMethod: 'usd-cash',
        paymentDetails: { amount: total },
        combinedPayment: null,
        currency: 'USD',
        totals: { subtotal: total, discount: 0, iva: 0, total: total },
        timestamp: new Date().toISOString(),
        customer: null,
        exchangeRate: 36.5,
        rateSource: 'manual',
        ivaApplied: false
    }, extra);
}

const OPS = (servidor, tipo) => Object.keys(leerDe(servidor.datos, RAIZ + '/ops/' + tipo) || {});
const rutaOpNodo = (tipo, nodo) => RAIZ + '/ops/' + tipo + '/' + nodo;
const rutaDeClave = (clave) => RAIZ + '/ops/' + clave;

/* =====================================================================
   8. ESCENARIOS
   ===================================================================== */

(async function main() {
    console.log('========== PRUEBAS DEL MOTOR REAL (motor_operaciones.js, E1) ==========');
    console.log('Se carga el archivo real en un contexto de vm con OPFS/IndexedDB y');
    console.log('Firebase falsos. "Cerrar el navegador" = tirar el vm y abrir otro sobre');
    console.log('el mismo disco falso (los archivos quedan).\n');

    /* ------------------------------------------------------------------
       P1 · La cola sobrevive a cerrar el navegador antes de subir
       ------------------------------------------------------------------ */
    titulo('P1 · Sin conexión: la operación está en DISCO antes de tocar la red, y sobrevive al cierre');
    {
        const servidor = crearNube({ online: false });
        const disco = crearDisco();
        const nav = crearNavigatorOPFS(disco, { onLine: false });
        const local = crearLocalStorageFalso({ pos_device_id: 'EQP1AAAA', pos_install_id: 'AAA1' });
        const db = crearDbFalso(servidor);

        const e1 = crearEntorno({ disco, nav, local, indexedDB: crearIndexedDBFalso() });
        const inicio1 = await e1.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP1AAAA', emailPath: EMAIL_PATH, db: db, operador: 'maria' });
        const reg = await e1.motor.registrarOperacion('venta', venta('V-LOCAL-EQP1AAAA-0001', 12));
        const colaCruda = textoEnDisco(disco, 'cola.jsonl');
        const calienteCrudo = textoEnDisco(disco, 'caliente/ventas.jsonl');
        const estado1 = e1.motor.estado();
        nota('iniciar -> ' + json({ activo: inicio1.activo, almacen: inicio1.almacen, installId: inicio1.installId, deviceId: inicio1.deviceId }));
        nota('registrar -> ' + json(reg));
        nota('cola.jsonl en disco (crudo): ' + String(colaCruda).replace(/\n/g, ' | ').trim());
        nota('estado -> ' + json(estado1));

        check('P1 · el motor arrancó en modo operaciones con almacén durable',
            inicio1.activo === true && inicio1.modo === 'operaciones' && inicio1.almacen === 'opfs',
            json(inicio1));
        check('P1 · registrarOperacion devuelve ok y la clave de operación',
            reg.ok === true && reg.clave === 'venta/EQP1AAAA_AAA1_0001', json(reg));
        check('P1 · la línea de la cola YA está en disco (antes de cualquier red)',
            typeof colaCruda === 'string' && colaCruda.indexOf('venta/EQP1AAAA_AAA1_0001') !== -1 &&
            colaCruda.indexOf('"estado":"pendiente"') !== -1, String(colaCruda));
        check('P1 · la venta está en la ventana caliente del equipo (se puede cobrar sin internet)',
            typeof calienteCrudo === 'string' && calienteCrudo.indexOf('V-LOCAL-EQP1AAAA-0001') !== -1);
        check('P1 · sin conexión no se intentó escribir en la nube',
            OPS(servidor, 'venta').length === 0 && servidor.escrituras.length === 0,
            json(OPS(servidor, 'venta')));
        check('P1 · el estado dice 1 pendiente y 0 subidas',
            estado1.pendientes === 1 && estado1.subidas === 0, json(estado1));

        // --- "se cierra el navegador": se tira el contexto y se abre otro sobre el mismo disco ---
        const e2 = crearEntorno({ disco, nav, local, indexedDB: crearIndexedDBFalso() });
        const inicio2 = await e2.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP1AAAA', emailPath: EMAIL_PATH, db: db, operador: 'maria' });
        check('P1 · tras reabrir, la operación sigue en la cola (leída del disco)',
            inicio2.pendientes === 1 && e2.motor.estado().pendientes === 1, json(inicio2));

        // --- vuelve la conexión ---
        nav.onLine = true;
        servidor.online = true;
        const vaciado = await e2.motor.vaciarCola();
        const enNube = leerDe(servidor.datos, rutaOpNodo('venta', 'EQP1AAAA_AAA1_0001'));
        nota('tras reconectar -> vaciado: ' + json(vaciado));
        nota('nube -> ' + json(enNube));
        check('P1 · al reconectar se sube y la cola queda a cero',
            vaciado.subidas === 1 && vaciado.fallos === 0 && e2.motor.estado().pendientes === 0, json(vaciado));
        check('P1 · la operación llegó a la nube con su ruta y su contenido',
            !!enNube && enNube.id === 'V-LOCAL-EQP1AAAA-0001' && enNube.deviceId === 'EQP1AAAA' &&
            enNube.installId === 'AAA1' && enNube.secuencia === 1 && enNube.version === 1,
            json(enNube));
        check('P1 · el payload es el saleData completo (el recibo se puede reconstruir)',
            !!enNube && !!enNube.payload && enNube.payload.items.length === 1 &&
            enNube.payload.totals.total === 12 && enNube.payload.paymentMethod === 'usd-cash',
            json(enNube && enNube.payload));
        check('P1 · quedó anotada como confirmada (el equipo sabe que puede liberarla algún día)',
            e2.motor.estado().confirmadas === 1, json(e2.motor.estado()));
    }

    /* ------------------------------------------------------------------
       P2 · Reenviar la misma operación no duplica
       ------------------------------------------------------------------ */
    titulo('P2 · Reenviar la misma operación no duplica (idempotencia por clave)');
    {
        const servidor = crearNube();
        const disco = crearDisco();
        const nav = crearNavigatorOPFS(disco);
        const local = crearLocalStorageFalso({ pos_device_id: 'EQP2BBBB', pos_install_id: 'BBB2' });
        const env = crearEntorno({ disco, nav, local });
        await env.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP2BBBB', emailPath: EMAIL_PATH, db: crearDbFalso(servidor) });

        const laVenta = venta('V-LOCAL-EQP2BBBB-0001', 25);
        const reg1 = await env.motor.registrarOperacion('venta', laVenta);
        const vac1 = await env.motor.vaciarCola();
        const vac2 = await env.motor.vaciarCola();
        const reg2 = await env.motor.registrarOperacion('venta', laVenta);   // la MISMA venta otra vez
        await env.motor.vaciarCola();
        const nodos = OPS(servidor, 'venta');

        nota('1er registro -> ' + json(reg1));
        nota('vaciados -> ' + json(vac1) + ' / ' + json(vac2));
        nota('2º registro de la misma venta -> ' + json(reg2));
        nota('nube -> ops/venta: ' + json(nodos));

        check('P2 · en la nube hay UNA sola operación', nodos.length === 1, json(nodos));
        check('P2 · el primer vaciado sube 1 y el segundo no tiene nada que hacer (ni reescribe)',
            vac1.subidas === 1 && vac1.yaEstaban === 0 && vac2.intentadas === 0 && vac2.subidas === 0,
            json({ vac1, vac2 }));
        check('P2 · volver a registrar la MISMA venta no crea otra entrada (duplicada)',
            reg2.ok === true && reg2.duplicada === true && nodos.length === 1, json(reg2));
        check('P2 · a esa ruta se escribió UNA sola vez',
            servidor.escrituras.filter((e) => e.ruta === rutaOpNodo('venta', 'EQP2BBBB_BBB2_0001')).length === 1,
            json(servidor.escrituras.map((e) => e.ruta)));

        // Misma clave con contenido DISTINTO: nunca se pisa (§1.4).
        const servidor2 = crearNube();
        const local2 = crearLocalStorageFalso({ pos_device_id: 'EQP3CCCC', pos_install_id: 'CCC3' });
        const env2 = crearEntorno({ disco: crearDisco(), nav: crearNavigatorOPFS(crearDisco()), local: local2 });
        await env2.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP3CCCC', emailPath: EMAIL_PATH, db: crearDbFalso(servidor2) });
        servidor2.negar = true;                                   // las reglas niegan la escritura
        const regF = await env2.motor.registrarOperacion('venta', venta('V-LOCAL-EQP3CCCC-0001', 50));
        const vacF = await env2.motor.vaciarCola();
        escribirEn(servidor2.datos, rutaDeClave(regF.clave), { id: 'OTRO-CONTENIDO', secuencia: 1 });
        servidor2.negar = false;
        const vacC = await env2.motor.vaciarCola();
        const trasConflicto = leerDe(servidor2.datos, rutaDeClave(regF.clave));
        nota('primer intento con las reglas cerradas -> ' + json(vacF));
        nota('reintento con la misma clave y contenido distinto -> ' + json(vacC));
        nota('la nube conserva -> ' + json(trasConflicto));
        check('P2 · el fallo no marca subida (estado fallo + intentos)',
            vacF.fallos === 1 && vacF.subidas === 0, json(vacF));
        check('P2 · el reintento con la misma clave y contenido DISTINTO no pisa la nube (conflicto)',
            vacC.conflictos === 1 && vacC.subidas === 0, json(vacC));
        check('P2 · la nube sigue con el contenido que ya tenía',
            !!trasConflicto && trasConflicto.id === 'OTRO-CONTENIDO', json(trasConflicto));
    }

    /* ------------------------------------------------------------------
       P3 · No se libera sin confirmación
       ------------------------------------------------------------------ */
    const T0 = Date.parse('2026-02-14T12:00:00.000Z');
    let escenarioP3 = null;
    titulo('P3 · Una operación de más de 30 días NO se libera mientras no esté confirmada');
    {
        const servidor = crearNube({ online: false });
        const disco = crearDisco();
        const nav = crearNavigatorOPFS(disco, { onLine: false });
        const local = crearLocalStorageFalso({ pos_device_id: 'EQP4DDDD', pos_install_id: 'DDD4' });
        const db = crearDbFalso(servidor);

        // Sesión 1: se vende "hace 40 días" (reloj congelado) sin conexión.
        const s1 = crearEntorno({ disco, nav, local });
        await s1.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP4DDDD', emailPath: EMAIL_PATH, db: db, ahora: T0 });
        const reg = await s1.motor.registrarOperacion('venta', venta('V-LOCAL-EQP4DDDD-0001', 30));
        const colaS1 = s1.motor.estado();
        check('P3 · la operación vieja queda en la cola sin confirmar',
            colaS1.pendientes === 1 && colaS1.subidas === 0 && colaS1.liberadas === 0, json(colaS1));

        // Sesión 2: 40 días después, con la nube negando la escritura.
        servidor.online = true; servidor.negar = true; nav.onLine = true;
        const s2 = crearEntorno({ disco, nav, local });
        await s2.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP4DDDD', emailPath: EMAIL_PATH, db: db, ahora: T0 + 40 * DIA });
        const vacF = await s2.motor.vaciarCola();
        const estado2 = s2.motor.estado();
        const ventasCalientes2 = await s2.motor.leerVentas(30);
        nota('con la subida denegada -> ' + json(vacF));
        nota('estado (40 días después, sin confirmar) -> ' + json({ pendientes: estado2.pendientes, liberadas: estado2.liberadas, cola: estado2.cola }));
        nota('ventas en la ventana caliente -> ' + json(ventasCalientes2.map((v) => v.id)));
        check('P3 · aunque tenga 40 días, sin confirmación NO se libera (sigue en caliente)',
            vacF.liberadas.length === 0 && estado2.liberadas === 0 &&
            textoEnDisco(disco, 'caliente/ventas.jsonl').indexOf('V-LOCAL-EQP4DDDD-0001') !== -1,
            json({ liberadas: vacF.liberadas, estado: estado2.liberadas }));
        check('P3 · la operación que falló no se marca subida',
            vacF.fallos === 1 && estado2.cola.fallo === 1 && estado2.subidas === 0, json(estado2.cola));
        check('P3 · además queda fuera de la ventana caliente de 30 días (leerVentas no la devuelve)',
            ventasCalientes2.length === 0, json(ventasCalientes2.map((v) => v.id)));

        // Sesión 3: las reglas se arreglan. Ahora sí: se confirma y SOLO ENTONCES se libera.
        servidor.negar = false;
        const vacOk = await s2.motor.vaciarCola();
        const estado3 = s2.motor.estado();
        const enNube = leerDe(servidor.datos, rutaDeClave(reg.clave));
        nota('con las reglas arregladas -> ' + json(vacOk));
        nota('estado tras confirmar y liberar -> ' + json({ liberadas: estado3.liberadas, pendientes: estado3.pendientes }));
        check('P3 · al confirmarse, se marca subida y se libera de la ventana caliente',
            vacOk.subidas === 1 && vacOk.liberadas.length === 1 && estado3.liberadas === 1, json(vacOk));
        check('P3 · la liberada se va del archivo caliente pero SIGUE en la nube',
            typeof textoEnDisco(disco, 'caliente/ventas.jsonl') === 'string' &&
            textoEnDisco(disco, 'caliente/ventas.jsonl').indexOf('V-LOCAL-EQP4DDDD-0001') === -1 && !!enNube,
            String(textoEnDisco(disco, 'caliente/ventas.jsonl')));
        escenarioP3 = { servidor, disco, nav, local, db, clave: reg.clave, nodo: reg.nodo };
    }

    /* ------------------------------------------------------------------
       P4 · Dos equipos con el mismo negocio conservan las dos ventas
       ------------------------------------------------------------------ */
    titulo('P4 · Dos equipos del mismo negocio: las dos ventas se conservan (nadie pisa a nadie)');
    {
        const servidor = crearNube();
        const db = crearDbFalso(servidor);
        const navA = crearNavigatorOPFS(crearDisco());
        const navB = crearNavigatorOPFS(crearDisco());
        const A = crearEntorno({ nav: navA, local: crearLocalStorageFalso({ pos_device_id: 'AAAA1111', pos_install_id: 'AAAA' }) });
        const B = crearEntorno({ nav: navB, local: crearLocalStorageFalso({ pos_device_id: 'BBBB2222', pos_install_id: 'BBBB' }) });
        await A.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'AAAA1111', emailPath: EMAIL_PATH, db: db });
        await B.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'BBBB2222', emailPath: EMAIL_PATH, db: db });

        await A.motor.registrarOperacion('venta', venta('V-LOCAL-AAAA1111-0001', 5));
        await B.motor.registrarOperacion('venta', venta('V-LOCAL-BBBB2222-0001', 7));
        await B.motor.registrarOperacion('venta', venta('V-LOCAL-BBBB2222-0002', 9));
        await A.motor.vaciarCola();
        await B.motor.vaciarCola();
        await A.motor.vaciarCola();

        const nodos = OPS(servidor, 'venta');
        const ids = nodos.map((n) => leerDe(servidor.datos, rutaOpNodo('venta', n)).id).sort();
        nota('nube -> ops/venta: ' + json(nodos));
        nota('ids en la nube: ' + json(ids));
        check('P4 · la nube conserva LAS TRES ventas de los dos equipos', nodos.length === 3, json(nodos));
        check('P4 · con los tres ids (nadie pisó a nadie)',
            json(ids) === json(['V-LOCAL-AAAA1111-0001', 'V-LOCAL-BBBB2222-0001', 'V-LOCAL-BBBB2222-0002']), json(ids));
        check('P4 · las dos claves de B son distintas entre sí (orden de secuencia del equipo)',
            nodos.filter((n) => n.indexOf('BBBB2222_BBBB_') === 0).length === 2, json(nodos));
        check('P4 · el motor NUNCA escribe el arreglo completo en ventas/historial',
            servidor.escrituras.every((e) => e.ruta.indexOf('/ventas/historial') === -1),
            json(servidor.escrituras.map((e) => e.ruta)));
    }

    /* ------------------------------------------------------------------
       P5 · installId distinto evita la colisión de claves
       ------------------------------------------------------------------ */
    titulo('P5 · Mismo deviceId (respaldo restaurado) con installId distinto: las claves NO chocan');
    {
        const servidor = crearNube();
        const db = crearDbFalso(servidor);
        const navA = crearNavigatorOPFS(crearDisco());
        const navB = crearNavigatorOPFS(crearDisco());
        // Los dos equipos son "el mismo" (mismo deviceId y misma secuencia 1), pero
        // son instalaciones distintas: el installId los separa.
        const A = crearEntorno({ nav: navA, local: crearLocalStorageFalso({ pos_device_id: '7K3F9QAB', pos_install_id: 'K7M2', pos_last_sale_number: '0' }) });
        const B = crearEntorno({ nav: navB, local: crearLocalStorageFalso({ pos_device_id: '7K3F9QAB', pos_install_id: 'X9P4', pos_last_sale_number: '0' }) });
        const inA = await A.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: '7K3F9QAB', emailPath: EMAIL_PATH, db: db });
        const inB = await B.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: '7K3F9QAB', emailPath: EMAIL_PATH, db: db });

        const rA = await A.motor.registrarOperacion('venta', venta('V-LOCAL-7K3F9QAB-0001', 11));
        const rB = await B.motor.registrarOperacion('venta', venta('V-LOCAL-7K3F9QAB-0001', 22));
        await A.motor.vaciarCola();
        await B.motor.vaciarCola();

        const nodos = OPS(servidor, 'venta').sort();
        const totales = nodos.map((n) => leerDe(servidor.datos, rutaOpNodo('venta', n)).payload.totals.total).sort((a, b) => a - b);
        nota('installId de A: ' + inA.installId + ' | installId de B: ' + inB.installId);
        nota('claves de A: ' + rA.clave + ' | claves de B: ' + rB.clave);
        nota('nube -> ops/venta: ' + json(nodos));
        check('P5 · las dos claves existen en la nube (ninguna ignorada en silencio)',
            nodos.length === 2, json(nodos));
        check('P5 · la clave lleva deviceId_installId_secuencia4',
            /^7K3F9QAB_[A-Z0-9]{4}_0001$/.test(rA.clave.split('/')[1]) &&
            /^7K3F9QAB_[A-Z0-9]{4}_0001$/.test(rB.clave.split('/')[1]),
            rA.clave + ' / ' + rB.clave);
        check('P5 · los installId son distintos aunque el deviceId sea el mismo',
            inA.installId !== inB.installId && rA.clave !== rB.clave, rA.clave + ' / ' + rB.clave);
        check('P5 · las dos ventas conservan su total (las dos operaciones sobreviven)',
            json(totales) === json([11, 22]), json(totales));
    }

    /* ------------------------------------------------------------------
       P6 · Verificación posterior a la liberación (48 h)
       ------------------------------------------------------------------ */
    titulo('P6 · La verificación de liberadas recientes re-sube lo que falte en la nube');
    {
        const { servidor, disco, nav, local, db, clave, nodo } = escenarioP3;
        const AHORA = T0 + 40 * DIA;
        // Alguien borra la operación de la nube DESPUÉS de que el equipo creyera que subió.
        escribirEn(servidor.datos, rutaOpNodo('venta', nodo), null);
        const antes = leerDe(servidor.datos, rutaOpNodo('venta', nodo));

        const navNuevo = crearNavigatorOPFS(disco);
        const env = crearEntorno({ disco, nav: navNuevo, local });
        const inicio = await env.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP4DDDD', emailPath: EMAIL_PATH, db: db, ahora: AHORA });
        const despues = leerDe(servidor.datos, rutaOpNodo('venta', nodo));
        nota('antes de reabrir: la clave en la nube -> ' + json(antes));
        nota('verificación al arrancar -> ' + json(inicio.verificacion));
        nota('después -> ' + json(despues && despues.id));
        check('P6 · al arrancar se detecta que la clave liberada NO estaba en la nube',
            inicio.verificacion.revisadas === 1 && inicio.verificacion.faltantes === 1, json(inicio.verificacion));
        check('P6 · y se vuelve a subir',
            inicio.verificacion.resubidas === 1 && !!despues && despues.id === 'V-LOCAL-EQP4DDDD-0001',
            json(inicio.verificacion));
        check('P6 · la re-subida es la MISMA operación (misma clave, mismo contenido)',
            despues.payload.totals.total === 30 && despues.installId === 'DDD4', json(despues));

        // Si vuelve a fallar, se avisa y NO se da por verificada.
        escribirEn(servidor.datos, rutaOpNodo('venta', nodo), null);
        servidor.negar = true;
        const env2 = crearEntorno({ disco, nav: crearNavigatorOPFS(disco), local });
        const inicio2 = await env2.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP4DDDD', emailPath: EMAIL_PATH, db: db, ahora: AHORA + 60000 });
        nota('con la nube negando otra vez -> ' + json(inicio2.verificacion));
        nota('aviso del motor -> ' + json(env2.avisos.filter((a) => a.indexOf('reverificación') !== -1 || a.indexOf('sigue sin poder') !== -1)));
        check('P6 · si la re-subida falla, se cuenta como fallida y se avisa',
            inicio2.verificacion.fallidas === 1 && inicio2.verificacion.resubidas === 0 &&
            env2.avisos.some((a) => a.indexOf('sigue sin poder subirse') !== -1), json(inicio2.verificacion));
        servidor.negar = false;
        const env3 = crearEntorno({ disco, nav: crearNavigatorOPFS(disco), local });
        const inicio3 = await env3.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP4DDDD', emailPath: EMAIL_PATH, db: db, ahora: AHORA + 120000 });
        check('P6 · al arranque siguiente se reintenta y esta vez sí sube',
            inicio3.verificacion.resubidas === 1 && !!leerDe(servidor.datos, rutaOpNodo('venta', nodo)),
            json(inicio3.verificacion));

        // A las 48 h la entrada se poda: el registro no crece sin fin.
        const env4 = crearEntorno({ disco, nav: crearNavigatorOPFS(disco), local });
        const inicio4 = await env4.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP4DDDD', emailPath: EMAIL_PATH, db: db, ahora: AHORA + 49 * 60 * 60 * 1000 });
        nota('49 h después -> ' + json({ verificacion: inicio4.verificacion, liberadas: env4.motor.estado().liberadas }));
        check('P6 · pasadas las 48 h la entrada se poda y no se vuelve a verificar',
            inicio4.verificacion.podadas === 1 && inicio4.verificacion.revisadas === 0 &&
            env4.motor.estado().liberadas === 0, json(inicio4.verificacion));
    }

    /* ------------------------------------------------------------------
       P7 · Interruptor modoSync: true (booleano) o 'operaciones' activan; lo demás no
       ------------------------------------------------------------------ */
    titulo('P7 · Interruptor modoSync: true y "operaciones" activan el motor; false, "clasico" y valores raros NO');
    {
        const servidor = crearNube();
        const disco = crearDisco();
        const local = crearLocalStorageFalso({ pos_device_id: 'EQP5EEEE', pos_last_sale_number: '5' });
        const env = crearEntorno({ disco, nav: crearNavigatorOPFS(disco), local });
        const r = await env.motor.iniciar({ modoSync: 'clasico', deviceId: 'EQP5EEEE', emailPath: EMAIL_PATH, db: crearDbFalso(servidor) });
        const reg = await env.motor.registrarOperacion('venta', venta('V-LOCAL-EQP5EEEE-0006', 40));
        const vac = await env.motor.vaciarCola();
        const est = env.motor.estado();
        nota('iniciar(clasico) -> ' + json(r));
        nota('registrarOperacion -> ' + json(reg) + ' | vaciarCola -> ' + json(vac));
        check('P7 · con modoSync=clasico el motor queda inactivo',
            r.ok === true && r.activo === false && r.modo === 'clasico', json(r));
        check('P7 · NO se crea ni un archivo en el disco', Object.keys(disco.archivos).length === 0, json(Object.keys(disco.archivos)));
        check('P7 · NO se genera installId en localStorage', local.getItem('pos_install_id') === null, String(local.getItem('pos_install_id')));
        check('P7 · NO se toca el contador de ventas', local.getItem('pos_last_sale_number') === '5', String(local.getItem('pos_last_sale_number')));
        check('P7 · registrarOperacion no hace nada', reg.ok === false && reg.clave === null, json(reg));
        check('P7 · vaciarCola no hace nada y no se escribe en la nube',
            servidor.escrituras.length === 0 && servidor.lecturas.length === 0, json(servidor.escrituras));
        check('P7 · estado() informa modo clasico y cero pendientes',
            est.modo === 'clasico' && est.activo === false && est.pendientes === 0, json(est));

        // Un valor inválido también es clásico.
        const envRoto = crearEntorno({ disco: crearDisco(), nav: crearNavigatorOPFS(crearDisco()), local: crearLocalStorageFalso({ pos_device_id: 'EQP5EEEE' }) });
        const rRoto = await envRoto.motor.iniciar({ modoSync: 'modo-que-no-existe', deviceId: 'EQP5EEEE', emailPath: EMAIL_PATH });
        check('P7 · un valor inválido del interruptor también es clasico',
            rRoto.activo === false && rRoto.modo === 'clasico', json(rRoto));

        // Sin pasar modoSync, el motor LO LEE de la nube y usa 'clasico' si falla.
        const envNube = crearEntorno({ disco: crearDisco(), nav: crearNavigatorOPFS(crearDisco()), local: crearLocalStorageFalso({ pos_device_id: 'EQP5EEEE' }) });
        const rSinNodo = await envNube.motor.iniciar({ deviceId: 'EQP5EEEE', emailPath: EMAIL_PATH, db: crearDbFalso(servidor) });
        escribirEn(servidor.datos, RAIZ + '/suscripcion/modoSync', 'operaciones');
        const envNube2 = crearEntorno({ disco: crearDisco(), nav: crearNavigatorOPFS(crearDisco()), local: crearLocalStorageFalso({ pos_device_id: 'EQP5EEEE' }) });
        const rConNodo = await envNube2.motor.iniciar({ deviceId: 'EQP5EEEE', emailPath: EMAIL_PATH, db: crearDbFalso(servidor) });
        const servidorRoto = crearNube(); servidorRoto.negarLecturas = true;
        const envFallo = crearEntorno({ disco: crearDisco(), nav: crearNavigatorOPFS(crearDisco()), local: crearLocalStorageFalso({ pos_device_id: 'EQP5EEEE' }) });
        const rFallo = await envFallo.motor.iniciar({ deviceId: 'EQP5EEEE', emailPath: EMAIL_PATH, db: crearDbFalso(servidorRoto) });
        nota('interruptor ausente -> ' + json(rSinNodo) + ' | presente -> ' + json({ activo: rConNodo.activo, modo: rConNodo.modo }) + ' | lectura rota -> ' + json(rFallo));
        check('P7 · sin el nodo del interruptor se usa clasico',
            rSinNodo.activo === false && rSinNodo.modo === 'clasico', json(rSinNodo));
        check('P7 · si el nodo dice "operaciones", el motor sí se activa',
            rConNodo.activo === true && rConNodo.modo === 'operaciones', json(rConNodo));
        check('P7 · si la lectura del interruptor falla se usa clasico (nunca por accidente)',
            rFallo.activo === false && rFallo.modo === 'clasico', json(rFallo));

        // --- El interruptor acepta DOS formas, y solo dos: el booleano `true`
        //     (cómodo en la consola de Firebase, igual que `cloudSync`) y la cadena
        //     'operaciones' (forma canónica, con sitio para futuros modos). Todo lo
        //     demás —false, 'clasico', un número, un texto distinto, ausente o un
        //     fallo de lectura— es SIEMPRE clásico: nunca se activa por accidente.
        async function arranqueConInterruptor(nombre, preparar, extra) {
            const servidorI = crearNube();
            if (preparar) preparar(servidorI);
            const discoI = crearDisco();
            const localI = crearLocalStorageFalso({ pos_device_id: 'EQP5EEEE' });
            const envI = crearEntorno({ disco: discoI, nav: crearNavigatorOPFS(discoI), local: localI });
            const rI = await envI.motor.iniciar(Object.assign(
                { deviceId: 'EQP5EEEE', emailPath: EMAIL_PATH, db: crearDbFalso(servidorI) }, extra || {}));
            nota('interruptor ' + nombre + ' -> ' + json({ activo: rI.activo, modo: rI.modo, motivo: rI.motivo }));
            return { r: rI, disco: discoI, local: localI, servidor: servidorI };
        }

        const iBool = await arranqueConInterruptor('true (booleano)', null, { modoSync: true });
        check('P7 · modoSync booleano true SÍ activa el motor (comodidad, igual que cloudSync)',
            iBool.r.ok === true && iBool.r.activo === true && iBool.r.modo === 'operaciones', json(iBool.r));
        check('P7 · con el booleano true el motor arranca de verdad y genera installId en el equipo',
            iBool.local.getItem('pos_install_id') !== null, String(iBool.local.getItem('pos_install_id')));

        const iCadena = await arranqueConInterruptor("'operaciones' (cadena)", null, { modoSync: 'operaciones' });
        check("P7 · modoSync con la cadena 'operaciones' SÍ activa el motor (forma canónica de hoy)",
            iCadena.r.activo === true && iCadena.r.modo === 'operaciones', json(iCadena.r));

        const iNubeBool = await arranqueConInterruptor('true leído de la nube',
            (s) => escribirEn(s.datos, RAIZ + '/suscripcion/modoSync', true));
        check('P7 · el interruptor leído de la nube como booleano true también activa el motor',
            iNubeBool.r.activo === true && iNubeBool.r.modo === 'operaciones', json(iNubeBool.r));

        const iFalse = await arranqueConInterruptor('false (booleano)', null, { modoSync: false });
        const iModoClasico = await arranqueConInterruptor("'clasico' (cadena)", null, { modoSync: 'clasico' });
        const iUno = await arranqueConInterruptor('el número 1 (valor raro)', null, { modoSync: 1 });
        const iTexto = await arranqueConInterruptor("la cadena 'TRUE' (valor raro)", null, { modoSync: 'TRUE' });
        check('P7 · modoSync booleano false deja el motor INACTIVO',
            iFalse.r.activo === false && iFalse.r.modo === 'clasico', json(iFalse.r));
        check("P7 · modoSync con la cadena 'clasico' deja el motor INACTIVO",
            iModoClasico.r.activo === false && iModoClasico.r.modo === 'clasico', json(iModoClasico.r));
        check('P7 · un valor raro (el número 1) es clásico',
            iUno.r.activo === false && iUno.r.modo === 'clasico', json(iUno.r));
        check("P7 · un valor raro (la cadena 'TRUE') es clásico",
            iTexto.r.activo === false && iTexto.r.modo === 'clasico', json(iTexto.r));

        const inactivos = [['false', iFalse], ["'clasico'", iModoClasico], ['el número 1', iUno], ["'TRUE'", iTexto]];
        check('P7 · con el modo clásico NO se ejecuta ni una línea del motor (ni disco, ni installId, ni red)',
            inactivos.every(([, x]) => x.r.activo === false && x.r.modo === 'clasico' &&
                Object.keys(x.disco.archivos).length === 0 &&
                x.local.getItem('pos_install_id') === null &&
                x.servidor.escrituras.length === 0 && x.servidor.lecturas.length === 0),
            json(inactivos.map(([n, x]) => ({
                n, activo: x.r.activo, archivos: Object.keys(x.disco.archivos).length,
                installId: x.local.getItem('pos_install_id'), lecturas: x.servidor.lecturas.length
            }))));

        // El POS REAL también tiene que entender el booleano: si su propia puerta
        // (`leerModoSyncNube`, la que decide si se llega a llamar al motor) solo
        // aceptara la cadena, el dueño pondría `true` en la consola y no pasaría NADA.
        const servidorPosBool = crearNube();
        escribirEn(servidorPosBool.datos, 'BBDD/cliente_at_ejemplo_com/suscripcion/cloudSync', true);
        escribirEn(servidorPosBool.datos, 'BBDD/cliente_at_ejemplo_com/suscripcion/modoSync', true);
        const posBool = crearEntornoPOS({
            servidor: servidorPosBool,
            localInicial: { pos_device_id: 'POS5EEEE', pos_last_sale_number: '0' }
        });
        const modoPosBool = await posBool.ctx.esperarModoSync();
        const activoPosBool = (modoPosBool === 'operaciones') ? await posBool.ctx.asegurarMotorOps() : false;
        nota('POS real con modoSync booleano true -> modo: ' + modoPosBool + ' | motor: ' + activoPosBool);
        check('P7 · el POS real acepta modoSync booleano true y llega a arrancar el motor',
            modoPosBool === 'operaciones' && activoPosBool === true, json({ modoPosBool, activoPosBool }));

        // --- Invariantes del POS: el motor solo se usa con el interruptor en operaciones ---
        const pos = fs.readFileSync(RUTA_POS, 'utf8').replace(/\r\n/g, '\n');
        const iProc = pos.indexOf('async function processSale()');
        const bloqueProc = pos.slice(iProc, pos.indexOf('function calculateSaleTotals()'));
        const iRegistro = bloqueProc.indexOf("registrarOperacion('venta'");
        const iClasico = bloqueProc.indexOf('fbSaveVentas(ventas)');
        check('P7 · el POS carga motor_operaciones.js', /<script[^>]+src=["']motor_operaciones\.js["']/.test(pos));
        check('P7 · en processSale la venta se registra como operación y la subida clásica queda detrás del interruptor',
            iRegistro !== -1 && iClasico !== -1 && iRegistro < iClasico && bloqueProc.indexOf('modoOperacionesActivo()') !== -1,
            json({ iRegistro, iClasico }));
        check('P7 · el POS conserva las marcas de Fase A del módulo pos (no rompe la regresión)',
            pos.indexOf("marcarPendienteSync('pos')") !== -1 && pos.indexOf("limpiarPendienteSync('pos')") !== -1);
        check('P7 · la subida clásica de la venta NO se ejecuta cuando el motor está activo',
            /if \(subirClasico\) \{[\s\S]*?fbSaveVentas\(ventas\)/.test(bloqueProc), bloqueProc.slice(0, 40));

        // La garantía dura: NINGUNA subida del arreglo completo puede quedar sin la
        // guardia del motor delante. Si alguien añade una cuarta llamada a
        // fbSaveVentas(ventas) sin guardia, esta prueba falla y lo delata.
        const sitiosClasicos = [
            ['processSale', 'async function processSale()'],
            ['uploadToFirebase', 'async function uploadToFirebase()'],
            ['setupConnectionMonitor', 'async function setupConnectionMonitor(db)']
        ];
        sitiosClasicos.forEach(([nombre, firma]) => {
            const blq = bloqueDeFuncion(pos, firma);
            const iClasica = blq.indexOf('fbSaveVentas(ventas)');
            const iGuardia = blq.indexOf('modoOperacionesActivo()');
            check('P7 · ' + nombre + ': la subida del arreglo completo está detrás del interruptor del motor',
                iClasica !== -1 && iGuardia !== -1 && iGuardia < iClasica, json({ nombre, iClasica, iGuardia }));
        });
        const totalClasicas = (pos.match(/fbSaveVentas\(ventas\)/g) || []).length;
        check('P7 · solo hay 3 sitios que suben el arreglo completo (los tres con guardia)',
            totalClasicas === 3, String(totalClasicas));
    }

    /* ------------------------------------------------------------------
       P8 · Histórico antiguo: paginado y sin reescribir
       ------------------------------------------------------------------ */
    titulo('P8 · El histórico viejo se lee paginado de ventas/historial y NO se reescribe');
    {
        const servidor = crearNube();
        const base = Date.parse('2025-11-01T10:00:00.000Z');
        const historial = [];
        for (let i = 1; i <= 5; i++) {
            historial.push(venta('V-LOCAL-VIEJO111-000' + i, i * 10, { timestamp: new Date(base + i * DIA).toISOString() }));
        }
        // Además, una venta fuera del rango pedido.
        historial.push(venta('V-LOCAL-VIEJO111-0009', 999, { timestamp: new Date(base - 30 * DIA).toISOString() }));
        escribirEn(servidor.datos, RUTA_HISTORIAL, historial);
        const copiaAntes = JSON.stringify(leerDe(servidor.datos, RUTA_HISTORIAL));

        const disco = crearDisco();
        const env = crearEntorno({ disco, nav: crearNavigatorOPFS(disco), local: crearLocalStorageFalso({ pos_device_id: 'EQP6FFFF', pos_install_id: 'FFF6' }) });
        await env.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP6FFFF', emailPath: EMAIL_PATH, db: crearDbFalso(servidor) });
        const escriturasAntes = servidor.escrituras.length;
        const desde = new Date(base + 0.5 * DIA).toISOString();
        const hasta = new Date(base + 5.5 * DIA).toISOString();
        const res = await env.motor.leerHistoricoAntiguo(desde, hasta, { tamanoPagina: 2 });
        const copiaDespues = JSON.stringify(leerDe(servidor.datos, RUTA_HISTORIAL));
        const consultas = servidor.consultas.filter((c) => c.ruta === RUTA_HISTORIAL);

        nota('histórico en la nube: ' + historial.length + ' ventas (una fuera del rango pedido)');
        nota('resultado -> ' + json({ ok: res.ok, modo: res.modo, paginas: res.paginas, lecturas: res.lecturas, total: res.total, ids: res.ventas.map((v) => v.id) }));
        nota('consultas paginadas -> ' + json(consultas));
        nota('escrituras a ventas/historial -> ' + servidor.escrituras.filter((e) => e.ruta === RUTA_HISTORIAL).length);

        check('P8 · se lee paginado (varias consultas con limitToLast, no el nodo entero de una vez)',
            res.ok === true && res.modo === 'paginado' && res.paginas >= 3 &&
            consultas.length >= 3 && consultas.every((c) => c.limitToLast === 2 && c.campo === 'timestamp'),
            json({ paginas: res.paginas, consultas }));
        check('P8 · devuelve solo las ventas del rango pedido, en orden',
            res.total === 5 && json(res.ventas.map((v) => v.id)) ===
            json(['V-LOCAL-VIEJO111-0001', 'V-LOCAL-VIEJO111-0002', 'V-LOCAL-VIEJO111-0003', 'V-LOCAL-VIEJO111-0004', 'V-LOCAL-VIEJO111-0005']),
            json(res.ventas.map((v) => v.id)));
        check('P8 · las ventas de fuera del rango no se cuelan',
            res.ventas.every((v) => v.id !== 'V-LOCAL-VIEJO111-0009'), json(res.ventas.map((v) => v.id)));
        check('P8 · ventas/historial NO se reescribe (congelado: solo se lee)',
            copiaAntes === copiaDespues && servidor.escrituras.length === escriturasAntes &&
            servidor.escrituras.every((e) => e.ruta !== RUTA_HISTORIAL),
            json({ escrituras: servidor.escrituras.length, igual: copiaAntes === copiaDespues }));
        check('P8 · el histórico leído no llena la ventana caliente del equipo',
            (await env.motor.leerVentas(3650)).length === 0 &&
            textoEnDisco(disco, 'caliente/ventas.jsonl') === null,
            String(textoEnDisco(disco, 'caliente/ventas.jsonl')));
        // Con paginado apagado (por si el SDK no trae consultas) sigue funcionando.
        const res2 = await env.motor.leerHistoricoAntiguo(desde, hasta, { paginado: false, tamanoPagina: 2 });
        check('P8 · sin consultas disponibles se pagina en memoria y da el mismo resultado',
            res2.total === 5 && res2.modo === 'memoria' && json(res2.ventas.map((v) => v.id)) === json(res.ventas.map((v) => v.id)),
            json({ modo: res2.modo, total: res2.total }));
    }

    /* ------------------------------------------------------------------
       P9 · Caída automática de OPFS a IndexedDB
       ------------------------------------------------------------------ */
    titulo('P9 · Sin OPFS, el motor cae a IndexedDB manteniendo la misma API');
    {
        const servidor = crearNube();
        const db = crearDbFalso(servidor);
        const local = crearLocalStorageFalso({ pos_device_id: 'EQP7GGGG', pos_install_id: 'GGG7' });
        const env = crearEntorno({ nav: crearNavigatorOPFS(crearDisco(), { sinOPFS: true }), local, indexedDB: crearIndexedDBFalso() });
        const inicio = await env.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP7GGGG', emailPath: EMAIL_PATH, db: db });
        const reg = await env.motor.registrarOperacion('venta', venta('V-LOCAL-EQP7GGGG-0001', 15));
        const vac = await env.motor.vaciarCola();
        const est = env.motor.estado();
        nota('iniciar sin OPFS -> ' + json({ activo: inicio.activo, almacen: inicio.almacen, motivo: inicio.motivo }));
        nota('registro y vaciado -> ' + json(reg) + ' / ' + json(vac));
        check('P9 · el motor arranca igual, con almacén IndexedDB', inicio.activo === true && inicio.almacen === 'indexeddb', json(inicio));
        check('P9 · la operación se encola, se sube y no queda pendiente',
            reg.ok === true && vac.subidas === 1 && est.pendientes === 0, json({ reg, vac, est }));
        check('P9 · la ventana caliente funciona igual sobre IndexedDB',
            (await env.motor.leerVentas(30)).length === 1, json((await env.motor.leerVentas(30)).map((v) => v.id)));
        // Y sobrevive a "cerrar el navegador": los datos están en IndexedDB, no en memoria.
        const env2 = crearEntorno({ nav: crearNavigatorOPFS(crearDisco(), { sinOPFS: true }), local, indexedDB: crearIndexedDBFalso() });
        const inicio2 = await env2.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP7GGGG', emailPath: EMAIL_PATH, db: db });
        const calientes = await env2.motor.leerVentas(30);
        nota('tras reabrir sobre IndexedDB -> ' + json({ pendientes: inicio2.pendientes, ventas: calientes.map((v) => v.id) }));
        check('P9 · al reabrir, la ventana caliente sigue en IndexedDB',
            calientes.length === 1 && calientes[0].id === 'V-LOCAL-EQP7GGGG-0001', json(calientes.map((v) => v.id)));
    }

    /* ------------------------------------------------------------------
       P10 · Sin ningún almacén durable: no se finge durabilidad
       ------------------------------------------------------------------ */
    titulo('P10 · Sin OPFS ni IndexedDB el motor NO arranca (la página debe seguir en clásico)');
    {
        const servidor = crearNube();
        const env = crearEntorno({
            nav: crearNavigatorOPFS(crearDisco(), { sinOPFS: true }),
            local: crearLocalStorageFalso({ pos_device_id: 'EQP8HHHH' }),
            indexedDB: undefined
        });
        const r = await env.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQP8HHHH', emailPath: EMAIL_PATH, db: crearDbFalso(servidor) });
        nota('iniciar -> ' + json(r));
        check('P10 · sin almacén durable no se activa y se informa el motivo',
            r.ok === false && r.activo === false && r.motivo === 'sin-almacen-durable', json(r));
        check('P10 · tampoco se genera installId ni se escribe nada',
            env.local.getItem('pos_install_id') === null && servidor.escrituras.length === 0);
    }

    /* ------------------------------------------------------------------
       P11 · El POS real de punta a punta (processSale en los dos modos)
       ------------------------------------------------------------------ */
    titulo('P11 · POS real (processSale): en clásico hace exactamente lo de hoy; en operaciones va a la cola');
    {
        const EMAIL_POS = 'cliente_at_ejemplo_com';
        const RAIZ_POS = 'BBDD/' + EMAIL_POS;
        const RUTA_HIST_POS = RAIZ_POS + '/ventas/historial';
        const inventario = JSON.stringify([{ id: 'P1', name: 'Harina PAN', price: 2, stock: 10 }]);
        const archivosMotor = (disco) => Object.keys(disco.archivos).filter((k) => k.indexOf('dir:') !== 0);

        // ---------- (a) cliente en modo clásico ----------
        const servidorA = crearNube();
        escribirEn(servidorA.datos, RAIZ_POS + '/suscripcion/cloudSync', true);
        escribirEn(servidorA.datos, RAIZ_POS + '/suscripcion/modoSync', 'clasico');
        const A = crearEntornoPOS({
            servidor: servidorA,
            localInicial: { pos_device_id: 'POS1AAAA', pos_last_sale_number: '0', ciervo_inventory: inventario }
        });
        const modoA = await A.ctx.esperarModoSync();
        const opsA = (modoA === 'operaciones') ? await A.ctx.asegurarMotorOps() : false;   // igual que el arranque del POS
        A.prepararVenta();
        await A.ctx.processSale();
        // La subida clásica NO se espera dentro de processSale (igual que hoy), así
        // que se le da un turno para que la promesa de .set() resuelva.
        await new Promise((r) => setTimeout(r, 20));
        const ventasNubeA = leerDe(servidorA.datos, RUTA_HIST_POS);
        const opsEnA = Object.keys(leerDe(servidorA.datos, RAIZ_POS + '/ops/venta') || {});
        const escriturasHistA = servidorA.escrituras.filter((e) => e.ruta === RUTA_HIST_POS).length;
        nota('modo detectado -> ' + modoA + ' | motor arrancado -> ' + opsA);
        nota('nube ventas/historial -> ' + json(ventasNubeA && ventasNubeA.map((v) => v.id)));
        nota('ops/venta -> ' + json(opsEnA) + ' | archivos del motor en el equipo -> ' + json(archivosMotor(A.disco)));
        nota('marcas de Fase A -> ' + json(A.marcas.llamadas));
        if (A.dbg.processSaleError) nota('[diagnóstico] error capturado por processSale -> ' + A.dbg.processSaleError.split('\n')[0]);
        check('P11 · en clásico el motor NO se arranca (ni un archivo, ni installId)',
            modoA === 'clasico' && opsA === false && archivosMotor(A.disco).length === 0 &&
            A.local.getItem('pos_install_id') === null,
            json({ modoA, opsA, archivos: archivosMotor(A.disco), installId: A.local.getItem('pos_install_id') }));
        check('P11 · la venta se sube como SIEMPRE: arreglo completo a ventas/historial',
            Array.isArray(ventasNubeA) && ventasNubeA.length === 1 &&
            String(ventasNubeA[0].id).indexOf('V-LOCAL-POS1AAAA-') === 0 && escriturasHistA === 1,
            json({ ventasNubeA, escriturasHistA }));
        check('P11 · NO se escribe ninguna operación en ops/*',
            opsEnA.length === 0 && !servidorA.escrituras.some((e) => e.ruta.indexOf('/ops/') !== -1), json(opsEnA));
        check('P11 · la marca de pendiente de Fase A se sigue poniendo y limpiando igual',
            A.marcas.llamadas.indexOf('marcar:pos') !== -1 && A.marcas.llamadas.indexOf('limpiar:pos') !== -1,
            json(A.marcas.llamadas));
        check('P11 · la venta queda en pos_sales (nada cambió para el cliente clásico)',
            (JSON.parse(A.local.getItem('pos_sales') || '[]') || []).length === 1,
            String(A.local.getItem('pos_sales')).slice(0, 120));

        // ---------- (b) cliente en modo operaciones ----------
        const servidorB = crearNube();
        escribirEn(servidorB.datos, RAIZ_POS + '/suscripcion/cloudSync', true);
        escribirEn(servidorB.datos, RAIZ_POS + '/suscripcion/modoSync', 'operaciones');
        const B = crearEntornoPOS({
            servidor: servidorB,
            localInicial: { pos_device_id: 'POS2BBBB', pos_last_sale_number: '0', ciervo_inventory: inventario }
        });
        const modoB = await B.ctx.esperarModoSync();
        const opsB = (modoB === 'operaciones') ? await B.ctx.asegurarMotorOps() : false;
        B.prepararVenta();
        await B.ctx.processSale();
        await B.ctx.window.motorOperaciones.vaciarCola();      // lo que hace el arranque/reconexión
        const opsEnB = Object.keys(leerDe(servidorB.datos, RAIZ_POS + '/ops/venta') || {});
        const opB = opsEnB.length ? leerDe(servidorB.datos, RAIZ_POS + '/ops/venta/' + opsEnB[0]) : null;
        const estadoB = B.ctx.window.motorOperaciones.estado();
        const calientesB = await B.ctx.window.motorOperaciones.leerVentas(30);
        const escriturasHistB = servidorB.escrituras.filter((e) => e.ruta === RUTA_HIST_POS).length;
        const installB = B.local.getItem('pos_install_id');
        nota('modo detectado -> ' + modoB + ' | motor arrancado -> ' + opsB + ' | installId -> ' + installB);
        nota('nube ops/venta -> ' + json(opsEnB));
        nota('estado del motor -> ' + json({ modo: estadoB.modo, pendientes: estadoB.pendientes, subidas: estadoB.subidas, almacen: estadoB.almacen }));
        nota('archivos del motor -> ' + json(archivosMotor(B.disco)));
        nota('ventas/historial escrito en modo operaciones -> ' + escriturasHistB);
        check('P11 · en operaciones el motor arranca y la venta se encola y se sube como operación',
            modoB === 'operaciones' && opsB === true && opsEnB.length === 1 &&
            /^POS2BBBB_[A-Z0-9]{4}_0001$/.test(opsEnB[0]) && estadoB.pendientes === 0 && estadoB.subidas >= 1,
            json({ modoB, opsB, opsEnB, estadoB }));
        check('P11 · NUNCA se sube el arreglo completo: ventas/historial no se toca en modo operaciones',
            escriturasHistB === 0 && leerDe(servidorB.datos, RUTA_HIST_POS) === null, String(escriturasHistB));
        check('P11 · la operación lleva el saleData completo y su secuencia coincide con el id de la venta',
            !!opB && opB.secuencia === 1 && opB.payload.id === opB.id &&
            String(opB.id).indexOf('V-LOCAL-POS2BBBB-') === 0 && opB.payload.items.length === 1 &&
            opB.payload.totals.total === 2 && opB.installId === installB,
            json(opB));
        check('P11 · la cola durable existe en el equipo y la ventana caliente tiene la venta',
            archivosMotor(B.disco).indexOf('cola.jsonl') !== -1 &&
            archivosMotor(B.disco).indexOf('caliente/ventas.jsonl') !== -1 &&
            calientesB.length === 1 && calientesB[0].id === opB.id,
            json({ archivos: archivosMotor(B.disco), calientes: calientesB.map((v) => v.id) }));
    }

    /* ------------------------------------------------------------------
       P12 · Permiso de nube (cloudSync): sin permiso, el motor es SOLO-LOCAL
       ------------------------------------------------------------------ */
    titulo('P12 · cloudSync: el motor solo sube si el cliente tiene permiso de nube');
    {
        const ANTIGUO = Date.parse('2026-02-14T12:00:00.000Z');

        /* ---------- (a) cloudSync:false + modo 'operaciones' -> SOLO-LOCAL ---------- */
        const servidorA = crearNube();
        const discoA = crearDisco();
        const localA = crearLocalStorageFalso({ pos_device_id: 'EQP9IIII', pos_install_id: 'III9' });
        const envA = crearEntorno({ disco: discoA, nav: crearNavigatorOPFS(discoA), local: localA });
        const inicioA = await envA.motor.iniciar({ cloudSync: false, modoSync: 'operaciones', deviceId: 'EQP9IIII', emailPath: EMAIL_PATH, db: crearDbFalso(servidorA) });
        const regA = await envA.motor.registrarOperacion('venta', venta('V-LOCAL-EQP9IIII-0001', 30));
        const vacA = await envA.motor.vaciarCola();
        const estA = envA.motor.estado();
        const calientesA = await envA.motor.leerVentas(30);
        nota('iniciar(cloudSync:false) -> ' + json(inicioA));
        nota('registrar -> ' + json(regA) + ' | vaciarCola -> ' + json(vacA));
        nota('escrituras en la nube -> ' + json(servidorA.escrituras.map((e) => e.ruta)));
        nota('estado -> ' + json({ nube: estA.nube, modoLocal: estA.modoLocal, pendientes: estA.pendientes, subidas: estA.subidas }));
        check('P12 · con cloudSync:false el motor arranca igual, pero SIN nube y en modo local',
            inicioA.activo === true && inicioA.modo === 'operaciones' &&
            inicioA.nube === false && inicioA.modoLocal === true, json(inicioA));
        check('P12 · la venta se encola y se puede cobrar (ventana caliente + leerVentas)',
            regA.ok === true && regA.clave === 'venta/EQP9IIII_III9_0001' &&
            calientesA.length === 1 && calientesA[0].id === 'V-LOCAL-EQP9IIII-0001',
            json({ regA, calientes: calientesA.map((v) => v.id) }));
        check('P12 · vaciarCola NO escribe NADA en la nube y devuelve motivo "sin-nube"',
            vacA.motivo === 'sin-nube' && vacA.intentadas === 0 && vacA.subidas === 0 &&
            servidorA.escrituras.length === 0 && OPS(servidorA, 'venta').length === 0,
            json({ vacA, escrituras: servidorA.escrituras.map((e) => e.ruta) }));
        check('P12 · la operación sigue PENDIENTE (no se pierde ni se libera)',
            vacA.pendientes === 1 && estA.pendientes === 1 && estA.subidas === 0 &&
            estA.confirmadas === 0 && envA.motor.hayPendientes() === true, json(estA));
        check('P12 · estado() refleja la realidad: nube=false y modoLocal=true',
            estA.nube === false && estA.modoLocal === true, json({ nube: estA.nube, modoLocal: estA.modoLocal }));
        check('P12 · el histórico congelado tampoco se toca (ni ventas/historial ni índices)',
            leerDe(servidorA.datos, RUTA_HISTORIAL) === null &&
            !servidorA.escrituras.some((e) => e.ruta.indexOf('/ventas_idx/') !== -1),
            json(servidorA.escrituras.map((e) => e.ruta)));

        /* ---------- (b) el permiso se concede después: nada se perdió ---------- */
        // La nube pasa a decir cloudSync:true y el equipo arranca otra vez (sin
        // pasar cloudSync: se LEE de la nube, el otro camino de la costura).
        escribirEn(servidorA.datos, RAIZ + '/suscripcion/cloudSync', true);
        const envA2 = crearEntorno({ disco: discoA, nav: crearNavigatorOPFS(discoA), local: localA });
        const inicioA2 = await envA2.motor.iniciar({ modoSync: 'operaciones', deviceId: 'EQP9IIII', emailPath: EMAIL_PATH, db: crearDbFalso(servidorA) });
        const vacA2 = await envA2.motor.vaciarCola();
        nota('2º arranque con cloudSync:true en la nube -> ' +
            json({ activo: inicioA2.activo, nube: inicioA2.nube, modoLocal: inicioA2.modoLocal, pendientes: inicioA2.pendientes }) +
            ' | vaciado -> ' + json(vacA2));
        check('P12 · sin pasar cloudSync, el motor lo LEE de la nube y sube la cola que quedó pendiente',
            inicioA2.activo === true && inicioA2.nube === true && inicioA2.modoLocal === false &&
            inicioA2.pendientes === 1 && vacA2.motivo === 'ok' && vacA2.subidas === 1 &&
            envA2.motor.estado().pendientes === 0 &&
            OPS(servidorA, 'venta').length === 1, json({ inicioA2, vacA2 }));

        /* ---------- (c) control: cloudSync:true explícito -> sube como hoy ---------- */
        const servidorC = crearNube();
        const discoC = crearDisco();
        const envC = crearEntorno({ disco: discoC, nav: crearNavigatorOPFS(discoC), local: crearLocalStorageFalso({ pos_device_id: 'EQPBIKKK', pos_install_id: 'KKKB' }) });
        const inicioC = await envC.motor.iniciar({ cloudSync: true, modoSync: 'operaciones', deviceId: 'EQPBIKKK', emailPath: EMAIL_PATH, db: crearDbFalso(servidorC) });
        const regC = await envC.motor.registrarOperacion('venta', venta('V-LOCAL-EQPBIKKK-0001', 45));
        const vacC = await envC.motor.vaciarCola();
        const estC = envC.motor.estado();
        nota('control con cloudSync:true -> ' + json({ nube: inicioC.nube, modoLocal: inicioC.modoLocal, motivo: vacC.motivo, subidas: vacC.subidas, pendientes: estC.pendientes }));
        check('P12 · con cloudSync:true el motor sube como siempre (control)',
            inicioC.nube === true && inicioC.modoLocal === false && regC.ok === true &&
            vacC.motivo === 'ok' && vacC.subidas === 1 && estC.pendientes === 0 &&
            estC.nube === true && OPS(servidorC, 'venta').length === 1,
            json({ inicioC, vacC, estC }));

        /* ---------- (d) ausente, lectura rota y valores que NO son true ---------- */
        async function arranqueSinPermiso(nombre, preparar) {
            const servidor = crearNube();
            if (preparar) preparar(servidor);
            const disco = crearDisco();
            const env = crearEntorno({
                disco, nav: crearNavigatorOPFS(disco),
                local: crearLocalStorageFalso({ pos_device_id: 'EQPCDDDD', pos_install_id: 'DDD4' })
            });
            const inicio = await env.motor.iniciar({ modoSync: 'operaciones', deviceId: 'EQPCDDDD', emailPath: EMAIL_PATH, db: crearDbFalso(servidor) });
            const reg = await env.motor.registrarOperacion('venta', venta('V-LOCAL-EQPCDDDD-0001', 60));
            const vac = await env.motor.vaciarCola();
            const est = env.motor.estado();
            nota('cloudSync ' + nombre + ' -> ' + json({ activo: inicio.activo, nube: inicio.nube, modoLocal: inicio.modoLocal, motivo: vac.motivo, escrituras: servidor.escrituras.length }));
            check('P12 · cloudSync ' + nombre + ': el motor arranca pero SIN nube (nunca al revés)',
                inicio.activo === true && inicio.nube === false && inicio.modoLocal === true &&
                reg.ok === true && vac.motivo === 'sin-nube' && vac.subidas === 0 &&
                servidor.escrituras.length === 0 && est.pendientes === 1 && est.nube === false,
                json({ inicio, vac, est, escrituras: servidor.escrituras.map((e) => e.ruta) }));
        }
        await arranqueSinPermiso('ausente', null);
        await arranqueSinPermiso('con la lectura rota', (s) => { s.negarLecturas = true; });
        await arranqueSinPermiso('con el texto "true"', (s) => escribirEn(s.datos, RAIZ + '/suscripcion/cloudSync', 'true'));
        await arranqueSinPermiso('con el número 1', (s) => escribirEn(s.datos, RAIZ + '/suscripcion/cloudSync', 1));

        /* ---------- (e) modoSync 'clasico': nada cambia (ni con cloudSync:false) ---------- */
        const servidorE = crearNube();
        const discoE = crearDisco();
        const localE = crearLocalStorageFalso({ pos_device_id: 'EQPEEEEE' });
        const envE = crearEntorno({ disco: discoE, nav: crearNavigatorOPFS(discoE), local: localE });
        const rE = await envE.motor.iniciar({ cloudSync: false, modoSync: 'clasico', deviceId: 'EQPEEEEE', emailPath: EMAIL_PATH, db: crearDbFalso(servidorE) });
        nota('iniciar(clasico + cloudSync:false) -> ' + json(rE));
        check('P12 · con modoSync:clasico no cambia absolutamente nada (ni con cloudSync:false)',
            rE.activo === false && rE.modo === 'clasico' &&
            Object.keys(discoE.archivos).length === 0 &&
            localE.getItem('pos_install_id') === null &&
            servidorE.lecturas.length === 0 && servidorE.escrituras.length === 0, json(rE));

        /* ---------- (f) la política de 1 GB sigue aplicando en SOLO-LOCAL ---------- */
        // Una venta de hace 100 días en modo solo-local: la liberación por
        // antigüedad NO puede tocarla, porque nunca se confirmó en la nube.
        const servidorF = crearNube();
        const discoF = crearDisco();
        const localF = crearLocalStorageFalso({ pos_device_id: 'EQPFFFFF', pos_install_id: 'FFF1' });
        const envF = crearEntorno({ disco: discoF, nav: crearNavigatorOPFS(discoF), local: localF });
        await envF.motor.iniciar({ cloudSync: false, modoSync: 'operaciones', deviceId: 'EQPFFFFF', emailPath: EMAIL_PATH, db: crearDbFalso(servidorF), ahora: ANTIGUO });
        await envF.motor.registrarOperacion('venta', venta('V-LOCAL-EQPFFFFF-0001', 70));
        // 100 días después el equipo arranca otra vez con el mismo disco.
        const envF2 = crearEntorno({ disco: discoF, nav: crearNavigatorOPFS(discoF), local: localF });
        await envF2.motor.iniciar({ cloudSync: false, modoSync: 'operaciones', deviceId: 'EQPFFFFF', emailPath: EMAIL_PATH, db: crearDbFalso(servidorF), ahora: ANTIGUO + 100 * DIA });
        const liberadasF = await envF2.motor.liberarCaliente();
        const vacF = await envF2.motor.vaciarCola();
        const estF = envF2.motor.estado();
        const calientesF = await envF2.motor.leerVentas(3650);
        const colaF = String(textoEnDisco(discoF, 'cola.jsonl'));
        nota('venta de hace 100 días en solo-local -> liberadas: ' + json(liberadasF.map((l) => l.clave)) + ' | vaciado: ' + json({ motivo: vacF.motivo, subidas: vacF.subidas, pendientes: vacF.pendientes }));
        nota('sigue en la ventana caliente -> ' + json(calientesF.map((v) => v.id)) + ' | estado -> ' + json({ pendientes: estF.pendientes, liberadas: estF.liberadas }));
        check('P12 · la política de 1 GB no libera por antigüedad lo que no está confirmado en la nube',
            liberadasF.length === 0 && estF.pendientes === 1 && estF.liberadas === 0 &&
            calientesF.length === 1 && calientesF[0].id === 'V-LOCAL-EQPFFFFF-0001',
            json({ liberadas: liberadasF.length, estF, calientes: calientesF.map((v) => v.id) }));
        check('P12 · tras el recorte y el vaciado la operación sigue en disco (nunca se pierde)',
            vacF.motivo === 'sin-nube' && colaF.indexOf('V-LOCAL-EQPFFFFF-0001') !== -1 &&
            servidorF.escrituras.length === 0, json({ motivo: vacF.motivo, enCola: colaF.indexOf('V-LOCAL-EQPFFFFF-0001') !== -1 }));

        /* ---------- (g) POS REAL de punta a punta: gratuito vs. cliente que paga ---------- */
        const RUTA_POS_G = 'BBDD/cliente_at_ejemplo_com';
        const RUTA_HIST_G = RUTA_POS_G + '/ventas/historial';
        const inventarioG = JSON.stringify([{ id: 'P1', name: 'Harina PAN', price: 2, stock: 10 }]);

        async function posReal(nombre, cloudSync, deviceId) {
            const servidor = crearNube();
            escribirEn(servidor.datos, RUTA_POS_G + '/suscripcion/cloudSync', cloudSync);
            escribirEn(servidor.datos, RUTA_POS_G + '/suscripcion/modoSync', 'operaciones');
            const env = crearEntornoPOS({
                servidor,
                localInicial: { pos_device_id: deviceId, pos_last_sale_number: '0', ciervo_inventory: inventarioG }
            });
            const modo = await env.ctx.esperarModoSync();
            const activo = (modo === 'operaciones') ? await env.ctx.asegurarMotorOps() : false;
            env.prepararVenta();
            await env.ctx.processSale();
            await new Promise((r) => setTimeout(r, 20));
            await env.ctx.window.motorOperaciones.vaciarCola();
            if (typeof env.ctx.actualizarPuntoEstadoOps === 'function') env.ctx.actualizarPuntoEstadoOps();
            return {
                nombre, servidor, env, modo, activo,
                estado: env.ctx.window.motorOperaciones.estado(),
                calientes: await env.ctx.window.motorOperaciones.leerVentas(30),
                punto: env.elementos['firebaseDot'] ? String(env.elementos['firebaseDot'].title) : '',
                color: env.elementos['firebaseDot'] ? String(env.elementos['firebaseDot'].style.background || '') : ''
            };
        }

        const gratuito = await posReal('cliente gratuito', false, 'POS3CCCC');
        const pagando = await posReal('cliente que paga', true, 'POS4DDDD');
        for (const r of [gratuito, pagando]) {
            nota(r.nombre + ' -> modo: ' + r.modo + ' | motor: ' + r.activo + ' | punto: "' + r.punto + '" | color: ' + r.color);
            nota('   estado -> ' + json({ nube: r.estado.nube, modoLocal: r.estado.modoLocal, pendientes: r.estado.pendientes, subidas: r.estado.subidas }) +
                ' | escrituras en la nube -> ' + json(r.servidor.escrituras.map((e) => e.ruta)));
        }
        check('P12 · POS real con cliente gratuito: arranca el motor, la venta se cobra y queda en el equipo',
            gratuito.modo === 'operaciones' && gratuito.activo === true &&
            gratuito.estado.nube === false && gratuito.estado.modoLocal === true &&
            gratuito.estado.pendientes === 1 && gratuito.calientes.length === 1,
            json({ modo: gratuito.modo, activo: gratuito.activo, estado: gratuito.estado, calientes: gratuito.calientes.map((v) => v.id) }));
        check('P12 · POS real con cliente gratuito: CERO escrituras en la nube (ni ops/*, ni índices, ni ventas/historial)',
            gratuito.servidor.escrituras.length === 0 &&
            leerDe(gratuito.servidor.datos, RUTA_HIST_G) === null &&
            Object.keys(leerDe(gratuito.servidor.datos, RUTA_POS_G + '/ops') || {}).length === 0,
            json(gratuito.servidor.escrituras.map((e) => e.ruta)));
        check('P12 · POS real con cliente gratuito: el punto de estado dice "solo en este equipo (sin nube)" y no alarma',
            gratuito.punto.indexOf('solo en este equipo (sin nube)') !== -1 &&
            !/error|no se pudo|desconectado|pendiente/i.test(gratuito.punto), gratuito.punto);
        // Sin nube no hay nada "subido y confirmado": el punto va GRIS (neutro),
        // nunca verde (verde = todo subido) ni naranja/rojo (eso sería alarma).
        check('P12 · POS real con cliente gratuito: el punto de estado es GRIS (#94a3b8), no verde',
            gratuito.color === '#94a3b8', json({ color: gratuito.color, punto: gratuito.punto }));
        // El motor no debe marcar nada como "pendiente de subir" en solo-local.
        // `updateInventory` SÍ marca 'pos' por los PRODUCTOS (Fase A, camino clásico
        // ajeno al motor), así que se limpia la marca y se refresca el punto: si el
        // motor volviera a ponerla, esta prueba lo delata.
        gratuito.env.ctx.limpiarPendienteSync('pos');
        gratuito.env.ctx.actualizarPuntoEstadoOps();
        check('P12 · POS real con cliente gratuito: el motor NO marca "pendiente" en solo-local (no hay nada que subir)',
            gratuito.env.ctx.hayPendientesSync('pos') === false &&
            String(gratuito.env.elementos['firebaseDot'].title).indexOf('solo en este equipo (sin nube)') !== -1 &&
            gratuito.env.elementos['firebaseDot'].style.background === '#94a3b8',
            json({ pendientes: gratuito.env.marcas.pendientes, punto: gratuito.env.elementos['firebaseDot'].title, color: gratuito.env.elementos['firebaseDot'].style.background }));
        check('P12 · POS real con cliente que paga: se distingue (sube, el punto dice "todo subido" y va VERDE)',
            pagando.activo === true && pagando.estado.nube === true && pagando.estado.modoLocal === false &&
            pagando.estado.pendientes === 0 && pagando.estado.subidas === 1 &&
            pagando.punto === 'Modo operaciones · todo subido' && pagando.color === '#22c55e',
            json({ activo: pagando.activo, estado: pagando.estado, punto: pagando.punto, color: pagando.color }));
    }

    /* ------------------------------------------------------------------
       P13 · El campo del interruptor se crea SOLO y nunca se pisa (extra)
       ------------------------------------------------------------------ */
    titulo('P13 · ensureUserCloudStructure crea suscripcion/modoSync = false sin pisar lo que ya exista');
    {
        const PATRON_CLOUD = 'BBDD/cliente_at_ejemplo_com';
        const EMAIL_CLOUD = 'cliente@ejemplo.com';

        /** Extrae una función del HTML: de su firma a la llave de cierre en columna 0. */
        function extraerFuncion(texto, firma) {
            const i = texto.indexOf(firma);
            if (i === -1) return '';
            const fin = texto.indexOf('\n}', i);
            return fin === -1 ? '' : texto.slice(i, fin + 2);
        }

        /** La parte de la nube falsa que usa ensureUserCloudStructure: once/child/set. */
        function crearDbCloudInit(servidor) {
            function snapshotDe(valor) {
                return {
                    val: () => clonar(valor),
                    exists: () => valor !== null && valor !== undefined,
                    child: (ruta) => snapshotDe(leerDe(valor, ruta))
                };
            }
            return {
                ref(ruta) {
                    return {
                        async once() {
                            if (servidor.negarLecturas) {
                                const e = new Error('PERMISSION_DENIED: rules denied read at ' + ruta);
                                e.code = 'PERMISSION_DENIED';
                                throw e;
                            }
                            servidor.lecturas.push(ruta);
                            return snapshotDe(leerDe(servidor.datos, ruta));
                        },
                        async set(valor) {
                            if (servidor.negar) {
                                const e = new Error('PERMISSION_DENIED: rules denied write at ' + ruta);
                                e.code = 'PERMISSION_DENIED';
                                throw e;
                            }
                            servidor.escrituras.push({ ruta, valor: clonar(valor) });
                            escribirEn(servidor.datos, ruta, valor);
                            return true;
                        }
                    };
                }
            };
        }

        /**
         * Carga la función REAL de creación de estructura de la página y la ejecuta
         * contra una nube falsa. Devuelve si compiló, si la llamada terminó sin lanzar
         * (nunca debe romper el arranque) y la nube resultante.
         */
        async function ejecutarCreacion(html, esIndex, preparar) {
            const firma = esIndex
                ? 'async function ensureUserCloudStructure(email)'
                : 'async function ensureUserCloudStructure()';
            const codigo = extraerFuncion(html, firma);
            const servidor = crearNube();
            if (preparar) preparar(servidor);
            const dbCloud = crearDbCloudInit(servidor);
            const ctx = {
                console: { log: () => {}, warn: () => {}, error: () => {} },
                JSON, Object, Array, String, Number, Boolean, Promise, Error, RegExp,
                sessionStorage: crearLocalStorageFalso(),
                db: dbCloud,
                emailToPath: (email) => String(email || '').trim().toLowerCase().replace('@', '_at_').replace(/\./g, '_'),
                getCurrentUserEmail: () => EMAIL_CLOUD,
                getUserDataPath: () => PATRON_CLOUD,
                initFirebase: async () => dbCloud
            };
            ctx.window = ctx;
            ctx.globalThis = ctx;
            vm.createContext(ctx);
            let lanzo = '';
            let compila = false;
            try {
                new vm.Script(codigo, { filename: 'ensureUserCloudStructure' });
                compila = true;
                vm.runInContext(codigo, ctx, { filename: 'ensureUserCloudStructure' });
                const llamada = esIndex
                    ? 'ensureUserCloudStructure(' + JSON.stringify(EMAIL_CLOUD) + ')'
                    : 'ensureUserCloudStructure()';
                await vm.runInContext(llamada, ctx);
            } catch (e) {
                lanzo = e.message;
            }
            return { servidor, codigo, compila, lanzo };
        }

        const PAGINAS = [
            { nombre: 'index.html', ruta: path.join(__dirname, 'index.html'), esIndex: true },
            { nombre: 'mini_market_pos.html', ruta: RUTA_POS, esIndex: false }
        ];

        for (const pagina of PAGINAS) {
            const html = fs.readFileSync(pagina.ruta, 'utf8').replace(/\r\n/g, '\n');
            const val = (servidor) => leerDe(servidor.datos, PATRON_CLOUD + '/suscripcion/modoSync');
            const valCloud = (servidor) => leerDe(servidor.datos, PATRON_CLOUD + '/suscripcion/cloudSync');

            // (a) Negocio nuevo: su nodo no existe -> se crean los DOS campos en false.
            const nuevo = await ejecutarCreacion(html, pagina.esIndex);
            check('P13 · ' + pagina.nombre + ': la función real de la página se extrae y compila',
                nuevo.codigo !== '' && nuevo.compila === true, nuevo.lanzo || nuevo.codigo.slice(0, 60));
            check('P13 · ' + pagina.nombre + ': negocio nuevo -> cloudSync = false y modoSync = false',
                valCloud(nuevo.servidor) === false && val(nuevo.servidor) === false,
                json({ cloudSync: valCloud(nuevo.servidor), modoSync: val(nuevo.servidor) }));

            // (b) El dueño YA activó el motor con el booleano: la creación NO lo pisa.
            const yaTrue = await ejecutarCreacion(html, pagina.esIndex, (s) => {
                escribirEn(s.datos, PATRON_CLOUD + '/suscripcion/cloudSync', true);
                escribirEn(s.datos, PATRON_CLOUD + '/suscripcion/modoSync', true);
            });
            check('P13 · ' + pagina.nombre + ': modoSync = true ya presente -> sigue siendo el booleano true',
                val(yaTrue.servidor) === true, json(val(yaTrue.servidor)));
            check('P13 · ' + pagina.nombre + ': con todo ya creado la función no escribe NADA (cero set)',
                yaTrue.servidor.escrituras.length === 0, json(yaTrue.servidor.escrituras));

            // (c) Forma canónica (cadena): tampoco se pisa.
            const yaCadena = await ejecutarCreacion(html, pagina.esIndex, (s) => {
                escribirEn(s.datos, PATRON_CLOUD + '/suscripcion/cloudSync', false);
                escribirEn(s.datos, PATRON_CLOUD + '/suscripcion/modoSync', 'operaciones');
            });
            check('P13 · ' + pagina.nombre + ': la cadena operaciones ya presente -> sigue siendo la cadena',
                val(yaCadena.servidor) === 'operaciones' && yaCadena.servidor.escrituras.length === 0,
                json({ valor: val(yaCadena.servidor), escrituras: yaCadena.servidor.escrituras.length }));

            // (d) Un false explícito ya guardado: se respeta (no se reescribe).
            const yaFalse = await ejecutarCreacion(html, pagina.esIndex, (s) => {
                escribirEn(s.datos, PATRON_CLOUD + '/suscripcion/cloudSync', false);
                escribirEn(s.datos, PATRON_CLOUD + '/suscripcion/modoSync', false);
            });
            check('P13 · ' + pagina.nombre + ': un false ya guardado se respeta (cero escrituras)',
                val(yaFalse.servidor) === false && yaFalse.servidor.escrituras.length === 0,
                json({ valor: val(yaFalse.servidor), escrituras: yaFalse.servidor.escrituras.length }));

            // (e) Usuario antiguo: tiene nodo y cloudSync, pero le falta el interruptor.
            const antiguo = await ejecutarCreacion(html, pagina.esIndex, (s) => {
                escribirEn(s.datos, PATRON_CLOUD + '/suscripcion/cloudSync', true);
            });
            check('P13 · ' + pagina.nombre + ': usuario antiguo sin el campo -> se le crea modoSync = false',
                val(antiguo.servidor) === false && valCloud(antiguo.servidor) === true,
                json({ cloudSync: valCloud(antiguo.servidor), modoSync: val(antiguo.servidor) }));

            // (f) Lectura rota: no rompe nada y no escribe (el motor, ante duda, clásico).
            const roto = await ejecutarCreacion(html, pagina.esIndex, (s) => { s.negarLecturas = true; });
            check('P13 · ' + pagina.nombre + ': si la lectura falla no rompe el arranque ni escribe',
                roto.compila === true && roto.lanzo === '' && roto.servidor.escrituras.length === 0,
                json({ lanzo: roto.lanzo, escrituras: roto.servidor.escrituras.length }));

            // (g) Reglas que niegan la escritura: el try/catch de la función lo absorbe.
            const negado = await ejecutarCreacion(html, pagina.esIndex, (s) => { s.negar = true; });
            check('P13 · ' + pagina.nombre + ': si las reglas niegan la escritura, la función no revienta',
                negado.compila === true && negado.lanzo === '', negado.lanzo);
        }
    }

    console.log('\n================ ' + ok + ' OK, ' + fallos + ' FALLAS ================');
    if (fallos === 0) {
        console.log('El motor real (motor_operaciones.js) supera los 8 casos obligatorios + 4 extra,');
        console.log('incluido el POS real (processSale) cargado en un vm con OPFS y Firebase falsos.');
        console.log('P12 cubre el permiso de nube (cloudSync): sin permiso, el motor es solo-local y no');
        console.log('escribe NADA en la nube (ni ops/*, ni índices, ni ventas/historial).');
        console.log('P13 comprueba que suscripcion/modoSync se crea solo en false y que NUNCA');
        console.log('se pisa lo que ya exista (ni el booleano true ni la cadena operaciones).');
        console.log('Recordatorio: los mocks de OPFS/IndexedDB/Firebase reproducen la semántica del');
        console.log('navegador y del SDK v8; NO prueban un corte de energía ni dos pestañas a la vez.');
    }
    process.exit(fallos === 0 ? 0 : 1);
})();
