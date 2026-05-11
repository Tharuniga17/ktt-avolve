const models = require("../../../models");
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { formatByRegion } = require('../../../lib/dateFormatter');
const { handleApiError } = require('../../middlewares/helper');
const { Op } = require('sequelize');


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

		return res.send({ success: true, results: vehicleServiceSchedules });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching serviceschedule list', err);
	}
}

exports.vehicleInfo = async function (req, res) {
	const ROUTE = 'app/serviceschedules/vehicleInfo';
	try {
		const Assets = await models.Asset.findAll({
			attributes: ["id", "name", "lplate", "odo", "engineHrs", "axleProfile", "mfgYear", "axleConfig", "sensor"],
			include: [{
				attributes: ["id", "modelName", "year"],
				model: models.VehicleModel,
				include: [{
					attributes: ["brandName"],
					model: models.VehicleBrand
				}]
			}, {
				attributes: ["id", "type", "variant"],
				model: models.VehicleType
			}],
			where: {
				AccountId: res.locals.AccountId,
				active: true,
				remove: false
			},
			order: [['id', 'ASC']],
		});

		const recentUsedAssets = await models.VehicleServiceSchedule.findAll({
			attributes: ['AssetId'],
			where: {
				AccountId: res.locals.AccountId,
				AssetId: { [Op.ne]: null }
			},
			group: ['AssetId', 'updatedAt'],
			order: [['updatedAt', 'DESC']],
			limit: 50,
			raw: true
		});

		if (!recentUsedAssets || !recentUsedAssets.length) {
			return res.send({ success: true, results: Assets });
		}

		let sortOrder = recentUsedAssets.map(x => x.AssetId);
		let recentUsedAssetList = Assets.sort(function (a, b) {
			let x = sortOrder.indexOf(a.id);
			if (x == -1) {
				x = sortOrder.length;
			}
			let y = sortOrder.indexOf(b.id);
			if (y == -1) {
				y = sortOrder.length;
			}
			return x - y;
		});
		return res.send({ success: true, results: recentUsedAssetList });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in serviceschedule vehicleInfo API', err);
	}
}