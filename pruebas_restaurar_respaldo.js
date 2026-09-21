/**
 * pruebas_restaurar_respaldo.js
 *
 * Encargo 2: al restaurar un respaldo, el contador de tickets
 * (`pos_last_sale_number`) NUNCA retrocede y los identificadores del equipo
 * (`pos_install_id`, `pos_device_id`) no se toman del archivo.
 *
 * Prueba la función real `restaurarRespaldo()` de `almacenamiento.js` con un
 * localStorage falso, un `FileReader` falso y, en la última sección, con el
 * aislamiento por cuenta REAL de `datos_cuenta.js` (intercepción de
 * `Storage.prototype`). No necesita navegador ni Firebase.
 *
 * Uso:  node pruebas_restaurar_respaldo.js
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
/* 1. localStorage / Storage falso                                    */
/* ------------------------------------------------------------------ */

function errorDeCuota() {
    const e = new Error('QuotaExceededError: cuota simulada en las pruebas');
    e.name = 'QuotaExceededError';
    e.code = 22;
    return e;
}

/**
 * `Storage` falso con la forma de un Storage real (prototipo con getItem/setItem/
 * removeItem/key y el getter `length`): así `datos_cuenta.js` puede interceptarlo
 * igual que al localStorage del navegador.
 * Opciones de fallo: `fallarSiempre`, `fallarEnEscribir` (1-based, una sola vez) y
 * `fallarEnClave`.
 */
function crearStorageFalso(inicial, opciones) {
    const op = opciones || {};
    const datos = new Map();
    if (inicial) {
        Object.keys(inicial).forEach(function (k) { datos.set(String(k), String(inicial[k])); });
    }
    let escrituras = 0;

    class StorageFalso {
        getItem(k) { k = String(k); return datos.has(k) ? datos.get(k) : null; }
        setItem(k, v) {
            k = String(k); v = String(v);
            escrituras++;
            if (op.fallarSiempre) throw errorDeCuota();
            if (op.fallarEnEscribir && escrituras === op.fallarEnEscribir) throw errorDeCuota();
            if (op.fallarEnClave && k === op.fallarEnClave) throw errorDeCuota();
            datos.set(k, v);
        }
        removeItem(k) { datos.delete(String(k)); }
        clear() { datos.clear(); }
        key(i) {
            const claves = Array.from(datos.keys());
            const n = Number(i);
            return (n >= 0 && n < claves.length) ? claves[n] : null;
        }
        get length() { return datos.size; }
    }

    const almacen = new StorageFalso();
    almacen._datos = datos;
    almacen._escrituras = function () { return escrituras; };
    return almacen;
}

/* ------------------------------------------------------------------ */
/* 2. document falso (para los avisos de almacenamiento.js)           */
/* ------------------------------------------------------------------ */

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
    Object.defineProperty(documento, '_elementos', { get: function () { return elementos; } });
    return documento;
}

/* ------------------------------------------------------------------ */
/* 3. FileReader falso (lee el campo `texto` del archivo)             */
/* ------------------------------------------------------------------ */

function crearFileReaderFalso() {
    function FileReaderFalso() {
        this.result = null;
        this.onload = null;
        this.onerror = null;
    }
    FileReaderFalso.prototype.readAsText = function (archivo) {
        const self = this;
        setTimeout(function () {
            try {
                if (!archivo || typeof archivo.texto !== 'string') {
                    if (typeof self.onerror === 'function') self.onerror({ target: self });
                    return;
                }
                self.result = archivo.texto;
                if (typeof self.onload === 'function') self.onload({ target: self });
            } catch (e) { /* nada: la promesa ya resuelve por su cuenta */ }
        }, 0);
    };
    return FileReaderFalso;
}

/* ------------------------------------------------------------------ */
/* 4. Sandbox con los scripts reales cargados                         */
/* ------------------------------------------------------------------ */

