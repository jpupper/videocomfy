// ===========================================================================
// IACOMFY - base de datos (MongoDB) del proyecto
// ---------------------------------------------------------------------------
// Misma convención que artedigitaldata y el resto del ecosistema: Mongoose
// contra el MongoDB del VPS, base propia (`iacomfy`).
//
// Qué guarda, POR USUARIO (la clave de unificación es el EMAIL, como dice el
// skillmaestro):
//   a) Usuario     -> quién es (username, displayName, avatar)
//   b) Asset       -> cada imagen/video/audio que ese usuario creó (la URL de
//                     R2, nunca el binario: prohibido guardar binarios en Mongo)
//   c) Computadora -> qué computadoras se registraron desde esa cuenta, cuánto
//                     tiempo estuvo prendida cada una (segundosTotal) y cuántas
//                     generaciones sirvió (se cuentan de la colección Generacion)
//   d) Sesion      -> cada vez que una computadora se prende (para el uptime)
//   e) Generacion  -> qué se generó, quién lo pidió, en qué computadora y a
//                     quién pertenece esa computadora
//
// Con esto se arma el RANKING DE LOS FIERROS (más tiempo prendida / más
// generaciones provistas) que es el programa de incentivos para los creadores.
//
// Regla: si Mongo no responde, el hub SIGUE FUNCIONANDO (se degrada, avisa en
// el log y las estadísticas devuelven "sin datos").
// ===========================================================================
const mongoose = require('mongoose');

const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/iacomfy';
const BASE = 'iacomfy';   // nombre de la base (para tokenizar el panel)

let conectado = false;
let ultimoError = null;

// ---------------------------- Esquemas -------------------------------------

// a) Usuario (clave: email)
const UsuarioSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, index: true },
    username: { type: String, default: '' },
    displayName: { type: String, default: '' },
    avatar: { type: String, default: '' },
    primeraVez: { type: Date, default: Date.now },
    ultimaVez: { type: Date, default: Date.now },
    // cuántas veces pidió/creó algo (liviano, se rellena solo)
    vistas: { type: Number, default: 0 }
}, { timestamps: true });

// b) Asset: lo que el usuario creó
const AssetSchema = new mongoose.Schema({
    email: { type: String, required: true, index: true },
    username: { type: String, default: '' },
    publicId: { type: String, required: true, index: true },   // nombre del archivo
    url: { type: String, default: '' },                         // URL pública de R2 (vacía si vive sólo en la PC)
    key: { type: String, default: '' },                         // clave en el bucket
    tipo: { type: String, default: 'image' },                   // image | video | audio
    mimetype: { type: String, default: '' },
    bytes: { type: Number, default: 0 },
    // dónde vive el archivo: 'nube' (Cloudflare R2) o 'local' (disco del fierro)
    ubicacion: { type: String, default: 'nube', index: true },
    computadoraPeerId: { type: String, default: '', index: true },
    computadoraNombre: { type: String, default: '' },
    modelo: { type: String, default: '' },
    prompt: { type: String, default: '' },
    cuando: { type: Date, default: Date.now, index: true }
}, { timestamps: true });
AssetSchema.index({ email: 1, cuando: -1 });

// c) Computadora: los fierros que aportan a la red
const ComputadoraSchema = new mongoose.Schema({
    peerId: { type: String, required: true, unique: true, index: true },
    nombre: { type: String, default: '' },                 // JPupper · ComfyLatam
    hostname: { type: String, default: '' },               // sólo para el dueño
    email: { type: String, default: '', index: true },     // a quién pertenece
    username: { type: String, default: '' },
    avatar: { type: String, default: '' },
    gpu: { type: String, default: '' },
    modelos: { type: [String], default: [] },
    compartir: { type: Boolean, default: false },
    primerVisto: { type: Date, default: Date.now },
    ultimoVisto: { type: Date, default: Date.now, index: true },
    // uptime acumulado (se cierra cada sesión)
    segundosTotal: { type: Number, default: 0 },
    sesiones: { type: Number, default: 0 }
}, { timestamps: true });

