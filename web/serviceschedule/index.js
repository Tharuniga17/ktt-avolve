'use strict';

const express = require('express');
const controller = require('./serviceschedule');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");

router.get('/list', requireLogin, controller.list);
router.get('/vehicles', requireLogin, controller.vehicleInfo);

module.exports = router;