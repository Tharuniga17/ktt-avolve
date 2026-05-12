const models = require('../../../models');
const evt = require('../../../lib/event');
const moment = require('moment');
const logger = require('../../../lib/helpers/rmqlog');
const inspectionSummaryPDF = require('../../../lib/helpers/inspection-summary-pdf');
const md5 = require('../../../lib/md5').md5;
const avolveHelper = require('../../../lib/helpers/avolveHelper');
const path = require('path');
const fs = require('fs');
const { Op } = require('sequelize');
const { handleApiError } = require('../../middlewares/helper');

exports.inspectVehicle = async function (req, res) {
	const ROUTE = 'app/inspections/inspectVehicle';
	try {
		logger.RaiseLogEvent(ROUTE, req.body.AssetId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.body.AssetId || !req.body.lat || !req.body.lon || !req.body.odo || !req.body.date) {
			return res.send({ success: false, error: 'Input paramters missing.' });
		}

		let lastDraftInsWhere = {
			AssetId: req.body.AssetId,
			type: 'vd',
			date: { [Op.lt]: moment().toISOString() }
		};

		let lastInsWhere = {
			AssetId: req.body.AssetId,
			type: 'v',
			date: { [Op.lt]: moment().toISOString() }
		};

		let assetWhere = {
			id: req.body.AssetId
		}

		let lastDrafInspect = await models.Inspection.findOne({
			where: lastDraftInsWhere,
			order: [['date', 'desc']]
		});

		let lastInspect = await models.Inspection.findOne({
			where: lastInsWhere,
			order: [['date', 'desc']]
		});

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) == -1) {
			if ((lastDrafInspect && moment(lastDrafInspect.date).isAfter(moment().subtract(72, 'h'))) || (lastInspect && moment(lastInspect.date).isAfter(moment().subtract(72, 'h')))) {
				return res.send({ success: false, error: 'Vehicle inspection already found within 72 hours time frame.' });
			}
		}

		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			assetWhere.plan = 1; //AMCS
		}

		if (['XE FTE', 'ARSA', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			assetWhere.AccountId = res.locals.accountIds;
			if (res.locals.role == 'AMCC FTE') assetWhere.plan = 2; //AMCC
		}

		if (res.locals.role == 'DE FTE') assetWhere.AccountId = res.locals.AccountId;

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'imei', 'lplate', 'odo', 'axleProfile', 'axleConfig', 'details', 'AccountId', 'plan'],
			include: [{
				attributes: ['id', 'modelName'],
				model: models.VehicleModel,
				include: [{
					attributes: ['id', 'brandName'],
					model: models.VehicleBrand
				}]
			}],
			where: assetWhere
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		let odoValidation = false;
		if (req.body.resetOdo == "false" && req.body.notOperOdo == "false") {
			odoValidation = true;
		}

		let resetOdo = req.body.resetOdo && req.body.resetOdo == "true" && true || false;
		if (!Asset.imei && odoValidation) { // Validate odo only if it is not reset and not operational
			if ((!req.body.odo || Number(req.body.odo) <= 0) || (Number(Asset.odo) >= Number(req.body.odo))) {
				return res.send({ success: false, error: 'Odometer should be greater than previous inspection/vehicle odometer.' });
			}
		} else {
			if (resetOdo && (!req.body.odo || Number(req.body.odo) <= 0)) {
				return res.send({ success: false, error: 'Please enter odometer to proceed.' });
			}
		}


		//#region service alert validation
		if (req.body.ServiceBookingId && !req.body.updateBooking) {
			let SerBooking = await models.ServiceBooking.findOne({
				attributes: ['id', 'status', 'type'],
				where: {
					AssetId: Asset.id,
					id: req.body.ServiceBookingId
				}
			});

			if (SerBooking && SerBooking.type == 0 && SerBooking.status == 2) {
				let data = {
					isActive: true,
					AssetId: Asset.id,
					[Op.or]: [
						{ jobCardStatus: [3] },
						{ jobCardStatus: null },
					]
				}
				let result = await avolveHelper.fetchAssetServiceSchedule(data, Math.round(req.body.odo));
				if (result.success == true) {
					return res.send({ success: false, message: `New services (${result.services.map(x => x.serviceName).join(', ')}) triggered for given odo \n Do you want to add these services in current service booking?` });
				}
			}
		}
		//#endregion

		let prevInspect = {};
		if (lastInspect && lastInspect.details) {
			prevInspect.odo = lastInspect.details.odo;
			prevInspect.date = lastInspect.date;
			prevInspect.resetOdo = lastInspect.details.resetOdo;
			prevInspect.notOperOdo = lastInspect.details.notOperOdo;
		}

		let conditions = req.body.observations && JSON.parse(req.body.observations) || [];
		let details = {
			lplate: Asset.lplate,
			AssetId: Asset.id,
			odo: req.body.odo,
			plan: Asset.plan,
			resetOdo: resetOdo,
			date: moment().toISOString(),
			notOperOdo: req.body.notOperOdo && req.body.notOperOdo == "true" && true || false,
			vehicleBrand: {
				id: Asset.VehicleModel && Asset.VehicleModel.VehicleBrand && Asset.VehicleModel.VehicleBrand.id || null,
				name: Asset.VehicleModel && Asset.VehicleModel.VehicleBrand && Asset.VehicleModel.VehicleBrand.brandName || ""
			},
			vehicleModel: {
				id: Asset.VehicleModel && Asset.VehicleModel.id || null,
				name: Asset.VehicleModel && Asset.VehicleModel.modelName || ""
			},
			location: {
				lat: req.body.lat,
				lon: req.body.lon,
				name: req.body.location
			},
			axleProfile: {},
			prevInspect: prevInspect,
			serviceType: req.body.serviceType && req.body.serviceType || "",
			comments: req.body.comments || ""
		};

		if (Asset.details && Asset.details.axleProfile) {
			details.axleProfile = Asset.details.axleProfile;
		}

		let User = await models.User.findOne({
			attributes: ['id', 'username', 'firstName', 'lastName'],
			where: {
				id: res.locals.UserId,
				activeStatus: true
			}
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found.' });
		}

		let user = {
			createdBy: {
				id: res.locals.UserId,
				name: User.firstName + (User.lastName ? ' ' + User.lastName : ''),
				username: res.locals.username,
				date: moment().format('DD/MM/YYYY hh:mm A')
			}
		}

		let obsvImgsPush = [];
		let obsvImgs = (req.files && req.files.images) ? req.files.images.filter(files => {
			return files;
		}) : [];

		let inspectImgs = [];
		let inspectImgsPush = [];
		if (req.files && req.files.inspected_images && req.files.inspected_images.length) {
			inspectImgs = req.files.inspected_images.map(obj => {
				inspectImgsPush.push(obj);
				return '/' + md5(res.locals.AccountId) + '/Apollo/AssetInspection/' + Asset.lplate + '_' + obj.filename.replace(/ +/g, "");
			})
		}
		details.inspectionImgs = inspectImgs;

		let odoImgs = [];
		let odoImgsPush = [];
		if (req.files && req.files.odometer_images && req.files.odometer_images.length) {
			odoImgs = req.files.odometer_images.map(obj => {
				odoImgsPush.push(obj);
				return '/' + md5(res.locals.AccountId) + '/Apollo/AssetInspection/' + Asset.lplate + '_' + obj.filename.replace(/ +/g, "");
			})
		}
		details.odometerImgs = odoImgs;

		if (req.files && obsvImgs && obsvImgs.length) {
			obsvImgsPush = obsvImgsPush.concat(obsvImgs);
		}

		logger.RaiseLogEvent(ROUTE, Asset.id, obsvImgs, `Requested by ${res.locals.username} - Images received.`);

		let observations = [];
		for (let condition of conditions) {
			let matchImgs = obsvImgs.filter(x => x.originalname.split('_')[0] == condition.name);
			let images = matchImgs.map(x => {
				return '/' + md5(res.locals.AccountId) + '/Apollo/AssetInspection/' + Asset.lplate + '_' + x.filename.replace(/ +/g, "");
			});
			observations.push({
				id: condition.id,
				name: condition.name,
				images: images,
				comments: condition.comments || ""
			})
		}
		details.observations = observations;

		let VehicleInspect = await models.Inspection.create({
			date: moment().toISOString(),
			type: 'vd',
			details: details,
			user: user,
			AssetId: Asset.id,
			AccountId: Asset.AccountId,
			ServiceBookingId: req.body.ServiceBookingId || null
		});

		let logData = { inputOdo: req.body.odo, AssetOdo: Asset.odo };
		if (req.body.resetOdo) {
			logData.NewOdo = req.body.odo;
		}
		logger.RaiseLogEvent(ROUTE, Asset.id, logData, `Odo details for inspection before update in vehicle`);
		// Update Asset odo
		let updAsset = {};
		if ((!Asset.imei && Number(req.body.odo) > Number(Asset.odo)) || resetOdo || Asset.imei) { //Allow odo update to vehicle for GPS fitted vehicles
			updAsset = await Asset.update({
				odo: Math.round(req.body.odo)
			});

			if (updAsset) {
				logger.RaiseLogEvent(ROUTE, Asset.id, logData, `Vehicle odo after update`);
			}

			if (Asset.imei) { //Check if vehicle has GPS
				let data = {};
				data.AssetId = Asset.id;
				data.AccountId = Asset.AccountId;
				data.odo = Math.round(updAsset.odo / 1000);
				data.emp = {
					id: res.locals.UserId,
					number: res.locals.UserId,
					name: res.locals.username
				}
				evt.events.emit('create-device-command', data);
				logger.RaiseLogEvent(ROUTE, Asset.id, data, 'odo device command triggered');
			}
		}


		for (const obsvImg of obsvImgsPush) {
			if (obsvImg && obsvImg.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: obsvImg.path,
					s3Path: md5(res.locals.AccountId) + '/Apollo/AssetInspection/' + Asset.lplate + '_' + obsvImg.filename.replace(/ +/g, "")
				});
			}
		}

		for (const inspectImg of inspectImgsPush) {
			if (inspectImg && inspectImg.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: inspectImg.path,
					s3Path: md5(res.locals.AccountId) + '/Apollo/AssetInspection/' + Asset.lplate + '_' + inspectImg.filename.replace(/ +/g, "")
				});
			}
		}

		for (const odoImg of odoImgsPush) {
			if (odoImg && odoImg.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: odoImg.path,
					s3Path: md5(res.locals.AccountId) + '/Apollo/AssetInspection/' + Asset.lplate + '_' + odoImg.filename.replace(/ +/g, "")
				});
			}
		}

		if (req.body.ServiceBookingId && req.body.updateBooking == "Yes") {
			evt.events.emit('update-service-booking', {
				AssetId: VehicleInspect.AssetId,
				ServiceBookingId: req.body.ServiceBookingId,
				odo: updAsset.odo
			});
		}

		return res.send({ success: true, vehicleInspection: VehicleInspect });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error in vehicle inspection', error);
	}
}

