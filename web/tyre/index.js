'use strict';

const express = require('express');
const controller = require('./tyre');
const helper = require('../../middlewares/helper');
const allFileUpload = require('../../middlewares/upload');
const requireLogin = helper.requireLogin;
const router = express.Router();

router.get('/history/:tyreNo', requireLogin, controller.getTyreHistory);
router.get('/list', requireLogin, controller.list);
router.get('/payKmList', requireLogin, controller.payKmList);
router.get('/custom/list', requireLogin, controller.listCustom);
router.get("/asset/:id", requireLogin, controller.getTyresByAsset);
router.get('/listCondition', requireLogin, controller.listTyreCondition);
router.get('/:id', requireLogin, controller.get);

router.put('/:id', requireLogin, allFileUpload.array('invoiceImages'), controller.update);
router.put('/histories/update', requireLogin, controller.updateHistories);

router.post('/', requireLogin, allFileUpload.array('invoiceImages'), controller.create);
router.post('/calculate/cpkm', requireLogin, controller.calculateCPKM);

module.exports = router;