function crearContexto(inicial, opciones) {
    const op = opciones || {};
    const almacen = crearStorageFalso(inicial, op);
    const documento = crearDocumentoFalso();

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
        localStorage: almacen,
        sessionStorage: crearStorageFalso(),
        Storage: almacen.constructor,
        document: documento,
        navigator: {},
        location: { origin: 'https://pruebas.local' },
        FileReader: crearFileReaderFalso(),
        _confirmaciones: [],
        _confirmar: op.confirmar !== false
    };
    contexto.confirm = function (mensaje) {
        contexto._confirmaciones.push(String(mensaje));
        return contexto._confirmar !== false;
    };
    contexto.window = contexto;
    contexto._almacen = almacen;
    contexto._documentoFalso = documento;

    vm.createContext(contexto);
    const scripts = op.scripts || ['almacenamiento.js'];
    scripts.forEach(function (nombre) {
        const codigo = fs.readFileSync(path.join(RAIZ, nombre), 'utf8');
        vm.runInContext(codigo, contexto, { filename: nombre });
    });
    return contexto;
}

/* ------------------------------------------------------------------ */
/* 5. Utilidades de prueba                                            */
/* ------------------------------------------------------------------ */

/** Restaura `datos` en el contexto y devuelve el resultado de restaurarRespaldo(). */
async function restaurar(ctx, datos, opciones) {
    const op = opciones || {};
    ctx._confirmaciones.length = 0;
    ctx._confirmar = op.confirmar !== false;
    const texto = (typeof op.texto === 'string') ? op.texto : JSON.stringify({
        app: 'Ciervo Mini Market',
        version: 1,
        generado: op.generado || '2024-01-01T00:00:00.000Z',
        origen: 'https://pruebas.local',
        datos: datos
    });
    return ctx.window.restaurarRespaldo({ texto: texto, name: 'respaldo.json' });
}

function proteccionDe(res, clave) {
    const lista = (res && res.protegidas) || [];
    return lista.filter(function (p) { return p.clave === clave; })[0] || null;
}

function leer(ctx, clave) {
    return ctx.window.localStorage.getItem(clave);
}

/* ------------------------------------------------------------------ */
/* 6. Secciones de prueba                                             */
/* ------------------------------------------------------------------ */

function probarSintaxis() {
    titulo('1. Sintaxis (new vm.Script)');
    try {
        const codigo = fs.readFileSync(path.join(RAIZ, 'almacenamiento.js'), 'utf8');
        new vm.Script(codigo, { filename: 'almacenamiento.js' });
        check('almacenamiento.js compila sin errores de sintaxis', true);
    } catch (e) {
        check('almacenamiento.js compila sin errores de sintaxis — ' + e.message, false);
    }
}