exports.nearbyZones = async function (req, res) {
	const ROUTE = 'app/inspections/nearbyZones';
	try {
		if (!req.query.lat || !req.query.lon) {
			return res.send({ success: false, error: 'Input paramters missing.' });
		}

		let whereClause = {
			AccountId: res.locals.AccountId,
			activeStatus: true
		}

		let geoZoneIds = [];
		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			let accountIds = [];
			if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
				res.GeozoneId = geozoneResult.geozones.map(x => x.id);
				geoZoneIds = res.GeozoneId;
				if (req.body.GeozoneId) {
					res.GeozoneId = req.body.GeozoneId;
				}
				let result = await avolveHelper.fetchCustomers(res);
				accountIds = result && result.customers.map(x => x.id) || [];
				if (accountIds.length) {
					whereClause.AccountId = accountIds;
				}
			}
		}

		if (['XE FTE', 'ARSA', 'AMCC FTE'].indexOf(res.locals.role) > -1) { //For xpert edge & captive - customers based
			whereClause.AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let Geozones = await models.Geozone.findAll({
			attributes: [
				'id', 'ztype', 'type', 'name', 'zoneCode', 'geojson',
				'scale', 'fullName', 'address', 'city', 'phone', 'area'],
			where: whereClause,
			raw : true
		});

		let fteZones = await models.Geozone.findAll({
			attributes: [
				'id', 'ztype', 'type', 'name', 'zoneCode', 'geojson',
				'scale', 'fullName', 'address', 'city', 'phone', 'area'],
			where: {
				id: geoZoneIds,
				activeStatus: true
			},
			raw : true
		});

		var zoneRadius = 1; // in KM
		if (req.query.radius && !isNaN(req.query.radius)) {
			zoneRadius = parseInt(req.query.radius);
		}
		let results = [];
		for (let fteZone of fteZones) {
			fteZone = JSON.parse(JSON.stringify(fteZone));
			results.push(fteZone);
		}
		for (let Geozone of Geozones) {
			Geozone = JSON.parse(JSON.stringify(Geozone));
			results.push(Geozone);
			// let zoneCenterLatLng = center(Geozone.geojson.point);
			// let zoneLat = zoneCenterLatLng[0];
			// let zoneLon = zoneCenterLatLng[1];
			// let dist = distance(req.query.lat, req.query.lon, zoneLat, zoneLon);
			// if (dist <= zoneRadius) {
			// 	Geozone.distMeter = Math.round(dist * 1000);
			// 	results.push(Geozone);
			// }
		}
		return res.send({ success: true, results: results })
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching zones', error);
	}
}

exports.listObservations = async function (req, res) {
	const ROUTE = 'app/inspections/listObservations';
	try {
		let systemConfig = await models.SystemConfig.findOne({
			where: {
				module: 'Apollo Fleet',
				name: 'Vehicle Observations'
			},
			raw : true
		});

		if (!systemConfig) {
			return res.send({ success: false, error: 'systemConfig not found.' });
		}
		return res.send({ success: true, results: systemConfig.data || [] })

	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching observations', error);
	}
}

exports.assetLastInspection = async function (req, res) {
	const ROUTE = 'app/inspections/assetLastInspection';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing.' });
		}

		let whereClause = {
			AssetId: req.params.id,
			type: 'v',
			AccountId: res.locals.AccountId
		}

		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			let Asset = await models.Asset.findOne({
				attributes: ['id', 'AccountId'],
				where: {
					id: req.params.id,
					plan: 1
				},
				raw : true
			});

			if (!Asset) {
				return res.send({ success: false, error: 'Vehicle is not in AMC shared offer.' });
			}
			whereClause.AccountId = Asset.AccountId;
		}

		if (['XE FTE', 'ARSA', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			whereClause.AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let result = await models.Inspection.findOne({
			where: whereClause,
			order: [['date', 'desc']],
			raw : true
		});

		if (!result) {
			return res.send({ success: false, error: 'Vehicle last inspection not found.' });
		}

		return res.send({ success: true, result: result });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching last inspection', error);
	}
}

