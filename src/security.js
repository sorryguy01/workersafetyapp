'use strict';

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Hash a password with a per-user random salt. Returns hex strings. */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS, (err, key) => {
      if (err) return reject(err);
      resolve({ hash: key.toString('hex'), salt });
    });
  });
}

/** Constant-time password verification. */
function verifyPassword(password, salt, expectedHex) {
  return new Promise((resolve) => {
    try {
      const expected = Buffer.from(String(expectedHex), 'hex');
      crypto.scrypt(String(password), String(salt), SCRYPT_KEYLEN, SCRYPT_OPTIONS, (err, key) => {
        if (err) return resolve(false);
        resolve(expected.length === key.length && crypto.timingSafeEqual(expected, key));
      });
    } catch {
      resolve(false);
    }
  });
}

// Used for unknown accounts so failed logins take the same time as real ones.
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
const DUMMY_HASH = crypto.scryptSync('notice-no-such-operator', DUMMY_SALT, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString('hex');

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time string comparison for CSRF tokens. */
function safeEqual(a, b) {
  try {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256,
  safeEqual,
  DUMMY_SALT,
  DUMMY_HASH,
};
