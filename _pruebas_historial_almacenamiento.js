/**
 * _pruebas_historial_almacenamiento.js
 *
 * Pruebas del archivo histórico en IndexedDB y de la política de límite local
 * añadidos a `almacenamiento.js`. No necesita navegador ni Firebase: usa un
 * localStorage falso y un IndexedDB falso en un sandbox de `vm`.
 *
 * Uso:  node _pruebas_historial_almacenamiento.js
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
/* 1. Sintaxis: new vm.Script(...)                                    */
/* ------------------------------------------------------------------ */

function scriptsEnLinea(html) {
    const salida = [];
    const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) salida.push(m[1]);
    return salida;
}

function probarSintaxis() {
    titulo('1. Sintaxis (new vm.Script)');
    try {
        const codigo = fs.readFileSync(path.join(RAIZ, 'almacenamiento.js'), 'utf8');
        new vm.Script(codigo, { filename: 'almacenamiento.js' });
        check('almacenamiento.js compila sin errores de sintaxis', true);
    } catch (e) {
        check('almacenamiento.js compila sin errores de sintaxis — ' + e.message, false);
    }

    ['config.html', 'mini_market_pos.html'].forEach(function (archivo) {
        try {
            const html = fs.readFileSync(path.join(RAIZ, archivo), 'utf8');
            const bloques = scriptsEnLinea(html);
            bloques.forEach(function (bloque, indice) {
                new vm.Script(bloque, { filename: archivo + '#script' + (indice + 1) });
            });
            check(archivo + ': ' + bloques.length + ' bloque(s) <script> en línea compilan', bloques.length > 0);
        } catch (e) {
            check(archivo + ': sus <script> en línea compilan — ' + e.message, false);
        }
    });
}

/* ------------------------------------------------------------------ */
/* 2. localStorage falso                                              */
/* ------------------------------------------------------------------ */

function crearLocalStorageFalso(inicial) {
    const datos = new Map();
    if (inicial) {
        Object.keys(inicial).forEach(function (k) { datos.set(String(k), String(inicial[k])); });
    }
    const almacen = {
        getItem: function (k) { k = String(k); return datos.has(k) ? datos.get(k) : null; },
        setItem: function (k, v) { datos.set(String(k), String(v)); },
        removeItem: function (k) { datos.delete(String(k)); },
        clear: function () { datos.clear(); },
        key: function (i) { const claves = Array.from(datos.keys()); return (i >= 0 && i < claves.length) ? claves[i] : null; },
        _datos: datos
    };
    Object.defineProperty(almacen, 'length', { get: function () { return datos.size; } });
    return almacen;
}

/* ------------------------------------------------------------------ */
/* 3. IndexedDB falso (open/onupgradeneeded/transaction/objectStore/  */
/*    put/getAll/count/delete/createObjectStore)                      */
/* ------------------------------------------------------------------ */

function crearBaseFalsa(nombre, version) {
    const almacenes = new Map();

    function crearStoreFalso(def, tx) {
        function programar(fn) {
            tx._pendientes++;
            setTimeout(function () {
                try { fn(); } catch (e) { /* el error se reporta por la petición */ }
                tx._pendientes--;
                if (tx._pendientes === 0 && !tx._cerrado) {
                    tx._cerrado = true;
                    setTimeout(function () {
                        if (typeof tx.oncomplete === 'function') tx.oncomplete({ target: tx });
                    }, 0);
                }
            }, 0);
        }
        function peticion() {
            return { result: undefined, error: null, onsuccess: null, onerror: null };
        }
        return {
            get keyPath() { return def.keyPath; },
            put: function (registro) {
                const p = peticion();
                programar(function () {
                    const clave = (registro && typeof registro === 'object') ? registro[def.keyPath] : undefined;
                    if (clave === undefined || clave === null) {
                        p.error = new Error('sin clave primaria');
                        if (p.onerror) p.onerror({ target: p });
                        return;
                    }
                    def.datos.set(String(clave), JSON.parse(JSON.stringify(registro)));
                    p.result = clave;
                    if (p.onsuccess) p.onsuccess({ target: p });
                });
                return p;
            },
            delete: function (clave) {
                const p = peticion();
                programar(function () {
                    def.datos.delete(String(clave));
                    p.result = undefined;
                    if (p.onsuccess) p.onsuccess({ target: p });
                });
                return p;
            },
            getAll: function () {
                const p = peticion();
                programar(function () {
                    p.result = Array.from(def.datos.values()).map(function (v) { return JSON.parse(JSON.stringify(v)); });
                    if (p.onsuccess) p.onsuccess({ target: p });
                });
                return p;
            },
            count: function () {
                const p = peticion();
                programar(function () {
                    p.result = def.datos.size;
                    if (p.onsuccess) p.onsuccess({ target: p });
                });
                return p;
            }
        };
    }

    return {
        name: nombre,
        version: version,
        objectStoreNames: {
            contains: function (n) { return almacenes.has(n); },
            get length() { return almacenes.size; },
            item: function (i) { return Array.from(almacenes.keys())[i] || null; }
        },
        createObjectStore: function (nombreAlmacen, opciones) {
            almacenes.set(nombreAlmacen, {
                keyPath: (opciones && opciones.keyPath) || 'id',
                datos: new Map()
            });
            return null;
        },
        transaction: function (nombreAlmacen) {
            const def = almacenes.get(nombreAlmacen);
            if (!def) throw new Error('almacén inexistente: ' + nombreAlmacen);
            const tx = {
                oncomplete: null,
                onerror: null,
                onabort: null,
                _pendientes: 0,
                _cerrado: false,
                objectStore: function (n) {
                    const d = almacenes.get(n);
                    if (!d) throw new Error('almacén inexistente: ' + n);
                    return crearStoreFalso(d, tx);
                },
                abort: function () {
                    if (tx._cerrado) return;
                    tx._cerrado = true;
                    if (typeof tx.onabort === 'function') setTimeout(function () { tx.onabort({ target: tx }); }, 0);
                }
            };
            return tx;
        }
    };
}

function crearIndexedDBFalso() {
    const bases = new Map();
    return {
        _bases: bases,
        open: function (nombre, version) {
            const peticion = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
            setTimeout(function () {
                let base = bases.get(nombre);
                const nueva = !base;
                if (!base) {
                    base = crearBaseFalsa(nombre, version || 1);
                    bases.set(nombre, base);
                }
                peticion.result = base;
                if (nueva && typeof peticion.onupgradeneeded === 'function') peticion.onupgradeneeded({ target: peticion });
                if (typeof peticion.onsuccess === 'function') peticion.onsuccess({ target: peticion });
            }, 0);
            return peticion;
        }
    };
}