exports.assetLastConsolidateInspection = async function (req, res) {
	const ROUTE = 'app/inspections/assetLastConsolidateInspection';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing.' });
		}

		let AccountId = res.locals.AccountId;
		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			let Asset = await models.Asset.findOne({
				attributes: ['id', 'AccountId'],
				where: {
					id: req.params.id,
					plan: 1
				},
				raw : true
			});

			if (!Asset) {
				return res.send({ success: false, error: 'Vehicle not found.' });
			}
			AccountId = Asset.AccountId;
		}

		if (['XE FTE', 'ARSA', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let VehicleInpsect = await models.Inspection.findOne({
			where: {
				AssetId: req.params.id,
				type: 'v',
				AccountId: AccountId
			},
			order: [['date', 'desc']],
			raw : true
		});

		let inspectWhere = {
			AssetId: req.params.id,
			type: 'vd',
			AccountId: AccountId
		}
		if (VehicleInpsect && VehicleInpsect.date) {
			inspectWhere.date = { [Op.gt]: moment(VehicleInpsect.date).toISOString() }
		}

		let vehicleDraftInspection = await models.Inspection.findOne({
			attributes: { exclude: ['date'] },
			where: inspectWhere,
			order: [['date', 'desc']],
			raw : true
		});

		VehicleInpsect = JSON.parse(JSON.stringify(VehicleInpsect));
		if (vehicleDraftInspection) {
			let prevInspect = {}
			if (VehicleInpsect && Object.keys(VehicleInpsect).length) {
				prevInspect = VehicleInpsect;
			}
			VehicleInpsect = JSON.parse(JSON.stringify(vehicleDraftInspection));
			if (prevInspect && Object.keys(prevInspect).length) {
				VehicleInpsect.id = prevInspect.id;
				VehicleInpsect.date = prevInspect.date;
			}
		}

		let prevVehicleInspect = await models.Inspection.findOne({
			where: {
				AssetId: VehicleInpsect.AssetId,
				type: 'v',
				date: { [Op.lt]: VehicleInpsect.date },
				AccountId: AccountId
			},
			order: [['date', 'desc']],
			raw : true
		});

		let TyreInspect = await models.Inspection.findOne({
			where: {
				AssetId: req.params.id,
				type: 't',
				date: { [Op.gte]: VehicleInpsect.date },
				AccountId: AccountId
			},
			order: [['date', 'desc']],
			raw : true
		});

		let prevTyreInspect = await models.Inspection.findOne({
			where: {
				AssetId: VehicleInpsect.AssetId,
				type: 't',
				date: { [Op.lt]: VehicleInpsect.date },
				AccountId: AccountId
			},
			order: [['date', 'desc']],
			raw : true
		});

		let result = {
			vehicleInpsection: VehicleInpsect,
			tyreInspection: TyreInspect && TyreInspect || {},
			prevVehicleInspection: prevVehicleInspect && prevVehicleInspect || {},
			prevTyreInspection: prevTyreInspect && prevTyreInspect || {}
		};

		return res.send({ success: true, result: result });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching inspection', error);
	}
}

exports.assetInspectionHistById = async function (req, res) {
	const ROUTE = 'app/inspections/assetInspectionHistById';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing.' });
		}

		let AccountId = res.locals.AccountId;
		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			let Asset = await models.Asset.findOne({
				attributes: ['id', 'AccountId'],
				where: {
					id: req.params.id,
					plan: 1
				},
				raw : true
			});

			if (!Asset) {
				return res.send({ success: false, error: 'Vehicle not found.' });
			}
			AccountId = Asset.AccountId;
		}

		if (['XE FTE', 'ARSA', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let results = await models.Inspection.findAll({
			include: [{
				attributes: ['id', 'lplate', 'axleProfile', 'details'],
				model: models.Asset
			}],
			where: {
				AssetId: req.params.id,
				type: 'v',
				AccountId: AccountId
			},
			order: [['date', 'desc']]
		});

		if (!results) {
			return res.send({ success: false, error: 'Vehicle inspection histories not found.' });
		}

		return res.send({ success: true, results: results });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching inspection history', error);
	}
}

exports.assetInspectionHist = async function (req, res) {
	const ROUTE = 'app/inspections/assetInspectionHist';
	try {

		let AccountId = [res.locals.AccountId];
		let plan = [];
		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			let accountIds = [];
			if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
				res.GeozoneId = geozoneResult.geozones.map(x => x.id);
				if (req.body.GeozoneId) {
					res.GeozoneId = req.body.GeozoneId;
				}
				let result = await avolveHelper.fetchCustomers(res);
				accountIds = result && result.customers.map(x => x.id) || [];
			}
			AccountId = accountIds.length && accountIds || null;
			plan = [1]; //AMCS
		}

		if (['XE FTE', 'ARSA', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			AccountId = req.query.AccountId && [req.query.AccountId] || res.locals.accountIds;
			if (res.locals.role == 'AMCC FTE') plan = [2]; //AMCC
		}

		let planQuery = '';
		if (plan.length) {
			planQuery = 'A."plan" = (:plan) and';
		}

		var histSql = `
			select
				distinct on (VI."AssetId") VI."AssetId", VI."date", VI."details",
				A."lplate", A."axleProfile", VT.id as "VehicleTypeId", VT."type" as "vType",
				VT."variant" as "vVariant", A."details" as "assetDetails", A."odo"
			from
				"Inspections" VI
				left join "Assets" A on VI."AssetId" = A."id"
				left join "VehicleTypes" VT on A."VehicleTypeId" = VT."id"
			where
				VI."AccountId" in (:AccountId) and
				${planQuery}
				VI."type" = :type
			order by
				VI."AssetId", VI."date" desc`;

		let inspectionHistories = await models.sequelize.query(histSql, {
			replacements: {
				AccountId: AccountId,
				plan: plan,
				type: 'v'
			},
			type: models.sequelize.QueryTypes.SELECT
		});

		let countSql =
			`select 
				count("AssetId"), "AssetId"
			from 
				"Inspections" 
			where 
				"AccountId" in (:AccountId) and 
				"type" = :type 
			group by "AssetId"`;

		let inspectHistoriesCount = await models.sequelize.query(countSql, {
			replacements: {
				AccountId: AccountId,
				type: 'v'
			},
			type: models.sequelize.QueryTypes.SELECT
		});

		let results = [];
		for (const hist of inspectionHistories) {
			hist.count = inspectHistoriesCount.find(x => x.AssetId == hist.AssetId) && inspectHistoriesCount.find(x => x.AssetId == hist.AssetId).count || 0;
			if (hist.VehicleTypeId) {
				hist.VehicleType = {
					id: hist.VehicleTypeId,
					type: hist.vType,
					variant: hist.vVariant
				};
				delete hist.VehicleTypeId;
				delete hist.vType;
				delete hist.vVariant;
			} else {
				hist.VehicleType = {};
			}
			hist.vehicleBrand = {};
			if (hist.details && hist.details.vehicleBrand) {
				hist.vehicleBrand = hist.details.vehicleBrand;
			}
			hist.vehicleModel = {};
			if (hist.details && hist.details.vehicleModel) {
				hist.vehicleModel = hist.details.vehicleModel;
			}
			delete hist.details;
			results.push(hist);
		}
		return res.send({ success: true, results: results });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching inspection history', error);
	}
}

