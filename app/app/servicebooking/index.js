'use strict';

const express = require('express');
const controller = require('./servicebooking');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");

router.post('/', requireLogin, controller.create);
router.post('/adhoc/create', requireLogin, controller.createAdhoc);
router.post('/onboarding/request', requireLogin, controller.onboardingRequest);
router.get('/listByStatus', requireLogin, controller.listByStatus);
router.get('/missedList/download', requireLogin, controller.missedListDownload);
router.get('/missedList', requireLogin, controller.missedList);
router.get('/reject/reasons', requireLogin, controller.rejectReasons);
router.get('/:id', requireLogin, controller.get);
router.put('/reschedule/:id', requireLogin, controller.reschedule);
router.put('/gatein/:id', requireLogin, controller.gateIn);
router.put('/approve/:id', requireLogin, controller.approve);
router.put('/reject/:id', requireLogin, controller.reject);
router.get('/services/asset/:id', requireLogin, controller.getServicesByAsset);

module.exports = router;