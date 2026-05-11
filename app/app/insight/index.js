'use strict';

const express = require('express');
const controller = require('./insights');
const { requireLogin } = require('../../middlewares/helper');
const router = express.Router();

router.get('/list', requireLogin, controller.listDownloads);

module.exports = router;