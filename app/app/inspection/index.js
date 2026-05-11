'use strict';

const express = require('express');
const controller = require('./inspection');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");
const allFileUpload = require('../../middlewares/upload');

router.post('/inspectVehicle', requireLogin, allFileUpload.fields([{ name: 'images' }, { name: 'inspected_images' }, { name: 'odometer_images' }]), controller.inspectVehicle);
router.post('/tyresVerification', requireLogin, controller.createTyreVerification);
router.post('/xe/tyresVerification', requireLogin, controller.xeCreateTyreVerification);
router.put('/tyreInspection/complete/:id', requireLogin, controller.completeTyreInspection);
router.put('/xe/tyreInspection/complete/:id', requireLogin, controller.xeCompleteTyreInspection);
router.put('/tyreVerification/update/:id', requireLogin, controller.updateTyreVerification);
router.put('/xe/tyresVerification/update/:id', requireLogin, controller.xeUpdateTyreVerification);
router.get('/tyresVerification/:id', requireLogin, controller.getTyreVerification);
router.get('/xe/tyresVerification/:id', requireLogin, controller.xeGetTyreVerification);
router.get('/steps/asset/:id', requireLogin, controller.getInspectionSteps);
router.get('/xe/steps/asset/:id', requireLogin, controller.xeGetInspectionSteps);
router.get('/nearbyZones', requireLogin, controller.nearbyZones);
router.get('/observations', requireLogin, controller.listObservations);
router.get('/asset/inspectionHistory', requireLogin, controller.assetInspectionHist);
router.get('/asset/inspectionHistory/:id', requireLogin, controller.assetInspectionHistById);
router.get('/asset/lastInspection/:id', requireLogin, controller.assetLastInspection);
router.get('/asset/lastConsolidateInspection/:id', requireLogin, controller.assetLastConsolidateInspection);
router.get('/history/:id', requireLogin, controller.inspectionHistory);

module.exports = router;