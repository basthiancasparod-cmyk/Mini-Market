/**
 * pruebas_catalogo_fusion.js
 *
 * Punto C del relevo: el catálogo (catalogo.html) SOLO subía. Y subía con un
 * `.set()` de todo el nodo `productos`, con su copia local dentro, así que una
 * copia vieja pisaba el stock real de la nube.
 *
 * Ahora DESCARGA, FUSIONA por id y escribe SOLO los campos del catálogo con
 * `update()`. Esta suite fija ese contrato ejecutando las funciones REALES
 * extraídas del HTML (no una reimplementación), sobre un Firebase y un
 * localStorage falsos.
 *
 * Lo que se comprueba, en corto:
 *   1. la nube manda en el stock, los precios y todo lo que el catálogo no edita;
 *   2. el local manda en los SEIS campos del catálogo (images, mainImageIndex,
 *      imageUrl, description, visible, specs);
 *   3. la lista resultante es la de la nube (el catálogo no crea ni borra);
 *   4. se escribe en la CLAVE REAL de la nube, no en `productos/<id>`: el nodo
 *      está indexado por POSICIÓN, así que `productos/<id>` crearía productos
 *      fantasma;
 *   5. si la nube no se puede leer, NO se sube nada;
 *   6. el stock y el precio NO viajan en el payload;
 *   7. la descarga al abrir respeta la Fase A (no pisa cambios pendientes);
 *   8. y se deja anclado POR QUÉ no se reutiliza `mergeInventoryWithLocal` tal
 *      cual: su precedencia de `images` es la contraria y revertiría las
 *      imágenes que el catálogo acaba de editar.
 *
 * No necesita navegador ni Firebase.
 * Uso:  node pruebas_catalogo_fusion.js
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

/** Extrae una función declarada a 8 espacios de indentación (estilo del proyecto). */
function extraer(html, nombre) {
    const re = new RegExp('(?:async )?function ' + nombre + '\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n {8}\\}');
    const m = html.match(re);
    return m ? m[0] : null;
}

// OJO: el orden importa porque se compara con un JSON. Es el orden que deja
// Array.prototype.sort() (lexicografico por codigo UTF-16), no el orden en que
// estan escritos en el HTML: 'imageUrl' va ANTES que 'images' porque 'U' < 's'.
const CAMPOS_CATALOGO = ['description', 'imageUrl', 'images', 'mainImageIndex', 'specs', 'visible'];

/* ------------------------------------------------------------------ */
/* 1. Productos de ejemplo                                            */
/* ------------------------------------------------------------------ */

function productoLocal(extra) {
    return Object.assign({
        id: 1, name: 'Producto', code: 'P1',
        stock: 999, price: 100, cost: 50,          // copia local VIEJA
        images: ['local0.png', 'local1.png', 'local2.png'],
        mainImageIndex: 2,
        imageUrl: 'local0.png',
        description: 'descripcion local',
        visible: false,
        specs: { color: 'rojo', material: 'local' }
    }, extra || {});
}

function productoNube(extra) {
    return Object.assign({
        id: 1, name: 'Producto', code: 'P1',
        stock: 3, price: 100, cost: 50,            // estado REAL de la nube
        images: ['nube0.png'],
        mainImageIndex: 0,
        imageUrl: 'nube0.png',
        description: 'descripcion nube',
        visible: true,
        specs: { color: 'azul', material: 'nube', peso: '1kg' }
    }, extra || {});
}

/* ------------------------------------------------------------------ */
/* 2. Entorno falso (Firebase + localStorage)                         */
/* ------------------------------------------------------------------ */