exports.inspectionHistory = async function (req, res) {
	const ROUTE = 'app/inspections/inspectionHistory';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing.' });
		}

		let whereClause = {
			id: req.params.id,
			type: 'v',
			AccountId: res.locals.AccountId
		};
		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			delete whereClause.AccountId;
		}

		if (['XE FTE', 'ARSA', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			whereClause.AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let VehicleInpsect = await models.Inspection.findOne({
			include: [{
				attributes: ['id', 'axleConfig'],
				model: models.Asset
			}],
			where: whereClause,
			order: [['date', 'desc']]
		});

		if (!VehicleInpsect) {
			return res.send({ success: false, error: 'Vehicle inspection not found.' });
		}

		if (!VehicleInpsect.Asset || !VehicleInpsect.Asset.axleConfig) {
			return res.send({ success: false, error: "Vehicle not found or axleConfig not found." });
		}

		let prevVehicleInspect = await models.Inspection.findOne({
			where: {
				AssetId: VehicleInpsect.AssetId,
				type: 'v',
				date: { [Op.lt]: VehicleInpsect.date },
				AccountId: VehicleInpsect.AccountId
			},
			order: [['date', 'desc']],
			raw : true
		});

		let TyreInspect = await models.Inspection.findOne({
			where: {
				AssetId: VehicleInpsect.AssetId,
				type: 't',
				date: { [Op.gte]: VehicleInpsect.date },
				AccountId: VehicleInpsect.AccountId
			},
			order: [['date', 'asc']],
			raw : true
		});

		let prevTyreInspect = await models.Inspection.findOne({
			where: {
				AssetId: VehicleInpsect.AssetId,
				type: 't',
				date: { [Op.lt]: VehicleInpsect.date },
				AccountId: VehicleInpsect.AccountId
			},
			order: [['date', 'desc']],
			raw : true
		});

		VehicleInpsect = JSON.parse(JSON.stringify(VehicleInpsect));
		if (VehicleInpsect.details && VehicleInpsect.details.observations && VehicleInpsect.details.observations.length) {
			for (const observation of VehicleInpsect.details.observations) {
				let images = [];
				for (const image of observation.images) {
					images.push(image);
				}
				observation.images = images;
			}
		}

		TyreInspect = JSON.parse(JSON.stringify(TyreInspect));
		//#region order tyre positions same as app
		const positionToOrder = {};
		if (VehicleInpsect.Asset && VehicleInpsect.Asset.axleConfig && VehicleInpsect.Asset.axleConfig.config) {
			for (let axle of VehicleInpsect.Asset.axleConfig.config) {
				for (let order of axle.order) {
					positionToOrder[order.p] = order.o;
				}
			}
		}

		if (positionToOrder) {
			TyreInspect.details.tyres.sort((a, b) => {
				const positionA = a.inspection.position;
				const positionB = b.inspection.position;
				const orderA = positionToOrder[positionA] || Number.MAX_VALUE;
				const orderB = positionToOrder[positionB] || Number.MAX_VALUE;
				return orderA - orderB;
			});
		}
		//#endregion

		let histIds = TyreInspect && TyreInspect.details && TyreInspect.details.tyres.map(x => x.inspection.id) || [];
		let InspectHistories = await models.TyreHistory.findAll({
			attributes: ['id', 'details', 'histDate'],
			where: {
				id: {[Op.in]: histIds},
				AccountId: VehicleInpsect.AccountId
			},
			raw : true
		});

		if (TyreInspect && TyreInspect.details && TyreInspect.details.tyres) {
			for (const tyre of TyreInspect.details.tyres) {
				let tyreHist = InspectHistories.find(x => x.id == tyre.inspection.id);
				if (tyre.inspection && tyre.inspection.tyreImages) {
					let tyreImgs = tyre.inspection.tyreImages.split(',')
					let allImgs = [];
					for (const image of tyreImgs) {
						allImgs.push(image);
					}
					tyre.inspection.tyreImages = allImgs.join(',');
				}
				tyre.inspection.details = tyreHist && tyreHist.details || {};
			}
		}

		let result = {
			vehicleInpsection: VehicleInpsect,
			tyreInspection: TyreInspect && TyreInspect || {},
			prevVehicleInspection: prevVehicleInspect && prevVehicleInspect || {},
			prevTyreInspection: prevTyreInspect && prevTyreInspect || {}
		};

		if (req.query && req.query.pdf == 'true') {
			inspectionSummaryPDF.createPdf(result, function (err, reply) {
				if (err) {
					logger.RaiseLogEvent(ROUTE, 'error', err, 'Error in inspection summary pdf.');
					return res.send({ success: false, error: "Error in inspection summary pdf." });
				}
				let fileName = `inspection-summary-${VehicleInpsect.id}.pdf`
				if (req.query.appVersion && parseInt(req.query.appVersion) > 253) {
					res.setHeader('Content-Disposition', `attachment;filename=${fileName}`);
					res.setHeader('Content-Type', 'application/pdf');
					reply.pipe(res);
					reply.end();
					return;
				} else {
					let destFileUrl = `/help/${fileName}`;
					let filePath = path.join(__dirname, `/../../../public/help/${fileName}`);
					reply.pipe(fs.createWriteStream(filePath));
					reply.end();
					console.log(`avolve/File inspection-summary.pdf created.`);
					return res.send({ success: true, url: destFileUrl, result: {} });
				}
			});
		} else {
			return res.send({ success: true, result: result });
		}

	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching inspection', error);
	}
}

