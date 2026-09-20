/* =====================================================================
   PRUEBAS DEL AISLAMIENTO DE DATOS POR CUENTA (datos_cuenta.js)

   Se ejecuta con:  node pruebas_datos_cuenta.js

   Carga el ARCHIVO REAL en un `vm` con un localStorage falso (y un
   sessionStorage falso) que tienen la MISMA forma que Storage (métodos en el
   prototipo), y comprueba:

     1. Sin cuenta activa: leer/escribir se comporta como hoy (transparente).
     2. Con la cuenta A activa: las claves se guardan prefijadas, la cuenta B no
        las ve y cada una escribe lo suyo sin pisar a la otra.
     3. Las claves de equipo NUNCA se prefijan y se ven igual con cualquier cuenta.
     4. Migración: copia, verifica, borra los originales, deja contadores y es
        idempotente.
     5. La migración no pierde nada (valor a valor, antes y después).
     6. key(i)/length coherentes: solo las claves de la cuenta activa + las de equipo.
     7. limpiarCuenta(A) borra solo lo de A.
     8. sessionStorage no se ve afectado.
     9. Si la intercepción falla, el módulo queda transparente y lo dice.
    10. Invariantes de archivos (compila, CRLF) y de la página piloto.
    11. Lote completo: las 14 páginas cargan el módulo en el <head> como PRIMER script
        propio y llaman a la activación en su arranque; sus bloques en línea compilan.
   ===================================================================== */
const fs = require('fs');
const vm = require('vm');
let ok = 0, fallos = 0;
const check = (nombre, condicion, extra = '') => {
    if (condicion) { ok++; console.log('OK    ' + nombre); }
    else { fallos++; console.log('FALLA ' + nombre + (extra ? '  -> ' + extra : '')); }
};
const nota = (t) => console.log('      ' + t);

/* =====================================================================
   1. ALMACENES FALSOS CON LA FORMA REAL DE Storage
   Cada sandbox recibe su PROPIA clase: así cada intercepción vive en su
   propio prototipo y no se pisan entre pruebas.
   ===================================================================== */
function crearAlmacenFalso(inicial) {
    const datos = new Map();
    Object.keys(inicial || {}).forEach((k) => { datos.set(String(k), String(inicial[k])); });

    class Almacen {
        get length() { return datos.size; }
        key(i) {
            const claves = Array.from(datos.keys());
            const n = Number(i);
            return (n >= 0 && n < claves.length) ? claves[n] : null;
        }
        getItem(k) { const n = String(k); return datos.has(n) ? datos.get(n) : null; }
        setItem(k, v) { datos.set(String(k), String(v)); }
        removeItem(k) { datos.delete(String(k)); }
        clear() { datos.clear(); }
    }

    const instancia = new Almacen();
    return { clase: Almacen, instancia, datos };
}

/* Volcado FÍSICO del almacén (lo que hay de verdad en disco, con prefijos). */
function volcado(almacen) {
    const salida = {};
    almacen.datos.forEach((v, k) => { salida[k] = v; });
    return salida;
}
const clavesFisicas = (almacen) => Array.from(almacen.datos.keys());

/* =====================================================================
   2. CARGA DEL ARCHIVO REAL EN UN SANDBOX
   ===================================================================== */
const CRUDO = fs.readFileSync('datos_cuenta.js', 'utf8');

function cargarModulo(opciones) {
    const op = opciones || {};
    const almacen = crearAlmacenFalso(op.local);
    const sesion = crearAlmacenFalso(op.session);

    if (op.sinStorage === true) {
        /* Nada de Storage: el módulo no puede interceptar. */
    } else if (op.congelado === true) {
        /* Storage.prototype NO modificable: la intercepción tiene que fallar sola. */
        Object.freeze(almacen.clase.prototype);
    }

    const ctx = {
        console, JSON, Object, String, Number, Array, Date, parseInt, isFinite, Math,
        localStorage: almacen.instancia,
        sessionStorage: sesion.instancia
    };
    if (op.sinStorage !== true) ctx.Storage = almacen.clase;
    if (op.sanitizeEmailForDb) {
        ctx.sanitizeEmailForDb = (e) => String(e).replace('@', '_at_').replace(/\./g, '_');
    }
    ctx.window = ctx;

    vm.createContext(ctx);
    vm.runInContext(CRUDO, ctx);
    return { ctx, almacen, sesion, api: ctx.datosCuenta, local: almacen.instancia, session: sesion.instancia };
}

const L = (g) => g.local;          // atajo: localStorage del sandbox
const S = (g) => g.session;        // atajo: sessionStorage del sandbox

/* =====================================================================
   A. SIN CUENTA ACTIVA: MODO TRANSPARENTE (como hoy)
   ===================================================================== */
console.log('\n================ A. MODO TRANSPARENTE (sin cuenta) ================\n');

{
    const g = cargarModulo({ local: { sesionActiva: '{"email":"juan@x.com"}', darkMode: 'true' } });
    const e = g.api.estado();
    check('A1 · el módulo intercepta localStorage', e.interceptado === true, JSON.stringify(e));
    check('A2 · sin marcador en el equipo, arranca transparente',
        e.activa === false && e.emailPath === '' && e.prefijo === '', JSON.stringify(e));
    check('A3 · sin cuenta activa no hay claves de cuenta', e.clavesDeCuenta === 0, String(e.clavesDeCuenta));

    L(g).setItem('ciervo_inventory', '[{"id":1}]');
    check('A4 · escribir guarda la clave TAL CUAL (sin prefijo)',
        g.almacen.datos.has('ciervo_inventory') &&
        !clavesFisicas(g.almacen).some((k) => k.indexOf('cuenta:') === 0),
        JSON.stringify(clavesFisicas(g.almacen)));
    check('A5 · leer devuelve lo escrito', L(g).getItem('ciervo_inventory') === '[{"id":1}]', String(L(g).getItem('ciervo_inventory')));

    const largoAntes = L(g).length;
    L(g).removeItem('ciervo_inventory');
    check('A6 · removeItem borra la clave sin prefijo',
        !g.almacen.datos.has('ciervo_inventory') && L(g).length === largoAntes - 1);

    L(g).setItem('pos_sales', '[]');
    L(g).setItem('ciervo_clients', '[]');
    check('A7 · key(i)/length ven TODAS las claves físicas (comportamiento de hoy)',
        L(g).length === 4 && L(g).key(0) === 'sesionActiva' && L(g).key(3) === 'ciervo_clients',
        [L(g).length, L(g).key(0), L(g).key(3)].join(' / '));
    check('A8 · key(i) fuera de rango devuelve null', L(g).key(99) === null);
    check('A9 · desactivar() en transparente es inocuo', g.api.desactivar() === true && g.api.estado().activa === false);
}

