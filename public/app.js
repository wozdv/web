const NICK_REGEX = /^[A-Za-z0-9_]{3,16}$/;
const $ = (id) => document.getElementById(id);
const nickInput = $('nick');
let selected = null;
let currency = 'USD';

const setStatus = (msg, type) => { const s = $('status'); s.textContent = msg; s.className = type || ''; };

async function init() {
  const [config, products] = await Promise.all([
    fetch('/api/config').then((r) => r.json()),
    fetch('/api/products').then((r) => r.json()),
  ]);
  currency = config.currency;

  const grid = $('products');
  products.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'card';
    const h = document.createElement('h3'); h.textContent = p.name;
    const d = document.createElement('p'); d.textContent = p.description;
    const pr = document.createElement('div'); pr.className = 'price';
    pr.textContent = `${p.price.toFixed(2)} ${currency}`;
    card.append(h, d, pr);
    card.onclick = () => {
      document.querySelectorAll('.card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      selected = p;
      $('summary').textContent = `${p.name} — ${p.price.toFixed(2)} ${currency}`;
      $('checkout').hidden = false;
    };
    grid.append(card);
  });

  nickInput.addEventListener('input', () => {
    nickInput.classList.toggle('invalid', nickInput.value !== '' && !NICK_REGEX.test(nickInput.value));
  });

  // Cargar el SDK de PayPal con el client-id del servidor
  const script = document.createElement('script');
  script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.clientId)}&currency=${currency}`;
  script.onload = renderButtons;
  document.head.append(script);
}

function renderButtons() {
  paypal.Buttons({
    style: { theme: 'black', color: 'blue', shape: 'rect', label: 'pay' },

    // Bloquea el pago si no hay nick válido o producto
    onClick: (_data, actions) => {
      if (!NICK_REGEX.test(nickInput.value)) {
        nickInput.classList.add('invalid'); nickInput.focus();
        setStatus('Debes ingresar un nick válido antes de comprar.', 'err');
        return actions.reject();
      }
      if (!selected) { setStatus('Selecciona un producto.', 'err'); return actions.reject(); }
      setStatus('');
      return actions.resolve();
    },

    createOrder: async () => {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: selected.id, nick: nickInput.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al crear la orden');
      return data.id;
    },

    onApprove: async (data) => {
      const res = await fetch(`/api/orders/${data.orderID}/capture`, { method: 'POST' });
      const out = await res.json();
      if (res.ok && out.status === 'COMPLETED') {
        setStatus(`✅ ¡Pago recibido! Tu compra se entregará en segundos a ${nickInput.value}. Entra al servidor.`, 'ok');
      } else {
        setStatus('El pago no se completó. Si te cobraron, contacta a soporte con tu ID: ' + data.orderID, 'err');
      }
    },

    onCancel: () => setStatus('Pago cancelado.', 'err'),
    onError: (err) => { console.error(err); setStatus('Error con PayPal. Intenta de nuevo.', 'err'); },
  }).render('#paypal-buttons');
}

init().catch(() => setStatus('No se pudo cargar la tienda.', 'err'));
