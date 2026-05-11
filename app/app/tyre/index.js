'use strict';

const express = require('express');
const controller = require('./tyre');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");
const allFileUpload = require('../../middlewares/upload');

router.get('/list', requireLogin, controller.list);
router.get('/psiDetails/asset/:id', requireLogin, controller.getPsiDetails);
router.get('/alignDetails/asset/:id', requireLogin, controller.getAlignDetails);
router.get('/history/:tyreNo', requireLogin, controller.getTyreHistory);
router.get("/history/asset/:id", requireLogin, controller.getHistoryByAsset);
router.get('/asset/:id', requireLogin, controller.getByAsset);
router.get('/payKmList', requireLogin, controller.payKmList);
router.get("/summary", requireLogin, controller.tyreSummary);
router.get("/summary/search/:tyreNo", requireLogin, controller.summarySearch);
router.get("/listByStatus", requireLogin, controller.listByStatus);
router.get("/listByStatus/search/:tyreNo", requireLogin, controller.listByStatusSearch);
router.get("/listByLife", requireLogin, controller.listByLife);
router.get("/dealers", requireLogin, controller.getDealersList);
router.get('/wearPatterns', requireLogin, controller.getWearPatterns);
router.get('/removeReasons', requireLogin, controller.getRemoveReasons);
router.get('/removeTypes', requireLogin, controller.getRemoveTypes);
router.get('/branches', requireLogin, controller.branchList);
router.get('/listCustom', requireLogin, controller.listCustom);
router.get('/list/Web', requireLogin, controller.listWeb);
router.get('/analysis/:tyreNo', requireLogin, controller.tyreAnalysis);
router.get('/reminders', requireLogin, controller.getReminders);
router.get('/listStatus', requireLogin, controller.listTyreStatus);
router.get('/:id', requireLogin, controller.get);

router.put('/web/:tyreNo', requireLogin, controller.updateWeb);
router.put('/histories/update', requireLogin, controller.updateHistories);
router.put('/inspect', requireLogin, allFileUpload.array('tyreImages'), controller.inspect);
router.put('/retread/send', requireLogin, allFileUpload.array('tyreImages'), controller.retreadSend);
router.put('/retread/receive', requireLogin, allFileUpload.array('tyreImages'), controller.retreadReceive);
router.put('/assign/:tyreNo', requireLogin, controller.assign);
router.put('/align', requireLogin, allFileUpload.array('tyreImages'), controller.align);
router.put('/swap', requireLogin, allFileUpload.array('tyreImages'), controller.swap);
router.put('/swap/all', requireLogin, controller.swapAll);
router.put('/scrap', requireLogin, allFileUpload.array('tyreImages'), controller.scrap);
router.put('/remove', requireLogin, allFileUpload.array('tyreImages'), controller.remove);
router.put('/rotationOnRim', requireLogin, allFileUpload.array('tyreImages'), controller.rimRotation);
router.put('/psiUpdate/asset/:id', requireLogin, allFileUpload.array('tyreImages'), controller.updatePsiUpdate);
router.put('/scrapCancel', requireLogin, allFileUpload.array('tyreImages'), controller.scrapCancel);
router.put('/scrapSurvey', requireLogin, allFileUpload.array('tyreImages'), controller.scrapSurvey);

router.post('/scrapSurveyDetails', requireLogin, controller.getTyreScrapSurvey);
router.post('/listByIds', requireLogin, controller.getTyresByIds);
router.post('/bulkCreate', requireLogin, allFileUpload.array('invoiceImages'), controller.bulkCreate);

module.exports = router;