// d) Sesion: cada vez que una computadora se prende
const SesionSchema = new mongoose.Schema({
    peerId: { type: String, required: true, index: true },
    nombre: { type: String, default: '' },
    email: { type: String, default: '', index: true },
    username: { type: String, default: '' },
    inicio: { type: Date, default: Date.now, index: true },
    ultimoLatido: { type: Date, default: Date.now },
    fin: { type: Date, default: null },
    segundos: { type: Number, default: 0 },
    abierta: { type: Boolean, default: true, index: true }
}, { timestamps: true });

// e) Generacion: qué se hizo, quién lo pidió y en qué fierro
const GeneracionSchema = new mongoose.Schema({
    archivo: { type: String, default: '' },
    prompt: { type: String, default: '' },
    modelo: { type: String, default: '' },
    tipo: { type: String, default: 'imagen' },          // imagen | video | storyboard
    // quién la pidió
    email: { type: String, default: '', index: true },
    username: { type: String, default: '' },
    displayName: { type: String, default: '' },
    avatar: { type: String, default: '' },
    // en qué computadora se hizo y de quién es esa computadora
    computadoraPeerId: { type: String, default: '', index: true },
    computadoraNombre: { type: String, default: '' },
    emailDueno: { type: String, default: '', index: true },
    duenoNombre: { type: String, default: '' },
    origen: { type: String, default: 'local' },         // local | red | web
    cuando: { type: Date, default: Date.now, index: true }
}, { timestamps: true });
GeneracionSchema.index({ computadoraPeerId: 1, cuando: -1 });
GeneracionSchema.index({ emailDueno: 1, cuando: -1 });

const Usuario = mongoose.model('Usuario', UsuarioSchema);
const Asset = mongoose.model('Asset', AssetSchema);
const Computadora = mongoose.model('Computadora', ComputadoraSchema);
const Sesion = mongoose.model('Sesion', SesionSchema);
const Generacion = mongoose.model('Generacion', GeneracionSchema);

// Configuración del proyecto (por ejemplo el cupo de la nube por cuenta).
const ConfigSchema = new mongoose.Schema({
    clave: { type: String, required: true, unique: true },
    valor: { type: mongoose.Schema.Types.Mixed },
    actualizado: { type: Date, default: Date.now }
}, { timestamps: true });
const Config = mongoose.model('ConfigIacomfy', ConfigSchema);

// Config por defecto: 20 MB por cuenta en la nube (los ADMIN no tienen tope).
const LIMITE_DEFECTO_MB = 20;

async function leerLimiteMB() {
    if (!conectado) return LIMITE_DEFECTO_MB;
    try {
        const c = await Config.findOne({ clave: 'limiteMB' }).lean();
        const v = c && Number(c.valor);
        return Number.isFinite(v) && v > 0 ? v : LIMITE_DEFECTO_MB;
    } catch (e) { return LIMITE_DEFECTO_MB; }
}

async function guardarLimiteMB(mb) {
    if (!conectado) return null;
    const v = Math.max(1, Math.round(Number(mb) || LIMITE_DEFECTO_MB));
    await Config.findOneAndUpdate({ clave: 'limiteMB' }, { $set: { valor: v, actualizado: new Date() } }, { upsert: true, returnDocument: 'after' });
    return v;
}

// ¿Qué rol tiene esta cuenta en el ecosistema? Se mira en fullscreen_global.users
// (la base compartida de jpconnect/fscauth), que es donde está el rol de verdad.
let dbGlobal = null;
async function rolEnElEcosistema(clave) {
    const k = String(clave || '').trim().toLowerCase();
    if (!k) return null;
    try {
        if (!dbGlobal) dbGlobal = mongoose.connection.useDb('fullscreen_global');
        // Se busca por email, por usuario Y por id: el JWT del ecosistema sólo
        // trae {id, email, role}, así que sin el _id el perfil no se encontraba
        // y devolvía nulls -> la web pisaba la foto/nombre con null.
        const filtros = [{ email: k }, { username: k }];
        if (/^[a-f0-9]{24}$/i.test(k)) {
            try { filtros.push({ _id: new mongoose.Types.ObjectId(k) }); } catch (e) { }
        }
        const u = await dbGlobal.collection('users').findOne(
            { $or: filtros },
            { projection: { role: 1, username: 1, email: 1, avatar: 1, displayName: 1, bio: 1 } }
        );
        return u || null;
    } catch (e) { return null; }
}

