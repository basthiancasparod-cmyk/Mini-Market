/**
 * Pruebas de la nueva autenticación de index.html (Firebase Auth + migración + bóveda).
 * Usa las funciones REALES del archivo con Firebase simulado.
 */
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const extract = (re, name) => {
    const m = html.match(re);
    if (!m) throw new Error('No se pudo extraer: ' + name);
    return m[0];
};

// ---------- DOM simulado ----------
const els = {};
let ultimoToast = null;
function fakeEl(id) {
    const el = {
        id, value: '', checked: false, textContent: '', innerHTML: '', className: '', style: {},
        _attrs: {}, _classes: new Set(), _span: null, disabled: false,
        classList: {
            add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c),
            contains: (c) => el._classes.has(c), toggle: () => {}
        },
        setAttribute: (k, v) => { el._attrs[k] = v; },
        removeAttribute: (k) => { delete el._attrs[k]; },
        getAttribute: (k) => el._attrs[k],
        appendChild: () => {}, remove: () => {}, focus: () => {},
        querySelector: (sel) => (el._span = el._span || fakeEl(id + '-span'))
    };
    return el;
}
const el = (id) => (els[id] = els[id] || fakeEl(id));
global.document = {
    getElementById: el,
    querySelectorAll: () => [],
    createElement: () => fakeEl('creado'),
    addEventListener: () => {},
    body: { appendChild: (t) => { ultimoToast = t; historialAvisos.push(t._span.textContent); } }
};
let storeSesion = {}, storeLocal = {};
global.sessionStorage = { getItem: (k) => (k in storeSesion ? storeSesion[k] : null), setItem: (k, v) => { storeSesion[k] = String(v); }, removeItem: (k) => { delete storeSesion[k]; } };
global.localStorage = { getItem: (k) => (k in storeLocal ? storeLocal[k] : null), setItem: (k, v) => { storeLocal[k] = String(v); }, removeItem: (k) => { delete storeLocal[k]; } };
global.window = { location: { href: '' } };

// ---------- Firebase simulado ----------
let pushCounter = 0;
const dbData = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const hasPath = (p) => dbData.has(p) || [...dbData.keys()].some((k) => k.startsWith(p + '/'));
// Devuelve el valor del nodo, reconstruyendo el objeto desde los hijos si hace falta
function getPath(p) {
    if (dbData.has(p)) return clone(dbData.get(p));
    const prefijo = p + '/';
    const hijos = [...dbData.keys()].filter((k) => k.startsWith(prefijo));
    if (!hijos.length) return null;
    const obj = {};
    hijos.forEach((k) => {
        const partes = k.slice(prefijo.length).split('/');
        let nodo = obj;
        partes.forEach((parte, i) => {
            if (i === partes.length - 1) nodo[parte] = clone(dbData.get(k));
            else { nodo[parte] = nodo[parte] || {}; nodo = nodo[parte]; }
        });
    });
    return obj;
}
function setPath(p, value) {
    if (value === null) { dbData.delete(p); return; }
    [...dbData.keys()].forEach((k) => { if (k.startsWith(p + '/')) dbData.delete(k); });
    dbData.set(p, clone(value));
}
function childSnapshot(path, key) {
    const valor = getPath(path + '/' + key);
    return { key, val: () => valor, exists: () => hasPath(path + '/' + key) };
}
function snapshot(path) {
    return {
        exists: () => hasPath(path),
        val: () => getPath(path),
        child: (c) => snapshot(path + '/' + c),
        forEach: (cb) => {
            const obj = getPath(path);
            if (!obj || typeof obj !== 'object') return false;
            Object.keys(obj).forEach((k) => { if (cb(childSnapshot(path, k)) === true) return true; });
            return false;
        }
    };
}
function querySnapshot(path, child, value) {
    return {
        exists: () => Object.keys(getPath(path) || {}).some((k) => (getPath(path)[k] || {})[child] === value),
        val: () => getPath(path),
        forEach: (cb) => {
            const obj = getPath(path) || {};
            Object.keys(obj).forEach((k) => { if ((obj[k] || {})[child] === value) cb(childSnapshot(path, k)); });
        }
    };
}
const db = {
    ref: (path) => ({
        path,
        once: async () => snapshot(path),
        set: async (v) => { setPath(path, v); },
        push: async (v) => { pushCounter += 1; const k = 'push' + pushCounter; setPath(path + '/' + k, v); return { key: k }; },
        orderByChild: (child) => ({ equalTo: (v) => ({ once: async () => querySnapshot(path, child, v) }) })
    })
};
const authUsers = new Map();
const auth = {
    currentUser: null,
    async createUserWithEmailAndPassword(email, password) {
        const correo = String(email).toLowerCase();
        if (authUsers.has(correo)) { const e = new Error('en uso'); e.code = 'auth/email-already-in-use'; throw e; }
        const uid = 'uid' + (authUsers.size + 1);
        authUsers.set(correo, { uid, email: correo, password });
        auth.currentUser = { uid, email: correo };
        return { user: { uid, email: correo } };
    },
    async signInWithEmailAndPassword(email, password) {
        const correo = String(email).toLowerCase();
        const u = authUsers.get(correo);
        if (!u || u.password !== password) { const e = new Error('credenciales'); e.code = 'auth/wrong-password'; throw e; }
        auth.currentUser = { uid: u.uid, email: u.email };
        return { user: { uid: u.uid, email: u.email } };
    },
    async signOut() { auth.currentUser = null; }
};

