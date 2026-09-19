/* =====================================================================
   PRUEBAS DEL LECTOR DE VENTAS (Fase B, etapa E2)

   Se ejecuta con:  node pruebas_lector_ventas.js

   Comprueba que `lector_ventas.js` une los DOS MUNDOS sin duplicar ni perder
   nada y que, en modo clásico, devuelve exactamente lo de siempre.

   1) Un rango que cruza los dos mundos devuelve TODAS las ventas, sin repetir.
   2) Una venta presente en los dos (mismo id) se cuenta UNA sola vez.
   3) `resumenDelDia` usa `ventas_idx` cuando está completo; si falta o está
      incompleto lo recalcula y lo marca con `completo:false`.
   4) Sin conexión devuelve lo local y lista los días que faltan.
   5) Modo 'clasico': mismo resultado que la lectura clásica (no regresión).
   6) `ventas/historial` no recibe NINGUNA escritura (contador = 0).
   7) Los errores de lectura devuelven `ok:false` con `error`, sin lanzar.

   El Firebase se simula con un servidor en memoria que implementa lo justo
   del SDK v8: `ref().orderByChild().startAt().endAt().limitToFirst().once()`
   y un `set()` que APUNTA cada escritura (para poder demostrar que el lector
   no escribe). NO es un navegador: ver la nota final.
   ===================================================================== */
'use strict';
const fs = require('fs');
const vm = require('vm');

let ok = 0, fallos = 0;
const check = (nombre, condicion, extra = '') => {
    if (condicion) { ok++; console.log('OK    ' + nombre); }
    else { fallos++; console.log('FALLA ' + nombre + (extra ? '  -> ' + extra : '')); }
};
const nota = (t) => console.log('      ' + t);

const EMAIL = 'cliente_at_ejemplo_com';
const DEV = 'DEV1';
const INST = 'AAAA';

/* ============ 1. SERVIDOR Y SDK SIMULADOS ============ */

const ESCRITURAS_GLOBALES = [];      // T6: aquí se acumula TODO lo escrito

function clonar(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }

function escribirEn(raiz, ruta, valor) {
    const partes = String(ruta).split('/').filter(Boolean);
    let nodo = raiz;
    for (let i = 0; i < partes.length - 1; i++) {
        if (nodo[partes[i]] === null || typeof nodo[partes[i]] !== 'object') nodo[partes[i]] = {};
        nodo = nodo[partes[i]];
    }
    nodo[partes[partes.length - 1]] = clonar(valor);
}

function leerDe(raiz, ruta) {
    let nodo = raiz;
    for (const p of String(ruta).split('/').filter(Boolean)) {
        if (nodo === null || nodo === undefined || typeof nodo !== 'object') return null;
        nodo = nodo[p];
    }
    return nodo === undefined ? null : clonar(nodo);
}

function borrarDe(raiz, ruta) {
    const partes = String(ruta).split('/').filter(Boolean);
    let nodo = raiz;
    for (let i = 0; i < partes.length - 1; i++) {
        if (!nodo || typeof nodo !== 'object') return;
        nodo = nodo[partes[i]];
    }
    if (nodo && typeof nodo === 'object') delete nodo[partes[partes.length - 1]];
}

function normalizarPares(valor) {
    const salida = [];
    if (!valor) return salida;
    if (Array.isArray(valor)) {
        valor.forEach((v, i) => { if (v !== null && v !== undefined) salida.push({ clave: String(i), valor: v }); });
        return salida;
    }
    if (typeof valor !== 'object') return salida;
    Object.keys(valor).forEach((k) => { if (valor[k] !== null && valor[k] !== undefined) salida.push({ clave: k, valor: valor[k] }); });
    return salida;
}

function valorOrden(valor, campo) {
    if (!valor || typeof valor !== 'object') return '';
    const v = valor[campo];
    return (v === null || v === undefined) ? '' : String(v);
}

