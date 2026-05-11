'use strict';

const express = require('express');
const controller = require('./asset');
const router = express.Router();
const { requireLogin } = require('../../middlewares/helper');

router.get("/list", requireLogin, controller.list);
router.get("/count", requireLogin, controller.count);
router.get("/listSelect", requireLogin, controller.listSelect);
router.get("/getSelect/:id", requireLogin, controller.getSelect);
router.get('/list/axleConfigs', requireLogin, controller.getAxleConfigs);
router.get('/list/axleProfiles', requireLogin, controller.getAxleProfiles);
router.get('/payKmList', requireLogin, controller.payKmList);

router.get('/list/payKm', requireLogin, controller.listPaykmVehicles);

module.exports = router;