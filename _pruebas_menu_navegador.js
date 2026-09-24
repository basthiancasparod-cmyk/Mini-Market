/* =====================================================================
   MENÚ EN NAVEGADOR REAL · fase 0 + dinamismo

   Una suite que LLAMA funciones no prueba que la interfaz funcione: hay que pulsar.
   Aquí se siembran datos de verdad en el equipo, se abre menu.html en Chromium y se
   comprueba lo que se ve y lo que pasa al hacer clic:

     1. La franja "Atención hoy" con los números que salen de los datos sembrados.
     2. Las 3 tarjetas con el día real (y ninguna diciendo "Disponible").
     3. La campana: la cuenta SALDADA con abonos ya no aparece como vencida.
     4. Los 4 clics de las fichas: navegan a la pantalla con el filtro puesto.
     5. El cartel de conexión: dice la verdad, también SIN internet.
     6. La maqueta: nada se desborda a 1440 ni a 390 (y no se desplaza de lado).
     7. Cero errores de JavaScript, con un producto A GRANEL en el inventario.

   Se ejecuta con:
     $env:PW_EMAIL_A='<correo>'; $env:PW_PASS_A='<clave>'
     $env:PW_OPER_USER='<usuario>'; $env:PW_OPER_PASS='<clave>'
     node _pruebas_menu_navegador.js
   ===================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RAIZ = __dirname;
const ORIGEN = 'http://127.0.0.1:5500';
const LOG = path.join(RAIZ, '_servidor_menu_pruebas.log');
const CAPTURAS = path.join(RAIZ, 'capturas_menu_pruebas');

const OPC = {
    email: process.env.PW_EMAIL_A || '',
    pass: process.env.PW_PASS_A || '',
    operUser: process.env.PW_OPER_USER || '',
    operPass: process.env.PW_OPER_PASS || '',
    timeout: Number(process.env.PW_TIMEOUT || 120000),
    waitUntil: process.env.PW_WAITUNTIL || 'commit'
};

let ok = 0, fallos = 0;
const ERRORES = [];
const check = (n, c, e = '') => {
    if (c) { ok++; console.log('OK    ' + n); }
    else { fallos++; console.log('FALLA ' + n + (e !== '' ? '  -> ' + e : '')); }
};
const titulo = t => console.log('\n' + t);
const nota = t => console.log('      ' + t);
const esperar = ms => new Promise(r => setTimeout(r, ms));

let NAVEGADOR = null, SERVIDOR = null;

function resolverPlaywright() {
    const c = [];
    if (process.env.PW_PLAYWRIGHT) c.push(process.env.PW_PLAYWRIGHT);
    c.push('playwright');
    c.push(path.join(RAIZ, 'node_modules', 'playwright'));
    c.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright'));
    c.push('C:/Users/FOLGORESB/Desktop/TEA/ruta-tea/node_modules/playwright');
    for (const x of c) { try { const m = require(x); if (m && m.chromium) return m; } catch (e) { } }
    return null;
}
async function responde() {
    try { const r = await fetch(ORIGEN + '/menu.html'); return !!r; } catch (e) { return false; }
}
async function asegurarServidor() {
    titulo('0. Servidor local');
    if (await responde()) { nota('ya había un servidor en ' + ORIGEN); return true; }
    let d = 'ignore';
    try { d = fs.openSync(LOG, 'w'); } catch (e) { }
    SERVIDOR = spawn(process.execPath, [path.join(RAIZ, '_servidor_pruebas.js')],
        { cwd: RAIZ, stdio: ['ignore', d, d], windowsHide: true });
    for (let i = 0; i < 40; i++) { if (await responde()) break; await esperar(250); }
    const listo = await responde();
    check('Servidor local en ' + ORIGEN, listo);
    return listo;
}
async function captura(page, n) {
    try {
        if (!fs.existsSync(CAPTURAS)) fs.mkdirSync(CAPTURAS, { recursive: true });
        await page.screenshot({ path: path.join(CAPTURAS, n + '.png') });
    } catch (e) { }
}
async function entrar(page) {
    await page.goto(ORIGEN + '/index.html?mp=1', { waitUntil: OPC.waitUntil, timeout: OPC.timeout });
    await esperar(2500);
    await page.evaluate(async function () {
        try { if (window.firebase && firebase.auth) await firebase.auth().signOut(); } catch (e) { }
        try { localStorage.removeItem('sesionActiva'); } catch (e) { }
    });
    await page.fill('#email', OPC.email);
    await page.fill('#password', OPC.pass);
    await page.click('#loginButton');
    const limite = Date.now() + OPC.timeout;
    while (Date.now() < limite) {
        await esperar(500);
        if (page.url().indexOf('index.html') === -1) return { ok: true, via: 'navegación' };
        const pide = await page.evaluate(function () {
            const c = document.getElementById('operator-login-container');
            if (!c) return false;
            const r = c.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
        if (pide) {
            await page.fill('#system-username', OPC.operUser);
            await page.fill('#system-password', OPC.operPass);
            await page.click('#operatorLoginButton');
            const l2 = Date.now() + OPC.timeout;
            while (Date.now() < l2) {
                await esperar(500);
                if (page.url().indexOf('index.html') === -1) return { ok: true, via: 'operador' };
            }
            return { ok: false, motivo: 'el login de operador no navegó' };
        }
    }
    return { ok: false, motivo: 'el login no terminó' };
}

/** Siembra el equipo con datos que producen números conocidos. */
function sembrar() {
    const ahora = new Date();
    const hoy = ahora.toISOString().split('T')[0];
    const ayer = new Date(ahora.getTime() - 86400000).toISOString();
    const enHoy = new Date(ahora.getTime() - 3600000).toISOString();   // una hora antes: mismo día UTC salvo borde de medianoche

    localStorage.setItem('ciervo_accounts', JSON.stringify([
        { id: 1, type: 'cobrar', description: 'VENCIDA SIN PAGOS', contact: 'Ana', amount: 50, dueDate: '2020-01-05', category: 'Ventas', payments: [] },
        { id: 2, type: 'cobrar', description: 'YA PAGADA CON ABONOS', contact: 'Beto', amount: 80, dueDate: '2020-01-05', category: 'Ventas', payments: [{ amount: 80, date: '2020-01-06', metodo: 'efectivo' }] },
        { id: 3, type: 'pagar', description: 'VENCE HOY', contact: 'Carlos', amount: 30, dueDate: hoy, category: 'Compras', payments: [] },
        { id: 4, type: 'cobrar', description: 'VENCIDA A MEDIAS', contact: 'Dora', amount: 100, dueDate: '2020-02-05', category: 'Ventas', payments: [{ amount: 40, date: '2020-02-06', metodo: 'efectivo' }] }
    ]));

    // El cuarto producto es A GRANEL, como lo guarda compras.html: cost null y profit 2.
    localStorage.setItem('ciervo_inventory', JSON.stringify([
        { id: 1, name: 'Harina PAN', code: 'A1', stock: 20, minStock: 5, cost: 10, price: 15, profit: 5, margin: 50 },
        { id: 2, name: 'Queso bajo mínimo', code: 'A2', stock: 2, minStock: 5, cost: 4, price: 6, profit: 2, margin: 33 },
        { id: 3, name: 'Agotado del todo', code: 'A3', stock: 0, minStock: 3, cost: 1, price: 2, profit: 1, margin: 100 },
        { id: 4, name: 'A granel', code: 'A4', isBulk: true, unit: 'kg', stock: 1, minStock: 2, cost: null, costPerUnit: 4, price: 7, profit: 2, profitPerUnit: 2, margin: null }
    ]));

    localStorage.setItem('pos_sales', JSON.stringify([
        { id: 'V1', timestamp: enHoy, currency: 'USD', exchangeRate: 40, totals: { total: 30 }, paymentMethod: 'efectivo', items: [] },
        { id: 'V2', timestamp: enHoy, currency: 'VES', exchangeRate: 40, totals: { total: 400 }, paymentMethod: 'efectivo', items: [] },
        { id: 'V3', timestamp: enHoy, currency: 'USD', exchangeRate: 40, totals: { total: 100 }, paymentMethod: 'consumo-interno', consumoInterno: true, items: [] },
        { id: 'V4', timestamp: enHoy, currency: 'USD', exchangeRate: 40, totals: { total: 20 }, paymentMethod: 'por-cobrar', porCobrar: true, items: [] },
        { id: 'V5', timestamp: ayer, currency: 'USD', exchangeRate: 40, totals: { total: 999 }, paymentMethod: 'efectivo', items: [] }
    ]));
    return { hoy: hoy };
}