async function esAdminDelEcosistema(clave) {
    const u = await rolEnElEcosistema(clave);
    const rol = String((u && u.role) || '').toUpperCase();
    return rol === 'ADMIN' || rol === 'SYSTEM';
}

// ¿Puede esta cuenta seguir subiendo a la nube? (ADMIN = sin tope)
async function puedeSubir(emailOUsuario) {
    if (!conectado) return { permitido: true, limiteMB: null, usadoMB: 0, admin: false, motivo: 'sin base' };
    const limite = await leerLimiteMB();
    const clave = String(emailOUsuario || '').trim().toLowerCase();
    if (!clave) return { permitido: true, limiteMB: limite, usadoMB: 0, admin: false, motivo: 'sin cuenta' };
    const admin = await esAdminDelEcosistema(clave);
    const bytes = await Asset.aggregate([{ $match: { email: clave } }, { $group: { _id: null, t: { $sum: '$bytes' } } }]);
    const usadoMB = ((bytes[0] && bytes[0].t) || 0) / 1048576;
    return { permitido: admin || usadoMB < limite, limiteMB: limite, usadoMB: Math.round(usadoMB * 10) / 10, admin, motivo: admin ? 'admin' : (usadoMB < limite ? 'ok' : 'cupo lleno') };
}

// ---------------------------- Conexión -------------------------------------

async function conectar() {
    try {
        mongoose.set('strictQuery', true);
        await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 6 });
        conectado = true;
        ultimoError = null;
        console.log('🗄️  IACOMFY: conectado a MongoDB (' + URI.replace(/\/\/[^@]*@/, '//***@') + ')');
        // arranque: si hay sesiones abiertas de antes, cerrarlas (uptime limpio)
        await cerrarSesionesViejas(true);
        return true;
    } catch (e) {
        conectado = false;
        ultimoError = e.message;
        console.log('⚠️  IACOMFY: no pude conectar a MongoDB (' + e.message + ') — sigo sin estadísticas');
        setTimeout(conectar, 60000);
        return false;
    }
}

function estadoDb() {
    return { conectado, base: BASE, uri: URI.replace(/\/\/[^@]*@/, '//***@'), ultimoError };
}

// ---------------------------- Anotadores -----------------------------------

function datosDe(input) {
    // Ojo con los nombres: la app manda {usuario, displayName, email} y otras
    // partes usan {username}. Se aceptan los dos (antes el "quién lo pidió"
    // quedaba vacío por esto).
    const i = input || {};
    const email = String(i.email || '').trim().toLowerCase();
    const username = String(i.username || i.usuario || '').trim();
    const displayName = String(i.displayName || i.nombre || username || '').trim();
    return { email, username, displayName, avatar: i.avatar || '' };
}

// a) Usuario
async function anotarUsuario(input) {
    if (!conectado) return null;
    const d = datosDe(input);
    const emailReal = (d.email && d.email.indexOf('@') > 0) ? d.email : '';
    const clave = emailReal || d.username;
    if (!clave) return null;
    try {
        // Si ya existe ese username (aunque tenga el email "pseudo"), se completa
        // en vez de crear una cuenta duplicada que después parte el ranking.
        if (d.username) {
            const ya = await Usuario.findOne({ username: d.username });
            if (ya) {
                ya.displayName = d.displayName || ya.displayName;
                ya.avatar = d.avatar || ya.avatar;
                ya.ultimaVez = new Date();
                if (emailReal) ya.email = emailReal;
                ya.vistas = (ya.vistas || 0) + 1;
                await ya.save();
                return ya;
            }
        }
        return await Usuario.findOneAndUpdate(
            { email: clave },
            {
                $set: { username: d.username, displayName: d.displayName, avatar: d.avatar, ultimaVez: new Date() },
                $setOnInsert: { primeraVez: new Date() },
                $inc: { vistas: 1 }
            },
            { upsert: true, returnDocument: 'after' }
        );
    } catch (e) { console.log('⚠️  IACOMFY usuario: ' + e.message); return null; }
}

