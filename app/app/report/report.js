const models = require("../../../models");
const { Op } = require("sequelize");
const logger = require('../../../lib/helpers/rmqlog');
const avolveHelper = require('../../../lib/helpers/avolveHelper');
const moment = require('moment');
const path = require('path');
const Excel = require("exceljs");
const evt = require('../../../lib/event');
const avolvePdfHelper = require('../../../lib/helpers/avolvePdf');
const reportHelper = require('../../../lib/helpers/reports');
const { handleApiError } = require('../../middlewares/helper');

exports.iosDashboard = async function (req, res) {
	const ROUTE = 'app/reports/iosDashboard ';
	try {
		let sdate;
		if (!req.query.date) {
			sdate = moment().startOf('month').toISOString();
		} else {
			sdate = moment(req.query.date).toISOString();
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role) && !req.query.AccountId) {
			return res.send({ success: false, error: 'Please select customer to proceed.' });
		}

		let AccountId = ["XE FTE", "ARSA"].includes(res.locals.role) ? req.query.AccountId : res.locals.AccountId;

		let AplReport = await models.AplReport.findOne({
			where: {
				month: moment(sdate).format('MM'),
				year: moment(sdate).format('YYYY'),
				AccountId: AccountId,
				UserId: null
			},
			raw : true
		});

		//#region service 2.0
		let statusCounts = {};
		let tyreLife = [];
		let tyreSummary = await avolveHelper.getDashboardTyreSummary(AccountId, true, true);
		if (tyreSummary && tyreSummary.success && tyreSummary.result) {
			statusCounts = tyreSummary.result.statusCounts || {};
			tyreLife = tyreSummary.result.tyreLife || [];
		}
		//#endregion

		let onboardSummary = await avolveHelper.onboardSummary(AccountId);
		if (onboardSummary.error) {
			onboardSummary = onboardSummaryStruct();
		}
		onboardSummary = {
			totalVehicles: onboardSummary.totalVehicles,
			totalMappedTyres: onboardSummary.totalMappedTyres,
			totalTyres: onboardSummary.totalTyres
		}

		if (!AplReport) {
			return res.send({
				success: true, result: {
					onboardSummary: onboardSummary,
					avgSummary: avgSummaryStruct(),
					consumptionSummary: consSummaryStruct(),
					serviceSummary: serviceSummaryStruct(),
					tyreSummary: statusCounts,
					tyreLife: tyreLife
				}, error: null
			});
		}

		//#region  Service summary
		let serviceSummary = AplReport.details && AplReport.details.ss || {};

		// Temp solution - Update missed service & vehicle count for ios dashboard
		if (serviceSummary && serviceSummary.alertsMissed) {
			serviceSummary.alertsMissed.servicesCount = serviceSummary.alertsMissed.missed || 0;
			serviceSummary.alertsMissed.unqAssetsCount = serviceSummary.alertsMissed.uniqAssets || 0;
		}

		if (serviceSummary && serviceSummary.alertsTriggered) {
			serviceSummary.alertsTriggered.servicesCount = serviceSummary.alertsTriggered.count || 0;
			serviceSummary.alertsTriggered.unqAssetsCount = serviceSummary.alertsTriggered.uniqAssets || 0;
		}

		let avgSummary = AplReport.details && AplReport.details.as || {};
		if (!Object.keys(avgSummary)) {
			avgSummary = avgSummaryStruct();
		}
		avgSummary = {
			biasProjKMPerTyre: avgSummary.biasProjKMPerTyre,
			totalBiasTyreCount: avgSummary.totalBiasTyreCount,
			radialProjKMPerTyre: avgSummary.radialProjKMPerTyre,
			totalRadialTyreCount: avgSummary.totalRadialTyreCount
		}

		let consumptionSummary = AplReport.details && AplReport.details.cs || {};
		if (!Object.keys(consumptionSummary)) {
			consumptionSummary = consSummaryStruct();
		}

		let result = {
			onboardSummary: onboardSummary,
			avgSummary: avgSummary,
			consumptionSummary: consumptionSummary,
			serviceSummary: serviceSummary,
			tyreSummary: statusCounts,
			tyreLife: tyreLife
		};

		return res.send({ success: true, result: result, error: null });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching data', err);
	}
}

function avgSummaryStruct() {
	return {
		biasProjKMPerTyre: 0,
		totalBiasTyreCount: 0,
		radialProjKMPerTyre: 0,
		totalRadialTyreCount: 0
	}
}

function consSummaryStruct() {
	return {
		newTyresPer: 0,
		newTyresCount: 0,
		scrapCompleted: 0,
		scrapCompletedPer: 0
	}
}

function onboardSummaryStruct() {
	return {
		totalTyres: 0,
		totalVehicles: 0,
		totalMappedTyres: 0
	}
}

function serviceSummaryStruct() {
	return {
		vehInspect: 0,
		tyreFitment: 0,
		tyreInspect: 0,
		alertsMissed: {
			servicesCount: 0,
			unqAssetsCount: 0
		},
		tyreRotation: 0,
		wheelAlignment: 0,
		alertsTriggered: {
			servicesCount: 0,
			unqAssetsCount: 0
		},
		unqVehInspected: 0,
		unqTyreInspected: 0,
		tyreRotationOnRim: 0,
		ipCheckAndCorrection: 0
	}
}

exports.salesDashboard = async function (req, res) {
	const ROUTE = 'app/reports/salesDashboard';
	try {
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		//#region user hierarchy with customers
		let accountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, true);
		//#endregion

		let custResult = await avolveHelper.getAvolveCustomers(accountIds, res.locals.masterAccountId);
		if (!custResult.success) {
			return res.send({ success: false, error: 'Error fetching customers.' });
		}

		let activeAccIds = custResult.activeAccIds;
		let allAccIds = custResult.allAccIds;

		let sdate;
		if (!req.query.date) {
			sdate = moment().startOf('month').toISOString();
		} else {
			sdate = moment(req.query.date).toISOString();
		}

		//#region customer summary
		let customerSummary = await avolveHelper.customerSummary(allAccIds);
		if (customerSummary.error) {
			customerSummary = customerSummaryStruct();
		}
		//#endregion

		//#region vehicle summary
		let vehicleSummary = await avolveHelper.vehicleSummary(activeAccIds);
		if (vehicleSummary.error) {
			vehicleSummary = vehicleSummaryStruct();
		}
		//#endregion

		let AplReports = await models.AplReport.findAll({
			attributes: ['id', 'details'],
			where: {
				month: moment(sdate).format('MM'),
				year: moment(sdate).format('YYYY'),
				AccountId: activeAccIds,
				UserId: null
			},
			raw : true
		});

		let serviceSummary = serviceSummarySalesStruct();
		let invoiceSummary = invoiceSummaryStruct();

		for (const AplReport of AplReports) {
			if (AplReport.details && AplReport.details.ss) {
				let service = AplReport.details.ss;
				serviceSummary.jobcardPending += service.jobCardPending || 0;
				serviceSummary.servicesRejected += service.servicesRejected || 0;
				if (service.alertsTriggered) {
					serviceSummary.alertsTriggered.count += service.alertsTriggered.count;
					serviceSummary.alertsTriggered.uniqAssets += service.alertsTriggered.uniqAssets;
				}
				if (service.alertsExecuted) {
					serviceSummary.alertsExecuted.count += service.alertsExecuted.count;
					serviceSummary.alertsExecuted.uniqAssets += service.alertsExecuted.uniqAssets;
				}
				if (service.alertsMissed) {
					if (service.alertsMissed.count) {
						serviceSummary.alertsMissed.count += service.alertsMissed.count;
					}
					if (service.alertsMissed.missed) {
						serviceSummary.alertsMissed.missed += service.alertsMissed.missed;
					}
					serviceSummary.alertsMissed.uniqAssets += service.alertsMissed.uniqAssets;
				}
				if (service.secServices) {
					serviceSummary.secServices.count += service.secServices.count;
					serviceSummary.secServices.rejected += service.secServices.rejected;
				}
				if (service.jobCard) {
					serviceSummary.jobCard.count += service.jobCard.count;
					serviceSummary.jobCard.pending += service.jobCard.pending;
				}
			}
			if (AplReport.details && AplReport.details.invs) {
				invoiceSummary.raised += AplReport.details.invs.raised;
				invoiceSummary.overDue += AplReport.details.invs.overDue;
				invoiceSummary.unPaid += AplReport.details.invs.unPaid;
				invoiceSummary.paid += AplReport.details.invs.paid;
			}
		}

		//#region percentage calc
		if (serviceSummary.alertsExecuted.count > 0 && serviceSummary.alertsTriggered.count > 0) {
			serviceSummary.alertsExecuted.percentage = parseInt(serviceSummary.alertsExecuted.count / serviceSummary.alertsTriggered.count * 100);
		}
		if (serviceSummary.alertsMissed.count > 0 && serviceSummary.alertsMissed.missed > 0) {
			serviceSummary.alertsMissed.percentage = parseInt(serviceSummary.alertsMissed.missed / serviceSummary.alertsMissed.count * 100);
		}
		if (serviceSummary.jobCard.count > 0 && serviceSummary.jobCard.pending > 0) {
			serviceSummary.jobCard.percentage = parseInt(serviceSummary.jobCard.pending / serviceSummary.jobCard.count * 100);
		}
		if (serviceSummary.secServices.count > 0 && serviceSummary.secServices.rejected > 0) {
			serviceSummary.secServices.percentage = parseInt(serviceSummary.secServices.rejected / serviceSummary.secServices.count * 100);
		}
		//#endregion

		let result = {
			customerSummary: customerSummary,
			vehicleSummary: vehicleSummary,
			serviceSummary: serviceSummary,
			invoiceSummary: invoiceSummary
		}
		return res.send({ success: true, result: result, error: null });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching data', err);
	}
}

function customerSummaryStruct() {
	return {
		total: 0,
		active: 0,
		inactive: 0,
		amcs: 0,
		amcc: 0,
		xe: 0,
		de: 0
	}
}

function vehicleSummaryStruct() {
	return {
		signed: 0,
		onboarded: 0,
		onboardedWithTyres: 0
	}
}

function serviceSummarySalesStruct() {
	return {
		alertsTriggered: {
			count: 0,
			uniqAssets: 0
		},
		alertsExecuted: {
			count: 0,
			uniqAssets: 0,
			percentage: 0
		},
		alertsMissed: {
			count: 0,
			missed: 0,
			uniqAssets: 0,
			percentage: 0
		},
		secServices: {
			count: 0,
			rejected: 0,
			percentage: 0
		},
		jobCard: {
			count: 0,
			pending: 0,
			percentage: 0
		},
		servicesRejected: 0,
		jobcardPending: 0
	}
}

function invoiceSummaryStruct() {
	return {
		raised: 0,
		overDue: 0,
		unPaid: 0,
		paid: 0
	}
}