/* =====================================================================
   B. CUENTA A Y CUENTA B: AISLAMIENTO REAL
   ===================================================================== */
console.log('\n================ B. AISLAMIENTO ENTRE DOS CUENTAS ================\n');

{
    const g = cargarModulo({ local: { ciervo_inventory: '["viejo-sin-prefijo"]' } });
    check('B1 · activarPara(A) deja el prefijo de A',
        g.api.activarPara('juan_at_x_com') === true && g.api.estado().prefijo === 'cuenta:juan_at_x_com:',
        JSON.stringify(g.api.estado()));
    check('B2 · el correo con @ y puntos también se normaliza',
        g.api.activarPara('Maria@Negocio.com') === true && g.api.estado().emailPath === 'maria_at_negocio_com',
        g.api.estado().emailPath);
    g.api.activarPara('juan_at_x_com');

    check('B3 · sin migrar, la clave vieja (sin prefijo) NO se ve bajo A',
        L(g).getItem('ciervo_inventory') === null, String(L(g).getItem('ciervo_inventory')));

    L(g).setItem('ciervo_inventory', '["A"]');
    check('B4 · escribir bajo A guarda en cuenta:<A>:ciervo_inventory',
        g.almacen.datos.get('cuenta:juan_at_x_com:ciervo_inventory') === '["A"]' &&
        g.almacen.datos.get('ciervo_inventory') === '["viejo-sin-prefijo"]',
        JSON.stringify(clavesFisicas(g.almacen)));
    check('B5 · leer bajo A devuelve el valor de A', L(g).getItem('ciervo_inventory') === '["A"]');

    g.api.activarPara('pedro_at_y_com');
    check('B6 · la cuenta B NO ve el inventario de A', L(g).getItem('ciervo_inventory') === null,
        String(L(g).getItem('ciervo_inventory')));
    L(g).setItem('ciervo_inventory', '["B"]');
    check('B7 · B escribe lo suyo sin pisar a A',
        g.almacen.datos.get('cuenta:juan_at_x_com:ciervo_inventory') === '["A"]' &&
        g.almacen.datos.get('cuenta:pedro_at_y_com:ciervo_inventory') === '["B"]',
        JSON.stringify(volcado(g.almacen)));

    g.api.activarPara('juan_at_x_com');
    check('B8 · al volver a A, A sigue viendo lo suyo', L(g).getItem('ciervo_inventory') === '["A"]');
    L(g).removeItem('ciervo_inventory');
    check('B9 · borrar bajo A no toca lo de B',
        !g.almacen.datos.has('cuenta:juan_at_x_com:ciervo_inventory') &&
        g.almacen.datos.get('cuenta:pedro_at_y_com:ciervo_inventory') === '["B"]');

    /* Una clave que ya viene prefijada no se prefija dos veces. */
    L(g).setItem('cuenta:juan_at_x_com:raro', 'ok');
    check('B10 · una clave ya prefijada no se duplica (no hay cuenta:A:cuenta:A:...)',
        g.almacen.datos.get('cuenta:juan_at_x_com:raro') === 'ok' &&
        !clavesFisicas(g.almacen).some((k) => /cuenta:.*cuenta:/.test(k)),
        JSON.stringify(clavesFisicas(g.almacen)));

    g.api.desactivar();
    check('B11 · al desactivar, las claves prefijadas siguen en disco pero ya no se ven',
        g.almacen.datos.get('cuenta:pedro_at_y_com:ciervo_inventory') === '["B"]' &&
        L(g).getItem('ciervo_inventory') === '["viejo-sin-prefijo"]' &&
        g.api.estado().activa === false,
        String(L(g).getItem('ciervo_inventory')));
}

/* =====================================================================
   C. CLAVES DE EQUIPO: NUNCA SE PREFIJAN
   ===================================================================== */
console.log('\n================ C. CLAVES DE EQUIPO ================\n');

{
    const EQUIPO = ['datosDeCuenta', 'sesionActiva', 'rememberedEmail', 'darkMode', 'theme'];
    const g = cargarModulo({ local: {} });
    g.api.activarPara('juan_at_x_com');

    EQUIPO.forEach((k) => { L(g).setItem(k, 'equipo-' + k); });
    check('C1 · ninguna clave de equipo queda prefijada en disco',
        EQUIPO.every((k) => g.almacen.datos.get(k) === 'equipo-' + k) &&
        !clavesFisicas(g.almacen).some((k) => k.indexOf('cuenta:') === 0),
        JSON.stringify(volcado(g.almacen)));
    check('C2 · se leen igual con A activa',
        EQUIPO.every((k) => L(g).getItem(k) === 'equipo-' + k));

    g.api.activarPara('pedro_at_y_com');
    check('C3 · se leen igual con B activa',
        EQUIPO.every((k) => L(g).getItem(k) === 'equipo-' + k) &&
        g.almacen.datos.get('datosDeCuenta') === 'equipo-datosDeCuenta');

    g.api.desactivar();
    check('C4 · y también sin ninguna cuenta activa',
        EQUIPO.every((k) => L(g).getItem(k) === 'equipo-' + k));

    g.api.activarPara('juan_at_x_com');
    L(g).removeItem('darkMode');
    check('C5 · removeItem de una clave de equipo no inventa prefijos',
        !g.almacen.datos.has('darkMode') &&
        !clavesFisicas(g.almacen).some((k) => k.indexOf('cuenta:') === 0),
        JSON.stringify(clavesFisicas(g.almacen)));

    check('C6 · estado().clavesDeEquipo es exactamente la lista de las 5 claves',
        JSON.stringify(g.api.estado().clavesDeEquipo) === JSON.stringify(EQUIPO),
        JSON.stringify(g.api.estado().clavesDeEquipo));
}