async function probarContador() {
    titulo('2. pos_last_sale_number: el contador nunca retrocede');

    // (a) Respaldo ANTIGUO (contador menor): manda el del equipo.
    {
        const ctx = crearContexto({ pos_last_sale_number: '105', ciervo_inventory: '[{"id":"NUEVO"}]' });
        const res = await restaurar(ctx, { pos_last_sale_number: '100', ciervo_inventory: '[{"id":"VIEJO"}]' });
        check('contador menor: la restauración termina ok', res.ok === true);
        check('contador menor: el contador se queda en 105 (el del equipo)',
            leer(ctx, 'pos_last_sale_number') === '105');
        check('contador menor: el resto de claves sí se restaura',
            leer(ctx, 'ciervo_inventory') === '[{"id":"VIEJO"}]');
        const prot = proteccionDe(res, 'pos_last_sale_number');
        check('contador menor: el resultado informa de la protección con su valor final',
            !!prot && prot.valorFinal === '105' && /contador/i.test(prot.motivo));
        check('contador menor: se informa también en el texto que ve el usuario (confirmación)',
            /pos_last_sale_number/.test(ctx._confirmaciones[0] || '') &&
            /105/.test(ctx._confirmaciones[0] || ''));
        check('contador menor: la clave protegida no se cuenta como restaurada (restauradas = 1)',
            res.restauradas === 1);
        const aviso = ctx._documentoFalso.body.hijos[0];
        const textoAviso = (aviso && aviso.hijos[0]) ? aviso.hijos[0].textContent : '';
        check('contador menor: el aviso final habla del contador más alto',
            /contador más alto: 105/.test(textoAviso));
    }

    // (b) Respaldo con contador MAYOR: la subida legítima no se bloquea.
    {
        const ctx = crearContexto({ pos_last_sale_number: '105' });
        const res = await restaurar(ctx, { pos_last_sale_number: '120', ciervo_inventory: '[]' });
        check('contador mayor: la restauración termina ok', res.ok === true);
        check('contador mayor: el contador sube a 120', leer(ctx, 'pos_last_sale_number') === '120');
        check('contador mayor: no se informa de ninguna protección del contador',
            proteccionDe(res, 'pos_last_sale_number') === null);
        check('contador mayor: el resto de claves se restaura igual',
            leer(ctx, 'ciervo_inventory') === '[]');
    }

    // (c) Mismo contador: nada que proteger.
    {
        const ctx = crearContexto({ pos_last_sale_number: '105' });
        const res = await restaurar(ctx, { pos_last_sale_number: '105' });
        check('contador igual: no se informa de protección',
            res.ok === true && res.protegidas.length === 0 && leer(ctx, 'pos_last_sale_number') === '105');
    }

    // (d) Equipo sin contador: se acepta el del respaldo.
    {
        const ctx = crearContexto({});
        const res = await restaurar(ctx, { pos_last_sale_number: '7' });
        check('sin contador en el equipo: se acepta el del respaldo (7)',
            res.ok === true && leer(ctx, 'pos_last_sale_number') === '7' && res.protegidas.length === 0);
    }

    // (e) Respaldo corrupto/no numérico: no puede bajar un contador real.
    {
        const ctx = crearContexto({ pos_last_sale_number: '900' });
        const res = await restaurar(ctx, { pos_last_sale_number: 'abc' });
        check('contador no numérico en el respaldo: se conserva el del equipo (900)',
            res.ok === true && leer(ctx, 'pos_last_sale_number') === '900' &&
            !!proteccionDe(res, 'pos_last_sale_number'));
    }
}

async function probarIdentidad() {
    titulo('3. pos_install_id / pos_device_id: la identidad del equipo no se pisa');

    // (a) El equipo YA tiene sus identificadores: se conservan los suyos.
    {
        const ctx = crearContexto({ pos_install_id: 'EQ-1', pos_device_id: 'DEV-1', ciervo_inventory: '[]' });
        const res = await restaurar(ctx, {
            pos_install_id: 'EQ-2', pos_device_id: 'DEV-2', ciervo_inventory: '[{"id":"VIEJO"}]'
        });
        check('identidad: la restauración termina ok', res.ok === true);
        check('identidad: pos_install_id conserva el del equipo (EQ-1)', leer(ctx, 'pos_install_id') === 'EQ-1');
        check('identidad: pos_device_id conserva el del equipo (DEV-1)', leer(ctx, 'pos_device_id') === 'DEV-1');
        const pInstall = proteccionDe(res, 'pos_install_id');
        const pDevice = proteccionDe(res, 'pos_device_id');
        check('identidad: se informa de las dos protecciones con su valor final',
            !!pInstall && pInstall.valorFinal === 'EQ-1' &&
            !!pDevice && pDevice.valorFinal === 'DEV-1');
        check('identidad: el motivo explica que identifica a este equipo',
            /equipo/i.test(pInstall.motivo) && /equipo/i.test(pDevice.motivo));
        check('identidad: el dato del respaldo que no está protegido sí entra',
            leer(ctx, 'ciervo_inventory') === '[{"id":"VIEJO"}]');
        check('identidad: las 2 protegidas no se cuentan como restauradas (restauradas = 1)',
            res.restauradas === 1);
    }

    // (b) El equipo NO tiene identificadores: se aceptan los del respaldo.
    {
        const ctx = crearContexto({ ciervo_inventory: '[]' });
        const res = await restaurar(ctx, { pos_install_id: 'EQ-9', pos_device_id: 'DEV-9' });
        check('sin identidad previa: se aceptan los dos del respaldo',
            leer(ctx, 'pos_install_id') === 'EQ-9' && leer(ctx, 'pos_device_id') === 'DEV-9');
        check('sin identidad previa: no se informa de protección',
            res.ok === true && res.protegidas.length === 0 && res.restauradas === 2);
    }

    // (c) Identificador presente pero vacío en el equipo: se acepta el del respaldo.
    {
        const ctx = crearContexto({ pos_install_id: '   ' });
        const res = await restaurar(ctx, { pos_install_id: 'EQ-3' });
        check('identidad vacía en el equipo: se acepta la del respaldo (EQ-3)',
            leer(ctx, 'pos_install_id') === 'EQ-3' && res.protegidas.length === 0);
    }

    // (d) Caso mixto: solo uno de los dos está en el equipo.
    {
        const ctx = crearContexto({ pos_device_id: 'DEV-LOCAL' });
        const res = await restaurar(ctx, { pos_install_id: 'EQ-NUBE', pos_device_id: 'DEV-NUBE' });
        check('mixto: se conserva el del equipo y se acepta el que faltaba',
            leer(ctx, 'pos_device_id') === 'DEV-LOCAL' && leer(ctx, 'pos_install_id') === 'EQ-NUBE');
        check('mixto: solo se informa de la protegida (DEV-LOCAL)',
            res.protegidas.length === 1 && res.protegidas[0].clave === 'pos_device_id');
    }
}

