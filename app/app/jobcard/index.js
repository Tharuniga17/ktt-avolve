'use strict';

const express = require('express');
const controller = require('./jobcard');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");
const allFileUpload = require('../../middlewares/upload');

router.post('/', requireLogin, controller.create);
router.get('/serviceLogs', requireLogin, controller.getServiceLogs);
router.get('/listByStatus', requireLogin, controller.listByStatus);
router.get('/histories/asset', requireLogin, controller.assetJobHist);
router.get('/history/asset/:id', requireLogin, controller.assetJobHistById);
router.get('/:id', requireLogin, controller.get);
router.get('/log/:id', requireLogin, controller.getLog);
router.get('/asset/:id', requireLogin, controller.getJobCardbyAsset);
router.put('/execute/:id', requireLogin, allFileUpload.array('images'), controller.execute);
router.put('/approve/:id', requireLogin, controller.approve);
router.put('/complete/:id', requireLogin, allFileUpload.array('images'), controller.complete);
router.put('/gatepass/:id', requireLogin, allFileUpload.array('images'), controller.gatepass);

module.exports = router;