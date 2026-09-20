/**
 * Pruebas de la ELIMINACIÓN DE DATOS DE MUESTRA (productos, cuentas, proveedores,
 * categorías, empresa y el usuario administrador demo del reinicio de fábrica).
 *
 * Qué comprueba:
 *   1. Ninguna página ni .js del proyecto contiene ya arreglos de datos de ejemplo.
 *   2. Las funciones REALES que antes sembraban (extraídas del HTML) con un almacén
 *      vacío no escriben NINGUNA clave y devuelven estructuras vacías.
 *   3. El arranque de inventario.html, cuentas.html, gestion_proveedores.html y
 *      menu.html (funciones reales) deja las listas vacías y con CERO escrituras.
 *   4. El reinicio de fábrica de config.html ya no crea ningún usuario de ejemplo
 *      (comprobado sobre el texto y ejecutando sus pasos reales).
 *   5. El diagnóstico de "datos sospechosos" del panel Avanzado detecta una lista de
 *      ejemplo inyectada a mano y NO borra ni escribe nada.
 *   6. Integridad: CRLF en las páginas tocadas y que las funciones sigan existiendo.
 *
 * Ejecutar:  node pruebas_sin_datos_muestra.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const RAIZ = __dirname;
const leer = (archivo) => fs.readFileSync(path.join(RAIZ, archivo), 'utf8').replace(/\r\n/g, '\n');

let ok = 0, fallos = 0;
function check(nombre, condicion, extra) {
    if (condicion) { ok++; console.log('OK    ' + nombre); }
    else { fallos++; console.log('FALLA ' + nombre + (extra ? ' -> ' + extra : '')); }
}
function titulo(texto) { console.log('\n================ ' + texto + ' ================'); }
function eq(nombre, obtenido, esperado) {
    check(nombre, obtenido === esperado, 'esperado ' + JSON.stringify(esperado) + ', obtenido ' + JSON.stringify(obtenido));
}

/* ------------------------------------------------------------------ */
/* Utilidades: quitar comentarios, extraer bloques reales del HTML     */
/* ------------------------------------------------------------------ */