/* ------------------------------------------------------------------ */
/* 4. document falso (solo para probar los avisos)                    */
/* ------------------------------------------------------------------ */

function crearDocumentoFalso(idsIniciales) {
    function crearNodo(etiqueta) {
        const nodo = {
            tagName: String(etiqueta).toUpperCase(),
            style: {},
            hijos: [],
            atributos: {},
            parentNode: null,
            texto: '',
            _html: '',
            hidden: false,
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
    (idsIniciales || []).forEach(function (id) { elementos[id] = crearNodo('div'); });
    Object.defineProperty(documento, '_elementos', { get: function () { return elementos; } });
    return documento;
}

/* ------------------------------------------------------------------ */
/* 5. Sandbox con almacenamiento.js cargado                           */
/* ------------------------------------------------------------------ */

function crearContexto(inicial, opciones) {
    const op = opciones || {};
    const localStorage = crearLocalStorageFalso(inicial);
    const sessionStorage = crearLocalStorageFalso();
    const indexedDB = crearIndexedDBFalso();
    const documento = crearDocumentoFalso(op.idsElementos);

    const contexto = {
        console: console,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Promise: Promise,
        Date: Date,
        Math: Math,
        JSON: JSON,
        Number: Number,
        String: String,
        Boolean: Boolean,
        Object: Object,
        Array: Array,
        Error: Error,
        Map: Map,
        Set: Set,
        isFinite: isFinite,
        isNaN: isNaN,
        parseInt: parseInt,
        parseFloat: parseFloat,
        localStorage: localStorage,
        sessionStorage: sessionStorage,
        indexedDB: indexedDB,
        document: documento,
        navigator: op.navigator || {},
        location: { origin: 'https://pruebas.local' }
    };
    if (op.extra) {
        Object.keys(op.extra).forEach(function (k) { contexto[k] = op.extra[k]; });
    }
    contexto.window = contexto;
    contexto._documentoFalso = documento;
    vm.createContext(contexto);
    const codigo = fs.readFileSync(path.join(RAIZ, 'almacenamiento.js'), 'utf8');
    vm.runInContext(codigo, contexto, { filename: 'almacenamiento.js' });
    return contexto;
}

/* ------------------------------------------------------------------ */
/* 6. Pruebas funcionales                                             */
/* ------------------------------------------------------------------ */

function ventaAntigua(indice, meses) {
    const d = new Date();
    d.setMonth(d.getMonth() - meses);
    d.setHours(d.getHours() + indice);
    return d.toISOString();
}

async function pruebaArchivado() {
    titulo('2. archivarVentasAntiguas(): archiva en IndexedDB y quita de pos_sales sin perder ninguna');

    const ventas = [
        { id: 'V-1', timestamp: ventaAntigua(0, 8), total: 10 },
        { id: 'V-2', fecha: ventaAntigua(1, 7), total: 20 },
        { id: 'V-3', timestamp: ventaAntigua(2, 1), total: 30 },   // reciente
        { id: 'V-4', total: 40 },                                 // sin fecha: reciente
        { id: 'V-5', timestamp: new Date().toISOString(), total: 50 }
    ];
    const ctx = crearContexto({ pos_sales: JSON.stringify(ventas) });

    const idsAntes = ventas.map(function (v) { return v.id; }).sort();
    const res = await ctx.window.archivarVentasAntiguas();

    check('historialDisponible() = true con IndexedDB falso', ctx.window.historialDisponible() === true);
    check('devuelve { archivadas, quedan, error } sin error', res.error === null && res.archivadas === 2 && res.quedan === 3);

    const quedan = JSON.parse(ctx.localStorage.getItem('pos_sales'));
    const idsQuedan = quedan.map(function (v) { return v.id; });
    check('pos_sales conserva solo las recientes (V-3, V-4, V-5)', idsQuedan.length === 3 &&
        idsQuedan.indexOf('V-3') !== -1 && idsQuedan.indexOf('V-4') !== -1 && idsQuedan.indexOf('V-5') !== -1);
    check('las ventas antiguas ya no están en pos_sales', idsQuedan.indexOf('V-1') === -1 && idsQuedan.indexOf('V-2') === -1);

    const historial = await ctx.window.leerHistorial('ventas', 0);
    const idsHistorial = historial.map(function (v) { return v.id; }).sort();
    check('IndexedDB contiene las 2 ventas antiguas (V-1, V-2)',
        idsHistorial.length === 2 && idsHistorial[0] === 'V-1' && idsHistorial[1] === 'V-2');
    check('contarHistorial("ventas") = 2', (await ctx.window.contarHistorial('ventas')) === 2);

    const idsDespues = idsQuedan.concat(idsHistorial).sort();
    check('NINGUNA venta se perdió: ids antes = ' + idsAntes.join(',') + ' / ids después = ' + idsDespues.join(','),
        JSON.stringify(idsAntes) === JSON.stringify(idsDespues));

    const res2 = await ctx.window.archivarVentasAntiguas();
    check('una segunda llamada no archiva nada (archivadas = 0)', res2.archivadas === 0 && res2.error === null);

    // Sin IndexedDB no se debe quitar nada de localStorage.
    const ctxSinIdb = crearContexto({ pos_sales: JSON.stringify([ventas[0]]) });
    ctxSinIdb.indexedDB = undefined;
    ctxSinIdb.window.indexedDB = undefined;
    const resSin = await ctxSinIdb.window.archivarVentasAntiguas();
    check('sin IndexedDB avisa y NO quita la venta de localStorage',
        resSin.archivadas === 0 && !!resSin.error && JSON.parse(ctxSinIdb.localStorage.getItem('pos_sales')).length === 1);

    // Venta registrada MIENTRAS se archivaba: no se puede perder.
    const ctxCarrera = crearContexto({
        pos_sales: JSON.stringify([
            { id: 'A-1', timestamp: ventaAntigua(0, 8), total: 1 },
            { id: 'A-2', timestamp: new Date().toISOString(), total: 2 }
        ])
    });
    const enCurso = ctxCarrera.window.archivarVentasAntiguas();
    const mientras = JSON.parse(ctxCarrera.localStorage.getItem('pos_sales'));
    mientras.push({ id: 'A-NUEVA', timestamp: new Date().toISOString(), total: 3 });   // venta nueva
    ctxCarrera.localStorage.setItem('pos_sales', JSON.stringify(mientras));
    const resCarrera = await enCurso;
    const idsCarrera = JSON.parse(ctxCarrera.localStorage.getItem('pos_sales')).map(function (v) { return v.id; });
    check('una venta registrada durante el archivado NO se pierde (archivadas = 1, quedan = 2)',
        resCarrera.archivadas === 1 && resCarrera.quedan === 2 &&
        idsCarrera.indexOf('A-NUEVA') !== -1 && idsCarrera.indexOf('A-2') !== -1 && idsCarrera.indexOf('A-1') === -1);
}

async function pruebaPolitica() {
    titulo('3. aplicarPoliticaAlmacenamiento(): requiere respaldo al 100 % y luego borra en lotes');

    const registroViejo = { id: 'H-0', timestamp: '2020-01-01T00:00:00.000Z', payload: 'x'.repeat(300) };
    const ctx = crearContexto({
        pos_sales: JSON.stringify([{ id: 'V-1', timestamp: new Date().toISOString(), total: 5 }]),
        pos_rate_history: JSON.stringify({ oficial: [{ t: Date.now(), v: 10 }] })
    });

    // 250 registros con fechas crecientes: H-0 (el más antiguo) … H-249 (el más nuevo).
    const registros = [];
    for (let i = 0; i < 250; i++) {
        const d = new Date('2020-01-01T00:00:00.000Z');
        d.setHours(d.getHours() + i);
        registros.push({ id: 'H-' + i, timestamp: d.toISOString(), payload: 'y'.repeat(300) });
    }
    void registroViejo;
    const guardado = await ctx.window.guardarEnHistorial('ventas', registros);
    check('guardarEnHistorial() guarda 250 registros', guardado.ok === true && guardado.guardados === 250);

    // Límite tal que el uso quede al ~200 % (2 veces el límite).
    const bytesLocal = ctx.window.medirAlmacenamiento().totalBytes;
    const bytesHistorial = await ctx.window.tamanoHistorial();
    const limiteMB = ((bytesLocal + bytesHistorial) / 1048576) / 2;
    ctx.localStorage.setItem('limiteLocalMB', String(limiteMB));

    const medidaInicial = ctx.window.medirTodo();
    check('medirTodo() devuelve el objeto esperado (origen "local" y ~200 %)',
        medidaInicial.origenLimite === 'local' && medidaInicial.porcentaje > 190 && medidaInicial.porcentaje < 210 &&
        medidaInicial.totalBytes === medidaInicial.localBytes + bytesHistorial &&
        medidaInicial.limiteBytes === Math.round(limiteMB * 1048576));
    check('necesitaRespaldo() = true antes de descargar un respaldo', ctx.window.necesitaRespaldo() === true);

    const sinRespaldo = await ctx.window.aplicarPoliticaAlmacenamiento();
    const trasAviso = await ctx.window.contarHistorial('ventas');
    check('al 100 % sin respaldo devuelve accion = "requiere-respaldo"', sinRespaldo.accion === 'requiere-respaldo');
    check('el aviso pide descargar un respaldo', typeof sinRespaldo.aviso === 'string' &&
        sinRespaldo.aviso.indexOf('descarga un respaldo y luego se borrarán los registros más antiguos') !== -1);
    check('NO borró nada en esa llamada (siguen los 250 registros)', trasAviso === 250 && sinRespaldo.liberadoBytes === 0);

    // El aviso debe ofrecer el botón "Descargar respaldo".
    const nodoAviso = ctx._documentoFalso.body.hijos[0];
    const filaBotones = nodoAviso && nodoAviso.hijos[1];
    check('el aviso muestra el botón "Descargar respaldo"',
        !!filaBotones && filaBotones.hijos.length === 1 && filaBotones.hijos[0].textContent === 'Descargar respaldo');

    check('marcarRespaldoHecho() deja la marca y necesitaRespaldo() pasa a false',
        ctx.window.marcarRespaldoHecho() === true && ctx.window.necesitaRespaldo() === false &&
        !!ctx.localStorage.getItem('respaldoHecho'));

    const conRespaldo = await ctx.window.aplicarPoliticaAlmacenamiento();
    const restantes = await ctx.window.contarHistorial('ventas');
    const quedan = await ctx.window.leerHistorial('ventas', 0);

    check('con respaldo borra en lotes: accion = "recortado"', conRespaldo.accion === 'recortado');
    check('liberó bytes y borró registros (liberadoBytes > 0 y borrados >= 100)',
        conRespaldo.liberadoBytes > 0 && conRespaldo.borrados >= 100);
    check('el aviso informa de los MB liberados y de activar la nube',
        conRespaldo.aviso.indexOf('Se liberaron') === 0 && conRespaldo.aviso.indexOf('Activa la nube') !== -1);
    check('bajó del 90 % del límite (' + conRespaldo.porcentaje + ' %)', conRespaldo.porcentaje < 90);
    check('quedan ' + restantes + ' registros y son los MÁS NUEVOS (sin H-0)',
        restantes === 250 - conRespaldo.borrados && quedan.length === restantes && quedan[0].id !== 'H-0');

    const idsBorrados = new Set();
    registros.forEach(function (r) { idsBorrados.add(r.id); });
    quedan.forEach(function (r) { idsBorrados.delete(r.id); });
    let soloAntiguos = true;
    let maxBorrado = 0;
    idsBorrados.forEach(function (id) { maxBorrado = Math.max(maxBorrado, Number(String(id).split('-')[1])); });
    quedan.forEach(function (r) {
        if (Number(String(r.id).split('-')[1]) <= maxBorrado) soloAntiguos = false;
    });
    check('todos los borrados son más antiguos que los conservados', soloAntiguos && idsBorrados.size === conRespaldo.borrados);

    // Por debajo del 80 %: no hace nada.
    ctx.localStorage.setItem('limiteLocalMB', '99999');
    const holgado = await ctx.window.aplicarPoliticaAlmacenamiento();
    check('con espacio de sobra devuelve accion = "nada" y sin aviso', holgado.accion === 'nada' && holgado.aviso === null);

    // Entre 80 % y 100 %: solo aviso.
    const bytesLocal2 = ctx.window.medirAlmacenamiento().totalBytes;
    const bytesHist2 = await ctx.window.tamanoHistorial();
    const limite85 = ((bytesLocal2 + bytesHist2) / 1048576) / 0.85;
    ctx.localStorage.setItem('limiteLocalMB', String(limite85));
    const enAviso = await ctx.window.aplicarPoliticaAlmacenamiento();
    check('entre 80 % y 100 % devuelve accion = "aviso" con el texto del límite',
        enAviso.accion === 'aviso' && enAviso.aviso.indexOf('% de tu límite') !== -1 &&
        enAviso.aviso.indexOf('Activa la nube o descarga un respaldo') !== -1);
}

async function pruebaRecorteTasas() {
    titulo('4. recortarHistorialTasas(): conserva siempre 60 días (o la ventana más larga)');

    const ahora = Date.now();
    const dia = 24 * 60 * 60 * 1000;
    const historial = {
        oficial: [
            { t: ahora - 70 * dia, v: 1 },     // fuera de 60 días: se quita
            { t: ahora - 45 * dia, v: 7 },     // dentro de 60 días: se conserva
            { t: ahora - 40 * dia, v: 1.5 },
            { t: ahora - 10 * dia, v: 2 },
            { t: ahora - 2 * dia, v: 3 }
        ],
        paralelo: [{ t: ahora - 20 * dia, v: 4 }, { t: ahora - 1 * dia, v: 5 }],
        promedio: [{ t: ahora - 90 * dia, v: 6 }]
    };
    const ctx = crearContexto({
        pos_rate_history: JSON.stringify(historial),
        pos_rate_trend_window: '3d'
    });
    // El POS publica los días de sus ventanas: la más larga es 21 días (< 60).
    ctx.window.RATE_TREND_WINDOWS_DIAS = { '3d': 3, '3w': 21 };

    const quitados = ctx.window.recortarHistorialTasas();
    const despues = JSON.parse(ctx.localStorage.getItem('pos_rate_history'));

    check('con "3d" seleccionado NO recorta a 3 días: quita solo lo anterior a 60 días (2 puntos)', quitados === 2);
    check('quita la muestra de 70 días (fuera de 60)', !despues.oficial.some(function (m) { return m.v === 1; }));
    check('CONSERVA la muestra de 45 días (dentro de 60)', despues.oficial.some(function (m) { return m.v === 7; }));
    check('conserva las 4 muestras de los últimos 60 días',
        despues.oficial.length === 4 && despues.paralelo.length === 2 && despues.promedio.length === 0);
    check('la vista "3w" (21 días) SIGUE TENIENDO datos tras recortar con "3d"',
        despues.oficial.filter(function (m) { return m.t >= ahora - 21 * dia; }).length > 0 &&
        despues.paralelo.filter(function (m) { return m.t >= ahora - 21 * dia; }).length > 0);
    check('no rompe el formato del objeto (mismas claves, cada una un arreglo)',
        JSON.stringify(Object.keys(despues).sort()) === JSON.stringify(['oficial', 'paralelo', 'promedio']) &&
        Array.isArray(despues.oficial) && Array.isArray(despues.paralelo) && Array.isArray(despues.promedio));
    check('una segunda pasada no quita nada', ctx.window.recortarHistorialTasas() === 0);

    // '3w' = 3 semanas = 21 días: tampoco puede bajar de 60 días.
    const ctx3w = crearContexto({
        pos_rate_history: JSON.stringify({ oficial: [{ t: ahora - 40 * dia, v: 1 }, { t: ahora - 10 * dia, v: 2 }] }),
        pos_rate_trend_window: '3w'
    });
    check('con "3w" tampoco baja de 60 días: no quita nada',
        ctx3w.window.recortarHistorialTasas() === 0 &&
        JSON.parse(ctx3w.localStorage.getItem('pos_rate_history')).oficial.length === 2);

    // Si una ventana publicada pide MÁS de 60 días, se respeta ese valor mayor.
    const ctxLarga = crearContexto({
        pos_rate_history: JSON.stringify({ oficial: [{ t: ahora - 100 * dia, v: 1 }, { t: ahora - 70 * dia, v: 2 }, { t: ahora - 10 * dia, v: 3 }] }),
        pos_rate_trend_window: '3d'
    });
    ctxLarga.window.RATE_TREND_WINDOWS_DIAS = { '3d': 3, '3m': 90 };
    const quitadosLarga = ctxLarga.window.recortarHistorialTasas();
    const trasLarga = JSON.parse(ctxLarga.localStorage.getItem('pos_rate_history')).oficial;
    check('si una ventana publicada pide 90 días se respeta: quita el de 100 y conserva el de 70',
        quitadosLarga === 1 && trasLarga.length === 2 &&
        trasLarga.some(function (m) { return m.v === 2; }) && !trasLarga.some(function (m) { return m.v === 1; }));

    // Sin ventana publicada y sin clave: suelo de 60 días.
    const ctxDefecto = crearContexto({
        pos_rate_history: JSON.stringify({ oficial: [{ t: ahora - 70 * dia, v: 1 }, { t: ahora - 20 * dia, v: 2 }] })
    });
    check('sin pos_rate_trend_window ni ventanas publicadas usa 60 días (quita el de 70 y conserva el de 20)',
        ctxDefecto.window.recortarHistorialTasas() === 1 &&
        JSON.parse(ctxDefecto.localStorage.getItem('pos_rate_history')).oficial[0].v === 2);

    // Una ventana enorme ('12m' = 360 días) se respeta: el punto de 400 días cae fuera.
    const ctxEnorme = crearContexto({
        pos_rate_history: JSON.stringify({ oficial: [{ t: ahora - 400 * dia, v: 1 }, { t: ahora - 5 * dia, v: 2 }] }),
        pos_rate_trend_window: '12m'
    });
    check('una ventana de 360 días (12m) se respeta: quita el de 400 días y conserva el de 5',
        ctxEnorme.window.recortarHistorialTasas() === 1 &&
        JSON.parse(ctxEnorme.localStorage.getItem('pos_rate_history')).oficial[0].v === 2);

    const ctxRoto = crearContexto({ pos_rate_history: 'no es json' });
    check('con un histórico ilegible no lanza y devuelve 0', ctxRoto.window.recortarHistorialTasas() === 0);
}

function pruebaVentanasPublicadasPorElPOS() {
    titulo('5. mini_market_pos.html publica los días de cada ventana de tendencia');

    const html = fs.readFileSync(path.join(RAIZ, 'mini_market_pos.html'), 'utf8');
    const declaracion = html.match(/const RATE_TREND_WINDOWS = \{[\s\S]*?\n\s*\};/);
    check('se encontró la declaración RATE_TREND_WINDOWS en el POS', !!declaracion);

    const fragmento = html.split('// >>> RATE_TREND_WINDOWS_DIAS')[1];
    const bloque = fragmento ? fragmento.split('// <<< RATE_TREND_WINDOWS_DIAS')[0] : '';
    check('se encontró el bloque que publica window.RATE_TREND_WINDOWS_DIAS', !!bloque && bloque.indexOf('window.RATE_TREND_WINDOWS_DIAS') !== -1);
    if (!declaracion || !bloque) return;

    const contexto = { console: console, Object: Object, Number: Number, isFinite: isFinite };
    contexto.window = {};
    vm.createContext(contexto);
    vm.runInContext(declaracion[0] + '\n' + bloque, contexto, { filename: 'mini_market_pos.html#ventanas' });
    const publicado = contexto.window.RATE_TREND_WINDOWS_DIAS;

    check('el POS publica exactamente { "3d": 3, "3w": 21 } (sin tocar RATE_TREND_WINDOWS)',
        !!publicado && publicado['3d'] === 3 && publicado['3w'] === 21 && Object.keys(publicado).length === 2);

    // El POS no cambia su selector: rateTrendWindow sigue leyendo RATE_TREND_WINDOWS.
    check('el selector del POS sigue usando RATE_TREND_WINDOWS',
        html.indexOf("RATE_TREND_WINDOWS[saved] ? saved : '3d'") !== -1);

    // Y con esos datos publicados, el recorte conserva la vista de 3 semanas.
    const ahora = Date.now();
    const dia = 86400000;
    const ctx = crearContexto({
        pos_rate_history: JSON.stringify({ oficial: [{ t: ahora - 45 * dia, v: 1 }, { t: ahora - 70 * dia, v: 2 }] }),
        pos_rate_trend_window: '3d'
    });
    ctx.window.RATE_TREND_WINDOWS_DIAS = publicado;
    const quitados = ctx.window.recortarHistorialTasas();
    const quedan = JSON.parse(ctx.localStorage.getItem('pos_rate_history')).oficial;
    check('recorte real con las ventanas del POS: quita el de 70 días y deja el de 45 días (vista 3w con datos)',
        quitados === 1 && quedan.length === 1 && quedan[0].v === 1);
}

function pruebaLimiteYMedicion() {
    titulo('6. limiteLocalMB() y medirTodo()');

    const ctx = crearContexto({});
    const porDefecto = ctx.window.limiteLocalMB();
    check('sin nada configurado el límite es 1024 MB (origen "por-defecto")',
        porDefecto.mb === 1024 && porDefecto.origen === 'por-defecto');

    ctx.localStorage.setItem('limiteLocalMB', '512');
    const local = ctx.window.limiteLocalMB();
    check('lee localStorage["limiteLocalMB"] cuando no hay nube', local.mb === 512 && local.origen === 'local');

    ctx.window.getCurrentUserEmail = function () { return 'dueno@negocio.com'; };
    let rutaConsultada = null;
    ctx.window.firebase = {
        apps: [{}],
        database: function () {
            return {
                ref: function (ruta) {
                    rutaConsultada = ruta;
                    return {
                        once: function (tipo, alRecibir) {
                            if (ruta.indexOf('/suscripcion/limiteLocalMB') !== -1) alRecibir({ val: function () { return 2048; } });
                        }
                    };
                }
            };
        }
    };
    const nube = ctx.window.limiteLocalMB();
    check('con Firebase inicializado lee la nube y devuelve origen "consola"',
        nube.mb === 2048 && nube.origen === 'consola');
    check('la ruta consultada es BBDD/<emailPath>/suscripcion/limiteLocalMB',
        rutaConsultada === 'BBDD/dueno_at_negocio_com/suscripcion/limiteLocalMB');

    const medida = ctx.window.medirTodo();
    check('medirTodo() incluye localBytes, historialBytes, totalBytes, limiteBytes, porcentaje y origenLimite',
        typeof medida.localBytes === 'number' && typeof medida.historialBytes === 'number' &&
        typeof medida.totalBytes === 'number' && typeof medida.limiteBytes === 'number' &&
        typeof medida.porcentaje === 'number' && typeof medida.origenLimite === 'string');
    check('medirTodo() calcula el porcentaje sobre el límite real (2048 MB)',
        medida.porcentaje === Math.round(((medida.totalBytes / medida.limiteBytes) * 100) * 10) / 10);
}

function pruebaAvisoConBotones() {
    titulo('7. mostrarAvisoAlmacenamiento(): compatibilidad de 2 parámetros y botones opcionales');

    const ctx = crearContexto({});
    ctx.window.mostrarAvisoAlmacenamiento('aviso simple', 'aviso');
    const simple = ctx._documentoFalso.body.hijos[0];
    check('con 2 parámetros pinta el texto y el botón de cerrar (2 hijos)',
        !!simple && simple.hijos.length === 2 && simple.hijos[0].textContent === 'aviso simple');

    let pulsado = 0;
    ctx.window.mostrarAvisoAlmacenamiento('aviso con botón', 'error', [
        { texto: 'Descargar respaldo', accion: function () { pulsado++; } }
    ]);
    const conBoton = ctx._documentoFalso.body.hijos[1];
    const fila = conBoton && conBoton.hijos[1];
    check('con 3 parámetros añade la fila de botones', !!fila && fila.hijos.length === 1);
    fila.hijos[0].click();
    check('el botón ejecuta su acción', pulsado === 1);
    check('el botón de cerrar sigue presente (3 hijos)', conBoton.hijos.length === 3);
}

async function pruebaPanelConfig() {
    titulo('8. Panel de config.html: límite real, uso, historial y botones nuevos');

    const html = fs.readFileSync(path.join(RAIZ, 'config.html'), 'utf8');
    const panel = scriptsEnLinea(html).filter(function (b) { return b.indexOf('function almacenamientoRefrescar') !== -1; })[0];
    check('existe el bloque <script> del panel de almacenamiento', !!panel);
    if (!panel) return;

    const ids = ['almEstadoUso', 'almEstadoLimite', 'almEstadoCuota', 'almEstadoHistorial',
        'almBarraUso', 'almTablaClaves', 'almDiagnostico', 'almEstado', 'almEstadoPersistencia',
        'almEstadoUsoSimple', 'almEstadoCopia', 'almAvisoLlano', 'almAvanzado', 'almBtnAvanzado'];
    const ctx = crearContexto({
        pos_sales: JSON.stringify([
            { id: 'V-1', timestamp: '2020-01-01T00:00:00.000Z', total: 1 },
            { id: 'V-2', timestamp: '2020-02-01T00:00:00.000Z', total: 2 },
            { id: 'V-3', timestamp: new Date().toISOString(), total: 3 }
        ]),
        pos_rate_history: JSON.stringify({ oficial: [{ t: Date.now() - 70 * 86400000, v: 1 }, { t: Date.now() - 45 * 86400000, v: 3 }, { t: Date.now(), v: 2 }] }),
        pos_rate_trend_window: '3d'
    }, {
        idsElementos: ids,
        navigator: { storage: { persisted: function () { return Promise.resolve(true); } } },
        extra: { showToast: function () { } }
    });

    // El bloque avanzado nace con el atributo `hidden` en el HTML.
    ctx._documentoFalso._elementos.almAvanzado.hidden = true;

    // Tres ventas archivadas para que la línea de historial tenga datos.
    await ctx.window.guardarEnHistorial('ventas', [
        { id: 'H-1', timestamp: '2020-01-01T00:00:00.000Z' },
        { id: 'H-2', timestamp: '2020-01-02T00:00:00.000Z' },
        { id: 'H-3', timestamp: '2020-01-03T00:00:00.000Z' }
    ]);

    vm.runInContext(panel, ctx, { filename: 'config.html#panel' });
    await ctx.window.almacenamientoRefrescar();

    const el = ctx._documentoFalso._elementos;
    const uso = el.almEstadoUso.textContent;
    const limite = el.almEstadoLimite.textContent;
    const cuota = el.almEstadoCuota.textContent;
    const historial = el.almEstadoHistorial.textContent;

    check('uso = "X MB de Y MB del límite local (Z %)" -> "' + uso + '"',
        /^\d+\.\d\d MB de 1024\.00 MB del límite local \(\d+(\.\d+)? %\)$/.test(uso));
    check('límite real visible -> "' + limite + '"', limite === 'Límite local: 1.024 MB (origen: por defecto)');
    check('la cuota del navegador queda como dato secundario -> "' + cuota + '"', cuota.indexOf('Cuota del navegador:') === 0);
    check('línea de historial -> "' + historial + '"',
        historial === 'Historial archivado: 3 ventas, 0 compras (' + (historial.match(/\(([^)]+)\)/) || [])[1] + ')' &&
        historial.indexOf('3 ventas, 0 compras') !== -1);

    // Botones nuevos en el HTML.
    check('el HTML tiene el botón "Aplicar política de almacenamiento" con su onclick',
        /<button[^>]*id="almBtnPolitica"[^>]*onclick="almacenamientoAplicarPolitica\(\)"[^>]*>Aplicar política de almacenamiento<\/button>/.test(html));
    check('el HTML tiene el botón "Recortar histórico de tasas" con su onclick',
        /<button[^>]*id="almBtnRecortarTasas"[^>]*onclick="almacenamientoRecortarTasas\(\)"[^>]*>Recortar histórico de tasas<\/button>/.test(html));

    // Botón "Aplicar política": con el límite de 1 GB no hay nada que hacer.
    await ctx.window.almacenamientoAplicarPolitica();
    check('el botón "Aplicar política" pinta accion/liberado -> "' + el.almEstado.textContent + '"',
        el.almEstado.textContent.indexOf('acción: nada') !== -1 &&
        el.almEstado.textContent.indexOf('liberado: 0.00 MB') !== -1);

    // Botón "Recortar histórico de tasas": debe quitar solo el punto de 70 días
    // (el de 45 días se conserva: el recorte nunca baja de 60 días).
    await ctx.window.almacenamientoRecortarTasas();
    check('el botón "Recortar histórico de tasas" muestra los puntos quitados -> "' + el.almEstado.textContent + '"',
        el.almEstado.textContent === 'Histórico de tasas: se quitaron 1 punto(s) fuera de la ventana de la tendencia.');
    const trasRecorte = JSON.parse(ctx.localStorage.getItem('pos_rate_history')).oficial;
    check('el histórico conserva los puntos de 45 días y de hoy, y quita el de 70',
        trasRecorte.length === 2 && trasRecorte.some(function (m) { return m.v === 3; }) &&
        trasRecorte.some(function (m) { return m.v === 2; }) && !trasRecorte.some(function (m) { return m.v === 1; }));

    // ---- Dos niveles: visible (cliente) y avanzado (oculto) ----
    const visible = html.substring(html.indexOf('<h3 class="section-title">Almacenamiento</h3>'), html.indexOf('id="almAvanzado"'));
    const avanzado = html.split('id="almAvanzado"')[1];

    check('el nivel visible tiene la línea llana, la fecha de la copia, la frase llana y el botón grande',
        visible.indexOf('id="almEstadoUsoSimple"') !== -1 && visible.indexOf('id="almEstadoCopia"') !== -1 &&
        visible.indexOf('id="almAvisoLlano"') !== -1 && visible.indexOf('id="almBtnCopia"') !== -1 &&
        visible.indexOf('Descargar copia de seguridad</button>') !== -1);
    check('el nivel visible NO tiene tecnicismos (claves, diagnóstico, cuota, límite, IndexedDB)',
        !/almTablaClaves|almDiagnostico|almEstadoCuota|almEstadoLimite|almEstadoHistorial|almEstadoUso"|IndexedDB|Cuota del navegador|Límite local|base64/.test(visible));
    check('el bloque Avanzado está en el HTML y empieza cerrado', /id="almAvanzado"\s+hidden/.test(html));
    check('el botón "Avanzado" es discreto y controla el bloque',
        /<button[^>]*id="almBtnAvanzado"[^>]*onclick="almacenamientoAlternarAvanzado\(\)"[^>]*>Avanzado<\/button>/.test(html));
    check('el nivel avanzado tiene la tabla, el diagnóstico y TODOS los botones técnicos',
        avanzado.indexOf('id="almTablaClaves"') !== -1 && avanzado.indexOf('id="almDiagnostico"') !== -1 &&
        avanzado.indexOf('id="almBtnRefrescar"') !== -1 && avanzado.indexOf('id="almBtnPersistencia"') !== -1 &&
        avanzado.indexOf('id="almBtnRestaurar"') !== -1 && avanzado.indexOf('id="almArchivoRespaldo"') !== -1 &&
        avanzado.indexOf('id="almBtnPolitica"') !== -1 && avanzado.indexOf('id="almBtnRecortarTasas"') !== -1);

    // Textos pintados en el nivel visible.
    check('la línea visible es llana -> "' + el.almEstadoUsoSimple.textContent + '"',
        el.almEstadoUsoSimple.textContent === 'menos de 1 MB de 1 GB usados · Todo en orden' ||
        /^\S.* de 1 GB usados · Todo en orden$/.test(el.almEstadoUsoSimple.textContent));
    check('la fecha de la copia se muestra en llano -> "' + el.almEstadoCopia.textContent + '"',
        el.almEstadoCopia.textContent === 'Última copia de seguridad: nunca');
    check('con el espacio holgado la frase llana está oculta', el.almAvisoLlano.hidden === true);

    // El botón "Avanzado" abre y cierra el bloque técnico.
    check('el bloque avanzado empieza oculto en el DOM', el.almAvanzado.hidden === true);
    ctx.window.almacenamientoAlternarAvanzado();
    check('el botón "Avanzado" abre el bloque técnico',
        el.almAvanzado.hidden === false && el.almBtnAvanzado.textContent === 'Ocultar avanzado');
    ctx.window.almacenamientoAlternarAvanzado();
    check('y lo vuelve a cerrar',
        el.almAvanzado.hidden === true && el.almBtnAvanzado.textContent === 'Avanzado');

    // Con el límite simulado al 90 % la frase llana aparece.
    fijarLimiteParaFraccion(ctx, 0.9);
    await ctx.window.almacenamientoRefrescar();
    check('casi lleno: aparece UNA frase llana sin números -> "' + el.almAvisoLlano.textContent + '"',
        el.almAvisoLlano.hidden === false &&
        el.almAvisoLlano.textContent === 'Puedes seguir vendiendo. Descarga una copia para no perder datos antiguos.');
    check('casi lleno: la línea visible lo dice en llano -> "' + el.almEstadoUsoSimple.textContent + '"',
        /· Casi lleno$/.test(el.almEstadoUsoSimple.textContent));

    // Lleno: menciona la nube, sin botón técnico.
    fijarLimiteParaFraccion(ctx, 1.5);
    await ctx.window.almacenamientoRefrescar();
    check('lleno: la frase menciona la nube y sigue sin números -> "' + el.almAvisoLlano.textContent + '"',
        /· Lleno$/.test(el.almEstadoUsoSimple.textContent) &&
        el.almAvisoLlano.textContent === 'Puedes seguir vendiendo. Descarga una copia para no perder datos antiguos. Para conservar todo el historial hace falta la nube.' &&
        !/\d/.test(el.almAvisoLlano.textContent));

    // Descargar copia desde el botón visible refresca la fecha en llano.
    ctx.localStorage.setItem('respaldoHecho', new Date().toISOString());
    await ctx.window.almacenamientoRefrescar();
    check('tras la copia, la línea visible dice "hoy" -> "' + el.almEstadoCopia.textContent + '"',
        el.almEstadoCopia.textContent === 'Última copia de seguridad: hoy');
}

/* ------------------------------------------------------------------ */
/* 9 y 10. Estado llano, fecha de copia y aviso automático            */
/* ------------------------------------------------------------------ */

/** Todos los <button> de un nodo falso, en orden. */
function contarBotones(nodo, salida) {
    const acumulado = salida || [];
    if (!nodo || !nodo.hijos) return acumulado;
    nodo.hijos.forEach(function (hijo) {
        if (hijo.tagName === 'BUTTON') acumulado.push(hijo);
        contarBotones(hijo, acumulado);
    });
    return acumulado;
}

/**
 * Fija localStorage['limiteLocalMB'] para que el uso quede en la fracción pedida
 * (0.5 = 50 %). Se hace en dos pasadas porque la propia clave del límite ocupa
 * espacio y falsearía la fracción.
 */
function fijarLimiteParaFraccion(ctx, fraccion) {
    const datos = ctx.localStorage;
    datos.setItem('limiteLocalMB', '1');
    for (let i = 0; i < 2; i++) {
        const total = ctx.window.medirTodo().totalBytes;
        datos.setItem('limiteLocalMB', String((total / 1048576) / fraccion));
    }
}

function pruebaEstadoSimple() {
    titulo('9. estadoAlmacenamientoSimple() y fechaUltimaCopia() en lenguaje llano');

    const datos = { pos_sales: JSON.stringify([{ id: 'V-1', timestamp: new Date().toISOString(), total: 5 }]) };

    // Con el límite por defecto: "menos de 1 MB de 1 GB usados · Todo en orden".
    const ctxDefecto = crearContexto(datos);
    const porDefecto = ctxDefecto.window.estadoAlmacenamientoSimple();
    check('con el límite por defecto el texto es llano y en GB -> "' + porDefecto.texto + '"',
        /^\S.* de 1 GB usados · Todo en orden$/.test(porDefecto.texto) && porDefecto.estado === 'ok');
    check('devuelve estado, texto, porcentaje, usadoMB, limiteMB y ultimaCopia',
        porDefecto.estado === 'ok' && typeof porDefecto.texto === 'string' && typeof porDefecto.porcentaje === 'number' &&
        typeof porDefecto.usadoMB === 'number' && porDefecto.limiteMB === 1024 && porDefecto.ultimaCopia === 'nunca');

    // ---- Tres estados con el límite simulado ----
    // El relleno hace que el espacio de la propia clave del límite no falsee la fracción.
    const ctx = crearContexto({
        pos_sales: JSON.stringify([{ id: 'V-1', timestamp: new Date().toISOString(), total: 5 }]),
        relleno_pruebas: 'x'.repeat(200000)
    });

    fijarLimiteParaFraccion(ctx, 0.5);
    const ok = ctx.window.estadoAlmacenamientoSimple();
    check('al ~50 % el estado es "ok" con "· Todo en orden" (' + ok.porcentaje + ' %) -> "' + ok.texto + '"',
        ok.estado === 'ok' && ok.texto.indexOf('· Todo en orden') !== -1 && ok.porcentaje > 45 && ok.porcentaje < 55);

    fijarLimiteParaFraccion(ctx, 0.85);
    const casi = ctx.window.estadoAlmacenamientoSimple();
    check('al ~85 % el estado es "casi" con "· Casi lleno" (' + casi.porcentaje + ' %) -> "' + casi.texto + '"',
        casi.estado === 'casi' && casi.texto.indexOf('· Casi lleno') !== -1 && casi.porcentaje >= 80 && casi.porcentaje < 100);

    fijarLimiteParaFraccion(ctx, 1.5);
    const lleno = ctx.window.estadoAlmacenamientoSimple();
    check('al ~150 % el estado es "lleno" con "· Lleno" (' + lleno.porcentaje + ' %) -> "' + lleno.texto + '"',
        lleno.estado === 'lleno' && lleno.texto.indexOf('· Lleno') !== -1 && lleno.porcentaje >= 100);
    check('el texto nunca dice "límite local", "IndexedDB", "cuota" ni origen',
        !/límite local|IndexedDB|cuota|origen/i.test(ok.texto + casi.texto + lleno.texto));
    check('usadoMB y limiteMB son coherentes con el texto en MB/GB',
        ok.usadoMB > 0 && ok.limiteMB > 0 && typeof ok.texto === 'string');

    // ---- fechaUltimaCopia() ----
    const ctxF = crearContexto({});
    check('sin marca devuelve "nunca"', ctxF.window.fechaUltimaCopia() === 'nunca');
    check('la marca se refleja en estadoAlmacenamientoSimple().ultimaCopia', ctxF.window.estadoAlmacenamientoSimple().ultimaCopia === 'nunca');

    ctxF.localStorage.setItem('respaldoHecho', new Date().toISOString());
    check('con marca de hoy devuelve "hoy"', ctxF.window.fechaUltimaCopia() === 'hoy');
    check('y el estado simple también dice "hoy"', ctxF.window.estadoAlmacenamientoSimple().ultimaCopia === 'hoy');

    const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);
    ctxF.localStorage.setItem('respaldoHecho', ayer.toISOString());
    check('con marca de ayer devuelve "ayer"', ctxF.window.fechaUltimaCopia() === 'ayer');

    const hace3 = new Date(); hace3.setDate(hace3.getDate() - 3);
    ctxF.localStorage.setItem('respaldoHecho', hace3.toISOString());
    check('con marca de hace 3 días devuelve "hace 3 días"', ctxF.window.fechaUltimaCopia() === 'hace 3 días');

    const hace30 = new Date(); hace30.setDate(hace30.getDate() - 30);
    ctxF.localStorage.setItem('respaldoHecho', hace30.toISOString());
    check('a los 30 días sigue en "hace 30 días"', ctxF.window.fechaUltimaCopia() === 'hace 30 días');

    const hace40 = new Date(); hace40.setDate(hace40.getDate() - 40);
    const esperado40 = String(hace40.getDate()).padStart(2, '0') + '/' + String(hace40.getMonth() + 1).padStart(2, '0') + '/' + hace40.getFullYear();
    ctxF.localStorage.setItem('respaldoHecho', hace40.toISOString());
    check('a los 40 días pasa a fecha DD/MM/AAAA -> ' + esperado40, ctxF.window.fechaUltimaCopia() === esperado40);

    ctxF.localStorage.setItem('respaldoHecho', new Date(2025, 8, 12, 10, 0, 0).toISOString());
    check('con marca antigua devuelve "12/09/2025"', ctxF.window.fechaUltimaCopia() === '12/09/2025');

    ctxF.localStorage.setItem('respaldoHecho', 'no es una fecha');
    check('con marca ilegible devuelve "nunca"', ctxF.window.fechaUltimaCopia() === 'nunca');
}

async function pruebaAvisarSiLleno() {
    titulo('10. avisarSiLleno(): calla al 80 % y avisa al 96 % con un solo botón');

    const datos = { pos_sales: JSON.stringify([{ id: 'V-1', timestamp: new Date().toISOString(), total: 5 }]) };

    // --- 80 %: no debe decir nada ---
    const ctx80 = crearContexto(Object.assign({ relleno_pruebas: 'x'.repeat(200000) }, datos));
    fijarLimiteParaFraccion(ctx80, 0.8);
    const r80 = await ctx80.window.avisarSiLleno();
    check('al 80 % NO muestra nada (' + r80.porcentaje + ' %)',
        r80.avisado === false && ctx80._documentoFalso.body.hijos.length === 0);

    // --- 96 %: aviso llano con un único botón de acción ---
    const ctx96 = crearContexto(Object.assign({ relleno_pruebas: 'x'.repeat(200000) }, datos));
    fijarLimiteParaFraccion(ctx96, 0.96);
    const r96 = await ctx96.window.avisarSiLleno();
    check('al 96 % SÍ muestra el aviso (' + r96.porcentaje + ' %)',
        r96.avisado === true && ctx96._documentoFalso.body.hijos.length === 1);

    const cont = ctx96._documentoFalso.body.hijos[0];
    const textoAviso = cont.hijos[0].textContent;
    check('el mensaje es el llano esperado, sin números -> "' + textoAviso + '"',
        textoAviso === 'Al almacenamiento de este equipo le queda muy poco espacio. Descarga una copia de seguridad para no perder tus datos.' &&
        !/\d/.test(textoAviso));

    const botones = contarBotones(cont);
    check('el aviso tiene exactamente 2 botones contando el de cerrar', botones.length === 2);
    const acciones = botones.filter(function (b) { return b.textContent !== '\u00d7'; });
    check('el único botón de acción es "Descargar copia de seguridad"',
        acciones.length === 1 && acciones[0].textContent === 'Descargar copia de seguridad');
    check('el segundo botón es el de cerrar (aria-label)',
        botones.filter(function (b) { return b.atributos && b.atributos['aria-label'] === 'Cerrar aviso'; }).length === 1);

    // --- Justo por debajo del umbral (94 %) sigue callado ---
    const ctx94 = crearContexto(Object.assign({ relleno_pruebas: 'x'.repeat(200000) }, datos));
    fijarLimiteParaFraccion(ctx94, 0.94);
    const r94 = await ctx94.window.avisarSiLleno();
    check('al 94 % sigue sin mostrar nada (' + r94.porcentaje + ' %)',
        r94.avisado === false && ctx94._documentoFalso.body.hijos.length === 0);
}

/* ------------------------------------------------------------------ */
/* Ejecución                                                          */
/* ------------------------------------------------------------------ */
(async function () {
    console.log('Pruebas de almacenamiento.js — historial en IndexedDB y política de límite local');
    console.log('Node ' + process.version + ' · ' + new Date().toISOString());

    probarSintaxis();
    await pruebaArchivado();
    await pruebaPolitica();
    await pruebaRecorteTasas();
    pruebaVentanasPublicadasPorElPOS();
    pruebaLimiteYMedicion();
    pruebaAvisoConBotones();
    await pruebaPanelConfig();
    pruebaEstadoSimple();
    await pruebaAvisarSiLleno();

    console.log('\n----------------------------------------');
    console.log('RESULTADO: ' + (pruebas - fallos) + '/' + pruebas + ' comprobaciones OK' + (fallos ? ' · ' + fallos + ' FALLA(S)' : ' · sin fallos'));
    process.exit(fallos ? 1 : 0);
})().catch(function (e) {
    console.error('ERROR INESPERADO EN LAS PRUEBAS:', e);
    process.exit(1);
});
