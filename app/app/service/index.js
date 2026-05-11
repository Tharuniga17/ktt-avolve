'use strict';

const express = require('express');
const controller = require('./service');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");

router.get('/asset', requireLogin, controller.getServices);
router.get('/summary/content', requireLogin, controller.getSummaryContent);
router.get('/list',  requireLogin, controller.list);

module.exports = router;