exports.missedServiceAlertsDownload = async function (req, res) {
	const ROUTE = 'app/reports/missedServiceAlertsDownload ';
	try {
		if (["XE FTE", "ARSA"].includes(res.locals.role) && !req.query.AccountId) {
			return res.send({ success: false, error: 'Please select customer to proceed.' });
		}

		let accountIds = ["XE FTE", "ARSA"].includes(res.locals.role) ? [req.query.AccountId] : [res.locals.AccountId];
		let kamUsers = [];
		if (["KAM", "AMCC FTE"].includes(res.locals.role)) {
			if (req.query.AccountId) {
				accountIds = req.query.AccountId;
			} else {
				let custResult = await avolveHelper.getCustomersByUser(res.locals.UserId, false, res.locals.masterAccountId);
				if (custResult.success && custResult.results.length) {
					accountIds = custResult.results.map(x => x.id);
				} else {
					accountIds = res.locals.accountIds;
				}
			}
		} else if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM'].includes(res.locals.role)) {
			if (req.query.UserId) {
				let kamResult = await avolveHelper.getKamListByUser(req.query.UserId);
				kamUsers = kamResult.results;
				let result = await avolveHelper.getCustomersByUser(req.query.UserId, false, res.locals.masterAccountId);
				accountIds = result.results.map(x => x.id);
			} else {
				let zmId = ["HO Sales", "FTS HO"].includes(res.locals.role) && res.locals.zmIds || res.locals.UserId;
				let kamResult = await avolveHelper.getKamListByUser(zmId);
				kamUsers = kamResult.results;
				if (kamResult.success && kamResult.results.length) {
					let custResult = await avolveHelper.getCustomersByUser(kamResult.results.map(x => x.id), false, res.locals.masterAccountId);
					accountIds = custResult.results.map(x => x.id);
				}
			}
		}

		if (res.locals.role == 'AMCS FTE') {
			let custResult = await avolveHelper.getAMCSCustomersByFte(res.locals.UserId, res.locals.masterAccountId);
			accountIds = custResult.success && custResult.results.map(x => x.id) || [];
		}

		if (!['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			let kamResult = await avolveHelper.getKamListByCustomers(accountIds, res.locals.masterAccountId);
			kamUsers = kamResult.success && kamResult.results || [];
		}

		let fteUsers = await avolveHelper.getFteUsersByCustomers(accountIds, false, res.locals.masterAccountId);
		fteUsers = fteUsers.results || [];

		let accountUsers = await avolveHelper.getUsersByAccounts(accountIds, ["KAM", "FTS KAM"].includes(res.locals.role) && [] || kamUsers, fteUsers);
		accountUsers = accountUsers.results || [];

		let sdate, edate;
		if (!req.query.sdate || !req.query.edate) {
			sdate = null;
			edate = moment().subtract(1, 'day').endOf('day').toISOString();
		} else {
			sdate = moment(req.query.sdate).startOf('day').toISOString();
			edate = moment(req.query.edate).endOf('day').toISOString();
		}

		// Temp solution - front end to change end date for current month
		if (moment(edate).startOf('day').isSameOrAfter(moment().startOf('day'))) {
			edate = moment().subtract(1, 'day').endOf('day').toISOString();
		}

		if (moment(edate).isAfter(moment().startOf('day'))) {
			return res.send({ success: false, error: "End date should be a past date" });
		}

		let missedAlerts = await avolveHelper.getMissedAlerts(accountIds, sdate, edate, req.query.excel);
		if (missedAlerts.err) {
			logger.RaiseLogEvent(ROUTE, 'error', missedAlerts.err, `Error fetching booking list`);
			return res.send({ success: false, results: [], destFileUrl: '', error: 'Unable to load missed alerts data' });
		}

		let resultsByAsset = [];

		let unqAssets = new Set;
		for (const alert of missedAlerts.results) {
			unqAssets.add(alert.AssetId);
		}
		unqAssets = Array.from(unqAssets);

		for (const id of unqAssets) {
			let alerts = missedAlerts.results.filter(x => x.AssetId == id);
			alerts.sort((a, b) => b.dueDays - a.dueDays); // Sort by due days desc

			let services = alerts.map(x => {
				return {
					serviceName: x.serviceName,
					BookingId: x.BookingId,
					ScheduleId: x.ScheduleId
				}
			});

			//This format is used to support the live version
			let result = {
				date: alerts[0].alertDueDate, // Oldest date
				dueDays: alerts[0].dueDays, // largest due days
				services: services,
				asset: {
					id: alerts[0].AssetId,
					lplate: alerts[0].vehicle
				}
			}
			resultsByAsset.push(result);
		}

		resultsByAsset.sort((a, b) => b.dueDays - a.dueDays); // sort desc order of due days

		let destFileUrl = '';
		if (req.query.excel == 'true') {
			try {
				const workbook = new Excel.Workbook();
				const worksheet = workbook.addWorksheet("Sheet 1");

				let columns = [
					{ header: "KAM", key: "kamName", width: 20 },
					{ header: "FTE", key: "fteName", width: 20 },
					{ header: "MDG ID", key: "mdgId", width: 20 },
					{ header: "Customer Name", key: "accName", width: 20 },
					{ header: "Veh Reg No", key: "vehicle", width: 20 },
					{ header: "Service Name", key: "serviceName", width: 20 },
					{ header: "Alert Triggered Date", key: "alertTriggDate", width: 20 },
					{ header: "Alert Based On", key: "alertBasedOn", width: 20 },
					{ header: "Alert Due Date", key: "alertDueDate", width: 20 },
					{ header: "Alert Scheduled Date", key: "alertSchDate", width: 25 },
					{ header: "Alert Missed Date", key: "alertMissedDate", width: 20 },
					{ header: "Alert Rescheduled Date", key: "alertReSchDate", width: 25 },
					{ header: "Workshop", key: "workshop", width: 25 },
					{ header: "Over due days", key: "dueDays", width: 20 },
					{ header: "Status", key: "status", width: 20 }
				];

				if (!['FM', 'FO'].includes(res.locals.role)) {
					columns.splice(3, 0, { header: "Offer", key: "offerType", width: 20 },
						{ header: "Sub Offer", key: "subOfferType", width: 20 },
						{ header: "Plan", key: "plan", width: 20 },
						{ header: "Slab", key: "slab", width: 20 }
					);
				}

				let results = missedAlerts.results.map(detail => {
					let accountUser = accountUsers.length && accountUsers.find(x => x.AccountId == detail.AccountId) || '';
					detail.alertDueDate = detail.alertDueDate && moment(detail.alertDueDate).format('DD/MM/YYYY') || '';
					detail.kamName = ["KAM", "FTS KAM"].includes(res.locals.role) ? res.locals.firstName && `${res.locals.firstName} ${res.locals.lastName || ''}` || res.locals.username : accountUser && accountUser.kamName || '';
					detail.fteName = accountUser && accountUser.fteName || '';
					detail.alertBasedOn = 'Days';
					return { ...detail };
				});

				let excelResults = [];
				for (const result of results) {
					excelResults.push(result);
				}

				let fileName = `APL_Missed_Service_Alerts_${res.locals.UserId}_${res.locals.AccountId}`;

				return await avolveHelper.avolveExcelExport(fileName, columns, excelResults, req, res);

			} catch (err) {
				console.log(`Error in ${ROUTE}: ${err}`);
				logger.RaiseLogEvent(ROUTE, 'error', err, `Error creating excel`);
			}
		}

		return res.send({ success: true, results: resultsByAsset, destFileUrl: destFileUrl, error: null });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching booking list', err);
	}
}

exports.missedServiceAlerts = async function (req, res) {
	const ROUTE = 'app/reports/missedServiceAlerts ';
	try {
		if (["XE FTE", "ARSA"].includes(res.locals.role) && !req.query.AccountId) {
			return res.send({ success: false, error: 'Please select customer to proceed.' });
		}

		let accountIds = ["XE FTE", "ARSA"].includes(res.locals.role) ? [req.query.AccountId] : [res.locals.AccountId];
		let kamUsers = [];
		if (["KAM", "AMCC FTE", 'FTS KAM'].includes(res.locals.role)) {
			if (req.query.AccountId) {
				accountIds = req.query.AccountId;
			} else {
				let custResult = await avolveHelper.getCustomersByUser(res.locals.UserId, false, res.locals.masterAccountId);
				if (custResult.success && custResult.results.length) {
					accountIds = custResult.results.map(x => x.id);
				} else {
					accountIds = res.locals.accountIds;
				}
			}
		} else if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM'].includes(res.locals.role)) {
			if (req.query.UserId) {
				let kamResult = await avolveHelper.getKamListByUser(req.query.UserId);
				kamUsers = kamResult.results;
				let result = await avolveHelper.getCustomersByUser(req.query.UserId, false, res.locals.masterAccountId);
				accountIds = result.results.map(x => x.id);
			} else {
				let zmId = ["HO Sales", "FTS HO"].includes(res.locals.role) && res.locals.zmIds || res.locals.UserId;
				let kamResult = await avolveHelper.getKamListByUser(zmId);
				kamUsers = kamResult.results;
				if (kamResult.success && kamResult.results.length) {
					let custResult = await avolveHelper.getCustomersByUser(kamResult.results.map(x => x.id), false, res.locals.masterAccountId);
					accountIds = custResult.results.map(x => x.id);
				}
			}
		}

		if (res.locals.role == 'AMCS FTE') {
			let custResult = await avolveHelper.getAMCSCustomersByFte(res.locals.UserId, res.locals.masterAccountId);
			accountIds = custResult.success && custResult.results.map(x => x.id) || [];
		}

		let Accounts = [], FMUsers = [];
		let accountsResult = await avolveHelper.getAvolveAccFMUser(accountIds, res.locals.masterAccountId);
		if (accountsResult && accountsResult.success) {
			Accounts = accountsResult.result && accountsResult.result.Accounts || [];
			FMUsers = accountsResult.result && accountsResult.result.FMUsers || [];
		}

		if (!['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			let kamResult = await avolveHelper.getKamListByCustomers(accountIds, res.locals.masterAccountId);
			kamUsers = kamResult.success && kamResult.results || [];
		}

		let fteUsers = await avolveHelper.getFteUsersByCustomers(accountIds, false, res.locals.masterAccountId);
		fteUsers = fteUsers.results || [];

		let accountUsers = await avolveHelper.getUsersByAccounts(accountIds, ["KAM", "FTS KAM"].includes(res.locals.role) && [] || kamUsers, fteUsers);
		accountUsers = accountUsers.results || [];

		let sdate, edate;
		if (!req.query.sdate || !req.query.edate) {
			sdate = null;
			edate = moment().subtract(1, 'day').endOf('day').toISOString();
		} else {
			sdate = moment(req.query.sdate).startOf('day').toISOString();
			edate = moment(req.query.edate).endOf('day').toISOString();
		}

		// Temp solution - front end to change end date for current month
		if (moment(edate).startOf('day').isSameOrAfter(moment().startOf('day'))) {
			edate = moment().subtract(1, 'day').endOf('day').toISOString();
		}

		if (moment(edate).isAfter(moment().startOf('day'))) {
			return res.send({ success: false, error: "End date should be a past date" });
		}

		let missedAlerts = await avolveHelper.getMissedAlerts(accountIds, sdate, edate, req.query.excel);
		if (missedAlerts.err) {
			logger.RaiseLogEvent(ROUTE, 'error', missedAlerts.err, `Error fetching booking list`);
			return res.send({ success: false, results: [], destFileUrl: '', error: 'Unable to load missed alerts data' });
		}

		//#region map the alerts with account id
		let accountAlertMap = new Map();
		for (let alert of missedAlerts.results) {
			if (!accountAlertMap.has(alert.AccountId)) {
				accountAlertMap.set(alert.AccountId, new Map());
			}
			let assetMap = accountAlertMap.get(alert.AccountId);
			if (!assetMap.has(alert.AssetId)) {
				assetMap.set(alert.AssetId, []);
			}
			assetMap.get(alert.AssetId).push(alert);
		}
		delete missedAlerts.results;
		//#endregion

		let resultsByAccount = [];
		for (let Account of Accounts) {
			let matchedFMUser = FMUsers[Account.id] || {};
			let result = {
				id: Account.id,
				name: Account.tname,
				fmName: `${matchedFMUser.firstName || ''} ${matchedFMUser.lastName || ''}`.trim(),
				phone: matchedFMUser.mobile || '',
				alerts: []
			};

			let assetMap = accountAlertMap.get(Account.id);
			if (assetMap) {
				for (let [assetId, alerts] of assetMap.entries()) {
					alerts.sort((a, b) => b.dueDays - a.dueDays);

					let services = alerts.map(alert => ({
						serviceName: alert.serviceName,
						BookingId: alert.BookingId,
						ScheduleId: alert.ScheduleId
					}));

					result.alerts.push({
						date: alerts[0].alertDueDate, // Oldest date
						dueDays: alerts[0].dueDays,  // Largest due days
						services: services,
						asset: {
							id: assetId,
							lplate: alerts[0].vehicle
						}
					});
				}
			}

			if (result.alerts && result.alerts.length) {
				resultsByAccount.push(result);
			}
		}

		resultsByAccount.forEach(account => { account.alerts.sort((a, b) => b.dueDays - a.dueDays) }); // Sort alerts by dueDays descending

		let destFileUrl = '';
		if (req.query.excel == 'true') {
			try {
				const workbook = new Excel.Workbook();
				workbook.addWorksheet("Sheet 1");

				let columns = [
					{ header: 'KAM', key: 'kamName', width: 15 },
					{ header: 'FTE', key: 'fteName', width: 15 },
					{ header: 'Customer Name', key: 'accName', width: 15 },
					{ header: 'Offer', key: 'offerType', width: 15 },
					{ header: 'Sub Offer', key: 'subOfferType', width: 15 },
					{ header: 'Asset Number', key: 'vehicle', width: 15 },
					{ header: 'Wheeler', key: 'wheeler', width: 15 },
					{ header: 'Config', key: 'config', width: 15 },
					{ header: 'Service Missed', key: 'serviceName', width: 30 },
					{ header: 'Service Due Date', key: 'alertDueDate', width: 15 },
					{ header: 'Overdue Days', key: 'dueDays', width: 10 },
					{ header: 'Status', key: 'status', width: 10 }
				];

				let results = missedAlerts.results.map(detail => {
					let accountUser = accountUsers.length && accountUsers.find(x => x.AccountId == detail.AccountId) || '';
					detail.alertDueDate = detail.alertDueDate && moment(detail.alertDueDate).format('DD/MM/YYYY') || '';
					detail.kamName = ["KAM", "FTS KAM"].includes(res.locals.role) ? res.locals.firstName && `${res.locals.firstName} ${res.locals.lastName || ''}` || res.locals.username : accountUser && accountUser.kamName || '';
					detail.fteName = accountUser && accountUser.fteName || '';
					return { ...detail };
				});

				let fileName = `APL_Missed_Service_Alerts_${res.locals.UserId}_${res.locals.AccountId}`;

				return await avolveHelper.avolveExcelExport(fileName, columns, results, req, res);

			} catch (err) {
				console.log(`Error in ${ROUTE}: ${err}`);
				logger.RaiseLogEvent(ROUTE, 'error', err, `Error creating excel`);
			}
		}

		return res.send({ success: true, results: resultsByAccount, destFileUrl: destFileUrl, error: null });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching booking list', err);
	}
}

