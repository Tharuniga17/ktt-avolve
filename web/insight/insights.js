const models = require('../../../models');
const evt = require('../../../lib/event');
const moment = require('moment');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { handleApiError } = require('../../middlewares/helper');
const { validateJson } = require('../../middlewares/helper');
const avolveHelper = require('../../../lib/helpers/avolveHelper');


exports.createInsight = async function (req, res) {
	const ROUTE = 'web/insights/createInsight';
	try {
		const validation = validateJson(req, 'insightsInput');
		if (!validation.valid) {
			return res.send({ success: false, error: validation.message, results: [] });
		}
		const insightsInputReqObj = req.body.insightsInput;
		//#region validate
		if (validateInsightInput(insightsInputReqObj)) {
			return res.send({ success: false, error: 'Input Parameters missing.', results: [] });
		}
		if (insightsInputReqObj.category == 'count' && !+insightsInputReqObj.splitUp) {
			return res.send({ success: false, error: 'Splitup mandatory.', results: [] });
		}
		if (insightsInputReqObj.type == 'apl-inspection-summary') {
			if (moment(insightsInputReqObj.edate).diff(insightsInputReqObj.sdate, 'years') > 1) {
				return res.send({ success: false, error: 'More than one year not allowed' });
			}
		}
		//#endregion

		let keyName = `insights-${insightsInputReqObj.type}`;
		if (insightsInputReqObj.type && insightsInputReqObj.typeId) {
			let insightTableName = avolveHelper.getInsightDump(insightsInputReqObj.typeId, 'tableName');
			tempTableName = `z_${insightTableName}_${res.locals.UserId}`
			insightsInputReqObj.tempTable = tempTableName;

			keyName = avolveHelper.getInsightDump(insightsInputReqObj.typeId, 'consumerKey');
			insightsInputReqObj.emailStatus = false;
		}
		let insightsObj = getInsightObj(insightsInputReqObj, req.originalUrl, res);
		let Insight = await models.Insight.create(insightsObj);
		evt.events.emit(
			keyName,
			{
				input: insightsInputReqObj,
				insightId: Insight.id,
				AccountId: res.locals.AccountId,
				tempTable: tempTableName,
				UserId: res.locals.UserId
			}
		);
		return res.send({ success: true, result: Insight });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error creating insightsr', error);
	}
}

function getInsightObj(insightsInput, route, res) {
	let obj = {
		UserId: res.locals.UserId,
		input: insightsInput,
		routerName: route,
		type: insightsInput.type,
		progress: 0,
		startTime: moment().toString(),
		AccountId: res.locals.AccountId,
		masterAccountId: res.locals.masterAccountId
	}
	if (insightsInput.sRange && insightsInput.eRange) {
		obj.sRange = insightsInput.sRange;
		obj.eRange = insightsInput.eRange;
	}
	return obj;
}