async function probarRestoDeClaves() {
    titulo('4. El resto de claves se restaura igual que antes (no se debilita lo ya probado)');

    // (a) Restauración normal: todas las claves del respaldo se escriben y se cuentan.
    {
        const datos = {
            ciervo_inventory: '[{"id":"P-1"}]',
            ciervo_suppliers: '[{"id":1}]',
            ciervo_purchases: '[]',
            ciervo_inventory_history: '[]',
            ciervo_clients: '[{"id":"C-1"}]',
            ciervo_accounts: '[]',
            companyData: '{"nombre":"Demo"}',
            pos_exchange_rate: '36.5'
        };
        const ctx = crearContexto({ ciervo_inventory: '[{"id":"VIEJO"}]', pos_exchange_rate: '10' });
        const res = await restaurar(ctx, datos);
        check('restauración normal: ok y sin protecciones',
            res.ok === true && res.protegidas.length === 0);
        check('restauración normal: se cuentan las 8 claves', res.restauradas === 8);
        let todas = true;
        Object.keys(datos).forEach(function (k) { if (leer(ctx, k) !== datos[k]) todas = false; });
        check('restauración normal: las 8 claves quedan con el valor del respaldo', todas);
        check('restauración normal: los campos de siempre siguen ahí (ok, restauradas, error)',
            res.ok === true && res.restauradas === 8 && res.error === null);
    }

    // (b) Las validaciones previas siguen intactas.
    {
        const ctx = crearContexto({ ciervo_inventory: '["INTACTO"]' });
        const rJson = await restaurar(ctx, null, { texto: '{no es json' });
        check('JSON inválido: no se restaura nada y la clave previa sigue intacta',
            rJson.ok === false && /JSON válido/.test(rJson.error) && leer(ctx, 'ciervo_inventory') === '["INTACTO"]');

        const rForma = await restaurar(ctx, null, { texto: JSON.stringify({ datos: {} }) });
        check('Sin "version": se rechaza y no se toca el almacén',
            rForma.ok === false && leer(ctx, 'ciervo_inventory') === '["INTACTO"]');

        const rVacio = await restaurar(ctx, {});
        check('Respaldo sin datos: se rechaza',
            rVacio.ok === false && /no contiene datos/.test(rVacio.error));

        const ctxTipo = crearContexto({ ciervo_inventory: '["INTACTO"]' });
        const rTipo = await restaurar(ctxTipo, null, {
            texto: JSON.stringify({ version: 1, datos: { ciervo_inventory: 123 } })
        });
        check('Valor no textual: se rechaza y no se escribe nada',
            rTipo.ok === false && /no válido/.test(rTipo.error) && leer(ctxTipo, 'ciervo_inventory') === '["INTACTO"]');

        const ctxProhibida = crearContexto({ ciervo_inventory: '["INTACTO"]' });
        const rProhibida = await restaurar(ctxProhibida, null, {
            texto: JSON.stringify({ version: 1, datos: { ciervo_inventory: '[]', sesionActiva: 'x' } })
        });
        check('Clave prohibida en el respaldo: se rechaza sin restaurar nada',
            rProhibida.ok === false && /protegida/.test(rProhibida.error) &&
            leer(ctxProhibida, 'ciervo_inventory') === '["INTACTO"]');

        const ctxCancel = crearContexto({ ciervo_inventory: '["INTACTO"]' });
        const rCancel = await restaurar(ctxCancel, { ciervo_inventory: '[]' }, { confirmar: false });
        check('Cancelado por el usuario: no se escribe nada',
            rCancel.ok === false && /cancelada/.test(rCancel.error) &&
            leer(ctxCancel, 'ciervo_inventory') === '["INTACTO"]');
    }

    // (c) Forma del resultado estable: `protegidas` siempre es una lista.
    {
        const ctx = crearContexto({});
        const r = await restaurar(ctx, null, { texto: 'no-json' });
        const r2 = await restaurar(ctx, { ciervo_inventory: '[]' });
        check('`protegidas` está siempre presente (también en los fallos)',
            Array.isArray(r.protegidas) && r.protegidas.length === 0 &&
            Array.isArray(r2.protegidas) && r2.protegidas.length === 0);
    }
}

