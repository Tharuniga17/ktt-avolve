'use strict';

const express = require('express');
const controller = require('./report');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");

router.get('/ios/dashboard', requireLogin, controller.iosDashboard);
router.get('/sales/dashboard', requireLogin, controller.salesDashboard);
router.get('/ios/serviceSummary/missedAlerts/download', requireLogin, controller.missedServiceAlertsDownload);
router.get('/ios/serviceSummary/missedAlerts', requireLogin, controller.missedServiceAlerts);
router.get('/sales/inventoryAlerts', requireLogin, controller.salesInventoryAlerts);
router.get('/sales/paymentAlerts', requireLogin, controller.salesPaymentAlerts);
router.get('/sales/download/ServiceSummary', requireLogin, controller.downloadServiceSummary);
router.get('/stakeAnalytics', requireLogin, controller.stakeAnalytics);
router.get('/stakeAnalytics/download', requireLogin, controller.downloadStakeAnalytics);
router.get('/scrapAnalytics', requireLogin, controller.avolveScrapAnalytics);
router.get('/scrapAnalytics/download', requireLogin, controller.downloadScrapAnalytics);
router.get('/download/avolveCustomers', requireLogin, controller.downloadAvolveCustomers);
router.get('/performanceAnalytics', requireLogin, controller.tyrePerformanceAnalytics);
router.get('/performanceAnalytics/info', requireLogin, controller.performaceAnalyticsInfo);

//Customer Monthly Snapshot API's
router.get('/monthlySummary/account/:id', requireLogin, controller.listMonthlySummary);
router.get('/monthlySummary/:id', requireLogin, controller.getMonthlySummary);
router.put('/monthlySummary/updateNote/:id', requireLogin, controller.updateKamNote);
router.get('/monthlySummary/download/:id', requireLogin, controller.downloadMonthlySummary);
router.get('/monthlySummary/email/:id', requireLogin, controller.emailMonthlySummary);

//mf - monitored fitment
router.get('/mf/dashboard', requireLogin, controller.mfDashboard);
router.get('/download/mf/inUseTyres', requireLogin, controller.mfInUseTyres);
router.get('/download/mf/notInUseTyres', requireLogin, controller.mfNotInUseTyres);
router.get('/download/mf/scrappedTyres', requireLogin, controller.mfScrappedTyres);
router.get('/download/mf/vehicles', requireLogin, controller.mfVehicles);
router.get('/download/mfCustomers', requireLogin, controller.downloadMFCustomers);
router.get('/download/draftCustomers', requireLogin, controller.downloadDraftCustomers);

//#region Reports & Analytics
router.get('/inventory/analytics', requireLogin, controller.apolloFleetInventoryAnalytics);
router.get('/scrap/analytics', requireLogin, controller.apolloFleetScrapAnalytics);
router.get('/stake/analytics', requireLogin, controller.apolloFleetStakeAnalytics);
router.get('/inspection/analytics', requireLogin, controller.apolloFleetInspectionAnalytics);

//Report & Analytics Downloads
router.get('/tyreAnalytics/download', requireLogin, controller.downloadTyreAnalytics);
router.get('/scrapAnalytics/download', requireLogin, controller.downloadScrapAnalytics);
router.get('/stakeAnalytics/download', requireLogin, controller.downloadStakeAnalytics);
router.get('/inspectionAnalytics/download', requireLogin, controller.downloadInspectionAnalytics);
router.get('/performanceAnalytics/download', requireLogin, controller.downloadPerformanceAnalytics);

module.exports = router;