exports.createTyreVerification = async (req, res) => {
	const ROUTE = 'app/inspections/createTyreVerification';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		let tyreData = req.body.tyreData && JSON.parse(req.body.tyreData);
		if (!tyreData.length || (tyreData[0] && !tyreData[0].AssetId)) {
			return res.send({ success: false, error: 'Missing or invalid tyre data.' });
		}

		const Asset = await models.Asset.findOne({
			attributes: ['id', 'odo', 'AccountId'],
			include: [{
				model: models.Account,
				where: {
					AccountIdParent: res.locals.masterAccountId
				}
			}],
			where: { id: tyreData[0].AssetId }
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		const tyreNos = tyreData.map(x => x.tyreNo);
		const Tyres = await models.Tyre.findAll({
			attributes: [
				'id',
				'tyreNo',
				'AccountId',
				[models.sequelize.json('"lastStatus".position'), 'position']  // Preserving case for JSON column
			],
			where: {
				tyreNo: tyreNos,
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			},
			raw: true
		});

		if (!Tyres.length) {
			return res.send({ success: false, error: 'Tyres not found.' });
		}

		let LatestTyreInspection = await models.Inspection.count({
			where: {
				AssetId: Asset.id,
				type: 't',
				date: { [Op.gte]: moment().subtract(72, 'hours').toISOString() },
				AccountId: Asset.AccountId
			}
		});

		let LatestVehDraftInspection = await models.Inspection.findOne({
			attributes: [[models.sequelize.literal(`"details"->>'odo'`), 'odo']],
			where: {
				AssetId: Asset.id,
				type: 'vd',
				date: { [Op.gte]: moment().subtract(72, 'hours').toISOString() },
				AccountId: Asset.AccountId
			},
			raw: true
		});

		let rotationCount = 0, removeCount = 0;
		let rotation = [];
		let removeFitment = [];
		let assetOdo = (LatestVehDraftInspection && LatestVehDraftInspection.odo) || (Asset.odo) || '';
		for (const tyre of tyreData) {
			const matchedTyre = Tyres.find(x => x.tyreNo === tyre.tyreNo) || {};
			let tyreInReqPos = Tyres.find(x => tyre.newPos && x.position && x.position == tyre.newPos) || null;

			if (!tyreInReqPos && tyre.newPos && tyre.newPos != 'Not Found') {
				removeFitment.push({
					...tyre, ...{
						AccountId: matchedTyre.AccountId,
						date: moment().toISOString(),
						AplJobCardId: null,
						assetOdo: assetOdo,
						inspectedBy: { id: res.locals.UserId, name: res.locals.username },
						inspectedPosition: tyre.currentPos,
						currentPosition: tyre.newPos,
						serviceName: 'En Route Tyre Replacement'
					}
				});
			} else if (tyre.newPos && tyre.newPos != 'Not Found' && tyre.newPos !== tyre.currentPos && tyreInReqPos) {
				rotation.push({
					...tyre, ...{
						AccountId: matchedTyre.AccountId,
						date: moment().toISOString(),
						AplJobCardId: null,
						assetOdo: assetOdo,
						inspectedBy: res.locals.username,
						inspectedPosition: tyre.currentPos,
						currentPosition: tyre.newPos,
						serviceName: 'En Route Tyre Rotation'
					}
				});

				rotationCount++;
			}
			if (tyre.isNotFound) {
				removeCount++;
			}
		}

		const user = {
			createdBy: {
				id: res.locals.UserId,
				date: moment().format('DD/MM/YYYY hh:mm A'),
				name: res.locals.username
			}
		};

		let details = {
			tyres: tyreData,
			isTyrePosChanged: (!LatestTyreInspection || (req.body.isTyrePosChanged && req.body.isTyrePosChanged == 'true')) && true || false,
			enrouteServices: {
				rotation: rotationCount,
				text: ''
			}
		};

		details.enrouteServices.text = rotationCount && `${rotationCount} Tyres Rotated` + `${!removeCount ? ' while Enroute' : ''}` || '';
		if (removeCount) {
			details.enrouteServices.text += details.enrouteServices.text && ` & ${removeCount} Tyres Replaced while Enroute.` || `${removeCount} Tyres Replaced while Enroute.`;
		}

		const TyreVerification = await models.Inspection.create({
			details: details,
			date: moment().toISOString(),
			type: 'tv',
			AssetId: Asset.id,
			AccountId: Asset.AccountId,
			AplJobCardId: null,
			user: user,
			ServiceBookingId: req.query.ServiceBookingId || null
		});

		for (const tyre of removeFitment) {
			evt.events.emit('avolve-create-removeFitment-tyrehist', { ...tyre, ...{ InspectionId: TyreVerification.id } });
		}

		for (const tyre of rotation) {
			evt.events.emit('create-apl-tyreRotation-tyrehist', { ...tyre, ...{ InspectionId: TyreVerification.id } });
		}

		return res.send({ success: true, result: TyreVerification });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error verifying tyres', error);
	}
};

exports.getTyreVerification = async (req, res) => {
	const ROUTE = 'app/inspections/getTyreVerification';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing Input Parameter.' });
		}

		const Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'AccountId', 'details', 'axleProfile', 'odo'],
			where: { id: req.params.id },
			raw : true
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		const vehInspection = await models.Inspection.findOne({
			attributes: ['id', 'details', 'date', 'type'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId,
				type: ['v', 'vd']
			},
			order: [['date', 'desc']],
			raw : true
		});

		const tyreVerification = await models.Inspection.findOne({
			attributes: ['id', 'date', 'details'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId,
				type: ['tv']
			},
			order: [['date', 'desc']],
			raw : true
		});

		if (!tyreVerification || !tyreVerification.details || !tyreVerification.details.tyres || !tyreVerification.details.tyres.length) {
			return res.send({ success: false, error: 'Tyre verification pending' });
		}

		let LatestTyreInspection = await models.Inspection.count({
			where: {
				AssetId: Asset.id,
				type: 't',
				date: { [Op.gte]: moment().subtract(72, 'hours').toISOString() },
				AccountId: Asset.AccountId
			},
			raw : true
		});

		let vehicleDraftInspection = vehInspection && vehInspection.type == 'vd' ? vehInspection : {};
		let skipTyreInspection = tyreVerification.details && tyreVerification.details.skipTyreInspection;
		let assetData = {
			lplate: Asset.lplate || '',
			wheeler: Asset.axleProfile || '',
			odometer: Asset.odo || '',
			date: vehInspection && vehInspection.date && moment(vehInspection.date).format('DD/MM/YYYY') || '',
			lastVehDraftInspDate: vehicleDraftInspection && vehicleDraftInspection && moment(vehicleDraftInspection.date).toISOString() || '',
			isTyrePosChanged: tyreVerification.details && tyreVerification.details.isTyrePosChanged || false,
			skipTyreInspection: skipTyreInspection == undefined ? null : skipTyreInspection,
			isWithinInspectionWindow: LatestTyreInspection && true || false,
			message: null,
			notOperOdo: vehInspection.details && vehInspection.details.notOperOdo || false,
			resetOdo: vehInspection.details && vehInspection.details.resetOdo || false
		};

		if (tyreVerification.details.isTyrePosChanged == false) {
			assetData.isTyrePosChanged = tyreVerification.details.isTyrePosChanged;
			assetData.message = 'Tyre inspection was already completed within the last 72 hours.'
		}

		if (Asset.details && Asset.details.axleProfile) {
			assetData.config = Asset.details.axleProfile.config || '';
			assetData.name = Asset.details.axleProfile.name || '';
		}

		const result = {
			...assetData,
			...{ notFoundTyres: tyreVerification.details.tyres.filter(x => x.isNotFound) || [] }
		};

		return res.send({ success: true, result: result });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error getting tyre verification data', error);
	}
};

exports.updateTyreVerification = async (req, res) => {
	const ROUTE = 'app/inspections/updateTyreVerification';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing Input Parameter.' });
		}

		const Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'AccountId', 'details', 'axleProfile', 'odo'],
			where: { id: req.params.id }
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		const TyreVerification = await models.Inspection.findOne({
			attributes: ['id', 'details'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId,
				type: ['tv'],
				ServiceBookingId: req.query.ServiceBookingId
			},
			order: [['date', 'desc']]
		});

		if (!TyreVerification) {
			return res.send({ success: false, error: 'Tyre Verification not found.' });
		}

		let details = JSON.parse(JSON.stringify(TyreVerification.details));
		details.skipTyreInspection = req.query.skipTyreInspection == 'true';

		await TyreVerification.update({
			details: details
		});

		return res.send({ success: true, skipTyreInspection: details.skipTyreInspection });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error updating tyre verification data', error);
	}
};

