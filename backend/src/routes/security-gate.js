// routes/security-gate.js
// Thin wrapper so the security gate can be mounted via loadRoute().

const express = require('express');
const router = express.Router();
const securityGate = require('../middleware/securityGate');

router.use(securityGate);

module.exports = router;