/* =====================================================================
   D. MIGRACIÓN
   ===================================================================== */
console.log('\n================ D. MIGRACIÓN ================\n');

{
    const LEGADO = {
        ciervo_inventory: '[{"id":1,"nombre":"Arroz"}]',
        ciervo_clients: '[{"id":"C-1","nombre":"Ana"}]',
        pos_sales: '[{"id":"V-1","total":5}]',
        companyData: '{"nombre":"Bodega A"}',
        sesionActiva: '{"email":"juan@x.com"}',
        darkMode: 'true',
        'cuenta:otra_at_cuenta_com:ciervo_inventory': '["DE-OTRA-CUENTA"]'
    };
    const antes = Object.assign({}, LEGADO);

    const g = cargarModulo({ local: LEGADO });
    g.api.activarPara('juan_at_x_com');
    const r = g.api.migrarAlaCuenta('juan_at_x_com');

    check('D1 · migrarAlaCuenta devuelve ok sin error',
        r.ok === true && r.error === null, JSON.stringify(r));
    check('D2 · migra las 4 claves de negocio y omite equipo y cuentas ajenas',
        r.migradas === 4 && r.omitidas === 3, JSON.stringify(r));

    check('D3 · NO PIERDE NADA: cada valor migrado es idéntico al de antes',
        Object.keys(antes).every((k) => {
            if (k.indexOf('cuenta:') === 0) return true;                    // ajena: intacta
            if (k === 'sesionActiva' || k === 'darkMode') return true;      // equipo: intacta
            return L(g).getItem(k) === antes[k];
        }),
        JSON.stringify(volcado(g.almacen)));
    check('D4 · las claves se leen ya bajo la cuenta',
        L(g).getItem('ciervo_inventory') === antes['ciervo_inventory'] &&
        L(g).getItem('companyData') === antes['companyData']);

    check('D5 · los originales sin prefijo se borran después de verificar la copia',
        !g.almacen.datos.has('ciervo_inventory') &&
        !g.almacen.datos.has('ciervo_clients') &&
        !g.almacen.datos.has('pos_sales') &&
        !g.almacen.datos.has('companyData'),
        JSON.stringify(clavesFisicas(g.almacen)));

    check('D6 · las claves de equipo quedan intactas y sin prefijar',
        g.almacen.datos.get('sesionActiva') === antes['sesionActiva'] &&
        g.almacen.datos.get('darkMode') === antes['darkMode'] &&
        !g.almacen.datos.has('cuenta:juan_at_x_com:sesionActiva'));

    check('D7 · no toca las claves de OTRA cuenta',
        g.almacen.datos.get('cuenta:otra_at_cuenta_com:ciervo_inventory') === '["DE-OTRA-CUENTA"]');

    check('D8 · deja constancia de la migración (cuenta:<A>:datosCuentaMigrado)',
        g.almacen.datos.get('cuenta:juan_at_x_com:datosCuentaMigrado') === '1');
    check('D9 · estado().migrada dice que ya está hecha', g.api.estado().migrada === true);

    /* Idempotencia: la segunda pasada no cambia absolutamente nada. */
    const despues = JSON.stringify(volcado(g.almacen));
    const r2 = g.api.migrarAlaCuenta('juan_at_x_com');
    check('D10 · es idempotente: la segunda vez no migra nada y no cambia el disco',
        r2.ok === true && r2.migradas === 0 && JSON.stringify(volcado(g.almacen)) === despues,
        JSON.stringify(r2));
    check('D11 · y los datos siguen completos después de la segunda pasada',
        L(g).getItem('ciervo_inventory') === antes['ciervo_inventory'] &&
        L(g).getItem('pos_sales') === antes['pos_sales']);

    /* Migración con el prefijo de OTRA cuenta activo: no debe estorbarla. */
    const g2 = cargarModulo({ local: { ciervo_inventory: '["LEGADO"]', 'cuenta:b_at_y_com:pos_sales': '["B"]' } });
    g2.api.activarPara('b_at_y_com');
    const r3 = g2.api.migrarAlaCuenta('a_at_x_com');
    check('D12 · migra una cuenta distinta de la activa sin tocar la activa',
        r3.ok === true && r3.migradas === 1 &&
        g2.almacen.datos.get('cuenta:a_at_x_com:ciervo_inventory') === '["LEGADO"]' &&
        !g2.almacen.datos.has('ciervo_inventory') &&
        g2.almacen.datos.get('cuenta:b_at_y_com:pos_sales') === '["B"]' &&
        L(g2).getItem('pos_sales') === '["B"]',
        JSON.stringify(r3));

    /* No pisa lo que la cuenta ya tenía: manda lo que ya estaba bajo la cuenta. */
    const g3 = cargarModulo({ local: { ciervo_inventory: '["VIEJO-SIN-PREFIJO"]' } });
    g3.api.activarPara('a_at_x_com');
    L(g3).setItem('ciervo_inventory', '["NUEVO-BAJO-LA-CUENTA"]');
    const r4 = g3.api.migrarAlaCuenta('a_at_x_com');
    check('D13 · una migración tardía no machaca lo que la cuenta ya tenía',
        L(g3).getItem('ciervo_inventory') === '["NUEVO-BAJO-LA-CUENTA"]' &&
        g3.almacen.datos.get('ciervo_inventory') === '["VIEJO-SIN-PREFIJO"]' &&
        r4.migradas === 0 && r4.omitidas >= 1,
        JSON.stringify(r4));

    /* Nunca lanza: cuentas inválidas y módulo sin intercepción. */
    const g4 = cargarModulo({ local: {} });
    const r5 = g4.api.migrarAlaCuenta('');
    check('D14 · migrar con cuenta vacía devuelve error sin lanzar',
        r5.ok === false && typeof r5.error === 'string' && r5.error.length > 0, JSON.stringify(r5));
    const r6 = g4.api.migrarAlaCuenta(null);
    check('D15 · migrar con null tampoco lanza', r6.ok === false && !!r6.error, JSON.stringify(r6));
}

