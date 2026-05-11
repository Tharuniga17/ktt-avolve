'use strict';

const express = require('express');
const controller = require('./insights');
const { requireLogin } = require('../../middlewares/helper');
const router = express.Router();
const fields = ['assetIds']

router.get('/list/:type', requireLogin, controller.getInsights);
router.get('/list-by-type', requireLogin, controller.getInsightsByType);

router.post('/create', requireLogin, controller.createInsight);

module.exports = router;