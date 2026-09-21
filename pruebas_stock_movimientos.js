/* =====================================================================
   PRUEBAS DEL STOCK POR MOVIMIENTOS

   Se ejecuta con:  node pruebas_stock_movimientos.js

   QUÉ HACE
   --------
   No toca ningún archivo de la aplicación. Modela DOS motores de stock sobre el
   mismo servidor simulado y el mismo mock de Firebase v8, y compara el
   antes/después de cada escenario:

     * `clasico`     = el comportamiento de HOY: el stock es un NÚMERO dentro del
                       producto y se sube el ARREGLO COMPLETO de productos
                       (`fbSaveProductos` / `firebaseSaveProducts`). Dos equipos
                       que venden sin conexión se pisan y el stock descuadra.
     * `movimientos` = el diseño de DISENO_STOCK_MOVIMIENTOS.md: cada cambio de
                       stock es una operación `movimiento` con clave determinista
                       (idempotente) encolada ANTES de tocar la red; el stock es
                       la SUMA (`inicial + Σ movimientos`), con cierre/snapshot
                       para acotar el cálculo. El campo `stock` del producto pasa
                       a ser caché de presentación.

   MOCK FIEL (misma semántica ya verificada en pruebas_motor_operaciones.js)
   -----------------------------------------------------------------------
   * Con conexión, `.set()` resuelve cuando el SERVIDOR confirma y cuenta una
     escritura.
   * SIN conexión la escritura NO llega al servidor: queda PENDIENTE en el
     equipo (el motor la encola en disco antes de intentar subir).
   * Escribir dos veces la MISMA clave con el MISMO contenido es un no-op
     observable (idempotencia por clave, §1.4 del diseño del motor).
   * `.set()` rechaza si las reglas lo niegan (permission_denied).

   Formato: OK/FALLA por comprobación, resumen final y código de salida.
   ===================================================================== */
'use strict';

let ok = 0, fallos = 0;
const check = (nombre, condicion, extra = '') => {
    if (condicion) { ok++; console.log('OK    ' + nombre); }
    else { fallos++; console.log('FALLA ' + nombre + (extra !== '' ? '  -> ' + extra : '')); }
};
const nota = (t) => console.log('      ' + t);
const aviso = (t) => console.log('      [!] ' + t);
const titulo = (t) => console.log('\n' + t);
const json = (v) => JSON.stringify(v);

/* ===================== 1. SERVIDOR (Firebase RTDB simulado) ============= */

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

function crearServidor() {
    return {
        datos: {},
        cloudSync: true,               // suscripcion/cloudSync
        modoSync: 'operaciones',       // suscripcion/modoSync
        online: true,                  // red del equipo que escribe
        fallarOps: false,              // las reglas niegan ops/* (prueba de fallo)
        escrituras: 0,                 // escrituras CONFIRMADAS por el servidor
        rechazos: 0                    // escrituras rechazadas (permission_denied)
    };
}

const EMAIL_PATH = 'negocio_at_ejemplo_com';
const RAIZ = 'BBDD/' + EMAIL_PATH;
const rutaProductosClasico = RAIZ + '/productos';      // ARREGLO COMPLETO (lo de hoy)
const rutaOps = (tipo) => RAIZ + '/ops/' + tipo;
const rutaMovimientos = RAIZ + '/ops/movimiento';

/* ===================== 2. EQUIPO (navegador + disco) =================== */

/* `local.productos`   = ciervo_inventory (localStorage): el arreglo completo.
   `local.movs`        = registro local de movimientos (en el motor real vive en
                         `caliente/movimientos.jsonl`), clave -> operación.
   `pendientes`        = cola durable del equipo (§3 del diseño del motor):
                         la operación se escribe ANTES de tocar la red.        */
function crearEquipo(id, servidor, opciones = {}) {
    const deviceId = String(opciones.deviceId || id);
    return {
        id,
        deviceId,
        installId: String(opciones.installId || 'K7M2'),
        servidor,
        online: true,
        /* El modo por defecto es `clasico`: si la página no dice nada, no se
           enciende nada (nunca al revés). Para probar el motor hay que pedirlo. */
        modoSync: Object.prototype.hasOwnProperty.call(opciones, 'modoSync') ? opciones.modoSync : 'clasico',
        cloudSync: (opciones.cloudSync !== undefined) ? opciones.cloudSync : true,
        local: { productos: undefined, movs: {}, orden: [], porClave: {} },   // movs: nodo -> op; porClave: opId -> nodo
        pendientes: {},                // clave -> operación (cola durable)
        secuencia: 0,
        escrituras: 0,
        /* El motor arranca SOLO con modo 'operaciones'; cualquier otro valor
           (false, 'clasico', ausente, basura) no enciende nada. */
        activo() { return this.modoSync === 'operaciones'; },
        hayNube() { return this.cloudSync === true; },
        /* .set() del SDK v8, con DOS semánticas según la ruta (es la diferencia que
           importa en este trabajo):
             * `ops/*`  -> append-only + idempotente (§1.4 del motor): la MISMA clave
                           con el MISMO contenido es un no-op; con contenido DISTINTO
                           NO se sobrescribe, se devuelve `conflicto`.
             * el resto -> `set()` normal de RTDB: PISA lo que hubiera (así es como el
                           arreglo completo de productos machaca el stock del otro equipo). */
        set(ruta, valor) {
            if (!this.online) return { ok: false, motivo: 'sin-red' };   // promesa pendiente en el SDK real
            if (this.servidor.fallarOps && ruta.indexOf('/ops/') !== -1) {
                this.servidor.rechazos++;
                return { ok: false, motivo: 'permission_denied' };
            }
            const antes = leerDe(this.servidor.datos, ruta);
            const esOps = ruta.indexOf('/ops/') !== -1;
            if (esOps && antes !== null) {
                const igual = json(antes) === json(valor);
                if (igual) return { ok: true, yaEstaba: true, conflicto: false, escrituras: 0 };
                return { ok: false, motivo: 'conflicto', yaEstaba: false, conflicto: true,
                         detalle: 'la clave ya existe con contenido distinto (append-only)' };
            }
            this.servidor.escrituras++;
            this.escrituras++;
            escribirEn(this.servidor.datos, ruta, valor);
            return { ok: true, yaEstaba: false, conflicto: false, escrituras: 1 };
        }
    };
}

/* ===================== 3. CLAVES DETERMINISTAS (idempotencia) ========== */

/* Un movimiento SIEMPRE lleva `opId`: la clave de negocio que lo identifica.
   Reintentar la misma acción produce el MISMO opId -> el MISMO nodo -> un solo
   movimiento. El nodo final de la nube añade la clave del motor
   (`deviceId_installId_secuencia4`) para que dos equipos no choquen. */
function claveDe(mov) {
    return String(mov.opId || mov.id || '');
}
function nodoDe(mov) {
    return mov.deviceId + '_' + mov.installId + '_' + String(mov.secuencia).padStart(4, '0');
}
function rutaDeMovimiento(mov) { return rutaMovimientos + '/' + nodoDe(mov); }

/* Claves de negocio por tipo de movimiento (todas deterministas):
     inicial    MIG-<productoId>                     (una sola vez por producto)
     venta      M-V-<ventaId>                        (una sola vez por venta)
     anulacion  M-A-<movimientoAnulado>              (una sola por anulación)
     ajuste     M-AJ-<productoId>-<sello>            (el sello lo elige el operador)
     compra     M-C-<compraId>-<productoId>          (una por línea de compra)
     cierre     CIE-<periodo>-<productoId>           (una sola por producto y periodo) */
const opIdInicial = (productoId) => 'MIG-' + productoId;
const opIdVenta = (ventaId) => 'M-V-' + ventaId;
const opIdAnulacion = (movId) => 'M-A-' + movId;
const opIdAjuste = (productoId, sello) => 'M-AJ-' + productoId + '-' + sello;
const opIdCompra = (compraId, productoId) => 'M-C-' + compraId + '-' + productoId;
const opIdCierre = (periodo, productoId) => 'CIE-' + periodo + '-' + productoId;

/* ===================== 4. MOTOR CLÁSICO (lo de hoy) =================== */

/* Arranca igual que el POS de hoy: si no hay nada local, baja el arreglo
   COMPLETO de la nube; si ya hay algo local, se queda con lo suyo.
   OJO (simplificación declarada): el POS real, al reconectar, vuelve a subir su
   arreglo completo cuando tiene la marca de pendientes de Fase A
   (`mini_market_pos.html` ~L5334-5340: `marcarPendienteSync` + resubida). El
   simulador NO modela ese camino: solo modela la subida del arreglo al vender y
   la subida forzada de `clasicoSubirArreglo()`. */
function clasicoArrancar(eq) {
    if (eq.local.productos === undefined) {
        const nube = eq.online ? leerDe(eq.servidor.datos, rutaProductosClasico) : null;
        eq.local.productos = nube ? clonar(nube) : [];
    }
    return eq.local.productos.length;
}

/* Sube el ARREGLO COMPLETO tal cual lo hace `fbSaveProductos`. Es la escritura que
   pisa lo que otro equipo haya subido. */
function clasicoSubirArreglo(eq) {
    if (!eq.hayNube()) return { ok: false, motivo: 'sin-nube' };
    const r = eq.set(rutaProductosClasico, eq.local.productos);
    return { ok: r.ok === true, motivo: r.motivo || '', stock: clasicoStock(eq, PRODUCTO) };
}

function clasicoStock(eq, productoId) {
    const p = (eq.local.productos || []).find(x => String(x.id) === String(productoId));
    return p ? Number(p.stock) || 0 : null;
}

/* Venta: descuenta el número y sube el ARREGLO COMPLETO (fbSaveProductos). */
function clasicoVender(eq, productoId, cantidad, cuando) {
    const p = eq.local.productos.find(x => String(x.id) === String(productoId));
    if (!p) return { ok: false, motivo: 'producto-no-existe' };
    p.stock = Math.max(0, (Number(p.stock) || 0) - Number(cantidad));
    if (cuando) p.fechaStock = cuando;
    const r = eq.hayNube() ? eq.set(rutaProductosClasico, eq.local.productos) : { ok: false, motivo: 'sin-nube' };
    return { ok: true, stock: p.stock, subida: r.ok === true, motivo: r.motivo || '' };
}