/* =====================================================================
   E. limpiarCuenta (reinicio de fábrica)
   ===================================================================== */
console.log('\n================ E. limpiarCuenta ================\n');

{
    const g = cargarModulo({
        local: {
            'cuenta:a_at_x_com:ciervo_inventory': '["A1"]',
            'cuenta:a_at_x_com:pos_sales': '["A2"]',
            'cuenta:a_at_x_com:datosCuentaMigrado': '1',
            'cuenta:b_at_y_com:ciervo_inventory': '["B"]',
            sesionActiva: '{"email":"a@x.com"}',
            darkMode: 'true',
            datosDeCuenta: 'a_at_x_com'
        }
    });
    check('E1 · el equipo con marcador arranca ya aislado para su cuenta',
        g.api.estado().activa === true && g.api.estado().emailPath === 'a_at_x_com',
        JSON.stringify(g.api.estado()));

    const r = g.api.limpiarCuenta('a_at_x_com');
    check('E2 · borra solo las claves de A y las cuenta',
        r.ok === true && r.borradas === 3, JSON.stringify(r));
    check('E3 · no queda ninguna clave física de A',
        !clavesFisicas(g.almacen).some((k) => k.indexOf('cuenta:a_at_x_com:') === 0),
        JSON.stringify(clavesFisicas(g.almacen)));
    check('E4 · las claves de B quedan intactas',
        g.almacen.datos.get('cuenta:b_at_y_com:ciervo_inventory') === '["B"]');
    check('E5 · las claves de equipo quedan intactas',
        g.almacen.datos.get('sesionActiva') === '{"email":"a@x.com"}' &&
        g.almacen.datos.get('darkMode') === 'true' &&
        g.almacen.datos.get('datosDeCuenta') === 'a_at_x_com');

    const antes = JSON.stringify(volcado(g.almacen));
    const r2 = g.api.limpiarCuenta('');
    check('E6 · limpiar con cuenta vacía devuelve error y no borra nada',
        r2.ok === false && !!r2.error && JSON.stringify(volcado(g.almacen)) === antes, JSON.stringify(r2));

    const r3 = g.api.limpiarCuenta('c_at_z_com');
    check('E7 · limpiar una cuenta inexistente no borra nada',
        r3.ok === true && r3.borradas === 0 && JSON.stringify(volcado(g.almacen)) === antes,
        JSON.stringify(r3));
}

/* =====================================================================
   F. sessionStorage INTACTO
   ===================================================================== */
console.log('\n================ F. sessionStorage ================\n');

{
    const g = cargarModulo({ local: {}, session: { propietarioActual: 'juan@x.com' } });
    g.api.activarPara('juan_at_x_com');

    S(g).setItem('propietarioActual', 'juan@x.com');
    S(g).setItem('ciervo_inventory', '["EN-SESION"]');
    check('F1 · escribir en sessionStorage NUNCA lleva prefijo',
        g.sesion.datos.get('ciervo_inventory') === '["EN-SESION"]' &&
        !clavesFisicas(g.sesion).some((k) => k.indexOf('cuenta:') === 0),
        JSON.stringify(volcado(g.sesion)));
    check('F2 · se lee igual que siempre',
        S(g).getItem('ciervo_inventory') === '["EN-SESION"]' &&
        S(g).getItem('propietarioActual') === 'juan@x.com');
    check('F3 · length y key() de sessionStorage no se filtran por cuenta',
        S(g).length === 2 && S(g).key(0) === 'propietarioActual' && S(g).key(1) === 'ciervo_inventory',
        [S(g).length, S(g).key(0), S(g).key(1)].join(' / '));

    L(g).setItem('ciervo_inventory', '["EN-LOCAL"]');
    check('F4 · localStorage y sessionStorage no se mezclan',
        L(g).getItem('ciervo_inventory') === '["EN-LOCAL"]' &&
        S(g).getItem('ciervo_inventory') === '["EN-SESION"]');
    S(g).removeItem('ciervo_inventory');
    check('F5 · removeItem en sessionStorage borra solo allí',
        S(g).getItem('ciervo_inventory') === null &&
        g.almacen.datos.get('cuenta:juan_at_x_com:ciervo_inventory') === '["EN-LOCAL"]');
}

/* =====================================================================
   G. key(i)/length COHERENTES CON LA CUENTA ACTIVA
   ===================================================================== */
console.log('\n================ G. key(i) y length ================\n');

