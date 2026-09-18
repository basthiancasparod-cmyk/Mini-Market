/**
 * Pruebas de sesion.js: el control que exige sesión antes de que las páginas toquen la base.
 * Se ejecuta en un contexto simulado (nada de red ni navegador real).
 */
const fs = require('fs');
const vm = require('vm');

const codigo = fs.readFileSync('sesion.js', 'utf8');

let ok = 0, fallos = 0;
const check = (n, c, extra = '') => { if (c) { ok++; console.log('OK    ' + n); } else { fallos++; console.log('FALLA ' + n + (extra ? ' -> ' + extra : '')); } };
// El aviso de "Sesión no activa" se muestra 900 ms antes de redirigir
const esperarRedireccion = () => new Promise((r) => setTimeout(r, 1000));
const eq = (n, a, b) => check(n, a === b, `esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)}`);

// Arma un contexto simulando una página
function montar({ usuario = null, perfil = null, conInitFirebase = true, conSDK = true, tokenSesion = null, marca = true, rutaEnPestana = true } = {}) {
    const registro = { redirects: [], llamadas: [], eventos: [] };
    // sessionStorage: lo que tenga la pestaña (el navegador lo COPIA a pestañas nuevas)
    const almacen = Object.assign({}, tokenSesion || {});
    if (rutaEnPestana && !('propietarioActual' in almacen)) almacen.propietarioActual = 'jefe@negocio.com';
    // localStorage: aquí vive la marca de sesión compartida por TODAS las pestañas
    const almacenLocal = { darkMode: 'true' };
    if (marca) almacenLocal.sesionActiva = JSON.stringify({ email: 'jefe@negocio.com', uid: 'uid1' });
    const oyentes = { DOMContentLoaded: [] };
    const avisos = [];

    const documento = {
        addEventListener: (tipo, fn, captura) => { (oyentes[tipo] = oyentes[tipo] || []).push({ fn, captura }); },
        dispatchEvent: (evento) => {
            registro.eventos.push(evento.type);
            // Igual que el navegador: la fase de captura corre primero y puede frenar el resto
            const lista = (oyentes[evento.type] || []).slice().sort((a, b) => (b.captura ? 1 : 0) - (a.captura ? 1 : 0));
            for (const oyente of lista) { oyente.fn(evento); if (evento._frenado) break; }
            return true;
        },
        createElement: () => ({ setAttribute: () => {}, innerHTML: '' }),
        body: { appendChild: (nodo) => avisos.push(nodo) },
        readyState: 'loading'
    };

    const db = { ref: () => ({ once: async () => ({ val: () => perfil }) }) };
    const firebase = conSDK ? {
        auth: () => ({
            currentUser: usuario,
            onAuthStateChanged: (cb) => {
                registro.llamadas.push('onAuthStateChanged');
                setTimeout(() => cb(usuario), 0);
            }
        }),
        database: () => db
    } : undefined;

    const ctx = {
        window: { location: { replace: (u) => registro.redirects.push(u), href: '' } },
        document: documento,
        sessionStorage: {
            getItem: (k) => (k in almacen ? almacen[k] : null),
            setItem: (k, v) => { almacen[k] = String(v); },
            removeItem: (k) => { delete almacen[k]; },
            clear: () => { Object.keys(almacen).forEach((k) => delete almacen[k]); }
        },
        localStorage: {
            getItem: (k) => (k in almacenLocal ? almacenLocal[k] : null),
            setItem: (k, v) => { almacenLocal[k] = String(v); },
            removeItem: (k) => { delete almacenLocal[k]; }
        },
        firebase,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        setTimeout, clearTimeout, Promise, Object, Array, JSON, Date,
        Event: class {
            constructor(tipo) { this.type = tipo; this._frenado = false; }
            stopImmediatePropagation() { this._frenado = true; }
            stopPropagation() { this._frenado = true; }
            preventDefault() {}
        }
    };
    ctx.window.window = ctx.window;
    ctx.window.firebase = firebase;
    if (conInitFirebase) {
        ctx.window.initFirebase = async function () {
            registro.llamadas.push('initFirebase-original');
            return db;
        };
        ctx.initFirebase = ctx.window.initFirebase;
    }
    vm.createContext(ctx);
    vm.runInContext(codigo, ctx);
    return { ctx, registro, almacen, almacenLocal, db, oyentes, documento, avisos };
}