function compararOrden(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

function crearServidor(datos) {
    return { datos: datos || {}, escrituras: [], lecturas: [] };
}

/** Aplica una consulta al nodo (lo que haría el servidor de RTDB). */
function aplicarConsulta(servidor, estado) {
    const nodo = leerDe(servidor.datos, estado.ruta);
    if (nodo === null || nodo === undefined) return null;
    if (!estado.orden) return nodo;
    let pares = normalizarPares(nodo);
    pares.sort((a, b) => {
        const c = compararOrden(valorOrden(a.valor, estado.orden), valorOrden(b.valor, estado.orden));
        if (c) return c;
        return compararOrden(String(a.clave), String(b.clave));
    });
    if (estado.ini !== null && estado.ini !== undefined) {
        pares = pares.filter((p) => {
            const c = compararOrden(valorOrden(p.valor, estado.orden), String(estado.ini));
            if (c > 0) return true;
            if (c < 0) return false;
            return !estado.iniClave || String(p.clave) >= String(estado.iniClave);
        });
    }
    if (estado.fin !== null && estado.fin !== undefined) {
        pares = pares.filter((p) => compararOrden(valorOrden(p.valor, estado.orden), String(estado.fin)) <= 0);
    }
    if (estado.limite > 0) pares = estado.desdeFinal ? pares.slice(-estado.limite) : pares.slice(0, estado.limite);
    if (!pares.length) return null;
    const salida = {};
    pares.forEach((p) => { salida[p.clave] = clonar(p.valor); });
    return salida;
}

function crearRef(servidor, estado) {
    const copia = (cambios) => crearRef(servidor, Object.assign({}, estado, cambios));
    const ref = {
        orderByChild: (campo) => copia({ orden: campo, ini: null, iniClave: null, fin: null }),
        orderByKey: () => copia({ orden: '$clave', ini: null, iniClave: null, fin: null }),
        startAt: (v, k) => copia({ ini: v, iniClave: (k === undefined ? null : String(k)) }),
        endAt: (v, k) => copia({ fin: v, finClave: (k === undefined ? null : String(k)) }),
        limitToFirst: (n) => copia({ limite: n, desdeFinal: false }),
        limitToLast: (n) => copia({ limite: n, desdeFinal: true }),
        once: () => {
            servidor.lecturas.push(estado.ruta + (estado.orden ? '?orderBy=' + estado.orden : ''));
            return Promise.resolve({ val: () => aplicarConsulta(servidor, estado) });
        },
        on: () => ref,
        off: () => ref,
        /* Cualquier escritura se apunta: el lector no debe usar ninguna. */
        set: (valor) => {
            const registro = { ruta: estado.ruta, valor: clonar(valor) };
            servidor.escrituras.push(registro);
            ESCRITURAS_GLOBALES.push(registro);
            escribirEn(servidor.datos, estado.ruta, valor);
            return Promise.resolve(true);
        },
        update: (valor) => {
            const registro = { ruta: estado.ruta, valor: clonar(valor) };
            servidor.escrituras.push(registro);
            ESCRITURAS_GLOBALES.push(registro);
            escribirEn(servidor.datos, estado.ruta, valor);
            return Promise.resolve(true);
        },
        remove: () => {
            const registro = { ruta: estado.ruta, valor: null };
            servidor.escrituras.push(registro);
            ESCRITURAS_GLOBALES.push(registro);
            borrarDe(servidor.datos, estado.ruta);
            return Promise.resolve(true);
        }
    };
    return ref;
}

/** Base de datos con consultas (camino paginado del lector). */
function crearDb(servidor) {
    return {
        ref: (ruta) => crearRef(servidor, { ruta: ruta, orden: null, ini: null, iniClave: null, fin: null, limite: 0, desdeFinal: false })
    };
}

/** Base de datos SIN consultas: obliga al lector al camino "leer entero". */
function crearDbBasico(servidor) {
    return {
        ref: (ruta) => ({
            once: () => {
                servidor.lecturas.push(ruta);
                return Promise.resolve({ val: () => leerDe(servidor.datos, ruta) });
            },
            on: function () { return this; },
            set: (valor) => {
                const registro = { ruta: ruta, valor: clonar(valor) };
                servidor.escrituras.push(registro);
                ESCRITURAS_GLOBALES.push(registro);
                escribirEn(servidor.datos, ruta, valor);
                return Promise.resolve(true);
            }
        })
    };
}

/* ============ 2. DATOS DE PRUEBA (los dos mundos) ============ */

function venta(id, isoFecha, total, metodo, opciones) {
    opciones = opciones || {};
    const moneda = opciones.currency || 'VES';
    const tasa = opciones.tasa === undefined ? 100 : opciones.tasa;
    return {
        id: id,
        items: [{
            product: { name: 'Producto ' + id, category: 'general', code: 'C-' + id, price: total, cost: 0, isBulk: false },
            quantity: 1, unit: 'unidades', unitPrice: total, subtotal: total, currency: moneda
        }],
        paymentMethod: metodo,
        paymentDetails: opciones.paymentDetails || {},
        combinedPayment: null,
        currency: moneda,
        totals: { subtotal: total, total: total },
        timestamp: isoFecha,
        customer: null,
        exchangeRate: tasa,
        rateSource: 'manual',
        ivaApplied: false
    };
}

function nodoOp(dev, inst, sec) { return dev + '_' + inst + '_' + String(sec).padStart(4, '0'); }

function operacion(dev, inst, sec, fechaISO, v) {
    return { id: v.id, tipo: 'venta', deviceId: dev, installId: inst, secuencia: sec, fechaISO: fechaISO, version: 1, payload: v };
}

/*  Mundo VIEJO (congelado): 2026-03-01 (fuera de rango), 03-10 y 03-11.
    Mundo NUEVO (operaciones): 03-11 (una repetida del mundo viejo), 03-12 y 03-13. */
const H0 = venta('V-LOCAL-DEV1-0000', '2026-03-01T15:00:00.000Z', 50, 'efectivo');
const H1 = venta('V-LOCAL-DEV1-0001', '2026-03-11T10:00:00.000Z', 100, 'efectivo');
const H2 = venta('V-LOCAL-DEV1-0002', '2026-03-11T15:00:00.000Z', 200, 'pago-movil');
const O0 = operacion(DEV, INST, 1, '2026-03-11T16:00:00.000Z', venta('V-LOCAL-DEV1-0001', '2026-03-11T16:00:00.000Z', 100, 'efectivo'));
const O1 = operacion(DEV, INST, 3, '2026-03-12T15:00:00.000Z', venta('V-LOCAL-DEV1-0003', '2026-03-12T15:00:00.000Z', 300, 'efectivo'));
const O2 = operacion(DEV, INST, 4, '2026-03-13T15:00:00.000Z', venta('V-LOCAL-DEV1-0004', '2026-03-13T15:00:00.000Z', 400, 'usd-cash', { currency: 'USD' }));
const O3 = operacion(DEV, INST, 5, '2026-03-13T18:00:00.000Z', venta('V-LOCAL-DEV1-0005', '2026-03-13T18:00:00.000Z', 500, 'efectivo'));

function datosBase() {
    const datos = {};
    escribirEn(datos, 'BBDD/' + EMAIL + '/ventas/historial', [H0, H1, H2]);
    escribirEn(datos, 'BBDD/' + EMAIL + '/ops/venta/' + nodoOp(DEV, INST, 1), O0);
    escribirEn(datos, 'BBDD/' + EMAIL + '/ops/venta/' + nodoOp(DEV, INST, 3), O1);
    escribirEn(datos, 'BBDD/' + EMAIL + '/ops/venta/' + nodoOp(DEV, INST, 4), O2);
    escribirEn(datos, 'BBDD/' + EMAIL + '/ops/venta/' + nodoOp(DEV, INST, 5), O3);
    return datos;
}

function servidorBase() { return crearServidor(datosBase()); }

const sumaTotales = (ventas) => ventas.reduce((s, v) => s + (Number(v.totals && v.totals.total) || 0), 0);
const ids = (ventas) => ventas.map((v) => String(v.id));

/* ============ 3. LECTOR EN UN SANDBOX (como en el navegador) ============ */

const FUENTE_LECTOR = fs.readFileSync('lector_ventas.js', 'utf8');
const almacenLocal = {};
const almacenSesion = {};

const entorno = {
    console: console,
    localStorage: {
        getItem: (k) => (k in almacenLocal ? almacenLocal[k] : null),
        setItem: (k, v) => { almacenLocal[k] = String(v); },
        removeItem: (k) => { delete almacenLocal[k]; },
        key: (i) => Object.keys(almacenLocal)[i],
        get length() { return Object.keys(almacenLocal).length; }
    },
    sessionStorage: {
        getItem: (k) => (k in almacenSesion ? almacenSesion[k] : null),
        setItem: (k, v) => { almacenSesion[k] = String(v); },
        removeItem: (k) => { delete almacenSesion[k]; }
    },
    navigator: { onLine: true }
};
entorno.window = entorno;
vm.createContext(entorno);
vm.runInContext(FUENTE_LECTOR.replace(/\r\n/g, '\n'), entorno);
const lector = entorno.lectorVentas;

function opciones(extra) {
    return Object.assign({ modoSync: 'operaciones', db: null, emailPath: EMAIL }, extra || {});
}

(async function ejecutar() {

    /* ============ A. EL RANGO CRUZA LOS DOS MUNDOS ============ */
    console.log('================ A. UN RANGO, DOS MUNDOS ================\n');
    {
        const s = servidorBase();
        const r = await lector.leerVentas(opciones({ desde: '2026-03-11', hasta: '2026-03-13', db: crearDb(s) }));

        check('A1 · la lectura termina bien', r.ok === true, JSON.stringify(r.error));
        check('A2 · el rango devuelve TODAS las ventas de los dos mundos (5)',
            r.ventas.length === 5, JSON.stringify(ids(r.ventas)));
        check('A3 · y sin duplicados', new Set(ids(r.ventas)).size === r.ventas.length);
        check('A4 · los dos orígenes aportaron (ops + histórico congelado)',
            r.origen.ops === 4 && r.origen.historicoCongelado === 1,
            JSON.stringify(r.origen));
        check('A5 · el total suma los dos mundos (1500)', sumaTotales(r.ventas) === 1500, String(sumaTotales(r.ventas)));
        check('A6 · lo que está fuera del rango no entra (H0 del 03-01)',
            !ids(r.ventas).some((id) => id.endsWith('0000')));
        check('A7 · ordenadas por fecha',
            r.ventas[0].timestamp === '2026-03-11T15:00:00.000Z' && r.ventas[4].timestamp === '2026-03-13T18:00:00.000Z');

        /* ---- T2: la repetida se cuenta UNA vez ---- */
        const repetidas = r.ventas.filter((v) => String(v.id) === 'V-LOCAL-DEV1-0001');
        check('A8 · una venta en los dos mundos (mismo id) se cuenta una sola vez',
            repetidas.length === 1, 'aparece ' + repetidas.length + ' veces');
        check('A9 · y la que sobrevive es la operación (mundo nuevo)',
            repetidas.length === 1 && repetidas[0].timestamp === '2026-03-11T16:00:00.000Z');
        check('A10 · el histórico congelado solo se leyó, nunca se escribió',
            s.escrituras.length === 0);

        /* ---- `pos_sales` local duplicando los dos mundos ---- */
        const sDup = servidorBase();
        const soloLocal = venta('V-LOCAL-DEV1-0008', '2026-03-13T20:00:00.000Z', 800, 'efectivo');
        almacenLocal['pos_sales'] = JSON.stringify([H0, H1, H2, O1.payload, O2.payload, soloLocal]);
        const rDup = await lector.leerVentas(opciones({ db: crearDb(sDup) }));
        delete almacenLocal['pos_sales'];
        check('A11 · ni con pos_sales duplicando los dos mundos hay repetidas (7 únicas)',
            rDup.ok === true && rDup.ventas.length === 7 && new Set(ids(rDup.ventas)).size === 7,
            JSON.stringify(ids(rDup.ventas)));
        check('A12 · y lo que solo está en el equipo también sale (1 local)',
            rDup.origen.locales === 1 && ids(rDup.ventas).some((id) => id.endsWith('0008')),
            JSON.stringify(rDup.origen));

        /* ---- Sin id: se compara por fecha + total + referencia de ticket ---- */
        const sinIdHist = venta('', '2026-03-12T10:00:00.000Z', 77, 'efectivo', { paymentDetails: { reference: 'T-77' } });
        delete sinIdHist.id;
        const sinIdOp = venta('', '2026-03-12T10:00:00.000Z', 77, 'efectivo', { paymentDetails: { reference: 'T-77' } });
        delete sinIdOp.id;
        const datosSinId = {};
        escribirEn(datosSinId, 'BBDD/' + EMAIL + '/ventas/historial', [sinIdHist]);
        escribirEn(datosSinId, 'BBDD/' + EMAIL + '/ops/venta/' + nodoOp(DEV, INST, 9),
            operacion(DEV, INST, 9, '2026-03-12T10:00:00.000Z', sinIdOp));
        const rSinId = await lector.leerVentas(opciones({ desde: '2026-03-12', hasta: '2026-03-12', db: crearDb(crearServidor(datosSinId)) }));
        check('A13 · sin id se compara por fecha + total + ticket y no se duplica',
            rSinId.ok === true && rSinId.ventas.length === 1, JSON.stringify(ids(rSinId.ventas)));

        const sinIdOp2 = venta('', '2026-03-12T10:00:00.000Z', 88, 'efectivo', { paymentDetails: { reference: 'T-77' } });
        delete sinIdOp2.id;
        const datosSinId2 = {};
        escribirEn(datosSinId2, 'BBDD/' + EMAIL + '/ventas/historial', [sinIdHist]);
        escribirEn(datosSinId2, 'BBDD/' + EMAIL + '/ops/venta/' + nodoOp(DEV, INST, 9),
            operacion(DEV, INST, 9, '2026-03-12T10:00:00.000Z', sinIdOp2));
        const rSinId2 = await lector.leerVentas(opciones({ desde: '2026-03-12', hasta: '2026-03-12', db: crearDb(crearServidor(datosSinId2)) }));
        check('A14 · si cambia el total son dos ventas distintas (no se pisan)',
            rSinId2.ventas.length === 2, JSON.stringify(ids(rSinId2.ventas)));
    }

    /* ============ B. PAGINACIÓN Y CAMINO SIN CONSULTAS ============ */
    console.log('\n================ B. PAGINACIÓN Y LECTURA ENTERA ================\n');
    {
        const s = servidorBase();
        const paginado = await lector.leerVentas(opciones({ db: crearDb(s), tamanoPagina: 2 }));
        const entero = await lector.leerVentas(opciones({ db: crearDb(servidorBase()) }));

        check('B1 · con páginas pequeñas no se pierde ninguna operación',
            JSON.stringify(ids(paginado.ventas).sort()) === JSON.stringify(ids(entero.ventas).sort()),
            JSON.stringify(ids(paginado.ventas)) + ' vs ' + JSON.stringify(ids(entero.ventas)));
        check('B2 · la lectura se hizo por páginas de verdad',
            s.lecturas.filter((l) => l.indexOf('ops/venta') >= 0).length > 1,
            JSON.stringify(s.lecturas));
        check('B3 · paginado y sin consultas dan el mismo resultado',
            sumaTotales(paginado.ventas) === sumaTotales(entero.ventas) && paginado.ventas.length === entero.ventas.length);

        const sBasico = servidorBase();
        const sinConsultas = await lector.leerVentas(opciones({ db: crearDbBasico(sBasico) }));
        check('B4 · sin consultas disponibles se lee el nodo entero y se filtra igual',
            JSON.stringify(ids(sinConsultas.ventas).sort()) === JSON.stringify(ids(entero.ventas).sort()),
            JSON.stringify(ids(sinConsultas.ventas)));
        check('B5 · tampoco en ese camino se escribe nada', sBasico.escrituras.length === 0);
    }

    /* ============ C. resumenDelDia Y EL ÍNDICE ============ */
    console.log('\n================ C. resumenDelDia Y ventas_idx ================\n');
    {
        /* C1-C2: índice COMPLETO (con valores distintos a las ventas, para que
           se vea que de verdad se usa el índice y no el recálculo). */
        const s = servidorBase();
        escribirEn(s.datos, 'BBDD/' + EMAIL + '/ventas_idx/2026-03-12/' + nodoOp(DEV, INST, 3),
            { total: 999, totalUSD: 9.99, items: 1, metodo: 'efectivo' });
        const r1 = await lector.resumenDelDia('2026-03-12', opciones({ db: crearDb(s) }));
        check('C1 · con ventas_idx COMPLETO se usa el índice (total 999, no 300)',
            r1.ok === true && r1.indexado === true && r1.total === 999, 'total=' + r1.total + ' indexado=' + r1.indexado);
        check('C2 · y se marca completo', r1.completo === true);
        check('C3 · el desglose por método sale del índice',
            r1.porMetodo['efectivo'] && r1.porMetodo['efectivo'].total === 999 && r1.porMetodo['efectivo'].cantidad === 1,
            JSON.stringify(r1.porMetodo));

        /* C4: índice INCOMPLETO (dos operaciones en el día, una sola en el índice). */
        escribirEn(s.datos, 'BBDD/' + EMAIL + '/ops/venta/' + nodoOp(DEV, INST, 6),
            operacion(DEV, INST, 6, '2026-03-12T20:00:00.000Z', venta('V-LOCAL-DEV1-0006', '2026-03-12T20:00:00.000Z', 60, 'pago-movil')));
        const r2 = await lector.resumenDelDia('2026-03-12', opciones({ db: crearDb(s) }));
        check('C4 · con el índice INCOMPLETO se recalcula desde las ventas (360)',
            r2.indexado === false && r2.total === 360, 'total=' + r2.total);
        check('C5 · y se avisa con completo:false', r2.completo === false);

        /* C6: índice AUSENTE. */
        const sSin = servidorBase();
        const r3 = await lector.resumenDelDia('2026-03-12', opciones({ db: crearDb(sSin) }));
        check('C6 · con el índice AUSENTE se recalcula (300) y se avisa',
            r3.indexado === false && r3.total === 300 && r3.completo === false, 'total=' + r3.total + ' completo=' + r3.completo);

        /* C7: día sin nada. */
        const r4 = await lector.resumenDelDia('2026-03-20', opciones({ db: crearDb(servidorBase()) }));
        check('C7 · un día sin ventas da cero y completo (no falta nada)',
            r4.ok === true && r4.cantidad === 0 && r4.total === 0 && r4.completo === true);

        /* C8: resumenRango (totales por día). */
        const rr = await lector.resumenRango('2026-03-11', '2026-03-13', opciones({ db: crearDb(servidorBase()) }));
        const porDia = {};
        (rr.dias || []).forEach((d) => { porDia[d.fecha] = d.total; });
        check('C8 · resumenRango da los totales por día',
            rr.ok === true && porDia['2026-03-11'] === 300 && porDia['2026-03-12'] === 300 && porDia['2026-03-13'] === 900,
            JSON.stringify(porDia));
        check('C9 · resumenRango cuadra con el total del rango (1500)', rr.total === 1500, 'total=' + rr.total);
        check('C10 · resumenRango incluye los días sin ventas a cero',
            (rr.dias || []).length === 3);
    }

    /* ============ D. SIN CONEXIÓN ============ */
    console.log('\n================ D. SIN CONEXIÓN ================\n');
    {
        const s = servidorBase();
        almacenLocal['pos_sales'] = JSON.stringify([venta('V-LOCAL-DEV1-0007', '2026-03-13T12:00:00.000Z', 700, 'efectivo')]);
        const caliente = [venta('V-LOCAL-DEV1-0009', '2026-03-12T12:00:00.000Z', 900, 'efectivo')];

        const r1 = await lector.leerVentas(opciones({
            desde: '2026-03-12', hasta: '2026-03-13', db: crearDb(s), online: false,
            fuentes: { caliente: async () => ({ ok: true, ventas: caliente }) }
        }));
        check('D1 · sin conexión devuelve lo local (ventana caliente + pos_sales)',
            r1.ok === true && r1.ventas.length === 2, JSON.stringify(ids(r1.ventas)));
        check('D2 · sin conexión no se toca la nube (ni una lectura)',
            s.lecturas.length === 0, JSON.stringify(s.lecturas));
        check('D3 · sin conexión los días cubiertos por lo local no faltan',
            r1.faltantes.length === 0, JSON.stringify(r1.faltantes));
        check('D4 · pero se avisa de que la lectura no está completa', r1.completo === false);

        const r2 = await lector.leerVentas(opciones({
            desde: '2026-03-12', hasta: '2026-03-13', db: crearDb(s), online: false,
            fuentes: { caliente: async () => ({ ok: true, ventas: [] }) }
        }));
        check('D5 · sin conexión se listan los días que no se pudieron leer',
            r2.faltantes.length === 1 && r2.faltantes[0] === '2026-03-12', JSON.stringify(r2.faltantes));
        check('D6 · y se devuelve lo que sí hay (pos_sales del 03-13)',
            r2.ok === true && r2.ventas.length === 1 && String(r2.ventas[0].id).endsWith('0007'));
    }

    /* ============ E. MODO CLÁSICO (NO REGRESIÓN) ============ */
    console.log('\n================ E. MODO CLÁSICO ================\n');
    {
        const s = servidorBase();
        const clasico = await lector.leerVentas({ modoSync: 'clasico', db: crearDb(s), emailPath: EMAIL });
        const historialDirecto = leerDe(s.datos, 'BBDD/' + EMAIL + '/ventas/historial');
        check('E1 · clásico devuelve EXACTAMENTE el historial de siempre',
            JSON.stringify(ids(clasico.ventas)) === JSON.stringify(historialDirecto.map((v) => v.id)),
            JSON.stringify(ids(clasico.ventas)) + ' vs ' + JSON.stringify(historialDirecto.map((v) => v.id)));
        check('E2 · clásico no mezcla ninguna operación del mundo nuevo',
            !ids(clasico.ventas).some((id) => id.endsWith('0003') || id.endsWith('0004') || id.endsWith('0005')));
        check('E3 · clásico no consulta ops/venta',
            !s.lecturas.some((l) => l.indexOf('ops/venta') >= 0), JSON.stringify(s.lecturas));
        check('E4 · clásico cuenta el origen como histórico congelado',
            clasico.origen.historicoCongelado === 3 && clasico.origen.ops === 0 && clasico.origen.locales === 0,
            JSON.stringify(clasico.origen));
        check('E5 · clásico no avisa de datos que falten', clasico.completo === true && clasico.faltantes.length === 0);

        /* Con cambios locales sin subir, la nube no pisa lo local (igual que hoy). */
        const locales = [
            venta('V-LOCAL-DEV1-0011', '2026-03-05T10:00:00.000Z', 111, 'efectivo'),
            venta('V-LOCAL-DEV1-0012', '2026-03-06T10:00:00.000Z', 222, 'efectivo')
        ];
        almacenLocal['pos_sales'] = JSON.stringify(locales);
        const sinPermiso = await lector.leerVentas({ modoSync: 'clasico', db: crearDb(servidorBase()), emailPath: EMAIL, puedeSobrescribir: false });
        check('E6 · clásico con cambios pendientes usa pos_sales local',
            JSON.stringify(ids(sinPermiso.ventas)) === JSON.stringify(ids(locales)) && sinPermiso.origen.locales === 2,
            JSON.stringify(ids(sinPermiso.ventas)));

        const sinNube = await lector.leerVentas({ modoSync: 'clasico', db: null, emailPath: '' });
        check('E7 · clásico sin nube usa pos_sales local igual que hoy',
            JSON.stringify(ids(sinNube.ventas)) === JSON.stringify(ids(locales)), JSON.stringify(ids(sinNube.ventas)));
    }

    /* ============ F. SIN ESCRITURAS EN ventas/historial ============ */
    console.log('\n================ F. NADA SE ESCRIBE ================\n');
    {
        const aHistorial = ESCRITURAS_GLOBALES.filter((e) => String(e.ruta).indexOf('/ventas/historial') >= 0);
        check('F1 · ventas/historial NO recibió ninguna escritura en todo el proceso',
            aHistorial.length === 0, JSON.stringify(aHistorial.map((e) => e.ruta)));
        check('F2 · el lector no escribió NADA en la nube (contador total = 0)',
            ESCRITURAS_GLOBALES.length === 0, JSON.stringify(ESCRITURAS_GLOBALES.map((e) => e.ruta)));

        const est = lector.estado();
        check('F3 · estado() trae modo, ultimaLectura, cacheVentas y error',
            typeof est.modo === 'string' && typeof est.ultimaLectura === 'string' &&
            typeof est.cacheVentas === 'number' && typeof est.error === 'string',
            JSON.stringify(est));
        check('F4 · estado() refleja la última lectura (clásico con 2 locales)',
            est.modo === 'clasico' && est.cacheVentas === 2, JSON.stringify(est));
    }

    /* ============ G. ERRORES DE LECTURA ============ */
    console.log('\n================ G. ERRORES SIN LANZAR ================\n');
    {
        const dbRoto = { ref: function () { throw new Error('sin conexión simulada'); } };
        const r1 = await lector.leerVentas(opciones({ db: dbRoto }));
        check('G1 · todos los orígenes de nube fallan -> ok:false con error',
            r1.ok === false && typeof r1.error === 'string' && r1.error.length > 0, JSON.stringify(r1.error));
        check('G2 · y aun así devuelve un objeto usable (arreglo de ventas)',
            Array.isArray(r1.ventas) && r1.completo === false);

        const dbRechaza = { ref: function () { return { once: function () { return Promise.reject(new Error('rechazo de red')); } }; } };
        const r2 = await lector.leerVentas(opciones({ db: dbRechaza }));
        check('G3 · una promesa rechazada tampoco lanza: ok:false con error',
            r2.ok === false && r2.error.length > 0, JSON.stringify(r2.error));

        let lanzo = false;
        let r3 = null;
        try { r3 = await lector.leerVentas({ desde: {}, hasta: [] }); }
        catch (e) { lanzo = true; }
        check('G4 · opciones basura no rompen el lector', lanzo === false && r3 && typeof r3.ok === 'boolean');

        const r4 = await lector.resumenDelDia('no-es-fecha');
        check('G5 · fecha inválida -> ok:false con error claro',
            r4.ok === false && r4.error === 'fecha-invalida', JSON.stringify(r4.error));

        const r5 = await lector.resumenDelDia('2026-03-12', opciones({ db: dbRoto }));
        check('G6 · resumenDelDia con la nube rota -> ok:false sin lanzar',
            r5.ok === false && typeof r5.error === 'string' && r5.error.length > 0, JSON.stringify(r5.error));

        const r6 = await lector.resumenRango('2026-03-01', '2026-03-31', opciones({ db: dbRoto }));
        check('G7 · resumenRango con la nube rota -> ok:false sin lanzar',
            r6.ok === false && typeof r6.error === 'string');

        /* Y la API prometida existe y es la del encargo. */
        check('G8 · la API expuesta es la del encargo',
            ['leerVentas', 'resumenDelDia', 'resumenRango', 'estado'].every((f) => typeof lector[f] === 'function'));
    }

    /* ============ H. INVARIANTES SOBRE LOS ARCHIVOS REALES ============ */
    console.log('\n================ H. ARCHIVOS REALES ================\n');
    {
        check('H1 · lector_ventas.js es CRLF (sin LF sueltos)',
            /\r\n/.test(FUENTE_LECTOR) && FUENTE_LECTOR.replace(/\r\n/g, '').indexOf('\n') === -1,
            'el archivo debe usar CRLF');
        let errSintaxis = '';
        try { new vm.Script(FUENTE_LECTOR.replace(/\r\n/g, '\n')); } catch (e) { errSintaxis = e.message; }
        check('H2 · lector_ventas.js · sintaxis', !errSintaxis, errSintaxis);
        check('H3 · el lector no contiene NINGUNA escritura (.set/.update/.remove/.transaction)',
            !/\.set\s*\(/.test(FUENTE_LECTOR) && !/\.update\s*\(/.test(FUENTE_LECTOR) &&
            !/\.remove\s*\(/.test(FUENTE_LECTOR) && !/\.transaction\s*\(/.test(FUENTE_LECTOR));
        check('H4 · el lector no toca ventas/historial para escribir',
            !/ventas\/historial[^\n]*\.(set|update|remove)\s*\(/.test(FUENTE_LECTOR));

        let pagina = '';
        try { pagina = fs.readFileSync('mini_market_pos_resumen.html', 'utf8'); }
        catch (e) { check('H5 · mini_market_pos_resumen.html legible', false, e.message); }
        if (pagina) {
            check('H5 · el resumen carga lector_ventas.js', /src=["']lector_ventas\.js["']/.test(pagina));
            check('H6 · el resumen carga motor_operaciones.js', /src=["']motor_operaciones\.js["']/.test(pagina));
            check('H7 · el resumen arma los reportes con el lector',
                pagina.indexOf('lectorVentas.leerVentas') >= 0 && pagina.indexOf('lectorVentas.resumenDelDia') >= 0);
            check('H8 · el aviso de días incompletos está en el resumen',
                pagina.indexOf('Faltan datos de algunos días: se muestran los disponibles') >= 0);
            check('H9 · la página no escribe ventas/historial',
                !/ventas\/historial[^\n]*\.(set|update|remove)\s*\(/.test(pagina));

            const bloques = [...pagina.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
            let errorPagina = '';
            for (const b of bloques) {
                try { new vm.Script(b); } catch (e) { errorPagina = e.message; break; }
            }
            check('H10 · sintaxis de los scripts en línea del resumen', !errorPagina, errorPagina);
        } else {
            check('H5 · el resumen carga lector_ventas.js', false, 'no se pudo leer la página');
            check('H6 · el resumen carga motor_operaciones.js', false, 'no se pudo leer la página');
            check('H7 · el resumen arma los reportes con el lector', false, 'no se pudo leer la página');
            check('H8 · el aviso de días incompletos está en el resumen', false, 'no se pudo leer la página');
            check('H9 · la página no escribe ventas/historial', false, 'no se pudo leer la página');
            check('H10 · sintaxis de los scripts en línea del resumen', false, 'no se pudo leer la página');
        }
    }

    console.log('\n================ ' + ok + ' OK, ' + fallos + ' FALLAS ================');
    nota('Los mocks NO son un navegador: no se prueban OPFS, Firebase real, la UI ni el');
    nota('render de la página. Ver el informe de la etapa E2.');
    process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => {
    console.error('FALLA la suite se cayó sin control:', e && e.stack || e);
    process.exit(1);
});