{
    const g = cargarModulo({
        local: {
            'cuenta:a_at_x_com:ciervo_inventory': '["A"]',
            'cuenta:a_at_x_com:pos_sales': '["A"]',
            'cuenta:b_at_y_com:ciervo_inventory': '["B"]',
            'cuenta:b_at_y_com:clientes': '["B"]',
            sesionActiva: '{"email":"a@x.com"}',
            darkMode: 'true',
            datosDeCuenta: 'a_at_x_com',
            ciervo_suppliers: '["LEGADO-SIN-PREFIJO"]'
        }
    });

    const visibles = [];
    for (let i = 0; i < L(g).length; i++) visibles.push(L(g).key(i));

    check('G1 · length cuenta solo las claves de A más las de equipo presentes',
        L(g).length === 5, String(L(g).length));
    check('G2 · aparecen las claves de A (sin el prefijo) y las de equipo',
        visibles.includes('ciervo_inventory') && visibles.includes('pos_sales') &&
        visibles.includes('sesionActiva') && visibles.includes('darkMode') &&
        visibles.includes('datosDeCuenta'),
        JSON.stringify(visibles));
    check('G3 · NO aparece ninguna clave de B',
        !visibles.includes('clientes') && visibles.filter((k) => k === 'ciervo_inventory').length === 1,
        JSON.stringify(visibles));
    check('G4 · NO aparece ninguna clave sin prefijo que no sea de equipo (legado invisible)',
        !visibles.includes('ciervo_suppliers'), JSON.stringify(visibles));
    check('G5 · cada clave visible se lee de verdad con getItem',
        visibles.every((k) => L(g).getItem(k) !== null), JSON.stringify(visibles));
    check('G6 · key(i) fuera de rango devuelve null',
        L(g).key(L(g).length) === null && L(g).key(-1) === null);
    check('G7 · estado().clavesDeCuenta coincide con lo visible',
        g.api.estado().clavesDeCuenta === 2, String(g.api.estado().clavesDeCuenta));

    g.api.activarPara('b_at_y_com');
    const visiblesB = [];
    for (let i = 0; i < L(g).length; i++) visiblesB.push(L(g).key(i));
    check('G8 · con B activa, B ve lo suyo y no ve nada de A',
        visiblesB.includes('ciervo_inventory') && visiblesB.includes('clientes') &&
        !visiblesB.includes('pos_sales') && !visiblesB.includes('ciervo_suppliers'),
        JSON.stringify(visiblesB));
    check('G9 · el legado sin prefijo tampoco aparece con B activa',
        !visiblesB.includes('ciervo_suppliers'));

    /* Coherencia con el respaldo de almacenamiento.js: recorre localStorage con
       key(i)+getItem(i) y filtra por nombre. Debe ver nombres LÓGICOS. */
    g.api.activarPara('a_at_x_com');
    const recorrido = [];
    for (let i = 0; i < L(g).length; i++) {
        const clave = L(g).key(i);
        recorrido.push({ clave: clave, valor: L(g).getItem(clave) });
    }
    check('G10 · el respaldo ve nombres lógicos (sin "cuenta:" ni ":" ) y todos con valor',
        recorrido.length === 5 && recorrido.every((x) => x.valor !== null && x.clave.indexOf(':') === -1),
        JSON.stringify(recorrido.map((x) => x.clave)));
    check('G11 · y el respaldo incluiría el inventario de la cuenta activa',
        recorrido.some((x) => x.clave === 'ciervo_inventory' && x.valor === '["A"]'),
        JSON.stringify(recorrido));
}

/* =====================================================================
   H. SI LA INTERCEPCIÓN FALLA: TRANSPARENTE Y LO DICE
   ===================================================================== */
console.log('\n================ H. FALLO DE INTERCEPCIÓN ================\n');

{
    /* H1: no existe Storage. */
    const g = cargarModulo({ sinStorage: true, local: { ciervo_inventory: '["X"]' } });
    const e = g.api.estado();
    check('H1 · sin Storage.prototype el módulo queda transparente y lo dice',
        e.interceptado === false && e.activa === false &&
        typeof e.error === 'string' && e.error.indexOf('interceptar') !== -1,
        JSON.stringify(e));
    check('H2 · activarPara no puede activar nada y no lanza', g.api.activarPara('a_at_x_com') === false);
    check('H3 · leer y escribir siguen funcionando como hoy',
        L(g).getItem('ciervo_inventory') === '["X"]' &&
        (L(g).setItem('pos_sales', '["Y"]'), g.almacen.datos.get('pos_sales') === '["Y"]'));
    check('H4 · la migración avisa con error en vez de tocar nada',
        g.api.migrarAlaCuenta('a_at_x_com').ok === false &&
        !!g.api.migrarAlaCuenta('a_at_x_com').error &&
        g.almacen.datos.get('ciervo_inventory') === '["X"]');
    check('H5 · limpiarCuenta tampoco borra nada',
        g.api.limpiarCuenta('a_at_x_com').ok === false &&
        g.almacen.datos.get('ciervo_inventory') === '["X"]');

    /* H6: Storage.prototype no modificable. */
    const g2 = cargarModulo({ congelado: true, local: { ciervo_inventory: '["Z"]' } });
    const e2 = g2.api.estado();
    check('H6 · con Storage.prototype no modificable tampoco se rompe nada',
        e2.interceptado === false && e2.activa === false && !!e2.error, JSON.stringify(e2));
    check('H7 · y el almacén sigue siendo transparente',
        L(g2).getItem('ciervo_inventory') === '["Z"]' &&
        (L(g2).setItem('pos_sales', '["W"]'), g2.almacen.datos.has('pos_sales')) &&
        !clavesFisicas(g2.almacen).some((k) => k.indexOf('cuenta:') === 0));
}

/* =====================================================================
   I. ACTIVACIÓN PEREZOSA AL CARGAR
   ===================================================================== */
console.log('\n================ I. ACTIVACIÓN PEREZOSA ================\n');

{
    const g = cargarModulo({
        local: {
            datosDeCuenta: 'juan_at_x_com',
            'cuenta:juan_at_x_com:ciervo_inventory': '["J"]',
            sesionActiva: '{"email":"juan@x.com"}'
        }
    });
    check('I1 · con marcador en el equipo, el prefijo se activa solo al cargar',
        g.api.estado().activa === true && g.api.estado().prefijo === 'cuenta:juan_at_x_com:',
        JSON.stringify(g.api.estado()));
    check('I2 · y la página ve los datos de esa cuenta sin llamar a nadie',
        L(g).getItem('ciervo_inventory') === '["J"]');
    check('I3 · pero NO migra sola: eso lo decide la página (migrada === false)',
        g.api.estado().migrada === false);

    const g2 = cargarModulo({ local: { ciervo_inventory: '["legado"]', sesionActiva: '{"email":"juan@x.com"}' } });
    check('I4 · sin marcador (equipo recién instalado) no se activa nada',
        g2.api.estado().activa === false && !clavesFisicas(g2.almacen).some((k) => k.indexOf('cuenta:') === 0));
    check('I5 · la marca del equipo se lee siempre, activa o no',
        g2.api.activarPara('juan_at_x_com') === true && L(g2).getItem('sesionActiva') === '{"email":"juan@x.com"}');

    /* El módulo no se instala dos veces: cargarlo de nuevo no duplica el prefijo. */
    const g3 = cargarModulo({ local: { datosDeCuenta: 'a_at_x_com', 'cuenta:a_at_x_com:x': '1' } });
    vm.runInContext(CRUDO, g3.ctx);
    g3.local.setItem('y', '2');
    check('I6 · cargar el módulo dos veces no duplica el prefijo',
        g3.almacen.datos.get('cuenta:a_at_x_com:y') === '2' &&
        !clavesFisicas(g3.almacen).some((k) => /cuenta:.*cuenta:/.test(k)),
        JSON.stringify(clavesFisicas(g3.almacen)));
}

