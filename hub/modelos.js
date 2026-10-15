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
    url: { type: String, required: true },                      // URL pública de R2
    key: { type: String, default: '' },                         // clave en el bucket
    tipo: { type: String, default: 'image' },                   // image | video | audio
    mimetype: { type: String, default: '' },
    bytes: { type: Number, default: 0 },
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
    const clave = d.email || d.username;
    if (!clave) return null;
    try {
        return await Usuario.findOneAndUpdate(
            { email: clave },
            {
                $set: { username: d.username, displayName: d.displayName, avatar: d.avatar, ultimaVez: new Date() },
                $setOnInsert: { primeraVez: new Date() },
                $inc: { vistas: 1 }
            },
            { upsert: true, new: true }
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
                    computadoraPeerId: a.computadoraPeerId || '', computadoraNombre: a.computadoraNombre || '',
                    modelo: a.modelo || '', prompt: String(a.prompt || '').slice(0, 400)
                },
                $setOnInsert: { cuando: new Date() }
            },
            { upsert: true, new: true }
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
        const comp = await Computadora.findOneAndUpdate(
            { peerId: peer.id },
            { $set: set, $setOnInsert: { primerVisto: new Date() } },
            { upsert: true, new: true }
        );
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
            emailDueno: String(comp.duenoEmail || comp.dueno || '').toLowerCase(),
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
    if (!conectado) return { porEmail: {}, porPeer: {} };
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
        return { porEmail, porPeer };
    } catch (e) { return { porEmail: {}, porPeer: {} }; }
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
        const usuario = await Usuario.findOne({ $or: [{ email: clave }, { username: clave }] }).lean();
        const yo = usuario ? usuario.email : clave;

        const [assets, computadoras, pidio, sirvio] = await Promise.all([
            Asset.find({ email: yo }).sort({ cuando: -1 }).limit(60).lean(),
            Computadora.find({ $or: [{ email: yo }, { emailDueno: yo }] }).sort({ segundosTotal: -1 }).lean(),
            Generacion.countDocuments({ email: yo }),
            Generacion.countDocuments({ emailDueno: yo })
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
            usuario: usuario || { email: yo, username: clave, displayName: clave },
            assets: assets.map((x) => ({ publicId: x.publicId, url: x.url, tipo: x.tipo, bytes: x.bytes, cuando: x.cuando, prompt: x.prompt })),
            totales: {
                assets: await Asset.countDocuments({ email: yo }),
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
        if (cual === 'generaciones') {
            // generaciones que SALIERON de los fierros de cada dueño
            const filas = await Generacion.aggregate([
                { $match: { emailDueno: { $ne: '' } } },
                {
                    $group: {
                        _id: '$emailDueno', generaciones: { $sum: 1 },
                        usuario: { $last: '$duenoNombre' }, computadoras: { $addToSet: '$computadoraPeerId' }
                    }
                },
                { $sort: { generaciones: -1 } }, { $limit: 25 }
            ]);
            // las que pidió cada uno (para el detalle)
            const pedidas = await Generacion.aggregate([
                { $match: { email: { $ne: '' } } }, { $group: { _id: '$email', pidio: { $sum: 1 } } }
            ]);
            const mapaPedidas = Object.fromEntries(pedidas.map((x) => [x._id, x.pidio]));
            const segundos = await Computadora.aggregate([{ $group: { _id: '$email', segundos: { $sum: '$segundosTotal' } } }]);
            const mapaSeg = Object.fromEntries(segundos.map((x) => [x._id, x.segundos]));
            return {
                orden: cual,
                filas: filas.map((f, i) => ({
                    puesto: i + 1, email: f._id, usuario: f.usuario || f._id,
                    generacionesProvistas: f.generaciones, generacionesPedidas: mapaPedidas[f._id] || 0,
                    enLinea: enLineaDe(f._id, null, vivo),
                    computadoras: f.computadoras.filter(Boolean).length,
                    segundosComputadora: (mapaSeg[f._id] || 0) + (vivo.porEmail[f._id] || 0),
                    enLinea: enLineaDe(f._id, f.ultimoVisto, vivo)
                }))
            };
        }

        if (cual === 'fierros') {
            const filas = await Computadora.aggregate([
                { $match: { email: { $ne: '' } } },
                {
                    $group: {
                        _id: '$email', computadoras: { $sum: 1 }, segundos: { $sum: '$segundosTotal' },
                        usuario: { $last: '$nombre' }, ultimo: { $max: '$ultimoVisto' }
                    }
                },
                { $sort: { computadoras: -1, segundos: -1 } }, { $limit: 25 }
            ]);
            const gen = await Generacion.aggregate([{ $group: { _id: '$emailDueno', total: { $sum: 1 } } }]);
            const mapaGen = Object.fromEntries(gen.map((x) => [x._id, x.total]));
            return {
                orden: cual,
                filas: filas.map((f, i) => ({
                    puesto: i + 1, email: f._id, usuario: f.usuario || f._id,
                    computadoras: f.computadoras, segundosComputadora: f.segundos + (vivo.porEmail[f._id] || 0),
                    enLinea: enLineaDe(f._id, f.ultimoVisto, vivo),
                    generacionesProvistas: mapaGen[f._id] || 0, ultimoVisto: f.ultimo
                }))
            };
        }

        // tiempo (por defecto): el fierro que más tiempo estuvo prendido
        const filas = await Computadora.aggregate([
            { $match: { email: { $ne: '' } } },
            {
                $group: {
                    _id: '$email', segundos: { $sum: '$segundosTotal' },
                    computadoras: { $sum: 1 }, sesiones: { $sum: '$sesiones' },
                    usuario: { $last: '$nombre' }, ultimoVisto: { $max: '$ultimoVisto' }
                }
            },
            { $sort: { segundos: -1 } }, { $limit: 25 }
        ]);
        const gen = await Generacion.aggregate([{ $group: { _id: '$emailDueno', total: { $sum: 1 } } }]);
        const mapaGen = Object.fromEntries(gen.map((x) => [x._id, x.total]));
        const ped = await Generacion.aggregate([{ $group: { _id: '$email', total: { $sum: 1 } } }]);
        const mapaPed = Object.fromEntries(ped.map((x) => [x._id, x.total]));
        return {
            orden: cual,
            filas: filas.map((f, i) => ({
                puesto: i + 1, email: f._id, usuario: f.usuario || f._id,
                segundosComputadora: f.segundos, computadoras: f.computadoras, sesiones: f.sesiones,
                generacionesProvistas: mapaGen[f._id] || 0, generacionesPedidas: mapaPed[f._id] || 0,
                ultimoVisto: f.ultimoVisto
            }))
        };
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
    estadisticasDe, ranking, resumen,
    modelos: { Usuario, Asset, Computadora, Sesion, Generacion }
};
