'use strict';

const express = require('express');
const controller = require('./tyreMakeModel');
const helper = require('../../middlewares/helper');
const requireLogin = helper.requireLogin;
const router = express.Router();

router.get('/list', requireLogin, controller.list);
router.get('/count', requireLogin, controller.count);
router.get('/distinct/models', requireLogin, controller.getDistinctModels);
router.get('/:id', requireLogin, controller.get);

router.put('/:id', requireLogin, controller.update);

router.post('/', requireLogin, controller.create);

module.exports = router;