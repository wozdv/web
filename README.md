# Tienda gaming (PayPal + RCON)

## Instalación
1. `npm install`
2. Copia `.env.example` a `.env` y rellena tus credenciales.
3. En el servidor de Minecraft (`server.properties`):
   ```
   enable-rcon=true
   rcon.port=25575
   rcon.password=la_misma_clave_del_.env
   ```
   y reinícialo. No expongas el puerto RCON a internet.
4. En developer.paypal.com crea el webhook `https://tudominio.com/webhook/paypal`
   con el evento "Payment capture completed" y copia su ID a `PAYPAL_WEBHOOK_ID`.
   (En local usa ngrok o cloudflared para tener HTTPS.)
5. `npm start` y abre http://localhost:3000

## Archivos clave
- `products.js`: catálogo, precios y comandos RCON.
- `data/delivered.json`: pagos ya entregados (idempotencia).
- `data/failed.log`: entregas fallidas para revisar o reembolsar a mano.

## Producción
Cambia `PAYPAL_ENV=live` con credenciales y webhook Live; usa HTTPS y `pm2 start server.js`.
