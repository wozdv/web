require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const { Rcon } = require('rcon-client');
const fs = require('fs');
const path = require('path');
const PRODUCTS = require('./products');

// ───────────── Configuración ─────────────
const {
  PORT = 3000,
  PAYPAL_ENV = 'sandbox',
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_WEBHOOK_ID,
  CURRENCY = 'USD',
  RCON_HOST = '127.0.0.1',
  RCON_PORT = 25575,
  RCON_PASSWORD,
} = process.env;

for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID', 'RCON_PASSWORD']) {
  if (!process.env[k]) {
    console.error(`❌ Falta la variable ${k} en .env`);
    process.exit(1);
  }
}

const PAYPAL_API =
  PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const NICK_REGEX = /^[A-Za-z0-9_]{3,16}$/; // Java. Para Bedrock/Geyser adapta (prefijo ".")

// ───────────── Persistencia simple (idempotencia) ─────────────
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'delivered.json');
const FAIL_LOG = path.join(DATA_DIR, 'failed.log');
fs.mkdirSync(DATA_DIR, { recursive: true });

const loadDb = () => {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
};
const saveDb = (db) => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const logFailure = (msg) =>
  fs.appendFileSync(FAIL_LOG, `[${new Date().toISOString()}] ${msg}\n`);
const inFlight = new Set(); // evita procesar dos veces el mismo pago en paralelo

// ───────────── PayPal helpers ─────────────
let tokenCache = { value: null, exp: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth falló (${res.status})`);
  const data = await res.json();
  tokenCache = { value: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return tokenCache.value;
}

async function paypal(endpoint, body) {
  const token = await getAccessToken();
  const res = await fetch(`${PAYPAL_API}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`PayPal ${endpoint} → ${res.status}`);
    err.details = data;
    throw err;
  }
  return data;
}

async function verifyWebhook(req) {
  const h = req.headers;
  const result = await paypal('/v1/notifications/verify-webhook-signature', {
    auth_algo: h['paypal-auth-algo'],
    cert_url: h['paypal-cert-url'],
    transmission_id: h['paypal-transmission-id'],
    transmission_sig: h['paypal-transmission-sig'],
    transmission_time: h['paypal-transmission-time'],
    webhook_id: PAYPAL_WEBHOOK_ID,
    webhook_event: JSON.parse(req.rawBody),
  });
  return result.verification_status === 'SUCCESS';
}

// ───────────── RCON ─────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RCON_ERRORS = /could not be found|unknown or incomplete|unknown command|no such|not found/i;

async function runRcon(commands, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    let rcon;
    try {
      rcon = await Rcon.connect({
        host: RCON_HOST,
        port: Number(RCON_PORT),
        password: RCON_PASSWORD,
        timeout: 5000,
      });
      rcon.on('error', (e) => console.error('RCON error:', e.message));

      const outputs = [];
      for (const cmd of commands) {
        const out = await rcon.send(cmd);
        console.log(`RCON ▶ ${cmd} ◀ ${out}`);
        // RCON devuelve texto; un error de comando NO lanza excepción
        if (RCON_ERRORS.test(out)) throw new Error(`Comando rechazado: "${out}"`);
        outputs.push(out);
      }
      return outputs;
    } catch (err) {
      lastErr = err;
      const reason =
        err.code === 'ECONNREFUSED' ? 'servidor apagado o puerto RCON cerrado'
        : err.code === 'ETIMEDOUT' || /timeout/i.test(err.message) ? 'timeout (IP/puerto/firewall)'
        : /auth/i.test(err.message) ? 'contraseña RCON incorrecta'
        : err.message;
      console.error(`RCON intento ${i}/${attempts} falló: ${reason}`);
      if (i < attempts) await sleep(2000 * i);
    } finally {
      if (rcon) await rcon.end().catch(() => {});
    }
  }
  throw lastErr;
}