/* =====================================================================
   I2. activarYMigrar: la entrada que usan TODAS las páginas del lote
   ===================================================================== */
console.log('\n================ I2. activarYMigrar (entrada de las páginas) ================\n');

{
    const g = cargarModulo({
        local: {
            ciervo_inventory: '["VIEJO"]',
            pos_sales: '["V-1"]',
            sesionActiva: '{"email":"juan@x.com"}',
            darkMode: 'true'
        }
    });

    const e = g.api.activarYMigrar('Juan@X.com');
    check('I7 · activa la cuenta (normaliza el correo) y devuelve el estado',
        !!e && e.activa === true && e.emailPath === 'juan_at_x_com' &&
        e.prefijo === 'cuenta:juan_at_x_com:' && e.migrada === true,
        JSON.stringify(e));
    check('I8 · y migra de una sola vez',
        L(g).getItem('ciervo_inventory') === '["VIEJO"]' &&
        L(g).getItem('pos_sales') === '["V-1"]' &&
        !g.almacen.datos.has('ciervo_inventory') && !g.almacen.datos.has('pos_sales'),
        JSON.stringify(volcado(g.almacen)));
    check('I9 · no toca las claves de equipo',
        g.almacen.datos.get('darkMode') === 'true' &&
        g.almacen.datos.get('sesionActiva') === '{"email":"juan@x.com"}');

    const disco = JSON.stringify(volcado(g.almacen));
    const e2 = g.api.activarYMigrar('juan_at_x_com');
    check('I10 · la segunda llamada no vuelve a migrar ni cambia el disco',
        !!e2 && e2.activa === true && JSON.stringify(volcado(g.almacen)) === disco);

    /* Nunca lanza y no cambia nada con un correo que no sirve. */
    const antesVacio = JSON.stringify(volcado(g.almacen));
    let lanzo = '';
    let rVacio, rNulo, rIndef;
    try {
        rVacio = g.api.activarYMigrar('');
        rNulo = g.api.activarYMigrar(null);
        rIndef = g.api.activarYMigrar(undefined);
    } catch (err) { lanzo = err.message; }
    check('I11 · con correo vacío/null/undefined NO lanza y devuelve null',
        !lanzo && rVacio === null && rNulo === null && rIndef === null, lanzo || JSON.stringify([rVacio, rNulo, rIndef]));
    check('I12 · y no cambia el almacén',
        JSON.stringify(volcado(g.almacen)) === antesVacio);
    check('I13 · la cuenta que ya estaba activa sigue activa',
        g.api.estado().activa === true && g.api.estado().emailPath === 'juan_at_x_com');

    /* Sin intercepción (Storage.prototype no disponible) tampoco lanza. */
    const g2 = cargarModulo({ sinStorage: true, local: { ciervo_inventory: '["X"]' } });
    let lanzo2 = '';
    let r2 = 'sin-llamar';
    try { r2 = g2.api.activarYMigrar('a_at_x_com'); } catch (err) { lanzo2 = err.message; }
    check('I14 · sin intercepción devuelve null, no lanza y no toca los datos',
        !lanzo2 && r2 === null && g2.almacen.datos.get('ciervo_inventory') === '["X"]',
        lanzo2 || JSON.stringify(r2));

    /* Equipo marcado que ya venía activado en modo perezoso: la llamada de la página
       solo migra lo que falte. */
    const g3 = cargarModulo({
        local: { datosDeCuenta: 'a_at_x_com', 'cuenta:a_at_x_com:hecho': '1', ciervo_clients: '["LEGADO"]' }
    });
    const e3 = g3.api.activarYMigrar('a_at_x_com');
    check('I15 · sobre un equipo ya activado, migra el legado y deja el sello',
        !!e3 && e3.activa === true && e3.migrada === true &&
        L(g3).getItem('ciervo_clients') === '["LEGADO"]' &&
        !g3.almacen.datos.has('ciervo_clients'),
        JSON.stringify(e3));
}

/* =====================================================================
   J. INVARIANTES DE LOS ARCHIVOS Y DE LA PÁGINA PILOTO
   ===================================================================== */
console.log('\n================ J. ARCHIVOS Y PÁGINA PILOTO ================\n');