/* Ajuste manual clásico: `inventario.html` pide una CANTIDAD A SUMAR O RESTAR
   (`const newStock = product.stock + quantity`, ~L4269, con title «Cantidad a
   sumar o restar del stock actual»), o sea un DELTA, y sube el arreglo completo. */
function clasicoAjustar(eq, productoId, delta, cuando) {
    const p = eq.local.productos.find(x => String(x.id) === String(productoId));
    if (!p) return { ok: false, motivo: 'producto-no-existe' };
    p.stock = Number(p.stock) + Number(delta);
    if (cuando) p.fechaStock = cuando;
    const r = eq.hayNube() ? eq.set(rutaProductosClasico, eq.local.productos) : { ok: false, motivo: 'sin-nube' };
    return { ok: true, stock: p.stock, subida: r.ok === true, motivo: r.motivo || '' };
}

/* Reabrir la página: descarga REEMPLAZANDO el arreglo local (lo de hoy). */
function clasicoAbrirYDescargar(eq) {
    if (!eq.online) return { descargo: false, motivo: 'sin-red' };
    const nube = leerDe(eq.servidor.datos, rutaProductosClasico);
    if (!nube) return { descargo: false, motivo: 'nube-vacia' };
    eq.local.productos = clonar(nube);       // REEMPLAZA: lo local se pierde
    return { descargo: true, motivo: '' };
}

/* Stock que ve CUALQUIER equipo al mirar la nube (fuente de verdad clásica). */
function stockEnNube(productoId) {
    const arr = leerDe(servidorGlobal.datos, rutaProductosClasico);
    if (!arr) return null;
    const p = arr.find(x => String(x.id) === String(productoId));
    return p ? Number(p.stock) || 0 : null;
}

/* ===================== 5. MOTOR DE MOVIMIENTOS ======================== */

/* Registra una operación `movimiento` con la semántica del §3.2 del diseño del
   motor: (1) cola durable ANTES de la red, (2) aplicar local, (3) subir si hay
   red Y nube, (4) confirmar solo con el `.set()` resuelto. */
function registrarMovimiento(eq, mov) {
    if (!eq.activo()) return { ok: false, motivo: 'motor-inactivo' };
    const claveNegocio = String(mov.opId || '');
    /* IDEMPOTENCIA DE NEGOCIO (el «corazón» del §1.2): si este equipo YA conoce un
       movimiento con esta clave de negocio —propio o bajado de la nube—, la acción
       ya está hecha. Se devuelve la que había SIN crear otra operación y SIN gastar
       secuencia. Sin este índice, `registrarOperacion()` crearía un nodo nuevo cada
       vez (el motor real NO deduplica por `opId`: solo deduplica por la clave del
       nodo), y el mismo hecho se contaría dos veces. */
    const nodoConocido = eq.local.porClave[claveNegocio];
    if (nodoConocido && eq.local.movs[nodoConocido]) {
        delete eq.pendientes[claveNegocio];
        return { ok: true, op: eq.local.movs[nodoConocido], clave: claveNegocio, nodo: nodoConocido,
                 duplicada: true, encolada: false };
    }
    eq.secuencia++;
    /* Operación con la MISMA forma que produce el motor E1
       (`motor_operaciones.js` ~L1409): sobre fijo {id, tipo, deviceId, installId,
       secuencia, fechaISO, operador, version, payload} y, DENTRO del payload, los
       campos de negocio. Esta es la conclusión de la auditoría independiente: la
       operación NO lleva campos de negocio en la raíz, porque `registrarOperacion`
       no los copia (si los llevara, haría falta tocar el motor, no solo ampliarlo). */
    const payload = {
        productoId: String(mov.productoId),
        tipoMov: mov.tipoMov,
        cantidad: Number(mov.cantidad),
        ref: mov.ref || '',
        anulaA: mov.anulaA || '',
        nota: mov.nota || '',
        periodo: mov.periodo || ''
    };
    if (mov.saldoContado !== undefined) payload.saldoContado = Number(mov.saldoContado);
    const op = {
        id: mov.opId,                 // el motor respeta `payload.id` si viene (motor L1402)
        opId: mov.opId,               // clave de negocio (idempotencia de negocio)
        tipo: 'movimiento',
        deviceId: eq.deviceId,
        installId: eq.installId,
        secuencia: eq.secuencia,
        fechaISO: mov.fechaISO || '2026-02-14T00:00:00.000Z',
        operador: mov.operador || 'maria',
        version: 1,
        payload: payload
    };
    const clave = claveDe(op);

    // (1) Cola durable primero: si la MISMA clave de negocio ya está, es un reintento.
    if (eq.pendientes[clave]) {
        return { ok: true, op: eq.pendientes[clave], clave: clave, duplicada: true, encolada: false };
    }
    eq.pendientes[clave] = op;

    // (2) Aplicar local: el equipo ya calcula su stock con sus movimientos. El
    // registro local se indexa por NODO (`deviceId_installId_secuencia4`), igual que
    // la ruta de la nube: así el mismo mapa sirve para lo local y para lo bajado.
    const nodo = nodoDe(op);
    if (eq.local.movs[nodo]) {
        delete eq.pendientes[clave];
        return { ok: true, op: eq.local.movs[nodo], clave: clave, duplicada: true, encolada: false };
    }
    eq.local.movs[nodo] = op;
    eq.local.orden.push(nodo);
    eq.local.porClave[claveDe(op)] = nodo;

    // (3) Subir: solo con red Y nube (modo solo-local: nada sale del equipo).
    if (!eq.online || !eq.hayNube()) {
        return { ok: true, op: op, clave: clave, subida: false, motivo: !eq.online ? 'sin-red' : 'sin-nube' };
    }
    const r = eq.set(rutaDeMovimiento(op), op);
    if (r.ok) {
        delete eq.pendientes[clave];
        return { ok: true, op: op, clave: clave, subida: true, yaEstaba: r.yaEstaba === true, conflicto: false };
    }
    if (r.conflicto) {
        // La clave del nodo ya existe con OTRO contenido: el motor no sobrescribe
        // (append-only). Se queda la que ya estaba y se avisa.
        return { ok: false, op: op, clave: clave, subida: false, motivo: 'conflicto', conflicto: true };
    }
    return { ok: true, op: op, clave: clave, subida: false, motivo: r.motivo || 'fallo' };
}

/* Vaciar la cola del equipo cuando vuelve la red/la nube. */
function vaciarCola(eq) {
    if (!eq.activo() || !eq.online || !eq.hayNube()) return { subidas: 0, pendientes: Object.keys(eq.pendientes).length, conflictos: 0 };
    let subidas = 0, conflictos = 0;
    for (const clave of Object.keys(eq.pendientes)) {
        const op = eq.pendientes[clave];
        const r = eq.set(rutaDeMovimiento(op), op);
        if (r.ok) { delete eq.pendientes[clave]; if (!r.yaEstaba) subidas++; continue; }
        if (r.conflicto) {                          // no se puede subir: se deja y se avisa
            conflictos++;
            continue;
        }
        break;                                      // fallo de red: no se salta el orden (§3.2.4)
    }
    return { subidas: subidas, pendientes: Object.keys(eq.pendientes).length, conflictos: conflictos };
}

/* Baja de la nube los movimientos que ESTE equipo no tiene. La unión es por NODO
   (`deviceId_installId_secuencia4`), que es la clave de la ruta en el motor real:
   dos equipos con la MISMA clave de negocio (`opId`) producen DOS nodos y los dos
   se conservan, porque son el mismo hecho replicado y hay que poder DELATARLO (si
   se descartara el segundo, el doble conteo sería invisible). El cálculo es el que
   deduplica por clave de negocio (§ sumarStock). */
function bajarMovimientos(eq) {
    if (!eq.online || !eq.hayNube()) return { bajados: 0 };
    const nube = leerDe(eq.servidor.datos, rutaMovimientos) || {};
    let bajados = 0;
    for (const nodo of Object.keys(nube)) {
        const op = nube[nodo];
        if (!op || !op.payload) continue;
        if (!claveDe(op)) continue;                  // una operación sin clave no se puede sumar
        if (eq.local.movs[nodo]) continue;           // ya la tenía: no se cuenta dos veces
        eq.local.movs[nodo] = clonar(op);
        eq.local.orden.push(nodo);
        bajados++;
        // Índice de clave de negocio -> nodo CONOCIDO (el primero que llegó). Los
        // duplicados (otro nodo con la misma clave) NO se indexan: quedan en el mapa
        // por nodo para poder delatarlos, pero el «ya está hecho» apunta al primero.
        const cn = claveDe(op);
        if (cn && !eq.local.porClave[cn]) eq.local.porClave[cn] = nodo;
    }
    return { bajados: bajados };
}

/* Cierre/snapshot (§4 del diseño): fija el saldo base del producto para el
   periodo cerrado. Es un movimiento MÁS, con clave determinista
   `CIE-<periodo>-<producto>`, así que reintentarlo no duplica y el cálculo no
   cambia.
   OJO 1: como el stock es una SUMA, el `cierre` no puede llevar el saldo absoluto
   (el `inicial` ya está en la suma y se contaría dos veces). Lleva el DELTA
   necesario para que la suma acumulada coincida con el saldo contado:
       cantidadCierre = saldo(periodo) - saldoBase(antes del cierre)
   OJO 2: aquí `saldoBaseAntes` lo pasa el llamante para poder montar el escenario.
   Es una SIMPLIFICACIÓN del simulador (documentada en §12 del diseño): en el motor
   la función pública debe ser `cerrar(productoId, periodo, saldoContado)` y el
   DELTA lo calcula el motor, nunca la página. */