(async () => {
    console.log('=== 1. Pestaña nueva sin nada: debe mandar al login ===');
    let t = montar({ usuario: null, marca: false, rutaEnPestana: false });
    await t.ctx.window.sesionLista.catch(() => {});
    await esperarRedireccion();
    eq('Redirige a index.html', t.registro.redirects[0], 'index.html');
    eq('Muestra el aviso visible de "Sesión no activa"', t.avisos.length, 1);
    eq('Limpia el almacenamiento de la pestaña', Object.keys(t.almacen).length, 0);
    eq('Y no deja marca de sesión', t.almacenLocal.sesionActiva, undefined);

    console.log('\n=== 2. Con sesión de app y de Firebase: envuelve initFirebase y devuelve la base ===');
    t = montar({ usuario: { uid: 'uid1', email: 'jefe@negocio.com' }, perfil: { email: 'jefe@negocio.com', ingreso: true } });
    const base = await t.ctx.window.initFirebase();
    eq('Devuelve la base de datos', base === t.db, true);
    eq('Conserva la ruta de datos de la pestaña', t.almacen['propietarioActual'], 'jefe@negocio.com');
    eq('No redirige', t.registro.redirects.length, 0);

    console.log('\n=== 3. El orden importa: el SDK se carga ANTES de exigir sesión ===');
    t = montar({ usuario: { uid: 'uid1', email: 'jefe@negocio.com' }, perfil: { email: 'jefe@negocio.com' } });
    await t.ctx.window.initFirebase();
    eq('Primero el initFirebase de la página, después la comprobación de sesión', t.registro.llamadas.join(' -> '), 'initFirebase-original -> onAuthStateChanged');

    console.log('\n=== 4. La comprobación de sesión se hace una sola vez ===');
    t = montar({ usuario: { uid: 'uid1', email: 'jefe@negocio.com' }, perfil: { email: 'jefe@negocio.com' } });
    await t.ctx.window.initFirebase();
    await t.ctx.window.sesionLista;
    await t.ctx.window.initFirebase();
    eq('Un solo onAuthStateChanged', t.registro.llamadas.filter((x) => x === 'onAuthStateChanged').length, 1);

    console.log('\n=== 5. CASO REAL: pestaña con sessionStorage copiado pero SIN la marca compartida ===');
    // Es lo que pasaba: una pestaña abierta antes de cerrar sesión conserva su copia de
    // propietarioActual, pero la marca compartida ya no está → debe quedar bloqueada.
    t = montar({ usuario: { uid: 'uid1', email: 'jefe@negocio.com' }, marca: false, rutaEnPestana: true });
    const resultado = await Promise.race([
        t.ctx.window.initFirebase(),
        new Promise((r) => setTimeout(() => r('bloqueado'), 300))
    ]);
    eq('NO le entrega la base de datos a la página', resultado, 'bloqueado');
    await esperarRedireccion();
    eq('Y la manda al login', t.registro.redirects[0], 'index.html');
    eq('Limpiando también su copia de sessionStorage', t.almacen.propietarioActual, undefined);

    console.log('\n=== 5b. Marca compartida y pestaña sin ruta: entra y la restaura ===');
    t = montar({ usuario: { uid: 'uid1', email: 'jefe@negocio.com' }, marca: true, rutaEnPestana: false });
    const baseNueva = await t.ctx.window.initFirebase();
    eq('Devuelve la base', baseNueva === t.db, true);
    eq('Restaura la ruta de datos desde la marca', t.almacen['propietarioActual'], 'jefe@negocio.com');
    eq('No redirige', t.registro.redirects.length, 0);

    console.log('\n=== 5c. Si la pestaña tiene otra ruta, no se pisa ===');
    t = montar({ usuario: { uid: 'uid1', email: 'jefe@negocio.com' }, tokenSesion: { propietarioActual: 'otro@negocio.com' } });
    await t.ctx.window.initFirebase();
    eq('Conserva la ruta de la pestaña', t.almacen['propietarioActual'], 'otro@negocio.com');

    console.log('\n=== 6. Sin SDK de Firebase: la página no se bloquea ===');
    t = montar({ conSDK: false });
    const baseSinSdk = await t.ctx.window.initFirebase();
    eq('devuelve la base igualmente', baseSinSdk === t.db, true);
    eq('No redirige', t.registro.redirects.length, 0);

    console.log('\n=== 7. Página sin initFirebase (config.html): frena el arranque hasta tener sesión ===');
    t = montar({ usuario: { uid: 'uid9', email: 'jefe@negocio.com' }, perfil: { email: 'jefe@negocio.com' }, conInitFirebase: false });
    let arranco = false;
    t.oyentes.DOMContentLoaded.push({ fn: () => { arranco = true; }, captura: false });
    const evento = new t.ctx.Event('DOMContentLoaded');
    t.documento.dispatchEvent(evento);
    eq('El manejador de la página NO arranca todavía', arranco, false);
    await t.ctx.window.sesionLista;
    await new Promise((r) => setTimeout(r, 10));
    eq('Y arranca cuando la sesión está lista', arranco, true);
    eq('Con su ruta de datos intacta', t.almacen['propietarioActual'], 'jefe@negocio.com');

    console.log('\n=== 8. Página sin initFirebase y sin sesión: no arranca ===');
    t = montar({ usuario: null, conInitFirebase: false, marca: false, rutaEnPestana: false });
    let arranco2 = false;
    t.oyentes.DOMContentLoaded.push({ fn: () => { arranco2 = true; }, captura: false });
    t.documento.dispatchEvent(new t.ctx.Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 20));
    eq('No arranca', arranco2, false);
    await esperarRedireccion();
    eq('Y redirige al login', t.registro.redirects[0], 'index.html');

    console.log('\n=== 9. Cierre de sesión real (cerrar_sesion.js) ===');
    function montarCierre({ conSDK = true, apps = [], currentUser = { uid: 'u1' }, fallaCarga = false } = {}) {
        const registro = { signOut: 0, initApp: 0, redirects: [], cargados: [] };
        const almacen = { propietarioActual: 'jefe@negocio.com', currentUser: '{}' };
        // localStorage guarda además datos de la app: solo se debe borrar la marca de sesión
        const almacenLocal = { sesionActiva: JSON.stringify({ email: 'jefe@negocio.com' }), darkMode: 'true', ciervo_inventory: '[]' };
        const base = {
            apps: apps,
            initializeApp: () => { registro.initApp++; },
            auth: () => ({
                currentUser: currentUser,
                // En el navegador la sesión guardada se restaura de forma asíncrona
                onAuthStateChanged: (cb) => { setTimeout(() => cb(currentUser), 0); },
                signOut: async () => { registro.signOut++; }
            })
        };
        const ctx = {
            window: { location: { replace: (u) => registro.redirects.push(u) } },
            document: {
                head: {
                    appendChild: (s) => {
                        registro.cargados.push(String(s.src).split('/').pop());
                        if (fallaCarga) { if (s.onerror) s.onerror(); return; }
                        setTimeout(() => { ctx.window.firebase = base; if (s.onload) s.onload(); }, 0);
                    }
                },
                createElement: () => ({}),
                addEventListener: () => {}
            },
            sessionStorage: {
                clear: () => { Object.keys(almacen).forEach((k) => delete almacen[k]); },
                getItem: (k) => (k in almacen ? almacen[k] : null),
                setItem: (k, v) => { almacen[k] = String(v); }
            },
            localStorage: {
                getItem: (k) => (k in almacenLocal ? almacenLocal[k] : null),
                setItem: (k, v) => { almacenLocal[k] = String(v); },
                removeItem: (k) => { delete almacenLocal[k]; }
            },
            console: { log: () => {}, warn: () => {}, error: () => {} },
            setTimeout, Promise, Object, JSON
        };
        if (conSDK) { ctx.firebase = base; ctx.window.firebase = base; }
        vm.createContext(ctx);
        vm.runInContext(fs.readFileSync('cerrar_sesion.js', 'utf8'), ctx);
        return { ctx, registro, almacen, almacenLocal };
    }

    let c = montarCierre({ conSDK: true, apps: [{}] });
    await c.ctx.window.cerrarSesionApp('index.html');
    eq('Cierra la sesión de Firebase', c.registro.signOut, 1);
    eq('No reinicializa la app si ya estaba', c.registro.initApp, 0);
    eq('Limpia la sesión de la pestaña', Object.keys(c.almacen).length, 0);
    eq('Borra la marca de sesión compartida', c.almacenLocal.sesionActiva, undefined);
    eq('Y NO toca los demás datos del navegador', c.almacenLocal.ciervo_inventory, '[]');
    eq('Vuelve al login', c.registro.redirects[0], 'index.html');

    console.log('\n=== 10. Cierre desde una página SIN SDK (menu.html) ===');
    c = montarCierre({ conSDK: false });
    await c.ctx.window.cerrarSesionApp('index.html');
    eq('Carga el SDK dinámicamente (app + auth)', c.registro.cargados.length, 2);
    eq('Inicializa la app', c.registro.initApp, 1);
    eq('Cierra la sesión', c.registro.signOut, 1);
    eq('Limpia y vuelve al login', c.registro.redirects[0], 'index.html');

    console.log('\n=== 11. Si no puede cargar el SDK, igual cierra la sesión local ===');
    c = montarCierre({ conSDK: false, fallaCarga: true });
    await c.ctx.window.cerrarSesionApp('index.html');
    eq('No se queda colgado', c.registro.redirects[0], 'index.html');
    eq('Y limpia la pestaña', Object.keys(c.almacen).length, 0);

    console.log('\n=== 12. Caso crítico: sesión guardada pero currentUser todavía vacío ===');
    c = montarCierre({ conSDK: true, apps: [{}], currentUser: null });
    await c.ctx.window.cerrarSesionApp('index.html');
    eq('CIERRA la sesión igualmente (no depende de currentUser)', c.registro.signOut, 1);
    eq('Limpia la pestaña', Object.keys(c.almacen).length, 0);
    eq('Y va al login', c.registro.redirects[0], 'index.html');

    console.log('\n=== 13. EL BUG REAL: página que pinta desde localStorage sin llamar a Firebase ===');
    // inventario.html (y otras) muestran el inventario guardado en localStorage y solo tocan
    // Firebase si hay Cloud Sync y sesión. Envolver initFirebase no bastaba: hay que frenar
    // el arranque de la página siempre.
    t = montar({ usuario: null, conInitFirebase: true, marca: false, rutaEnPestana: false });
    let pintoDatos = false;
    t.oyentes.DOMContentLoaded.push({ fn: () => { pintoDatos = true; }, captura: false });
    t.documento.dispatchEvent(new t.ctx.Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 30));
    eq('La página NO llega a pintar sus datos', pintoDatos, false);
    await esperarRedireccion();
    eq('Y la manda al login', t.registro.redirects[0], 'index.html');

    console.log('\n=== 14. Con sesión válida, la misma página sí arranca ===');
    t = montar({ usuario: { uid: 'uid1', email: 'jefe@negocio.com' }, conInitFirebase: true });
    let pinto2 = false;
    t.oyentes.DOMContentLoaded.push({ fn: () => { pinto2 = true; }, captura: false });
    t.documento.dispatchEvent(new t.ctx.Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 30));
    eq('Arranca normalmente', pinto2, true);
    eq('Sin redirigir', t.registro.redirects.length, 0);

    console.log(`\n================ ${ok} OK, ${fallos} FALLAS ================`);
    process.exitCode = fallos === 0 ? 0 : 1;
})();