// b) Asset (la media subida a R2)
async function anotarAsset(a) {
    if (!conectado) return null;
    try {
        const d = datosDe(a);
        return await Asset.findOneAndUpdate(
            { publicId: a.publicId },
            {
                $set: {
                    // la cuenta del asset es el email o, si no hay sesión, el usuario
                    email: d.email || d.username || '', username: d.username, publicId: a.publicId,
                    url: a.url, key: a.key || '', mimetype: a.mimetype || '',
                    bytes: a.bytes || 0, tipo: a.tipo || 'image',
                    ubicacion: a.ubicacion || (a.url ? 'nube' : 'local'),
                    computadoraPeerId: a.computadoraPeerId || '', computadoraNombre: a.computadoraNombre || '',
                    modelo: a.modelo || '', prompt: String(a.prompt || '').slice(0, 400)
                },
                $setOnInsert: { cuando: new Date() }
            },
            { upsert: true, returnDocument: 'after' }
        );
    } catch (e) { console.log('⚠️  IACOMFY asset: ' + e.message); return null; }
}

// c+d) Computadora + sesión (se llama en cada latido del nodo)
async function latidoDeComputadora(peer) {
    if (!conectado || !peer || !peer.id) return null;
    try {
        // Ojo: el peer de la red trae `usuario` como TEXTO (el nombre) y el email
        // aparte. Si viene como objeto también se banca.
        const u = peer.usuario;
        const fuente = (u && typeof u === 'object')
            ? u
            : { username: (typeof u === 'string' ? u : ''), displayName: (typeof u === 'string' ? u : ''), email: peer.email || '', avatar: peer.avatar || '' };
        if (!fuente.email && peer.email) fuente.email = peer.email;
        const d = datosDe(fuente);
        const email = d.email || d.username;
        const set = {
            nombre: peer.nombre || '', email, username: d.username, avatar: d.avatar,
            gpu: peer.gpu || '',
            // los modelos pueden llegar como lista de objetos: se guardan como nombres
            modelos: (Array.isArray(peer.modelos) ? peer.modelos : [])
                .map((m) => (typeof m === 'string' ? m : (m && (m.nombre || m.etiqueta || m.id)) || ''))
                .filter(Boolean).slice(0, 40),
            compartir: !!peer.compartir,
            ultimoVisto: new Date()
        };
        if (peer.hostname) set.hostname = peer.hostname;
        const nueva = !(await Computadora.findOne({ peerId: peer.id }).lean());
        const comp = await Computadora.findOneAndUpdate(
            { peerId: peer.id },
            { $set: set, $setOnInsert: { primerVisto: new Date() } },
            { upsert: true, returnDocument: 'after' }
        );
        // la cuenta queda registrada (para las listas de usuarios)
        if (nueva) await anotarUsuario(fuente).catch(() => { });
        // sesión: si no hay una abierta, se abre; si hay, se estira el latido
        const abierta = await Sesion.findOne({ peerId: peer.id, abierta: true });
        const ahora = new Date();
        if (abierta) {
            abierta.ultimoLatido = ahora;
            if (email && !abierta.email) abierta.email = email;
            await abierta.save();
        } else {
            await Sesion.create({ peerId: peer.id, nombre: peer.nombre || '', email, username: d.username, inicio: ahora, ultimoLatido: ahora });
            await Computadora.updateOne({ peerId: peer.id }, { $inc: { sesiones: 1 } });
        }
        return comp;
    } catch (e) { console.log('⚠️  IACOMFY latido: ' + e.message); return null; }
}

// Cierra la sesión de un nodo y suma el uptime a la computadora.
async function cerrarSesion(peerId) {
    if (!conectado || !peerId) return;
    try {
        const s = await Sesion.findOne({ peerId, abierta: true });
        if (!s) return;
        const fin = s.ultimoLatido || new Date();
        const segundos = Math.max(0, Math.round((fin - s.inicio) / 1000));
        s.abierta = false; s.fin = fin; s.segundos = segundos;
        await s.save();
        if (segundos > 5) {   // ignorar rebotes de un segundo
            await Computadora.updateOne({ peerId }, { $inc: { segundosTotal: segundos } });
            console.log(`⏱️  ${s.nombre || peerId} estuvo ${(segundos / 60).toFixed(0)} min prendida (acumulado guardado)`);
        }
    } catch (e) { console.log('⚠️  IACOMFY cerrar sesión: ' + e.message); }
}

