// Punto de entrada para hostings con "Setup Node.js App" (cPanel/Passenger),
// que cargan el archivo con require() en vez de ejecutarlo directamente.
require('./server/index').start();