/** Quita comentarios de línea y de bloque respetando cadenas (no corta 'https://'). */
function sinComentarios(codigo) {
    let salida = '';
    let i = 0;
    const n = codigo.length;
    while (i < n) {
        const c = codigo[i], d = codigo[i + 1];
        if (c === '/' && d === '/') { while (i < n && codigo[i] !== '\n') i++; continue; }
        if (c === '/' && d === '*') {
            i += 2;
            while (i < n && !(codigo[i] === '*' && codigo[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const comilla = c;
            salida += c; i++;
            while (i < n) {
                if (codigo[i] === '\\') { salida += codigo[i] + (codigo[i + 1] || ''); i += 2; continue; }
                salida += codigo[i];
                if (codigo[i] === comilla) { i++; break; }
                i++;
            }
            continue;
        }
        salida += c; i++;
    }
    return salida;
}

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

/** Extrae una función declarada: `function nombre(...) { ... }`. */
function extraerFuncion(texto, nombre) {
    const marca = 'function ' + nombre + '(';
    const i = texto.indexOf(marca);
    if (i === -1) throw new Error('no se encontró la función ' + nombre);
    /* Respeta el 'async' de delante (loadSuppliersFromFirebase es async). */
    const antes = texto.slice(Math.max(0, i - 6), i);
    return extraerBloque(texto, /async\s$/.test(antes) ? i - 6 : i);
}

/** Extrae un método de clase: `nombre() { ... }`. */
function extraerMetodo(texto, nombre) {
    const marca = nombre + '() {';
    const i = texto.indexOf(marca);
    if (i === -1) throw new Error('no se encontró el método ' + nombre);
    if (texto.indexOf(marca, i + 1) !== -1) throw new Error('método ambiguo: ' + nombre);
    return extraerBloque(texto, i);
}

/* ------------------------------------------------------------------ */
/* localStorage falso: las claves guardadas son propiedades propias    */
/* enumerables (como en el navegador) y los métodos viven en el        */
/* prototipo, así Object.keys(almacen) devuelve las CLAVES guardadas.  */
/* ------------------------------------------------------------------ */
const PROTO_ALMACEN = {
    getItem: function (k) { k = String(k); return this._datos.has(k) ? this._datos.get(k) : null; },
    setItem: function (k, v) {
        k = String(k);
        this._escrituras.push(k);
        this._datos.set(k, String(v));
        Object.defineProperty(this, k, { value: String(v), enumerable: true, writable: true, configurable: true });
    },
    removeItem: function (k) {
        k = String(k);
        this._borrados.push(k);
        this._datos.delete(k);
        delete this[k];
    },
    clear: function () { Array.from(this._datos.keys()).forEach((k) => this.removeItem(k)); },
    key: function (i) { return Array.from(this._datos.keys())[i] || null; }
};

function almacenFalso(inicial) {
    const almacen = Object.create(PROTO_ALMACEN);
    Object.defineProperty(almacen, '_datos', { value: new Map(), enumerable: false });
    Object.defineProperty(almacen, '_escrituras', { value: [], enumerable: false });
    Object.defineProperty(almacen, '_borrados', { value: [], enumerable: false });
    Object.defineProperty(almacen, 'length', { get: function () { return almacen._datos.size; } });
    Object.keys(inicial || {}).forEach((k) => {
        const clave = String(k);
        const valor = String(inicial[k]);
        almacen._datos.set(clave, valor);
        Object.defineProperty(almacen, clave, { value: valor, enumerable: true, writable: true, configurable: true });
    });
    return almacen;
}

/** Sandbox con lo mínimo que usan las funciones reales. */
function crearSandbox(extra) {
    const ctx = Object.assign({
        console: { log() {}, warn() {}, error() {} },
        JSON, Date, Math, Object, Array, String, Number, Boolean,
        isFinite, isNaN, parseInt, parseFloat, setTimeout, clearTimeout, Promise
    }, extra || {});
    ctx.globalThis = ctx;
    ctx.window = ctx;
    return vm.createContext(ctx);
}

/** Instantánea del almacén para comprobar que nada cambió. */
const instantanea = (almacen) => JSON.stringify(Array.from(almacen._datos.entries()).sort());

/* ------------------------------------------------------------------ */
/* Páginas que se van a inspeccionar / ejecutar                        */
/* ------------------------------------------------------------------ */
const MENU = leer('menu.html');
const INVENTARIO = leer('inventario.html');
const COMPRAS = leer('compras.html');
const CUENTAS = leer('cuentas.html');
const PROVEEDORES = leer('gestion_proveedores.html');
const RECIBO = leer('config_recibo.html');
const CONFIG = leer('config.html');

/* Firmas de los datos de ejemplo (las que había que eliminar). */
const PATRONES_MUESTRA = [
    { re: /name:\s*['"]Laptop HP Pavilion['"]/, que: 'producto de ejemplo (Laptop HP)' },
    { re: /name:\s*['"]Smartphone Samsung Galaxy['"]/, que: 'producto de ejemplo (Samsung)' },
    { re: /name:\s*['"]Audífonos Sony WH-1000XM4['"]/, que: 'producto de ejemplo (Sony)' },
    { re: /name:\s*['"]Camiseta Nike Dri-FIT['"]/, que: 'producto de ejemplo (Nike)' },
    { re: /name:\s*['"]Cafetera Nespresso['"]/, que: 'producto de ejemplo (Nespresso)' },
    { re: /name:\s*['"]Distribuidora Central SAC['"]/, que: 'proveedor de ejemplo' },
    { re: /description:\s*['"]Venta de productos electrónicos['"]/, que: 'cuenta de ejemplo' },
    { re: /description:\s*['"]Compra de materia prima['"]/, que: 'cuenta de ejemplo' },
    { re: /contact:\s*['"]Cliente A['"]/, que: 'contacto de ejemplo' },
    { re: /contact:\s*['"]Proveedor X['"]/, que: 'contacto de ejemplo' },
    { re: /companyName:\s*["']TIENDA DE EJEMPLO/, que: 'empresa de ejemplo' },
    { re: /rif:\s*["']J-12345678['"]/, que: 'RIF de ejemplo' },
    { re: /password:\s*["']Admin123['"]/, que: 'usuario administrador demo' },
    { re: /setItem\(\s*['"]users['"]/, que: 'escritura de usuarios demo en localStorage' },
    { re: /createDemoAdminUser/, que: 'creador del usuario administrador demo' },
    { re: /\{\s*value:\s*["']Electrónicos["']/, que: 'categoría de ejemplo (Electrónicos)' },
    { re: /\{\s*value:\s*["']Charcutería["']/, que: 'categoría de ejemplo (Charcutería)' },
    { re: /(?:const|let|var)\s+(?:sampleData|sampleAccounts|sampleInventory|demoAccounts|DEFAULT_PRODUCTS|DEFAULT_SUPPLIERS|defaultProducts|datosDeEjemplo)\s*=\s*\[/, que: 'arreglo de ejemplo con nombre de sembrador' }
];

(async function principal() {

    /* ============================================================== */
    titulo('1. Ninguna página ni .js conserva arreglos de datos de ejemplo');
    /* ============================================================== */
    const ARCHIVOS = fs.readdirSync(RAIZ)
        .filter((f) => /\.(html|js)$/.test(f))
        .filter((f) => f.indexOf('pruebas_') !== 0 && f.indexOf('_pruebas_') !== 0);

    check('se revisan las páginas y los .js del proyecto (' + ARCHIVOS.length + ' archivos)',
        ARCHIVOS.length >= 20, 'archivos=' + ARCHIVOS.length);

    const conMuestra = [];
    ARCHIVOS.forEach((archivo) => {
        if (archivo === 'config.html') return; /* se revisa aparte: guarda las firmas para el diagnóstico */
        let texto;
        try { texto = leer(archivo); } catch (e) { conMuestra.push(archivo + ' (ilegible)'); return; }
        const limpio = sinComentarios(texto);
        PATRONES_MUESTRA.forEach((p) => {
            if (p.re.test(limpio)) conMuestra.push(archivo + ': ' + p.que);
        });
    });
    check('ninguna página/.js (sin contar config.html) tiene datos de muestra',
        conMuestra.length === 0, conMuestra.join(' | '));

    /* config.html: las firmas viven SOLO en el diagnóstico de solo lectura. */
    const CONFIG_LIMPIO = sinComentarios(CONFIG);
    const DIAG_FUENTE = extraerFuncion(CONFIG, 'diagnosticoDatosDeMuestra');
    const CONFIG_SIN_DIAG = CONFIG.replace(DIAG_FUENTE, '');
    const fueraDelDiag = PATRONES_MUESTRA
        .filter((p) => p.re.test(sinComentarios(CONFIG_SIN_DIAG)))
        .map((p) => p.que);
    check('config.html · las firmas de ejemplo viven solo dentro del diagnóstico',
        fueraDelDiag.length === 0, fueraDelDiag.join(' | '));
    check('config.html · el diagnóstico de muestras no escribe ni borra nada',
        !/setItem|removeItem|\.clear\s*\(/.test(sinComentarios(DIAG_FUENTE)));
    check('config.html · el reinicio sigue borrando la clave local "users" (restos de versiones viejas)',
        /removeItem\('users'\)/.test(CONFIG_LIMPIO));

    /* ============================================================== */
    titulo('2. Los sembradores reales, con almacén vacío: cero escrituras y vacío');
    /* ============================================================== */

    /* 2a. inventario.html · loadSampleData() */
    {
        const almacen = almacenFalso();
        const ctx = crearSandbox({ localStorage: almacen });
        vm.runInContext('var products = null; var nextProductId = 0;\n' +
            extraerFuncion(INVENTARIO, 'loadSampleData') + '\n' +
            'var __res = loadSampleData();', ctx);
        eq('inventario.html · loadSampleData() no escribe ninguna clave', almacen._escrituras.length, 0);
        check('inventario.html · loadSampleData() deja products vacío',
            Array.isArray(ctx.products) && ctx.products.length === 0, JSON.stringify(ctx.products));
        check('inventario.html · loadSampleData() devuelve un arreglo vacío',
            Array.isArray(ctx.__res) && ctx.__res.length === 0, JSON.stringify(ctx.__res));
        eq('inventario.html · loadSampleData() reinicia el contador de ids', ctx.nextProductId, 1);
    }

    /* 2b. inventario.html · loadCategories() (antes sembraba 10 categorías) */
    {
        const almacen = almacenFalso();
        const ctx = crearSandbox({ localStorage: almacen });
        vm.runInContext('var categories = null;\n' +
            extraerFuncion(INVENTARIO, 'loadCategories') + '\n' +
            'loadCategories();', ctx);
        eq('inventario.html · loadCategories() no escribe ninguna clave', almacen._escrituras.length, 0);
        eq('inventario.html · loadCategories() deja solo el rótulo vacío', ctx.categories.length, 1);
        eq('inventario.html · la única opción es la vacía', ctx.categories[0] && ctx.categories[0].value, '');
    }

    /* 2c. compras.html · loadSampleSuppliers() */
    {
        const almacen = almacenFalso();
        const ctx = crearSandbox({ localStorage: almacen });
        vm.runInContext('var suppliers = null; var nextSupplierId = 0;\n' +
            extraerFuncion(COMPRAS, 'loadSampleSuppliers') + '\n' +
            'var __res = loadSampleSuppliers();', ctx);
        eq('compras.html · loadSampleSuppliers() no escribe ninguna clave', almacen._escrituras.length, 0);
        check('compras.html · loadSampleSuppliers() deja suppliers vacío',
            Array.isArray(ctx.suppliers) && ctx.suppliers.length === 0, JSON.stringify(ctx.suppliers));
        check('compras.html · loadSampleSuppliers() devuelve un arreglo vacío',
            Array.isArray(ctx.__res) && ctx.__res.length === 0, JSON.stringify(ctx.__res));
        eq('compras.html · loadSampleSuppliers() reinicia el contador de ids', ctx.nextSupplierId, 1);
    }

    /* 2d. menu.html · loadSampleInventoryData() y loadSampleAccountsData() */
    {
        const almacen = almacenFalso();
        const ctx = crearSandbox({ localStorage: almacen });
        ctx.__puestos = [];
        ctx.__valores = {};
        ctx.miAlmacen = {
            set: (clave, valor) => { ctx.__puestos.push(clave); ctx.__valores[clave] = valor; },
            get: (clave) => ctx.__valores[clave]
        };
        const metodos = extraerMetodo(MENU, 'loadSampleInventoryData') + '\n' +
            extraerMetodo(MENU, 'loadSampleAccountsData');
        vm.runInContext('class _Sembrador { ' + metodos + ' }\n' +
            'var __s = new _Sembrador();\n__s.dataStore = miAlmacen;\n' +
            'var __inv = __s.loadSampleInventoryData();\n' +
            'var __cta = __s.loadSampleAccountsData();', ctx);
        eq('menu.html · los sembradores no escriben en localStorage', almacen._escrituras.length, 0);
        check('menu.html · el inventario de ejemplo queda vacío',
            Array.isArray(ctx.__valores.inventory) && ctx.__valores.inventory.length === 0);
        check('menu.html · las cuentas de ejemplo quedan vacías',
            Array.isArray(ctx.__valores.accounts) && ctx.__valores.accounts.length === 0);
        check('menu.html · los sembradores devuelven arreglos vacíos',
            ctx.__inv.length === 0 && ctx.__cta.length === 0);
        check('menu.html · los sembradores tocan SOLO el almacén en memoria (inventory, accounts)',
            JSON.stringify(ctx.__puestos) === '["inventory","accounts"]', JSON.stringify(ctx.__puestos));
    }

    /* 2e. config_recibo.html · loadCompanyData() (antes ponía "TIENDA DE EJEMPLO C.A.") */
    {
        const almacen = almacenFalso();
        const ctx = crearSandbox({
            localStorage: almacen,
            document: { getElementById: () => null },
            showMissingAlert: () => { ctx.avisoFaltanDatos = true; },
            loadCompanyFromFirebase: () => Promise.resolve(null),
            setupRealtimeCompanyListener: () => { ctx.oyentePuesto = true; }
        });
        ctx.companyData = null;
        vm.runInContext(extraerFuncion(RECIBO, 'loadCompanyData') + '\nloadCompanyData();', ctx);
        await new Promise((r) => setTimeout(r, 10));
        eq('config_recibo.html · loadCompanyData() no escribe ninguna clave', almacen._escrituras.length, 0);
        check('config_recibo.html · sin datos de empresa NO se inventa una empresa',
            ctx.companyData && Object.keys(ctx.companyData).length === 0 && !ctx.companyData.companyName,
            JSON.stringify(ctx.companyData));
        check('config_recibo.html · se avisa de que faltan los datos de empresa', ctx.avisoFaltanDatos === true);
    }

    /* ============================================================== */
    titulo('3. Arranque real con almacén vacío: listas vacías y CERO escrituras');
    /* ============================================================== */

    /* 3a. inventario.html */
    {
        const almacen = almacenFalso();
        const ctx = crearSandbox({ localStorage: almacen });
        ctx.renderProducts = () => { ctx.__pintados = (ctx.products || []).length; };
        vm.runInContext('var products = []; var nextProductId = 1;\n' +
            extraerFuncion(INVENTARIO, 'loadSampleData') + '\n' +
            extraerFuncion(INVENTARIO, 'loadProducts') + '\n' +
            'loadProducts();', ctx);
        eq('inventario.html · arranque sin datos: 0 escrituras', almacen._escrituras.length, 0);
        eq('inventario.html · arranque sin datos: lista vacía', ctx.products.length, 0);
        eq('inventario.html · arranque sin datos: se pinta el estado vacío', ctx.__pintados, 0);
    }

    /* 3b. cuentas.html */
    {
        const almacen = almacenFalso();
        const ctx = crearSandbox({ localStorage: almacen });
        ctx.renderAccounts = () => { ctx.__pintadas = (ctx._accountsCache || []).length; };
        ctx.updateAccountStatuses = () => { ctx.__estados = true; };
        ctx.saveAccountsCache = () => { ctx.__guardo = true; };
        vm.runInContext('var _accountsCache = [{ id: 1 }]; var nextAccountId = 5;\n' +
            extraerFuncion(CUENTAS, 'loadAccounts') + '\n' +
            'loadAccounts();', ctx);
        eq('cuentas.html · arranque sin datos: 0 escrituras', almacen._escrituras.length, 0);
        eq('cuentas.html · arranque sin datos: lista vacía', ctx._accountsCache.length, 0);
        eq('cuentas.html · arranque sin datos: se pinta la lista vacía', ctx.__pintadas, 0);
        eq('cuentas.html · arranque sin datos: NO se guarda la caché', ctx.__guardo, undefined);
    }

    /* 3c. gestion_proveedores.html */
    {
        const almacen = almacenFalso();
        const ctx = crearSandbox({
            localStorage: almacen,
            checkCloudAccess: () => Promise.resolve(false),
            getEmailPath: (e) => String(e),
            propietarioActualEmail: 'jefe@negocio.com'
        });
        ctx._suppliersCache = [{ id: 'resto-viejo' }];
        vm.runInContext(extraerFuncion(PROVEEDORES, 'loadSuppliersFromFirebase') + '\n' +
            'var __promesa = loadSuppliersFromFirebase();', ctx);
        await ctx.__promesa;
        eq('gestion_proveedores.html · arranque sin datos: 0 escrituras', almacen._escrituras.length, 0);
        check('gestion_proveedores.html · arranque sin datos: lista vacía',
            Array.isArray(ctx._suppliersCache) && ctx._suppliersCache.length === 0,
            JSON.stringify(ctx._suppliersCache));
        check('gestion_proveedores.html · tiene estado vacío propio para la lista',
            /no-suppliers-message/.test(PROVEEDORES),
            'sin mensaje de lista vacía');
    }

    /* 3d. menu.html · loadSystemData() completo */
    {
        const almacen = almacenFalso();
        const ctx = crearSandbox({ localStorage: almacen, sessionStorage: almacenFalso() });
        ctx.__mapa = new Map();
        ctx.miAlmacen = {
            set: (clave, valor) => ctx.__mapa.set(clave, valor),
            get: (clave) => ctx.__mapa.get(clave)
        };
        const metodos = extraerMetodo(MENU, 'loadSystemData') + '\n' +
            extraerMetodo(MENU, 'loadSampleInventoryData') + '\n' +
            extraerMetodo(MENU, 'loadSampleAccountsData') + '\n' +
            'getData(clave) { return this.dataStore.get(clave); }';
        vm.runInContext('class _Arranque { ' + metodos + ' }\n' +
            'var __a = new _Arranque();\n__a.dataStore = miAlmacen;\n__a.loadSystemData();', ctx);
        eq('menu.html · arranque sin datos: 0 escrituras en localStorage', almacen._escrituras.length, 0);
        check('menu.html · arranque sin datos: inventario vacío',
            ctx.__mapa.get('inventory').length === 0, JSON.stringify(ctx.__mapa.get('inventory')));
        check('menu.html · arranque sin datos: cuentas vacías',
            ctx.__mapa.get('accounts').length === 0, JSON.stringify(ctx.__mapa.get('accounts')));
    }

    /* ============================================================== */
    titulo('4. El reinicio de fábrica ya no crea ningún usuario de ejemplo');
    /* ============================================================== */
    check('config.html · ya no define createDemoAdminUser', !/createDemoAdminUser/.test(CONFIG_LIMPIO));
    check('config.html · ya no escribe la clave "users" en localStorage',
        !/setItem\(\s*['"]users['"]/.test(CONFIG_LIMPIO));
    check('config.html · ningún paso del reinicio crea usuarios de ejemplo',
        !/password:\s*["']Admin123["']/.test(CONFIG_LIMPIO) &&
        !/Creando usuario administrador demo/.test(CONFIG_LIMPIO));
    check('config.html · la pantalla de éxito ya no muestra credenciales demo',
        !/Credenciales de Acceso Demo/.test(CONFIG) && !/Usuario:<\/strong> Admin/.test(CONFIG));
    check('config.html · el aviso previo ya no promete un usuario demo',
        !/se creará un usuario administrador demo/.test(CONFIG));
    check('config.html · el arranque del login no depende de la clave local "users"',
        !/getItem\(\s*['"]users['"]\)/.test(CONFIG_LIMPIO));

    /* Ejecutable: se corren TODOS los pasos reales del reinicio de fábrica. */
    {
        const inicioSteps = CONFIG.indexOf('const steps = [');
        const finSteps = CONFIG.indexOf('];', inicioSteps);
        check('config.html · los pasos del reinicio son extraíbles', inicioSteps !== -1 && finSteps !== -1);
        const codigoSteps = CONFIG.slice(inicioSteps, finSteps + 3) +
            '\nsteps.forEach(function (paso) { paso.action(); });';
        const almacen = almacenFalso({
            'users': JSON.stringify([{ id: 1, username: 'Admin', password: 'Admin123', email: 'admin@demo.com' }]),
            'ciervo_inventory': JSON.stringify([{ id: 1, name: 'Laptop HP Pavilion' }]),
            'ciervo_suppliers': JSON.stringify([{ id: 1, name: 'Distribuidora Central SAC' }]),
            'ciervo_accounts': JSON.stringify([{ id: 1, description: 'Venta de productos electrónicos' }]),
            'ciervo_categories': JSON.stringify([{ value: 'Electrónicos' }]),
            'companyData': JSON.stringify({ companyName: 'TIENDA DE EJEMPLO C.A.' }),
            '_pendSync_compras': 'true'
        });
        const ctx = crearSandbox({ localStorage: almacen });
        vm.runInContext(extraerFuncion(CONFIG, 'clearOtherSystemData') + '\n' + codigoSteps, ctx);
        eq('config.html · el reinicio no escribe NINGUNA clave', almacen._escrituras.length, 0);
        check('config.html · el reinicio borra el usuario de ejemplo que hubiera',
            !almacen._datos.has('users'), JSON.stringify(Array.from(almacen._datos.keys())));
        check('config.html · el reinicio borra inventario, proveedores, cuentas, categorías y empresa',
            !almacen._datos.has('ciervo_inventory') && !almacen._datos.has('ciervo_suppliers') &&
            !almacen._datos.has('ciervo_accounts') && !almacen._datos.has('ciervo_categories') &&
            !almacen._datos.has('companyData'),
            JSON.stringify(Array.from(almacen._datos.keys())));
        check('config.html · el reinicio borra las marcas de sincronización pendientes',
            !almacen._datos.has('_pendSync_compras'), JSON.stringify(almacen._borrados));
        check('config.html · y NO crea ningún usuario nuevo (no se escribe "users")',
            !almacen._datos.has('users'));
    }

    /* ============================================================== */
    titulo('5. El diagnóstico de datos sospechosos detecta y NO borra');
    /* ============================================================== */
    {
        const inicioConstantes = CONFIG.indexOf('        var MUESTRA_PRODUCTOS = {');
        const finConstantes = CONFIG.indexOf('];', CONFIG.indexOf('MUESTRA_CATEGORIAS'));
        check('config.html · las firmas del diagnóstico son extraíbles',
            inicioConstantes !== -1 && finConstantes !== -1);
        const codigoDiag = CONFIG.slice(inicioConstantes, finConstantes + 3) + '\n' +
            extraerFuncion(CONFIG, 'muestraLeer') + '\n' +
            extraerFuncion(CONFIG, 'muestraNombres') + '\n' +
            extraerFuncion(CONFIG, 'diagnosticoDatosDeMuestra');

        const catalogoPresets = ['Electrónicos', 'Ropa', 'Hogar', 'Deportes', 'Libros', 'Belleza',
            'Automotriz', 'Frutas y Hortalizas', 'Charcutería', 'Otros'];

        /* 5a. Almacén con una lista de ejemplo inyectada a mano + un dato real de cada tipo. */
        const almacen = almacenFalso({
            'ciervo_inventory': JSON.stringify([
                { id: 1, code: 'LAP-HP-001', name: 'Laptop HP Pavilion' },
                { id: 2, code: 'TEL-SAM-002', name: 'Smartphone Samsung Galaxy' },
                { id: 3, code: 'AUD-SON-003', name: 'Audífonos Sony WH-1000XM4' },
                { id: 7, code: 'REAL-01', name: 'Harina PAN 1kg' }
            ]),
            'ciervo_accounts': JSON.stringify([
                { id: 1, description: 'Venta de productos electrónicos', contact: 'Cliente A' },
                { id: 2, description: 'Compra de materia prima', contact: 'Proveedor X' },
                { id: 3, description: 'Cobro de la semana', contact: 'Bodega La Esquina' }
            ]),
            'ciervo_suppliers': JSON.stringify([
                { id: 1, name: 'Distribuidora Central SAC', document: '20123456789' },
                { id: 2, name: 'Panificadora del Sur', document: 'J-99887766' }
            ]),
            'ciervo_categories': JSON.stringify([{ value: '', text: 'Seleccionar categoría' }]
                .concat(catalogoPresets.map((n) => ({ value: n, text: n })))),
            'companyData': JSON.stringify({ companyName: 'TIENDA DE EJEMPLO C.A.', rif: 'J-12345678' }),
            'users': JSON.stringify([{ id: 1, firstName: 'Admin', lastName: 'Demo', username: 'Admin', password: 'Admin123', email: 'admin@demo.com', document: 'DEMO-001' }])
        });
        const antes = instantanea(almacen);
        const ctx = crearSandbox({ localStorage: almacen });
        vm.runInContext(codigoDiag + '\nvar __res = diagnosticoDatosDeMuestra();', ctx);
        const res = ctx.__res;
        const texto = res.lineas.join('\n');

        check('diagnóstico · cuenta 3 productos de ejemplo (ignora el producto real)',
            /Productos con pinta de ejemplo: 3/.test(texto), texto);
        check('diagnóstico · nombra los productos sospechosos y no el real',
            /Laptop HP Pavilion/.test(texto) && !/Harina PAN/.test(texto), texto);
        check('diagnóstico · cuenta 2 cuentas de ejemplo (ignora la real)',
            /Cuentas con pinta de ejemplo: 2/.test(texto), texto);
        check('diagnóstico · cuenta 1 proveedor de ejemplo (ignora el real)',
            /Proveedores con pinta de ejemplo: 1/.test(texto) && /Distribuidora Central SAC/.test(texto), texto);
        check('diagnóstico · detecta la lista completa de 10 categorías de demostración',
            /Categorías con pinta de ejemplo: 10/.test(texto), texto);
        check('diagnóstico · detecta los datos de empresa de ejemplo',
            /Datos de empresa de ejemplo: sí/.test(texto), texto);
        check('diagnóstico · detecta el usuario administrador demo',
            /Usuarios de ejemplo: 1/.test(texto) && /admin@demo\.com/.test(texto), texto);
        check('diagnóstico · avisa de que los clientes no tienen firma de ejemplo',
            /Clientes: sin firma conocida/.test(texto), texto);
        check('diagnóstico · resume el total y deja claro que es de solo lectura',
            res.total === 18 && /Total: 18 elemento\(s\) sospechoso\(s\)\. Diagnóstico de SOLO LECTURA/.test(texto),
            'total=' + res.total + ' | ' + texto);

        eq('diagnóstico · NO escribe ninguna clave', almacen._escrituras.length, 0);
        eq('diagnóstico · NO borra ninguna clave', almacen._borrados.length, 0);
        eq('diagnóstico · el almacén queda EXACTAMENTE igual', instantanea(almacen), antes);

        /* 5b. Almacén solo con datos reales: no debe dar falsos positivos. */
        const almacenReal = almacenFalso({
            'ciervo_inventory': JSON.stringify([{ id: 1, code: 'REAL-01', name: 'Harina PAN 1kg' }]),
            'ciervo_accounts': JSON.stringify([{ id: 1, description: 'Cobro de la semana', contact: 'Bodega La Esquina' }]),
            'ciervo_suppliers': JSON.stringify([{ id: 1, name: 'Panificadora del Sur', document: 'J-99887766' }]),
            'ciervo_categories': JSON.stringify([{ value: '', text: 'Seleccionar categoría' }, { value: 'Hogar', text: 'Hogar' }]),
            'companyData': JSON.stringify({ companyName: 'Mini Market La Esquina', rif: 'J-12345678-9' }),
            'users': JSON.stringify([{ id: 1, username: 'jefa', password: 'otraClave', email: 'jefa@negocio.com' }])
        });
        const antesReal = instantanea(almacenReal);
        const ctxReal = crearSandbox({ localStorage: almacenReal });
        vm.runInContext(codigoDiag + '\nvar __res = diagnosticoDatosDeMuestra();', ctxReal);
        eq('diagnóstico · con datos reales el total es 0 (sin falsos positivos)', ctxReal.__res.total, 0);
        check('diagnóstico · con datos reales lo dice claramente',
            /Total: 0 elementos sospechosos/.test(ctxReal.__res.lineas.join('\n')),
            ctxReal.__res.lineas.join('\n'));
        eq('diagnóstico · tampoco escribe con datos reales', almacenReal._escrituras.length, 0);
        eq('diagnóstico · ni cambia el almacén con datos reales', instantanea(almacenReal), antesReal);
    }

    /* ============================================================== */
    titulo('6. Integridad de las páginas tocadas');
    /* ============================================================== */
    const TOCADAS = ['menu.html', 'inventario.html', 'compras.html', 'config_recibo.html', 'config.html'];
    const sinCRLF = TOCADAS.filter((f) => /(?<!\r)\n/.test(fs.readFileSync(path.join(RAIZ, f), 'utf8')));
    check('las páginas tocadas conservan CRLF', sinCRLF.length === 0, sinCRLF.join(', '));

    TOCADAS.forEach((archivo) => {
        const texto = leer(archivo);
        const bloques = [...texto.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
        let errorSintaxis = '';
        for (const b of bloques) {
            try { new vm.Script(b); } catch (e) { errorSintaxis = e.message; break; }
        }
        check(archivo + ' · sintaxis de sus ' + bloques.length + ' bloque(s) en línea', !errorSintaxis, errorSintaxis);
    });

    check('menu.html · los dos sembradores siguen existiendo (los usa el arranque)',
        /loadSampleInventoryData\(\)\s*\{/.test(MENU) && /loadSampleAccountsData\(\)\s*\{/.test(MENU));
    check('menu.html · los sembradores ya no persisten en la clave del usuario',
        !/^\s*this\.saveData\('inventory'\);/m.test(MENU) &&
        /^\s*\/\/ this\.saveData\('inventory'\);/m.test(MENU) &&
        /^\s*\/\/ this\.saveData\('accounts'\);/m.test(MENU));
    check('menu.html · los guardados legítimos del usuario siguen intactos',
        /this\.saveData\(store\)/.test(MENU));

    check('inventario.html · el alta real sigue guardando el inventario',
        /function saveProducts\(\)/.test(INVENTARIO) && /guardarLocalSeguro\('ciervo_inventory'/.test(INVENTARIO));
    check('inventario.html · el gestor de categorías sigue guardando lo que el usuario crea',
        /function addCategory\(\)/.test(INVENTARIO) && /saveCategories\(\)/.test(INVENTARIO));

    check('compras.html · el alta real de proveedores sigue guardando',
        /function saveSupplier\(\)/.test(COMPRAS) && /setItem\('ciervo_suppliers'/.test(COMPRAS));

    check('config_recibo.html · la vista previa ya no usa una tasa de mentira',
        !/MOCK_EXCHANGE_RATE/.test(RECIBO) && /function tasaVistaPrevia\(\)/.test(RECIBO));
    check('config_recibo.html · la empresa sigue guardándose desde el formulario real',
        /setItem\('companyData'/.test(RECIBO));

    check('config.html · el diagnóstico cuelga del panel Avanzado (id almMuestras)',
        /id="almAvanzado"\s+hidden/.test(CONFIG) &&
        CONFIG.indexOf('id="almMuestras"') > CONFIG.indexOf('id="almAvanzado"'));
    check('config.html · el panel refresca el diagnóstico al medir',
        /muestrasPintarDiagnostico\(\);/.test(CONFIG));

    console.log('\n================ ' + ok + ' OK, ' + fallos + ' FALLAS ================');
    console.log('Nota: los sembradores siguen existiendo como funciones VACÍAS (no se');
    console.log('      eliminaron para no romper el arranque); ninguno escribe ni pinta nada.');
    process.exit(fallos === 0 ? 0 : 1);
})();
