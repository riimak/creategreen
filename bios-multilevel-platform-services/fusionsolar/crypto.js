const crypto = require('node:crypto');

function createTokenCipher(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('token cipher requires 32-byte key');
  }

  return {
    encrypt(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(String(plaintext), 'utf8'),
        cipher.final(),
      ]);

      return {
        version: 1,
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      };
    },

    decrypt(envelope) {
      if (envelope?.version !== 1) {
        throw new Error('unsupported token envelope');
      }

      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));

      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

module.exports = { createTokenCipher };
