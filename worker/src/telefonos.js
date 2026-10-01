// Misma normalización que usa el panel (panel y worker tienen que
// coincidir 100% en esto o un chat entrante no va a encontrar al cliente).
// En vez de duplicar la función, el worker reusa el archivo del panel.
module.exports = require('../../js/telefonos.js');