function crearEntorno(op) {
    op = op || {};
    const almacen = new Map();
    if (op.local) Object.keys(op.local).forEach(k => almacen.set(String(k), String(op.local[k])));

    const registro = { lecturas: [], updates: [], sets: [], marcas: [], limpiezas: [] };

    const db = {
        ref: function (ruta) {
            return {
                once: function () {
                    registro.lecturas.push(ruta);
                    return Promise.resolve({ val: function () { return op.nube === undefined ? null : op.nube; } });
                },
                update: function (cambios) { registro.updates.push({ ruta: ruta, cambios: cambios }); return Promise.resolve(); },
                set: function (datos) { registro.sets.push({ ruta: ruta, datos: datos }); return Promise.resolve(); }
            };
        }
    };

    const ctx = {
        console: console,
        JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
        Boolean: Boolean, Date: Date, Math: Math, Promise: Promise,
        isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
        localStorage: {
            getItem: function (k) { k = String(k); return almacen.has(k) ? almacen.get(k) : null; },
            setItem: function (k, v) { almacen.set(String(k), String(v)); },
            removeItem: function (k) { almacen.delete(String(k)); },
            key: function (i) { const ks = Array.from(almacen.keys()); return ks[i] === undefined ? null : ks[i]; },
            get length() { return almacen.size; }
        },
        guardarLocalSeguro: function (clave, valor) { almacen.set(String(clave), String(valor)); return { ok: true }; },
        checkCloudAccess: function () { return Promise.resolve(op.nubePermitida !== false); },
        initFirebase: function () { return Promise.resolve(op.sinDb ? null : db); },
        getUserDataPath: function () { return 'BBDD/negocio_at_x_com'; },
        marcarPendienteSync: function (m) { registro.marcas.push(m); },
        limpiarPendienteSync: function (m) { registro.limpiezas.push(m); },
        renderAll: function () {},
        puedeSobrescribirLocalSync: function () { return op.puedeSobrescribir !== false; },
        products: op.products || [],
        _pendingFirebaseChanges: false
    };
    ctx.window = ctx;
    return { ctx: ctx, almacen: almacen, registro: registro, db: db };
}

/** Carga las funciones reales de catalogo.html en un entorno falso. */
function cargarCatalogo(op) {
    const html = leer('catalogo.html');
    const nombres = ['firebaseLoadProducts', 'fusionarCatalogoConNube', 'sincronizarCatalogoConNube', 'firebaseSaveProducts'];
    const partes = nombres.map(function (n) {
        const c = extraer(html, n);
        if (!c) throw new Error('No se pudo extraer ' + n + ' de catalogo.html');
        return c;
    });
    const e = crearEntorno(op);
    vm.createContext(e.ctx);
    vm.runInContext(partes.join('\n\n'), e.ctx, { filename: 'catalogo.html#funciones' });
    e.html = html;
    return e;
}

/** Ruta del producto dentro del payload de update(), sin el campo final. */
function rutasDelUpdate(registro) {
    const rutas = [];
    registro.updates.forEach(function (u) { Object.keys(u.cambios).forEach(function (k) { rutas.push(k); }); });
    return rutas;
}

/** Lee la copia local de productos del almacén falso. */
function productosEnAlmacen(e) {
    const bruto = e.almacen.get('ciervo_inventory');
    return bruto === undefined ? null : JSON.parse(bruto);
}

/* ------------------------------------------------------------------ */
/* 3. La fusión (funciones reales)                                    */
/* ------------------------------------------------------------------ */
function probarFusion() {
    titulo('1. Fusion por id: la nube manda en el stock, el local en el catalogo');

    const e = cargarCatalogo({ products: [productoLocal()] });
    const nube = [productoNube()];
    const r = e.ctx.fusionarCatalogoConNube(nube, e.ctx.products);
    const p = r[0];

    check('T1 · el stock lo manda la NUBE (999 local no pisa el 3 real)', p.stock === 3, 'stock=' + p.stock);
    check('T2 · el precio y el costo los manda la NUBE',
        p.price === 100 && p.cost === 50, JSON.stringify({ price: p.price, cost: p.cost }));
    check('T3 · el nombre y el codigo los manda la NUBE',
        p.name === 'Producto' && p.code === 'P1');

    check('T4 · las IMAGENES las manda el LOCAL (no se revierte la edicion del catalogo)',
        JSON.stringify(p.images) === JSON.stringify(['local0.png', 'local1.png', 'local2.png']),
        JSON.stringify(p.images));
    check('T5 · mainImageIndex e imageUrl los manda el LOCAL',
        p.mainImageIndex === 2 && p.imageUrl === 'local0.png',
        JSON.stringify({ i: p.mainImageIndex, u: p.imageUrl }));
    check('T6 · description y visible los manda el LOCAL',
        p.description === 'descripcion local' && p.visible === false,
        JSON.stringify({ d: p.description, v: p.visible }));
    check('T7 · specs se fusiona campo a campo (local gana, lo que solo esta en la nube se conserva)',
        p.specs.color === 'rojo' && p.specs.material === 'local' && p.specs.peso === '1kg',
        JSON.stringify(p.specs));

    // Membresia: la lista resultante es la de la nube.
    const r2 = e.ctx.fusionarCatalogoConNube(
        [productoNube({ id: 1 })],
        [productoLocal({ id: 1 }), productoLocal({ id: 42, name: 'Solo local' })]);
    check('T8 · un producto que solo existe en LOCAL no resucita (no esta en el resultado)',
        r2.length === 1 && !r2.some(x => String(x.id) === '42'),
        'resultado=' + JSON.stringify(r2.map(x => x.id)));

    const r3 = e.ctx.fusionarCatalogoConNube(
        [productoNube({ id: 1 }), productoNube({ id: 77, name: 'Solo nube' })],
        [productoLocal({ id: 1 })]);
    check('T9 · un producto que solo existe en la NUBE entra tal cual',
        r3.length === 2 && r3.some(x => String(x.id) === '77' && x.name === 'Solo nube'),
        'resultado=' + JSON.stringify(r3.map(x => x.name)));

    const r4 = e.ctx.fusionarCatalogoConNube([productoNube({ id: 5 })], []);
    check('T10 · si el local no lo tiene, se queda el de la nube (sin campos inventados)',
        r4[0].stock === 3 && r4[0].description === 'descripcion nube');
}