try {
    let errSintaxis = '';
    try { new vm.Script(CRUDO); } catch (e) { errSintaxis = e.message; }
    check('datos_cuenta.js · compila', !errSintaxis, errSintaxis);
    check('datos_cuenta.js · usa CRLF en todas sus líneas', !/(?<!\r)\n/.test(CRUDO));

    const sinComentarios = CRUDO.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    check('datos_cuenta.js · expone la API en window.datosCuenta',
        ['activarPara', 'desactivar', 'migrarAlaCuenta', 'activarYMigrar', 'estado', 'limpiarCuenta']
            .every((f) => new RegExp(f + '\\s*:').test(CRUDO)));
    check('datos_cuenta.js · no toca sessionStorage en el código',
        !/sessionStorage/.test(sinComentarios));
    check('datos_cuenta.js · no usa clear() (nunca borra el almacén entero)',
        !/\.clear\s*\(/.test(sinComentarios));
    check('datos_cuenta.js · no menciona claves de negocio concretas',
        !/ciervo_inventory|pos_sales|ciervo_clients|companyData|receiptSettings/.test(sinComentarios));
    check('datos_cuenta.js · usa las funciones originales para migrar y limpiar',
        /originales\.getItem\.call/.test(CRUDO) && /originales\.removeItem\.call/.test(CRUDO));
    check('datos_cuenta.js · nombra las 5 claves de equipo',
        ['datosDeCuenta', 'sesionActiva', 'rememberedEmail', 'darkMode', 'theme']
            .every((k) => CRUDO.indexOf("'" + k + "'") !== -1));
} catch (e) {
    check('datos_cuenta.js legible', false, e.message);
}

try {
    const POS = fs.readFileSync('mini_market_pos.html', 'utf8');
    const LF = POS.replace(/\r\n/g, '\n');

    check('mini_market_pos.html · usa CRLF en todas sus líneas', !/(?<!\r)\n/.test(POS));

    /* datos_cuenta.js es LO PRIMERO del <head>, antes que cualquier otro script. */
    const primerTag = POS.match(/<script[^>]*>/i);
    check('mini_market_pos.html · carga datos_cuenta.js como primer <script> de la página',
        !!primerTag && /datos_cuenta\.js/.test(primerTag[0]), primerTag ? primerTag[0] : 'sin <script>');

    const iDatos = POS.indexOf('src="datos_cuenta.js"');
    const anteriores = ['cloud-access.js', 'sincronizacion.js', 'almacenamiento.js', 'cuenta_local.js', 'motor_operaciones.js'];
    check('mini_market_pos.html · se carga antes que sincronizacion/almacenamiento/cuenta_local',
        iDatos !== -1 && anteriores.every((f) => iDatos < POS.indexOf('src="' + f + '"')),
        anteriores.map((f) => f + '=' + POS.indexOf('src="' + f + '"')).join(' '));
    check('mini_market_pos.html · sigue cargando cuenta_local.js (la fase 1 no se toca)',
        /<script[^>]+src=["']cuenta_local\.js["']/.test(POS));

    /* El arranque: se activa y se migra (una sola vez) en cuanto se conoce el correo. */
    check('mini_market_pos.html · el arranque activa la cuenta con el emailPath',
        /datosCuenta\.activarPara\(\s*emailPath\s*\)/.test(POS));
    check('mini_market_pos.html · el arranque migra una sola vez si no se ha migrado',
        /datosCuenta\.migrarAlaCuenta\(\s*emailPath\s*\)/.test(POS) &&
        /\.migrada/.test(POS));
    check('mini_market_pos.html · el aislamiento va al principio del arranque, antes de leer ajustes',
        (() => {
            const iLoad = LF.indexOf('loadSavedSettings();');
            const iReg = LF.lastIndexOf("document.addEventListener('DOMContentLoaded'", iLoad);
            if (iLoad === -1 || iReg === -1) return false;
            return LF.slice(iReg, iLoad).indexOf('aislarDatosPorCuenta();') !== -1;
        })());
    check('mini_market_pos.html · el aislamiento está envuelto en try/catch (nunca frena el POS)',
        /function aislarDatosPorCuenta\(\)\s*\{\s*try\s*\{/.test(LF));

    /* Todos los bloques en línea de la página siguen compilando. */
    const bloques = [...POS.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    let errorBloques = '';
    for (const b of bloques) {
        try { new vm.Script(b); } catch (e) { errorBloques = e.message; break; }
    }
    check('mini_market_pos.html · sintaxis de sus ' + bloques.length + ' bloques en línea', !errorBloques, errorBloques);
    check('mini_market_pos.html · la lógica de venta sigue intacta (motores y cobro)',
        /function reserveLocalSaleId/.test(LF) && /async function uploadToFirebase/.test(LF) &&
        /function loadSavedSettings/.test(LF));

    /* Prueba de extremo a extremo del arranque REAL del piloto: se extrae del HTML la
       función `aislarDatosPorCuenta` tal como quedó escrita y se ejecuta en un sandbox
       con el módulo real y datos legados sin prefijo. */
    const iFn = LF.indexOf('function aislarDatosPorCuenta()');
    const iFin = LF.indexOf('\n        }', iFn);
    const fuente = (iFn !== -1 && iFin !== -1) ? LF.slice(iFn, iFin + 11) : '';

    const g = cargarModulo({
        local: {
            datosDeCuenta: 'juan_at_x_com',
            ciervo_inventory: '[{"id":1}]',
            pos_last_sale_number: '57',
            sesionActiva: '{"email":"juan@x.com"}',
            darkMode: 'true'
        }
    });
    g.ctx.getCurrentUserEmail = () => 'juan@x.com';
    g.ctx.sanitizeEmailForDb = (e) => String(e).replace('@', '_at_').replace(/\./g, '_');
    let errorArranque = '';
    try { vm.runInContext(fuente + '\naislarDatosPorCuenta();', g.ctx); } catch (e) { errorArranque = e.message; }

    check('arranque del POS · la función real se ejecuta sin lanzar', !!fuente && !errorArranque, errorArranque);
    check('arranque del POS · la cuenta queda activa y los datos legados migrados',
        g.api.estado().activa === true &&
        g.local.getItem('ciervo_inventory') === '[{"id":1}]' &&
        g.local.getItem('pos_last_sale_number') === '57' &&
        !clavesFisicas(g.almacen).includes('ciervo_inventory'),
        JSON.stringify(volcado(g.almacen)));
    check('arranque del POS · no toca las claves de equipo',
        g.almacen.datos.get('darkMode') === 'true' &&
        g.almacen.datos.get('sesionActiva') === '{"email":"juan@x.com"}');
    check('arranque del POS · deja constancia de la migración',
        g.api.estado().migrada === true &&
        g.almacen.datos.get('cuenta:juan_at_x_com:datosCuentaMigrado') === '1');

    const discoTrasArranque = JSON.stringify(volcado(g.almacen));
    vm.runInContext('aislarDatosPorCuenta();', g.ctx);
    check('arranque del POS · la segunda carga no vuelve a migrar nada',
        JSON.stringify(volcado(g.almacen)) === discoTrasArranque &&
        g.local.getItem('ciervo_inventory') === '[{"id":1}]');

    /* Sin sesión (getCurrentUserEmail no devuelve correo) no se toca nada. */
    const g2 = cargarModulo({ local: { ciervo_inventory: '["LEGADO"]' } });
    g2.ctx.getCurrentUserEmail = () => null;
    g2.ctx.sanitizeEmailForDb = (e) => String(e);
    vm.runInContext(fuente + '\naislarDatosPorCuenta();', g2.ctx);
    check('arranque del POS · sin correo no se activa ni se migra nada',
        g2.api.estado().activa === false &&
        g2.almacen.datos.get('ciervo_inventory') === '["LEGADO"]');
} catch (e) {
    check('mini_market_pos.html legible', false, e.message);
}

/* =====================================================================
   K. EL LOTE COMPLETO: las 14 páginas cargan el módulo y activan la cuenta
   ===================================================================== */
console.log('\n================ K. LOTE COMPLETO (14 páginas) ================\n');

const PAGINAS_LOTE = [
    'index.html',
    'inventario.html',
    'catalogo.html',
    'compras.html',
    'cuentas.html',
    'config_recibo.html',
    'gestion_empresa.html',
    'gestion_proveedores.html',
    'listado_clientes.html',
    'mini_market_pos.html',
    'mini_market_pos_resumen.html',
    'config.html',
    'menu.html',
    'calcular_precio_ven.html'
];

/* Scripts propios que SIEMPRE deben cargarse DESPUÉS del módulo de aislamiento. */
const SCRIPTS_PROPIOS = [
    'cloud-access.js', 'sincronizacion.js', 'almacenamiento.js', 'cuenta_local.js',
    'motor_operaciones.js', 'lector_ventas.js', 'sesion.js', 'cerrar_sesion.js'
];

check('son las 14 páginas del lote (12 de la fase 1 + menu.html + calcular_precio_ven.html)',
    PAGINAS_LOTE.length === 14);

const bloquesDeLote = {};
for (const archivo of PAGINAS_LOTE) {
    let t = '';
    try { t = fs.readFileSync(archivo, 'utf8'); }
    catch (e) { check(archivo + ' legible', false, e.message); continue; }

    check(archivo + ' · carga datos_cuenta.js',
        /<script[^>]+src=["']datos_cuenta\.js["']/.test(t));

    /* El módulo va DENTRO del <head> y antes que cualquier otro script propio. */
    const iModulo = t.indexOf('src="datos_cuenta.js"');
    const iCierreHead = t.indexOf('</head>');
    const tarde = SCRIPTS_PROPIOS.filter((f) => {
        const i = t.indexOf('src="' + f + '"');
        return i >= 0 && (i < iModulo);
    });
    check(archivo + ' · el módulo va el primero y dentro del <head>',
        iModulo !== -1 && iCierreHead !== -1 && iModulo < iCierreHead && tarde.length === 0,
        'iModulo=' + iModulo + ' </head>=' + iCierreHead + ' antes=' + JSON.stringify(tarde));

    /* Activación en el arranque: la receta del lote (activarYMigrar) o el ayudante del
       piloto del POS, que usa la API explícita (activarPara + migrarAlaCuenta). */
    const porReceta = /datosCuenta\.activarYMigrar\(/.test(t);
    const porPiloto = /datosCuenta\.activarPara\(/.test(t) && /datosCuenta\.migrarAlaCuenta\(/.test(t);
    check(archivo + ' · el arranque activa la cuenta (' + (porPiloto ? 'ayudante del piloto' : 'activarYMigrar') + ')',
        porReceta || porPiloto);

    /* La activación no puede lanzar aunque la página se quede sin correo: o la llamada va
       guardada con `window.datosCuenta`, o (el piloto) el ayudante comprueba el correo. */
    const lineaActivacion = (t.match(/^.*activarYMigrar\([^\n]*$/m) || [''])[0];
    const guardada = porReceta
        ? (/window\.datosCuenta/.test(lineaActivacion) && !/sanitizeEmailForDb\(getCurrentUserEmail\(\)\)/.test(t))
        : (/function aislarDatosPorCuenta\(\)[\s\S]{0,400}?if \(!email\) return;/.test(t));
    check(archivo + ' · la activación no puede lanzar si la página se queda sin correo',
        guardada, lineaActivacion.trim());

    check(archivo + ' · usa CRLF en todas sus líneas', !/(?<!\r)\n/.test(t));

    bloquesDeLote[archivo] = [...t.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

/* Todos los bloques en línea de todas las páginas del lote siguen compilando. */
{
    let totalBloques = 0;
    let error = '';
    for (const archivo of Object.keys(bloquesDeLote)) {
        for (const b of bloquesDeLote[archivo]) {
            totalBloques++;
            try { new vm.Script(b); } catch (e) { error = archivo + ': ' + e.message; break; }
        }
        if (error) break;
    }
    check('las 14 páginas · sintaxis de sus ' + totalBloques + ' bloques en línea', !error, error);
}

/* Casos concretos del lote que no son una simple inserción. */
try {
    const config = fs.readFileSync('config.html', 'utf8');
    check('config.html · el reinicio de fábrica limpia las claves de la cuenta activa',
        /datosCuenta\.limpiarCuenta\(/.test(config));
    check('config.html · lo hace ANTES de liberar el equipo (la fase 1 sigue mandando después)',
        config.indexOf('datosCuenta.limpiarCuenta(') < config.indexOf('cuentaLocal.liberarEquipo()'));

    const menu = fs.readFileSync('menu.html', 'utf8');
    /* Los dos sembradores de ejemplo (inventario y cuentas) quedan comentados. */
    const sembradoresApagados = (menu.match(/^\s*\/\/ this\.saveData\('(?:inventory|accounts)'\);/gm) || []).length;
    check('menu.html · el sembrador de datos de EJEMPLO ya no persiste en el almacén',
        !/^\s*this\.saveData\('inventory'\);/m.test(menu) && sembradoresApagados === 2,
        'sembradores apagados=' + sembradoresApagados);
    check('menu.html · los guardados legítimos del usuario siguen intactos',
        /this\.saveData\(store\)/.test(menu) &&
        /this\.saveData\('accounts'\); \/\/ Save updated status/.test(menu));
    check('menu.html · activa la cuenta del equipo sin depender de getCurrentUserEmail',
        /datosCuenta\.activarYMigrar\(localStorage\.getItem\('datosDeCuenta'\)/.test(menu));
} catch (e) {
    check('config.html/menu.html legibles', false, e.message);
}

/* ===================================================================== */
console.log('\n================ ' + ok + ' OK, ' + fallos + ' FALLAS ================');
console.log('Nota: el aislamiento es transparente para el resto del código (prefijo por cuenta');
console.log('      sobre localStorage); la migración es idempotente y nunca pisa lo ya migrado.');
process.exit(fallos === 0 ? 0 : 1);
