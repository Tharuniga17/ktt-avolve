'use strict';

const express = require('express');
const controller = require('./vehiclemodel');
const { requireLogin } = require('../../middlewares/helper');
const router = express.Router();

// Admin only (master account check baked into controller — or add masterOnly here)
router.get('/list', requireLogin, controller.list);
router.get('/count', requireLogin, controller.count);
router.get('/:id', requireLogin, controller.get);
router.put('/:id', requireLogin, controller.update);
router.post('/', requireLogin, controller.create);

module.exports = router;