/* ------------------------------------------------------------------ */
/* 4. Por qué NO se reutiliza mergeInventoryWithLocal                 */
/* ------------------------------------------------------------------ */
function probarDiferenciaConInventario() {
    titulo('2. Anclaje: mergeInventoryWithLocal NO sirve tal cual para el catalogo');

    const inv = leer('inventario.html');
    const codigo = extraer(inv, 'mergeInventoryWithLocal');
    check('T11 · se pudo extraer mergeInventoryWithLocal de inventario.html', !!codigo);
    if (!codigo) return;

    const local = [productoLocal()];
    const nube = [productoNube()];

    // La de inventario: lee el local del almacen.
    const eInv = crearEntorno({ local: { ciervo_inventory: JSON.stringify(local) } });
    vm.createContext(eInv.ctx);
    vm.runInContext(codigo, eInv.ctx, { filename: 'inventario.html#mergeInventoryWithLocal' });
    const rInv = eInv.ctx.mergeInventoryWithLocal(nube);

    const eCat = cargarCatalogo({ products: local });
    const rCat = eCat.ctx.fusionarCatalogoConNube(nube, local);

    check('T12 · la de inventario prefiere las imagenes de la NUBE (por eso no se reutiliza)',
        JSON.stringify(rInv[0].images) === JSON.stringify(['nube0.png']),
        JSON.stringify(rInv[0].images));
    check('T13 · la del catalogo prefiere las del LOCAL: son distintas en images',
        JSON.stringify(rCat[0].images) !== JSON.stringify(rInv[0].images),
        'catalogo=' + JSON.stringify(rCat[0].images) + ' inventario=' + JSON.stringify(rInv[0].images));
    check('T14 · fuera de images, las dos coinciden (misma eleccion de campos)',
        rCat[0].description === rInv[0].description &&
        rCat[0].visible === rInv[0].visible &&
        rCat[0].stock === rInv[0].stock &&
        JSON.stringify(rCat[0].specs) === JSON.stringify(rInv[0].specs),
        JSON.stringify({ cat: [rCat[0].description, rCat[0].visible, rCat[0].stock], inv: [rInv[0].description, rInv[0].visible, rInv[0].stock] }));
}