// ───────────── App ─────────────
const app = express();
app.set('trust proxy', 1); // detrás de nginx/Cloudflare
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', rateLimit({ windowMs: 60_000, max: 30 }));

app.get('/api/config', (_req, res) => res.json({ clientId: PAYPAL_CLIENT_ID, currency: CURRENCY }));

app.get('/api/products', (_req, res) => {
  res.json(
    Object.entries(PRODUCTS).map(([id, p]) => ({
      id, name: p.name, description: p.description, price: p.price,
    }))
  );
});

// Crea la orden en PayPal. El monto sale del catálogo del servidor.
app.post('/api/orders', async (req, res) => {
  try {
    const { productId, nick } = req.body || {};
    const product = PRODUCTS[productId];
    if (!product) return res.status(400).json({ error: 'Producto inválido' });
    if (typeof nick !== 'string' || !NICK_REGEX.test(nick))
      return res.status(400).json({ error: 'Nick inválido (3-16 caracteres: letras, números y _)' });

    const order = await paypal('/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: `${productId}|${nick}`, // metadato que vuelve en el webhook (máx. 127 chars)
        description: `${product.name} para ${nick}`.slice(0, 127),
        amount: { currency_code: CURRENCY, value: product.price.toFixed(2) },
      }],
    });
    res.json({ id: order.id });
  } catch (err) {
    console.error('Crear orden:', err.message, err.details || '');
    res.status(500).json({ error: 'No se pudo crear la orden' });
  }
});

// Captura el pago aprobado. La ENTREGA no se hace aquí, sino en el webhook.
app.post('/api/orders/:orderId/capture', async (req, res) => {
  try {
    const data = await paypal(`/v2/checkout/orders/${encodeURIComponent(req.params.orderId)}/capture`);
    res.json({ status: data.status });
  } catch (err) {
    console.error('Capturar orden:', err.message, err.details || '');
    res.status(500).json({ error: 'No se pudo capturar el pago' });
  }
});

// Webhook de PayPal
app.post('/webhook/paypal', async (req, res) => {
  try {
    if (!(await verifyWebhook(req))) {
      console.warn('⚠️ Webhook con firma inválida');
      return res.sendStatus(400);
    }

    const event = req.body;
    if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') return res.sendStatus(200);

    const cap = event.resource;
    const captureId = cap.id;
    const db = loadDb();

    if (db[captureId] || inFlight.has(captureId)) return res.sendStatus(200); // ya procesado

    // Extraer producto y nick de los metadatos
    const [productId, nick] = String(cap.custom_id || '').split('|');
    const product = PRODUCTS[productId];

    if (!product || !NICK_REGEX.test(nick || '')) {
      logFailure(`Metadatos inválidos. capture=${captureId} custom_id=${cap.custom_id}`);
      return res.sendStatus(200); // reintentar no ayuda; revisar manualmente
    }
    if (
      cap.status !== 'COMPLETED' ||
      cap.amount?.currency_code !== CURRENCY ||
      cap.amount?.value !== product.price.toFixed(2)
    ) {
      logFailure(`Monto/estado inesperado. capture=${captureId} amount=${JSON.stringify(cap.amount)} status=${cap.status}`);
      return res.sendStatus(200);
    }

    inFlight.add(captureId);
    try {
      const commands = product.commands.map((c) => c.replaceAll('{nick}', nick));
      await runRcon(commands);

      db[captureId] = { productId, nick, at: new Date().toISOString() };
      saveDb(db);
      console.log(`✅ Entregado ${productId} a ${nick} (capture ${captureId})`);
      return res.sendStatus(200);
    } catch (err) {
      logFailure(`ENTREGA FALLÓ capture=${captureId} producto=${productId} nick=${nick} error=${err.message}`);
      // 500 → PayPal reintentará el webhook (hasta ~3 días)
      return res.sendStatus(500);
    } finally {
      inFlight.delete(captureId);
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`🛒 Tienda en http://localhost:${PORT} (PayPal: ${PAYPAL_ENV})`));
