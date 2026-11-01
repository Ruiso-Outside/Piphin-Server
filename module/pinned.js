// Conexão com o agente presa à impressão digital guardada no pareamento. O certificado é próprio (não dá para validar pela
// cadeia), então confere o que veio ANTES de entregar a conexão: nem os cabeçalhos com o token saem para um impostor.
// fingerprint "*" = primeiro contato do pareamento, antes de conhecer a máquina.
"use strict";
const https = require("https");
const tls = require("tls");

const MISMATCH = "A identidade da máquina mudou (certificado diferente). Por segurança, remova e pareie de novo.";

class PinnedAgent extends https.Agent {
  constructor(fingerprint) { super({ keepAlive: false }); this.fingerprint = fingerprint; }
  createConnection(options, callback) {
    const socket = tls.connect({ host: options.host, port: options.port, rejectUnauthorized: false, ...(options.timeout ? { timeout: options.timeout } : {}) });
    const onError = (e) => callback(e);
    socket.once("error", onError);
    socket.once("secureConnect", () => {
      socket.removeListener("error", onError);
      const cert = socket.getPeerCertificate();
      if (this.fingerprint !== "*" && (!cert || cert.fingerprint256 !== this.fingerprint)) { socket.destroy(); return callback(new Error(MISMATCH)); }
      callback(null, socket);
    });
  }
}
module.exports = { PinnedAgent, MISMATCH };