async function probarCuota() {
    titulo('5. Un fallo de cuota a mitad sigue revirtiendo sin dejar basura');

    // (a) Fallo puntual en la 3ª escritura de 4 claves: se revierte todo.
    {
        const previos = {
            ciervo_suppliers: '["PROVEEDOR-VIEJO"]',
            ciervo_purchases: '["COMPRA-VIEJA"]'
        };
        const ctx = crearContexto(previos, { fallarEnEscribir: 3 });
        const res = await restaurar(ctx, {
            ciervo_inventory: '["INVENTARIO-NUEVO"]',
            ciervo_suppliers: '["PROVEEDOR-NUEVO"]',
            ciervo_purchases: '["COMPRA-NUEVA"]',
            ciervo_inventory_history: '["HISTORIAL-NUEVO"]'
        });
        check('cuota a mitad: la restauración falla con ok = false', res.ok === false);
        check('cuota a mitad: el error avisa de que se devolvieron los datos anteriores',
            /devolvieron los datos anteriores/.test(res.error));
        check('cuota a mitad: las claves que ya existían vuelven a su valor previo',
            leer(ctx, 'ciervo_suppliers') === '["PROVEEDOR-VIEJO"]' &&
            leer(ctx, 'ciervo_purchases') === '["COMPRA-VIEJA"]');
        check('cuota a mitad: la clave escrita antes del fallo se revierte (no queda basura nueva)',
            leer(ctx, 'ciervo_inventory') === null);
        check('cuota a mitad: la clave posterior al fallo nunca se escribió',
            leer(ctx, 'ciervo_inventory_history') === null);
        check('cuota a mitad: se informa restauradas = 0', res.restauradas === 0);
    }

    // (b) Cuota llena desde el principio: no se toca nada.
    {
        const ctx = crearContexto({ ciervo_inventory: '["INTACTO"]' }, { fallarSiempre: true });
        const res = await restaurar(ctx, { ciervo_inventory: '[]', ciervo_clients: '[]' });
        check('cuota llena: falla sin escribir y sin lanzar', res.ok === false && res.restauradas === 0);
        check('cuota llena: el dato anterior queda intacto',
            leer(ctx, 'ciervo_inventory') === '["INTACTO"]' && leer(ctx, 'ciervo_clients') === null);
    }

    // (c) La clave protegida NO se escribe: aunque esa clave sea la que falla por
    //     cuota, la restauración de las demás puede completarse.
    {
        const ctx = crearContexto({ pos_last_sale_number: '200' }, { fallarEnClave: 'pos_last_sale_number' });
        const res = await restaurar(ctx, { pos_last_sale_number: '150', ciervo_clients: '[]' });
        check('clave protegida que falla por cuota: no se escribe y el contador del equipo sigue en 200',
            leer(ctx, 'pos_last_sale_number') === '200');
        check('clave protegida que falla por cuota: el resto sí se restaura (ok, restauradas = 1)',
            leer(ctx, 'ciervo_clients') === '[]' && res.ok === true && res.restauradas === 1 &&
            !!proteccionDe(res, 'pos_last_sale_number'));
    }
}

