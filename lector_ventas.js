/* =====================================================================
   LECTOR_VENTAS_V1 (Fase B, etapa E2) — lectura unificada de ventas

   QUÉ ES
   ------
   La pieza que hace que las pantallas que LEEN ventas vean los DOS MUNDOS
   a la vez, sin duplicar y sin perder nada:

     * mundo NUEVO  -> las OPERACIONES confirmadas en `ops/venta/*` (E1)
     * mundo VIEJO  -> `ventas/historial`, que quedó CONGELADO (solo lectura)
     * mundo LOCAL  -> la ventana caliente del equipo y `pos_sales`

   Con el interruptor en 'clasico' lee EXACTAMENTE lo de siempre
   (`ventas/historial` + `pos_sales` local) para que ningún reporte cambie.
   Con el interruptor en 'operaciones' une los tres orígenes y descarta los
   repetidos comparando por `id` y, si la venta no lo tiene, por la
   combinación fecha + total + referencia de ticket.

   GARANTÍAS DURAS (encargo E2)
   ----------------------------
   1. NUNCA escribe en la nube: todo lo que hace contra Firebase es
      `once('value')` (lecturas). No hay ni un `set`, `update`, `push` ni
      `remove` en este archivo.
   2. NUNCA escribe `ventas/historial`: ese nodo es del período anterior y
      queda congelado. Solo se lee.
   3. Si algo falla devuelve `{ ok:false, error:'...' }`; jamás lanza.
   4. Autocontenido: IIFE, sin dependencias, sin credenciales. La config de
      Firebase (si hace falta) la pasa la página en `opciones.db`.
   5. No arranca `motor_operaciones.js` (arrancarlo puede re-subir operaciones
      liberadas, o sea escribir en la nube). Solo lo USA si ya está activo.

   API (`window.lectorVentas`)
   ---------------------------
     leerVentas({ desde, hasta, modoSync, ... })  -> promesa
     resumenDelDia(fecha, opciones)               -> promesa
     resumenRango(desde, hasta, opciones)         -> promesa
     estado()                                     -> objeto

   OPCIONES ADMITIDAS (todas opcionales; la página pasa las tres primeras)
   ----------------------------------------------------------------------
     desde / hasta : 'AAAA-MM-DD', ISO, Date o ms. Sin valor = sin límite.
     modoSync      : 'clasico' | 'operaciones'. Si falta, se mira si el motor
                     ya está activo en esta página; si no, 'clasico'.
     db            : raíz de Firebase RTDB v8 (`firebase.database()`). Sin ella
                     el lector trabaja SOLO con lo local (y lo dice).
     emailPath     : ruta del cliente bajo `BBDD/`. Si falta se deduce de la
                     sesión (`propietarioActual` / `currentOwner`).
     online        : true/false fuerza el estado de conexión (costura de
                     PRUEBA y de páginas offline).
     puedeSobrescribir : false = hay cambios locales sin subir, así que NO se
                     pisa lo local con la nube (misma guardia que la app).
     fuentes       : costura de PRUEBA para inyectar orígenes. Cada clave es
                     una función async que devuelve `{ ok, ventas }`:
                     `caliente`, `posSales`, `ops`, `historico`, `indice`.

   CÓMO SE CUENTA EL DÍA (importante)
   ----------------------------------
   El día de una venta se calcula recortando su fecha ISO en UTC
   (`fechaISO.slice(0,10)`), que es EXACTAMENTE lo que usa el motor al
   escribir `ventas_idx/<AAAA-MM-DD>`. Así el índice y el recálculo hablan
   siempre del mismo día.

   ALCANCE
   -------
   Etapa E2: solo lectura y agregados. No decide cobros, no toca la cola, no
   modifica `almacenamiento.js` ni `sincronizacion.js`.
   ===================================================================== */