function validateInsightInput(insightsInputReqObj) {
	switch (insightsInputReqObj.type) {
		case 'km-chart':
			return !insightsInputReqObj.assetIds || !insightsInputReqObj.sdate || !insightsInputReqObj.edate || !+insightsInputReqObj.splitUp;
		case 'stoppage-km':
			return !insightsInputReqObj.assetIds || !+insightsInputReqObj.splitUp ||
				!insightsInputReqObj.sdate || !insightsInputReqObj.edate ||
				insightsInputReqObj.maxIdle < 5;
		case 'overspeed-km-chart':
			return !insightsInputReqObj.assetIds || !insightsInputReqObj.sdate || !insightsInputReqObj.edate
				|| !insightsInputReqObj.maxspeed || !insightsInputReqObj.category;
		case 'speed-distribution':
			return !insightsInputReqObj.assetIds || !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'tpms-vehicle-analysis':
			return !insightsInputReqObj.assetIds || !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'tpms-tyre-analysis':
			return !insightsInputReqObj.tyreNo || !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'tpms-raw-data':
			return !insightsInputReqObj.assetIds || !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'harsh-acceleration-braking':
			return !insightsInputReqObj.assetIds || !insightsInputReqObj.sdate || !insightsInputReqObj.edate || !insightsInputReqObj.chartType || !insightsInputReqObj.sRange || !insightsInputReqObj.eRange;
		case 'vehicle-route-speed-map':
			return !insightsInputReqObj.assetIds || !insightsInputReqObj.sdate || !insightsInputReqObj.edate || !insightsInputReqObj.mapType;
		case 'engine-working-hours':
			return !insightsInputReqObj.assetIds || !insightsInputReqObj.sdate || !insightsInputReqObj.edate || !insightsInputReqObj.splitUp;
		case 'engine-idle-hours':
			return !insightsInputReqObj.assetIds || !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'km-report':
			return !insightsInputReqObj.groupId || !insightsInputReqObj.assetIds || !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'fuel-consumption-chart':
			return !insightsInputReqObj.assetIds || !insightsInputReqObj.sdate || !insightsInputReqObj.edate || !+insightsInputReqObj.splitUp;
		case 'axle-load-summary':
			return !insightsInputReqObj.AssetId ||
				!insightsInputReqObj.sdate || !insightsInputReqObj.edate || !insightsInputReqObj.chartType;
		case 'trip-summary':
			return !insightsInputReqObj.sdate || !insightsInputReqObj.edate || !insightsInputReqObj.dateChoice;
		case 'apl-vehicle-tyre-hist':
			return !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'apl-vehicle-summary':
			return !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'apl-jobcard-pending':
			return !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'apl-alerts-triggered':
			return !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'apl-service-rejected':
			return !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'apl-service-execution':
			return !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'apl-service-summary':
			return !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'apl-tyre-summary':
			return !insightsInputReqObj.AccountId;
		case 'apl-tyre-analytics':
			return false;
		case 'apl-inspection-summary':
			return !insightsInputReqObj.CustomerIds || !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'apl-missed-alerts-dump':
			return false; // Allow all customer selection
		case 'apl-tyre-projected-mileage-dump':
			return !insightsInputReqObj.CustomerId;
		case 'apl-service-summary-dump':
			return !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'apl-scrap-analytics-dump':
			return !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'apl-weekly-onboarding-dump':
			return !insightsInputReqObj.sdate && !insightsInputReqObj.edate && !insightsInputReqObj.CustomerIds;
		case 'apl-used-tyre-projected-mileage-dump':
			return !insightsInputReqObj.CustomerIds;
		case 'avolve-tyre-stakeAnalytics':
			return !insightsInputReqObj.CustomerIds;
		case 'apl-customer-consumption':
			return !insightsInputReqObj.CustomerId;
		case 'avolve-km-summary':
			return false;
		case 'avolve-mf-inUseTyres-dump':
			return false;
		case 'avolve-mf-notInUseTyres-dump':
			return false;
		case 'avolve-mf-scrappedTyres-dump':
			return false;
		case 'gps-raw-data-dump':
			return !insightsInputReqObj.AssetId || !insightsInputReqObj.sdate ||
				!insightsInputReqObj.edate || !insightsInputReqObj.emailIds ||
				!insightsInputReqObj.emailIds.length;
		case 'avolve-scrap-analytics-dump':
			return false;
		case 'avolve-mileage-performance-dump':
			return false;
		case 'avolve-vehicle-summary-dump':
			return false;
		case 'avolve-projected-mileage-dump':
			return false;
		case 'avolve-stake-analytics-dump':
			return false;
		case 'avolve-inspection-analytics-dump':
			return false;
		case 'avolve-inspection-analytics-web-dump':
			return false;
		case 'avolve-service-execution-dump':
			return false;
		case 'avolve-service-summary-dump':
			return false;
		case 'avolve-missed-alerts-dump':
			return false;
		case 'avolve-alerts-triggered-dump':
			return false;
		case 'avolve-weekly-onboarding-dump':
			return false;
		case 'avolve-vehicle-tyreHistoires-dump':
			return false;
		case 'avolve-customer-consumption-dump':
			return false;
		case 'avolve-service-rejected-dump':
			return false;
		case 'avolve-service-summary-ho-dump':
			return !insightsInputReqObj.sdate || !insightsInputReqObj.edate;
		case 'avolve-jobcard-pending-dump':
			return false
		case 'avolve-fte-performance-dump':
			return false
		case 'avolve-tyre-transaction-dump':
			return false
		default:
			return true;
	}
}

exports.getInsights = async function (req, res) {
	const ROUTE = 'web/insights/getInsights';
	try {
		let insightsTypes;
		if (req.params.type && req.params.type != 'multiple') {
			insightsTypes = req.params.type;
			if (req.query.service) {
				insightsTypes = insightsTypes.split(",");
			}
		} else if (req.query.types) {
			insightsTypes = req.query.types;
		} else {
			return res.send({ success: false, error: 'fields missing' });
		}

		let limit = 40;
		if (req.params.type == "trip-summary") {
			limit = 1;
		}

		let attributes = ['id', 'input', 'type', 'progress', 'startTime', 'endTime', 'createdAt', 'updatedAt'];
		if (req.query.output && req.query.output == true) {
			attributes.push('output');
		}
		let insightWhere = {
			AccountId: res.locals.AccountId,
			UserId: res.locals.UserId,
			type: insightsTypes
		}

		if (req.query.avolve && req.query.avolve == 'true') {
			insightWhere.type = avolveHelper.getInsightDump('all', 'type');
		} else if (req.query.avolve && req.query.fts == 'true') {
			insightWhere.type = avolveHelper.getInsightDump('all', 'type');
			insightWhere['input.fts'] = true;
		}
		let Insights = await models.Insight.findAll({
			attributes: attributes,
			where: insightWhere,
			order: [['startTime', 'DESC']],
			limit: limit,
			raw : true
		});

		let results = [];
		if (req.params.type == "trip-summary") {
			for (const insight of Insights) {
				results.push({
					id: insight.id,
					routerName: insight.routerName,
					input: insight.input,
					progress: insight.progress,
					startTime: insight.startTime,
					endTime: insight.endTime
				})
			}
		} else {
			results = Insights;
		}
		return res.send({ success: true, results: results });

	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching insights', error);
	}
}

exports.getInsightsByType = async function (req, res) {
	const ROUTE = 'web/insights/getInsightsByType ';
	try {
		let insightsTypes;

		if (req.query.types) {
			insightsTypes = req.query.types;
		} else {
			return res.send({ success: false, message: 'fields missing', error: 'fields missing' });
		}

		let Insights = await models.Insight.findAll({
			attributes: ['id', 'type', 'input', 'progress', 'startTime', 'endTime'],
			where: {
				AccountId: res.locals.AccountId,
				UserId: res.locals.UserId,
				type: insightsTypes
			},
			order: [["startTime", "DESC"]],
			limit: 40,
			raw : true
		});

		if (!Insights) {
			res.send({ success: true, results: [] });
		}

		return res.send({ success: true, results: Insights });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching insights', error);
	}
}