/** Texto de un elemento (o null si no existe). */
function textoDe(page, id) {
    return page.evaluate(function (elId) {
        const el = document.getElementById(elId);
        return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
    }, id);
}

(async function principal() {
    console.log('=====================================================================');
    console.log(' MENÚ EN NAVEGADOR REAL · ' + ORIGEN + '/menu.html');
    console.log('=====================================================================');

    if (!OPC.email || !OPC.pass || !OPC.operUser || !OPC.operPass) {
        check('Credenciales de prueba definidas', false, 'faltan PW_EMAIL_A, PW_PASS_A, PW_OPER_USER o PW_OPER_PASS');
        process.exit(1);
    }
    if (!(await asegurarServidor())) process.exit(1);
    const pw = resolverPlaywright();
    if (!pw) { check('Playwright disponible', false); process.exit(1); }

    NAVEGADOR = await pw.chromium.launch({ headless: true });
    const contexto = await NAVEGADOR.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await contexto.newPage();
    page.on('pageerror', e => { const t = String(e.message).split('\n')[0]; ERRORES.push(t); console.log('      >>> ERROR DE PÁGINA: ' + t); });
    page.on('console', m => { if (m.type() === 'error') ERRORES.push('console: ' + String(m.text()).slice(0, 140)); });

    const acceso = await entrar(page);
    check('Se entró en la aplicación', acceso.ok === true, JSON.stringify(acceso));

    // Sembrar y abrir el menú con esos datos.
    await page.evaluate(sembrar);
    const abrirMenu = async (etiqueta) => {
        await page.goto(ORIGEN + '/menu.html?mp=' + encodeURIComponent(etiqueta), { waitUntil: OPC.waitUntil, timeout: OPC.timeout });
        await esperar(1200);
        await page.waitForFunction(function () {
            const el = document.getElementById('atencionVencidas');
            return !!el && el.textContent !== '—';
        }, null, { timeout: 20000 }).catch(function () { });
        await esperar(600);
    };
    await abrirMenu('inicio');

    titulo('1. La franja "Atención hoy" con números reales');
    {
        const franja = await page.evaluate(function () {
            return {
                visible: (function () { const e = document.getElementById('atencionHoy'); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; })(),
                vencidas: (document.getElementById('atencionVencidas') || {}).textContent,
                vencidasMonto: (document.getElementById('atencionVencidasMonto') || {}).textContent,
                vencenHoy: (document.getElementById('atencionVencenHoy') || {}).textContent,
                vencenHoyMonto: (document.getElementById('atencionVencenHoyMonto') || {}).textContent,
                sinStock: (document.getElementById('atencionSinStock') || {}).textContent,
                sinStockDetalle: (document.getElementById('atencionSinStockDetalle') || {}).textContent,
                fiados: (document.getElementById('atencionFiados') || {}).textContent,
                fiadosMonto: (document.getElementById('atencionFiadosMonto') || {}).textContent
            };
        });
        nota(JSON.stringify(franja));
        check('La franja está a la vista', franja.visible === true);
        // La cuenta SALDADA con abonos (80 de 80) NO puede contar como vencida.
        check('Cuenta 2 vencidas reales (la pagada con abonos queda fuera)', franja.vencidas === '2', franja.vencidas);
        check('El importe vencido es el SALDO ($50 + $60 = $110.00)', franja.vencidasMonto === '$110.00 por cobrar/pagar', franja.vencidasMonto);
        check('Cuenta 1 que vence hoy', franja.vencenHoy === '1', franja.vencenHoy);
        check('Con su importe ($30.00)', franja.vencenHoyMonto === '$30.00 con vencimiento hoy', franja.vencenHoyMonto);
        check('Cuenta 3 productos con problema (1 agotado + 2 bajo mínimo)', franja.sinStock === '3', franja.sinStock);
        check('Con el desglose exacto', franja.sinStockDetalle === '1 agotado(s) · 2 bajo mínimo', franja.sinStockDetalle);
        check('Cuenta 1 fiado de hoy (la venta por cobrar del POS)', franja.fiados === '1', franja.fiados);
        check('Con su importe ($20.00), y sin contar el consumo interno', franja.fiadosMonto === '$20.00 fiado hoy · este equipo', franja.fiadosMonto);
        await captura(page, 'M1_atencion');
    }

    titulo('2. Las tarjetas dicen el día real (y ninguna dice "Disponible")');
    {
        const tarjetas = await page.evaluate(function () {
            return {
                op: (document.getElementById('estadoOperaciones') || {}).textContent,
                opDatos: (document.getElementById('datosOperaciones') || {}).textContent,
                inv: (document.getElementById('estadoInventario') || {}).textContent,
                invDatos: (document.getElementById('datosInventario') || {}).textContent,
                res: (document.getElementById('estadoResumen') || {}).textContent,
                resDatos: (document.getElementById('datosResumen') || {}).textContent,
                disponibles: (function () {
                    let n = 0;
                    ['operacionesModuleCard', 'inventarioModuleCard', 'salesSummaryModuleCard'].forEach(function (id) {
                        const el = document.getElementById(id);
                        if (el && el.textContent.indexOf('Disponible') !== -1) n++;
                    });
                    return n;
                })()
            };
        });
        nota(JSON.stringify(tarjetas));
        // 3 ventas hoy: 30 USD + 400 Bs/40 + 20 fiado = 60 USD. El consumo interno (100) NO cuenta.
        check('Operaciones: 3 ventas de hoy', tarjetas.op === 'Hoy · 3 venta(s)', tarjetas.op);
        check('Operaciones: $60.00 USD y el fiado aparte (el consumo interno no suma)',
            tarjetas.opDatos === '$60.00 USD en ventas de este equipo · 1 fiado(s)', tarjetas.opDatos);
        check('Inventario: 4 productos, incluido el de granel sin costo', tarjetas.inv === '4 producto(s)', tarjetas.inv);
        check('Inventario: 1 agotado, 2 bajo mínimo y el valor del stock ($319.00)',
            tarjetas.invDatos === '1 agotado(s) · 2 bajo mínimo · valor $319.00', tarjetas.invDatos);
        check('Resumen: $60.00 de hoy', tarjetas.res === 'Hoy · $60.00', tarjetas.res);
        check('Resumen: 3 tickets y ticket medio $20.00',
            tarjetas.resDatos === '3 ticket(s) de este equipo · ticket medio $20.00', tarjetas.resDatos);
        check('NINGUNA de las 3 tarjetas dice "Disponible"', tarjetas.disponibles === 0, 'dicen Disponible: ' + tarjetas.disponibles);
    }

    titulo('3. El centro de notificaciones: se abre, dice la verdad y lleva a resolverlo');
    {
        await page.click('#botonNotificaciones');
        await esperar(800);
        const panel = await page.evaluate(function () {
            const p = document.getElementById('notificationPanel');
            const lista = document.getElementById('notificationList');
            const badge = document.getElementById('notificationBadge');
            const boton = document.getElementById('botonNotificaciones');
            const filas = Array.from(document.querySelectorAll('#notificationList .notification-item'));
            const b = p.getBoundingClientRect();
            return {
                abierto: p.hidden === false,
                aria: boton.getAttribute('aria-expanded'),
                etiquetaBoton: boton.getAttribute('aria-label'),
                texto: lista ? lista.textContent.replace(/\s+/g, ' ').trim() : '',
                badge: badge ? badge.textContent.trim() : '',
                badgeOculto: badge ? badge.hidden : null,
                filas: filas.length,
                sonBotones: filas.every(function (f) { return f.tagName === 'BUTTON'; }),
                altos: filas.map(function (f) { return Math.round(f.getBoundingClientRect().height); }),
                grupos: Array.from(document.querySelectorAll('#notificationList .aviso-grupo-titulo')).map(function (g) { return g.textContent.trim(); }),
                dentroDeLaPantalla: b.left >= 0 && b.right <= document.documentElement.clientWidth + 1,
                cuelgaDeLaCampana: b.top >= Math.round(boton.getBoundingClientRect().bottom) - 1,
                titulo: (document.getElementById('tituloNotificaciones') || {}).textContent
            };
        });
        nota('panel: ' + JSON.stringify({ badge: panel.badge, filas: panel.filas, grupos: panel.grupos, titulo: panel.titulo }));
        check('La campana abre el panel y lo anuncia', panel.abierto === true && panel.aria === 'true');
        check('Los avisos son BOTONES (cada uno lleva a resolverlo)', panel.sonBotones === true && panel.filas === 7, 'filas=' + panel.filas);
        check('Se agrupan con su contador: Cobros 3 · Inventario 3 · Mantenimiento 1',
            JSON.stringify(panel.grupos) === JSON.stringify(['Cobros y pagos (3)', 'Inventario (3)', 'Mantenimiento (1)']),
            JSON.stringify(panel.grupos));
        check('El contador se anuncia también con texto, no solo con el número',
            String(panel.etiquetaBoton).indexOf('7 pendiente') !== -1, String(panel.etiquetaBoton));
        check('La cuenta vencida de verdad aparece', panel.texto.indexOf('VENCIDA SIN PAGOS') !== -1);
        check('La cuenta YA PAGADA con abonos NO aparece', panel.texto.indexOf('YA PAGADA CON ABONOS') === -1);
        check('El aviso muestra el SALDO ($60.00) y no el importe total ($100.00)',
            panel.texto.indexOf('$60.00') !== -1 && panel.texto.indexOf('$100.00') === -1, panel.texto.slice(0, 220));
        check('Cada aviso es cómodo de pulsar (44 px o más)', panel.altos.every(function (h) { return h >= 44; }), JSON.stringify(panel.altos));
        check('El panel cuelga de la campana y no se sale de la pantalla',
            panel.cuelgaDeLaCampana === true && panel.dentroDeLaPantalla === true);
        check('Y el aviso de copia de seguridad sale de un dato real (nunca se ha copiado)',
            panel.texto.indexOf('Copia de seguridad: nunca') !== -1);
        await captura(page, 'M2_centro_notificaciones');

        // Escape y el botón de cerrar.
        await page.keyboard.press('Escape');
        await esperar(300);
        check('Escape cierra el centro de notificaciones',
            await page.evaluate(function () { return document.getElementById('notificationPanel').hidden; }));
        await page.click('#botonNotificaciones');
        await esperar(400);
        await page.click('.aviso-cerrar');
        await esperar(300);
        check('Su botón de cerrar también lo cierra',
            await page.evaluate(function () { return document.getElementById('notificationPanel').hidden; }));

        // Un clic en un aviso lleva a ESA cuenta (enlace profundo), no a una lista genérica.
        await page.click('#botonNotificaciones');
        await esperar(500);
        await page.click('#notificationList .notification-item');
        await esperar(2000);
        check('Pulsar el aviso vencido abre ESA cuenta en cuentas.html',
            page.url().indexOf('cuentas.html') !== -1 && page.url().indexOf('id=1') !== -1 && page.url().indexOf('tipo=cobrar') !== -1,
            page.url());

        // Un aviso de INVENTARIO abre el inventario EN EL PRODUCTO (era la queja del usuario).
        await abrirMenu('avisos-inventario');
        await page.click('#botonNotificaciones');
        await esperar(500);
        await page.evaluate(function () {
            const filas = Array.from(document.querySelectorAll('#notificationList .notification-item'));
            const objetivo = filas.filter(function (f) { return f.textContent.indexOf('Agotado del todo') !== -1; })[0];
            if (objetivo) objetivo.click();
        });
        await esperar(2500);
        check('Pulsar un aviso de inventario abre ESE producto (no la lista entera)',
            page.url().indexOf('inventario.html?id=3') !== -1, page.url());

        const producto = await page.evaluate(function () {
            const filas = Array.from(document.querySelectorAll('#inventoryTableBody tr'));
            const primera = filas[0];
            const buscador = document.getElementById('searchInput');
            return {
                filas: filas.length,
                id: primera ? primera.getAttribute('data-product-id') : null,
                destacada: primera ? primera.classList.contains('fila-destacada') : null,
                buscador: buscador ? buscador.value : null,
                textoFila: primera ? primera.textContent.replace(/\s+/g, ' ').trim().slice(0, 50) : null
            };
        });
        nota('inventario con el enlace profundo: ' + JSON.stringify(producto));
        check('La tabla queda filtrada en ESE producto', producto.filas === 1 && producto.id === '3', JSON.stringify(producto));
        check('…y la fila queda marcada (se ve cuál es)', producto.destacada === true, JSON.stringify(producto));
        check('…y el buscador muestra por qué está filtrada (su código)', producto.buscador === 'A3', String(producto.buscador));
        check('Todo listo para trabajar con él, no para buscarlo a mano',
            String(producto.textoFila || '').indexOf('Agotado del todo') !== -1, String(producto.textoFila));
        await captura(page, 'M10_producto_destacado');

        // Un cambio de tasa AUTOMÁTICO aparece como aviso (lo que pidió el usuario).
        await page.evaluate(function () {
            const ahora = Date.now();
            localStorage.setItem('pos_rate_source', 'bcv');
            localStorage.setItem('pos_rate_history', JSON.stringify({
                bcv: [{ t: ahora - 2 * 86400000, v: 36.5 }, { t: ahora - 3600000, v: 38.2 }]
            }));
        });
        await abrirMenu('avisos-tasa');
        await page.click('#botonNotificaciones');
        await esperar(700);
        const tasa = await page.evaluate(function () {
            const filas = Array.from(document.querySelectorAll('#notificationList .notification-item'));
            const objetivo = filas.filter(function (f) { return f.textContent.indexOf('tasa') !== -1; })[0] || null;
            return {
                filas: filas.length,
                badge: document.getElementById('notificationBadge').textContent,
                texto: objetivo ? objetivo.textContent.replace(/\s+/g, ' ').trim() : '',
                clic: objetivo ? (objetivo.getAttribute('onclick') || '') : '',
                grupos: Array.from(document.querySelectorAll('#notificationList .aviso-grupo-titulo')).map(function (g) { return g.textContent.trim(); })
            };
        });
        nota('aviso de tasa: ' + JSON.stringify({ badge: tasa.badge, grupos: tasa.grupos, texto: tasa.texto }));
        check('El cambio de tasa automático aparece como aviso',
            tasa.texto.indexOf('36,50') !== -1 && tasa.texto.indexOf('38,20') !== -1 && tasa.texto.indexOf('subió') !== -1,
            tasa.texto);
        check('…diciendo que fue automática y de qué fuente',
            tasa.texto.indexOf('automáticamente') !== -1 && tasa.texto.indexOf('BCV') !== -1, tasa.texto);
        check('…en su propio grupo, sumando al contador (8)',
            tasa.grupos.indexOf('Tasa del día (1)') !== -1 && tasa.badge === '8',
            JSON.stringify(tasa.grupos) + ' badge=' + tasa.badge);
        check('…y lleva al POS a verla', tasa.clic.indexOf('mini_market_pos.html') !== -1, tasa.clic);
        await captura(page, 'M11_aviso_tasa');

        // Se limpia la tasa sembrada para que la prueba del estado vacío siga siendo válida.
        await page.evaluate(function () {
            localStorage.removeItem('pos_rate_history');
            localStorage.removeItem('pos_rate_source');
        });

        // Estado vacío honesto: sin datos de negocio y con copia hecha hoy, no hay avisos.
        await page.evaluate(function () {
            localStorage.removeItem('ciervo_accounts');
            localStorage.removeItem('ciervo_inventory');
            localStorage.removeItem('pos_sales');
            localStorage.setItem('respaldoHecho', new Date().toISOString());
        });
        await abrirMenu('avisos-vacio');
        await page.click('#botonNotificaciones');
        await esperar(700);
        const vacio = await page.evaluate(function () {
            const p = document.getElementById('notificationPanel');
            const badge = document.getElementById('notificationBadge');
            return {
                filas: document.querySelectorAll('#notificationList .notification-item').length,
                texto: p.textContent.replace(/\s+/g, ' ').trim(),
                badgeOculto: badge.hidden,
                etiqueta: document.getElementById('botonNotificaciones').getAttribute('aria-label'),
                titulo: (document.getElementById('tituloNotificaciones') || {}).textContent
            };
        });
        nota('sin datos: ' + JSON.stringify({ filas: vacio.filas, titulo: vacio.titulo, etiqueta: vacio.etiqueta }));
        check('Sin nada pendiente no hay avisos y el contador se oculta',
            vacio.filas === 0 && vacio.badgeOculto === true, JSON.stringify(vacio));
        check('…y se dice qué se vigila, en vez de dejar el panel en blanco',
            vacio.texto.indexOf('Todo al día') !== -1 && vacio.texto.indexOf('tasa del día') !== -1);
        check('…y el botón lo anuncia sin contador',
            vacio.titulo === 'Notificaciones' && String(vacio.etiqueta).indexOf('nada pendiente') !== -1);
        await captura(page, 'M9_avisos_vacio');
        await page.evaluate(function () { localStorage.removeItem('respaldoHecho'); });
    }

/* ------------------------------------------------------------------ */

    titulo('4. Los 4 clics de las fichas: llevan a la pantalla con el filtro puesto');
    {
        const destinos = [
            { ficha: 'fichaVencidas', esperado: 'cuentas.html', filtro: 'estado=overdue' },
            { ficha: 'fichaVencenHoy', esperado: 'cuentas.html', filtro: 'estado=pending&orden=vencimiento' },
            { ficha: 'fichaSinStock', esperado: 'inventario.html', filtro: '' },
            { ficha: 'fichaFiados', esperado: 'cuentas.html', filtro: 'origen=pos' }
        ];
        for (const d of destinos) {
            await abrirMenu('clic-' + d.ficha);
            await page.evaluate(function (id) {
                const el = document.getElementById(id);
                if (el) el.click();
            }, d.ficha);
            await esperar(1800);
            const url = page.url();
            const bien = url.indexOf(d.esperado) !== -1 && (d.filtro === '' || url.indexOf(d.filtro) !== -1);
            check('La ficha «' + d.ficha + '» abre ' + d.esperado + (d.filtro ? ' con ' + d.filtro : ''), bien, url);
        }
    }

    titulo('5. El cartel de conexión dice la verdad (también sin internet)');
    {
        await abrirMenu('conexion');
        const conRed = await textoDe(page, 'syncText');
        const malo = await page.evaluate(function () {
            // Ojo: el texto de los <script> en línea también cuelga de body.textContent,
            // así que se miran solo elementos con texto visible.
            return Array.from(document.querySelectorAll('body *')).some(function (el) {
                if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
                if (el.childElementCount > 0) return false;
                const b = el.getBoundingClientRect();
                return b.width > 0 && b.height > 0 && el.textContent.indexOf('Datos sincronizados') !== -1;
            });
        });
        check('Con red, el cartel NO afirma que todo está sincronizado', conRed !== 'Datos sincronizados', conRed);
        check('…y en toda la página no queda ningún "Datos sincronizados"', malo === false);

        await contexto.setOffline(true);
        await page.evaluate(function () { window.dispatchEvent(new Event('offline')); });
        await esperar(2500);
        const sinRed = await page.evaluate(function () {
            const dot = document.getElementById('syncDot');
            return {
                texto: (document.getElementById('syncText') || {}).textContent,
                color: dot ? getComputedStyle(dot).backgroundColor : null,
                estado: document.getElementById('syncIndicator').getAttribute('data-estado'),
                titulo: document.getElementById('syncIndicator').getAttribute('title')
            };
        });
        nota('sin internet: ' + JSON.stringify(sinRed));
        check('SIN internet el cartel lo dice', sinRed.texto === 'Sin internet', sinRed.texto);
        check('…con el color rojo canónico', sinRed.color === 'rgb(239, 68, 68)', String(sinRed.color));
        check('…y el estado queda marcado', sinRed.estado === 'sin-red', String(sinRed.estado));
        check('…con el texto largo del módulo en el title',
            String(sinRed.titulo || '').indexOf('Sin internet') === 0, String(sinRed.titulo));
        await captura(page, 'M3_sin_internet');

        await contexto.setOffline(false);
        await page.evaluate(function () { window.dispatchEvent(new Event('online')); });
        await esperar(2500);
        const vuelta = await textoDe(page, 'syncText');
        check('Al volver la red, deja de decir que no hay internet', vuelta !== 'Sin internet', vuelta);
    }

    titulo('6. La maqueta: nada se desborda');
    {
        for (const ancho of [1440, 390]) {
            await page.setViewportSize({ width: ancho, height: 900 });
            await abrirMenu('ancho-' + ancho);
            const m = await page.evaluate(function () {
                window.scrollTo(200, 0);
                const x = window.scrollX;
                window.scrollTo(0, 0);
                return {
                    scrollWidth: document.documentElement.scrollWidth,
                    clientWidth: document.documentElement.clientWidth,
                    desplazamientoLateral: x
                };
            });
            nota(ancho + ' px -> ' + JSON.stringify(m));
            check('A ' + ancho + ' px el documento no es más ancho que la ventana',
                m.scrollWidth <= m.clientWidth + 1, m.scrollWidth + ' > ' + m.clientWidth);
            check('A ' + ancho + ' px no se puede desplazar de lado', m.desplazamientoLateral === 0, String(m.desplazamientoLateral));
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await abrirMenu('final');
        await captura(page, 'M4_escritorio');
        await page.setViewportSize({ width: 390, height: 900 });
        await abrirMenu('final-movil');
        await captura(page, 'M5_movil');
    }

    titulo('7. Diseño medido: la cabecera y el contenido, y el teclado');
    {
        for (const ancho of [1440, 768, 390]) {
            await page.setViewportSize({ width: ancho, height: 900 });
            await abrirMenu('diseno-' + ancho);
            const m = await page.evaluate(function () {
                const izq = sel => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().left) : null; };
                const sinFoco = [];
                document.querySelectorAll('[onclick]').forEach(function (el) {
                    const b = el.getBoundingClientRect();
                    if (b.width === 0 || b.height === 0) return;
                    if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.hasAttribute('tabindex')) return;
                    sinFoco.push(el.id || el.tagName);
                });
                const tarjeta = document.getElementById('operacionesModuleCard');
                tarjeta.focus();
                return {
                    marca: izq('.brand-icon'), franja: izq('#atencionHoy'),
                    tarjeta: izq('#operacionesModuleCard'), accesos: izq('.secondary-list'),
                    sinFoco: sinFoco,
                    enfocada: document.activeElement === tarjeta,
                    role: tarjeta.getAttribute('role'), tabindex: tarjeta.getAttribute('tabindex')
                };
            });
            nota(ancho + ' px -> ' + JSON.stringify(m));
            check('A ' + ancho + ' px la cabecera y el contenido arrancan en la misma vertical',
                m.marca !== null && m.marca === m.franja && m.marca === m.tarjeta && m.marca === m.accesos,
                'marca=' + m.marca + ' franja=' + m.franja + ' tarjeta=' + m.tarjeta + ' accesos=' + m.accesos);
            check('A ' + ancho + ' px ningún elemento pulsable se queda sin teclado',
                m.sinFoco.length === 0, JSON.stringify(m.sinFoco));
            check('A ' + ancho + ' px el módulo se enfoca de verdad y se anuncia como botón',
                m.enfocada === true && m.role === 'button' && m.tabindex === '0',
                JSON.stringify({ enfocada: m.enfocada, role: m.role, tabindex: m.tabindex }));
        }

        // El correo del DUEÑO: en un panel desplegable, para que el header no crezca.
        await page.setViewportSize({ width: 1440, height: 900 });   // el bucle terminó a 390
        await abrirMenu('cabecera');
        const compacto = await page.evaluate(function () {
            const info = document.getElementById('userInfo');
            const panel = document.getElementById('userPanel');
            const header = document.querySelector('.top-bar');
            return {
                altoHeader: Math.round(header.getBoundingClientRect().height),
                anchoInfo: Math.round(info.getBoundingClientRect().width),
                panelOculto: panel.hidden,
                panelVisible: panel.getBoundingClientRect().width > 0,
                aria: info.getAttribute('aria-expanded'),
                nombre: (document.getElementById('user-name') || {}).textContent,
                rol: (document.getElementById('user-role') || {}).textContent,
                correo: (document.getElementById('user-email') || {}).textContent
            };
        });
        nota('header en reposo: ' + JSON.stringify(compacto));
        /* El alto del header NO cambia (83 px). El bloque de usuario pasa de 152 a ~178 px
           por el chevron que avisa de que se puede desplegar; el correo ya no ocupa sitio. */
        check('El header sigue igual de alto y el correo no ocupa sitio',
            compacto.altoHeader === 83 && compacto.anchoInfo <= 185,
            'alto=' + compacto.altoHeader + ' anchoBloque=' + compacto.anchoInfo);
        check('El correo NO ocupa sitio hasta que se pide (panel cerrado)',
            compacto.panelOculto === true && compacto.panelVisible === false && compacto.aria === 'false',
            JSON.stringify(compacto));

        await page.click('#userInfo');
        await esperar(400);
        const abierto = await page.evaluate(function () {
            const panel = document.getElementById('userPanel');
            const b = panel.getBoundingClientRect();
            const disparador = document.getElementById('userInfo').getBoundingClientRect();
            return {
                visible: b.width > 0 && b.height > 0,
                correo: (document.getElementById('user-email') || {}).textContent.trim(),
                aria: document.getElementById('userInfo').getAttribute('aria-expanded'),
                dentroDeLaPantalla: b.left >= 0 && b.right <= document.documentElement.clientWidth + 1,
                // Cuelga del BLOQUE de usuario (no del header): no debe taparlo.
                cuelgaDelBloque: b.top >= Math.round(disparador.bottom) - 1,
                botonCopiar: !document.getElementById('copiarCorreoDueno').hidden
            };
        });
        nota('panel abierto: ' + JSON.stringify(abierto));
        check('Al pulsar el bloque de usuario se despliega el CORREO DEL DUEÑO',
            abierto.visible === true && abierto.correo === OPC.email && abierto.aria === 'true',
            JSON.stringify(abierto));
        check('El panel cuelga debajo del bloque de usuario y no se sale de la pantalla',
            abierto.dentroDeLaPantalla === true && abierto.cuelgaDelBloque === true, JSON.stringify(abierto));
        check('Con correo, se ofrece copiarlo', abierto.botonCopiar === true);
        await captura(page, 'M8_panel_usuario');

        // Copiar no debe cerrar el panel (la propagación se corta).
        await page.click('#copiarCorreoDueno');
        await esperar(400);
        check('Pulsar «Copiar correo» no cierra el panel',
            await page.evaluate(function () { return !document.getElementById('userPanel').hidden; }));

        await page.keyboard.press('Escape');
        await esperar(300);
        check('Escape cierra el panel',
            await page.evaluate(function () { return document.getElementById('userPanel').hidden; }));

        // Teclado: el bloque de usuario se enfoca y se abre con Enter.
        const conTeclado = await page.evaluate(function () {
            const info = document.getElementById('userInfo');
            info.focus();
            return { enfocado: document.activeElement === info, role: info.getAttribute('role'), tabindex: info.getAttribute('tabindex') };
        });
        await page.keyboard.press('Enter');
        await esperar(400);
        const abiertoConTeclado = await page.evaluate(function () { return !document.getElementById('userPanel').hidden; });
        check('El bloque de usuario se enfoca y se abre con Enter',
            conTeclado.enfocado === true && conTeclado.role === 'button' && conTeclado.tabindex === '0' && abiertoConTeclado === true,
            JSON.stringify(conTeclado) + ' abierto=' + abiertoConTeclado);

        // Clic fuera: se cierra.
        await page.mouse.click(20, 400);
        await esperar(300);
        check('Un clic fuera cierra el panel',
            await page.evaluate(function () { return document.getElementById('userPanel').hidden; }));

        // Las 4 tarjetas, entre los módulos y los accesos (posiciones reales en pantalla).
        const orden = await page.evaluate(function () {
            const abajo = el => el ? Math.round(el.getBoundingClientRect().bottom) : null;
            const arriba = el => el ? Math.round(el.getBoundingClientRect().top) : null;
            return {
                finModulos: abajo(document.querySelector('.modules-grid')),
                inicioFranja: arriba(document.getElementById('atencionHoy')),
                finFranja: abajo(document.getElementById('atencionHoy')),
                inicioAccesos: arriba(document.querySelector('.secondary-modules'))
            };
        });
        nota('orden en pantalla: ' + JSON.stringify(orden));
        check('Las 4 tarjetas de atención quedan ENTRE los módulos y los accesos',
            orden.inicioFranja >= orden.finModulos - 1 && orden.finFranja <= orden.inicioAccesos + 1,
            JSON.stringify(orden));

        // «Personalizar» como enlace subrayado (sin recuadro), pero pulsable.
        const enlace = await page.evaluate(function () {
            const b = document.getElementById('botonPersonalizar');
            const cs = getComputedStyle(b);
            return {
                decoracion: cs.textDecorationLine, fondo: cs.backgroundColor,
                borde: cs.borderTopWidth, alto: Math.round(b.getBoundingClientRect().height),
                etiqueta: b.tagName
            };
        });
        nota('el control de personalizar: ' + JSON.stringify(enlace));
        check('«Personalizar» se ve como enlace subrayado, no como recuadro',
            enlace.decoracion.indexOf('underline') !== -1 &&
            (enlace.fondo === 'rgba(0, 0, 0, 0)' || enlace.fondo === 'transparent') &&
            enlace.borde === '0px', JSON.stringify(enlace));
        check('…y sigue siendo un botón cómodo de pulsar (44 px de alto)',
            enlace.etiqueta === 'BUTTON' && enlace.alto >= 44, JSON.stringify(enlace));

        await page.setViewportSize({ width: 1440, height: 900 });
    }

    titulo('8. Personalizar accesos: reordenar, ocultar, recordar y restablecer');
    {
        const leerOrden = () => page.evaluate(function () {
            const ids = [];
            document.querySelectorAll('.secondary-list').forEach(function (lista) {
                Array.prototype.slice.call(lista.children).forEach(function (n) { if (n.id) ids.push(n.id); });
            });
            return ids;
        });
        await abrirMenu('personalizar');
        const ordenInicial = await leerOrden();
        nota('orden inicial: ' + JSON.stringify(ordenInicial));
        check('El menú trae sus 8 accesos en el orden del archivo', ordenInicial.length === 8, JSON.stringify(ordenInicial));

        await page.click('#botonPersonalizar');
        await esperar(400);
        const modo = await page.evaluate(function () {
            const controles = document.querySelectorAll('.editar-acceso button');
            const visibles = Array.from(controles).filter(function (b) {
                const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0;
            }).length;
            return {
                activo: document.body.classList.contains('modo-personalizar'),
                aria: document.getElementById('botonPersonalizar').getAttribute('aria-pressed'),
                controles: controles.length, visibles: visibles
            };
        });
        check('«Personalizar» enciende el modo y pone controles en los 11 accesos (33 botones)',
            modo.activo === true && modo.aria === 'true' && modo.controles === 33 && modo.visibles === 33,
            JSON.stringify(modo));
        await captura(page, 'M6_modo_personalizar');

        const urlAntes = page.url();
        await page.click('[data-accion="subir"][data-objetivo="userManagementItem"]');
        await esperar(600);
        const ordenTrasSubir = await leerOrden();
        check('Pulsar ↑ mueve el acceso y NO abre nada',
            page.url() === urlAntes && ordenTrasSubir[0] === 'userManagementItem',
            'url=' + page.url() + ' orden=' + JSON.stringify(ordenTrasSubir.slice(0, 3)));

        await page.click('[data-accion="ocultar"][data-objetivo="providersItem"]');
        await esperar(400);
        await page.click('#botonPersonalizar');
        await esperar(400);
        const oculto = await page.evaluate(function () {
            const el = document.getElementById('providersItem');
            const b = el.getBoundingClientRect();
            let clave = null;
            try { clave = JSON.parse(localStorage.getItem('ciervo_menu_disposicion') || 'null'); } catch (e) { }
            return { hidden: el.hidden, visible: b.width > 0 && b.height > 0, clave: clave };
        });
        check('Ocultar un acceso lo quita de la vista al salir del modo',
            oculto.hidden === true && oculto.visible === false, JSON.stringify(oculto));
        check('…y queda guardado en el equipo (orden + ocultos)',
            !!oculto.clave && oculto.clave.ocultos.indexOf('providersItem') !== -1 &&
            oculto.clave.orden.indexOf('userManagementItem') !== -1 &&
            oculto.clave.orden.indexOf('userManagementItem') < oculto.clave.orden.indexOf('catalogItem'),
            JSON.stringify(oculto.clave));

        await abrirMenu('personalizar-2');
        const persistido = await page.evaluate(function () {
            const ids = [];
            document.querySelectorAll('.secondary-list').forEach(function (l) {
                Array.prototype.slice.call(l.children).forEach(function (n) { if (n.id) ids.push(n.id); });
            });
            return { hidden: document.getElementById('providersItem').hidden, primero: ids[0] };
        });
        check('Al recargar, el menú recuerda el orden y lo oculto',
            persistido.hidden === true && persistido.primero === 'userManagementItem',
            JSON.stringify(persistido));
        await captura(page, 'M7_personalizado');

        await page.click('#botonRestablecer');
        await esperar(600);
        const restablecido = await leerOrden();
        const claveBorrada = await page.evaluate(function () { return localStorage.getItem('ciervo_menu_disposicion'); });
        check('«Restablecer» devuelve el orden del archivo y borra lo guardado',
            JSON.stringify(restablecido) === JSON.stringify(ordenInicial) && !claveBorrada,
            JSON.stringify(restablecido) + ' · clave=' + claveBorrada);

        await page.evaluate(function () {
            sessionStorage.setItem('currentUser', JSON.stringify({ username: 'v', role: 'Vendedor', firstName: 'V', lastName: 'D' }));
        });
        await abrirMenu('personalizar-vendedor');
        const vendedor = await page.evaluate(function () {
            const b = document.getElementById('botonPersonalizar');
            return { oculto: b.hidden, ancho: Math.round(b.getBoundingClientRect().width) };
        });
        check('Con rol Vendedor no se ofrece personalizar el menú',
            vendedor.oculto === true && vendedor.ancho === 0, JSON.stringify(vendedor));
        await page.evaluate(function () { sessionStorage.removeItem('currentUser'); });
    }

    titulo('9. Errores de JavaScript (con un producto A GRANEL en el inventario)');
    {
        const unicos = Array.from(new Set(ERRORES));
        check('La página no lanzó NINGÚN error de JavaScript', unicos.length === 0, unicos.slice(0, 4).join(' || '));
    }

    console.log('\n=====================================================================');
    console.log('RESUMEN: ' + ok + ' OK · ' + fallos + ' FALLA');
    console.log('=====================================================================');
    console.log('Capturas en: ' + CAPTURAS);
    try { await NAVEGADOR.close(); } catch (e) { }
    if (SERVIDOR) { try { SERVIDOR.kill(); } catch (e) { } }
    process.exit(fallos ? 1 : 0);
})();