(function () {
    'use strict';

    /* =================================================================
       0. Constantes y estado
       ================================================================= */

    /** Versión del lector (no confundir con la del motor). */
    /* v2: el resumen separa el consumo interno (fuera de los totales de venta) y
       el fiado «por cobrar» (dentro de las ventas, informado aparte). */
    var VERSION_LECTOR = 2;

    /** Ventas por página al leer la nube (§6 del diseño: nada cuelga la UI). */
    var TAMANO_PAGINA = 300;

    /** Tope de páginas por lectura: una lectura no puede colgar la pantalla. */
    var MAX_PAGINAS = 40;

    /** Días de la ventana caliente que se piden al motor (los mismos del §4). */
    var DIAS_VENTANA_CALIENTE = 30;

    /** Tope de días que se listan en `faltantes` (evita arreglos enormes). */
    var MAX_DIAS_FALTANTES = 400;

    var MS_DIA = 24 * 60 * 60 * 1000;

    var CLAVE_POS_SALES = 'pos_sales';

    var _modo = 'clasico';
    var _ultimaLectura = null;          // ISO de la última lectura, o null
    var _cache = [];                    // ventas de la última lectura
    var _cacheRango = { desde: null, hasta: null };
    var _ultimoOrigen = { locales: 0, ops: 0, historicoCongelado: 0 };
    var _ultimoError = '';

    /* =================================================================
       1. Utilidades mínimas (todo en try/catch: nunca lanzan)
       ================================================================= */

    function avisar(mensaje) {
        try {
            if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
                console.warn('[lectorVentas] ' + mensaje);
            }
        } catch (e) { /* sin consola: nada */ }
    }

    function anotarError(e, donde) {
        var texto = '';
        try {
            texto = (e && (e.message || e.code)) ? String(e.message || e.code) : String(e);
        } catch (e2) { texto = 'error-desconocido'; }
        if (!texto) texto = 'error-desconocido';
        _ultimoError = donde + ': ' + texto;
        avisar(_ultimoError);
        return _ultimoError;
    }

    /** Cualquier fecha legible -> ms. NaN si no se puede. */
    function aMs(valor) {
        try {
            if (valor === null || valor === undefined || valor === '') return NaN;
            if (typeof valor === 'number' && isFinite(valor)) return valor;
            if (valor instanceof Date) return valor.getTime();
            var t = Date.parse(String(valor));
            return isNaN(t) ? NaN : t;
        } catch (e) { return NaN; }
    }

    function iso(ms) {
        try { return new Date(Number(ms) || 0).toISOString(); } catch (e) { return '1970-01-01T00:00:00.000Z'; }
    }

    /** Día UTC ('AAAA-MM-DD') de un valor de fecha: la clave de `ventas_idx`. */
    function diaDe(valor) {
        var t = aMs(valor);
        if (isNaN(t)) return '';
        try { return new Date(t).toISOString().slice(0, 10); } catch (e) { return ''; }
    }

    function clonar(v) {
        try {
            if (v === undefined) return null;
            return JSON.parse(JSON.stringify(v));
        } catch (e) { return null; }
    }

    function esObjeto(v) {
        return !!v && typeof v === 'object';
    }

    /**
     * Un nodo de RTDB puede llegar como arreglo o como objeto con claves.
     * Devuelve pares `{ clave, valor }` en el orden natural de las claves
     * (numéricas primero), que es el orden en que las escribió la app.
     */
    function normalizarPares(valor) {
        var salida = [];
        try {
            if (!valor) return salida;
            if (Array.isArray(valor)) {
                for (var i = 0; i < valor.length; i++) {
                    if (valor[i] !== null && valor[i] !== undefined) salida.push({ clave: String(i), valor: valor[i] });
                }
                return salida;
            }
            if (typeof valor !== 'object') return salida;
            var claves = Object.keys(valor);
            claves.sort(function (a, b) {
                var na = parseInt(a, 10), nb = parseInt(b, 10);
                if (isFinite(na) && isFinite(nb) && String(na) === a && String(nb) === b) return na - nb;
                return String(a).localeCompare(String(b));
            });
            for (var j = 0; j < claves.length; j++) {
                if (valor[claves[j]] !== null && valor[claves[j]] !== undefined) {
                    salida.push({ clave: claves[j], valor: valor[claves[j]] });
                }
            }
            return salida;
        } catch (e) { return salida; }
    }

    function normalizarLista(valor) {
        try {
            var pares = normalizarPares(valor);
            var lista = [];
            for (var i = 0; i < pares.length; i++) lista.push(pares[i].valor);
            return lista;
        } catch (e) { return []; }
    }

    function sanitizeEmailForDb(email) {
        try {
            return String(email).replace('@', '_at_').replace(/\./g, '_');
        } catch (e) { return ''; }
    }

    /** Ruta del cliente: la que pasa la página o la de la sesión. */
    function emailPathDeSesion() {
        try {
            if (typeof sessionStorage === 'undefined' || !sessionStorage) return '';
            var directo = sessionStorage.getItem('propietarioActual');
            if (directo) return sanitizeEmailForDb(directo);
            var owner = JSON.parse(sessionStorage.getItem('currentOwner') || 'null');
            if (owner && owner.email) return sanitizeEmailForDb(owner.email);
        } catch (e) { /* sin sesión: sin ruta */ }
        return '';
    }

    function leerLocal(clave) {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) return null;
            return localStorage.getItem(clave);
        } catch (e) { return null; }
    }

    /**
     * Límite inferior/superior en ms. Un 'AAAA-MM-DD' se interpreta como el
     * día completo (00:00:00.000 a 23:59:59.999) en hora local, que es como
     * filtra la pantalla de resumen.
     */
    function limiteMs(valor, esHasta) {
        try {
            if (valor === null || valor === undefined || valor === '') return NaN;
            if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor.trim())) {
                var p = valor.trim().split('-');
                var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]),
                    esHasta ? 23 : 0, esHasta ? 59 : 0, esHasta ? 59 : 0, esHasta ? 999 : 0);
                return d.getTime();
            }
            return aMs(valor);
        } catch (e) { return NaN; }
    }

    function rangoMs(desde, hasta) {
        var r = { desdeMs: limiteMs(desde, false), hastaMs: limiteMs(hasta, true), desdeISO: '', hastaISO: '' };
        if (!isNaN(r.desdeMs)) r.desdeISO = iso(r.desdeMs);
        if (!isNaN(r.hastaMs)) r.hastaISO = iso(r.hastaMs);
        if (!isNaN(r.desdeMs) && !isNaN(r.hastaMs) && r.hastaMs < r.desdeMs) {
            var t = r.desdeMs; r.desdeMs = r.hastaMs; r.hastaMs = t;
            t = r.desdeISO; r.desdeISO = r.hastaISO; r.hastaISO = t;
        }
        return r;
    }

    function enRango(fecha, rango) {
        var t = aMs(fecha);
        if (isNaN(t)) return false;
        if (!isNaN(rango.desdeMs) && t < rango.desdeMs) return false;
        if (!isNaN(rango.hastaMs) && t > rango.hastaMs) return false;
        return true;
    }

    /** Días UTC del rango, para poder informar qué falta. */
    function diasDelRango(rango) {
        try {
            if (isNaN(rango.desdeMs) || isNaN(rango.hastaMs)) return null;
            var n = Math.floor((rango.hastaMs - rango.desdeMs) / MS_DIA) + 1;
            if (!(n > 0) || n > MAX_DIAS_FALTANTES) return null;
            var dias = [];
            var base = Date.parse(diaDe(rango.desdeMs) + 'T00:00:00.000Z');
            if (isNaN(base)) return null;
            for (var i = 0; i < n; i++) dias.push(new Date(base + i * MS_DIA).toISOString().slice(0, 10));
            return dias;
        } catch (e) { return null; }
    }

    /**
     * Clave de deduplicación de una venta. Primero el `id` (lo normal en los
     * dos mundos). Si no lo tiene, la combinación que pide el encargo:
     * fecha + total + referencia de ticket.
     */
    function claveVenta(v) {
        try {
            if (!esObjeto(v)) return '';
            if (v.id !== null && v.id !== undefined && String(v.id) !== '') return 'id:' + String(v.id);
            var fecha = String(v.fechaISO || v.timestamp || '');
            var total = '';
            if (esObjeto(v.totals) && v.totals.total !== undefined) total = String(v.totals.total);
            else if (v.total !== undefined) total = String(v.total);
            var pd = esObjeto(v.paymentDetails) ? v.paymentDetails : {};
            var ticket = String(pd.reference || v.ticketId || v.referencia || v.receiptId || v.numeroTicket || '');
            return 'c:' + fecha + '|' + total + '|' + ticket;
        } catch (e) { return ''; }
    }

    /** Total de una venta en su propia moneda (para los agregados). */
    function totalDeVenta(v) {
        try {
            if (!esObjeto(v)) return 0;
            if (esObjeto(v.totals) && isFinite(Number(v.totals.total))) return Number(v.totals.total);
            if (isFinite(Number(v.total))) return Number(v.total);
            var suma = 0;
            if (Array.isArray(v.items)) {
                for (var i = 0; i < v.items.length; i++) {
                    var it = v.items[i] || {};
                    var sub = Number(it.subtotal);
                    if (!isFinite(sub)) sub = (Number(it.unitPrice) || 0) * (Number(it.quantity) || 0);
                    suma += isFinite(sub) ? sub : 0;
                }
            }
            return suma;
        } catch (e) { return 0; }
    }

    /** Equivalente en USD de una venta: mismo criterio que el índice del motor. */
    function totalUsdDeVenta(v) {
        try {
            var total = totalDeVenta(v);
            var moneda = esObjeto(v) && v.currency ? String(v.currency) : 'USD';
            var tasa = esObjeto(v) ? (Number(v.exchangeRate) || 0) : 0;
            var usd = (moneda === 'VES' && tasa > 0) ? (total / tasa) : total;
            return Math.round(usd * 100) / 100;
        } catch (e) { return 0; }
    }

    function metodoDeVenta(v) {
        try {
            var m = esObjeto(v) && v.paymentMethod ? String(v.paymentMethod) : '';
            return m || 'sin-metodo';
        } catch (e) { return 'sin-metodo'; }
    }

    /* =================================================================
       Formas de pago de dueño (las dos que solo ve un administrador)
       ----------------------------------------------------------------
       CONSUMO INTERNO: el producto sale del inventario, pero NO es una venta y
       no es ingreso. Queda FUERA de todos los totales de venta.
       POR COBRAR: es una venta (ingreso), pero NO está cobrada: suma en los
       totales y ADEMÁS se informa aparte para poder distinguirla.
       La marca propia (`consumoInterno` / `porCobrar`) manda; el método de pago
       es la segunda señal, por si el dato viene de un registro viejo. */
    function esConsumoInterno(v) {
        try {
            if (!esObjeto(v)) return false;
            if (v.consumoInterno === true) return true;
            return String(v.paymentMethod || '') === 'consumo-interno';
        } catch (e) { return false; }
    }

    function esPorCobrar(v) {
        try {
            if (!esObjeto(v)) return false;
            if (v.porCobrar === true) return true;
            return String(v.paymentMethod || '') === 'por-cobrar';
        } catch (e) { return false; }
    }

    /** Suma una venta a un grupo aparte (consumo interno / por cobrar). */
    function sumarGrupo(grupo, total, totalUSD) {
        grupo.cantidad++;
        grupo.total += total;
        grupo.totalUSD += totalUSD;
    }

    function grupoVacio() { return { cantidad: 0, total: 0, totalUSD: 0 }; }

    /** Orden total: por fecha y, a igualdad, por id (estable y repetible). */
    function compararVentas(a, b) {
        var fa = aMs(a && (a.fechaISO || a.timestamp));
        var fb = aMs(b && (b.fechaISO || b.timestamp));
        if (isNaN(fa)) fa = 0;
        if (isNaN(fb)) fb = 0;
        if (fa !== fb) return fa - fb;
        return String(a && a.id || '').localeCompare(String(b && b.id || ''));
    }

    /* =================================================================
       2. Orígenes de datos (lectura pura)
       ================================================================= */

    /**
     * Operaciones confirmadas de `ops/venta` dentro del rango. Paginado por
     * `fechaISO` (que es el campo por el que ordena el motor) y, si el SDK no
     * deja consultar, se lee el nodo entero y se filtra en memoria.
     * Devuelve `{ ok, filas:[{ venta, nodo, fechaISO }], paginas, truncado, error }`.
     */
    async function leerOpsNube(ctx) {
        var res = { ok: false, filas: [], paginas: 0, truncado: false, error: '' };
        if (!ctx.db || !ctx.emailPath) { res.error = 'sin-nube'; return res; }
        var ruta = 'BBDD/' + ctx.emailPath + '/ops/venta';
        var pares = null;               // null = todavía no se ha leído nada
        try {
            var raiz = ctx.db.ref(ruta);
            if (typeof raiz.orderByChild === 'function') {
                try {
                    pares = await paginar(raiz, 'fechaISO', ctx, res);
                } catch (e) {
                    // Sin consultas utilizables se cae a la lectura completa.
                    avisar('no se pudo paginar ops/venta (' + (e && e.message) + '): se lee entero');
                    res.paginas = 0;
                    res.truncado = false;
                    pares = null;
                }
            }
            if (pares === null) {
                var snap = await raiz.once('value');
                res.paginas = 1;
                pares = normalizarPares(snap && typeof snap.val === 'function' ? snap.val() : null);
            }
            for (var i = 0; i < pares.length; i++) {
                var clave = pares[i].clave;
                var op = pares[i].valor;
                if (!esObjeto(op)) continue;
                var fechaISO = String(op.fechaISO || '');
                if (!enRango(fechaISO, ctx.rango)) continue;
                var payload = esObjeto(op.payload) ? op.payload : op;
                var venta = clonar(payload) || {};
                if (!venta.timestamp && fechaISO) venta.timestamp = fechaISO;
                res.filas.push({ venta: venta, nodo: clave, fechaISO: fechaISO || String(venta.timestamp || '') });
            }
            res.ok = true;
        } catch (e) {
            res.ok = false;
            res.error = anotarError(e, 'leerOpsNube');
        }
        return res;
    }

    /**
     * Historial viejo de `ventas/historial`, CONGELADO: solo lectura y paginado
     * por `timestamp`. Nunca se escribe en ese nodo.
     */
    async function leerHistoricoNube(ctx) {
        var res = { ok: false, filas: [], paginas: 0, truncado: false, vacio: false, error: '' };
        if (!ctx.db || !ctx.emailPath) { res.error = 'sin-nube'; return res; }
        var ruta = 'BBDD/' + ctx.emailPath + '/ventas/historial';
        var pares = null;               // null = todavía no se ha leído nada
        try {
            var raiz = ctx.db.ref(ruta);
            if (typeof raiz.orderByChild === 'function') {
                try {
                    pares = await paginar(raiz, 'timestamp', ctx, res);
                } catch (e) {
                    avisar('no se pudo paginar ventas/historial (' + (e && e.message) + '): se lee entero');
                    res.paginas = 0;
                    res.truncado = false;
                    pares = null;
                }
            }
            if (pares === null) {
                var snap = await raiz.once('value');
                res.paginas = 1;
                pares = normalizarPares(snap && typeof snap.val === 'function' ? snap.val() : null);
            }
            res.vacio = (pares.length === 0);
            for (var i = 0; i < pares.length; i++) {
                var v = pares[i].valor;
                if (!esObjeto(v)) continue;
                if (!enRango(v.timestamp || v.fechaISO, ctx.rango)) continue;
                res.filas.push({ venta: clonar(v) || {}, nodo: pares[i].clave, fechaISO: String(v.timestamp || v.fechaISO || '') });
            }
            res.ok = true;
        } catch (e) {
            res.ok = false;
            res.error = anotarError(e, 'leerHistoricoNube');
        }
        return res;
    }

    /**
     * Índice de agregados del día `ventas_idx/<AAAA-MM-DD>` (caché derivada del
     * motor). Solo lectura; si falta o falla se recalcula desde las ventas.
     */
    async function leerIndiceDia(dia, ctx) {
        var res = { ok: false, entradas: {}, cantidad: 0, error: '' };
        try {
            if (!ctx.db || !ctx.emailPath || !dia) { res.error = 'sin-nube'; return res; }
            var ruta = 'BBDD/' + ctx.emailPath + '/ventas_idx/' + dia;
            var snap = await ctx.db.ref(ruta).once('value');
            var valor = snap && typeof snap.val === 'function' ? snap.val() : null;
            if (!valor) { res.error = 'indice-ausente'; return res; }
            var pares = normalizarPares(valor);
            for (var i = 0; i < pares.length; i++) {
                if (esObjeto(pares[i].valor)) res.entradas[pares[i].clave] = pares[i].valor;
            }
            res.cantidad = Object.keys(res.entradas).length;
            res.ok = res.cantidad > 0;
            if (!res.ok) res.error = 'indice-vacio';
            return res;
        } catch (e) {
            res.ok = false;
            res.error = anotarError(e, 'leerIndiceDia');
            return res;
        }
    }

    /**
     * Pagina una consulta `orderByChild(campo)` con `startAt(fecha, clave)`
     * (el SDK desempata por clave) y `limitToFirst`. Devuelve los pares ya
     * ordenados y sin la fila del cursor repetida.
     */
    async function paginar(raiz, campo, ctx, res) {
        var pares = [];
        var cursor = null;
        var truncado = false;
        var paginas = 0;
        while (paginas < ctx.maxPaginas) {
            var consulta = raiz.orderByChild(campo);
            if (cursor) consulta = consulta.startAt(cursor.fecha, cursor.clave);
            else if (ctx.rango.desdeISO) consulta = consulta.startAt(ctx.rango.desdeISO);
            if (ctx.rango.hastaISO) consulta = consulta.endAt(ctx.rango.hastaISO);
            consulta = consulta.limitToFirst(ctx.tamanoPagina);
            var snap = await consulta.once('value');
            paginas++;
            var pagina = normalizarPares(snap && typeof snap.val === 'function' ? snap.val() : null);
            if (!pagina.length) break;
            var maxF = '', maxC = '', nuevos = 0;
            for (var i = 0; i < pagina.length; i++) {
                var clave = String(pagina[i].clave);
                var fila = pagina[i].valor;
                var f = esObjeto(fila) ? String(fila[campo] || '') : '';
                var mayor = (f > maxF) || (f === maxF && clave > maxC);
                if (mayor) { maxF = f; maxC = clave; }
                if (cursor && f === cursor.fecha && clave === cursor.clave) continue;   // startAt es inclusivo
                pares.push(pagina[i]);
                nuevos++;
            }
            if (pagina.length < ctx.tamanoPagina) break;                 // última página
            if (!nuevos || (maxF === (cursor && cursor.fecha) && maxC === (cursor && cursor.clave))) break;  // no avanza
            cursor = { fecha: maxF, clave: maxC };
            if (paginas >= ctx.maxPaginas) { truncado = true; break; }
        }
        res.paginas = paginas;
        res.truncado = truncado;
        return pares;
    }

    /** Ventana caliente del equipo, si el motor ya está activo en esta página. */
    async function leerCalienteLocal(ctx) {
        var res = { ok: true, ventas: [] };
        try {
            if (typeof ctx.fuentes.caliente === 'function') {
                var inyectado = await ctx.fuentes.caliente(ctx);
                res.ok = !inyectado || inyectado.ok !== false;
                res.ventas = normalizarLista(inyectado && inyectado.ventas);
                return res;
            }
            if (typeof window !== 'undefined' && window.motorOperaciones &&
                typeof window.motorOperaciones.leerVentas === 'function') {
                var lista = await window.motorOperaciones.leerVentas(DIAS_VENTANA_CALIENTE);
                res.ventas = normalizarLista(lista);
            }
            return res;
        } catch (e) {
            res.ok = false;
            res.error = anotarError(e, 'leerCalienteLocal');
            return res;
        }
    }

    /** `pos_sales` del equipo (la proyección local que ya usaba la app). */
    async function leerPosSalesLocal(ctx) {
        var res = { ok: true, ventas: [] };
        try {
            if (typeof ctx.fuentes.posSales === 'function') {
                var inyectado = await ctx.fuentes.posSales(ctx);
                res.ok = !inyectado || inyectado.ok !== false;
                res.ventas = normalizarLista(inyectado && inyectado.ventas);
                return res;
            }
            var crudo = leerLocal(CLAVE_POS_SALES);
            if (!crudo) return res;
            res.ventas = normalizarLista(JSON.parse(crudo));
            return res;
        } catch (e) {
            // Un `pos_sales` corrupto no puede tumbar la pantalla.
            avisar('pos_sales ilegible: se ignora (' + (e && e.message) + ')');
            res.ok = true;
            res.ventas = [];
            return res;
        }
    }

    /* =================================================================
       3. Preparación de la lectura
       ================================================================= */

    function preparar(opciones) {
        opciones = opciones || {};
        var rango = rangoMs(opciones.desde, opciones.hasta);

        var db = opciones.db || null;
        var emailPath = String(opciones.emailPath || emailPathDeSesion() || '');

        var modo = opciones.modoSync;
        if (modo !== 'operaciones' && modo !== 'clasico') {
            modo = 'clasico';
            try {
                if (typeof window !== 'undefined' && window.motorOperaciones &&
                    typeof window.motorOperaciones.estado === 'function') {
                    var est = window.motorOperaciones.estado();
                    if (est && est.activo === true && est.modo === 'operaciones') modo = 'operaciones';
                }
            } catch (e) { /* sin motor: clásico */ }
        }

        var online = null;
        if (opciones.online === true || opciones.online === false) online = opciones.online;
        else if (opciones.conexion === 'sin-conexion') online = false;
        else if (opciones.conexion === 'con-conexion') online = true;
        if (online === null) {
            try { online = !(typeof navigator !== 'undefined' && navigator.onLine === false); }
            catch (e) { online = true; }
        }

        return {
            db: db,
            emailPath: emailPath,
            modo: modo,
            online: online,
            rango: rango,
            dias: diasDelRango(rango),
            tamanoPagina: (Number(opciones.tamanoPagina) > 0) ? Number(opciones.tamanoPagina) : TAMANO_PAGINA,
            maxPaginas: (Number(opciones.maxPaginas) > 0) ? Number(opciones.maxPaginas) : MAX_PAGINAS,
            usarIndice: opciones.usarIndice !== false,
            puedeSobrescribir: opciones.puedeSobrescribir !== false,
            fuentes: esObjeto(opciones.fuentes) ? opciones.fuentes : {}
        };
    }

    /* =================================================================
       4. Lectura unificada (interna): aquí vive toda la unión
       ================================================================= */

    async function _leer(opciones) {
        var res = {
            ok: true,
            ventas: [],
            origen: { locales: 0, ops: 0, historicoCongelado: 0 },
            faltantes: [],
            completo: true,
            truncado: false,
            modo: 'clasico',
            error: '',
            nodosOpsPorDia: {},
            errores: [],
            detalle: { ops: 0, historico: 0, caliente: 0, posSales: 0 }
        };
        try {
            var ctx = preparar(opciones);
            res.modo = ctx.modo;
            _modo = ctx.modo;

            var mapa = {};                 // clave -> { venta, fuente, nodo, fechaISO }
            var orden = [];
            var diasLocales = {};
            var huboErrorNube = false;  // fallo REAL de lectura en la nube
            var nubeNoConsultada = false;   // offline: había nube y no se pudo preguntar
            var fuentesNubeOk = 0;      // orígenes de nube que SÍ se pudieron leer
            var truncado = false;
            var ultimoDiaLeido = '';

            function agregar(venta, fuente, nodo, fechaISO) {
                var clave = claveVenta(venta);
                if (!clave) return false;
                if (mapa[clave]) return false;
                if (fuente === 'ops' && nodo) {
                    var dia = diaDe(fechaISO || venta.timestamp);
                    if (dia) {
                        if (!res.nodosOpsPorDia[dia]) res.nodosOpsPorDia[dia] = [];
                        res.nodosOpsPorDia[dia].push(String(nodo));
                    }
                }
                if (fuente === 'locales') {
                    var d = diaDe(fechaISO || venta.timestamp);
                    if (d) diasLocales[d] = true;
                }
                mapa[clave] = { venta: venta, fuente: fuente, nodo: nodo || '', fechaISO: fechaISO || '' };
                orden.push(clave);
                return true;
            }

            var hayNube = !!ctx.db && !!ctx.emailPath && ctx.online;

            if (ctx.modo === 'clasico') {
                /* ---- MODO CLÁSICO: exactamente lo de siempre ----
                   La app, hasta hoy, ponía `ventas/historial` en pos_sales cuando
                   la nube contestaba (y había permiso / no había cambios
                   pendientes); si no, usaba el pos_sales local. Se replica tal
                   cual para que ningún número cambie. */
                var usarHistorial = hayNube && ctx.puedeSobrescribir;
                var historico = null;
                if (usarHistorial) {
                    historico = await leerHistoricoNube(ctx);
                    if (!historico.ok) {
                        huboErrorNube = true;
                        res.errores.push(historico.error);
                        historico = null;
                    }
                }
                var crudo = null;
                if (!historico) {
                    if (ctx.fuentes.historico) {
                        var iny = await ctx.fuentes.historico(ctx);
                        if (iny && iny.ok !== false) crudo = iny.ventas;
                        else if (iny && iny.ok === false) { huboErrorNube = true; res.errores.push(iny.error || 'historico'); }
                    }
                }
                if (historico) {
                    if (historico.filas.length || !historico.vacio) {
                        var filasC = historico.filas;
                        for (var i1 = 0; i1 < filasC.length; i1++) {
                            var vc = filasC[i1].venta;
                            if (vc && vc.timestamp === undefined && vc.fechaISO) vc.timestamp = vc.fechaISO;
                            agregar(vc, 'historicoCongelado', filasC[i1].nodo, filasC[i1].fechaISO);
                        }
                        res.detalle.historico = filasC.length;
                    }
                } else if (crudo) {
                    var listaC = normalizarLista(crudo);
                    for (var i2 = 0; i2 < listaC.length; i2++) agregar(listaC[i2], 'historicoCongelado', '', '');
                    res.detalle.historico = listaC.length;
                } else {
                    var local = await leerPosSalesLocal(ctx);
                    if (local.ventas.length) {
                        for (var i3 = 0; i3 < local.ventas.length; i3++) agregar(local.ventas[i3], 'locales', '', '');
                        res.detalle.posSales = local.ventas.length;
                    }
                }
                // En clásico no hay operaciones que puedan faltar: se lee lo que
                // siempre se leyó y no se avisa de nada.
                res.completo = true;
            } else {
                /* ---- MODO OPERACIONES: los tres mundos, sin duplicar ---- */
                var ops = null;
                if (typeof ctx.fuentes.ops === 'function') {
                    var inyOps = await ctx.fuentes.ops(ctx);
                    if (inyOps && inyOps.ok !== false) {
                        ops = { ok: true, filas: normalizarFilasInyectadas(inyOps), truncado: !!inyOps.truncado, paginas: 0 };
                    } else {
                        huboErrorNube = true;
                        res.errores.push((inyOps && inyOps.error) || 'ops');
                    }
                } else if (hayNube) {
                    ops = await leerOpsNube(ctx);
                } else if (ctx.db && ctx.emailPath && !ctx.online) {
                    nubeNoConsultada = true;   // sin conexión: no es un error, es un hueco
                }
                if (ops && ops.ok) {
                    fuentesNubeOk++;
                    res.detalle.ops = ops.filas.length;
                    truncado = !!ops.truncado;
                    var filasO = ops.filas;
                    for (var j1 = 0; j1 < filasO.length; j1++) {
                        agregar(filasO[j1].venta, 'ops', filasO[j1].nodo, filasO[j1].fechaISO);
                        var dO = diaDe(filasO[j1].fechaISO || filasO[j1].venta.timestamp);
                        if (dO) { if (dO > ultimoDiaLeido) ultimoDiaLeido = dO; }
                    }
                } else if (ops && !ops.ok) {
                    huboErrorNube = true;
                    res.errores.push(ops.error);
                }

                // 2) El período viejo congelado: solo lo que no esté ya en ops.
                var historico2 = null;
                if (typeof ctx.fuentes.historico === 'function') {
                    var inyH = await ctx.fuentes.historico(ctx);
                    if (inyH && inyH.ok !== false) {
                        historico2 = { ok: true, filas: normalizarFilasInyectadas(inyH), vacio: false };
                    } else {
                        huboErrorNube = true;
                        res.errores.push((inyH && inyH.error) || 'historico');
                    }
                } else if (hayNube) {
                    historico2 = await leerHistoricoNube(ctx);
                }
                if (historico2 && historico2.ok) {
                    fuentesNubeOk++;
                    res.detalle.historico = historico2.filas.length;
                    for (var j2 = 0; j2 < historico2.filas.length; j2++) {
                        agregar(historico2.filas[j2].venta, 'historicoCongelado', historico2.filas[j2].nodo, historico2.filas[j2].fechaISO);
                    }
                } else if (historico2 && !historico2.ok) {
                    huboErrorNube = true;
                    res.errores.push(historico2.error);
                }

                // 3) Lo local: ventana caliente del equipo y pos_sales.
                var caliente = await leerCalienteLocal(ctx);
                if (caliente.ventas.length) {
                    res.detalle.caliente = caliente.ventas.length;
                    for (var j3 = 0; j3 < caliente.ventas.length; j3++) agregar(caliente.ventas[j3], 'locales', '', '');
                }
                var posSales = await leerPosSalesLocal(ctx);
                if (posSales.ventas.length) {
                    res.detalle.posSales = posSales.ventas.length;
                    for (var j4 = 0; j4 < posSales.ventas.length; j4++) agregar(posSales.ventas[j4], 'locales', '', '');
                }

                // 4) ¿Se pudo leer todo?
                if (!ctx.dias && !isNaN(ctx.rango.desdeMs) && !isNaN(ctx.rango.hastaMs)) {
                    truncado = true;   // rango enorme: no se puede prometer nada
                }
                if (huboErrorNube || nubeNoConsultada) {
                    res.completo = false;
                    if (ctx.dias) {
                        res.faltantes = ctx.dias.filter(function (d) { return !diasLocales[d]; });
                    }
                } else if (truncado) {
                    res.completo = false;
                    if (ctx.dias && ultimoDiaLeido) {
                        res.faltantes = ctx.dias.filter(function (d) { return d > ultimoDiaLeido; });
                    } else if (ctx.dias) {
                        res.faltantes = ctx.dias.slice();
                    }
                }
            }

            // ---- Ventas finales, ordenadas y con su fecha normalizada ----
            var ventas = [];
            for (var k = 0; k < orden.length; k++) {
                var entrada = mapa[orden[k]];
                var v = entrada.venta;
                if (!esObjeto(v)) continue;
                if (!v.timestamp && entrada.fechaISO) v.timestamp = entrada.fechaISO;
                v.fechaISO = entrada.fechaISO || v.fechaISO || v.timestamp || '';
                ventas.push(v);
            }
            ventas.sort(compararVentas);

            res.ventas = ventas;
            res.truncado = truncado;
            res.origen = {
                locales: contarFuente(mapa, orden, 'locales'),
                ops: contarFuente(mapa, orden, 'ops'),
                historicoCongelado: contarFuente(mapa, orden, 'historicoCongelado')
            };

            // Si TODOS los orígenes de nube fallaron, esto no es "no había datos":
            // es un error de lectura y se dice (la venta local, si la hay, se
            // devuelve igual para que la pantalla pueda mostrar lo que tiene).
            if (ctx.modo === 'operaciones' && huboErrorNube && fuentesNubeOk === 0) {
                res.ok = false;
                res.error = (res.errores && res.errores.length) ? res.errores[0] : (_ultimoError || 'error-de-lectura');
            }
            if (!res.ok) res.error = res.error || 'error-de-lectura';

            // ---- Caché y estado ----
            _cache = ventas;
            _cacheRango = { desde: isNaN(ctx.rango.desdeMs) ? null : iso(ctx.rango.desdeMs), hasta: isNaN(ctx.rango.hastaMs) ? null : iso(ctx.rango.hastaMs) };
            _ultimoOrigen = res.origen;
            _ultimaLectura = iso(Date.now());
            return res;
        } catch (e) {
            return {
                ok: false,
                ventas: [],
                origen: { locales: 0, ops: 0, historicoCongelado: 0 },
                faltantes: [],
                completo: false,
                truncado: false,
                modo: _modo,
                nodosOpsPorDia: {},
                errores: [anotarError(e, '_leer')],
                error: anotarError(e, '_leer')
            };
        }
    }

    function normalizarFilasInyectadas(inyectado) {
        var filas = [];
        try {
            var lista = normalizarLista(inyectado && inyectado.ventas);
            for (var i = 0; i < lista.length; i++) {
                var v = lista[i];
                if (!esObjeto(v)) continue;
                var nodo = (inyectado && inyectado.nodos && inyectado.nodos[i] !== undefined) ? inyectado.nodos[i] : '';
                filas.push({ venta: clonar(v) || {}, nodo: nodo || '', fechaISO: String(v.fechaISO || v.timestamp || '') });
            }
            // Un mock puede traer pares nodo->venta explícitos.
            if (inyectado && esObjeto(inyectado.porNodo)) {
                filas = [];
                var pares = normalizarPares(inyectado.porNodo);
                for (var j = 0; j < pares.length; j++) {
                    var vv = pares[j].valor;
                    if (!esObjeto(vv)) continue;
                    filas.push({ venta: clonar(vv) || {}, nodo: pares[j].clave, fechaISO: String(vv.fechaISO || vv.timestamp || '') });
                }
            }
        } catch (e) { filas = []; }
        return filas;
    }

    function contarFuente(mapa, orden, fuente) {
        var n = 0;
        for (var i = 0; i < orden.length; i++) {
            if (mapa[orden[i]] && mapa[orden[i]].fuente === fuente) n++;
        }
        return n;
    }

    /* =================================================================
       5. API pública
       ================================================================= */

    /**
     * Lee las ventas de los dos mundos. Devuelve SIEMPRE un objeto:
     * `{ ok, ventas, origen, faltantes, completo, truncado, modo, error }`.
     */
    async function leerVentas(opciones) {
        try {
            var r = await _leer(opciones);
            return {
                ok: r.ok,
                ventas: r.ventas,
                origen: r.origen,
                faltantes: r.faltantes,
                completo: r.completo,
                truncado: r.truncado,
                modo: r.modo,
                error: r.error,
                errores: r.errores
            };
        } catch (e) {
            return {
                ok: false,
                ventas: [],
                origen: { locales: 0, ops: 0, historicoCongelado: 0 },
                faltantes: [],
                completo: false,
                truncado: false,
                modo: _modo,
                error: anotarError(e, 'leerVentas')
            };
        }
    }

    /**
     * Resumen de un día ('AAAA-MM-DD', en la misma clave que `ventas_idx`).
     * Usa el índice del motor cuando existe y está completo; si no, lo
     * recalcula desde las ventas leídas y lo dice con `completo:false`.
     */
    async function resumenDelDia(fecha, opciones) {
        opciones = opciones || {};
        var dia = String(fecha || '').trim().slice(0, 10);
        var res = {
            ok: false, fecha: dia, cantidad: 0, total: 0, totalUSD: 0, porMetodo: {},
            ventas: [], completo: false, indexado: false,
            /* Grupos APARTE de los totales de venta:
               · consumoInterno NO es una venta (no entra en total/totalUSD);
               · porCobrar SÍ es venta (ya está sumada) pero NO está cobrada. */
            consumoInterno: grupoVacio(),
            porCobrar: grupoVacio(),
            origen: { locales: 0, ops: 0, historicoCongelado: 0 }, faltantes: [], error: ''
        };
        try {
            var desdeMs = Date.parse(dia + 'T00:00:00.000Z');
            if (!dia || isNaN(desdeMs)) { res.error = 'fecha-invalida'; return res; }
            var opcionesDia = {};
            for (var k in opciones) { if (Object.prototype.hasOwnProperty.call(opciones, k)) opcionesDia[k] = opciones[k]; }
            opcionesDia.desde = desdeMs;
            opcionesDia.hasta = desdeMs + MS_DIA - 1;

            var ctx = preparar(opcionesDia);
            var lectura = await _leer(opcionesDia);
            res.origen = lectura.origen;
            res.faltantes = lectura.faltantes || [];
            res.ventas = lectura.ventas;
            res.ok = lectura.ok === true;
            if (!res.ok) { res.error = lectura.error || 'error-de-lectura'; return res; }

            var nodosOps = lectura.nodosOpsPorDia[dia] || [];
            var indice = { ok: false, entradas: {}, cantidad: 0 };
            if (nodosOps.length && ctx.usarIndice && ctx.db && ctx.emailPath && ctx.online && !ctx.fuentes.indice) {
                indice = await leerIndiceDia(dia, ctx);
            } else if (nodosOps.length && ctx.usarIndice && typeof ctx.fuentes.indice === 'function') {
                try {
                    var iny = await ctx.fuentes.indice(dia, ctx);
                    if (iny && iny.ok !== false) {
                        var pares = normalizarPares(iny.entradas);
                        for (var i = 0; i < pares.length; i++) {
                            if (esObjeto(pares[i].valor)) indice.entradas[pares[i].clave] = pares[i].valor;
                        }
                        indice.cantidad = Object.keys(indice.entradas).length;
                        indice.ok = indice.cantidad > 0;
                    }
                } catch (e) { indice = { ok: false, entradas: {}, cantidad: 0 }; }
            }

            var indiceCompleto = false;
            if (indice.ok && nodosOps.length) {
                indiceCompleto = Object.keys(indice.entradas).length >= nodosOps.length;
                for (var n = 0; indiceCompleto && n < nodosOps.length; n++) {
                    if (!Object.prototype.hasOwnProperty.call(indice.entradas, nodosOps[n])) indiceCompleto = false;
                }
            }

            if (indiceCompleto) {
                // El índice es la caché derivada del motor: se usa tal cual.
                res.indexado = true;
                res.completo = true;
                for (var c in indice.entradas) {
                    if (!Object.prototype.hasOwnProperty.call(indice.entradas, c)) continue;
                    var e = indice.entradas[c] || {};
                    var total = Number(e.total) || 0;
                    var totalUSD = Number(e.totalUSD);
                    if (!isFinite(totalUSD)) totalUSD = total;
                    var metodo = e.metodo ? String(e.metodo) : 'sin-metodo';
                    /* El índice del motor trae las banderas; el método de pago es la
                       segunda señal (por si el índice es anterior a esta función). */
                    if ((e.consumoInterno === true) || metodo === 'consumo-interno') {
                        sumarGrupo(res.consumoInterno, total, totalUSD);
                        continue;   // FUERA de los totales de venta
                    }
                    if ((e.porCobrar === true) || metodo === 'por-cobrar') {
                        sumarGrupo(res.porCobrar, total, totalUSD);
                    }
                    res.cantidad++;
                    res.total += total;
                    res.totalUSD += totalUSD;
                    if (!res.porMetodo[metodo]) res.porMetodo[metodo] = { cantidad: 0, total: 0, totalUSD: 0 };
                    res.porMetodo[metodo].cantidad++;
                    res.porMetodo[metodo].total += total;
                    res.porMetodo[metodo].totalUSD += totalUSD;
                }
            } else {
                // Sin índice fiable: se recalcula desde las ventas del día.
                res.indexado = false;
                for (var v = 0; v < lectura.ventas.length; v++) {
                    var venta = lectura.ventas[v];
                    var t = totalDeVenta(venta);
                    var u = totalUsdDeVenta(venta);
                    var m = metodoDeVenta(venta);
                    if (esConsumoInterno(venta)) {
                        sumarGrupo(res.consumoInterno, t, u);
                        continue;   // no es una venta: no entra en los totales
                    }
                    if (esPorCobrar(venta)) sumarGrupo(res.porCobrar, t, u);
                    res.cantidad++;
                    res.total += t;
                    res.totalUSD += u;
                    if (!res.porMetodo[m]) res.porMetodo[m] = { cantidad: 0, total: 0, totalUSD: 0 };
                    res.porMetodo[m].cantidad++;
                    res.porMetodo[m].total += t;
                    res.porMetodo[m].totalUSD += u;
                }
                // El índice solo hace falta cuando ese día tuvo operaciones.
                res.completo = (nodosOps.length === 0) && (lectura.completo !== false) && (res.faltantes.length === 0);
            }
            res.total = Math.round(res.total * 100) / 100;
            res.totalUSD = Math.round(res.totalUSD * 100) / 100;
            res.consumoInterno.total = Math.round(res.consumoInterno.total * 100) / 100;
            res.consumoInterno.totalUSD = Math.round(res.consumoInterno.totalUSD * 100) / 100;
            res.porCobrar.total = Math.round(res.porCobrar.total * 100) / 100;
            res.porCobrar.totalUSD = Math.round(res.porCobrar.totalUSD * 100) / 100;
            return res;
        } catch (e) {
            res.ok = false;
            res.error = anotarError(e, 'resumenDelDia');
            return res;
        }
    }

    /**
     * Totales por día del rango, para reportes. Es un agregado derivado de la
     * MISMA lectura (una sola pasada): no vuelve a preguntar a la nube.
     */
    async function resumenRango(desde, hasta, opciones) {
        opciones = opciones || {};
        var res = {
            ok: false, desde: desde || null, hasta: hasta || null,
            dias: [], cantidad: 0, total: 0, totalUSD: 0, porMetodo: {},
            /* Ver resumenDelDia: el consumo interno no es venta (queda fuera de los
               totales) y el fiado es venta, pero se informa aparte por no estar cobrado. */
            consumoInterno: grupoVacio(),
            porCobrar: grupoVacio(),
            origen: { locales: 0, ops: 0, historicoCongelado: 0 }, faltantes: [], completo: false, error: ''
        };
        try {
            var opcionesRango = {};
            for (var k in opciones) { if (Object.prototype.hasOwnProperty.call(opciones, k)) opcionesRango[k] = opciones[k]; }
            opcionesRango.desde = desde;
            opcionesRango.hasta = hasta;

            var ctx = preparar(opcionesRango);
            var lectura = await _leer(opcionesRango);
            res.ok = lectura.ok === true;
            res.origen = lectura.origen;
            res.faltantes = lectura.faltantes || [];
            res.completo = lectura.completo === true && res.faltantes.length === 0;
            if (!res.ok) { res.error = lectura.error || 'error-de-lectura'; return res; }

            var porDia = {};
            for (var i = 0; i < lectura.ventas.length; i++) {
                var venta = lectura.ventas[i];
                var dia = diaDe(venta.fechaISO || venta.timestamp);
                if (!dia) continue;
                if (!porDia[dia]) porDia[dia] = { fecha: dia, cantidad: 0, total: 0, totalUSD: 0, porMetodo: {}, consumoInterno: grupoVacio(), porCobrar: grupoVacio() };
                var d = porDia[dia];
                var t = totalDeVenta(venta);
                var u = totalUsdDeVenta(venta);
                var m = metodoDeVenta(venta);
                if (esConsumoInterno(venta)) {
                    sumarGrupo(res.consumoInterno, t, u);
                    sumarGrupo(d.consumoInterno, t, u);
                    continue;   // no es una venta: fuera de los totales (rango y día)
                }
                if (esPorCobrar(venta)) {
                    sumarGrupo(res.porCobrar, t, u);
                    sumarGrupo(d.porCobrar, t, u);
                }
                d.cantidad++;
                d.total += t;
                d.totalUSD += u;
                res.cantidad++;
                res.total += t;
                res.totalUSD += u;
                if (!d.porMetodo[m]) d.porMetodo[m] = { cantidad: 0, total: 0, totalUSD: 0 };
                d.porMetodo[m].cantidad++;
                d.porMetodo[m].total += t;
                d.porMetodo[m].totalUSD += u;
                if (!res.porMetodo[m]) res.porMetodo[m] = { cantidad: 0, total: 0, totalUSD: 0 };
                res.porMetodo[m].cantidad++;
                res.porMetodo[m].total += t;
                res.porMetodo[m].totalUSD += u;
            }

            var claves = Object.keys(porDia).sort();
            // Los días del rango sin ventas salen a cero (si el rango es razonable).
            if (ctx.dias) {
                for (var j = 0; j < ctx.dias.length; j++) {
                    if (!porDia[ctx.dias[j]]) porDia[ctx.dias[j]] = { fecha: ctx.dias[j], cantidad: 0, total: 0, totalUSD: 0, porMetodo: {}, consumoInterno: grupoVacio(), porCobrar: grupoVacio() };
                }
                claves = ctx.dias.slice();
            }
            for (var c = 0; c < claves.length; c++) {
                var dd = porDia[claves[c]];
                if (!dd) continue;
                dd.total = Math.round(dd.total * 100) / 100;
                dd.totalUSD = Math.round(dd.totalUSD * 100) / 100;
                dd.consumoInterno.total = Math.round(dd.consumoInterno.total * 100) / 100;
                dd.consumoInterno.totalUSD = Math.round(dd.consumoInterno.totalUSD * 100) / 100;
                dd.porCobrar.total = Math.round(dd.porCobrar.total * 100) / 100;
                dd.porCobrar.totalUSD = Math.round(dd.porCobrar.totalUSD * 100) / 100;
                dd.completo = !(res.faltantes || []).length || res.faltantes.indexOf(dd.fecha) === -1;
                res.dias.push(dd);
            }
            res.total = Math.round(res.total * 100) / 100;
            res.totalUSD = Math.round(res.totalUSD * 100) / 100;
            res.consumoInterno.total = Math.round(res.consumoInterno.total * 100) / 100;
            res.consumoInterno.totalUSD = Math.round(res.consumoInterno.totalUSD * 100) / 100;
            res.porCobrar.total = Math.round(res.porCobrar.total * 100) / 100;
            res.porCobrar.totalUSD = Math.round(res.porCobrar.totalUSD * 100) / 100;
            return res;
        } catch (e) {
            res.ok = false;
            res.error = anotarError(e, 'resumenRango');
            return res;
        }
    }

    /** Estado del lector: modo, última lectura, caché y último error. */
    function estado() {
        var dias = {};
        for (var i = 0; i < _cache.length; i++) {
            var d = diaDe(_cache[i] && (_cache[i].fechaISO || _cache[i].timestamp));
            if (d) dias[d] = true;
        }
        return {
            modo: _modo,
            ultimaLectura: _ultimaLectura,
            cacheVentas: _cache.length,           // cuántas ventas hay cacheadas
            cache: { dias: Object.keys(dias).length, desde: _cacheRango.desde, hasta: _cacheRango.hasta },
            origen: _ultimoOrigen,
            error: _ultimoError,
            version: VERSION_LECTOR,
            ventanaCalienteDias: DIAS_VENTANA_CALIENTE
        };
    }

    /* =================================================================
       6. Exposición
       ================================================================= */

    try {
        if (typeof window === 'undefined') return;
        window.lectorVentas = {
            leerVentas: leerVentas,
            resumenDelDia: resumenDelDia,
            resumenRango: resumenRango,
            estado: estado,
            // Apoyo al diagnóstico y a las pruebas (no los usa la pantalla).
            esConsumoInterno: esConsumoInterno,
            esPorCobrar: esPorCobrar,
            totalDeVenta: totalDeVenta,
            totalUsdDeVenta: totalUsdDeVenta,
            metodoDeVenta: metodoDeVenta,
            leerOpsNube: leerOpsNube,
            leerHistoricoNube: leerHistoricoNube,
            leerIndiceDia: leerIndiceDia,
            claveVenta: claveVenta,
            version: VERSION_LECTOR
        };
    } catch (e) { /* sin window no hay nada que exponer */ }
})();