/* ------------------------------------------------------------------ */
/* 5. La escritura: update() quirurgico                               */
/* ------------------------------------------------------------------ */
async function probarEscritura() {
    titulo('3. Al guardar: descarga, fusiona y escribe SOLO los campos del catalogo');

    // La nube esta indexada por POSICION: la clave '2' guarda el producto id 7.
    const nubeCruda = { '0': productoNube({ id: 4 }), '2': productoNube({ id: 7 }) };
    const e = cargarCatalogo({
        nube: nubeCruda,
        local: { ciervo_inventory: JSON.stringify([productoLocal({ id: 4 }), productoLocal({ id: 7 }), productoLocal({ id: 99 })]) },
        products: [productoLocal({ id: 4 }), productoLocal({ id: 7 }), productoLocal({ id: 99 })]
    });

    const devuelto = await e.ctx.firebaseSaveProducts();

    check('T15 · la funcion real de guardado termina sin lanzar', devuelto === true, 'devuelto=' + devuelto);
    check('T16 · se leyo la nube antes de escribir', e.registro.lecturas.some(r => /\/productos$/.test(r)),
        JSON.stringify(e.registro.lecturas));
    check('T17 · se usa update(), NO set(), sobre productos',
        e.registro.updates.length === 1 && e.registro.sets.filter(s => /productos/.test(s.ruta)).length === 0,
        'updates=' + e.registro.updates.length + ' sets=' + e.registro.sets.length);

    const rutas = rutasDelUpdate(e.registro);
    const campos = Array.from(new Set(rutas.map(r => r.split('/')[1]))).sort();

    check('T18 · se escribe SOLO los 6 campos del catalogo',
        JSON.stringify(campos) === JSON.stringify(CAMPOS_CATALOGO.slice().sort()), JSON.stringify(campos));
    check('T19 · el stock, el precio y el costo NO viajan en el payload',
        !rutas.some(r => /\/(stock|price|cost|name|code)$/.test(r)), JSON.stringify(rutas));
    check('T20 · se escribe en la CLAVE REAL de la nube (0/ y 2/), no en productos/<id>',
        rutas.some(r => r.indexOf('0/') === 0) && rutas.some(r => r.indexOf('2/') === 0),
        JSON.stringify(rutas));
    check('T21 · NO se escribe productos/4 ni productos/7 (eso crearia productos fantasma)',
        !rutas.some(r => r.indexOf('4/') === 0 || r.indexOf('7/') === 0), JSON.stringify(rutas));
    check('T22 · un producto que solo existe en LOCAL no se crea en la nube',
        !rutas.some(r => r.indexOf('99/') === 0), JSON.stringify(rutas));

    const guardados = productosEnAlmacen(e);
    check('T23 · la copia local queda refrescada con el stock de la NUBE',
        guardados && guardados.length === 2 && guardados.every(p => p.stock === 3),
        JSON.stringify(guardados && guardados.map(p => [p.id, p.stock])));
    check('T24 · la marca de pendiente se limpia al confirmar el servidor',
        e.registro.limpiezas.indexOf('catalogo') !== -1 && e.registro.marcas.indexOf('catalogo') !== -1,
        'marcas=' + JSON.stringify(e.registro.marcas) + ' limpiezas=' + JSON.stringify(e.registro.limpiezas));
}

async function probarSinNube() {
    titulo('4. Cuando la nube no se puede leer: no se escribe NADA');

    const e = cargarCatalogo({ nube: null, products: [productoLocal()] });
    const devuelto = await e.ctx.firebaseSaveProducts();
    check('T25 · devuelve false', devuelto === false, 'devuelto=' + devuelto);
    check('T26 · no hubo ni un update() ni un set()',
        e.registro.updates.length === 0 && e.registro.sets.length === 0,
        JSON.stringify({ u: e.registro.updates.length, s: e.registro.sets.length }));
    check('T27 · la marca de pendiente NO se limpia (se reintentara)',
        e.registro.limpiezas.indexOf('catalogo') === -1 && e.registro.marcas.indexOf('catalogo') !== -1,
        JSON.stringify({ m: e.registro.marcas, l: e.registro.limpiezas }));

    const e2 = cargarCatalogo({ nubePermitida: false, products: [productoLocal()] });
    const devuelto2 = await e2.ctx.firebaseSaveProducts();
    check('T28 · sin permiso de nube (cloudSync off) no lee ni escribe',
        devuelto2 === false && e2.registro.lecturas.length === 0 && e2.registro.updates.length === 0,
        JSON.stringify(e2.registro));
}