exports.salesInventoryAlerts = async function (req, res) {
	const ROUTE = 'app/reports/salesInventoryAlerts ';
	try {
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let accountIds = [], kamUsers = [];
		if (['KAM', 'FTS KAM'].includes(res.locals.role)) {
			if (req.query.AccountId) {
				accountIds = req.query.AccountId;
			} else {
				let custResult = await avolveHelper.getCustomersByUser(res.locals.UserId, false, res.locals.masterAccountId);
				if (custResult.success && custResult.results.length) {
					accountIds = custResult.results.map(x => x.id);
				} else {
					accountIds = res.locals.accountIds;
				}
			}
		} else {
			if (req.query.UserId) {
				let kamResult = await avolveHelper.getKamListByUser(req.query.UserId);
				kamUsers = kamResult.results;
				let result = await avolveHelper.getCustomersByUser(req.query.UserId, false, res.locals.masterAccountId);
				accountIds = result.results.map(x => x.id);
			} else {
				let zmId = ["HO Sales", "FTS HO"].includes(res.locals.role) && res.locals.zmIds || res.locals.UserId;
				let kamResult = await avolveHelper.getKamListByUser(zmId);
				kamUsers = kamResult.results;
				if (kamResult.success && kamResult.results.length) {
					let custResult = await avolveHelper.getCustomersByUser(kamResult.results.map(x => x.id), false, res.locals.masterAccountId);
					accountIds = custResult.results.map(x => x.id);
				}
			}
		}

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'name', 'tname', 'details', 'status'],
			where: {
				id: {[Op.in] : accountIds}
			},
			raw : true
		});

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'AccountId', 'lastStatus'],
			where: {
				AccountId: {[Op.in] : accountIds},
				'lastStatus.treadDepth': {
					[Op.gte]: 0, [Op.lte]: 4
				},
				tyreStatus: { [Op.notIn]: [3, 6] }
			},
			raw : true
		});

		let fteUsers = await avolveHelper.getFteUsersByCustomers(accountIds, false, res.locals.masterAccountId);
		fteUsers = fteUsers.results || [];

		let accountUsers = await avolveHelper.getUsersByAccounts(accountIds, ["KAM", "FTS KAM"].includes(res.locals.role) && [] || kamUsers, fteUsers);
		accountUsers = accountUsers.results || [];

		let AplOffers = await models.AplOffer.findAll({
			attributes: ['id', 'AccountId', 'offerType', 'subOfferType'],
			where: {
				AccountId: {[Op.in] : accountIds},
				status: 'Active'
			},
			order: [['id', 'desc']],
			raw : true
		});

		let inventoryAlerts = [];
		for (let Account of Accounts) {
			let tyreStakeCount = Tyres.filter(x => x.AccountId == Account.id).length;
			let aplOffer = AplOffers.find(x => x.AccountId == Account.id);
			let { slab, channel } = avolveHelper.avolveOfferLookUp(aplOffer) || {};
			let accountUser = accountUsers.length && accountUsers.find(x => x.AccountId == Account.id) || '';
			if (tyreStakeCount) {
				inventoryAlerts.push({
					kamName: ["KAM", "FTS KAM"].includes(res.locals.role) ? (res.locals.firstName && `${res.locals.firstName} ${res.locals.lastName || ''}`) || (res.locals.username || '') : accountUser && accountUser.kamName || '',
					fteName: accountUser && accountUser.fteName || '',
					offerType: aplOffer && aplOffer.offerType || '',
					subOfferType: aplOffer && aplOffer.subOfferType || '',
					slab: slab || '',
					channel: channel || 'Non TIS',
					AccountId: Account.id,
					customerId: Account.name || '',
					accName: Account.tname || '',
					plan: Account.details && Account.details.plan || '',
					tyreStakeCount: tyreStakeCount,
					status: Account.status == 0 ? 'Inactive' : Account.status == 1 ? 'Active' : ''
				});
			}
		}

		let destFileUrl = '';
		if (req.query.excel == 'true') {
			try {
				let columns = [
					{ header: 'KAM', key: 'kamName', width: 15 },
					{ header: 'FTE', key: 'fteName', width: 15 },
					{ header: 'Customer Name', key: 'accName', width: 15 },
					{ header: 'Offer', key: 'offerType', width: 15 },
					{ header: 'Sub Offer', key: 'subOfferType', width: 15 },
					{ header: 'Plan', key: 'channel', width: 15 },
					{ header: 'Slab', key: 'slab', width: 15 },
					{ header: 'No of Tyre (0-4mm)', key: 'tyreStakeCount', width: 15 }
				];

				let excelResults = []
				for (const result of inventoryAlerts) {
					excelResults.push(result);
				}

				let fileName = `APL_Inventory_Alerts_${res.locals.UserId}`;

				return await avolveHelper.avolveExcelExport(fileName, columns, excelResults, req, res);
			} catch (err) {
				console.log(`Error in ${ROUTE}: ${err}`);
				logger.RaiseLogEvent(ROUTE, 'error', err, `Error creating excel`);
			}
		}
		return res.send({ success: true, results: inventoryAlerts, destFileUrl: destFileUrl, error: null });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching inventory alerts', err);
	}
}

exports.salesPaymentAlerts = async function (req, res) {
	const ROUTE = 'app/reports/salesPaymentAlerts ';
	try {
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let accountIds = [], kamUsers = [];
		if (["KAM", "FTS KAM"].includes(res.locals.role)) {
			if (req.query.AccountId) {
				accountIds = req.query.AccountId;
			} else {
				let custResult = await avolveHelper.getCustomersByUser(res.locals.UserId, false, res.locals.masterAccountId);
				if (custResult.success && custResult.results.length) {
					accountIds = custResult.results.map(x => x.id);
				} else {
					accountIds = res.locals.accountIds;
				}
			}
			kamUsers = `${res.locals.firstName} ${res.locals.lastName}`
		} else {
			if (req.query.UserId) {
				let kamResult = await avolveHelper.getKamListByUser(req.query.UserId);
				kamUsers = kamResult.results;
				let result = await avolveHelper.getCustomersByUser(req.query.UserId, false, res.locals.masterAccountId);
				accountIds = result.results.map(x => x.id);
			} else {
				let zmId = ["HO Sales", "FTS HO"].includes(res.locals.role) && res.locals.zmIds || res.locals.UserId;
				let kamResult = await avolveHelper.getKamListByUser(zmId);
				kamUsers = kamResult.results;
				if (kamResult.success && kamResult.results.length) {
					let custResult = await avolveHelper.getCustomersByUser(kamResult.results.map(x => x.id), false, res.locals.masterAccountId);
					accountIds = custResult.results.map(x => x.id);
				}
			}
		}

		let whereClause = {
			AccountId: {[Op.in]:accountIds}
		};

		if (req.query.sdate && req.query.edate && req.query.excel != 'true') {
			whereClause.invDate = {
				[Op.between]: [
					moment(req.query.sdate).startOf('month').format('YYYY-MM-DD'),
					moment(req.query.edate).endOf('month').format('YYYY-MM-DD')
				]
			}
		}

		let AplOffers = await models.AplOffer.findAll({
			attributes: ['id', 'AccountId', 'offerType', 'subOfferType', 'plan', 'slab'],
			where: {
				AccountId: {[Op.in]:accountIds},
				status: 'Active'
			},
			order: [['id', 'desc']],
			raw : true
		});

		let AplInvoices = await models.AplInvoice.findAll({
			attributes: ['id', 'invNo', 'invDate', 'offerType', 'total', 'AccountId', 'period'],
			include: [{
				attributes: ['id', 'name', 'tname', 'details'],
				model: models.Account,
				where: {
					status: 1
				},
				required: true
			}, {
				attributes: ['id', 'amount'],
				model: models.AplPayment,
				required: false
			}],
			where: whereClause
		});

		let accountUsers = [];
		if (res.locals.role != "KAM") {
			accountUsers = await avolveHelper.getUsersByAccounts(accountIds, kamUsers, []);
			accountUsers = accountUsers.results || [];
		}

		let paymentAlerts = [];
		for (let Invoice of AplInvoices) {
			let overDueDays = 0, status = 'Un Paid';
			if (Invoice.AplPayments && Invoice.AplPayments.length) {
				if (req.query.excel == 'true') {
					status = 'Paid';
				} else {
					continue;
				}
			}
			let Account = Invoice.Account;
			let plan = Account && Account.details && Account.details.plan || '';
			let invDate = Invoice.invDate && moment(Invoice.invDate).add(5, 'days') || '';
			if (plan == 2) {//for AMCC inv date + 30 days buffer
				invDate = Invoice.invDate && moment(Invoice.invDate).add(30, 'days') || '';
			}
			if (invDate && moment().isAfter(invDate) && status != 'Paid') {
				overDueDays = moment().diff(invDate, 'days');
				status = 'Over Due';
			}
			let accountUser = accountUsers.length && accountUsers.find(x => x.AccountId == Account.id) || '';
			let aplOffer = AplOffers.find(x => x.AccountId == Account.id);
			let { slab, channel } = avolveHelper.avolveOfferLookUp(aplOffer) || {};
			paymentAlerts.push({
				kamName: ["KAM", "FTS KAM"].includes(res.locals.role) ? (res.locals.firstName && `${res.locals.firstName} ${res.locals.lastName || ''}`) || (res.locals.username || '') : accountUser && accountUser.kamName || '',
				plan: plan,
				AccountId: Account.id,
				customerId: Account && Account.name || '',
				accName: Account && Account.tname || '',
				date: Invoice.invDate && moment(Invoice.invDate).format('DD/MM/YYYY') || '',
				invNo: Invoice.invNo,
				amount: Math.round(Invoice.total),
				servicePeriod: Invoice.period || '',
				overDueDays: overDueDays,
				status: status,
				offerType: aplOffer && aplOffer.offerType || '',
				subOfferType: aplOffer && aplOffer.subOfferType || '',
				channel: channel || 'Non TIS',
				slab: slab || ''
			});
		}

		let destFileUrl = '';
		if (req.query.excel == 'true') {
			try {
				let columns = [
					{ header: 'KAM', key: 'kamName', width: 15 },
					{ header: 'Customer Name', key: 'accName', width: 15 },
					{ header: 'Offer', key: 'offerType', width: 15 },
					{ header: 'Sub Offer', key: 'subOfferType', width: 15 },
					{ header: 'Plan', key: 'channel', width: 15 },
					{ header: 'Slab', key: 'slab', width: 15 },
					{ header: 'Invoice Number', key: 'invNo', width: 15 },
					{ header: 'Invoice Date', key: 'date', width: 15 },
					{ header: 'Amount', key: 'amount', width: 10 },
					{ header: 'Service Period', key: 'servicePeriod', width: 15 },
					{ header: 'Status', key: 'status', width: 15 },
					{ header: 'Overdue Days', key: 'overDueDays', width: 10 }
				];

				let excelResults = [];
				for (const result of paymentAlerts) {
					if (result.status == "Paid") {
						result.overDueDays = 0;
					}
					excelResults.push(result);
				}

				let fileName = `APL_Payment_Alerts_${res.locals.UserId}`;

				return await avolveHelper.avolveExcelExport(fileName, columns, excelResults, req, res);
			} catch (err) {
				console.log(`Error in ${ROUTE}: ${err}`);
				logger.RaiseLogEvent(ROUTE, 'error', err, `Error creating excel`);
			}
		}
		return res.send({ success: true, results: paymentAlerts, destFileUrl: destFileUrl, error: null });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching payment alerts', err);
	}
}