async function probarAislamientoPorCuenta() {
    titulo('6. Compatibilidad con el aislamiento por cuenta (datos_cuenta.js real)');

    const ctx = crearContexto({ datosDeCuenta: 'demo_at_x_com' }, {
        scripts: ['datos_cuenta.js', 'almacenamiento.js']
    });
    const estado = ctx.window.datosCuenta.estado();
    check('el aislamiento por cuenta quedó activo con el prefijo esperado',
        estado.activa === true && estado.prefijo === 'cuenta:demo_at_x_com:' &&
        estado.interceptado === true);

    // Datos del equipo, escritos por la API normal (la clave lógica se prefija sola).
    ctx.window.localStorage.setItem('pos_last_sale_number', '105');
    ctx.window.localStorage.setItem('ciervo_inventory', '["DEL-EQUIPO"]');

    const res = await restaurar(ctx, {
        pos_last_sale_number: '100',
        ciervo_inventory: '["DEL-RESPALDO"]',
        ciervo_clients: '[]'
    });

    // `_datos` es el Map FÍSICO: con la intercepción activa, getItem() ya aplica el
    // prefijo, así que aquí se comprueba lo que hay realmente guardado en el almacén.
    const fisico = ctx._almacen._datos;

    check('restauración con cuenta activa: termina ok', res.ok === true);
    check('restauración con cuenta activa: el contador del equipo no retrocede',
        ctx.window.localStorage.getItem('pos_last_sale_number') === '105');
    check('restauración con cuenta activa: el resto se escribe en la cuenta',
        ctx.window.localStorage.getItem('ciervo_inventory') === '["DEL-RESPALDO"]' &&
        ctx.window.localStorage.getItem('ciervo_clients') === '[]');
    check('restauración con cuenta activa: todo queda en las claves FÍSICAS prefijadas',
        fisico.get('cuenta:demo_at_x_com:pos_last_sale_number') === '105' &&
        fisico.get('cuenta:demo_at_x_com:ciervo_inventory') === '["DEL-RESPALDO"]' &&
        fisico.get('cuenta:demo_at_x_com:ciervo_clients') === '[]');
    check('restauración con cuenta activa: no se creó ninguna clave sin prefijo',
        fisico.has('pos_last_sale_number') === false &&
        fisico.has('ciervo_inventory') === false &&
        fisico.has('ciervo_clients') === false);
    check('restauración con cuenta activa: la protección se informa igual',
        !!proteccionDe(res, 'pos_last_sale_number') && res.restauradas === 2);
}

/* ------------------------------------------------------------------ */
/* Ejecución                                                          */
/* ------------------------------------------------------------------ */
(async function () {
    console.log('Pruebas de restaurarRespaldo() — protección del contador de tickets y de la identidad del equipo');
    console.log('Node ' + process.version + ' · ' + new Date().toISOString());

    probarSintaxis();
    await probarContador();
    await probarIdentidad();
    await probarRestoDeClaves();
    await probarCuota();
    await probarAislamientoPorCuenta();

    console.log('\n----------------------------------------');
    console.log('RESULTADO: ' + (pruebas - fallos) + '/' + pruebas + ' comprobaciones OK' + (fallos ? ' · ' + fallos + ' FALLA(S)' : ' · sin fallos'));
    process.exit(fallos ? 1 : 0);
})().catch(function (e) {
    console.error('ERROR INESPERADO EN LAS PRUEBAS:', e);
    process.exit(1);
});