/* ------------------------------------------------------------------ */
/* 6. La descarga al abrir                                            */
/* ------------------------------------------------------------------ */
async function probarDescargaAlAbrir() {
    titulo('5. Al abrir la pagina: descarga y fusiona, respetando la Fase A');

    const e = cargarCatalogo({
        nube: { '0': productoNube({ id: 4, stock: 3 }) },
        local: { ciervo_inventory: JSON.stringify([productoLocal({ id: 4, stock: 999 })]) },
        products: [productoLocal({ id: 4, stock: 999 })]
    });
    const r = await e.ctx.sincronizarCatalogoConNube();
    check('T29 · descarga y devuelve true', r === true, 'devuelto=' + r);
    check('T30 · el stock en memoria pasa a ser el de la nube',
        e.ctx.products.length === 1 && e.ctx.products[0].stock === 3,
        JSON.stringify(e.ctx.products.map(p => p.stock)));
    check('T31 · el almacen local tambien queda con el stock de la nube',
        (productosEnAlmacen(e) || [])[0] && productosEnAlmacen(e)[0].stock === 3,
        JSON.stringify(productosEnAlmacen(e)));
    check('T32 · las imagenes del local se conservan al descargar',
        JSON.stringify(e.ctx.products[0].images) === JSON.stringify(['local0.png', 'local1.png', 'local2.png']),
        JSON.stringify(e.ctx.products[0].images));

    const e2 = cargarCatalogo({
        nube: { '0': productoNube({ id: 4, stock: 3 }) },
        products: [productoLocal({ id: 4, stock: 999 })],
        puedeSobrescribir: false
    });
    const r2 = await e2.ctx.sincronizarCatalogoConNube();
    check('T33 · Fase A: con cambios pendientes NO descarga (no pisa lo local)',
        r2 === false && e2.registro.lecturas.length === 0 && e2.ctx.products[0].stock === 999,
        JSON.stringify({ r: r2, lecturas: e2.registro.lecturas, stock: e2.ctx.products[0].stock }));

    const e3 = cargarCatalogo({ nube: null, products: [productoLocal({ id: 4, stock: 999 })] });
    const r3 = await e3.ctx.sincronizarCatalogoConNube();
    check('T34 · si la nube esta vacia o falla, se queda con lo local (no vacia la lista)',
        r3 === false && e3.ctx.products.length === 1 && e3.ctx.products[0].stock === 999,
        JSON.stringify(e3.ctx.products));
}

/* ------------------------------------------------------------------ */
/* 7. Invariantes del archivo                                         */
/* ------------------------------------------------------------------ */
function probarArchivo() {
    titulo('6. Invariantes sobre catalogo.html');

    const html = leer('catalogo.html');

    check('T35 · ya NO hace .set() del nodo productos',
        !/\/productos'\)\.set\(/.test(html));
    check('T36 · SI hace .update() del nodo productos',
        /\/productos'\)\.update\(/.test(html));
    check('T37 · carga sincronizacion.js (marcas de pendiente y guardia de descarga)',
        /src=["']sincronizacion\.js["']/.test(html));
    check('T38 · tiene la guardia de descarga de la Fase A',
        html.indexOf('puedeSobrescribirLocalSync') !== -1);
    check('T39 · la descarga se dispara al cargar la lista de productos',
        /sincronizarCatalogoConNube\(\)/.test(html) && /loadProducts\(\);/.test(html));

    const camposEscritos = Array.from(new Set(
        Array.from(html.matchAll(/cambios\[claveNube \+ '\/(\w+)'\]/g)).map(m => m[1]))).sort();
    check('T40 · el payload del update se construye con exactamente los 6 campos del catalogo',
        JSON.stringify(camposEscritos) === JSON.stringify(CAMPOS_CATALOGO.slice().sort()), JSON.stringify(camposEscritos));

    check('T41 · se escribe en la clave real de la nube (nube.claves), no en p.id',
        /nube\.claves\[String\(p\.id\)\]/.test(html));
    check('T42 · catalogo.html es CRLF (sin LF sueltos)',
        html.indexOf('\r\n') !== -1 && !/[^\r]\n/.test(html));

    // Las tres escrituras locales de la pagina siguen bajo el guardian de cuota.
    const setItems = (html.match(/localStorage\.setItem\('ciervo_inventory'/g) || []).length;
    const guardianes = (html.match(/guardarLocalSeguro\('ciervo_inventory'/g) || []).length;
    check('T43 · las escrituras locales de ciervo_inventory siguen bajo el guardian de cuota (' +
        setItems + ' con respaldo / ' + guardianes + ' con guardian)',
        setItems >= 1 && setItems === guardianes);
}

/* ------------------------------------------------------------------ */
/* Ejecución                                                          */
/* ------------------------------------------------------------------ */
(async function () {
    console.log('Pruebas de la fusion del catalogo (punto C)');
    console.log('Node ' + process.version + ' · ' + new Date().toISOString());

    probarFusion();
    probarDiferenciaConInventario();
    await probarEscritura();
    await probarSinNube();
    await probarDescargaAlAbrir();
    probarArchivo();

    console.log('\n----------------------------------------');
    console.log('RESULTADO: ' + (pruebas - fallos) + '/' + pruebas + ' comprobaciones OK' + (fallos ? ' · ' + fallos + ' FALLA(S)' : ' · sin fallos'));
    process.exit(fallos ? 1 : 0);
})().catch(function (e) {
    console.error('ERROR INESPERADO EN LAS PRUEBAS:', e);
    process.exit(1);
});
