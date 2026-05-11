'use strict';

const express = require('express');
const controller = require('./geozone');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");

router.get('/listByRole', requireLogin, controller.listByRole);
router.get('/mapview', requireLogin, controller.mapview);
router.get('/listCities', requireLogin, controller.listCities);
router.get('/zonetypes', requireLogin, controller.zoneTypes);
router.get('/nearbyZones', requireLogin, controller.nearbyZones);

module.exports = router;