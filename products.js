// {nick} se reemplaza por el nombre del jugador (ya validado).
// Preferible un solo comando por producto para que los reintentos no dupliquen entregas parciales.
module.exports = {
  vip: {
    name: 'Rango VIP',
    description: 'Kit VIP, prefijo y comandos exclusivos',
    price: 9.99,
    commands: ['lp user {nick} parent add vip'],
  },
  mvp: {
    name: 'Rango MVP',
    description: 'Todo lo de VIP + beneficios premium',
    price: 19.99,
    commands: ['lp user {nick} parent add mvp'],
  },
  llaves: {
    name: 'Pack 5 Llaves',
    description: '5 llaves de caja épica',
    price: 4.99,
    commands: ['crate key give {nick} epic 5'], // ajusta a tu plugin de crates
  },
};