// ---------- Código real extraído ----------
const code = [
    extract(/const EMAIL_PATH_AT = '_at_';/, 'EMAIL_PATH_AT'),
    extract(/function normalizeEmail\(value\) \{[\s\S]*?\n        \}/, 'normalizeEmail'),
    extract(/function emailToPath\(email\) \{[\s\S]*?\n        \}/, 'emailToPath'),
    extract(/function authErrorMessage\(error\) \{[\s\S]*?\n        \}/, 'authErrorMessage'),
    extract(/function withTimeout\(promise, ms = 15000\) \{[\s\S]*?\n        \}/, 'withTimeout'),
    extract(/function showToast\(message, type\) \{[\s\S]*?\n        \}/, 'showToast'),
    extract(/const buttonCooldowns = new Map\(\);[\s\S]*?\n        \}/, 'isRateLimited'),
    extract(/function sanitizeInput\(str\) \{[\s\S]*?\n        \}/, 'sanitizeInput'),
    extract(/function validateField\(field\) \{[\s\S]*?\n        \}/, 'validateField'),
    extract(/function clearValidation\(field\) \{[\s\S]*?\n        \}/, 'clearValidation'),
    extract(/function updateAuthButtons\(\) \{[\s\S]*?\n        \}/, 'updateAuthButtons'),
    extract(/async function ensureOwnerProfile\(user, \{ plainPassword = null, legacy = null \} = \{\}\) \{[\s\S]*?\n        \}/, 'ensureOwnerProfile'),
    extract(/async function migrateLegacyOwner\(email, password\) \{[\s\S]*?\n        \}/, 'migrateLegacyOwner'),
    extract(/async function completeOwnerLogin\(user, plainPassword, aviso = ''\) \{[\s\S]*?\n        \}/, 'completeOwnerLogin'),
    extract(/async function handleOwnerRegister\(\) \{[\s\S]*?\n        \}/, 'handleOwnerRegister'),
    extract(/async function handleOwnerLogin\(\) \{[\s\S]*?\n        \}/, 'handleOwnerLogin'),
    extract(/async function handleOperatorLogin\(\) \{[\s\S]*?\n        \}/, 'handleOperatorLogin'),
    extract(/async function handleSignOutAndReturn\(\) \{[\s\S]*?\n        \}/, 'handleSignOutAndReturn'),
    extract(/async function ensureUserCloudStructure\(email\) \{[\s\S]*?\n\}/, 'ensureUserCloudStructure'),
    // Ayuda de prueba: limpia el cooldown de botones (vive dentro del eval)
    'function __resetCooldowns() { buttonCooldowns.clear(); }',
].join('\n');

