'use strict';

const express = require('express');
const router = express.Router();
const controller = require('./upload');

router.get('/file/*', controller.getFile); // Temporarily allow all requests - requireAdminLogin

module.exports = router;