'use strict';

const express = require('express');
const controller = require('./account');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");
const allFileUpload = require("../../middlewares/upload");

//Apollo Fleet
router.post('/serviceConfig/bulkupload', requireLogin, allFileUpload.single('file'), controller.serviceConfigBulkUpdate);
router.post('/psiConfig/bulkupload', requireLogin, allFileUpload.single('file'), controller.psiConfigBulkUpdate);
router.post('/web/create', requireLogin, controller.createWeb);
router.post('/fts/create', requireLogin, controller.ftsCreate);
router.post('/tis/create/:id', requireLogin, controller.tisCreate);
router.post('/fts/bulkCreate', requireLogin, allFileUpload.single('accountSheet'), controller.ftsBulkCreate);

router.get('/listWeb', requireLogin, controller.listWeb);
router.get('/listPaykm', requireLogin, controller.listPaykm);
router.get('/list', requireLogin, controller.list);
router.get('/list/customers', requireLogin, controller.listCustomers);
router.get('/vendors', requireLogin, controller.listVendors);
router.get('/listByUser/web', requireLogin, controller.listByUserWeb);
router.get('/listByUser', requireLogin, controller.listByUser);
router.get('/summary/:id', requireLogin, controller.getAccountSummary);
router.get('/serviceMaster/:id', requireLogin, controller.getServiceMaster);
router.get('/serviceConfig', requireLogin, controller.serviceConfig);
router.get('/offer/config', requireLogin, controller.getOfferConfig);
router.get('/offer/:id', requireLogin, controller.getOffer);
router.get('/vehicleGroups/list', requireLogin, controller.vehicleGroupsList);
router.get('/draft/list', requireLogin, controller.draftList);
router.get('/draft/:id', requireLogin, controller.getDraftAccount);
router.get('/count', requireLogin, controller.count);
router.get('/offer/web/:id', requireLogin, controller.getOfferWeb);
router.get('/:id', requireLogin, controller.getAccount);
router.get('/syncServiceMaster/:id', requireLogin, controller.syncServiceMaster);
router.get('/syncIPMaster/:id', requireLogin, controller.syncIPMaster);

router.put('/draft/update/:id', requireLogin, controller.draftUpdate);
router.put('/offer/update/:id', requireLogin, controller.offerUpdate);

module.exports = router;