function cerrarPeriodo(eq, productoId, periodo, saldoContado, saldoBaseAntes, fechaISO) {
    const delta = Number(saldoContado) - Number(saldoBaseAntes || 0);
    const mov = {
        opId: opIdCierre(periodo, productoId),
        productoId: productoId,
        tipoMov: 'cierre',
        cantidad: delta,
        saldoContado: Number(saldoContado),
        periodo: periodo,
        fechaISO: fechaISO,
        nota: 'cierre ' + periodo + ': saldo ' + saldoContado + ' (delta ' + delta + ')'
    };
    return registrarMovimiento(eq, mov);
}

/* Migración del stock existente (§6): el `stock` actual del producto se
   convierte en un movimiento `inicial` con clave determinista `MIG-<producto>`.
   Se crea UNA sola vez: dos intentos (mismo equipo o dos equipos) producen la
   misma clave de negocio y el mismo nodo de nube -> un solo `inicial`. */
function migrarInicial(eq, productoId, stockActual, fechaISO) {
    const mov = {
        opId: opIdInicial(productoId),
        productoId: productoId,
        tipoMov: 'inicial',
        cantidad: Number(stockActual),
        fechaISO: fechaISO || '2026-02-01T00:00:00.000Z',
        nota: 'saldo de apertura (migración del stock clásico)'
    };
    return registrarMovimiento(eq, mov);
}

/* ===================== 6. CÁLCULO DEL STOCK (la verdad es la suma) ===== */

/* Campos de negocio de un movimiento. La forma preferida es que viajen en la raíz
   de la operación (como `tipo` y `fechaISO`); el payload se admite como respaldo
   para que una operación vieja o escrita por una página no migrada siga sumando. */
const campo = (m, nombre) => {
    if (m && m[nombre] !== undefined && m[nombre] !== '') return m[nombre];
    return (m && m.payload && m.payload[nombre] !== undefined) ? m.payload[nombre] : '';
};
const esSaldoBase = (m) => campo(m, 'tipoMov') === 'inicial' || campo(m, 'tipoMov') === 'cierre';

const periodoDe = (m) => String(campo(m, 'periodo') || String(m.fechaISO || '').slice(0, 7));

/* Los productos a granel (isBulk) se venden con 3 decimales
   (`mini_market_pos.html`: `parseFloat(newQuantity.toFixed(3))`). Sumar decimales
   en coma flotante acumula error (`10 - 0.1 - 0.1 - 0.1 = 9.700000000000001`), así
   que el cálculo redondea a 3 decimales en cada paso: es la precisión real del POS. */
const DECIMALES = 3;
const redondear = (n) => Math.round((Number(n) || 0) * Math.pow(10, DECIMALES)) / Math.pow(10, DECIMALES);
const sumarCantidades = (a, b) => redondear((Number(a) || 0) + (Number(b) || 0));

/* Movimiento cubierto por un cierre: pertenece a un periodo ya cerrado. Su efecto
   YA está dentro del saldo base del cierre, así que no se vuelve a sumar. */
const cubiertoPorCierre = (m, periodos) => periodos.indexOf(periodoDe(m)) !== -1;

/* stock(p) = saldoBase(p) + Σ movimientos(p) no cubiertos por el saldo base.
   saldoBase = el `inicial` + los `cierre` aplicables. El orden de aplicación no
   importa (la suma es conmutativa); lo que importa es no sumar dos veces lo que
   un cierre ya contiene.                                                        */
function sumarStock(movs, productoId) {
    const p = String(productoId);
    const lista = [];
    for (const clave of Object.keys(movs)) {
        const m = movs[clave];
        if (!m) continue;
        if (String(campo(m, 'productoId')) !== p) continue;
        if (!claveDe(m)) continue;
        lista.push(m);
    }
    const instante = (m) => String(m.fechaISO || '') + '|' + String(m.secuencia || 0).padStart(6, '0') + '|' + String(m.deviceId || '');
    lista.sort((a, b) => instante(a).localeCompare(instante(b)));

    // `inicial` duplicado (dos equipos migraron el mismo producto): se agrupa por
    // CLAVE DE NEGOCIO y se toma el MENOR, no la suma. El diseño dice que el
    // `inicial` lo escribe UN solo equipo; esto es la red de seguridad para que un
    // duplicado no infle el stock (y es determinista: no depende del orden).
    const iniciales = lista.filter(m => campo(m, 'tipoMov') === 'inicial');
    const cierres = lista.filter(m => campo(m, 'tipoMov') === 'cierre');
    const porClave = {};
    for (const m of iniciales) {
        const k = claveDe(m);
        const v = Number(campo(m, 'cantidad')) || 0;
        porClave[k] = (porClave[k] === undefined) ? v : Math.min(porClave[k], v);
    }
    const clavesInicial = Object.keys(porClave);
    const inicial = clavesInicial.length ? Math.min.apply(null, clavesInicial.map(k => porClave[k])) : 0;
    let base = redondear(inicial);
    // Los `cierre` se deduplican igual: el mismo periodo cerrado desde dos equipos
    // es el MISMO hecho (misma clave de negocio) y no se puede sumar dos veces. Si
    // discrepan, se toma el MENOR (conservador: nunca infla) y se marca el conflicto.
    const porClaveCierre = {};
    const periodosCerrados = [];
    for (const c of cierres) {
        const k = claveDe(c);
        const p = periodoDe(c);
        if (periodosCerrados.indexOf(p) === -1) periodosCerrados.push(p);
        if (porClaveCierre[k] === undefined) {
            porClaveCierre[k] = { cantidad: (Number(campo(c, 'cantidad')) || 0), periodo: p };
        } else {
            porClaveCierre[k].cantidad = Math.min(porClaveCierre[k].cantidad, Number(campo(c, 'cantidad')) || 0);
        }
    }
    const clavesCierre = Object.keys(porClaveCierre);
    for (const k of clavesCierre) base = sumarCantidades(base, porClaveCierre[k].cantidad);
    const deltas = lista.filter(m => campo(m, 'tipoMov') !== 'inicial' && campo(m, 'tipoMov') !== 'cierre');
    const posteriores = deltas.filter(m => !cubiertoPorCierre(m, periodosCerrados));
    let stock = base;
    for (const m of posteriores) stock = sumarCantidades(stock, campo(m, 'cantidad'));
    return {
        stock: stock,
        base: base,
        movimientosSumados: posteriores.length,
        movimientosTotales: lista.length,
        movimientosBase: clavesInicial.length + clavesCierre.length,
        inicialesDuplicados: iniciales.length > clavesInicial.length,
        cierresDuplicados: cierres.length > clavesCierre.length,
        inicial: inicial,
        saldoContadoCierre: cierres.length ? Number(campo(cierres[cierres.length - 1], 'saldoContado')) : null,
        periodosCerrados: periodosCerrados,
        ultimoCierre: cierres.length ? periodoDe(cierres[cierres.length - 1]) : null
    };
}

/* Suma INGENUA (la equivocada): sumar TODOS los nodos sin descontar los
   movimientos que un cierre ya absorbió. Es el error clásico al implantar
   snapshots; sirve para demostrar cuánto descuadra. */
function sumarStockIngenuo(movs, productoId) {
    let total = 0;
    for (const clave of Object.keys(movs)) {
        const m = movs[clave];
        if (!m) continue;
        if (String(campo(m, 'productoId')) !== String(productoId)) continue;
        total += Number(campo(m, 'cantidad')) || 0;
    }
    return total;
}

/* Dos movimientos con la MISMA clave de negocio pero contenido distinto = conflicto
   (no se suma dos veces, pero se avisa: alguien reutilizó una clave). */
function conflictosDeClave(movs, productoId) {
    const porClave = {};
    for (const nodo of Object.keys(movs)) {
        const m = movs[nodo];
        if (!m) continue;
        if (productoId !== undefined && String(campo(m, 'productoId')) !== String(productoId)) continue;
        const c = claveDe(m);
        porClave[c] = porClave[c] || [];
        porClave[c].push(json({ tipoMov: campo(m, 'tipoMov'), cantidad: campo(m, 'cantidad') }));
    }
    return Object.keys(porClave).filter(c => new Set(porClave[c]).size > 1);
}

/* Cuenta las ventas por referencia: DOS movimientos de venta con la MISMA
   referencia son la señal de que dos equipos registraron la misma venta (el
   sistema no puede fusionarlas solas: hay que avisar al operador). */
function referenciasRepetidas(movs) {
    const porRef = {};
    for (const nodo of Object.keys(movs)) {
        const m = movs[nodo];
        if (!m) continue;
        if (campo(m, 'tipoMov') !== 'venta') continue;
        const ref = String(campo(m, 'ref') || '');
        if (!ref) continue;
        porRef[ref] = (porRef[ref] || 0) + 1;
    }
    return Object.keys(porRef).filter(ref => porRef[ref] > 1);
}

/* ===================== 7. PRODUCTOS DE PRUEBA ========================= */

const PRODUCTO = 'P-HARINA-PAN';

let servidorGlobal = crearServidor();

function crearServidorGlobal() {
    servidorGlobal = crearServidor();
    return servidorGlobal;
}

/* Siembra la nube por la ruta REAL (`BBDD/<emailPath>/productos`), anidando las
   partes de la ruta como hace RTDB (no como una sola clave con barras). */
function sembrar(productos) {
    escribirEn(servidorGlobal.datos, rutaProductosClasico, productos);
}

function catalogoInicial(stock) {
    return [{ id: PRODUCTO, nombre: 'Harina PAN 1kg', stock: Number(stock), precio: 1.2 }];
}

function movimientosEnNube() {
    return leerDe(servidorGlobal.datos, rutaMovimientos) || {};
}

/* Un equipo nuevo que llega a la nube y sincroniza lo suyo + lo del resto. */
function equipoNuevo(id, movimientosLocales) {
    const eq = crearEquipo(id, servidorGlobal, { deviceId: id, modoSync: 'operaciones' });
    for (const m of movimientosLocales || []) {
        // Se reconstruye el nodo tal cual estaba en la nube (mismo deviceId/secuencia).
        eq.local.movs[claveDe(m)] = clonar(m);
        eq.local.orden.push(claveDe(m));
        eq.secuencia = Math.max(eq.secuencia, Number(m.secuencia) || 0);
    }
    bajarMovimientos(eq);
    return eq;
}

