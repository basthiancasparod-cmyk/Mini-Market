// Servidor estático local (temporal) para probar la app SIN publicar nada.
// - Envía Cache-Control: no-store: el navegador nunca sirve una versión vieja.
// - Escucha solo en localhost e IPv4 local (no se expone al resto de la red).
// - Registra cada petición para poder diagnosticar qué carga y qué no.
const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');

const root = __dirname;
const TIPOS = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
};

function manejar(req, res) {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const relativo = urlPath === '/' ? 'menu.html' : urlPath.replace(/^\/+/, '');
    const archivo = path.resolve(root, relativo);

    if (!archivo.startsWith(root)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('403 prohibido');
    }
    fs.stat(archivo, (err, st) => {
        if (err || !st.isFile()) {
            console.log('404', relativo);
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end('404 ' + relativo);
        }
        console.log('200', relativo, '| origen:', req.headers.host || '-', '| desde:', (req.headers.referer || 'directo').slice(0, 60));
        res.writeHead(200, {
            'Content-Type': TIPOS[path.extname(archivo).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache'
        });
        fs.createReadStream(archivo).pipe(res);
    });
}

// Busca el primer puerto libre a partir de 5500 (solo en IPv4 local)
function buscarPuerto(port, listo) {
    if (port > 5520) { console.error('No hay puerto libre entre 5500 y 5520'); process.exit(1); }
    const sonda = net.createServer();
    sonda.once('error', () => buscarPuerto(port + 1, listo));
    sonda.once('listening', () => sonda.close(() => listo(port)));
    sonda.listen(port, '127.0.0.1');
}

function levantar(port) {
    const direcciones = ['127.0.0.1', '::1'];
    let activos = 0;
    direcciones.forEach((dir) => {
        const s = http.createServer(manejar);
        s.on('error', (e) => console.log('aviso: no se pudo escuchar en', dir, '-', e.code));
        s.listen(port, dir, () => {
            activos += 1;
            if (activos === 1) {
                console.log('SERVIDOR_LISTO http://127.0.0.1:' + port + '/index.html');
                console.log('TAMBIEN        http://localhost:' + port + '/index.html');
            }
        });
    });
}

buscarPuerto(5500, levantar);