exports.getInspectionSteps = async (req, res) => {
	const ROUTE = 'app/inspections/getInspectionSteps';
	try {
		if (!req.params.id || !req.query.ServiceBookingId) {
			return res.send({ success: false, error: 'Missing Input Parameter.' });
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'AccountId'],
			where: { id: req.params.id },
			raw : true
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		let ServiceBooking = await models.ServiceBooking.findOne({
			attributes: ['id', 'asset'],
			where: {
				id: req.query.ServiceBookingId,
				AssetId: Asset.id
			},
			raw : true
		});

		if (!ServiceBooking) {
			return res.send({ success: false, error: 'Service booking not found.' });
		}

		let InspectionWhere = {
			AssetId: Asset.id,
			AccountId: Asset.AccountId,
			date: { [Op.gt]: moment().subtract(72, 'hours').startOf('day').toISOString() },
			AplJobCardId: null,
			ServiceBookingId: req.query.ServiceBookingId
		}

		if (ServiceBooking.asset && ServiceBooking.asset.gateIn) {
			InspectionWhere.date = { [Op.gt]: moment(ServiceBooking.asset.gateIn).toISOString() };
		}

		const vehInspection = await models.Inspection.findOne({
			attributes: ['id', 'date'],
			where: { ...InspectionWhere, ...{ type: ['vd', 'v'] } },
			order: [['date', 'desc']],
			raw : true
		});

		let tyreVerification = {};
		let tyreInspection = 0;
		if (vehInspection) {
			InspectionWhere.date = { [Op.gte]: moment(vehInspection.date).toISOString() };

			tyreVerification = await models.Inspection.findOne({
				attributes: ['id', 'details'],
				where: { ...InspectionWhere, ...{ type: ['tv'] }, },
				order: [['date', 'desc']],
				raw : true
			});

			tyreInspection = await models.Inspection.count({
				where: { ...InspectionWhere, ...{ type: ['t'] } },
				order: [['date', 'desc']],
				raw : true
			});
		}

		let result = {
			vehInspect: vehInspection && true || false,
			tyreVerification: tyreVerification && true || false,
			tyreInspect: tyreInspection && true || false,
		};

		if (!vehInspection) {
			result.tyreVerification = false;
			result.tyreInspect = false;
		}

		if (tyreVerification && tyreVerification.details && (tyreVerification.details.skipTyreInspection || tyreVerification.details.tyreInspectionCompleted)) {
			result.tyreInspect = true;
		} else {
			result.tyreInspect = tyreInspection && true || false;
		}

		return res.send({ success: true, result: result });

	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fethcing inspections status', error);
	}
}

exports.completeTyreInspection = async (req, res) => {
	const ROUTE = 'app/inspections/completeTyreInspection';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing Input Parameter.' });
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'AccountId', 'axleConfig', 'axleProfile'],
			where: { id: req.params.id }
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'tyreNo', 'lastStatus'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			}
		});

		if (!Tyres) {
			return res.send({ success: false, error: 'Tyre not found.' });
		}

		const TyreVerification = await models.Inspection.findOne({
			attributes: ['id', 'details', 'date'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId,
				type: ['tv'],
				ServiceBookingId: req.query.ServiceBookingId
			},
			order: [['date', 'desc']]
		});

		if (!TyreVerification) {
			return res.send({ success: false, error: 'Tyre Verification not found.' });
		}

		let inActAxleCount = 0;
		let ignorePositions = ["SP", "SP1", "SP2", "SP3", "SP4"];
		if (Asset.axleConfig && Asset.axleConfig.config) {
			let inActiveAxles = Asset.axleConfig.config.filter(x => x.active == false); //ignore in-active axle positions
			for (let inActiveAxle of inActiveAxles) {
				if (inActiveAxle.position) {
					inActAxleCount += inActiveAxle.position.length;
					inActiveAxle.position.map(x => ignorePositions.push(x));
				}
			}
		}

		let tyreNos = [];
		let nonSpareTyresCount = 0;
		for (const tyre of Tyres) {
			if (tyre.lastStatus && tyre.lastStatus.position && !ignorePositions.includes(tyre.lastStatus.position)) {
				tyreNos.push(tyre.tyreNo);
				nonSpareTyresCount++;
			}
		}

		if (req.query.ignoreSpare && req.query.ignoreSpare == 'true') {
			await TyreVerification.update({
				details: Object.assign(TyreVerification.details, { tyreInspectionCompleted: true }),
			});

			evt.events.emit('tyre-inspection-summary', {
				AssetId: Asset.id,
				isSpare: false,
				AccountId: Asset.AccountId,
				UserId: res.locals.UserId,
				userName: res.locals.username,
				role: res.locals.role,
				isTyreVerification: true,
				ServiceBookingId: req.query.ServiceBookingId
			});
		} else {
			let inspectedTyres = await models.TyreHistory.findAll({
				attributes: ['id', 'position'],
				where: {
					AssetId: Asset.id,
					AccountId: Asset.AccountId,
					tyreNo: tyreNos,
					histDate: { [Op.gte]: moment(TyreVerification.date).toISOString() },
					transaction: 'Inspect'
				}
			});

			let inspectedPosition = [];
			let uniqueInspction = new Set();
			for (const inspetion of inspectedTyres) {
				if (uniqueInspction.has(inspetion.position)) {
					continue;
				}
				uniqueInspction.add(inspetion.position);
				inspectedPosition.push(inspetion);
			}

			if (inspectedPosition.length < nonSpareTyresCount) {
				return res.send({ success: false, error: 'Inspect all tyres before completing tyre inspection.' });
			}

			let histWhere = {
				AssetId: Asset.id,
				AccountId: Asset.AccountId,
				transaction: 'Inspect',
				histDate: { [Op.gte]: moment(TyreVerification.date).toISOString() },
				position: { [Op.in]: ["SP", "SP1", "SP2", "SP3", "SP4"] }
			}

			let isSpareFitted = await models.Tyre.count({
				where: {
					AssetId: Asset.id,
					AccountId: Asset.AccountId,
					'lastStatus.position': { [Op.in]: ["SP", "SP1", "SP2", "SP3", "SP4"] }
				}
			});

			if (!isSpareFitted) {
				return res.send({ success: false, error: 'No tyre has found in SP position. Are you sure to continue?', isSpareValidation: true });
			}

			let isSpareInspected = await models.TyreHistory.count({
				where: histWhere
			});

			if (!isSpareInspected) {
				return res.send({ success: false, error: 'Inspection has not been done in SP position. Are you sure to continue?', isSpareValidation: true });
			}

			await TyreVerification.update({
				details: Object.assign(TyreVerification.details, { tyreInspectionCompleted: true }),
			});

			evt.events.emit('tyre-inspection-summary', {
				AssetId: Asset.id,
				isSpare: false,
				AccountId: Asset.AccountId,
				UserId: res.locals.UserId,
				userName: res.locals.username,
				role: res.locals.role,
				isTyreVerification: true,
				ServiceBookingId: req.query.ServiceBookingId
			});
		}

		return res.send({ success: true });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error compeleting inspections', error);
	}
}

