'use strict';

const express = require('express');
const controller = require('./asset');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");
const allFileUpload = require('../../middlewares/upload')

router.get('/get/:id', requireLogin, controller.getVehicle);
router.get('/listSelect', requireLogin, controller.listSelect);
router.get('/payKmList', requireLogin, controller.payKmList);
router.get('/listByUser', requireLogin, controller.listByUser);
router.get('/listByUser/download', requireLogin, controller.listByUserDownload);
router.get('/listByStatus', requireLogin, controller.listByStatus);
router.get('/count/geozone/:id', requireLogin, controller.countByGeozone);
router.get('/list/mf', requireLogin, controller.listMFVehicles);
router.get('/customerAssets', requireLogin, controller.listCustomerAssets);
router.get('/list', requireLogin, controller.listAssets);
router.get('/apollofleet/:id', requireLogin, controller.getApolloFleetAsset);
router.put('/updateOdo/:id', requireLogin, controller.updateOdo); //web
router.post('/multiple/delete', requireLogin, controller.deleteAssets);
router.post('/mf', requireLogin, controller.monitoredFitment);
router.post('/create', requireLogin, allFileUpload.array('rcImages'), controller.createAsset);
router.get('/count', requireLogin, controller.listCount);
router.get('/list/axleConfigs', requireLogin, controller.listAxleConfigs);
router.get('/list/axleProfiles', requireLogin, controller.listAxleProfiles);

module.exports = router;