function nuevoEquipo(id, stock, opciones) {
    const eq = crearEquipo(id, servidorGlobal, opciones);
    catalogoInicial(stock).forEach(p => { eq.local.productos = eq.local.productos || []; eq.local.productos.push(clonar(p)); });
    return eq;
}

/* ===================== 8. ESCENARIOS ================================== */

(async function main() {

    /* ------------------------------------------------------------------ */
    titulo('T1 · Dos equipos sin conexión venden el mismo producto (inicial 10; A vende 3, B vende 4)');
    {
        // ---- CLÁSICO: el último que sube el arreglo completo manda ----
        // Se montan las DOS órdenes de subida (una por equipo) para que se vea que
        // NO existe un resultado correcto: en una gana la venta de A y en la otra la
        // de B, pero en ninguna están las dos.
        const correrClasico = (quienSubeUltimo) => {
            crearServidorGlobal();
            sembrar(catalogoInicial(10));
            const E = {
                A: crearEquipo('A', servidorGlobal, { deviceId: 'AAAA1111', modoSync: 'clasico' }),
                B: crearEquipo('B', servidorGlobal, { deviceId: 'BBBB2222', modoSync: 'clasico' })
            };
            clasicoArrancar(E.A); clasicoArrancar(E.B);
            E.A.online = false; E.B.online = false;
            clasicoVender(E.A, PRODUCTO, 3, '2026-02-14T10:00:00.000Z');   // A local 7
            clasicoVender(E.B, PRODUCTO, 4, '2026-02-14T10:00:05.000Z');   // B local 6
            E.A.online = true; E.B.online = true;
            const primero = quienSubeUltimo === 'B' ? 'A' : 'B';
            clasicoSubirArreglo(E[primero]);            // sube su arreglo completo
            const enMedio = stockEnNube(PRODUCTO);
            clasicoSubirArreglo(E[quienSubeUltimo]);    // el otro lo pisa con el suyo
            return { equipo: E, enMedio: enMedio, final: stockEnNube(PRODUCTO), quienSubeUltimo: quienSubeUltimo };
        };
        const cB = correrClasico('B');    // B sube al final -> la nube acaba en 6
        const cA = correrClasico('A');    // A sube al final -> la nube acaba en 7
        nota('clasico · A ve 7 y B ve 6 sin conexión (ninguno vio la venta del otro)');
        nota('clasico · sube A y luego B -> nube ' + cB.enMedio + ' -> ' + cB.final + ' (gana B)');
        nota('clasico · sube B y luego A -> nube ' + cA.enMedio + ' -> ' + cA.final + ' (gana A)');
        aviso('clasico · la venta del que sube primero NUNCA llega a la nube: stock final ' + cB.final + ' o ' + cA.final + ' (lo correcto es 3)');
        nota('clasico · al reabrir, el equipo que perdió descarga la nube y ve: ' +
             (clasicoAbrirYDescargar(cB.equipo.A), clasicoStock(cB.equipo.A, PRODUCTO)));
        check('T1 · clasico: subir el arreglo completo PISA al otro equipo (la nube queda en 6 o en 7, nunca en 3)',
            cB.final === 6 && cA.final === 7, json({ B_ultimo: cB.final, A_ultimo: cA.final }));
        check('T1 · clasico: el resultado depende del ORDEN de subida (no hay convergencia)',
            cB.final !== cA.final, json({ B_ultimo: cB.final, A_ultimo: cA.final }));
        check('T1 · clasico: el equipo que pierde se queda con el stock del otro al reabrir (pierde su venta)',
            clasicoStock(cB.equipo.A, PRODUCTO) === 6, String(clasicoStock(cB.equipo.A, PRODUCTO)));

        // ---- MOVIMIENTOS: cada venta es un hecho que no se pisa ----
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        const Am = crearEquipo('A', servidorGlobal, { deviceId: 'AAAA1111', modoSync: 'operaciones' });
        const Bm = crearEquipo('B', servidorGlobal, { deviceId: 'BBBB2222', modoSync: 'operaciones' });
        migrarInicial(Am, PRODUCTO, 10, '2026-02-01T00:00:00.000Z');   // inicial (una vez)
        Am.online = false; Bm.online = false;
        nota('movimientos · stock inicial (movimiento `inicial`): ' + sumarStock(Am.local.movs, PRODUCTO).stock);
        registrarMovimiento(Am, { opId: opIdVenta('V-LOCAL-AAAA1111-0007'), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -3, ref: 'V-LOCAL-AAAA1111-0007', fechaISO: '2026-02-14T10:00:00.000Z' });
        registrarMovimiento(Bm, { opId: opIdVenta('V-LOCAL-BBBB2222-0009'), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -4, ref: 'V-LOCAL-BBBB2222-0009', fechaISO: '2026-02-14T10:00:05.000Z' });
        nota('movimientos · sin conexión -> A ve: ' + sumarStock(Am.local.movs, PRODUCTO).stock +
             ' | B ve: ' + sumarStock(Bm.local.movs, PRODUCTO).stock +
             ' | pendientes en la cola de A: ' + Object.keys(Am.pendientes).length + ' | nube: ' + Object.keys(movimientosEnNube()).length + ' nodos');
        nota('movimientos · el primer nodo de la nube (autocontenido): ' + json(movimientosEnNube()[Object.keys(movimientosEnNube())[0]]));
        Am.online = true; Bm.online = true;
        vaciarCola(Am); vaciarCola(Bm);
        bajarMovimientos(Am); bajarMovimientos(Bm);
        const nubeFinal = movimientosEnNube();
        const clavesNube = Object.keys(nubeFinal).length;
        const AmFinal = sumarStock(Am.local.movs, PRODUCTO);
        const BmFinal = sumarStock(Bm.local.movs, PRODUCTO);
        const nuevo = equipoNuevo('C', []);
        const CFinal = sumarStock(nuevo.local.movs, PRODUCTO);
        nota('movimientos · nube: ' + clavesNube + ' nodos (inicial + 2 ventas) | A: ' + AmFinal.stock +
             ' | B: ' + BmFinal.stock + ' | equipo nuevo C: ' + CFinal.stock);
        aviso('clasico · el equipo que sube el arreglo completo borra de la nube el stock que ya estaba: no hay suma posible');
        aviso('movimientos · los 3 hechos suman en cualquier orden y en cualquier equipo: el stock es 3');
        check('T1 · movimientos: la nube conserva los 3 hechos (1 inicial + 2 ventas)',
            clavesNube === 3, 'nodos=' + clavesNube);
        check('T1 · movimientos: stock final correcto = 10 - 3 - 4 = 3 en LOS DOS equipos',
            AmFinal.stock === 3 && BmFinal.stock === 3, json({ A: AmFinal.stock, B: BmFinal.stock }));
        check('T1 · movimientos: un equipo nuevo que llega calcula el mismo stock (3)',
            CFinal.stock === 3, String(CFinal.stock));
    }

    /* ------------------------------------------------------------------ */
    titulo('T2 · Reintento del mismo movimiento: no se cuenta dos veces');
    {
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        const A = crearEquipo('A', servidorGlobal, { deviceId: 'AAAA1111', modoSync: 'operaciones' });
        migrarInicial(A, PRODUCTO, 10, '2026-02-01T00:00:00.000Z');
        const ventaId = 'V-LOCAL-AAAA1111-0007';
        const mov = { opId: opIdVenta(ventaId), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -3, ref: ventaId, fechaISO: '2026-02-14T10:00:00.000Z' };
        const r1 = registrarMovimiento(A, mov);
        const stockTras1 = sumarStock(A.local.movs, PRODUCTO).stock;
        // Reintento 1: el MISMO objeto, la MISMA clave -> la cola lo reconoce.
        const r2 = registrarMovimiento(A, mov);
        // Reintento 2: se reenvía a mano el nodo ya subido (reconexión que repite).
        const escriturasAntes = servidorGlobal.escrituras;
        const r3 = A.set(rutaDeMovimiento(r1.op), r1.op);
        const escriturasDelReintento = servidorGlobal.escrituras - escriturasAntes;
        // Reintento 3: la cola se vacía dos veces seguidas (doble disparador online+60s).
        vaciarCola(A); vaciarCola(A);
        // Reintento 4: el equipo vuelve a bajar la nube (ya tiene el movimiento).
        const baj = bajarMovimientos(A);
        // Reintento 5: el MISMO nodo con OTRO contenido (secuencia reutilizada con
        // distinto hecho). El motor NO sobrescribe: lo deja como conflicto.
        const r5 = A.set(rutaDeMovimiento(r1.op), Object.assign({}, r1.op, { payload: Object.assign({}, r1.op.payload, { cantidad: -99 }) }));
        const enNubeTrasConflicto = leerDe(servidorGlobal.datos, rutaDeMovimiento(r1.op));
        const stockFinal = sumarStock(A.local.movs, PRODUCTO).stock;

        nota('venta ' + ventaId + ' -> opId ' + opIdVenta(ventaId) + ' | nodo: ' + nodoDe(r1.op));
        nota('1er registro: stock ' + stockTras1 + ' | reintento local: ' + (r2.duplicada === true) +
             ' | reenvío a la nube: yaEstaba=' + (r3.yaEstaba === true) + ' (escrituras nuevas: ' + escriturasDelReintento + ')');
        nota('mismo nodo con contenido distinto -> conflicto=' + (r5.conflicto === true) +
             ' | en la nube sigue cantidad ' + enNubeTrasConflicto.payload.cantidad);
        nota('nodos en la nube: ' + Object.keys(movimientosEnNube()).length +
             ' | movimientos locales: ' + Object.keys(A.local.movs).length +
             ' | bajados al re-sincronizar: ' + baj.bajados + ' | stock final: ' + stockFinal);
        check('T2 · el primer registro descuenta 3 (10 -> 7)', stockTras1 === 7, String(stockTras1));
        check('T2 · reintentar la misma acción se detecta como duplicada y NO crea otra operación',
            r2.duplicada === true && r2.encolada === false && r2.clave === r1.clave,
            json({ duplicada: r2.duplicada, encolada: r2.encolada, clave: r2.clave }));
        check('T2 · reenviar el mismo nodo con el mismo contenido NO escribe nada (ni resuelve conflicto)',
            r3.ok === true && r3.yaEstaba === true && escriturasDelReintento === 0, json({ r3: r3, escrituras: escriturasDelReintento }));
        check('T2 · el mismo nodo con contenido distinto se rechaza como CONFLICTO y no se sobrescribe',
            r5.ok === false && r5.conflicto === true && enNubeTrasConflicto.payload.cantidad === -3,
            json({ r5: r5, enNube: enNubeTrasConflicto.payload.cantidad }));
        check('T2 · la nube queda con 2 nodos (1 inicial + 1 venta), no con 3',
            Object.keys(movimientosEnNube()).length === 2, String(Object.keys(movimientosEnNube()).length));
        check('T2 · el stock sigue siendo 7 después de los 4 reintentos',
            stockFinal === 7 && Object.keys(A.local.movs).length === 2,
            json({ stock: stockFinal, movs: Object.keys(A.local.movs).length }));
    }

    /* ------------------------------------------------------------------ */
    titulo('T3 · Venta anulada: el stock vuelve a su valor correcto');
    {
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        const A = crearEquipo('A', servidorGlobal, { deviceId: 'AAAA1111', modoSync: 'operaciones' });
        migrarInicial(A, PRODUCTO, 10, '2026-02-01T00:00:00.000Z');
        const ventaId = 'V-LOCAL-AAAA1111-0007';
        const rv = registrarMovimiento(A, { opId: opIdVenta(ventaId), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -3, ref: ventaId, fechaISO: '2026-02-14T10:00:00.000Z' });
        const stockTrasVenta = sumarStock(A.local.movs, PRODUCTO).stock;
        const ra = registrarMovimiento(A, { opId: opIdAnulacion(rv.op.id), productoId: PRODUCTO, tipoMov: 'anulacion', cantidad: 3, ref: ventaId, anulaA: rv.op.id, nota: 'error de cobro', fechaISO: '2026-02-14T10:05:00.000Z' });
        const stockTrasAnular = sumarStock(A.local.movs, PRODUCTO).stock;
        // La venta original NO se borra: sigue en la nube (§1.3, append-only).
        const originalSigue = !!leerDe(servidorGlobal.datos, rutaDeMovimiento(rv.op));
        // Reintento de la anulación: misma clave -> no se aplica otra vez.
        const ra2 = registrarMovimiento(A, { opId: opIdAnulacion(rv.op.id), productoId: PRODUCTO, tipoMov: 'anulacion', cantidad: 3, ref: ventaId, anulaA: rv.op.id, fechaISO: '2026-02-14T10:05:00.000Z' });
        const stockTrasReintento = sumarStock(A.local.movs, PRODUCTO).stock;
        // Anulación fantasma: venta + anulación se cancelan; el neto vuelve al inicial.
        const B = crearEquipo('B', servidorGlobal, { deviceId: 'BBBB2222', modoSync: 'operaciones' });
        bajarMovimientos(B);
        const fantasma = sumarStock(B.local.movs, PRODUCTO);
        nota('venta ' + ventaId + ' -> ' + rv.clave + ' | anulación -> ' + ra.clave);
        nota('10 -> venta: ' + stockTrasVenta + ' -> anulación: ' + stockTrasAnular +
             ' -> reintento de la anulación: ' + stockTrasReintento);
        nota('nodos en la nube: ' + Object.keys(movimientosEnNube()).length +
             ' | la venta original sigue en la nube: ' + originalSigue);
        check('T3 · la venta descuenta (10 -> 7)', stockTrasVenta === 7, String(stockTrasVenta));
        check('T3 · la anulación devuelve el stock a 10', stockTrasAnular === 10, String(stockTrasAnular));
        check('T3 · la venta original NO se borra (append-only): la anulación es un movimiento nuevo',
            originalSigue === true, String(originalSigue));
        check('T3 · reintentar la anulación no vuelve a subir el stock (sigue 10)',
            stockTrasReintento === 10 && ra2.duplicada === true, json({ stock: stockTrasReintento, duplicada: ra2.duplicada }));
        check('T3 · un equipo que recibe venta + anulación calcula 10 (la suma es conmutativa)',
            fantasma.stock === 10, String(fantasma.stock));
        // La ANULACIÓN vive en su propio nodo: el original nunca se borra, así que
        // la clave de la venta no se reutiliza y no hay conflicto de clave.
        check('T3 · la anulación es una operación NUEVA (clave distinta) y la del original no se reutiliza',
            ra.clave !== rv.clave && Object.keys(conflictosDeClave(A.local.movs)).length === 0,
            json({ venta: rv.clave, anulacion: ra.clave }));
        // Si DOS equipos registran la MISMA venta (misma referencia), el neto baja el
        // doble: la clave de negocio `M-V-<ventaId>` lo evita, y aquí se comprueba
        // que cuando la clave SÍ se repite con otro contenido se detecta.
        const clon = clonar(rv.op);
        clon.deviceId = 'CCCC3333';
        clon.opId = rv.op.opId;                       // misma clave de negocio, otro nodo
        clon.cantidad = -5;                           // y otro contenido: conflicto
        A.local.movs['CCCC3333_K7M2_0002'] = clon;
        const replicas = referenciasRepetidas(A.local.movs);
        const conflictos = conflictosDeClave(A.local.movs, PRODUCTO);
        nota('venta replicada con otra cantidad -> referencias repetidas: ' + json(replicas) +
             ' | conflictos de clave: ' + json(conflictos));
        check('T3 · una venta replicada (misma referencia) se detecta como posible doble conteo',
            replicas.length === 1 && replicas[0] === ventaId, json(replicas));
        check('T3 · la misma clave de negocio con contenido distinto se detecta como conflicto',
            conflictos.length === 1, json(conflictos));
    }

    /* ------------------------------------------------------------------ */
    titulo('T4 · Compra + venta + ajuste manual combinados');
    {
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        const A = crearEquipo('A', servidorGlobal, { deviceId: 'AAAA1111', modoSync: 'operaciones' });
        migrarInicial(A, PRODUCTO, 10, '2026-02-01T00:00:00.000Z');
        registrarMovimiento(A, { opId: opIdCompra('C-0001', PRODUCTO), productoId: PRODUCTO, tipoMov: 'compra', cantidad: 24, ref: 'C-0001', fechaISO: '2026-02-10T09:00:00.000Z' });
        registrarMovimiento(A, { opId: opIdVenta('V-LOCAL-AAAA1111-0007'), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -3, ref: 'V-LOCAL-AAAA1111-0007', fechaISO: '2026-02-14T10:00:00.000Z' });
        registrarMovimiento(A, { opId: opIdVenta('V-LOCAL-AAAA1111-0008'), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -4, ref: 'V-LOCAL-AAAA1111-0008', fechaISO: '2026-02-14T11:00:00.000Z' });
        registrarMovimiento(A, { opId: opIdAjuste(PRODUCTO, '2026-02-14'), productoId: PRODUCTO, tipoMov: 'ajuste', cantidad: -2, nota: 'conteo físico: 2 bolsas rotas', fechaISO: '2026-02-14T12:00:00.000Z' });
        const r = sumarStock(A.local.movs, PRODUCTO);
        nota('10 (inicial) + 24 (compra) - 3 (venta) - 4 (venta) - 2 (ajuste rotura) = ' + r.stock);
        nota('movimientos: ' + r.movimientosTotales + ' | sumados al vuelo: ' + r.movimientosSumados + ' | saldo base: ' + r.base);
        // El signo manda: los movimientos de entrada son positivos, los de salida negativos.
        const signos = Object.keys(A.local.movs).map(k => A.local.movs[k].payload.tipoMov + ':' + A.local.movs[k].payload.cantidad).sort();
        nota('signos: ' + json(signos));
        check('T4 · el stock cuadra: 10 + 24 - 3 - 4 - 2 = 25', r.stock === 25, String(r.stock));
        check('T4 · los 5 hechos están en el log (inicial, compra, 2 ventas, ajuste)',
            r.movimientosTotales === 5, String(r.movimientosTotales));
        check('T4 · entradas positivas y salidas negativas (un solo signo por tipo)',
            signos.join(',') === 'ajuste:-2,compra:24,inicial:10,venta:-3,venta:-4', json(signos));
        // Ajuste manual: la app de HOY pide "cantidad a sumar o restar" (delta). Aquí
        // se comprueba que el delta llega al objetivo y que el cálculo no se pierde.
        // (La conversión "valor absoluto -> delta" solo hace falta para el ADJUST de
        //  un cliente viejo; ver §1.4 del diseño.)
        const stockAntesDelAjuste = sumarStock(A.local.movs, PRODUCTO).stock;
        const ajusteDelta = 30 - stockAntesDelAjuste;
        registrarMovimiento(A, { opId: opIdAjuste(PRODUCTO, '2026-02-15'), productoId: PRODUCTO, tipoMov: 'ajuste', cantidad: ajusteDelta, nota: 'ajuste a 30 tras inventario', fechaISO: '2026-02-15T09:00:00.000Z' });
        const r2 = sumarStock(A.local.movs, PRODUCTO);
        nota('ajuste "poner 30" -> delta ' + ajusteDelta + ' -> stock ' + r2.stock +
             ' | si el ajuste se hubiera PERDIDO el stock sería ' + stockAntesDelAjuste + ' (no 30)');
        check('T4 · el ajuste manual por delta llega exacto a 30 (y no se pierde)',
            r2.stock === 30 && stockAntesDelAjuste !== 30, json({ stock: r2.stock, antes: stockAntesDelAjuste }));

        // ---- a granel: decimales de 3 cifras (isBulk) ----
        registrarMovimiento(A, { opId: 'MIG-P-QUESO', productoId: 'P-QUESO', tipoMov: 'inicial', cantidad: 10, fechaISO: '2026-02-01T00:00:00.000Z' });
        for (let k = 1; k <= 3; k++) {
            registrarMovimiento(A, {
                opId: opIdVenta('V-LOCAL-AAAA1111-01' + k), productoId: 'P-QUESO', tipoMov: 'venta',
                cantidad: -0.1, ref: 'V-LOCAL-AAAA1111-01' + k, fechaISO: '2026-02-14T13:0' + k + ':00.000Z'
            });
        }
        const queso = sumarStock(A.local.movs, 'P-QUESO');
        // Sin el redondeo del motor, la coma flotante acumula error:
        const sinRedondear = 10 + (-0.1) + (-0.1) + (-0.1);
        nota('a granel · 10 - 0.1 - 0.1 - 0.1 = ' + queso.stock + ' (sumando en crudo: ' + sinRedondear + ')');
        check('T4 · a granel: la suma con 3 decimales da el número exacto (9.7), sin error de coma flotante',
            queso.stock === 9.7, json({ stock: queso.stock, crudo: sinRedondear }));
        check('T4 · a granel: sin redondear a 3 decimales el resultado NO sería exacto (por eso el motor redondea)',
            sinRedondear !== 9.7, String(sinRedondear));
    }

    /* ------------------------------------------------------------------ */
    titulo('T5 · Cierre/snapshot: el cálculo sigue dando el mismo stock y la suma se reduce');
    {
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        const A = crearEquipo('A', servidorGlobal, { deviceId: 'AAAA1111', modoSync: 'operaciones' });
        migrarInicial(A, PRODUCTO, 10, '2026-02-01T00:00:00.000Z');
        for (let i = 1; i <= 12; i++) {
            registrarMovimiento(A, {
                opId: opIdVenta('V-LOCAL-AAAA1111-' + String(i).padStart(4, '0')),
                productoId: PRODUCTO, tipoMov: 'venta', cantidad: -1,
                ref: 'V-LOCAL-AAAA1111-' + String(i).padStart(4, '0'),
                fechaISO: '2026-02-1' + (i % 9) + 'T10:00:00.000Z'
            });
        }
        registrarMovimiento(A, { opId: opIdCompra('C-0002', PRODUCTO), productoId: PRODUCTO, tipoMov: 'compra', cantidad: 20, ref: 'C-0002', fechaISO: '2026-02-19T09:00:00.000Z' });
        const antes = sumarStock(A.local.movs, PRODUCTO);
        // ORÁCULO INDEPENDIENTE del cierre: 10 de apertura + 20 de compra - 12 ventas.
        // Se calcula a mano, sin pasar por `sumarStock`, para que la comprobación de
        // «el cierre no cambia el stock» no sea una identidad por construcción.
        const oraculo = 10 + 20 - 12;
        // Cierre del periodo 2026-02: saldo base = stock al cerrar el periodo. El
        // cierre marca el PERIODO que contiene: todo movimiento de ese periodo ya
        // está dentro del saldo y no se vuelve a sumar.
        const saldo = antes.stock;
        const rc = cerrarPeriodo(A, PRODUCTO, '2026-02', saldo, antes.base, '2026-02-28T23:59:59.000Z');
        const despues = sumarStock(A.local.movs, PRODUCTO);
        // Movimientos POSTERIORES al cierre: se suman al saldo base.
        registrarMovimiento(A, { opId: opIdVenta('V-LOCAL-AAAA1111-0099'), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -5, ref: 'V-LOCAL-AAAA1111-0099', fechaISO: '2026-03-05T10:00:00.000Z' });
        const trasCierre = sumarStock(A.local.movs, PRODUCTO);
        // Reintento del cierre desde OTRO equipo (dos equipos cierran el mismo
        // periodo). OJO: es el caso que la auditoría destapó. Aquí se modela la
        // decisión CERRADA del diseño: este equipo YA conoce un cierre de ese periodo
        // (lo ha bajado), así que NO escribe el suyo (la idempotencia de negocio gana)
        // y lo delata como discrepancia. El cálculo, además, deduplica por clave de
        // negocio: dos cierres del mismo periodo NUNCA se suman dos veces.
        const B5 = crearEquipo('B5', servidorGlobal, { deviceId: 'BBBB5555', modoSync: 'operaciones' });
        bajarMovimientos(B5);
        const cierreB5 = cerrarPeriodo(B5, PRODUCTO, '2026-02', saldo, antes.base, '2026-02-28T23:59:59.000Z');
        bajarMovimientos(A);
        const nubeConDosCierres = movimientosEnNube();
        const cierresEnNube = Object.keys(nubeConDosCierres).filter(k => campo(nubeConDosCierres[k], 'tipoMov') === 'cierre').length;
        const trasCierreOtroEquipo = sumarStock(nubeConDosCierres, PRODUCTO);
        const trasReintento = sumarStock(A.local.movs, PRODUCTO);
        // Discrepancia REAL: se inyecta a mano, en el mapa local, un segundo nodo del
        // mismo periodo con OTRO delta (el cierre que otro equipo habría escrito con
        // otra cuenta). El cálculo debe contar UNO (el menor) y marcarlo.
        const otroCierre = clonar(rc.op);
        otroCierre.deviceId = 'DDDD4444';
        otroCierre.secuencia = 1;
        otroCierre.payload = Object.assign({}, otroCierre.payload, { cantidad: 12, saldoContado: 22 });
        A.local.movs[nodoDe(otroCierre)] = otroCierre;
        const conDiscrepancia = sumarStock(A.local.movs, PRODUCTO);
        // La forma INGENUA de sumar (ignorar el cierre y sumar el histórico entero) descuadra:
        const ingenuo = sumarStockIngenuo(A.local.movs, PRODUCTO);
        const cierresA = Object.keys(A.local.movs).filter(k => campo(A.local.movs[k], 'tipoMov') === 'cierre');

        nota('antes del cierre: ' + antes.movimientosTotales + ' nodos | stock ' + antes.stock +
             ' = base ' + antes.base + ' + ' + antes.movimientosSumados + ' movimientos');
        nota('cierre ' + rc.clave + ' con saldo base ' + saldo + ' del periodo 2026-02 -> stock ' + despues.stock);
        nota('despues del cierre: base ' + despues.base + ' (' + despues.movimientosBase + ' nodos de saldo) + ' +
             despues.movimientosSumados + ' movimientos = stock ' + despues.stock);
        nota('venta posterior al cierre (-5) -> stock ' + trasCierre.stock + ' | movimientos sumados: ' + trasCierre.movimientosSumados);
        nota('reintento del cierre -> cierres en el equipo A: ' + cierresA.length + ' | stock ' + trasReintento.stock);
        nota('dos equipos cierran el mismo periodo -> el segundo NO escribe: cierre de B5 duplicado=' + (cierreB5.duplicada === true) +
             ' | nodos `cierre` en la nube: ' + cierresEnNube + ' | stock de la nube: ' + trasCierreOtroEquipo.stock + ' (no 18+8=26)');
        nota('cierre discrepante inyectado (delta 12 en vez de 8) -> stock ' + conDiscrepancia.stock + ' (toma el MENOR) | ' +
             'cierresDuplicados=' + conDiscrepancia.cierresDuplicados + ' | cierres contados=' + conDiscrepancia.movimientosBase);
        aviso('suma ingenua (sumar TODOS los nodos, incluidos los que el cierre ya absorbió): ' + ingenuo +
              ' <- descuadra, por eso el cierre necesita su periodo');
        nota('oráculo independiente (10 + 20 - 12) = ' + oraculo + ' | stock antes del cierre: ' + antes.stock +
             ' | stock después: ' + despues.stock);
        nota('nodos del periodo en la nube: ' + Object.keys(movimientosEnNube()).length);
        check('T5 · el cierre NO cambia el stock (contrastado contra el oráculo independiente ' + oraculo + ')',
            antes.stock === oraculo && despues.stock === oraculo, json({ oraculo: oraculo, antes: antes.stock, despues: despues.stock }));
        check('T5 · tras el cierre la suma a recorrer baja de 13 movimientos a 0 (los 13 del periodo ya están en el saldo)',
            antes.movimientosSumados === 13 && antes.movimientosBase === 1 &&
            despues.movimientosSumados === 0 && despues.movimientosBase === 2 && despues.base === saldo,
            json({ antes: { sumados: antes.movimientosSumados, base: antes.base }, despues: { sumados: despues.movimientosSumados, base: despues.base } }));
        check('T5 · un movimiento posterior al cierre se suma al saldo base (stock - 5)',
            trasCierre.stock === despues.stock - 5 && trasCierre.movimientosSumados === 1,
            json({ stock: trasCierre.stock, sumados: trasCierre.movimientosSumados }));
        check('T5 · DOS equipos cerrando el mismo periodo NO suman el cierre dos veces (el segundo no escribe y el cálculo deduplica)',
            cierreB5.duplicada === true && cierresEnNube === 1 &&
            trasCierreOtroEquipo.stock === trasCierre.stock && trasCierreOtroEquipo.cierresDuplicados === false,
            json({ duplicada: cierreB5.duplicada, cierres: cierresEnNube, stock: trasCierreOtroEquipo.stock }));
        check('T5 · dos cierres del mismo periodo con importes DISTINTOS se cuentan una vez (el menor) y se marcan',
            conDiscrepancia.cierresDuplicados === true && conDiscrepancia.stock === trasCierre.stock &&
            conDiscrepancia.movimientosBase === 2,
            json({ stock: conDiscrepancia.stock, esperado: trasCierre.stock, duplicados: conDiscrepancia.cierresDuplicados }));
        check('T5 · el stock tras el reintento del cierre sigue siendo el mismo',
            trasReintento.stock === trasCierre.stock, json({ trasCierre: trasCierre.stock, trasReintento: trasReintento.stock }));
        check('T5 · la suma ingenua (sin descontar lo que el cierre absorbe) descuadra: ' + ingenuo + ' != ' + trasCierre.stock,
            ingenuo !== trasCierre.stock, json({ ingenuo: ingenuo, correcto: trasCierre.stock }));
    }

    /* ------------------------------------------------------------------ */
    titulo('T6 · Migración del stock existente: el `inicial` se crea UNA sola vez y el stock no cambia');
    {
        // ---- un equipo que se migra dos veces ----
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        const A = crearEquipo('A', servidorGlobal, { deviceId: 'AAAA1111', modoSync: 'operaciones' });
        clasicoArrancar(A);
        const stockAntes = clasicoStock(A, PRODUCTO);
        const m1 = migrarInicial(A, PRODUCTO, stockAntes, '2026-02-01T00:00:00.000Z');
        const stockTras1 = sumarStock(A.local.movs, PRODUCTO).stock;
        // Segundo intento (la página se recarga a mitad de la migración y la repite).
        const m2 = migrarInicial(A, PRODUCTO, stockAntes, '2026-02-01T00:00:00.000Z');
        const stockTras2 = sumarStock(A.local.movs, PRODUCTO).stock;
        const nodos = Object.keys(movimientosEnNube()).length;
        nota('clasico stock ' + stockAntes + ' -> migrar -> stock ' + stockTras1 + ' -> repetir migración -> stock ' + stockTras2);
        nota('clave de negocio del inicial: ' + opIdInicial(PRODUCTO) + ' (' + m1.clave + ') | nodos en la nube: ' + nodos);
        check('T6 · la migración no cambia el stock (10 -> 10)',
            stockTras1 === 10 && stockTras2 === 10, json({ antes: stockAntes, tras1: stockTras1, tras2: stockTras2 }));
        check('T6 · migrar dos veces NO crea dos `inicial` (misma clave de negocio)',
            m2.duplicada === true && Object.keys(A.local.movs).length === 1, json({ duplicada: m2.duplicada, movs: Object.keys(A.local.movs).length }));
        check('T6 · la nube tiene UN solo nodo `inicial`',
            nodos === 1, String(nodos));

        // ---- dos equipos migrando el MISMO producto con stock DISTINTO (10 y 12) ----
        // Valores distintos a propósito: así «se toma el MENOR» se distingue de «el
        // primero» (10) y de «el MAYOR» / «la suma» (12 / 22).
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        const A2 = crearEquipo('A', servidorGlobal, { deviceId: 'AAAA1111', modoSync: 'operaciones' });
        const B = crearEquipo('B', servidorGlobal, { deviceId: 'BBBB2222', modoSync: 'operaciones' });
        A2.local.productos = catalogoInicial(10);
        B.local.productos = catalogoInicial(12);
        const ma = migrarInicial(A2, PRODUCTO, 10, '2026-02-01T00:00:00.000Z');
        const mb = migrarInicial(B, PRODUCTO, 12, '2026-02-01T00:00:00.000Z');
        const nubeB = movimientosEnNube();
        const calcB = sumarStock(nubeB, PRODUCTO);
        const C3 = crearEquipo('C3', servidorGlobal, { deviceId: 'CCCC3333', modoSync: 'operaciones' });
        bajarMovimientos(C3);
        const calcC3 = sumarStock(C3.local.movs, PRODUCTO);
        nota('b) · A migra 10 (' + nodoDe(ma.op) + ') y B migra 12 (' + nodoDe(mb.op) + '): misma clave de negocio ' + ma.clave);
        nota('b) · nodos en la nube: ' + Object.keys(nubeB).length + ' | iniciales duplicados: ' + calcB.inicialesDuplicados +
             ' | stock calculado: ' + calcB.stock + ' (menor) frente a 12 (mayor) o 22 (suma) | un equipo nuevo: ' + calcC3.stock);
        check('T6 · el mismo producto migrado por dos equipos NO duplica el stock: el duplicado se toma por el MENOR (10, no 12 ni 22)',
            calcB.stock === 10 && calcB.inicial === 10 && Object.keys(nubeB).length === 2,
            json({ nodos: Object.keys(nubeB).length, stock: calcB.stock, inicial: calcB.inicial }));
        check('T6 · el duplicado de `inicial` queda marcado para diagnóstico y para corregirlo a mano',
            calcB.inicialesDuplicados === true && calcB.movimientosBase === 1, json({ duplicados: calcB.inicialesDuplicados }));
        check('T6 · un equipo nuevo que llega calcula el mismo stock (10)',
            calcC3.stock === 10, String(calcC3.stock));

        // ---- dos equipos con stock inicial DISTINTO: hay que decidir a mano ----
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        const A3 = crearEquipo('A', servidorGlobal, { deviceId: 'AAAA1111', modoSync: 'operaciones' });
        const B3 = crearEquipo('B', servidorGlobal, { deviceId: 'BBBB2222', modoSync: 'operaciones' });
        migrarInicial(A3, PRODUCTO, 10, '2026-02-01T00:00:00.000Z');
        migrarInicial(B3, PRODUCTO, 8, '2026-02-01T00:01:00.000Z');
        const conflictosMig = conflictosDeClave(movimientosEnNube(), PRODUCTO);
        const calcD = sumarStock(movimientosEnNube(), PRODUCTO);
        nota('c) · A dice 10 y B dice 8 -> nodos: ' + Object.keys(movimientosEnNube()).length +
             ' | inicial tomado (el MENOR): ' + calcD.inicial + ' | stock: ' + calcD.stock);
        aviso('c) · la diferencia (2 unidades) NO se puede resolver sola: hay que avisar y corregir con un `ajuste` manual');
        check('T6 · con dos stocks iniciales distintos el sistema elige el MENOR (nunca infla) y lo delata',
            calcD.stock === 8 && calcD.inicialesDuplicados === true,
            json({ stock: calcD.stock, inicial: calcD.inicial, duplicados: calcD.inicialesDuplicados }));
        check('T6 · el conflicto queda visible en el diagnóstico (misma clave de negocio, contenido distinto)',
            conflictosMig.length === 1 && conflictosMig[0] === opIdInicial(PRODUCTO), json(conflictosMig));
    }

    /* ------------------------------------------------------------------ */
    titulo('T7 · Modo clásico: comportamiento IDÉNTICO al de hoy (regresión)');
    {
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        // El motor no arranca con ningún valor que no sea 'operaciones', y SÍ arranca
        // con el valor exacto.
        const valores = [undefined, false, 'clasico', true, 0, 'operaciones ', 'operaciones'];
        const resultados = valores.map(v => {
            // Cada valor se prueba en un servidor LIMPIO: el caso positivo escribe en
            // `ops/movimiento` y no debe contaminar la prueba de regresión clásica.
            crearServidorGlobal();
            sembrar(catalogoInicial(10));
            const eq = crearEquipo('X' + String(v), servidorGlobal, { modoSync: v, deviceId: 'AAAA1111' });
            const r = registrarMovimiento(eq, { opId: opIdVenta('V-1'), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -1 });
            return { valor: String(v), activo: eq.activo(), registrado: r.ok === true, motivo: r.motivo || '',
                     escribio: leerDe(servidorGlobal.datos, rutaMovimientos) !== null };
        });
        nota('interruptor -> ' + json(resultados));
        const soloElExacto = resultados.every(r =>
            (r.valor === 'operaciones') ? (r.activo === true && r.registrado === true && r.escribio === true)
                                        : (r.activo === false && r.registrado === false && r.escribio === false));
        check('T7 · solo el valor exacto \'operaciones\' enciende el motor (ni ausente, ni false, ni \'clasico\', ni con espacio)',
            soloElExacto, json(resultados));

        // La venta clásica sigue funcionando igual: número en el producto + arreglo completo.
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        const A = crearEquipo('A', servidorGlobal, { modoSync: 'clasico', deviceId: 'AAAA1111' });
        const B = crearEquipo('B', servidorGlobal, { modoSync: 'clasico', deviceId: 'BBBB2222' });
        clasicoArrancar(A); clasicoArrancar(B);
        const v = clasicoVender(A, PRODUCTO, 3, '2026-02-14T10:00:00.000Z');
        const nube = leerDe(servidorGlobal.datos, rutaProductosClasico);
        const aj = clasicoAjustar(A, PRODUCTO, 18, '2026-02-14T11:00:00.000Z');   // delta, como la app de hoy
        nota('clasico · venta -> stock local ' + v.stock + ' | nube productos[0].stock ' + nube[0].stock +
             ' | el producto sigue siendo un número: ' + typeof nube[0].stock);
        nota('clasico · ajuste manual por DELTA +18 -> stock ' + aj.stock + ' (un número en el producto)');
        nota('clasico · movimientos en ops/movimiento: ' + json(leerDe(servidorGlobal.datos, rutaMovimientos)));
        check('T7 · la venta clásica descuenta el número y sube el arreglo completo',
            v.stock === 7 && nube[0].stock === 7, json({ local: v.stock, nube: nube[0].stock }));
        check('T7 · el ajuste clásico sigue siendo un DELTA sobre el número y sube el arreglo completo',
            aj.stock === 25 && leerDe(servidorGlobal.datos, rutaProductosClasico)[0].stock === 25, String(aj.stock));
        check('T7 · en modo clásico NO se escribe ni un solo `ops/movimiento`',
            leerDe(servidorGlobal.datos, rutaMovimientos) === null,
            json(leerDe(servidorGlobal.datos, rutaMovimientos)));
        check('T7 · en modo clásico el equipo NO crea log local de movimientos ni cola pendiente',
            Object.keys(A.local.movs).length === 0 && A.pendientes && Object.keys(A.pendientes).length === 0,
            json({ movs: Object.keys(A.local.movs).length }));
    }

    /* ------------------------------------------------------------------ */
    titulo('T8 · Plan local (sin nube): los movimientos se acumulan en el equipo y el stock es correcto');
    {
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        const A = crearEquipo('A', servidorGlobal, { deviceId: 'AAAA1111', modoSync: 'operaciones', cloudSync: false });   // plan local
        const escriturasAntes = servidorGlobal.escrituras;
        migrarInicial(A, PRODUCTO, 10, '2026-02-01T00:00:00.000Z');
        registrarMovimiento(A, { opId: opIdVenta('V-LOCAL-AAAA1111-0007'), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -3, ref: 'V-LOCAL-AAAA1111-0007', fechaISO: '2026-02-14T10:00:00.000Z' });
        registrarMovimiento(A, { opId: opIdCompra('C-0003', PRODUCTO), productoId: PRODUCTO, tipoMov: 'compra', cantidad: 12, ref: 'C-0003', fechaISO: '2026-02-14T11:00:00.000Z' });
        registrarMovimiento(A, { opId: opIdAjuste(PRODUCTO, '2026-02-14'), productoId: PRODUCTO, tipoMov: 'ajuste', cantidad: -1, nota: 'merma', fechaISO: '2026-02-14T12:00:00.000Z' });
        const r = sumarStock(A.local.movs, PRODUCTO);
        const enNube = leerDe(servidorGlobal.datos, rutaMovimientos);
        nota('plan local · movs en el equipo: ' + r.movimientosTotales + ' | pendientes de subir: ' + Object.keys(A.pendientes).length);
        nota('plan local · stock calculado: 10 - 3 + 12 - 1 = ' + r.stock);
        nota('plan local · ops/movimiento en la nube: ' + json(enNube) + ' | escrituras nuevas: ' + (servidorGlobal.escrituras - escriturasAntes));
        check('T8 · sin nube el stock sigue siendo correcto (18)', r.stock === 18, String(r.stock));
        check('T8 · los 4 movimientos están guardados en el equipo',
            r.movimientosTotales === 4 && Object.keys(A.local.movs).length === 4, String(r.movimientosTotales));
        check('T8 · sin nube NO se escribe NADA en la nube (ni movimientos ni productos)',
            enNube === null && (servidorGlobal.escrituras - escriturasAntes) === 0,
            json({ nube: enNube, escrituras: servidorGlobal.escrituras - escriturasAntes }));
        check('T8 · las operaciones quedan PENDIENTES (no se pierden ni se liberan)',
            Object.keys(A.pendientes).length === 4, String(Object.keys(A.pendientes).length));
        // El día que se activa la nube, la cola se vacía y el stock no cambia.
        A.cloudSync = true;
        const vac = vaciarCola(A);
        const r2 = sumarStock(A.local.movs, PRODUCTO);
        nota('plan local · al activar la nube se suben ' + vac.subidas + ' operaciones | pendientes: ' + vac.pendientes +
             ' | stock: ' + r2.stock);
        check('T8 · al activar la nube se sube la cola entera y el stock sigue siendo 18',
            vac.subidas === 4 && vac.pendientes === 0 && r2.stock === 18, json({ subidas: vac.subidas, stock: r2.stock }));
    }

    /* ------------------------------------------------------------------ */
    titulo('T9 · Movimiento que llega tarde o fuera de orden: el neto no cambia');
    {
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        const A = crearEquipo('A', servidorGlobal, { deviceId: 'AAAA1111', modoSync: 'operaciones' });
        migrarInicial(A, PRODUCTO, 10, '2026-02-01T00:00:00.000Z');
        registrarMovimiento(A, { opId: opIdVenta('V-LOCAL-AAAA1111-0007'), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -3, ref: 'V-LOCAL-AAAA1111-0007', fechaISO: '2026-02-14T10:00:00.000Z' });
        registrarMovimiento(A, { opId: opIdCompra('C-0004', PRODUCTO), productoId: PRODUCTO, tipoMov: 'compra', cantidad: 5, ref: 'C-0004', fechaISO: '2026-02-13T09:00:00.000Z' });   // anterior en el tiempo, posterior en la subida
        const orden1 = sumarStock(A.local.movs, PRODUCTO).stock;
        // Equipo B recibe lo mismo en OTRO orden (bajada paginada al revés). Se
        // indexa por NODO, como la ruta real, y se recorre en orden inverso.
        const B = crearEquipo('B', servidorGlobal, { deviceId: 'BBBB2222', modoSync: 'operaciones' });
        const nodos = Object.keys(movimientosEnNube()).reverse();
        for (const n of nodos) { const op = movimientosEnNube()[n]; B.local.movs[n] = op; B.local.orden.push(n); }
        const orden2 = sumarStock(B.local.movs, PRODUCTO).stock;
        // Movimiento que llega MUY tarde (días después): se suma al final y el neto sigue cuadrando.
        registrarMovimiento(A, { opId: opIdVenta('V-LOCAL-AAAA1111-0008'), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -2, ref: 'V-LOCAL-AAAA1111-0008', fechaISO: '2026-02-12T10:00:00.000Z' });
        const final = sumarStock(A.local.movs, PRODUCTO).stock;
        nota('A (orden de creación): ' + orden1 + ' | B (recibido al revés, indexado por nodo): ' + orden2 +
             ' | stock final: 10 - 3 + 5 - 2 = ' + final);
        nota('orden de aplicación no altera el resultado: ' + (orden1 === orden2));
        check('T9 · dos equipos que reciben los movimientos en orden distinto calculan el mismo stock',
            orden1 === orden2 && orden1 === 12, json({ A: orden1, B: orden2 }));
        check('T9 · un movimiento que llega tarde (fecha anterior a otros ya aplicados) cuadra igual',
            final === 10, String(final));

        // ---- HUECO CONOCIDO (§11.1): movimiento que llega DESPUÉS de un cierre ----
        // Se cierra 2026-02 con saldo 10 y después llega una venta FECHADA dentro del
        // periodo cerrado: queda absorbida por el saldo base y NO se suma. La
        // comprobación fija ese comportamiento indeseado para que no se olvide.
        const C = crearEquipo('C', servidorGlobal, { deviceId: 'CCCC3333', modoSync: 'operaciones' });
        bajarMovimientos(C);
        cerrarPeriodo(C, PRODUCTO, '2026-02', 10, 10, '2026-02-28T23:59:59.000Z');
        const antesTardia = sumarStock(C.local.movs, PRODUCTO).stock;
        const tardia = registrarMovimiento(C, { opId: opIdVenta('V-LOCAL-CCCC3333-0099'), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -1, ref: 'V-LOCAL-CCCC3333-0099', fechaISO: '2026-02-20T10:00:00.000Z' });
        const despuesTardia = sumarStock(C.local.movs, PRODUCTO);
        aviso('HUECO §11.1: una venta fechada el 2026-02-20 registrada DESPUÉS del cierre de 2026-02 se pierde para el stock (' +
              antesTardia + ' -> ' + despuesTardia.stock + '); sigue en el log (nodo ' + nodoDe(tardia.op) + ') y en los reportes');
        check('T9 · (hueco documentado) una venta que llega tras el cierre de su propio periodo NO se suma al stock',
            antesTardia === 10 && despuesTardia.stock === 10 && despuesTardia.movimientosSumados === 0,
            json({ antes: antesTardia, despues: despuesTardia.stock, sumados: despuesTardia.movimientosSumados }));
    }

    /* ------------------------------------------------------------------ */
    titulo('T10 · Convivencia con lo clásico: una escritura clásica de productos no pisa el stock calculado');
    {
        crearServidorGlobal();
        sembrar(catalogoInicial(10));
        const A = crearEquipo('A', servidorGlobal, { deviceId: 'AAAA1111', modoSync: 'operaciones' });
        migrarInicial(A, PRODUCTO, 10, '2026-02-01T00:00:00.000Z');
        registrarMovimiento(A, { opId: opIdVenta('V-LOCAL-AAAA1111-0007'), productoId: PRODUCTO, tipoMov: 'venta', cantidad: -3, ref: 'V-LOCAL-AAAA1111-0007', fechaISO: '2026-02-14T10:00:00.000Z' });
        const calculado = sumarStock(A.local.movs, PRODUCTO).stock;
        // Un cliente viejo (o una página no migrada) sube el ARREGLO COMPLETO con SU stock.
        const viejo = [{ id: PRODUCTO, nombre: 'Harina PAN 1kg', stock: 10, precio: 1.2 }];
        sembrar(viejo);       // un cliente viejo sube el ARREGLO COMPLETO con SU stock (10 stale)
        // Regla de convivencia (§9): en modo operaciones, el `stock` del arreglo
        // clásico se LEE como caché pero NO se aplica: la verdad es la suma.
        const cacheLeida = leerDe(servidorGlobal.datos, rutaProductosClasico)[0].stock;
        // El cálculo no mira `producto.stock` en ningún caso: se comprueba que el
        // mismo cálculo da lo mismo ANTES y DESPUÉS de la escritura clásica.
        const calculadoDespues = sumarStock(A.local.movs, PRODUCTO).stock;
        nota('arreglo clásico subido por un cliente viejo: stock ' + cacheLeida);
        nota('stock calculado (suma) antes de la escritura clásica: ' + calculado + ' | después: ' + calculadoDespues +
             ' (lo que hay en el producto NO entra en la cuenta)');
        check('T10 · el arreglo clásico se acepta como catálogo pero su `stock` (10) NO cambia la verdad calculada (7)',
            calculado === 7 && calculadoDespues === 7 && cacheLeida === 10,
            json({ calculado: calculado, despues: calculadoDespues, cache: cacheLeida }));
        // Y el caché se reescribe con el valor calculado (solo presentación). Ojo:
        // leer y mutar en memoria no basta —RTDB devuelve copias—, hay que volver a
        // escribir el arreglo completo por el camino clásico.
        const arr = leerDe(servidorGlobal.datos, rutaProductosClasico) || [];
        arr[0].stock = calculado;
        arr[0].stockMtime = '2026-02-14T10:00:00.000Z';
        A.set(rutaProductosClasico, arr);
        const cacheRegenerada = leerDe(servidorGlobal.datos, rutaProductosClasico)[0].stock;
        nota('caché de presentación regenerada con el valor calculado: ' + cacheRegenerada);
        check('T10 · el campo `stock` queda como caché de presentación (el valor calculado), no como fuente de verdad',
            cacheRegenerada === 7, String(cacheRegenerada));
    }

    /* ------------------------------------------------------------------ */
    console.log('\n================ ' + ok + ' OK, ' + fallos + ' FALLAS ================');
    if (fallos === 0) {
        console.log('El diseño del stock por movimientos pasa los 8 escenarios obligatorios + 2 extra (T9, T10).');
        console.log('Aviso: esto NO es el motor; es el simulador del diseño. Sus puntos débiles están en §12 del documento.');
    }
    process.exit(fallos === 0 ? 0 : 1);
})();