exports.xeGetInspectionSteps = async (req, res) => {
	const ROUTE = 'app/inspections/xeGetInspectionSteps';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing Input Parameter.' });
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'AccountId'],
			where: { id: req.params.id },
			raw : true
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		let InspectionWhere = {
			AssetId: Asset.id,
			AccountId: Asset.AccountId,
			date: { [Op.gt]: moment().subtract(72, 'hours').startOf('day').toISOString() },
			AplJobCardId: null
		}

		const vehInspection = await models.Inspection.findOne({
			attributes: ['id', 'date'],
			where: { ...InspectionWhere, ...{ type: ['vd', 'v'] } },
			order: [['date', 'desc']],
			raw : true
		});

		let tyreVerification = {};
		let tyreInspection = 0;
		if (vehInspection) {
			InspectionWhere.date = { [Op.gte]: moment(vehInspection.date).toISOString() };

			tyreVerification = await models.Inspection.findOne({
				attributes: ['id', 'details'],
				where: { ...InspectionWhere, ...{ type: ['tv'] }, },
				order: [['date', 'desc']],
				raw : true
			});

			tyreInspection = await models.Inspection.count({
				where: { ...InspectionWhere, ...{ type: ['t'] } },
				order: [['date', 'desc']],
				raw : true
			});
		}

		let result = {
			vehInspect: vehInspection && true || false,
			tyreVerification: tyreVerification && true || false,
			tyreInspect: tyreInspection && true || false,
		};

		if (!vehInspection) {
			result.tyreVerification = false;
			result.tyreInspect = false;
		}

		if (tyreVerification && tyreVerification.details && (tyreVerification.details.skipTyreInspection || tyreVerification.details.tyreInspectionCompleted)) {
			result = {
				vehInspect: false,
				tyreVerification: false,
				tyreInspect: false
			};
		} else {
			result.tyreInspect = tyreInspection && true || false;
		}

		if (vehInspection && tyreInspection) {
			result = {
				vehInspect: false,
				tyreVerification: false,
				tyreInspect: false
			};
		}

		return res.send({ success: true, result: result });

	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fethcing inspections status', error);
	}
}

exports.xeGetTyreVerification = async (req, res) => {
	const ROUTE = 'app/inspections/xeGetTyreVerification';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing Input Parameter.' });
		}

		const Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'AccountId', 'details', 'axleProfile', 'odo'],
			where: { id: req.params.id },
			raw : true
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		const vehInspection = await models.Inspection.findOne({
			attributes: ['id', 'details', 'date', 'type'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId,
				type: ['v', 'vd']
			},
			order: [['date', 'desc']],
			raw : true
		});

		const tyreVerification = await models.Inspection.findOne({
			attributes: ['id', 'date', 'details'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId,
				date: { [Op.gte]: vehInspection.date },
				type: ['tv']
			},
			order: [['date', 'desc']],
			raw : true
		});

		if (!tyreVerification || !tyreVerification.details || !tyreVerification.details.tyres || !tyreVerification.details.tyres.length) {
			return res.send({ success: false, error: 'Tyre verification pending' });
		}

		let LatestTyreInspection = await models.Inspection.count({
			where: {
				AssetId: Asset.id,
				type: 't',
				date: { [Op.gte]: moment().subtract(72, 'hours').toISOString() },
				AccountId: Asset.AccountId
			},
			raw : true
		});

		let vehicleDraftInspection = vehInspection && vehInspection.type == 'vd' ? vehInspection : {};
		let skipTyreInspection = tyreVerification.details && tyreVerification.details.skipTyreInspection;
		let assetData = {
			lplate: Asset.lplate || '',
			wheeler: Asset.axleProfile || '',
			odometer: Asset.odo || '',
			date: vehInspection && vehInspection.date && moment(vehInspection.date).format('DD/MM/YYYY') || '',
			lastVehDraftInspDate: vehicleDraftInspection && vehicleDraftInspection && moment(vehicleDraftInspection.date).toISOString() || '',
			isTyrePosChanged: tyreVerification.details && tyreVerification.details.isTyrePosChanged || false,
			skipTyreInspection: skipTyreInspection == undefined ? null : skipTyreInspection,
			isWithinInspectionWindow: LatestTyreInspection && true || false,
			message: null,
			notOperOdo: vehInspection.details && vehInspection.details.notOperOdo || false,
			resetOdo: vehInspection.details && vehInspection.details.resetOdo || false
		};

		if (tyreVerification.details.isTyrePosChanged == false) {
			assetData.isTyrePosChanged = tyreVerification.details.isTyrePosChanged;
			assetData.message = 'Tyre inspection was already completed within the last 72 hours.'
		}

		if (Asset.details && Asset.details.axleProfile) {
			assetData.config = Asset.details.axleProfile.config || '';
			assetData.name = Asset.details.axleProfile.name || '';
		}

		const result = {
			...assetData,
			...{ notFoundTyres: tyreVerification.details.tyres.filter(x => x.isNotFound) || [] }
		};

		return res.send({ success: true, result: result });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error getting tyre verification data', error);
	}
};