exports.listMonthlySummary = async function (req, res) {
	const ROUTE = 'app/reports/listMonthlySummary';
	try {
		if (!['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, result: [], error: 'Not Authorized' });
		}

		if (!req.params.id) {
			return res.send({ success: false, result: [], error: 'AccountId missing.' });
		}

		const sdate = moment().subtract(13, 'months').startOf('month').toISOString();
		const edate = moment().subtract(1, 'month').endOf('month').toISOString();

		const AplReports = await models.AplReport.findAll({
			attributes: ['id', 'month', 'year', 'details', 'logs'],
			where: {
				[Op.and]: [
					models.sequelize.literal(`TO_DATE(CONCAT("year", '-', "month", '-01'), 'YYYY-MM-DD') BETWEEN '${sdate}' AND '${edate}'`),
					{ AccountId: req.params.id },
					{ UserId: null }
				]
			},
			order: [['year', 'DESC'], ['month', 'DESC']],
			raw : true
		});

		let results = [];
		let _checkDuplicates = new Set();
		for (const AplReport of AplReports) {
			if (_checkDuplicates.has({ month: AplReport.momth, year: AplReport.year })) {
				continue;
			}
			if (!AplReport.details || !AplReport.details.ms) {
				continue;
			}
			let rDate = moment(`${AplReport.year}-${AplReport.month}`, "YYYY-M").format("MMM'YY");
			let log = AplReport.logs && AplReport.logs[AplReport.logs.length - 1] || {};
			results.push({
				id: AplReport.id,
				title: rDate ? `Monthly Customer Snapshot - ${rDate}` : '',
				email: ((!log.triggeredCount || log.triggeredCount >= 5) && log.email) || false,
				month: moment(rDate, "MMM'YY").format('DD-MM-YYYY'),
				emailDate: log.emailDate && moment(log.emailDate).format('DD-MM-YYYY') || '',
				type: log.type && log.type == 1 ? 'Automatically Triggered' : log.type == 2 ? 'Manually Triggered' : '',
				isKamComment: [25700].includes(res.locals.UserId) && (!log.triggeredCount || log.triggeredCount < 6), // log.user && log.user.note ? true : false - Temporarily enabled the manual email option for Shekar HO.
				lastUpdatedAt: log.user && log.user.date && moment(log.user.date).format('DD-MM-YYYY') || ''
			});
		}
		return res.send({ success: true, results });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching report logs', error);
	}
}

exports.getMonthlySummary = async function (req, res) {
	const ROUTE = 'app/reports/getMonthlySummary ';
	try {
		if (!['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}
		if (!req.params.id) {
			return res.send({ success: false, error: 'Report Id missing.' });
		}

		const AplReport = await models.AplReport.findOne({
			attributes: ['id', 'details', 'logs'],
			where: {
				id: req.params.id
			},
			order: [['year', 'DESC'], ['month', 'DESC']],
			raw : true
		});

		let monthlySummary = AplReport && AplReport.details && AplReport.details.ms || {};
		if (!monthlySummary || !Object.keys(monthlySummary).length) {
			return res.send({ success: false, error: 'Monthly summary report not found.' });
		}

		let latestLog = AplReport.logs && AplReport.logs.length && AplReport.logs[AplReport.logs.length - 1] || {};
		monthlySummary.kamComment = latestLog && latestLog.user && latestLog.user.note || '';

		return res.send({ success: true, result: monthlySummary });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching report', error);
	}
}

exports.updateKamNote = async function (req, res) {
	const ROUTE = 'app/reports/updateKamNote';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id, req.body, `Requested User: ${res.locals.username}`);

		if (!['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: 'Report Id missing.' });
		}

		if (!req.body.comments) {
			return res.send({ success: false, error: "Comments mandatory." });
		}

		const AplReport = await models.AplReport.findOne({
			attributes: ['id', 'logs'],
			where: {
				id: req.params.id
			},
			order: [['year', 'DESC'], ['month', 'DESC']],
		});

		if (!AplReport) {
			return res.send({ success: false, error: 'Monthly summary report not found.' });
		}

		let logs = AplReport.logs && AplReport.logs.length ? JSON.parse(JSON.stringify(AplReport.logs)) : [];
		let latestLog = logs.length ? logs[logs.length - 1] : {};

		const newLog = {
			user: {
				id: res.locals.UserId || '',
				name: res.locals.username || '',
				date: moment().toISOString(),
				note: req.body.comments || ''
			}
		};

		if (latestLog && Object.keys(latestLog).length) {
			logs[logs.length - 1].user = newLog.user;
		} else {
			logs.push(newLog);
		}

		await AplReport.update({
			logs: logs
		});

		return res.send({ success: true });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error updating KAM comment', error);
	}
}

exports.downloadMonthlySummary = async function (req, res) {
	const ROUTE = 'app/reports/downloadMonthlySummary ';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id, {}, `Requested User: ${res.locals.username}`);

		if (!['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: 'Report Id missing.' });
		}

		const AplReport = await models.AplReport.findOne({
			attributes: ['id', 'details', 'month', 'year', 'logs'],
			where: {
				id: req.params.id
			},
			order: [['year', 'DESC'], ['month', 'DESC']],
			raw : true
		});

		let monthlySummary = AplReport && AplReport.details && AplReport.details.ms || {};
		if (!monthlySummary || !Object.keys(monthlySummary).length) {
			return res.send({ success: false, error: 'Monthly summary report not found.' });
		}

		let latestLog = AplReport.logs && AplReport.logs.length && AplReport.logs[AplReport.logs.length - 1] || {};
		monthlySummary.kamComment = latestLog && latestLog.user && latestLog.user.note || '';

		let mdgId = monthlySummary.mdgId || '';
		let actMdgId = mdgId.split('_')[0];
		let maskedMdgId = `${actMdgId.substring(0, 5)}xxx${actMdgId.substring(actMdgId.length - 2)}`;
		let fileName = `${maskedMdgId}_${moment(`${AplReport.month}-${AplReport.year}`, 'MM-YYYY').format("MMMM_YYYY")}_Snapshot_Report.pdf`;
		let result = await avolvePdfHelper.monthlySnapShotPDF(monthlySummary, true, actMdgId.replace(/^0+/, ''), fileName);
		if (!result.success) {
			logger.RaiseLogEvent(ROUTE, 'error', result.error, "Error fetching monthly customer snapshot.");
			return res.send({ success: false, error: 'Error downloading monthly customer snapshot.' });
		}

		return res.set({
			'Content-Type': 'application/pdf',
			'Content-Disposition': `attachment; filename="${fileName}"`,
			'Content-Length': result.pdfBuffer.length
		}).send(Buffer.from(result.pdfBuffer));

	} catch (error) {
		return handleApiError(res, ROUTE, 'Error downloading monthly customer snapshot', error);
	}
}

exports.emailMonthlySummary = async function (req, res) {
	const ROUTE = 'app/reports/emailMonthlySummary ';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id, {}, `Requested User: ${res.locals.username}`);

		if (!['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: 'Report Id missing.' });
		}

		let data = { id: req.params.id, type: 2 };
		let result = await avolvePdfHelper.monthlyCustReportEmail(data, true);
		if (!result.success || result.error) {
			logger.RaiseLogEvent(ROUTE, data.id, result.message || result.error, `Error in monthly summary pdf email.`);
			return res.send({ success: false, error: result.message });
		}

		return res.send({ success: true });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error sending monthly summary email', error);
	}
}

exports.stakeAnalytics = async function (req, res) {
	const ROUTE = 'app/reports/stakeAnalytics';
	try {
		if (!['FM', 'FO', 'HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'DE FTE', 'XE FTE', 'ARSA', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let AccountId = res.locals.AccountId;
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'XE FTE', 'ARSA', 'FTS KAM'].includes(res.locals.role)) {
			AccountId = req.query.AccountId || [];
		}

		let whereClause = {
			AccountId: AccountId,
			'lastStatus.treadDepth': {
				[Op.gte]: 0, [Op.lte]: 4
			},
			tyreStatus: { [Op.notIn]: [3, 6] }
		};
		//0-In Stock,1-In Use,2-Removed,3-Retreading,4-Retreaded,5-Scrap,6-Scrap Complete.

		let Tyres = await models.Tyre.findAll({
			attributes: ['tyreNo', 'condition', 'mfgBy', 'model', 'initialTreadDepth', 'lastStatus', 'codeSize', 'AssetId', 'tyreStatus'],
			include: [{
				attributes: ['id', 'lplate', 'details'],
				model: models.Asset,
				required: false
			}],
			where: whereClause
		});

		let filteredTyres = Tyres;
		if (req.query.status) {
			if (req.query.status == 1) {
				filteredTyres = Tyres.filter(x => [0, 2, 4, 5].includes(x.tyreStatus));
			} else if (req.query.status == 2) {
				filteredTyres = Tyres.filter(x => x.tyreStatus == 1);
			}
		}

		//#region push result by status
		let inStock = {
			id: 1, name: "In Stock",
			count: Tyres.filter(x => [0, 2, 4, 5].includes(x.tyreStatus)).length || 0
		};
		let inVehicle = {
			id: 2, name: "In Vehicles",
			count: Tyres.filter(x => x.tyreStatus == 1).length || 0
		};
		inStock.percentage = Math.round((inStock.count / Tyres.length) * 100) || 0;
		inVehicle.percentage = Math.round((inVehicle.count / Tyres.length) * 100) || 0;
		Tyres = null;
		//#endregion

		let depth = [];
		let tyreDepthRanges = [{ start: 0, end: 1, name: '0.0-1.0 mm', id: 1 }, { start: 1.1, end: 2, name: '1.1-2.0 mm', id: 2 }, { start: 2.1, end: 3, name: '2.1-3.0 mm', id: 3 }, { start: 3.1, end: 4, name: '3.1-4.0 mm', id: 4 }];
		let tyreResults = [];
		let totalTyres = filteredTyres.length;
		for (const Tyre of filteredTyres) {
			tyreResults.push({
				AssetId: Tyre.AssetId,
				assetDetails: Tyre.Asset && Tyre.Asset.details || {},
				tyreNo: Tyre.tyreNo,
				depth: Tyre.lastStatus && Number(Tyre.lastStatus.treadDepth || 0),
				position: Tyre.AssetId && Tyre.lastStatus && Tyre.lastStatus.position || "",
				status: Tyre.tyreStatus
			});
		}

		//#region push result by depth
		let groupByAssetMap = new Map();
		for (const tyreDepthRange of tyreDepthRanges) {
			let result = {
				id: tyreDepthRange.id,
				name: tyreDepthRange.name
			};
			let matchTyres = tyreResults.filter(x => x.depth >= tyreDepthRange.start && x.depth <= tyreDepthRange.end);
			for (const matchTyre of matchTyres) {
				if (!groupByAssetMap.has(matchTyre.AssetId)) {
					groupByAssetMap.set(matchTyre.AssetId, []);
				}
				if (!req.query.depth || req.query.depth == tyreDepthRange.id) {
					groupByAssetMap.get(matchTyre.AssetId).push({
						tyreNo: matchTyre.tyreNo,
						AssetId: matchTyre.AssetId,
						assetDetails: matchTyre.assetDetails,
						position: matchTyre.position,
						depth: Number(matchTyre.depth).toFixed(2)
					});
				}
			}
			result.count = matchTyres.length;
			result.percentage = Math.round((matchTyres.length / tyreResults.length) * 100) || 0;
			depth.push(result);
		}
		//#endregion

		let stakeAnalytics = {
			totalTyres: totalTyres,
			status: [inStock, inVehicle],
			depth: depth,
			inStock: [],
			inVehicle: []
		};

		if (req.query.depth || req.query.status) {
			let macthedRange = tyreDepthRanges.find(x => x.id == req.query.depth);
			let matchedTyres = macthedRange && tyreResults.filter(x => x.depth >= macthedRange.start && x.depth <= macthedRange.end) || tyreResults;
			if (req.query.status == 1) { //In Stock filter
				let removed = { name: "Removed", count: 0 },
					retreaded = { name: "Retreaded", count: 0 },
					pendingDecision = { name: "Pending for Decision", count: 0 }

				for (const tyre of matchedTyres) {
					if (tyre.status == 2) {
						removed.count += 1;
					}
					if (tyre.status == 4) {
						retreaded.count += 1;
					}
					if (tyre.status == 5) {
						pendingDecision.count += 1;
					}
				}
				stakeAnalytics.inStock = [removed, pendingDecision, retreaded];
			}

			if (req.query.status == 2) { //In Vehicle filter
				let axleSlabs = {};
				// Loop through each asset and its tyres
				for (const [AssetId, tyresInAsset] of groupByAssetMap) {
					if (tyresInAsset[0] && tyresInAsset[0].assetDetails) {
						let axleProfile = tyresInAsset[0].assetDetails.axleProfile || {};
						let wheeler = axleProfile && axleProfile.wheeler || "";
						let config = axleProfile && axleProfile.config || "";
						let name = axleProfile && axleProfile.name || "";
						let configList = await avolveHelper.getMatchedConfigList(wheeler, config, name);
						configList.forEach(config => {
							const slabName = config.name == "Spare Wheel" ? "Spare" : config.name;
							if (!axleSlabs[slabName]) {
								axleSlabs[slabName] = 0;
							}
						});

						// Iterate each tyre and match with the config
						for (const tyre of tyresInAsset) {
							let matchedConfig = configList.find(config => config.position.includes(tyre.position));
							if (matchedConfig) {
								const slabName = matchedConfig.name == "Spare Wheel" ? "Spare" : matchedConfig.name;
								axleSlabs[slabName]++; // Increment count for matched axle
							}
						}
					}
				}

				// Change axleSlabs object into array format
				let result = Object.entries(axleSlabs).map(([name, count]) => ({ name, count }));
				stakeAnalytics.inVehicle = result;
			}
		}

		return res.send({ success: true, stakeAnalytics: stakeAnalytics });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching tyre data', error);
	}
}