Object.defineProperty(global, 'ownerAuthForm', { get: () => el('owner-auth-form') });
Object.defineProperty(global, 'operatorLoginContainer', { get: () => el('operator-login-container') });
let historialAvisos = [];
eval(code);

// ---------- Utilidades ----------
let ok = 0, bad = 0;
const check = (n, c, extra = '') => { if (c) { ok++; console.log('OK    ' + n); } else { bad++; console.log('FALLA ' + n + (extra ? ' -> ' + extra : '')); } };
const eq = (n, a, b) => check(n, a === b, `esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)}`);
const mensajes = () => (ultimoToast ? ultimoToast._span.textContent : '');
const reiniciar = () => {
    dbData.clear(); authUsers.clear(); auth.currentUser = null;
    storeSesion = {}; storeLocal = {}; ultimoToast = null; pushCounter = 0; historialAvisos = [];
    Object.keys(els).forEach((k) => delete els[k]);
    el('email').name = 'email'; el('email').value = '';
    el('password').name = 'password'; el('password').value = '';
    el('system-username').name = 'system-username'; el('system-username').value = '';
    el('system-password').name = 'system-password'; el('system-password').value = '';
    el('rememberMe').checked = false;
    el('rateAuto'); el('owner-auth-form'); el('operator-login-container');
    __resetCooldowns();
    global.window.location.href = '';
};
const sembrarUsers = (lista) => { lista.forEach((u, i) => setPath('users/' + 'u' + (i + 1), u)); };
const sembrarOperadores = (lista) => { lista.forEach((o, i) => setPath('operadores/' + 'o' + (i + 1), o)); };

