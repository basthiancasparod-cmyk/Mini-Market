/**
 * Migración de las cuentas antiguas (nodo `users`) a Firebase Authentication.
 *
 * ¿Para qué sirve? El nuevo login migra cada cuenta sola cuando el cliente entra.
 * Pero antes de cerrar las reglas (Fase 4) TODAS las cuentas deben existir ya en
 * Authentication: si no, ese cliente se quedaría sin poder entrar (su registro en
 * `users` dejaría de ser legible para él).
 *
 * Qué hace, por cada registro de `users`:
 *   1. Crea la cuenta en Authentication con su correo y su contraseña actuales
 *      (si ya existe, intenta entrar con esa clave).
 *   2. Con el token del propio cliente escribe `usuarios/{uid}` (perfil y aprobación)
 *      y `soporte/{uid}` (bóveda de soporte), respetando las reglas.
 *   3. No imprime NINGUNA contraseña. Es idempotente: lo ya migrado se omite.
 *
 * Uso:
 *   node migrar_cuentas.js             -> simulación: solo lista lo que haría
 *   node migrar_cuentas.js --aplicar    -> migra de verdad
 */

const KEY = 'AIzaSyCyaIC2-pCCQf_mJWGtG6v-0kA1l2Or2CQ';
const DB = 'https://mini-market-ciervo-index-default-rtdb.firebaseio.com';
const APLICAR = process.argv.includes('--aplicar');

const emailToPath = (email) => String(email).trim().toLowerCase().replace('@', '_at_').replace(/\./g, '_');
const normalizar = (email) => String(email || '').trim().toLowerCase();

const authPost = async (ruta, cuerpo) => {
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:' + ruta + '?key=' + KEY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo)
    });
    return { status: r.status, data: await r.json() };
};
const dbPut = (ruta, token, valor) => fetch(DB + ruta + '.json?auth=' + token, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valor)
});
const dbGet = (ruta, token) => fetch(DB + ruta + '.json?auth=' + token).then((r) => r.json());

(async () => {
    console.log(APLICAR ? '=== MIGRACIÓN REAL ===' : '=== SIMULACIÓN (usa --aplicar para migrar) ===');

    const usuarios = await (await fetch(DB + '/users.json')).json();
    if (!usuarios || typeof usuarios !== 'object') { console.log('No hay registros en `users`.'); return; }

    const registros = Object.entries(usuarios)
        .map(([clave, u]) => ({ clave, ...u }))
        .filter((u) => u && typeof u.email === 'string' && typeof u.password === 'string' && u.email.includes('@'));

    console.log('Registros utilizables en `users`:', registros.length, '\n');

    const resumen = [];
    for (const u of registros) {
        const email = normalizar(u.email);
        const fila = { email, estado: '', detalle: '' };

        if (!APLICAR) {
            fila.estado = 'pendiente';
            fila.detalle = 'se creará la cuenta y su perfil';
            resumen.push(fila);
            continue;
        }

        let token = null;
        const alta = await authPost('signUp', { email, password: u.password, returnSecureToken: true });
        if (alta.status === 200) {
            token = alta.data.idToken;
            fila.estado = 'migrado';
        } else if (alta.data.error && alta.data.error.message === 'EMAIL_EXISTS') {
            const entrada = await authPost('signInWithPassword', { email, password: u.password, returnSecureToken: true });
            if (entrada.status === 200) {
                token = entrada.data.idToken;
                fila.estado = 'ya existía';
            } else {
                fila.estado = 'ATENCIÓN';
                fila.detalle = 'ya está en Authentication pero con otra contraseña; revisar a mano';
            }
        } else {
            fila.estado = 'ERROR';
            fila.detalle = (alta.data.error && alta.data.error.message) || 'desconocido';
        }

        if (token) {
            const uid = (await authPost('signInWithPassword', { email, password: u.password, returnSecureToken: true })).data.localId;
            const perfilActual = await dbGet('/usuarios/' + uid, token);
            if (!perfilActual) {
                const r = await dbPut('/usuarios/' + uid, token, {
                    email: email,
                    emailPath: emailToPath(email),
                    ingreso: u.ingreso === true,
                    createdAt: u.createdAt || new Date().toISOString(),
                    origen: 'migrado'
                });
                fila.detalle = r.status === 200 ? 'perfil creado' : 'perfil DENEGADO (' + r.status + ')';
            } else {
                fila.detalle = 'perfil ya existía';
            }
            const rBoveda = await dbPut('/soporte/' + uid, token, {
                email: email, password: u.password, actualizado: new Date().toISOString()
            });
            fila.detalle += rBoveda.status === 200 ? ' + bóveda' : ' | bóveda DENEGADA (' + rBoveda.status + ')';
        }

        resumen.push(fila);
    }

    console.log('correo'.padEnd(38), 'estado'.padEnd(12), 'detalle');
    resumen.forEach((f) => console.log(f.email.padEnd(38), f.estado.padEnd(12), f.detalle));

    const problemas = resumen.filter((f) => f.estado === 'ATENCIÓN' || f.estado === 'ERROR');
    console.log('\nTotal:', resumen.length, '| con problemas:', problemas.length);
    if (!APLICAR) console.log('\nEjecuta con --aplicar para migrar de verdad.');
})();
