'use strict';

const express = require('express');
const controller = require('./vendor');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");

router.get('/list', requireLogin, controller.list);
router.get('/:id', requireLogin, controller.get);
router.post('/', requireLogin, controller.create);
router.put('/assignCustomers/:id', requireLogin, controller.assignCustomers);
router.put('/:id', requireLogin, controller.update);
router.delete('/:id', requireLogin, controller.delete);

module.exports = router;