(async () => {
    console.log('=== 1. Normalización de correo y rutas ===');
    eq('normalizeEmail baja a minúsculas y recorta', normalizeEmail('  Juan.Perez@X.COM  '), 'juan.perez@x.com');
    eq('emailToPath iguala la del resto de la app', emailToPath('Juan@X.com'), 'juan_at_x_com');
    eq('emailToPath cambia los puntos', emailToPath('a.b@c.com'), 'a_b_at_c_com');

    console.log('\n=== 2. showToast ya no inyecta HTML (XSS) ===');
    reiniciar();
    showToast('<img src=x onerror=alert(1)>', 'error');
    check('El payload NO queda como HTML en el contenedor', !ultimoToast.innerHTML.includes('<img'), ultimoToast.innerHTML.slice(0, 80));
    eq('El payload se muestra como texto', ultimoToast._span.textContent, '<img src=x onerror=alert(1)>');
    showToast('Su usuario está <b>inactivo</b>.', 'warning');
    check('Un status con etiquetas tampoco se interpreta', ultimoToast._span.textContent.includes('<b>') && !ultimoToast.innerHTML.includes('<b>'));
    eq('Mensaje final en texto plano', mensajes(), 'Su usuario está <b>inactivo</b>.');

    console.log('\n=== 3. Registro de una cuenta nueva ===');
    reiniciar();
    el('email').value = 'Nuevo@Cliente.com';
    el('password').value = 'clave12345';
    await handleOwnerRegister();
    check('Se creó la cuenta en Authentication', authUsers.has('nuevo@cliente.com'));
    check('Y quedó SIN sesión activa (no está aprobado)', auth.currentUser === null);
    const perfilNuevo = getPath('usuarios/uid1');
    check('Se creó el perfil en usuarios/{uid}', !!perfilNuevo);
    eq('Con el correo normalizado', perfilNuevo.email, 'nuevo@cliente.com');
    eq('Con la ruta de datos correcta', perfilNuevo.emailPath, 'nuevo_at_cliente_com');
    eq('Sin aprobar', perfilNuevo.ingreso, false);
    eq('Origen = registro', perfilNuevo.origen, 'registro');
    const boveda = getPath('soporte/uid1');
    check('Se creó la bóveda de soporte', !!boveda);
    eq('Con el correo', boveda.email, 'nuevo@cliente.com');
    eq('Y la contraseña visible para soporte', boveda.password, 'clave12345');
    check('Avisa que espere la aprobación', /aprobación/.test(mensajes()), mensajes());
    eq('Los campos se limpian', el('email').value, '');

    console.log('\n=== 4. Login correcto de un propietario aprobado ===');
    reiniciar();
    authUsers.set('jefe@negocio.com', { uid: 'uidJ', email: 'jefe@negocio.com', password: 'clave12345' });
    setPath('usuarios/uidJ', { email: 'jefe@negocio.com', emailPath: 'jefe_at_negocio_com', ingreso: true });
    sembrarOperadores([{ username: 'vendedor1', password: 'op123456', propietario: 'jefe@negocio.com', status: 'active' }]);
    el('email').value = 'JEFE@negocio.com';
    el('password').value = 'clave12345';
    await handleOwnerLogin();
    eq('Sesión de Auth activa', auth.currentUser && auth.currentUser.uid, 'uidJ');
    eq('propietarioActual guardado', storeSesion['propietarioActual'], 'jefe@negocio.com');
    check('currentOwner incluye el uid', /uidJ/.test(storeSesion['currentOwner'] || ''));
    check('Muestra el login de operador (hay operadores)', el('operator-login-container').style.display === 'flex');
    check('Y oculta el formulario de propietario', el('owner-auth-form').style.display === 'none');
    check('Mensaje de éxito', /operador/.test(mensajes()), mensajes());

    console.log('\n=== 5. Login de un propietario NO aprobado ===');
    reiniciar();
    authUsers.set('pendiente@x.com', { uid: 'uidP', email: 'pendiente@x.com', password: 'clave12345' });
    setPath('usuarios/uidP', { email: 'pendiente@x.com', emailPath: 'pendiente_at_x_com', ingreso: false });
    el('email').value = 'pendiente@x.com';
    el('password').value = 'clave12345';
    await handleOwnerLogin();
    check('Se cierra la sesión de Auth', auth.currentUser === null);
    check('No se guarda sesión de la app', !storeSesion['propietarioActual']);
    check('Avisa que no está aprobada', /no ha sido aprobada/.test(mensajes()), mensajes());

    console.log('\n=== 6. Login con contraseña incorrecta ===');
    reiniciar();
    authUsers.set('jefe@negocio.com', { uid: 'uidJ', email: 'jefe@negocio.com', password: 'clave12345' });
    setPath('usuarios/uidJ', { email: 'jefe@negocio.com', emailPath: 'jefe_at_negocio_com', ingreso: true });
    el('email').value = 'jefe@negocio.com';
    el('password').value = 'otraclave';
    await handleOwnerLogin();
    eq('No hay sesión', auth.currentUser, null);
    check('Mensaje genérico (no revela si el correo existe)', /Email o contraseña incorrectos/.test(mensajes()), mensajes());

    console.log('\n=== 7. Migración automática de una cuenta antigua (login) ===');
    reiniciar();
    sembrarUsers([{ email: 'antiguo@negocio.com', password: 'claveVieja1', ingreso: true, createdAt: '2025-01-01T00:00:00.000Z' }]);
    check('No existe en Authentication todavía', !authUsers.has('antiguo@negocio.com'));
    el('email').value = 'antiguo@negocio.com';
    el('password').value = 'claveVieja1';
    await handleOwnerLogin();
    check('Se creó la cuenta de Authentication', authUsers.has('antiguo@negocio.com'));
    const perfilMigrado = getPath('usuarios/uid1');
    check('Se creó el perfil', !!perfilMigrado);
    eq('Conservando la aprobación anterior', perfilMigrado.ingreso, true);
    eq('Marcado como migrado', perfilMigrado.origen, 'migrado');
    eq('Conservando la fecha original', perfilMigrado.createdAt, '2025-01-01T00:00:00.000Z');
    eq('La bóveda guarda la clave', getPath('soporte/uid1').password, 'claveVieja1');
    eq('Entra con sesión', storeSesion['propietarioActual'], 'antiguo@negocio.com');
    check('Avisa de la actualización', historialAvisos.some((m) => /actualizada al nuevo sistema/.test(m)), JSON.stringify(historialAvisos));

    console.log('\n=== 8. Registro de una cuenta antigua con la clave correcta ===');
    reiniciar();
    sembrarUsers([{ email: 'heredado@negocio.com', password: 'claveVieja2', ingreso: true }]);
    el('email').value = 'heredado@negocio.com';
    el('password').value = 'claveVieja2';
    await handleOwnerRegister();
    check('Se migró a Authentication', authUsers.has('heredado@negocio.com'));
    eq('Y entró directamente', storeSesion['propietarioActual'], 'heredado@negocio.com');
    eq('Perfil aprobado', getPath('usuarios/uid1').ingreso, true);

    console.log('\n=== 9. Registro con un correo ya existente y clave equivocada (anti-suplantación) ===');
    reiniciar();
    sembrarUsers([{ email: 'victima@negocio.com', password: 'suClaveReal', ingreso: true }]);
    el('email').value = 'victima@negocio.com';
    el('password').value = 'claveInventada';
    await handleOwnerRegister();
    check('NO se crea una cuenta de Authentication para el correo ajeno', !authUsers.has('victima@negocio.com'));
    check('No hay sesión', auth.currentUser === null);
    check('Mensaje sin revelar el estado de la cuenta', /ya está registrado/.test(mensajes()), mensajes());

    console.log('\n=== 10. Cuenta ya existente en Authentication (registro) ===');
    reiniciar();
    authUsers.set('existe@negocio.com', { uid: 'uidE', email: 'existe@negocio.com', password: 'clave12345' });
    setPath('usuarios/uidE', { email: 'existe@negocio.com', emailPath: 'existe_at_negocio_com', ingreso: false });
    el('email').value = 'existe@negocio.com';
    el('password').value = 'clave12345';
    await handleOwnerRegister();
    check('No se duplica la cuenta', authUsers.size === 1);
    check('Avisa del error de correo en uso', /ya está registrado/.test(mensajes()), mensajes());

    console.log('\n=== 11. Login de operador: no guarda la contraseña ===');
    reiniciar();
    authUsers.set('jefe@negocio.com', { uid: 'uidJ', email: 'jefe@negocio.com', password: 'clave12345' });
    auth.currentUser = { uid: 'uidJ', email: 'jefe@negocio.com' };
    storeSesion['propietarioActual'] = 'jefe@negocio.com';
    sembrarOperadores([
        { username: 'vendedor1', password: 'op123456', propietario: 'jefe@negocio.com', status: 'active', firstName: 'Ana', lastName: 'Perez', role: 'Vendedor' },
        { username: 'vendedor2', password: 'op999999', propietario: 'jefe@negocio.com', status: 'inactive', firstName: 'Luis', lastName: 'Diaz', role: 'Vendedor' }
    ]);
    el('system-username').value = 'vendedor1';
    el('system-password').value = 'op123456';
    await handleOperatorLogin();
    const guardado = JSON.parse(storeSesion['currentUser'] || '{}');
    eq('Guarda el operador', guardado.username, 'vendedor1');
    eq('Con su rol', guardado.role, 'Vendedor');
    check('Sin la contraseña', guardado.password === undefined, JSON.stringify(guardado));
    check('Redirige al menú', global.window.location.href === 'menu.html', global.window.location.href);
    reiniciar();
    auth.currentUser = { uid: 'uidJ', email: 'jefe@negocio.com' };
    storeSesion['propietarioActual'] = 'jefe@negocio.com';
    sembrarOperadores([{ username: 'vendedor2', password: 'op999999', propietario: 'jefe@negocio.com', status: 'inactive' }]);
    el('system-username').value = 'vendedor2';
    el('system-password').value = 'op999999';
    await handleOperatorLogin();
    check('Un operador inactivo no entra', !storeSesion['currentUser']);
    check('Y se avisa del estado', /inactive|está/.test(mensajes()), mensajes());

    console.log('\n=== 12. Estructura de nube al entrar ===');
    reiniciar();
    authUsers.set('jefe@negocio.com', { uid: 'uidJ', email: 'jefe@negocio.com', password: 'clave12345' });
    setPath('usuarios/uidJ', { email: 'jefe@negocio.com', emailPath: 'jefe_at_negocio_com', ingreso: true });
    el('email').value = 'jefe@negocio.com';
    el('password').value = 'clave12345';
    await handleOwnerLogin();
    eq('Se creó BBDD/<ruta>/suscripcion/cloudSync', getPath('BBDD/jefe_at_negocio_com/suscripcion/cloudSync'), false);
    eq('Sin operadores, va a gestionar usuarios', global.window.location.href, 'gestion_usuario.html');

    console.log('\n=== 13. Cerrar sesión ===');
    reiniciar();
    auth.currentUser = { uid: 'uidJ', email: 'jefe@negocio.com' };
    storeSesion['propietarioActual'] = 'jefe@negocio.com';
    storeSesion['currentOwner'] = '{}';
    storeSesion['currentUser'] = '{}';
    handleSignOutAndReturn();
    await new Promise((r) => setTimeout(r, 10));
    eq('Auth cerrado', auth.currentUser, null);
    eq('propietarioActual borrado', storeSesion['propietarioActual'], undefined);
    eq('currentOwner borrado', storeSesion['currentOwner'], undefined);
    eq('currentUser borrado', storeSesion['currentUser'], undefined);

    console.log('\n=== 14. El respaldo cubre el código real del SDK (auth/internal-error) ===');
    reiniciar();
    sembrarUsers([{ email: 'oculto@negocio.com', password: 'claveOculta1', ingreso: true }]);
    const signInOriginal = auth.signInWithEmailAndPassword;
    auth.signInWithEmailAndPassword = async () => { const e = new Error('credenciales'); e.code = 'auth/internal-error'; throw e; };
    el('email').value = 'oculto@negocio.com';
    el('password').value = 'claveOculta1';
    await handleOwnerLogin();
    check('Migra aunque el SDK devuelva auth/internal-error', authUsers.has('oculto@negocio.com'));
    eq('Y entra correctamente', storeSesion['propietarioActual'], 'oculto@negocio.com');
    check('Perfil aprobado conservado', getPath('usuarios/uid1').ingreso === true);

    console.log('\n=== 15. Un error de configuración NO dispara la migración ===');
    reiniciar();
    sembrarUsers([{ email: 'fatal@negocio.com', password: 'claveFatal1', ingreso: true }]);
    auth.signInWithEmailAndPassword = async () => { const e = new Error('apagado'); e.code = 'auth/operation-not-allowed'; throw e; };
    el('email').value = 'fatal@negocio.com';
    el('password').value = 'claveFatal1';
    await handleOwnerLogin();
    auth.signInWithEmailAndPassword = signInOriginal;
    check('No crea cuentas cuando el proveedor está desactivado', !authUsers.has('fatal@negocio.com'));
    check('Muestra el aviso específico', /desactivado en Firebase/.test(mensajes()), mensajes());
    check('No entra', !storeSesion['propietarioActual']);

    console.log(`\n================ ${ok} OK, ${bad} FALLAS ================`);
    process.exitCode = bad === 0 ? 0 : 1;
})();
