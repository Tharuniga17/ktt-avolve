'use strict';

const express = require('express');
const controller = require('./account');
const router = express.Router();
const { requireLogin } = require('../../middlewares/helper');
const allFileUpload = require('../../middlewares/upload');

router.get('/list', requireLogin, controller.list);
router.get('/list/paykm', requireLogin, controller.listPaykm);
router.get('/regions', controller.regions);
router.get('/region', controller.region);
router.get('/offer/config', requireLogin, controller.getOfferConfig);
router.get('/offer/list', requireLogin, controller.offerList);
router.get('/offer/:id', requireLogin, controller.getOffer);
router.get('/syncServiceMaster/:id', requireLogin, controller.syncServiceMaster);
router.get('/syncIPMaster/:id', requireLogin, controller.syncIPMaster);
router.get('/master/details/:id', requireLogin, controller.getAccMasterDetails);

router.put('/offerUpdate/:id', requireLogin, controller.offerUpdate);
router.put('/signIn/trigger/:id', requireLogin, controller.signInTrigger);

router.post('/serviceConfig/bulkupload', requireLogin, allFileUpload.single('file'), controller.serviceConfigBulkUpdate);
router.post('/psiConfig/bulkupload', requireLogin, allFileUpload.single('file'), controller.psiConfigBulkUpdate);

module.exports = router;