exports.avolveScrapAnalytics = async function (req, res) {
	const ROUTE = 'app/reports/avolveScrapAnalytics ';
	try {
		if (!['FM', 'FO', 'HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'DE FTE', 'XE FTE', 'ARSA', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let AccountId = res.locals.AccountId;
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'XE FTE', 'ARSA', 'FTS KAM'].includes(res.locals.role)) {
			AccountId = req.query.AccountId || [];
		}

		let whereClause = {
			AccountId: AccountId,
			tyreStatus: { [Op.in]: [5, 6] } //5-Scrap,6-Scrap Complete
		};

		let Tyres = await models.Tyre.findAll({
			attributes: ['tyreNo', 'condition', 'mfgBy', 'model', 'initialTreadDepth', 'lastStatus', 'codeSize', 'AssetId', 'tyreStatus'],
			include: [{
				attributes: [],
				model: models.Account,
				where: {
					AccountIdParent: res.locals.masterAccountId
				}
			}],
			where: whereClause,
		});

		let tyreMakeModels = await models.TyreMakeModel.findAll({
			attributes: ['make', 'model', 'codeSize', 'initialTreadDepth', 'tyreType'],
			where: { apollo: true },
			raw: true
		});
		let tyreMakeMap = new Map();
		for (const makeModel of tyreMakeModels) {
			tyreMakeMap.set(`${makeModel.make}_${makeModel.model.trim()}_${makeModel.codeSize}`, makeModel);
		}
		tyreMakeModels = null;

		let tyreScrapWhere = {
			AccountId: AccountId,
			status: ['Scrap Complete', 'Scrap']
		};

		if (req.query.sdate && req.query.edate) {
			tyreScrapWhere.scrapDate = { [Op.between]: [moment(req.query.sdate, 'YYYY-MM-DD').startOf('day').toISOString(), moment(req.query.edate, 'YYYY-MM-DD').endOf('day').toISOString()] };
		}

		let TyreScraps = await models.TyreScrap.findAll({
			attributes: ['id', 'tyreNo', 'details', 'scrapDate', 'amount'],
			where: tyreScrapWhere,
			order: [['id', 'asc']],
			raw: true
		});
		let tyreScrapMap = {};
		for (const scrap of TyreScraps) {
			tyreScrapMap[scrap.tyreNo] = scrap;
		}
		TyreScraps = null;

		let SystemConfig = await models.SystemConfig.findOne({
			attributes: ['id', 'data'],
			where: {
				AccountId: res.locals.masterAccountId,
				module: 'Avolve',
				name: 'Tyre Masters'
			},
			raw : true
		});

		let scrapAnalytics = {
			scrappedTyres: 0, scrapTyres: 0, avgSalvageValue: 0, salvageTyres: 0,
			tyreLives: [{
				id: 1,
				name: 'Below 85% Life',
				count: 0
			}, {
				id: 2,
				name: 'Above 85% Life',
				count: 0
			}],
			tyreReasons: [], tyreMakes: [], monthlyStats: []
		};

		let tyreMakes = {}, monthlyStats = {};
		if (SystemConfig && SystemConfig.data && Object.keys(SystemConfig.data).length) {
			scrapAnalytics.tyreReasons = SystemConfig.data.scrapReasons.map(x => ({ count: 0, name: x.text, id: x.id })) || [];
		}

		let { sdate, edate } = req.query;
		if (sdate && edate) {
			let start = moment(sdate, "YYYY-MM-DD").startOf("month");
			let end = moment(edate, "YYYY-MM-DD").endOf("month");

			while (start.isSameOrBefore(end)) {
				let key = start.format("MMM'YY");
				monthlyStats[key] = { below: 0, btw: 0, above: 0 };
				start.add(1, "month");
			}
		} else {
			let currentDate = moment();
			for (let i = 0; i < 12; i++) {
				let date = currentDate.clone().subtract(i, "months").format("MMM'YY");
				monthlyStats[date] = { below: 0, btw: 0, above: 0 };
				if (date.startsWith("Apr")) break;
			}
		}

		for (const Tyre of Tyres) {
			let tyreStatus = Tyre.lastStatus && (Tyre.lastStatus.tyreStatus || Tyre.lastStatus.tyreStatus == 0) ? Tyre.lastStatus.tyreStatus : Tyre.tyreStatus;

			const tyreScrap = tyreScrapMap[Tyre.tyreNo];
			if (!tyreScrap) {
				continue;
			}

			if (tyreStatus == 5) {
				scrapAnalytics.scrapTyres += 1;
				continue;
			}

			scrapAnalytics.scrappedTyres += 1;
			if (tyreScrap.amount) {
				scrapAnalytics.avgSalvageValue += tyreScrap.amount;
				scrapAnalytics.salvageTyres += 1;
			}

			//#region Scrapped Tyre By Life
			let initialTreadDepth = Tyre.initialTreadDepth;
			let tyreMakeModel = tyreMakeMap.get(`${Tyre.mfgBy}_${Tyre.model.trim()}_${Tyre.codeSize}`) || {};
			if (tyreMakeModel) {
				initialTreadDepth = tyreMakeModel.initialTreadDepth;
			}

			let currTreadDepth = Tyre.lastStatus && Tyre.lastStatus.treadDepth || '';
			let tyreLife = (1 - currTreadDepth / parseFloat(initialTreadDepth)) * 100;
			tyreLife = tyreLife && !isFinite(tyreLife) ? 0 : parseFloat(tyreLife);

			if (tyreLife < 85) {
				scrapAnalytics.tyreLives[0].count += 1;
			} else {
				scrapAnalytics.tyreLives[1].count += 1;
			}
			//#endregion

			if (req.query.scrapTyreLifeId && ((tyreLife < 85 && req.query.scrapTyreLifeId != 1) || (tyreLife >= 85 && req.query.scrapTyreLifeId != 2))) {
				continue;
			}

			let scrapReasonId = null;
			if (tyreScrap && Object.keys(tyreScrap).length) {
				// Tyre Reasons 
				scrapReasonId = tyreScrap.details && tyreScrap.details.scrapReason && tyreScrap.details.scrapReason.id || null;
				if (scrapReasonId) {
					scrapAnalytics.tyreReasons[scrapReasonId - 1].count += 1;
				}

				if (req.query.scrapReasonId && scrapReasonId && scrapReasonId != Number(req.query.scrapReasonId)) {
					continue;
				}

				// Tyre Make
				let make = tyreMakeModel.make || Tyre.mfgBy;
				if (make) {
					setDefaultvalue(tyreMakes, make);
					tyreMakes[make].count += 1;
				}

				if (req.query.scrapTyreMake && make != req.query.scrapTyreMake) {
					continue;
				}

				// monthlyStats
				let date = tyreScrap.scrapDate ? moment(tyreScrap.scrapDate).format("MMM'YY") : null;
				if (date) {
					if (monthlyStats[date]) {
						if (tyreLife <= 30) monthlyStats[date].below += 1;
						else if (tyreLife <= 85) monthlyStats[date].btw += 1;
						else monthlyStats[date].above += 1;
					}
				}
			}
		}

		scrapAnalytics.avgSalvageValue = Math.round(scrapAnalytics.avgSalvageValue / scrapAnalytics.salvageTyres) || 0;
		scrapAnalytics.tyreMakes = Object.entries(tyreMakes).map(([name, data]) => ({ name, ...data }))
			.sort((a, b) => a.name.localeCompare(b.name));
		scrapAnalytics.monthlyStats = Object.entries(monthlyStats).map(([name, data]) => ({ name, ...data }));

		return res.send({ success: true, scrapAnalytics: scrapAnalytics });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching tyre data', error);
	}
}

function setDefaultvalue(obj, key) {
	if (!obj[key]) {
		obj[key] = {};
		obj[key].count = 0;
	}
}

