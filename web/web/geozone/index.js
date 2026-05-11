'use strict';

const express = require('express');
const controller = require('./geozone');
const router = express.Router();
const { requireLogin } = require('../../middlewares/helper');

router.get('/list', requireLogin, controller.list);
router.get('/listByType', requireLogin, controller.listByType);
router.get('/zoneTypes', requireLogin, controller.zoneTypes);
router.get('/customerList/:id', requireLogin, controller.getCustomerList);
router.get('/:id', requireLogin, controller.get);

router.put('/assignCustomer/:id', requireLogin, controller.assignCustomer);

module.exports = router;