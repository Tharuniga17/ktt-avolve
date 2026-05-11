const models = require("../../../models");
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { fetchGeozones, fetchCustomers, getServiceAlerts } = require('../../../lib/helpers/avolveHelper');
const { formatByRegion } = require('../../../lib/dateFormatter');
const { Op } = require('sequelize');
const { handleApiError } = require("../../middlewares/helper");

exports.reminders = async function (req, res) {
	const ROUTE = 'app/serviceschedules/reminders';
	try {
		//#region validations & workshop, customer access
		if (['KAM', 'FTS KAM'].indexOf(res.locals.role) > -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let accountIds = res.locals.AccountId;
		if (["XE FTE", "ARSA"].includes(res.locals.role)) { //For xpert edge - customers based
			if (!req.query.AccountId) {
				return res.send({ success: false, error: 'Please select customer and proceed.' });
			}
			accountIds = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		if (res.locals.role == "AMCC FTE") {
			accountIds = res.locals.accountIds;
		}

		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			let geozoneResult = await fetchGeozones(res);
			if (!geozoneResult.success) {
				RaiseLogEvent(ROUTE, 'error', geozoneResult.error, `Workshop not assigned to this user.`);
				return res.send({ success: false, error: 'Workshop not assigned to this user.' });
			}

			res.GeozoneId = geozoneResult.geozones.map(x => x.id);

			if (req.query.GeozoneId) {
				res.GeozoneId = req.query.GeozoneId;
			}

			let result = await fetchCustomers(res);

			if (result.success && result.customers && result.customers.length) {
				accountIds = result.customers.map(x => x.id);
			} else {
				accountIds = [];
			}
		}
		//#endregion


		let serviceAlertResult = await getServiceAlerts(req, res, accountIds);
		if (!serviceAlertResult || !serviceAlertResult.success || serviceAlertResult.error) {
			RaiseLogEvent(ROUTE, 'error', serviceAlertResult.error, 'Error fetching service reminders');
			return res.send({ success: false, error: "Error fetching service reminders" });
		} else {
			return res.send({ success: true, results: serviceAlertResult.results || [] });
		}

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching service reminders', err);
	}
}

exports.list = async (req, res) => {
	const ROUTE = 'app/serviceschedules/list';
	try {
		let assetWhere = {
			remove: false
		};

		let scheduleWhere = {
			isActive: true
		};

		if (req.query.AssetId) {
			assetWhere.id = req.query.AssetId;
			scheduleWhere.AssetId = req.query.AssetId;
		}

		let vehicleServiceSchedules = await models.VehicleServiceSchedule.findAll({
			attributes: ['id', 'serviceBasedOn', 'frequencyInKm', 'frequencyInMonth', 'alertThresholdInDays', 'alertThresholdInKm', 'lastServiceInMonth', 'lastServiceInKm', 'nextServiceInKm', 'nextServiceInMonth'],
			include: [{
				attributes: ['id', 'serviceName'],
				model: models.VehicleServiceType
			}],
			where: scheduleWhere,
			raw: true,
			nest: true
		});

		for (const schedule of vehicleServiceSchedules) {
			schedule.lastServiceInMonth = formatByRegion(schedule.lastServiceInMonth)
		}

		return res.send({ success: true, results: vehicleServiceSchedules });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in service serviceScheduleList', err);
	}
}

exports.vehicleModels = async function (req, res) {
	const ROUTE = 'app/serviceschedules/vehicleModels';
	try {
		let whereClause = {};
		if (res.locals.AccountId == 3924) { // RedTaxi customized model list
			whereClause.id = [252, 948, 1301, 1302, 1303, 1304, 1305, 1306, 1307, 1308, 1309, 1310, 1311, 1190, 1455];
		}
		let vehicleModels = await models.VehicleModel.findAll({
			attributes: ["id", "modelName", "year", "defaultAxle"],
			include: [
				{
					attributes: ["id", "brandName"],
					model: models.VehicleBrand
				}
			],
			order: [[models.sequelize.col('VehicleBrand.brandName'), 'ASC']],
			raw: false,
			where: whereClause
		});

		let recentUsedModels = await models.VehicleServiceSchedule.findAll({
			attributes: [[models.sequelize.fn('DISTINCT', models.sequelize.col('VehicleModelId')), 'VehicleModelId']],
			where: {
				AccountId: res.locals.AccountId,
				VehicleModelId: { [Op.ne]: null }
			},
			limit: 50,
		})
		if (!recentUsedModels || !recentUsedModels.length) {
			return res.send({ success: true, results: vehicleModels });
		}
		var sortOrder = recentUsedModels.map(x => x.VehicleModelId);
		var recentUsedModelList = vehicleModels.sort(function (a, b) {
			var x = sortOrder.indexOf(a.id);
			if (x == -1) {
				x = sortOrder.length;
			}
			var y = sortOrder.indexOf(b.id);
			if (y == -1) {
				y = sortOrder.length;
			}
			return x - y;
		});
		return res.send({ success: true, results: recentUsedModelList });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in processing your request', err);
	}
};