exports.downloadAvolveCustomers = async function (req, res) {
	const ROUTE = 'app/reports/downloadAvolveCustomers';
	try {
		if (!['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let accountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, true);

		let kamResult = await avolveHelper.getKamListByCustomers(accountIds, res.locals.masterAccountId);
		kamUsers = kamResult.success && kamResult.results || [];

		let fteUsers = await avolveHelper.getFteUsersByCustomers(accountIds, false, res.locals.masterAccountId);
		fteUsers = fteUsers.results || [];

		let accountUsers = await avolveHelper.getUsersByAccounts(accountIds, kamUsers, fteUsers);
		accountUsers = accountUsers.results || [];

		let results = [];
		let offerInclude = { where: {}, required: false };
		let accountWhere = {
			id: accountIds,
			type: 11,
			AccountIdParent: res.locals.masterAccountId
		};

		// Filters
		if (req.query.slab) {
			offerInclude.where.slab = req.query.slab;
			offerInclude.required = true;
		}
		if (req.query.plan) accountWhere['details.plan'] = Number(req.query.plan);


		let Accounts = await models.Account.findAll({
			attributes: ['id', 'name', 'tname', 'status', 'details', 'serviceConfig', 'createdAt'],
			include: [{
				...{
					attributes: ['id', 'offerType', 'subOfferType', 'plan', 'slab', 'startDate', 'endDate', 'AccountId', 'details'],
					model: models.AplOffer,
				},
				...offerInclude
			}],
			where: accountWhere,
			order: [
				['createdAt', 'ASC'],
				[{ model: models.AplOffer }, 'id', 'DESC']
			]
		});

		const AplInvoices = await models.AplInvoice.findAll({
			attributes: ['id', 'AccountId'],
			include: [{
				attributes: ['id'],
				model: models.AplPayment,
				required: false
			}],
			where: {
				AccountId: {[Op.in] : accountIds}
			},
		});

		const unPaidInvoicesMap = {};
		if (req.query.channel == 2) { //Non TIS
			for (const invoice of AplInvoices) {
				const accId = invoice.AccountId;
				const isUnpaid = !invoice.AplPayments || !invoice.AplPayments.id;

				if (!unPaidInvoicesMap[accId]) {
					unPaidInvoicesMap[accId] = 0;
				}
				if (isUnpaid) {
					unPaidInvoicesMap[accId] += 1;
				}
			}
		}

		let mfCustomers = await avolveHelper.isMFCustomer(accountIds);

		Accounts = JSON.parse(JSON.stringify(Accounts));
		for (const Account of Accounts) {
			let accountUser = accountUsers.length && accountUsers.find(x => x.AccountId == Account.id) || '';
			let AplOffer = Account.AplOffers && Account.AplOffers.length && Account.AplOffers[0] || {};
			Account.isMFCust = mfCustomers[Account.id] || false;
			Account.pendingInvoices = unPaidInvoicesMap[Account.id] && unPaidInvoicesMap[Account.id] || 0;
			Account.AplOffer = AplOffer;
			delete Account.AplOffers;

			if ((req.query.channel == 1 && AplOffer.plan == 1) || (req.query.channel == 2 && (!AplOffer || !AplOffer.plan || AplOffer.plan == 2))) {
				let excelResult = await avolveHelper.getAvolveCustomerDetails(Account, accountUser);
				if (!excelResult.success) {
					logger.RaiseLogEvent(ROUTE, 'error', excelResult.error, "Error downloading customer details.")
					return res.send({ success: false, error: 'Error downloading excel' });
				}
				if (Object.keys(excelResult.result).length) {
					results.push(excelResult.result);
				}
			}
		}

		return await avolveHelper.avolveCustomerDetailsDumpExcelApp(results, false, res, req.query.channel);
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching customer details dump', error);
	}
}

exports.downloadMFCustomers = async function (req, res) {
	const ROUTE = 'app/reports/downloadMFCustomers ';
	try {
		if (!['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let accountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, true);

		let kamResult = await avolveHelper.getKamListByCustomers(accountIds, res.locals.masterAccountId);
		kamUsers = kamResult.success && kamResult.results || [];

		let fteUsers = await avolveHelper.getFteUsersByCustomers(accountIds, false, res.locals.masterAccountId);
		fteUsers = fteUsers.results || [];

		let accountUsers = await avolveHelper.getUsersByAccounts(accountIds, kamUsers, fteUsers);
		accountUsers = accountUsers.results || [];

		let AplOffers = await models.AplOffer.findAll({
			attributes: ['id', 'details', 'AccountId', 'startDate', 'endDate'],
			where: {
				AccountId: accountIds
			},
			order: [['id', 'asc']],
			raw: true
		});
		let AplOffersMap = avolveHelper.createMap(AplOffers, 'AccountId', false);
		AplOffers = null;

		let mfCustomers = await avolveHelper.isMFCustomer(accountIds);

		let results = [];
		for (const accountId of accountIds) {
			let accountUser = accountUsers.length && accountUsers.find(x => x.AccountId == accountId) || '';
			let AplOffer = AplOffersMap.get(accountId) || {};
			AplOffer.AccountId = accountId;
			AplOffer.isMFCust = mfCustomers[accountId] || false;

			let excelResult = await avolveHelper.getMFCustomerDetails(AplOffer, accountUser);
			if (!excelResult.success) {
				logger.RaiseLogEvent(ROUTE, 'error', excelResult.error, "Error downloading customer details.")
				return res.send({ success: false, error: 'Error downloading excel' });
			}
			if (Object.keys(excelResult.result).length) {
				results.push(excelResult.result);
			}
		}

		return await avolveHelper.mfCustomerDetailsDumpExcelApp(results, false, res);
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching customer details dump', error);
	}
}

exports.mfDashboard = async function (req, res) {
	const ROUTE = 'app/reports/mfDashboard ';
	try {
		if (!['HO Sales', 'ZM', 'KAM', 'FTS HO', 'FTS ZM', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		//#region user hierarchy with customers
		let accountIds = [];
		if (['KAM', 'FTS KAM'].includes(res.locals.role)) {
			if (req.query.AccountId) {
				accountIds = req.query.AccountId;
			} else {
				let custResult = await avolveHelper.getCustomersByUser(res.locals.UserId, false, res.locals.masterAccountId);
				if (custResult.success && custResult.results.length) {
					accountIds = custResult.results.map(x => x.id);
				} else {
					accountIds = res.locals.accountIds;
				}
			}
		} else {
			if (req.query.UserId) {
				let customerData = await avolveHelper.getCustomersByUser(req.query.UserId, false , res.locals.masterAccountId);
				if (customerData.success && customerData.results.length) {
					accountIds = customerData.results.map(x => x.id);
				}
			} else {
				let zmId = ["HO Sales", "FTS HO"].includes(res.locals.role) && res.locals.zmIds || res.locals.UserId;
				let kamResult = await avolveHelper.getKamListByUser(zmId);
				if (kamResult.success && kamResult.results.length) {
					let custResult = await avolveHelper.getCustomersByUser(kamResult.results.map(x => x.id), false , res.locals.masterAccountId);
					accountIds = custResult.results.map(x => x.id);
				}
			}
		}
		//#endregion

		let Assets = await models.Asset.findAll({
			attributes: ['id', 'AccountId', 'axleConfig'],
			include: [{
				attributes: [],
				model: models.Account,
				where: {
					AccountIdParent: res.locals.masterAccountId
				}
			}],
			where: {
				AccountId: {[Op.in]:accountIds},
				active: true,
				remove: false,
				[Op.and]: [models.sequelize.literal(`"Asset"."details"->'axleProfile'->'mf'->>'active' = 'true'`)]
			}
		});

		let result = mfDashboardSummaryStruct();
		let vehicleSummary = result.vehicleSummary;
		for (let Asset of Assets) {
			let activeAxleCount = 0, mfAxleCount = 0;
			if (Asset.axleConfig && Object.keys(Asset.axleConfig).length) {
				let sparePositions = ['SP', 'SP1', 'SP2', 'SP3', 'SP4'];
				for (let axle of Asset.axleConfig.config) {
					if (axle.position.some(pos => !sparePositions.includes(pos)) && axle.active) { //ignored spare & inactive axles
						activeAxleCount += 1;
					}
					if (axle.mf && axle.mf.active) {
						mfAxleCount += 1;
					}
				}
			}

			vehicleSummary.total += 1;
			if (activeAxleCount == mfAxleCount) {
				vehicleSummary.fullyMarked += 1;
			} else {
				vehicleSummary.partiallyMarked += 1;
			}
		}

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'tyreStatus', 'mfgBy', 'model', 'codeSize', 'radial', 'AssetId'],
			where: {
				AccountId: {[Op.in]:accountIds},
				tyreStatus: [1, 2, 4, 5, 6], //In Use, Removed, Retreaded, Scrap, Scrap Complete
				'details.mf': true
			},
			raw: true
		});

		let tyreSummary = result.tyreSummary;
		tyreSummary.total = Tyres.length;
		for (const Tyre of Tyres) {
			if (Tyre.mfgBy == 'Apollo') {
				tyreSummary.apollo.count += 1;
			} else {
				tyreSummary.nonApollo.count += 1;
			}

			if (Tyre.radial) {
				tyreSummary.radial.count += 1;
			} else {
				tyreSummary.bias.count += 1;
			}

			if (Tyre.tyreStatus == 6) {
				tyreSummary.scrapped.count += 1;
			} else if (Tyre.tyreStatus == 1) {
				tyreSummary.inUse.count += 1;
			} else {
				tyreSummary.notInUse.count += 1;
			}
		}

		for (const key in tyreSummary) {
			if (key != 'total' && tyreSummary.hasOwnProperty(key)) {
				tyreSummary[key].percentage = Number((tyreSummary[key].count / tyreSummary.total * 100 || 0).toFixed());
			}
		}

		return res.send({ success: true, result: { vehicleSummary: vehicleSummary, tyreSummary: tyreSummary } });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching data', error);
	}
}

exports.tyrePerformanceAnalytics = async function (req, res) {
	const ROUTE = 'app/reports/tyrePerformanceAnalytics ';
	try {
		if (!['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.query.AccountId || !req.query.condition) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let tyreWhere = {
			AccountId: req.query.AccountId,
			'lastStatus.condition': req.query.condition
		};

		let result = { types: ['Radial', 'Bias'], totalTyre: 0, slab: [], make: [] };
		let queryTyreType = req.query.tyreType && req.query.tyreType.toLowerCase() || '';
		if (req.query.tyreType) {
			if (req.query.tyreType == 'Radial') {
				tyreWhere.radial = true;
			} else {
				tyreWhere[Op.or] = [{ radial: false }, { radial: null }];
			}
			result.types = [req.query.tyreType];
		}

		let [Tyres, TyreHistories] = await Promise.all([
			models.Tyre.findAll({
				attributes: ['tyreNo', 'initialTreadDepth', 'lastStatus', 'radial', 'mfgBy', 'model', 'codeSize'],
				where: tyreWhere,
				raw: true
			}),
			models.TyreHistory.findAll({
				attributes: ['condition', 'tyreNo', 'treadDepth', 'transaction'],
				where: {
					AccountId: req.query.AccountId,
					transaction: ['Fitment', 'Purchase']
				},
				raw: true,
				order: [['histDate', 'DESC'], ['id', 'DESC']]
			})
		]);

		let fitmentHistoriesMap = new Map();
		let purchaseHistoriesMap = new Map();
		for (const tyreHist of TyreHistories) {
			if (tyreHist.transaction == 'Fitment') {
				if (!fitmentHistoriesMap.has(tyreHist.tyreNo)) {
					fitmentHistoriesMap.set(tyreHist.tyreNo, []);
				}
				fitmentHistoriesMap.get(tyreHist.tyreNo).push({ condition: tyreHist.condition, treadDepth: tyreHist.treadDepth });
			} else {
				purchaseHistoriesMap.set(tyreHist.tyreNo, { condition: tyreHist.condition });
			}
		}
		TyreHistories = null;

		//grouping histories by tyreNo
		let slabData = {
			"0-30%": { radial: { count: 0, totalKm: 0 }, bias: { count: 0, totalKm: 0 } },
			"31-50%": { radial: { count: 0, totalKm: 0 }, bias: { count: 0, totalKm: 0 } },
			"51-85%": { radial: { count: 0, totalKm: 0 }, bias: { count: 0, totalKm: 0 } },
			"86% & above": { radial: { count: 0, totalKm: 0 }, bias: { count: 0, totalKm: 0 } }
		};

		let totalTyreCount = 0;
		let makeData = {}, modelData = {}, sizeData = {};

		// slap calculation
		for (const Tyre of Tyres) {
			const latestHistory = Tyre.lastStatus || {};
			const purchaseHist = purchaseHistoriesMap.get(Tyre.tyreNo) || {};
			const fitmentHists = fitmentHistoriesMap.get(Tyre.tyreNo) || [];
			let currCycleFirstFit = fitmentHists.find(x => x.condition == latestHistory.condition) || null;
			if (!currCycleFirstFit) {
				const prevCondition = getPrevLifeCycleByCondition(latestHistory, purchaseHist);
				currCycleFirstFit = fitmentHists.find(
					x => (Array.isArray(prevCondition) ? prevCondition : [prevCondition]).includes(x.condition)
				) || {};
			}
			let fitmentNSD = (currCycleFirstFit.treadDepth || currCycleFirstFit.treadDepth == 0) ? currCycleFirstFit.treadDepth : 0;
			if (!fitmentNSD) {
				continue;
			}
			if (fitmentNSD < Number((latestHistory.treadDepth || latestHistory.treadDepth == 0) ? latestHistory : '')) {
				continue;
			}
			if (!latestHistory.tyreOdometer || Math.round(Number(latestHistory.tyreOdometer) / 1000) < 100) {
				continue;
			}

			//average grooves calculation
			const depthResult = avolveHelper.getAvgTreadDepth(latestHistory, false);

			//get tyre life data
			const { tyreLife = '', tyreLifeSlab = '' } = avolveHelper.calculateTyreLife(latestHistory.treadDepth, Tyre.initialTreadDepth, [], depthResult.averageDepth);

			//get tyre projected mileage dump
			const { outliersNote = [], projectedMileage } = await avolveHelper.calcProjectedMileage(depthResult.averageDepth, Tyre.initialTreadDepth, Number(fitmentNSD), latestHistory, true, tyreLife);
			if (outliersNote.length) {
				continue;
			}

			const tyreType = Tyre.radial ? 'radial' : 'bias';
			const normalize = (val) => (val || '').toUpperCase().replace(/\s+/g, '');
			if ((!req.query.make && !req.query.size && !req.query.model) || req.query.slab) {
				slabData[tyreLifeSlab][tyreType].count++;
				slabData[tyreLifeSlab][tyreType].totalKm += projectedMileage;
				totalTyreCount++;
			}
			if (req.query.slab && req.query.slab != tyreLifeSlab) {
				continue;
			}

			let makeName = normalize(Tyre.mfgBy);
			let sizeName = normalize(Tyre.codeSize);
			let modelName = normalize(Tyre.model);
			if (!req.query.slab) {
				const filters = [
					{ key: 'make', value: makeName },
					{ key: 'size', value: sizeName },
					{ key: 'model', value: modelName }
				];

				// Skip tyre if any filter doesn't match
				if (filters.some(f => req.query[f.key] && req.query[f.key] != f.value)) {
					continue;
				}
			}
			if (req.query.make && !req.query.slab) {
				totalTyreCount++;
				slabData[tyreLifeSlab][tyreType].count++;
				slabData[tyreLifeSlab][tyreType].totalKm += projectedMileage;
			}

			if (!makeData[makeName]) {
				makeData[makeName] = { radial: { count: 0, totalKm: 0 }, bias: { count: 0, totalKm: 0 } };
			}
			makeData[makeName][tyreType].count++;
			makeData[makeName][tyreType].totalKm += projectedMileage;

			if (req.query.make && req.query.make == makeName) {
				if (!sizeData[sizeName]) {
					sizeData[sizeName] = { radial: { count: 0, totalKm: 0 }, bias: { count: 0, totalKm: 0 } };
				}
				sizeData[sizeName][tyreType].count++;
				sizeData[sizeName][tyreType].totalKm += projectedMileage;

				if (req.query.size && req.query.size != sizeName) {
					continue;
				}
				if (!modelData[modelName]) {
					modelData[modelName] = { radial: { count: 0, totalKm: 0, active: true }, bias: { count: 0, totalKm: 0, active: true } };
				}
				modelData[modelName][tyreType].count++;
				modelData[modelName][tyreType].totalKm += projectedMileage;
			}
		}

		//convert to arrays
		const slabOrder = ["0-30%", "31-50%", "51-85%", "86% & above"];
		const slabArray = slabOrder.map((name, idx) => {
			let active = true;
			if (req.query.slab && name !== req.query.slab) {
				active = false;
			}
			const slab = slabData[name];
			return {
				name,
				radial: {
					count: slab.radial.count,
					mileage: parseInt(slab.radial.count > 0 ? slab.radial.totalKm / slab.radial.count : 0),
					active
				},
				bias: {
					count: slab.bias.count || 0,
					mileage: parseInt(slab.bias.count > 0 ? slab.bias.totalKm / slab.bias.count : 0),
					active
				}
			};
		});

		const makeArray = Object.keys(makeData).map(name => {
			let active = true;
			if (req.query.make && name != req.query.make) {
				active = false;
			}
			let make = makeData[name];
			return {
				name,
				radial: {
					count: make.radial.count,
					mileage: parseInt(make.radial.count > 0 ? make.radial.totalKm / make.radial.count : 0),
					active

				},
				bias: {
					count: make.bias.count,
					mileage: parseInt(make.bias.count > 0 ? make.bias.totalKm / make.bias.count : 0),
					active
				}
			}
		});
		if (queryTyreType === 'radial' || queryTyreType === 'bias') {
			makeArray.sort((a, b) => b[queryTyreType].mileage - a[queryTyreType].mileage);
		}

		result.totalTyre = totalTyreCount;
		result.slab = slabArray;
		result.make = makeArray;

		if (req.query.make) {
			const sizeArray = Object.keys(sizeData).map(name => {
				let active = true;
				if (req.query.size && name != req.query.size) {
					active = false;
				}
				let size = sizeData[name];
				return {
					name,
					radial: {
						count: size.radial.count,
						mileage: parseInt(size.radial.count > 0 ? size.radial.totalKm / size.radial.count : 0),
						active
					},
					bias: {
						count: size.bias.count,
						mileage: parseInt(size.bias.count > 0 ? size.bias.totalKm / size.bias.count : 0),
						active
					}
				}
			});
			result.size = sizeArray;
			if (queryTyreType === 'radial' || queryTyreType === 'bias') {
				sizeArray.sort((a, b) => b[queryTyreType].mileage - a[queryTyreType].mileage);
			}
			const modelArray = Object.keys(modelData).map(name => {
				let model = modelData[name];
				return {
					name,
					radial: {
						count: model.radial.count,
						mileage: parseInt(model.radial.count > 0 ? model.radial.totalKm / model.radial.count : 0),
						active: model.radial.active
					},
					bias: {
						count: model.bias.count,
						mileage: parseInt(model.bias.count > 0 ? model.bias.totalKm / model.bias.count : 0),
						active: model.bias.active
					}
				}
			});
			if (queryTyreType === 'radial' || queryTyreType === 'bias') {
				modelArray.sort((a, b) => b[queryTyreType].mileage - a[queryTyreType].mileage);
			}
			result.model = modelArray;
		}

		return res.send({ success: true, result: result });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching tyres', error);
	}
}

exports.performaceAnalyticsInfo = async function (req, res) {
	const ROUTE = 'app/reports/performaceAnalyticsInfo';
	try {
		let template = "<html><h2 style=\"font-size: 16px; font-weight: 600; text-align: center;\">Projected Mileage Estimation</h2><br>Mileage Projection is calculated on the basis of actual kms driven by the tyres and their utilized tread depth.<br><br>While running, tyre performs differently based on their tread wear. Based on which, we have segregated Tyre performance in 4 stages.<br><br><b>0-30% Tread Wear :</b><br>Initial break in of tyres do not warrant to predict/project the service life of any specific tyre.<br><br><b>31-50% Tread Wear :</b><br>It's not practical to accurately predict/project the service life of any specific tyre in chronological time since service conditions vary widely.<b><br><br>51-85% Tread Wear :</b><br>It's practical to accurately predict/project the service life of any specific tyre based on its wear rate stability.<br><br><b>86% &amp; above Tread Wear :</b><br>Mileage projection accuracy reaches its peak due to more actual tyre running, comprehensive wear data and established patterns.<br><br><br><i><font color='#979797'>Tyres are built to deliver thousands of kms of excellent service. For maximum benefit, tyres must be maintained properly to avoid any tyre damage that may result in premature removal from service before the tread is worn out upto its minimum (TWI) depth.</font></i><html>";
		return res.send({ success: true, result: template });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching info template', error);
	}
}

exports.mfInUseTyres = async function (req, res) {
	const ROUTE = 'app/reports/mfInUseTyres';
	try {
		if (!["KAM", "FTS KAM", "ZM", "FTS ZM", "HO Sales", "FTS HO"].includes(res.locals.role)) {
			return res.send({ success: false, error: "Not Authorized" });
		}
		let { consumerKey, type, tableName } = avolveHelper.getInsightDump(3, 'all') || {}; // mf in use configuration
		let valdidateBatchReport = await avolveHelper.isValidBatchReport(res.locals, req.query, type);
		if (valdidateBatchReport.error || valdidateBatchReport.message) {
			return res.send(valdidateBatchReport);
		}

		let { User = {}, partialEmail = '' } = valdidateBatchReport.result || {};
		let AccountIds = req.query.AccountId ? [req.query.AccountId] : [res.locals.AccountId];
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			AccountIds = req.query.AccountIds ? JSON.parse(req.query.AccountIds) : [];
		}
		let allCustomers = false;
		if (!AccountIds.length) {
			AccountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, false);
			allCustomers = true;
		}
		let tempTableName = `z_${tableName}_${res.locals.UserId}_${req.query.deviceId}`;
		// create a new insight record for the user
		let NewInsight = await models.Insight.create({
			type: type,
			input: {
				masterAccountId: res.locals.masterAccountId,
				tempTable: tempTableName,
				accountIds: {[Op.in]:AccountIds},
				app: true,
				fromApp: ['FM', 'FO'].includes(res.locals.role),
				deviceId: req.query.deviceId,
				tyreStatus: "In Use",
				typeId: 3,
				allCustomers,
				useAvolveEmail: false // use no-reply sender for mf in use tyres
			},
			progress: 0,
			startTime: moment(),
			UserId: res.locals.UserId,
			AccountId: res.locals.AccountId
		});

		evt.events.emit(`${consumerKey}-app`, {
			input: {
				accountIds: {[Op.in]:AccountIds},
				deviceId: req.query.deviceId,
				emailReport: true,
				tyreStatus: "In Use",
				typeId: 3 // mf in use tyres
			},
			masterAccountId: res.locals.masterAccountId,
			insightId: NewInsight.id,
			UserId: res.locals.UserId,
			AccountId: NewInsight.AccountId,
			emailReport: true,
			tempTable: tempTableName
		});

		return res.send({ success: true, message: `Report generation initiated. You can download it from the Downloads menu once processing is completed.` });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error downloading the summary of used tyres', err);
	}
}

exports.downloadServiceSummary = async function (req, res) {
	const ROUTE = 'app/reports/downloadServiceSummary';
	try {
		let { consumerKey, type, tableName } = avolveHelper.getInsightDump(23, 'all') || {}; // service summary
		let valdidateBatchReport = await avolveHelper.isValidBatchReport(res.locals, req.query, type);
		if (valdidateBatchReport.error || valdidateBatchReport.message) {
			return res.send(valdidateBatchReport);
		}

		let { User = {}, partialEmail = '' } = valdidateBatchReport.result || {};
		let AccountIds = req.query.AccountId ? [req.query.AccountId] : [res.locals.AccountId];
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			AccountIds = req.query.AccountIds ? JSON.parse(req.query.AccountIds) : [];
		}
		let allCustomers = false;
		if (!AccountIds.length) {
			AccountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, false);
			allCustomers = true;
		}
		let tempTableName = `z_${tableName}_${res.locals.UserId}_${req.query.deviceId}`;
		// create a new insight record for the user
		let NewInsight = await models.Insight.create({
			type: type,
			input: {
				masterAccountId: res.locals.masterAccountId,
				tempTable: tempTableName,
				accountIds: {[Op.in]:AccountIds},
				fromApp: ['FM', 'FO'].includes(res.locals.role),
				deviceId: req.query.deviceId,
				typeId: 23,
				allCustomers,
				useAvolveEmail: false // use no-reply sender for service summary
			},
			progress: 0,
			UserId: res.locals.UserId,
			startTime: moment(),
			AccountId: res.locals.AccountId
		});

		evt.events.emit(`${consumerKey}-app`, {
			input: {
				accountIds: {[Op.in]:AccountIds},
				sdate: moment(req.query.sdate).format('YYYY-MM-DD'),
				edate: moment(req.query.edate).format('YYYY-MM-DD'),
				deviceId: req.query.deviceId,
				emailReport: true,
				typeId: 23 // service summary
			},
			masterAccountId: res.locals.masterAccountId,
			insightId: NewInsight.id,
			UserId: res.locals.UserId,
			AccountId: NewInsight.AccountId,
			emailReport: true,
			tempTable: tempTableName
		});

		return res.send({ success: true, message: `Report generation initiated. You can download it from the Downloads menu once processing is completed.` });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error downloading service summary', err);
	}
}