// Cierra sesiones que dejaron de latir (si el nodo se fue sin avisar).
async function cerrarSesionesViejas(alArrancar) {
    if (!conectado) return 0;
    try {
        const limite = new Date(Date.now() - (alArrancar ? 0 : 3 * 60 * 1000));
        const viejas = await Sesion.find({ abierta: true, ultimoLatido: { $lt: limite } });
        for (const s of viejas) {
            const fin = alArrancar ? new Date() : s.ultimoLatido;
            const segundos = Math.max(0, Math.round((fin - s.inicio) / 1000));
            s.abierta = false; s.fin = fin; s.segundos = segundos;
            await s.save();
            if (segundos > 5) await Computadora.updateOne({ peerId: s.peerId }, { $inc: { segundosTotal: segundos } });
        }
        if (viejas.length) console.log(`⏱️  IACOMFY: cerré ${viejas.length} sesión(es) sin latido`);
        return viejas.length;
    } catch (e) { console.log('⚠️  IACOMFY sesiones viejas: ' + e.message); return 0; }
}

// e) Generación (con el registro que ya manda la app)
async function anotarGeneracion(g) {
    if (!conectado) return null;
    try {
        const d = datosDe(g.pedidoPor || {});
        const email = d.email || d.username || '';
        const comp = g.computadora || {};
        const doc = await Generacion.create({
            archivo: g.archivo || '', prompt: String(g.prompt || '').slice(0, 600),
            modelo: g.modelo || '', tipo: g.tipo || 'imagen',
            email, username: d.username, displayName: d.displayName, avatar: d.avatar,
            computadoraPeerId: comp.peerId || '', computadoraNombre: comp.nombre || '',
            // el dueño va por EMAIL (identificador universal): antes se guardaba el
            // username y el ranking no podía cruzarlo con las cuentas.
            emailDueno: String(comp.emailDueno || comp.duenoEmail || comp.email || comp.dueno || '').toLowerCase(),
            duenoNombre: comp.duenoNombre || comp.dueno || '',
            origen: g.origen || 'local',
            cuando: g.cuando ? new Date(g.cuando) : new Date()
        });
        await anotarUsuario(g.pedidoPor || {});
        return doc;
    } catch (e) { console.log('⚠️  IACOMFY generación: ' + e.message); return null; }
}

// ---------------------------- Consultas ------------------------------------

// Segundos de las sesiones ABIERTAS ahora mismo, por email. Así el tiempo
// aportado se ve al instante (no hay que esperar a que se apague la PC).
async function segundosEnVivo() {
    if (!conectado) return { porEmail: {}, porPeer: {}, porPeerSeguido: {}, seguidoPorEmail: {} };
    try {
        const abiertas = await Sesion.find({ abierta: true }).lean();
        const ahora = Date.now();
        const porEmail = {}, porPeer = {};
        for (const s of abiertas) {
            const seg = Math.max(0, Math.round((ahora - new Date(s.inicio).getTime()) / 1000));
            porPeer[s.peerId] = seg;
            const k = String(s.email || '').toLowerCase();
            if (k) porEmail[k] = (porEmail[k] || 0) + seg;
        }
        // El tiempo SEGUIDO (la sesión abierta más larga) se calcula con TODAS
        // las sesiones abiertas, tenga o no email la sesión.
        const porPeerSeguido = Object.assign({}, porPeer);
        const seguidoPorEmail = Object.assign({}, porEmail);
        abiertas.forEach((x) => {
            const k = String(x.email || '').toLowerCase();
            if (!k) return;
            seguidoPorEmail[k] = Math.max(seguidoPorEmail[k] || 0, porPeer[x.peerId] || 0);
        });
        // Si una sesión no tiene email (arrancó antes de loguearse), lo saco de su
        // computadora: así el tiempo en vivo se le acredita igual al dueño.
        const sinMail = abiertas.filter((x) => !x.email);
        if (sinMail.length) {
            const comps = await Computadora.find({ peerId: { $in: sinMail.map((x) => x.peerId) } }, { peerId: 1, email: 1 }).lean();
            const mapa = {};
            comps.forEach((c) => { if (c.email) mapa[c.peerId] = String(c.email).toLowerCase(); });
            sinMail.forEach((x) => {
                const k = mapa[x.peerId];
                if (!k) return;
                const seg = porPeer[x.peerId] || 0;
                porEmail[k] = (porEmail[k] || 0) + seg;
                seguidoPorEmail[k] = Math.max(seguidoPorEmail[k] || 0, seg);
            });
        }
        return { porEmail, porPeer, porPeerSeguido, seguidoPorEmail };
    } catch (e) { return { porEmail: {}, porPeer: {}, porPeerSeguido: {}, seguidoPorEmail: {} }; }
}

