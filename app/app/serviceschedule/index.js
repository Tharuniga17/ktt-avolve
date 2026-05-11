'use strict';

const express = require('express');
const controller = require('./serviceschedule');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");

router.get('/reminders', requireLogin, controller.reminders);
router.get('/vehiclemodels', requireLogin, controller.vehicleModels);
router.get('/list', requireLogin, controller.list); // till now used for web

module.exports = router;