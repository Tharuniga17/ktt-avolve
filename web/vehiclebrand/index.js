'use strict';

const express = require('express');
const controller = require('./vehiclebrand');
const { requireLogin } = require('../../middlewares/helper');
const router = express.Router();

router.get('/list', requireLogin, controller.list);

module.exports = router;