// ¿Está conectada ahora? Sí si tiene una sesión abierta o si latió hace menos
// de 2 minutos (el hub actualiza ultimoVisto cada 30 s).
function enLineaDe(email, ultimoVisto, vivo) {
    if (vivo && vivo.porEmail && vivo.porEmail[String(email || '').toLowerCase()]) return true;
    if (ultimoVisto) {
        const t = new Date(ultimoVisto).getTime();
        if (!isNaN(t) && (Date.now() - t) < 2 * 60 * 1000) return true;
    }
    return false;
}

// (a, b) Todo lo de un usuario: sus assets, sus computadoras con uptime y las
// generaciones (las que pidió y las que se hicieron en sus fierros).
async function estadisticasDe(emailOUsuario) {
    if (!conectado) return null;
    const clave = String(emailOUsuario || '').trim().toLowerCase();
    if (!clave) return null;
    try {
        let usuario = await Usuario.findOne({ $or: [{ email: clave }, { username: clave }] }).lean();
        let ec = null;
        try {
            ec = await rolEnElEcosistema(clave);
            if (!ec && usuario) {
                ec = await rolEnElEcosistema(usuario.email || usuario.username);
            }
        } catch (e) { }

        if (ec) {
            if (!usuario) {
                usuario = {
                    email: ec.email || clave,
                    username: ec.username || clave,
                    displayName: ec.displayName || ec.username || clave,
                    avatar: ec.avatar || '',
                    descripcion: ec.bio || '',
                    role: ec.role || ''
                };
            } else {
                usuario.email = ec.email || usuario.email;
                usuario.username = ec.username || usuario.username;
                usuario.displayName = ec.displayName || ec.username || usuario.displayName || usuario.username;
                usuario.avatar = ec.avatar || usuario.avatar || '';
                usuario.descripcion = ec.bio || usuario.descripcion || '';
                usuario.role = ec.role || usuario.role || '';
            }
        }

        // Claves unificadas: email, username y variantes para matchear en todas las colecciones
        const clavesUnificadas = Array.from(new Set([
            clave,
            usuario && usuario.email,
            usuario && usuario.username,
            ec && ec.email,
            ec && ec.username
        ].filter(Boolean).map(x => String(x).toLowerCase())));

        const filtroUsuario = {
            $or: [
                { email: { $in: clavesUnificadas } },
                { username: { $in: clavesUnificadas } }
            ]
        };
        const filtroFierros = {
            $or: [
                { email: { $in: clavesUnificadas } },
                { emailDueno: { $in: clavesUnificadas } },
                { username: { $in: clavesUnificadas } }
            ]
        };

        const [assets, computadoras, pidio, sirvio] = await Promise.all([
            Asset.find(filtroUsuario).sort({ cuando: -1 }).limit(60).lean(),
            Computadora.find(filtroFierros).sort({ segundosTotal: -1 }).lean(),
            Generacion.countDocuments(filtroUsuario),
            Generacion.countDocuments({
                $or: [
                    { emailDueno: { $in: clavesUnificadas } },
                    { duenoNombre: { $in: clavesUnificadas } }
                ]
            })
        ]);

        const misPeerIds = computadoras.map((c) => c.peerId);
        const porFierro = await Generacion.aggregate([
            { $match: { computadoraPeerId: { $in: misPeerIds } } },
            { $group: { _id: '$computadoraPeerId', total: { $sum: 1 } } }
        ]);
        const mapaFierro = Object.fromEntries(porFierro.map((x) => [x._id, x.total]));

        const vivo = await segundosEnVivo();
        const segundos = computadoras.reduce((a, c) => a + (c.segundosTotal || 0) + (vivo.porPeer[c.peerId] || 0), 0);
        const bytes = assets.reduce((a, x) => a + (x.bytes || 0), 0);

        return {
            usuario: usuario || { email: clave, username: clave, displayName: clave },
            assets: assets.map((x) => ({ publicId: x.publicId, url: x.url, tipo: x.tipo, bytes: x.bytes, cuando: x.cuando, prompt: x.prompt, ubicacion: x.ubicacion || (x.url ? 'nube' : 'local'), computadoraNombre: x.computadoraNombre || '', modelo: x.modelo || '' })),
            totales: {
                assets: await Asset.countDocuments(filtroUsuario),
                bytes,
                computadoras: computadoras.length,
                segundosComputadora: segundos,
                generacionesPedidas: pidio,
                generacionesProvistas: sirvio
            },
            computadoras: computadoras.map((c) => ({
                peerId: c.peerId, nombre: c.nombre, gpu: c.gpu, compartir: c.compartir,
                segundosTotal: (c.segundosTotal || 0) + (vivo.porPeer[c.peerId] || 0),
                enVivo: !!vivo.porPeer[c.peerId],
                conectada: !!vivo.porPeer[c.peerId] || ((Date.now() - new Date(c.ultimoVisto || 0).getTime()) < 2 * 60 * 1000),
                sesiones: c.sesiones || 0,
                ultimoVisto: c.ultimoVisto, primerVisto: c.primerVisto,
                generaciones: mapaFierro[c.peerId] || 0
            }))
        };
    } catch (e) { console.log('⚠️  IACOMFY estadísticas: ' + e.message); return null; }
}

