#!/usr/bin/env node
const bcrypt = require('bcrypt');

const pw = process.argv[2];
if (!pw) {
    console.error('Usage: node scripts/hash-password.js <password>');
    process.exit(1);
}
bcrypt.hash(pw, parseInt(process.env.BCRYPT_ROUNDS, 10) || 10)
    .then(h => console.log(h))
    .catch(err => { console.error(err); process.exit(1); });