exports.mfNotInUseTyres = async function (req, res) {
	const ROUTE = 'app/reports/mfNotInUseTyres ';
	try {
		if (!["KAM", "FTS KAM", "ZM", "FTS ZM", "HO Sales", "FTS HO"].includes(res.locals.role)) {
			return res.send({ success: false, error: "Not Authorized" });
		}
		let { consumerKey, type, tableName } = avolveHelper.getInsightDump(4, 'all') || {}; // mf not in use configuration
		let valdidateBatchReport = await avolveHelper.isValidBatchReport(res.locals, req.query, type);
		if (valdidateBatchReport.error || valdidateBatchReport.message) {
			return res.send(valdidateBatchReport);
		}

		let { User = {}, partialEmail = '' } = valdidateBatchReport.result || {};
		let AccountIds = req.query.AccountId ? [req.query.AccountId] : [res.locals.AccountId];
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			AccountIds = req.query.AccountIds ? JSON.parse(req.query.AccountIds) : [];
		}
		let allCustomers = false;
		if (!AccountIds.length) {
			AccountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, false);
			allCustomers = true;
		}
		let tempTableName = `z_${tableName}_${res.locals.UserId}_${req.query.deviceId}`;
		// create a new insight record for the user
		let NewInsight = await models.Insight.create({
			type: type,
			input: {
				masterAccountId: res.locals.masterAccountId,
				tempTable: tempTableName,
				accountIds: {[Op.in]:AccountIds},
				app: true,
				fromApp: ['FM', 'FO'].includes(res.locals.role),
				deviceId: req.query.deviceId,
				tyreStatus: "Not In Use",
				typeId: 4,
				allCustomers,
				useAvolveEmail: false // use no-reply sender for mf not in use tyres
			},
			progress: 0,
			startTime: moment(),
			UserId: res.locals.UserId,
			AccountId: res.locals.AccountId
		});

		evt.events.emit(`${consumerKey}-app`, {
			input: {
				accountIds: {[Op.in]:AccountIds},
				deviceId: req.query.deviceId,
				emailReport: true,
				tyreStatus: "Not In Use",
				typeId: 4 // mf not in use tyres
			},
			masterAccountId: res.locals.masterAccountId,
			insightId: NewInsight.id,
			UserId: res.locals.UserId,
			AccountId: NewInsight.AccountId,
			emailReport: true,
			tempTable: tempTableName
		});

		return res.send({ success: true, message: `Report generation initiated. You can download it from the Downloads menu once processing is completed.` });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error downloading the summary of not used tyres', err);
	}
}

exports.mfScrappedTyres = async function (req, res) {
	const ROUTE = 'app/reports/mfScrappedTyres';
	try {
		if (!["KAM", "FTS KAM", "ZM", "FTS ZM", "HO Sales", "FTS HO"].includes(res.locals.role)) {
			return res.send({ success: false, error: "Not Authorized" });
		}
		let { consumerKey, type, tableName } = avolveHelper.getInsightDump(5, 'all') || {}; // mf scrapped configuration
		let valdidateBatchReport = await avolveHelper.isValidBatchReport(res.locals, req.query, type);
		if (valdidateBatchReport.error || valdidateBatchReport.message) {
			return res.send(valdidateBatchReport);
		}

		let { User = {}, partialEmail = '' } = valdidateBatchReport.result || {};
		let AccountIds = req.query.AccountId ? [req.query.AccountId] : [res.locals.AccountId];
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			AccountIds = req.query.AccountIds ? JSON.parse(req.query.AccountIds) : [];
		}
		let allCustomers = false;
		if (!AccountIds.length) {
			AccountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, false);
			allCustomers = true;
		}
		let tempTableName = `z_${tableName}_${res.locals.UserId}_${req.query.deviceId}`;
		// create a new insight record for the user
		let NewInsight = await models.Insight.create({
			type: type,
			input: {
				masterAccountId: res.locals.masterAccountId,
				tempTable: tempTableName,
				accountIds: {[Op.in]:AccountIds},
				app: true,
				fromApp: ['FM', 'FO'].includes(res.locals.role),
				deviceId: req.query.deviceId,
				tyreStatus: "Scrapped",
				typeId: 5,
				allCustomers,
				useAvolveEmail: false // use no-reply sender for mf scrapped tyres
			},
			progress: 0,
			startTime: moment(),
			UserId: res.locals.UserId,
			AccountId: res.locals.AccountId
		});

		evt.events.emit(`${consumerKey}-app`, {
			input: {
				accountIds: {[Op.in]:AccountIds},
				deviceId: req.query.deviceId,
				emailReport: true,
				tyreStatus: "Scrapped",
				typeId: 5 // mf scrapped tyres
			},
			masterAccountId: res.locals.masterAccountId,
			insightId: NewInsight.id,
			UserId: res.locals.UserId,
			AccountId: NewInsight.AccountId,
			emailReport: true,
			tempTable: tempTableName
		});

		return res.send({ success: true, message: `Report generation initiated. You can download it from the Downloads menu once processing is completed.` });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error downloading the scrapped tyres dump', err);
	}
}

exports.mfVehicles = async function (req, res) {
	const ROUTE = 'app/reports/mfVehicles ';
	try {
		let { consumerKey, type, tableName } = avolveHelper.getInsightDump(8, 'all') || {}; // mf vehicle summary configuration
		let valdidateBatchReport = await avolveHelper.isValidBatchReport(res.locals, req.query, type);
		if (valdidateBatchReport.error || valdidateBatchReport.message) {
			return res.send(valdidateBatchReport);
		}

		let allCustomers = false;
		let { User = {}, partialEmail = '' } = valdidateBatchReport.result || {};
		let accountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, false);
		allCustomers = true;
		let tempTableName = `z_${tableName}_${res.locals.UserId}_${req.query.deviceId}`
		// create a new insight record for the user
		let NewInsight = await models.Insight.create({
			type: type,
			input: {
				masterAccountId: res.locals.masterAccountId,
				tempTable: tempTableName,
				accountIds: accountIds,
				mf: true,
				deviceId: req.query.deviceId,
				typeId: 8,
				allCustomers,
				useAvolveEmail: false // use no-reply sender
			},
			progress: 0,
			startTime: moment(),
			UserId: res.locals.UserId,
			AccountId: res.locals.AccountId
		});

		evt.events.emit(consumerKey, {
			input: {
				accountIds: accountIds,
				deviceId: req.query.deviceId,
				emailReport: true,
				mf: true,
				typeId: 8 // mf vehicle summary
			},
			masterAccountId: res.locals.masterAccountId,
			insightId: NewInsight.id,
			UserId: res.locals.UserId,
			AccountId: NewInsight.AccountId,
			emailReport: true,
			tempTable: tempTableName
		});

		return res.send({ success: true, message: `Report generation initiated. You can download it from the Downloads menu once processing is completed.` });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error downloading the mf vehicles', err);
	}
}

exports.downloadTyreAnalytics = async function (req, res) {
	const ROUTE = 'app/reports/downloadTyreAnalytics';
	try {
		let { consumerKey, type, tableName } = avolveHelper.getInsightDump(1, 'all') || {}; // tyre analytics configuration
		let valdidateBatchReport = await avolveHelper.isValidBatchReport(res.locals, req.query, type);
		if (valdidateBatchReport.error || valdidateBatchReport.message) {
			return res.send(valdidateBatchReport);
		}

		let { User = {}, partialEmail = '' } = valdidateBatchReport.result || {};
		let AccountIds = req.query.AccountId ? [req.query.AccountId] : [res.locals.AccountId];
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			AccountIds = req.query.AccountIds ? JSON.parse(req.query.AccountIds) : [];
		}
		let allCustomers = false;
		if (!AccountIds.length) {
			AccountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, false);
			allCustomers = true;
		}
		let tempTableName = `z_${tableName}_${res.locals.UserId}_${req.query.deviceId}`;
		// create a new insight record for the user
		let NewInsight = await models.Insight.create({
			type: type,
			input: {
				masterAccountId: res.locals.masterAccountId,
				tempTable: tempTableName,
				accountIds: {[Op.in]:AccountIds},
				fromApp: ['FM', 'FO'].includes(res.locals.role),
				deviceId: req.query.deviceId,
				typeId: 1,
				allCustomers,
				useAvolveEmail: false // use no-reply sender for tyre analytics
			},
			progress: 0,
			startTime: moment(),
			UserId: res.locals.UserId,
			AccountId: res.locals.AccountId
		});

		evt.events.emit(`${consumerKey}-app`, {
			input: {
				accountIds: {[Op.in]:AccountIds},
				deviceId: req.query.deviceId,
				emailReport: true,
				typeId: 1 // tyre analytics
			},
			masterAccountId: res.locals.masterAccountId,
			insightId: NewInsight.id,
			UserId: res.locals.UserId,
			AccountId: NewInsight.AccountId,
			emailReport: true,
			tempTable: tempTableName
		});

		return res.send({ success: true, message: `Report generation initiated. You can download it from the Downloads menu once processing is completed.` });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error downloading the tyre analytics dump', error);
	}
}

exports.downloadScrapAnalytics = async function (req, res) {
	const ROUTE = 'app/reports/downloadScrapAnalytics';
	try {
		let { consumerKey, type, tableName } = avolveHelper.getInsightDump(6, 'all') || {}; // scrapAnalytics configuration
		let valdidateBatchReport = await avolveHelper.isValidBatchReport(res.locals, req.query, type);
		if (valdidateBatchReport.error || valdidateBatchReport.message) {
			return res.send(valdidateBatchReport);
		}

		let { User = {}, partialEmail = '' } = valdidateBatchReport.result || {};
		let tempTableName = `z_${tableName}_${res.locals.UserId}_${req.query.deviceId}`;
		let AccountIds = req.query.AccountId ? [req.query.AccountId] : [res.locals.AccountId];
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			AccountIds = req.query.AccountIds ? JSON.parse(req.query.AccountIds) : [];
		}
		let allCustomers = false;
		if (!AccountIds.length) {
			AccountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, false);
			allCustomers = true;
		}

		// create a new insight record for the user
		let NewInsight = await models.Insight.create({
			type: type,
			input: {
				masterAccountId: res.locals.masterAccountId,
				tempTable: tempTableName,
				accountIds: {[Op.in]:AccountIds},
				fromApp: ['FM', 'FO'].includes(res.locals.role),
				deviceId: req.query.deviceId,
				typeId: 6,
				allCustomers,
				useAvolveEmail: false // use no-reply sender
			},
			progress: 0,
			startTime: moment(),
			UserId: res.locals.UserId,
			AccountId: res.locals.AccountId
		});

		evt.events.emit(`${consumerKey}-app`, {
			input: {
				accountIds: AccountIds,
				deviceId: req.query.deviceId,
				emailReport: true,
				typeId: 6 // scrapAnalytics
			},
			masterAccountId: res.locals.masterAccountId,
			insightId: NewInsight.id,
			UserId: res.locals.UserId,
			AccountId: NewInsight.AccountId,
			emailReport: true,
			tempTable: tempTableName
		});

		return res.send({ success: true, message: `Report generation initiated. You can download it from the Downloads menu once processing is completed.` });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error downloading the scrap analytics dump', error);
	}
}