// (c) RANKING DE LOS FIERROS
//   orden = 'tiempo'       -> usuario con la computadora prendida más tiempo
//           'generaciones' -> cuántas generaciones proveyó cada usuario
//           'fierros'      -> quién puso más computadoras en la red
async function ranking(orden) {
    if (!conectado) return null;
    const cual = ['tiempo', 'generaciones', 'fierros'].includes(orden) ? orden : 'tiempo';
    try {
        const vivo = await segundosEnVivo();

        // ---- alias: cualquier clave (email o username) -> email canónico ----
        // Esto es lo que faltaba: las generaciones viejas guardaron el USERNAME
        // como dueño y el ranking las perdía. Ahora se cruzan las dos formas.
        const users = await Usuario.find({}, { email: 1, username: 1, displayName: 1, avatar: 1 }).lean();
        const canónico = {};   // 'jpupper' | 'julian@puppo...' -> 'julian@puppo...'
        const info = {};       // email canónico -> { email, username, displayName, avatar }
        for (const u of users) {
            const email = String(u.email || '').toLowerCase();
            const user = String(u.username || '').toLowerCase();
            // La clave es el USERNAME: en la base hay cuentas duplicadas (una con el
            // email real y otra con el username como email) y así se muestran una sola vez.
            const clave = user || email;
            if (!clave) continue;
            if (email) canónico[email] = clave;
            if (user) canónico[user] = clave;
            const previo = info[clave] || {};
            const emailReal = (email.indexOf('@') > 0) ? u.email : (previo.email || '');
            info[clave] = {
                email: emailReal || previo.email || '', username: u.username || previo.username || '',
                displayName: u.displayName || previo.displayName || u.username || '',
                avatar: u.avatar || previo.avatar || ''
            };
        }
        const can = (v) => canónico[String(v || '').toLowerCase()] || String(v || '').toLowerCase();

        const [comps, gens] = await Promise.all([
            Computadora.find({}).lean(),
            Generacion.find({}, { email: 1, emailDueno: 1, computadoraPeerId: 1 }).lean()
        ]);

        const filasPorDueno = {};
        const fila = (k) => (filasPorDueno[k] = filasPorDueno[k] || {
            clave: k, computadoras: new Set(), segundos: 0, sesiones: 0,
            provistas: 0, pedidas: 0, ultimoVisto: 0
        });

        for (const c of comps) {
            // una PC puede no tener email (se conectó sin sesión, o se recuperó de
            // los logs): en ese caso se cuenta por username, si no desaparece.
            const k = can(c.email || c.username);
            if (!k) continue;
            const f = fila(k);
            f.computadoras.add(c.peerId || String(c._id));
            f.segundos += Number(c.segundosTotal || 0);
            f.sesiones += Number(c.sesiones || 0);
            f.ultimoVisto = Math.max(f.ultimoVisto, new Date(c.ultimoVisto || 0).getTime());
            if (!info[k] && c.username) {
                info[k] = { email: c.email || '', username: c.username || '', displayName: c.username || '', avatar: c.avatar || '' };
            }
        }
        for (const g of gens) {
            const kd = can(g.emailDueno);
            if (kd) {
                const f = fila(kd);
                f.provistas++;
                if (g.computadoraPeerId) f.computadoras.add(g.computadoraPeerId);
            }
            const kp = can(g.email);
            if (kp) fila(kp).pedidas++;
        }
        // tiempo en vivo (sesiones abiertas) al dueño que corresponde
        for (const [em, seg] of Object.entries(vivo.porEmail || {})) {
            const k = can(em);
            if (filasPorDueno[k]) filasPorDueno[k].segundos += Number(seg || 0);
        }

        // pedidos anónimos ("sin sesión") no van al ranking: ensucian la tabla
        const SIN_DUENO = ['', 'sin sesión', 'sin sesion', 'anónimo', 'anonimo', 'desconocido', 'local', 'undefined', 'null'];
        const filas = Object.values(filasPorDueno)
            .filter((f) => SIN_DUENO.indexOf(String(f.clave || '').trim().toLowerCase()) < 0)
            .map((f) => {
            const i = info[f.clave] || {};
            const emailReal = i.email || f.clave;
            return {
                email: emailReal,
                usuario: i.username || f.clave,
                displayName: i.displayName || i.username || '',
                avatar: i.avatar || '',
                computadoras: f.computadoras.size,
                segundosComputadora: f.segundos,
                seguido: Math.max(0, ...[...f.computadoras].map((pid) => Number((vivo.porPeerSeguido && vivo.porPeerSeguido[pid]) || 0)),
                    Number((vivo.seguidoPorEmail && vivo.seguidoPorEmail[String(emailReal).toLowerCase()]) || 0)),
                sesiones: f.sesiones,
                generacionesProvistas: f.provistas,
                generacionesPedidas: f.pedidas,
                enLinea: enLineaDe(emailReal, f.ultimoVisto, vivo),
                ultimoVisto: f.ultimoVisto ? new Date(f.ultimoVisto).toISOString() : null
            };
        });

        const ordenar = {
            tiempo: (a, b) => b.segundosComputadora - a.segundosComputadora,
            generaciones: (a, b) => (b.generacionesProvistas - a.generacionesProvistas) || (b.segundosComputadora - a.segundosComputadora),
            fierros: (a, b) => (b.computadoras - a.computadoras) || (b.segundosComputadora - a.segundosComputadora)
        };
        filas.sort(ordenar[cual]);
        return { orden: cual, filas: filas.slice(0, 25).map((f, i) => Object.assign({ puesto: i + 1 }, f)) };
    } catch (e) { console.log('⚠️  IACOMFY ranking: ' + e.message); return null; }
}

// Resumen general (para la portada del ranking)
async function resumen() {
    if (!conectado) return null;
    try {
        const [usuarios, computadoras, generaciones, assets, segundos] = await Promise.all([
            Usuario.countDocuments(), Computadora.countDocuments(),
            Generacion.countDocuments(), Asset.countDocuments(),
            Computadora.aggregate([{ $group: { _id: null, total: { $sum: '$segundosTotal' } } }])
        ]);
        return {
            usuarios, computadoras, generaciones, assets,
            segundosComputadora: (segundos[0] && segundos[0].total) || 0,
            enLinea: await Computadora.countDocuments({ ultimoVisto: { $gte: new Date(Date.now() - 60000) } })
        };
    } catch (e) { return null; }
}

module.exports = {
    conectar, estadoDb, segundosEnVivo, cerrarSesionesViejas,
    anotarUsuario, anotarAsset, latidoDeComputadora, cerrarSesion, anotarGeneracion, enLineaDe,
    leerLimiteMB, guardarLimiteMB, puedeSubir, LIMITE_DEFECTO_MB,
    rolEnElEcosistema, esAdminDelEcosistema,
    estadisticasDe, ranking, resumen,
    modelos: { Usuario, Asset, Computadora, Sesion, Generacion }
};