exports.xeCreateTyreVerification = async (req, res) => {
	const ROUTE = 'app/inspections/xeCreateTyreVerification';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		let tyreData = req.body.tyreData && JSON.parse(req.body.tyreData);
		if (!tyreData.length || (tyreData[0] && !tyreData[0].AssetId)) {
			return res.send({ success: false, error: 'Missing or invalid tyre data.' });
		}

		const Asset = await models.Asset.findOne({
			attributes: ['id', 'odo', 'AccountId'],
			include: [{
				attributes: [],
				model: models.Account,
				where: {
					AccountIdParent: res.locals.masterAccountId
				}
			}],
			where: { id: tyreData[0].AssetId }
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		const tyreNos = tyreData.map(x => x.tyreNo);
		const Tyres = await models.Tyre.findAll({
			attributes: [
				'id',
				'tyreNo',
				'AccountId',
				[models.sequelize.json('"lastStatus".position'), 'position']  // Preserving case for JSON column
			],
			where: {
				tyreNo: tyreNos,
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			},
			raw: true
		});

		if (!Tyres.length) {
			return res.send({ success: false, error: 'Tyres not found.' });
		}

		let LatestTyreInspection = await models.Inspection.count({
			where: {
				AssetId: Asset.id,
				type: 't',
				date: { [Op.gte]: moment().subtract(72, 'hours').toISOString() },
				AccountId: Asset.AccountId
			}
		});

		let LatestVehDraftInspection = await models.Inspection.findOne({
			attributes: [[models.sequelize.literal(`"details"->>'odo'`), 'odo']],
			where: {
				AssetId: Asset.id,
				type: 'vd',
				date: { [Op.gte]: moment().subtract(72, 'hours').toISOString() },
				AccountId: Asset.AccountId
			},
			raw: true
		});

		let rotationCount = 0, removeCount = 0;
		let rotation = [];
		let removeFitment = [];
		let assetOdo = (LatestVehDraftInspection && LatestVehDraftInspection.odo) || (Asset.odo) || '';
		for (const tyre of tyreData) {
			const matchedTyre = Tyres.find(x => x.tyreNo === tyre.tyreNo) || {};
			let tyreInReqPos = Tyres.find(x => tyre.newPos && x.position && x.position == tyre.newPos) || null;

			if (!tyreInReqPos && tyre.newPos && tyre.newPos != 'Not Found') {
				removeFitment.push({
					...tyre, ...{
						AccountId: matchedTyre.AccountId,
						date: moment().toISOString(),
						AplJobCardId: null,
						assetOdo: assetOdo,
						inspectedBy: { id: res.locals.UserId, name: res.locals.username },
						inspectedPosition: tyre.currentPos,
						currentPosition: tyre.newPos,
						serviceName: 'En Route Tyre Replacement'
					}
				});
			} else if (tyre.newPos && tyre.newPos != 'Not Found' && tyre.newPos !== tyre.currentPos && tyreInReqPos) {
				rotation.push({
					...tyre, ...{
						AccountId: matchedTyre.AccountId,
						date: moment().toISOString(),
						AplJobCardId: null,
						assetOdo: assetOdo,
						inspectedBy: res.locals.username,
						inspectedPosition: tyre.currentPos,
						currentPosition: tyre.newPos,
						serviceName: 'En Route Tyre Rotation'
					}
				});

				rotationCount++;
			}
			if (tyre.isNotFound) {
				removeCount++;
			}
		}

		const user = {
			createdBy: {
				id: res.locals.UserId,
				date: moment().format('DD/MM/YYYY hh:mm A'),
				name: res.locals.username
			}
		};

		let details = {
			tyres: tyreData,
			isTyrePosChanged: (!LatestTyreInspection || (req.body.isTyrePosChanged && req.body.isTyrePosChanged == 'true')) && true || false,
			enrouteServices: {
				rotation: rotationCount,
				text: ''
			}
		};

		details.enrouteServices.text = rotationCount && `${rotationCount} Tyres Rotated` + `${!removeCount ? ' while Enroute' : ''}` || '';
		if (removeCount) {
			details.enrouteServices.text += details.enrouteServices.text && ` & ${removeCount} Tyres Replaced while Enroute.` || `${removeCount} Tyres Replaced while Enroute.`;
		}

		const TyreVerification = await models.Inspection.create({
			details: details,
			date: moment().toISOString(),
			type: 'tv',
			AssetId: Asset.id,
			AccountId: Asset.AccountId,
			AplJobCardId: null,
			user: user
		});

		for (const tyre of removeFitment) {
			evt.events.emit('avolve-create-removeFitment-tyrehist', { ...tyre, ...{ InspectionId: TyreVerification.id } });
		}

		for (const tyre of rotation) {
			evt.events.emit('create-apl-tyreRotation-tyrehist', { ...tyre, ...{ InspectionId: TyreVerification.id } });
		}

		return res.send({ success: true, result: TyreVerification });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error verifying tyres', error);
	}
}

exports.xeCompleteTyreInspection = async (req, res) => {
	const ROUTE = 'app/inspections/xeCompleteTyreInspection';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing Input Parameter.' });
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'AccountId', 'axleConfig', 'axleProfile'],
			where: { id: req.params.id },
			raw: true
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'tyreNo', 'lastStatus'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			},
			raw: true
		});

		if (!Tyres) {
			return res.send({ success: false, error: 'Tyre not found.' });
		}

		const TyreVerification = await models.Inspection.findOne({
			attributes: ['id', 'details', 'date'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId,
				type: ['tv']
			},
			order: [['date', 'desc']]
		});

		if (!TyreVerification) {
			return res.send({ success: false, error: 'Tyre Verification not found.' });
		}

		let inActAxleCount = 0;
		let ignorePositions = ["SP", "SP1", "SP2", "SP3", "SP4"];
		if (Asset.axleConfig && Asset.axleConfig.config) {
			let inActiveAxles = Asset.axleConfig.config.filter(x => x.active == false); //ignore in-active axle positions
			for (let inActiveAxle of inActiveAxles) {
				if (inActiveAxle.position) {
					inActAxleCount += inActiveAxle.position.length;
					inActiveAxle.position.map(x => ignorePositions.push(x));
				}
			}
		}

		let tyreNos = [];
		let nonSpareTyresCount = 0;
		for (const tyre of Tyres) {
			if (tyre.lastStatus && tyre.lastStatus.position && !ignorePositions.includes(tyre.lastStatus.position)) {
				tyreNos.push(tyre.tyreNo);
				nonSpareTyresCount++;
			}
		}

		if (req.query.ignoreSpare && req.query.ignoreSpare == 'true') {
			await TyreVerification.update({
				details: Object.assign(TyreVerification.details, { tyreInspectionCompleted: true }),
			});

			evt.events.emit('tyre-inspection-summary', {
				AssetId: Asset.id,
				isSpare: false,
				AccountId: Asset.AccountId,
				UserId: res.locals.UserId,
				userName: res.locals.username,
				role: res.locals.role,
				isTyreVerification: true
			});
		} else {
			let inspectedTyres = await models.TyreHistory.findAll({
				attributes: ['id', 'position'],
				where: {
					AssetId: Asset.id,
					AccountId: Asset.AccountId,
					tyreNo: tyreNos,
					histDate: { [Op.gte]: moment(TyreVerification.date).toISOString() },
					transaction: 'Inspect'
				}
			});

			let inspectedPosition = [];
			let uniqueInspction = new Set();
			for (const inspetion of inspectedTyres) {
				if (uniqueInspction.has(inspetion.position)) {
					continue;
				}
				uniqueInspction.add(inspetion.position);
				inspectedPosition.push(inspetion);
			}

			if (inspectedPosition.length < nonSpareTyresCount) {
				return res.send({ success: false, error: 'Inspect all tyres before completing tyre inspection.' });
			}

			let histWhere = {
				AssetId: Asset.id,
				AccountId: Asset.AccountId,
				transaction: 'Inspect',
				histDate: { [Op.gte]: moment(TyreVerification.date).toISOString() },
				position: { [Op.in]: ["SP", "SP1", "SP2", "SP3", "SP4"] }
			}

			let isSpareFitted = await models.Tyre.count({
				where: {
					AssetId: Asset.id,
					AccountId: Asset.AccountId,
					'lastStatus.position': { [Op.in]: ["SP", "SP1", "SP2", "SP3", "SP4"] }
				}
			});

			if (!isSpareFitted) {
				return res.send({ success: false, error: 'No tyre has found in SP position. Are you sure to continue?', isSpareValidation: true });
			}

			let isSpareInspected = await models.TyreHistory.count({
				where: histWhere
			});

			if (!isSpareInspected) {
				return res.send({ success: false, error: 'Inspection has not been done in SP position. Are you sure to continue?', isSpareValidation: true });
			}

			await TyreVerification.update({
				details: Object.assign(TyreVerification.details, { tyreInspectionCompleted: true }),
			});

			evt.events.emit('tyre-inspection-summary', {
				AssetId: Asset.id,
				isSpare: false,
				AccountId: Asset.AccountId,
				UserId: res.locals.UserId,
				userName: res.locals.username,
				role: res.locals.role,
				isTyreVerification: true
			});
		}

		return res.send({ success: true });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error compeleting inspections', error);
	}
}

exports.xeUpdateTyreVerification = async (req, res) => {
	const ROUTE = 'app/inspections/xeUpdateTyreVerification';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing Input Parameter.' });
		}

		const Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'AccountId', 'details', 'axleProfile', 'odo'],
			where: { id: req.params.id }
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		const TyreVerification = await models.Inspection.findOne({
			attributes: ['id', 'details'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId,
				type: ['tv']
			},
			order: [['date', 'desc']]
		});

		if (!TyreVerification) {
			return res.send({ success: false, error: 'Tyre Verification not found.' });
		}

		let details = JSON.parse(JSON.stringify(TyreVerification.details));
		details.skipTyreInspection = req.query.skipTyreInspection == 'true';

		await TyreVerification.update({
			details: details
		});

		return res.send({ success: true, skipTyreInspection: details.skipTyreInspection });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error updating tyre verification data', error);
	}
}