exports.downloadStakeAnalytics = async function (req, res) {
	const ROUTE = 'app/reports/downloadStakeAnalytics';
	try {
		let { consumerKey, type, tableName } = avolveHelper.getInsightDump(10, 'all') || {}; // stake analytics configuration
		let valdidateBatchReport = await avolveHelper.isValidBatchReport(res.locals, req.query, type);
		if (valdidateBatchReport.error || valdidateBatchReport.message) {
			return res.send(valdidateBatchReport);
		}

		let { User = {}, partialEmail = '' } = valdidateBatchReport.result || {};
		let tempTableName = `z_${tableName}_${res.locals.UserId}_${req.query.deviceId}`;
		let AccountIds = req.query.AccountId ? [req.query.AccountId] : [res.locals.AccountId];
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			AccountIds = req.query.AccountIds ? JSON.parse(req.query.AccountIds) : [];
		}
		let allCustomers = false;
		if (!AccountIds.length) {
			AccountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, false);
			allCustomers = true;
		}

		// create a new insight record for the user
		let NewInsight = await models.Insight.create({
			type: type,
			input: {
				masterAccountId: res.locals.masterAccountId,
				tempTable: tempTableName,
				accountIds: {[Op.in]:AccountIds},
				fromApp: ['FM', 'FO'].includes(res.locals.role),
				deviceId: req.query.deviceId,
				typeId: 10,
				allCustomers,
				useAvolveEmail: false // use no-reply sender
			},
			progress: 0,
			startTime: moment(),
			UserId: res.locals.UserId,
			AccountId: res.locals.AccountId
		});

		evt.events.emit(`${consumerKey}-app`, {
			input: {
				accountIds: {[Op.in]:AccountIds},
				deviceId: req.query.deviceId,
				emailReport: true,
				typeId: 10 // stake analytics
			},
			masterAccountId: res.locals.masterAccountId,
			insightId: NewInsight.id,
			UserId: res.locals.UserId,
			AccountId: NewInsight.AccountId,
			emailReport: true,
			tempTable: tempTableName
		});

		return res.send({ success: true, message: `Report generation initiated. You can download it from the Downloads menu once processing is completed.` });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error downloading the scrap analytics dump', error);
	}
}

exports.downloadInspectionAnalytics = async function (req, res) {
	const ROUTE = 'app/reports/downloadInspectionAnalytics ';
	try {
		let { consumerKey, type, tableName } = avolveHelper.getInsightDump(11, 'all') || {}; // inspection analytics configuration
		let valdidateBatchReport = await avolveHelper.isValidBatchReport(res.locals, req.query, type);
		if (valdidateBatchReport.error || valdidateBatchReport.message) {
			return res.send(valdidateBatchReport);
		}

		let { User = {}, partialEmail = '' } = valdidateBatchReport.result || {};
		let tempTableName = `z_${tableName}_${res.locals.UserId}_${req.query.deviceId}`;
		let AccountIds = req.query.AccountId ? [req.query.AccountId] : [res.locals.AccountId];
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			AccountIds = req.query.AccountIds ? JSON.parse(req.query.AccountIds) : [];
		}
		let allCustomers = false;
		if (!AccountIds.length) {
			AccountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, false);
			allCustomers = true;
		}

		// create a new insight record for the user
		let NewInsight = await models.Insight.create({
			type: type,
			input: {
				masterAccountId: res.locals.masterAccountId,
				tempTable: tempTableName,
				accountIds: {[Op.in]:AccountIds},
				fromApp: ['FM', 'FO'].includes(res.locals.role),
				deviceId: req.query.deviceId,
				typeId: 11,
				allCustomers,
				useAvolveEmail: false, // use no-reply sender
				...(req.query)
			},
			progress: 0,
			startTime: moment(),
			UserId: res.locals.UserId,
			AccountId: res.locals.AccountId
		});

		evt.events.emit(`${consumerKey}-app`, {
			input: {
				accountIds: {[Op.in]:AccountIds},
				deviceId: req.query.deviceId,
				emailReport: true,
				typeId: 11 // inspection analytics
			},
			masterAccountId: res.locals.masterAccountId,
			insightId: NewInsight.id,
			UserId: res.locals.UserId,
			AccountId: NewInsight.AccountId,
			emailReport: true,
			tempTable: tempTableName
		});

		return res.send({ success: true, message: `Report generation initiated. You can download it from the Downloads menu once processing is completed.` });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error downloading the inspection analytics dump', error);
	}
}

exports.downloadPerformanceAnalytics = async function (req, res) {
	const ROUTE = 'app/reports/downloadPerformanceAnalytics';
	try {
		let { consumerKey, type, tableName } = avolveHelper.getInsightDump(25, 'all') || {}; // performance analytics configuration
		let valdidateBatchReport = await avolveHelper.isValidBatchReport(res.locals, req.query, type);
		if (valdidateBatchReport.error || valdidateBatchReport.message) {
			return res.send(valdidateBatchReport);
		}

		let { User = {}, partialEmail = '' } = valdidateBatchReport.result || {};
		let tempTableName = `z_${tableName}_${res.locals.UserId}_${req.query.deviceId}`;
		let AccountIds = req.query.AccountId ? [req.query.AccountId] : [res.locals.AccountId];
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].includes(res.locals.role)) {
			AccountIds = req.query.AccountIds ? JSON.parse(req.query.AccountIds) : [];
		}
		let allCustomers = false;
		if (!AccountIds.length) {
			AccountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, false);
			allCustomers = true;
		}

		// create a new insight record for the user
		let NewInsight = await models.Insight.create({
			type: type,
			input: {
				masterAccountId: res.locals.masterAccountId,
				tempTable: tempTableName,
				accountIds: {[Op.in]:AccountIds},
				fromApp: ['FM', 'FO'].includes(res.locals.role),
				deviceId: req.query.deviceId,
				typeId: 25,
				allCustomers,
				useAvolveEmail: false, // use no-reply sender
				...(req.query)
			},
			progress: 0,
			startTime: moment(),
			UserId: res.locals.UserId,
			AccountId: res.locals.AccountId
		});

		evt.events.emit(`${consumerKey}-app`, {
			input: {
				accountIds: {[Op.in]:AccountIds},
				deviceId: req.query.deviceId,
				emailReport: true,
				conditions: req.query.condition ? [req.query.condition] : [],
				typeId: 25 // performance analytics
			},
			masterAccountId: res.locals.masterAccountId,
			insightId: NewInsight.id,
			UserId: res.locals.UserId,
			AccountId: NewInsight.AccountId,
			emailReport: true,
			tempTable: tempTableName
		});

		return res.send({ success: true, message: `Report generation initiated. You can download it from the Downloads menu once processing is completed.` });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error downloading the performance analytics dump', error);
	}
}

exports.downloadDraftCustomers = async function (req, res) {
	const ROUTE = 'app/reports/downloadDraftCustomers';
	try {
		if (!['KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let AplAccountDrafts = await models.AplAccountDraft.findAll({
			attributes: ['id', 'details', 'AccountId', 'status'],
			include: [{
				attributes: ['id', 'createdAt'],
				model: models.Account
			}],
			where: {
				status: [1, 2]
			},
			order: [['id', 'asc']],
			raw: true
		});

		let results = [];
		for (const AplAccountDraft of AplAccountDrafts) {
			let details = AplAccountDraft.details || {};
			let accCreatedDate = AplAccountDraft['Account.createdAt'] && moment(AplAccountDraft['Account.createdAt']) || '';
			const { slab, channel } = avolveHelper.avolveOfferLookUp({
				plan: details.offer && details.offer.plan || '',
				slab: details.offer && details.offer.slab || ''
			}) || {};

			results.push({
				mdgId: details.mdgId || '',
				createdAt: accCreatedDate && accCreatedDate.format('DD/MM/YYYY'),
				tname: details.tname || '',
				pendingDays: moment().diff(accCreatedDate, 'days') || '',
				vehicles: details.offer && details.offer.vehicles || '',
				slab: slab || '',
				channel: channel || '',
				status: AplAccountDraft.status == 1 ? 'MDG created' : 'Incomplete information'
			});
		}

		return await avolveHelper.draftCustomersExcelDump(results, false, res);
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching customer details dump', error);
	}
}

exports.apolloFleetInventoryAnalytics = async function (req, res) {
	const ROUTE = 'app/reports/apolloFleetInventoryAnalytics ';
	try {
		let result = await reportHelper.inventoryAnalytics(req, res);
		if (result.error) {
			logger.RaiseLogEvent(ROUTE, 'error', result.error, `Error: ${result.error}`);
			return res.send({ success: false, error: result.error, inventoryAnalytics: {} });
		}
		if (req.query && req.query.excel && req.query.excel == "true") {
			return result;
		} else {
			return res.send({ success: true, inventoryAnalytics: result });
		}
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching report', error);
	}
}

exports.apolloFleetScrapAnalytics = async function (req, res) {
	const ROUTE = 'app/reports/apolloFleetScrapAnalytics ';
	try {
		let result = await reportHelper.scrapAnalytics(req, res);
		if (result.error) {
			logger.RaiseLogEvent(ROUTE, 'error', result.error, `Error fetching srap analytics`);
			return res.send({ success: false, error: result.error, scrapAnalytics: {} });
		}
		if (req.query && req.query.excel && req.query.excel == "true") {
			return result;
		} else {
			return res.send({ success: true, scrapAnalytics: result });
		}
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching report', error);
	}
}

exports.apolloFleetStakeAnalytics = async function (req, res) {
	const ROUTE = 'app/reports/apolloFleetStakeAnalytics';
	try {
		let result = await reportHelper.stakeAnalytics(req, res);
		if (result.error) {
			logger.RaiseLogEvent(ROUTE, 'error', result.error, `Error fetching stake analytics`);
			return res.send({ success: false, error: result.error, stakeAnalytics: {} });
		}
		if (req.query && req.query.excel && req.query.excel == "true") {
			let fileName = `Stake_Analytics_Report`;
			var filePath = path.join(`${__dirname}, ../../../../public/help/${fileName}.xlsx`);
			let destFileUrl = `/help/${fileName}.xlsx`;
			fs.unlink(filePath, async function (err) {
				if (err) {
					console.log(`File delete error: ${err}`);
				}
				await result.xlsx.writeFile(filePath);
				return res.send({ success: true, url: destFileUrl });
			});
		} else {
			return res.send({ success: true, stakeAnalytics: result });
		}
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching report', error);
	}
}

exports.apolloFleetInspectionAnalytics = async function (req, res) {
	const ROUTE = 'app/reports/apolloFleetInspectionAnalytics  ';
	try {
		logger.RaiseLogEvent(ROUTE, req.query && req.query.AccountId || 'log', req.query, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.query.sdate || !req.query.edate) {
			return res.send({ success: false, error: 'Missing input parameters.', inspectionAnalytics: {} });
		}
		let result = await reportHelper.inspectionAnalytics(req, res);
		if (result.error && Object.keys(result.error).length) {
			logger.RaiseLogEvent(ROUTE, 'error', result.error, `Error fetching inspection analytics`);
			return res.send({ success: false, error: result.error, inspectionAnalytics: {} });
		}
		if (req.query && req.query.excel && req.query.excel == "true") {
			return result;
		} else {
			return res.send({ success: true, inspectionAnalytics: result });
		}
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching report', error);
	}
}

function getPartialEmail(email) {
	let [username, domain] = email.split('@');

	let firstTwoChars = username.substring(0, 2);
	let lastTwoChars = username.substring(username.length - 2);
	let middlePart = "x".repeat(username.length - 4);

	let formattedEmail = firstTwoChars + middlePart + lastTwoChars + "@" + domain;

	return formattedEmail;
}

function mfDashboardSummaryStruct() {
	return {
		vehicleSummary: {
			total: 0,
			partiallyMarked: 0,
			fullyMarked: 0
		},
		tyreSummary: {
			total: 0,
			radial: {
				count: 0,
				percentage: 0
			},
			bias: {
				count: 0,
				percentage: 0
			},
			apollo: {
				count: 0,
				percentage: 0
			},
			nonApollo: {
				count: 0,
				percentage: 0
			},
			inUse: {
				count: 0,
				percentage: 0
			},
			notInUse: {
				count: 0,
				percentage: 0
			},
			scrapped: {
				count: 0,
				percentage: 0
			}
		}
	}
}

function serviceDumpStruct() {
	return {
		tname: '',
		accName: '',
		offerName: '',
		subOfferName: '',
		lplate: '',
		workshop: '',
		serviceName: '',
		serviceType: '',
		alertDate: '',
		alertBased: '',
		dueDate: '',
		schDate: '',
		schFte: '',
		schZone: '',
		reSchDate: '',
		reSchFte: '',
		rejDate: '',
		rejFte: '',
		rejReason: '',
		accDate: '',
		accFte: '',
		excDate: '',
		excFte: '',
		jobDate: '',
		status: '',
		fteName: '',
		kamName: ''
	}
}

/**
 * Returns the previous condition in the lifecycle for a given tyre history.
 * If the tyre is in its initial condition (same as purchase or "New"/"Used"), it returns the current condition.
 * Otherwise, it returns the previous condition from the predefined lifecycle.
 *
 * @param {Object} latestHist - The latest tyre history object.
 * @param {Object} purchaseHist - The purchase history object of the tyre.
 * @returns {string|Array|null} - The previous condition string, array (for ['New', 'Used']), or null if not found.
 */
function getPrevLifeCycleByCondition(latestHist, purchaseHist) {
	if ((purchaseHist.condition == latestHist.condition) || ['New', 'Used'].includes(latestHist.condition)) {
		return latestHist.condition;
	}
	const conditions = [['New', 'Used'], 'Retread 1', 'Retread 2', 'Retread 3', 'Retread 4'];
	const index = conditions.findIndex(condition =>
		Array.isArray(condition) ? condition.includes(latestHist.condition) : condition == latestHist.condition
	);
	return index > 0 ? conditions[index - 1] : null;
}
