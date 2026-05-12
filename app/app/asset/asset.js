const models = require("../../../models");
const moment = require("moment");
const logger = require('../../../lib/helpers/rmqlog');
const avolveHelper = require('../../../lib/helpers/avolveHelper');
const { Op } = require('sequelize')
const evt = require('../../../lib/event');
const { isAmcFtes } = require('../../../lib/helpers/userroles');
const axleConfigAvolve = require('../../../config/axleConfig-apollo.json');
const { handleApiError } = require("../../middlewares/helper");

exports.countByGeozone = async function (req, res) {
	const ROUTE = 'app/assets/countByGeozone';
	try {
		if (!isAmcFtes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: 'Please select workshop to proceed.' });
		}

		let accountIds = res.locals.accountIds;
		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			res.GeozoneId = req.params.id;

			let result = await avolveHelper.fetchCustomers(res);

			if (result.success && result.customers && result.customers.length) {
				accountIds = result.customers.map(x => x.id) || [];
			} else {
				accountIds = [];
			}
		}

		//#region vehicle & tyre count

		let assetResult = await avolveHelper.fetchAssetsWithTyres(accountIds, res.locals.role);

		if (!assetResult.success) {
			return res.send({ success: false, error: 'Error fetching vehicles.' });
		}

		let results = [{
			id: 1,
			text: 'Total Vehicles Onboarded',
			count: assetResult.results.length
		}];

		let tyresPendingCount = 0;
		let allTyreAssets = [];
		for (const Asset of assetResult.results) {
			if (Asset.details && !Asset.details.allTyresOnb) {
				tyresPendingCount += 1;
			} else {
				allTyreAssets.push(Asset.id);
			}
		}
		results.push({
			id: 2,
			text: 'Onboarding Pending',
			count: tyresPendingCount
		});
		//#endregion

		//#region service & missed service schedule count
		let schServiceCount = await models.ServiceBooking.count({
			where: {
				GeozoneId: req.params.id,
				type: 0,
				status: 0,
				date: {
					[Op.gt]: moment().subtract(1, 'day').format('YYYY-MM-DD')
				}
			},
			raw : true
		});

		let pendingSerCount = await models.ServiceBooking.count({
			where: {
				GeozoneId: req.params.id,
				type: 0,
				status: 4,
				date: {
					[Op.gt]: moment().subtract(1, 'day').format('YYYY-MM-DD')
				}
			},
			raw : true
		});

		results.push({
			id: 4,
			text: 'Vehicles Scheduled for Service \n (Pending / Approved)',
			count: `${pendingSerCount} / ${schServiceCount}`
		});

		let missedServiceSchCount = await models.ServiceBooking.count({
			where: {
				AccountId: {[Op.in]: accountIds},
				type: [0, 1],
				status: [0, 1, 4], //Scheduled, Arrived, PendingApproval
				date: {
					[Op.lte]: moment().subtract(1, 'day').format('YYYY-MM-DD')
				}
			},
			raw : true
		});
		//#endregion

		//#region vehicle in service count
		let arrivedForServiceCount = await models.ServiceBooking.count({
			where: {
				GeozoneId: req.params.id,
				status: 1,
				date: {
					[Op.between]: [moment().format('YYYY-MM-DDT[00:00:00]Z'), moment().format('YYYY-MM-DDT[23:59:59]Z')]
				}
			},
			raw : true
		});

		results.push({
			id: 5,
			text: 'Vehicles Arrived for Service',
			count: arrivedForServiceCount
		})

		let inServiceCount = await models.AplJobCard.count({
			include: [{
				attributes: ['id'],
				model: models.Asset,
				where: {
					active: true,
					remove: false
				}
			}],
			where: {
				GeozoneId: req.params.id,
				status: { [Op.ne]: 3 }
			}
		});

		results.push({
			id: 7,
			text: 'Vehicles In Service',
			count: inServiceCount
		})
		//#endregion

		//#region fetch Vehicles Pending for Service Schedule count
		let serviceAlertResult = await avolveHelper.getServiceAlerts(req, res, accountIds);
		if (!serviceAlertResult.success || serviceAlertResult.error) {
			logger.RaiseLogEvent(ROUTE, 'error', serviceAlertResult.error, 'Error fetching service reminders');
			return res.send({ success: false, error: "Error fetching service reminders" });
		}
		//#endregion

		results.push({
			id: 3,
			text: 'Vehicles Pending for Service Schedule',
			count: serviceAlertResult && serviceAlertResult.alertCountByVehicle || 0
		});

		results.push({
			id: 6,
			text: 'Vehicles Missed Service Schedule',
			count: missedServiceSchCount
		});

		results = results.sort(function (a, b) { return a.id - b.id });
		//#endregion

		return res.send({ success: true, results: results });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching count', err);
	}
}

exports.listByStatus = async function (req, res) {
	const ROUTE = 'app/assets/listByStatus';
	try {
		if (['AMCS FTE', 'AMCC FTE', 'FM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let accountIds = res.locals.accountIds;
		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			let geozoneResult = await avolveHelper.fetchGeozones(res);

			if (!geozoneResult.success) {
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}

			if (req.query.GeozoneId) {
				res.GeozoneId = req.query.GeozoneId;
			} else {
				res.GeozoneId = geozoneResult.geozones.map(x => x.id);
			}

			let result = await avolveHelper.fetchCustomers(res);

			if (result.customers && result.customers.length) {
				accountIds = result.customers.map(x => x.id) || [];
			} else {
				accountIds = [];
			}
		}

		if (res.locals.role == "FM") {
			accountIds = [res.locals.AccountId];
		}

		let assetResult = await avolveHelper.fetchAssetsWithTyres(accountIds, res.locals.role);

		if (!assetResult.success) {
			return res.send({ success: false, error: 'Error fetching vehicles.' });
		}

		let tyrePendingAssetIds = [];
		for (const Asset of assetResult.results) {
			if (Asset.details && !Asset.details.allTyresOnb) {
				tyrePendingAssetIds.push(Asset.id);
			}
		}

		let whereClause = {
			AccountId: accountIds,
			remove: false
		};

		if (assetResult.results.length && req.query.status == 1) {
			whereClause = {
				id: assetResult.results.map(x => x.id)
			}
		} else if (req.query.status == 2) {
			whereClause = {
				id: tyrePendingAssetIds
			}
		}

		whereClause.plan = 1; //AMCS
		if (res.locals.role == 'AMCC FTE') whereClause.plan = 2; //AMCC

		let Assets = await models.Asset.findAll({
			attributes: [
				'AccountId', 'active', 'alarm', 'createdAt', 'removalDates', 'dtype', 'id',
				'lastDeviceAttribute', 'lplate', 'name', 'odo', 'engineHrs', 'engineHrsT',
				'fuel', 'fuel2', 'fuel3', 'share', 'type', 'updatedAt', 'av', 'note', 'address',
				'caddress', 'vType', 'ownerName', 'sensor', 'tags', 'ptype', 'group', 'oldgrossweight',
				'grossweight', 'unladenweight', 'axleProfile', 'axleConfig', 'mfgYear', 'serviceBasedOn',
				'restriction', 'chassisNo', 'engineNo', 'fTankCapacity', 'fuelCTable',
				'fTankCapacity2', 'mfgMonth', 'sCapacity', 'avgKM', 'avgHrs', 'pLocation', 'cards',
				'sensors', 'alarmSettings', 'onoff2N', 'assetCode', 'DriverGroupId',
				'rtoLocation', 'hierarchyIds', 'expMileage', 'expMileageUom', 'details', 'images', 'tripid'
			],
			include: [
				{
					attributes: ['id', 'name', 'tname'],
					model: models.Account
				},
				{
					attributes: ['id', 'type', 'variant'],
					model: models.VehicleType
				},
				{
					attributes: ['id', 'modelName'],
					model: models.VehicleModel,
					include: [
						{
							attributes: ['id', 'brandName'],
							model: models.VehicleBrand
						}
					]
				}
			],
			where: whereClause
		});

		return res.send({ success: true, results: Assets });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching assets', err);
	}
}

exports.updateOdo = async function (req, res) { //n
	
    const ROUTE = 'app/assets/updateOdo';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing input parameter.' });
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'axleProfile', 'odo', 'axleConfig', 'details', 'AccountId'],
			where: { id: req.params.id },
			raw : true
		});

		if (!Asset) {
			return res.send({ success: false, error: "Asset not found" });
		}

		if (Asset.details && !Asset.details.allTyresOnb) {
			return res.send({ success: false, error: "Couldn't update odo. Please onboard all tyres and proceed." });
		}

		let odo = Number(req.body.odo * 1000);

		if (Number(Asset.odo) > Number(odo)) {
			return res.send({ success: false, error: 'Odometer should be greater than previous vehicle odometer.' });
		}

		let updateAsset = await Asset.update({
			odo: odo
		});

		evt.events.emit('fetch-avolve-service-alerts', {
			AccountId: Asset.AccountId
		});

		return res.send({ success: true, Asset: updateAsset });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error updating odo', err);
	}
}

exports.deleteAssets = async function (req, res) {
	const ROUTE = 'app/assets/deleteAssets';
	try {
		
		logger.RaiseLogEvent(ROUTE, req.body.assetIds, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		if (['KAM', 'FTS KAM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.body.assetIds || !req.body.assetIds.length) {
			return res.send({ success: false, error: 'Missing vehicle id.' });
		}

		let Assets = await models.Asset.findAll({
			attributes: ['id', 'lplate'],
			include: [{
				attributes: ['id', 'tyreNo'],
				model: models.Tyre,
				required: false
			},
			{
				attributes: ['id', 'AssetId'],
				model: models.ServiceBooking,
				required: false
			},
			{
				attributes: ['id', 'AssetId'],
				model: models.TyreHistory,
				required: false
			}],
			where: {
				id: req.body.assetIds
			}
		});

		if (!Assets.length) {
			return res.send({ success: false, error: 'Vehicles not found in system.' });
		}

		let tyreMappedAssets = [], bookingAssets = [], tyreHistAssets = [];
		for (let Asset of Assets) {
			if (Asset.Tyres && Asset.Tyres.length) {
				tyreMappedAssets.push(Asset.lplate);
			}
			if (Asset.ServiceBookings && Asset.ServiceBookings.length) {
				bookingAssets.push(Asset.lplate);
			}
			if (Asset.TyreHistories && Asset.TyreHistories.length) {
				tyreHistAssets.push(Asset.lplate);
			}
		}

		if (tyreMappedAssets.length) {
			return res.send({ success: false, error: `${tyreMappedAssets.length > 1 && 'Vehicles' || 'Vehicle'} ${tyreMappedAssets.join(', ')} mapped with tyres, cannot be deleted.` });
		}

		if (bookingAssets.length) {
			let multiple = bookingAssets.length > 1 && true || false;
			return res.send({ success: false, error: `${multiple && 'Vehicles' || 'Vehicle'} ${bookingAssets.join(', ')} ${multiple && 'are' || 'is'} scheduled for onboarding service, cannot be deleted.` });
		}

		if (tyreHistAssets.length) {
			let multiple = tyreHistAssets.length > 1 && true || false;
			return res.send({ success: false, error: `${multiple && 'Vehicles' || 'Vehicle'} ${tyreHistAssets.join(', ')} ${multiple && 'were' || 'was'} onboarded with tyre, cannot be deleted.` });
		}

		await models.Asset.destroy({
			where: {
				id: Assets.map(x => x.id)
			}
		});

		return res.send({ success: true });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching vehicles', err);
	}
}

exports.listByUser = async function (req, res) {
	const ROUTE = 'app/assets/listByUser';
	try {
		if (['HO Sales', 'ZM', 'KAM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let accountIds = [], kamUsers = [];
		if (["KAM", "FTS KAM"].includes(res.locals.role)) {
			accountIds = req.query.AccountId && [req.query.AccountId] || res.locals.accountIds;
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

		let fteUsers = await avolveHelper.getFteUsersByCustomers(accountIds, false, res.locals.masterAccountId);
		fteUsers = fteUsers.results || [];

		let accountUsers = await avolveHelper.getUsersByAccounts(accountIds, ["KAM", "FTS KAM"].includes(res.locals.role) && [] || kamUsers, fteUsers);
		accountUsers = accountUsers.results || [];

		let whereClause = {
			active: true,
			remove: false,
			AccountId: {[Op.in]: accountIds}
		}

		if (req.query.excel == 'true' && req.query.offer) {
			whereClause.plan = Number(req.query.offer);
		}

		let Assets = await models.Asset.findAll({
			attributes: ['id', 'lplate', 'details', 'plan', 'createdAt', 'axleConfig', 'axleProfile', 'AccountId'],
			include: [{
				attributes: ['id', 'name', 'tname'],
				model: models.Account,
				include: [{
					attributes: ['id', 'offerType', 'subOfferType'],
					model: models.AplOffer,
					where: {
						status: 'Active',
						startDate: { [Op.lte]: moment().format('YYYY-MM-DD') },
						endDate: { [Op.gte]: moment().format('YYYY-MM-DD') },
					},
					required: false
				}]
			}, {
				attributes: ['id', 'tyreNo', 'createdAt'],
				model: models.Tyre,
				where: {
					AccountId: accountIds,
					'lastStatus.position': { [Op.notIn]: ["SP", "SP1", "SP2", "SP3", "SP4"] }
				},
				required: false
			},
			{
				model: models.VehicleModel,
				attributes: ['modelName', 'year'],
				include: [{
					attributes: ['brandName'],
					model: models.VehicleBrand
				}],
				required: false
			}],
			where: whereClause
		});

		let fitmentHistories = [];
		if (req.query.excel == 'true') {
			fitmentHistories = await models.TyreHistory.findAll({
				attributes: ['id', 'histDate', 'AssetId', 'position'],
				where: {
					AssetId: Assets.map(x => x.id),
					transaction: 'Fitment',
					AccountId: {[Op.in] : accountIds},
				},
				raw : true
			});
		}

		let results = [], excelResults = [];
		for (const Asset of Assets) {
			let result = {
				id: Asset.id,
				lplate: Asset.lplate,
				details: Asset.details || {},
				plan: Asset.plan,
				offerName: getOfferName(Asset.plan),
				onboardedDate: moment(Asset.createdAt).format('DD/MM/YYYY hh:mm A'),
				tyresObPending: Asset.details && Asset.details.allTyresOnb && true || false,
				tname: Asset.Account.tname,
				wheeler: Asset.axleProfile,
				mdgid: Asset.Account.name
			};
			let inActAxleCount = 0;
			if (Asset.axleConfig && Asset.axleConfig.config) {
				let inActiveAxles = Asset.axleConfig.config.filter(x => x.active == false); //ignore in-active axle positions
				for (let inActiveAxle of inActiveAxles) {
					if (inActiveAxle.position) {
						inActAxleCount += inActiveAxle.position.length;
					}
				}
			}
			results.push(result);

			if (req.query.excel == 'true') {
				let asset = {};
				let AccountId = Asset.AccountId;
				let AplOffers = Asset.Account.AplOffers.length && Asset.Account.AplOffers.sort(function (a, b) { return a.id - b.id }) || [];
				let accountUser = accountUsers && accountUsers.length && accountUsers.find(x => x.AccountId == AccountId) || '';
				asset.kamName = ["KAM", "FTS KAM"].includes(res.locals.role) ? res.locals.userFullName || res.locals.username : accountUser && accountUser.kamName || '';
				asset.fteName = accountUser && accountUser.fteName || '';
				let matchHistories = fitmentHistories.filter(x => x.AssetId == Asset.id);
				matchHistories = matchHistories.sort(function (a, b) {
					return moment(b.histDate) - moment(a.histDate);
				});

				asset.offerType = AplOffers.length && AplOffers[0].offerType || '';
				asset.vehicleOnboard = moment(Asset.createdAt).format('DD-MM-YYYY hh:mm:ss A');
				asset.subOfferType = AplOffers.length && AplOffers[0].subOfferType || '';
				asset.name = Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.name || '';
				asset.config = Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.config || '';
				asset.lastTyreOnboard = matchHistories.length && moment(matchHistories[0].histDate).format('DD-MM-YYYY hh:mm:ss A') || '';
				asset.vtStatus = result.tyresObPending ? 'Y' : 'N';
				asset.tyreCount = Asset.Tyres.length && parseInt(Asset.Tyres.length - inActAxleCount) || 0;
				asset.make = Asset.VehicleModel && Asset.VehicleModel.modelName || '';
				asset.model = Asset.VehicleModel && Asset.VehicleModel.VehicleBrand && Asset.VehicleModel.VehicleBrand.brandName || '';

				excelResults.push({ ...asset, ...result });
			}
		}

		if (req.query.excel == 'true') {
			try {
				let fileName = `APL_Vehicle_Summary.xlsx`;

				let columns = [{ header: 'KAM', key: 'kamName' },
				{ header: 'FTE', key: 'fteName' },
				{ header: 'Customer Name', key: 'tname' },
				{ header: 'Offer', key: 'offerType' },
				{ header: 'Sub Offer', key: 'subOfferType' },
				{ header: 'Asset Number', key: 'lplate' },
				{ header: 'Wheeler', key: 'wheeler' },
				{ header: 'Config', key: 'config' },
				{ header: 'Name', key: 'name' },
				{ header: 'Make', key: 'make' },
				{ header: 'Model', key: 'model' },
				{ header: 'Vehicle Onboarded date', key: 'vehicleOnboard' },
				{ header: 'No. of Tyre onboarded', key: 'tyreCount' },
				{ header: 'Last Tyre Onboarded date', key: 'lastTyreOnboard' },
				{ header: 'V+T status', key: 'vtStatus' }];

				return await avolveHelper.avolveExcelExport(fileName, columns, excelResults, req, res);
			} catch (err) {
				console.log(`Error in ${ROUTE}: `, err);
				logger.RaiseLogEvent(ROUTE, 'error', err, `Error creating excel`);
			}
		}
		return res.send({ success: true, results: results, error: null });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching assets', err);
	}
}

exports.listByUserDownload = async function (req, res) {
	const ROUTE = 'app/assets/listByUserDownload';
	try {
		let { consumerKey, type, tableName } = avolveHelper.getInsightDump(24, 'all') || {}; // vehicle summary
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
		let tempTableName = `z_${tableName}_${res.locals.UserId}`;
		// create a new insight record for the user
		let NewInsight = await models.Insight.create({
			type: type,
			input: {
				tempTable: tempTableName,
				accountIds: AccountIds,
				fromApp: ['FM', 'FO'].includes(res.locals.role),
				deviceId: req.query.deviceId,
				typeId: 24,
				allCustomers,
				useAvolveEmail: false // use no-reply sender for vehicle summary
			},
			progress: 0,
			UserId: res.locals.UserId,
			startTime: moment(),
			AccountId: res.locals.AccountId
		});

		evt.events.emit(`${consumerKey}-app`, {
			input: {
				accountIds: AccountIds,
				deviceId: req.query.deviceId,
				emailReport: true,
				typeId: 24 // vehicle summary
			},
			insightId: NewInsight.id,
			UserId: res.locals.UserId,
			AccountId: NewInsight.AccountId,
			emailReport: true,
			tempTable: tempTableName
		});

		return res.send({ success: true, message: `Report generation initiated. You can download it from the Downloads menu once processing is completed.` });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching assets', err);
	}
}

exports.payKmList = async function (req, res) {
	const ROUTE = 'app/assets/payKmList ';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { // Avolve
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		let sDate = moment().subtract(30, 'days').startOf('day');
		let eDate = moment();
		if (req.query.sdate && req.query.edate) {
			sDate = moment(req.query.sdate).startOf('day');
			eDate = moment(req.query.edate).endOf('day');
		}

		let accountWhere = {
			type: 11, // Avolve Customers
			AccountIdParent: res.locals.masterAccountId,
			status: 1,
			'details.payKm': true
		}

		let assetWhere = {
			active: true,
			remove: false,
			createdAt: { [Op.between]: [sDate.toISOString(), eDate.toISOString()] }
		};

		if (req.query.accountId) {
			delete assetWhere.createdAt;
			accountWhere.id = req.query.accountId;
		}

		if (req.query.allDates == 'true' || req.query.allDates == true) {
			delete assetWhere.createdAt;
		}

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'name', 'tname', 'oname', 'email1', 'baddress', 'anote', 'createdAt', 'totalvehicle', 'phone1'],
			include: [{
				attributes: ['id', 'offerType', 'subOfferType'],
				model: models.AplOffer
			}],
			where: accountWhere,
			order: [[models.AplOffer, 'id', 'DESC']]
		});

		if (!Accounts.length) {
			return res.send({ success: false, results: [] });
		}
		let accountIds = Accounts.map(x => x.id);
		assetWhere.AccountId = accountIds;

		let Assets = await models.Asset.findAll({
			attributes: ['id', 'lplate', 'imei', 'details', 'AccountId', 'createdAt', 'lastDeviceAttribute'],
			include: [{
				attributes: ['id', 'tpmsData'],
				model: models.Tyre
			}],
			where: assetWhere
		});

		let AssetServices = await models.AssetService.findAll({
			attributes: ['id', 'createdAt', 'status', 'AssetId', 'AccountId'],
			where: {
				AssetId: Assets.map(x => x.id),
				status: { [Op.notIn]: [12, 13] } // closed, Invalid request
			},
			raw: true
		});
		let kamResults = await avolveHelper.getKamListByCustomers(accountIds, res.locals.masterAccountId);
		let kamsList = [];
		if (kamResults.success) {
			kamsList = kamResults.results;
		}
		let AssetServicesMap = new Map();
		for (const AssetService of AssetServices) {
			if (!AssetServicesMap.has(AssetService.AssetId)) {
				AssetServicesMap.set(AssetService.AssetId, []);
			}
			AssetServicesMap.get(AssetService.AssetId).push(AssetService);
		}

		let AccountMap = new Map();
		let KamMap = new Map();
		for (const Account of Accounts) {
			if (!AccountMap.has(Account.id)) {
				AccountMap.set(Account.id, Account);
			}
			if (!KamMap.has(Account.id)) {
				if (kamsList && kamsList.length) {
					for (let kamObj of kamsList) {
						let accounts = (kamObj.accountIds && kamObj.accountIds.map(x => x.id)) || [];
						if (accounts.some(accId => accId == Account.id)) {
							KamMap.set(Account.id, { ...kamObj, accountIds: undefined });
							break;
						}
					}
				}
			}
		}

		let results = [];
		for (const Asset of Assets) {
			let account = AccountMap.get(Asset.AccountId) || '';
			let AplOffer = account && account.AplOffers && account.AplOffers.length && account.AplOffers[0] || {};
			let axleProfile = Asset.details && Asset.details.axleProfile || {};
			let dTime = Asset.lastDeviceAttribute && Asset.lastDeviceAttribute.dTime || '';
			let matchedServices = AssetServicesMap.get(Asset.id) || '';
			let lastData = Asset.lastDeviceAttribute;
			let batteryVoltage = lastData && lastData.io && lastData.io.io_67;
			let batteryVoltageDecimal = isNaN(batteryVoltage) ? 0 : Number(batteryVoltage / 1000);
			let updatedBatteryVoltage = batteryVoltageDecimal ? Number(batteryVoltageDecimal).toFixed(1) : '';
			let satellite = lastData && lastData.satenum || '';
			let gsm = lastData && lastData.gsm || '';
			let kam = KamMap.get(account.id) || {};
			let result = {
				AccountId: account.id,
				tname: account && account.tname || '',
				mdgId: account && account.name && account.name.split('_')[0] || '',
				offer: AplOffer && AplOffer.offerType || '',
				subOffer: AplOffer && AplOffer.subOfferType || '',
				AssetId: Asset.id,
				lplate: Asset.lplate || '',
				imeiNo: Asset.imei || '',
				satellite: satellite || '',
				gsm: gsm || '',
				batteryVoltage: updatedBatteryVoltage || '',
				wheeler: axleProfile && axleProfile.wheeler || '',
				config: axleProfile && axleProfile.config || '',
				name: axleProfile && axleProfile.name || '',
				installedOn: Asset.createdAt || '',
				gpsTimestamp: dTime || '',
				charging: lastData && lastData.charging || null,
				kam: kam,
				gpsStatus: 'Active',
				tpmsStatus: 'Active'
			};
			if (matchedServices && matchedServices.length && matchedServices[0]) {
				result.serviceDetails = {
					id: matchedServices[0].id,
					status: avolveHelper.serviceStatusLookUp(matchedServices[0].status),
					date: matchedServices[0].createdAt || ''
				};
			}

			if (!dTime || moment().diff(moment(dTime).add(330, 'minutes'), 'minutes') > 60) {
				result.gpsStatus = 'Disconnected';
			}
			if (Asset.Tyres && Asset.Tyres) {
				for (const tyre of Asset.Tyres) {
					if (!tyre.tpmsData || !Object.keys(tyre.tpmsData).length) {
						result.tpmsStatus = 'Disconnected';
						break;
					} else if (!tyre.tpmsData || !tyre.tpmsData.TIME || moment().diff(moment(tyre.tpmsData.TIME), 'minutes') > 60) {
						result.tpmsStatus = 'Disconnected';
						break;
					}
				}

			}
			results.push(result);
		}
		if (req.query.gpsIssue == 'true' || req.query.gpsIssue == true) {
			results = results.filter(x => x.gpsStatus == 'Disconnected');
		}

		if (req.query.tpmsIssue == 'true' || req.query.tpmsIssue == true) {
			results = results.filter(x => x.tpmsStatus == 'Disconnected');
		}

		return res.send({ success: true, results: results });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching assets', err);
	}
}

exports.monitoredFitment = async function (req, res) {
	const ROUTE = 'app/assets/monitoredFitment';
	try {
		logger.RaiseLogEvent(ROUTE, req.body.AssetId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!['KAM', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.body.AssetId || !req.body.mfAxles || !req.body.mfAxles.length) {
			return res.send({ success: false, error: 'Missing input parameter!' });
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'axleConfig', 'details', 'AccountId'],
			include: [{
				attributes: [],
				model: models.Account,
				where: {
					AccountIdParent: res.locals.masterAccountId
				}
			}],
			where: {
				id: req.body.AssetId
			}
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found' });
		}

		let axleConfig = Asset.axleConfig && JSON.parse(JSON.stringify(Asset.axleConfig)) || {};
		if (!axleConfig || (axleConfig && !axleConfig.config)) {
			return res.send({ success: false, error: 'Axle configuration not updated for this vehicle.' });
		}

		let assetRequest = false;
		let prevStatus = axleConfig.config.some(x => x.mf && x.mf.active == true);
		let mfFlag = prevStatus;
		let sparePositions = ['SP', 'SP1', 'SP2', 'SP3', 'SP4'];
		let reqWithTyres = [];
		let reqWithoutTyres = [];
		let unMarkedAxles = [];
		let newMFRequest = false;
		for (const config of axleConfig.config) {
			if (config.position.some(pos => sparePositions.includes(pos))) {
				continue;
			}
			let matchedReqAxle = req.body.mfAxles.find(x => x.name == config.name && x.axle == config.axle);
			if (config.mf && matchedReqAxle && !config.mf.req && matchedReqAxle.mf == config.mf.active) {
				continue;
			}
			newMFRequest = true;
			let request = false, active = false;
			if (matchedReqAxle && matchedReqAxle.mf) {
				if (matchedReqAxle.isTyre) {
					active = false;
					request = true;
					assetRequest = true;
					reqWithTyres.push(matchedReqAxle.name);
				} else {
					active = true;
					request = false;
					reqWithoutTyres.push(matchedReqAxle.name);
				}
			}
			if (config.mf && (config.mf.active || config.mf.req) && !matchedReqAxle.mf) {
				unMarkedAxles.push(matchedReqAxle.name);
			}
			config.mf = { req: request, active: active };
		}

		if (!prevStatus && assetRequest) {
			mfFlag = false;
		}

		if (!axleConfig.config.some(x => x.mf && x.mf.active == true)) {
			mfFlag = false;
		}

		if (reqWithoutTyres.length) {
			mfFlag = true;
		}

		let message = '<html><p>Dear User,';
		if (reqWithoutTyres.length) {
			message += ` You have marked <b>${reqWithoutTyres.join(', ')} ${reqWithoutTyres.length > 1 ? 'Axles' : 'Axle'}</b> for Monitored Fitment.`;
		}
		if (reqWithTyres.length) {
			message += `${reqWithoutTyres.length ? ' Additionally,' : ''} You have requested FTE to remove tyres from <b>${reqWithTyres.join(', ')} ${reqWithTyres.length > 1 ? 'Axles' : 'Axle'}</b> to mark as Monitored Fitment.`;
		}
		if (unMarkedAxles.length) {
			message += `${(reqWithoutTyres.length || reqWithTyres.length) ? ' Additionally,' : ''} You have unmarked <b>${unMarkedAxles.join(', ')} ${unMarkedAxles.length > 1 ? 'Axles' : 'Axle'}</b>.`;
		}
		if (!newMFRequest) {
			message += ` You have not requested or marked any axle for Monitored Fitment in the current request.`;
		}
		message += '</p></html>';

		if (!newMFRequest) {
			return res.send({ success: true, message: message, result: Asset });
		}

		let details = Asset.details && JSON.parse(JSON.stringify(Asset.details)) || {};
		if (details && details.axleProfile) {
			let initialDate = reqWithoutTyres.length ? moment().toISOString() : '';
			if (details.axleProfile.mf && details.axleProfile.mf.initialDate) initialDate = details.axleProfile.mf.initialDate;
			details.axleProfile.mf = {
				active: mfFlag,
				req: assetRequest,
				initialDate: initialDate
			}
		}

		await Asset.update({
			axleConfig: axleConfig,
			details: details
		});

		return res.send({ success: true, message: message, result: Asset });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error Marking MF', err);
	}
}

exports.listMFVehicles = async function (req, res) {
	const ROUTE = 'app/assets/listMFVehicles ';
	try {
		if (!['HO Sales', 'ZM', 'KAM', 'FTS HO', 'FTS ZM', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		//#region user hierarchy with customers
		let accountIds = await avolveHelper.getAccountIdByRole(res.locals, req.query, false);
		//#endregion

		let Assets = await models.Asset.findAll({
			attributes: [
				'id', 'lplate',
				[models.sequelize.fn('MAX', models.sequelize.col('Inspections.date')), 'latestInspectionDate'],
				[models.sequelize.fn('COUNT', models.sequelize.col('Inspections.id')), 'inspectionCount'],
			],
			include: [{
				model: models.Inspection,
				attributes: [],
				where: { type: 'v' },
				required: false
			}],
			where: {
				AccountId: { [Op.in]: accountIds },
				active: true,
				remove: false,
				[Op.and]: models.sequelize.literal(`"Asset"."details"->'axleProfile'->'mf'->>'active' = 'true'`)
			},
			group: ['Asset.id', 'Asset.lplate'],
			order: [['id', 'ASC']],
			raw: true
		});

		if (!Assets || !Assets.length) {
			return res.send({ success: true, results: [] });
		}

		Assets.sort((a, b) => { return moment(b.latestInspectionDate) - moment(a.latestInspectionDate); });
		const results = Assets.map(asset => {
			return {
				id: asset.id,
				lplate: asset.lplate,
				lastInspectionDate: asset.latestInspectionDate ? moment(asset.latestInspectionDate).format('DD/MM/YYYY hh:mm A') : 'N/A',
				inspectionCount: asset.inspectionCount || 0
			};
		});

		return res.send({ success: true, results: results });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching mf vehicles', err);
	}
}

exports.getVehicle = async function (req, res) {
	const ROUTE = 'app/assets/getVehicle';
	try {
		if (!req.params.id && Number.isInteger(req.params.id) && req.params.id < 0) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let AccountId = res.locals.AccountId;
		if (req.query.AccountId) {
			AccountId = req.query.AccountId;
		}

		let whereClause = {
			id: req.params.id,
			remove: false,
			AccountId: AccountId
		}

		let vehicleInsWhere = {
			AssetId: req.params.id,
			type: 'vd',
			date: { [Op.gte]: moment().subtract(72, 'hours').toISOString() },
			AccountId: AccountId
		}

		let tyreInsWhere = {
			AssetId: req.params.id,
			type: 't',
			AccountId: AccountId
		}

		if (['AMCS FTE', 'AMCC FTE', 'KAM'].indexOf(res.locals.role) > -1) {
			let accountIds = [];
			if (res.locals.role == "AMCS FTE") {
				whereClause.plan = 1; //AMCS
				delete whereClause.AccountId;
			} else {
				if (!['KAM'].includes(res.locals.role)) {
					whereClause.plan = 2; //AMCC
				}
				accountIds = res.locals.accountIds;
				whereClause.AccountId = { [Op.in]: accountIds };
				vehicleInsWhere.AccountId = { [Op.in]: accountIds };
				tyreInsWhere.AccountId = { [Op.in]: accountIds };
			}
		}

		if (['XE FTE', 'ARSA', 'FTS KAM'].indexOf(res.locals.role) > -1) { //For xpert edge, KAM and FTS KAM - customers based
			if (!req.query.AccountId) {
				return res.send({ success: false, error: `Please select customer to proceed.` });
			}
			whereClause.AccountId = req.query.AccountId;
			vehicleInsWhere.AccountId = [req.query.AccountId];
			tyreInsWhere.AccountId = req.query.AccountId;
		}

		let Asset = await models.Asset.findOne({
			attributes: [
				'imei', 'AccountId', 'active', 'alarm', 'createdAt', 'dtype', 'id', 'lastDeviceAttribute',
				'lplate', 'name', 'odo', 'engineHrs', 'engineHrsT', 'fuel', 'fuel2', 'fuel3', 'share', 'type',
				'updatedAt', 'av', 'note', 'address', 'caddress', 'vType', 'ownerName', 'sensor', 'tags',
				'ptype', 'group', 'oldgrossweight', 'grossweight', 'unladenweight', 'axleProfile', 'axleConfig',
				'mfgYear', 'serviceBasedOn', 'restriction', 'chassisNo', 'engineNo', 'fTankCapacity',
				'fTankCapacity2', 'mfgMonth', 'sCapacity', 'avgKM', 'avgHrs', 'pLocation', 'cards',
				'sensors', 'assetCode', 'sensorConfig', 'VehicleTypeId', 'VehicleModelId', 'expMileage',
				'expMileageUom', 'rtoLocation', 'availability', 'hierarchyIds', 'maxspeed', 'maxspeedN',
				'idle', 'idleN', 'onoff2N', 'alarmSettings', 'grease', 'details', 'plan'
			],
			include: [{
				attributes: ['id', 'type', 'variant'],
				model: models.VehicleType
			}, {
				attributes: ['id', 'modelName'],
				model: models.VehicleModel,
				include: [{
					attributes: ['id', 'brandName'],
					model: models.VehicleBrand
				}]
			},
			{
				attributes: ['id'],
				model: models.Account,
				where: {
					AccountIdParent: res.locals.masterAccountId
				},
				required: true
			}],
			where: whereClause,
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		// Flag to handle onboarding service inspection done for XE FTE to handle vehicle inspection redirrection.
		let isOnbServiceDone = false;
		let VehicleInspection = await models.Inspection.findOne({
			attributes: ['date'],
			where: {
				AssetId: req.params.id,
				type: 'v'
			},
			order: [['date', 'desc']]
		});
		if (VehicleInspection && res.locals.role == 'XE FTE') {
			isOnbServiceDone = true;
		}

		// Flag to restirct vehicle inspection for XE FTE.
		let showVehicleInspection = true;
		if (VehicleInspection && res.locals.role == 'XE FTE' && moment().subtract(72, 'hours').isSameOrBefore(moment(VehicleInspection.date))) {
			showVehicleInspection = false;
		}

		if (res.locals.role == "AMCS FTE") {
			vehicleInsWhere.AccountId = Asset.AccountId;
			tyreInsWhere.AccountId = Asset.AccountId;
		}

		let VehicleInspect = await models.Inspection.findOne({
			where: vehicleInsWhere,
			order: [['date', 'desc']],
			raw: true
		});

		let lastInspectionDate = VehicleInspection && VehicleInspection.date || '';
		let pendingInspection = false;
		if (VehicleInspect) {
			tyreInsWhere.date = { [Op.gte]: VehicleInspect.date };
			let TyreInpsect = await models.Inspection.findOne({
				where: tyreInsWhere,
				order: [['date', 'desc']],
				raw: true
			});
			if (moment().diff(moment(VehicleInspect.date), 'hours') < 72) { //Inspection window 72hrs
				if (!TyreInpsect) {
					pendingInspection = true;
					lastInspectionDate = VehicleInspect.date;
				}
			}
		}
		Asset = JSON.parse(JSON.stringify(Asset));
		Asset.pendingInspection = pendingInspection;
		Asset.lastInspectionDate = lastInspectionDate;
		Asset.isOnbServiceDone = isOnbServiceDone;
		Asset.showVehicleInspection = showVehicleInspection;
		return res.send({ success: true, asset: Asset });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching vehicles', err);
	}
}

exports.listSelect = async function (req, res) {
	const ROUTE = 'app/assets/listSelect';
	try {
		const whereClause = {
			AccountId: res.locals.AccountId,
			active: true
		};

		if (req.query.AccountId) {
			whereClause.AccountId = req.query.AccountId.split(',').map(f => f.trim()).filter(Boolean);
		}

		const fieldsParam = (req.query.fields || 'id').toString();
		const fields = fieldsParam.split(',').map(f => f.trim()).filter(Boolean);
		const attributes = Array.from(new Set(['id', ...fields]));

		let AssetInclude = [];
		let vehicleTypeFilter = {};
		let includeVehcileType = false;
		let vehicleTypeWhere = {};

		if (req.query.isNonTrailer && req.query.isNonTrailer == 'true') {
			vehicleTypeWhere = { type: { [Op.notILike]: "%trailer%" } };
			includeVehcileType = true;
		}
		if (req.query.vehicleType) {
			vehicleTypeWhere = { type: { [Op.iLike]: `%${req.query.vehicleType}%` } };
			includeVehcileType = true;
		}

		if (attributes.includes('vehicleType')) {
			var index = attributes.indexOf('vehicleType');
			if (index != -1) {
				attributes.splice(index, 1);
			}
			includeVehcileType = true;
			vehicleTypeFilter.attributes = ['id', 'type', 'variant'];
		} else if (includeVehcileType) {
			vehicleTypeFilter.attributes = [];
		}

		if (includeVehcileType) {
			vehicleTypeFilter.model = models.VehicleType;
			if (Object.keys(vehicleTypeWhere).length) {
				vehicleTypeFilter.where = vehicleTypeWhere;
			}
		}

		if (Object.keys(vehicleTypeFilter).length) {
			AssetInclude = [vehicleTypeFilter];
		}

		const Assets = await models.Asset.findAll({
			include: AssetInclude,
			where: whereClause,
			attributes: [...attributes],
		});

		return res.send({ success: true, results: Assets });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching assets', error);
	}
}

exports.getApolloFleetAsset = async function (req, res) {
	const ROUTE = 'app/assets/getApolloFleetAsset';
	try {
		if (!req.params.id && Number.isInteger(req.params.id) && req.params.id < 0) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let Account = await models.Account.findOne({
			attributes: ['id', 'type', 'AccountIdParent'],
			where: { id: res.locals.AccountId },
			raw : true
		});

		if ([10, 11].indexOf(Account.type) == -1) {
			return res.send({ success: false, error: 'Not authorized.' });
		}

		let whereClause = {
			id: req.params.id,
			remove: false,
			AccountId: res.locals.AccountId
		};

		let vehicleInsWhere = {
			AssetId: req.params.id,
			type: 'vd',
			AccountId: res.locals.AccountId
		};

		let tyreInsWhere = {
			AssetId: req.params.id,
			type: 't',
			AccountId: res.locals.AccountId
		};

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			let accountIds = [];
			if (res.locals.role == "AMCS FTE") {
				whereClause.plan = 1; //AMCS
				delete whereClause.AccountId;
			} else {
				accountIds = res.locals.accountIds;
				whereClause.plan = 2; //AMCC
				whereClause.AccountId = { [Op.in]: accountIds };
				vehicleInsWhere.AccountId = { [Op.in]: accountIds };
				tyreInsWhere.AccountId = { [Op.in]: accountIds };
			}
		}

		if ([...KAM_ROLES,].indexOf(res.locals.role) > -1) { //For xpert edge, KAM and FTS KAM - customers based
			if (!req.query.AccountId) {
				return res.send({ success: false, error: `Please select customer to proceed.` });
			}
			whereClause.AccountId = req.query.AccountId;
			vehicleInsWhere.AccountId = { [Op.in]: [req.query.AccountId] };
			tyreInsWhere.AccountId = req.query.AccountId;
		}

		let Asset = await models.Asset.findOne({
			attributes: [
				'imei', 'AccountId', 'active', 'alarm', 'createdAt', 'dtype', 'id', 'lastDeviceAttribute',
				'lplate', 'name', 'odo', 'engineHrs', 'engineHrsT', 'fuel', 'fuel2', 'fuel3', 'share', 'type',
				'updatedAt', 'av', 'note', 'address', 'caddress', 'vType', 'ownerName', 'sensor', 'tags',
				'ptype', 'group', 'oldgrossweight', 'grossweight', 'unladenweight', 'axleProfile', 'axleConfig',
				'mfgYear', 'serviceBasedOn', 'restriction', 'chassisNo', 'engineNo', 'fTankCapacity',
				'fTankCapacity2', 'mfgMonth', 'sCapacity', 'avgKM', 'avgHrs', 'pLocation', 'cards',
				'sensors', 'assetCode', 'sensorConfig', 'VehicleTypeId', 'VehicleModelId', 'expMileage',
				'expMileageUom', 'rtoLocation', 'availability', 'hierarchyIds', 'maxspeed', 'maxspeedN',
				'idle', 'idleN', 'onoff2N', 'alarmSettings', 'grease', 'details', 'plan'
			],
			include: [{
				attributes: ['id', 'type', 'variant'],
				model: models.VehicleType
			}, {
				attributes: ['id', 'modelName'],
				model: models.VehicleModel,
				include: [{
					attributes: ['id', 'brandName'],
					model: models.VehicleBrand
				}]
			},
			{
				attributes: ['id'],
				model: models.Account,
				where: {
					AccountIdParent: res.locals.masterAccountId //Apollo Fleet
				},
				required: true
			}],
			where: whereClause
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		if (res.locals.role == "AMCS FTE") {
			vehicleInsWhere.AccountId = Asset.AccountId;
			tyreInsWhere.AccountId = Asset.AccountId;
		}

		let VehicleInspect = await models.Inspection.findOne({
			where: vehicleInsWhere,
			order: [['date', 'desc']]
		});

		let lastInspectionDate = VehicleInspect && VehicleInspect.date || '';
		let pendingInspection = false;
		if (VehicleInspect) {
			tyreInsWhere.date = { [Op.gte]: VehicleInspect.date };
			let TyreInpsect = await models.Inspection.findOne({
				where: tyreInsWhere,
				order: [['date', 'desc']]
			});
			if (moment().diff(moment(VehicleInspect.date), 'hours') < 72) { //Inspection window 72hrs
				if (!TyreInpsect) {
					pendingInspection = true;
					lastInspectionDate = VehicleInspect.date;
				}
			}
		}
		Asset = JSON.parse(JSON.stringify(Asset));
		Asset.pendingInspection = pendingInspection;
		Asset.lastInspectionDate = lastInspectionDate;
		return res.send({ success: true, asset: Asset });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching assets', err);
	}
}

exports.createAsset = async function (req, res) {
	const ROUTE = 'app/assets/createAsset ';
	try {
		logger.RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (res.locals.AccountId != res.locals.masterAccountId) { //Apollo Fleet
			return res.send({ success: false, error: 'Not authorized!' });
		}
		if (!req.body.lplate || !req.body.AccountId || !req.body.VehicleModelId) {
			return res.send({ success: false, error: 'Input Parameters missing.' });
		}

		if (req.body.VehicleModelId == "Other") {
			return res.send({ success: false, error: 'Vehicle model should not be Other' });
		}

		let lplate = req.body.lplate.replace(/ /g, '');

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'AccountId'],
			where: {
				lplate: lplate,
				AccountId: req.body.AccountId
			},
			raw: true
		});

		if (Asset) {
			return res.send({ success: false, error: 'Vehicle Regn No already found.' });
		}

		let Account = await models.Account.findOne({
			attributes: ['id', 'tname', 'details'],
			where: {
				id: req.body.AccountId
			},
			raw: true
		});

		if (!Account) {
			return res.send({ success: false, error: 'Account not found.' });
		}

		let AplOffer = await models.AplOffer.findOne({
			attributes: ['id', 'details'],
			where: {
				AccountId: Account.id
			},
			order: [['id', 'DESC']],
			raw: true
		});

		let isTestAcc = Account.details && Account.details.testAcc && JSON.parse(Account.details.testAcc) ? true : false;
		let isAvolve = Account.details && Account.details.avolve && JSON.parse(Account.details.avolve) ? true : false;
		if (!AplOffer && !isTestAcc && isAvolve) {
			return res.send({ success: false, error: 'Offer not found for this customer.' });
		}

		let maxVehicles = AplOffer && AplOffer.details && parseInt(AplOffer.details.vehicles) || 0;
		let installedVehicles = await models.Asset.count({
			where: {
				AccountId: Account.id,
				remove: false,
				active: true
			}
		});

		if (maxVehicles && installedVehicles >= maxVehicles) {
			return res.send({ success: false, error: `Cannot add more than ${maxVehicles} as per contract terms.` });
		}

		let vehicleGroups = AplOffer && AplOffer.details && ((AplOffer.details.vehicleGroups) || (AplOffer.details.operations && AplOffer.details.operations.vehicleGroups)) || [];
		if (!vehicleGroups.length && !isTestAcc && isAvolve) {
			return res.send({ success: false, error: `The vehicle configuration cannot be added as it was not specified during customer onboarding.` });
		}

		let normalize = str => (str || '')
			.replace(/\s+/g, '')
			.replace(/x/g, '*')
			.toUpperCase();

		let isAxleConfigMatched = (vehicleGroups).some(x =>
			normalize(x.wheeler) === normalize(req.body.wheeler) &&
			normalize(x.config) === normalize(req.body.config) &&
			normalize(x.name) === normalize(req.body.name)
		);

		if (!isAxleConfigMatched && !isTestAcc && isAvolve) {
			return res.send({ success: false, error: "The vehicle configuration cannot be added as it was not specified during customer onboarding." });
		}

		let matchWheel = req.body.wheeler && axleConfigAvolve[req.body.wheeler] || {};
		let axleConfig = {};
		if (matchWheel && req.body.config) {
			let matchConfig = matchWheel[req.body.config] || [];
			if (matchConfig.length && req.body.name) {
				let matchName = matchConfig.find(x => x.name == req.body.name);
				if (matchName && matchName.value) {
					axleConfig = matchName.value;
				}
			}
		}

		if (req.body.liftAxleStatus && JSON.parse(req.body.liftAxleStatus).length) {
			if (axleConfig.config && axleConfig.config.length) {
				axleConfig.config.map(config => {
					let matchAxle = JSON.parse(req.body.liftAxleStatus).find(x => x.axle == config.axle && x.name == config.name);
					config.active = matchAxle ? matchAxle.active : true;
					return config;
				});
			}
		}

		let rcImages = [];
		let rcImagesPush = [];
		if (req.files && req.files.length) {
			rcImages = req.files.map(obj => {
				rcImagesPush.push(obj);
				return '/' + md5(res.locals.AccountId) + '/Apollo/Asset/' + lplate + '_' + obj.filename;
			})
		}
		let images = {
			rcImages: rcImages
		}

		let details = {
			axleProfile: {
				wheeler: req.body.wheeler || "",
				config: req.body.config || "",
				name: req.body.name || ""
			},
			allTyresOnb: false
		};

		let asset = await models.Asset.create({
			lplate: lplate,
			AccountIdParent: req.body.AccountIdParent,
			AccountId: req.body.AccountId,
			VehicleModelId: req.body.VehicleModelId,
			axleProfile: req.body.wheeler,
			axleConfig: axleConfig,
			dtype: 'ET200',
			odo: 0,
			engineHrs: 0,
			simOnly: 0,
			serverOnly: 0,
			mfgYear: null,
			billingType: 'Apollo Fleet',
			demo: false,
			saleType: 'Server Only',
			lmTime: moment().valueOf(),
			note: 'Apollo Fleet Asset',
			images: images,
			details: details,
			plan: Account.details && Account.details.plan || 3
		});

		evt.events.emit('apl-reportlog', {
			AccountId: asset.AccountId,
			transaction: 'Increment',
			reportValues: ['os'],
			property: 'totalVehicles'
		});

		for (const rcImage of rcImagesPush) {
			if (rcImage && rcImage.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: rcImage.path,
					s3Path: md5(res.locals.AccountId) + '/Apollo/Asset/' + asset.lplate + '_' + rcImage.filename
				});
			}
		}

		evt.events.emit('asset-service-master-create', {
			AssetId: asset.id,
			AccountId: asset.AccountId
		});

		return res.send({ success: true, asset: asset });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching vehicles', err);
	}
}

exports.listCustomerAssets = async function (req, res) {
	const ROUTE = 'app/assets/listCustomerAssets';

	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { // Apollo Fleet
			return res.send({ success: false, error: 'Not authorized!' });
		}
		let accountWhere = {
			AccountIdParent: res.locals.AccountId,
			type: 11
		};
		let listAll = true;
		if (req.query && req.query.AccountId) {
			accountWhere.id = req.query.AccountId
			listAll = false;
		}
		let customers = await models.Account.findAll({
			attributes: ['id'],
			where: accountWhere
		});

		let customerAccountIds = customers.map(x => x.id);
		if (listAll) {
			customerAccountIds.push(res.locals.AccountId);
		}
		if (res.locals.role != "Admin" && listAll) {
			customerAccountIds = res.locals.accountIds
		}
		if (res.locals.role == "KAM" && listAll) {
			let custResult = await avolveHelper.getCustomersByUser(res.locals.UserId, true, res.locals.masterAccountId);
			if (custResult.success && custResult.results.length) {
				customerAccountIds = custResult.results.map(x => x.id);
			}
		}
		var where = { AccountId: customerAccountIds, remove: false };
		if (res.locals.assetIds != null && res.locals.assetIds.length > 0) {
			where.id = { [Op.in]: res.locals.assetIds };
		}

		if ([true, 'true'].indexOf(req.query.removedAssets) > -1) {
			where.remove = true;
		}

		let assetInclude = [];
		let attributes = ['id', 'lplate', 'axleProfile', 'AccountId', 'details', 'createdAt', 'plan'];
		if (req.query.excel == 'true') {
			attributes = [
				'AccountId', 'active', 'alarm', 'createdAt', 'removalDates', 'dtype', 'id',
				'lastDeviceAttribute', 'lplate', 'name', 'odo', 'engineHrs', 'engineHrsT',
				'fuel', 'fuel2', 'fuel3', 'share', 'type', 'updatedAt', 'av', 'note', 'address',
				'caddress', 'vType', 'ownerName', 'sensor', 'tags', 'ptype', 'group', 'oldgrossweight',
				'grossweight', 'unladenweight', 'axleProfile', 'axleConfig', 'mfgYear', 'serviceBasedOn',
				'restriction', 'chassisNo', 'engineNo', 'fTankCapacity', 'fuelCTable',
				'fTankCapacity2', 'mfgMonth', 'sCapacity', 'avgKM', 'avgHrs', 'pLocation', 'cards',
				'sensors', 'alarmSettings', 'onoff2N', 'assetCode', 'DriverGroupId',
				'rtoLocation', 'hierarchyIds', 'expMileage', 'expMileageUom', 'details', 'images', 'plan'
			];
			assetInclude = [
				{
					attributes: ['id', 'name', 'tname'],
					model: models.Account
				},
				{
					attributes: ['id', 'type', 'variant'],
					model: models.VehicleType
				},
				{
					attributes: ['id', 'modelName'],
					model: models.VehicleModel,
					include: [
						{
							attributes: ['id', 'brandName'],
							model: models.VehicleBrand
						}
					]
				}
			];
		}

		let assets = await models.Asset.findAll({
			attributes: attributes,
			include: assetInclude,
			where: where,
			order: [['lplate', 'ASC']],
			raw : true
		});

		if (req.query.excel == 'true') {
			return await createCustomerAssetsExcel(assets, req, res);
		} else {
			const assetsList = assets.map(asset => {
				const { id, lplate, axleProfile, createdAt, AccountId, details, plan } = asset.toJSON();
				return { id, lplate, axleProfile, createdAt, AccountId, plan, mf: details.axleProfile && details.axleProfile.mf || {} }
			});
			return res.send({ success: true, results: assetsList });
		}
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching assets', err);
	}
}

async function createCustomerAssetsExcel(resultSet, req, res) {
	const ROUTE = 'app/assets/createCustomerAssetsExcel';
	try {

		const cdnUrl = "https://cdn.ktt.io";
		var excelRows = [];
		for (const result of resultSet) {

			let rcImages = []; // some old values were not in array. temp fix until they are updated
			if (result.images && Array.isArray(result.images.rcImages)) {
				rcImages = result.images.rcImages;
			} else {
				rcImages = result.images.rcImages && result.images.rcImages.split(",") || [];
			}

			let mfMarkedAxels = "";
			let isMfMarked = "N";
			let mfMarkingDate = "";
			if (result.details && result.details.axleProfile && result.details.axleProfile.mf) {
				isMfMarked = result.details.axleProfile.mf.active && "Y" || "N";
				mfMarkingDate = result.details.axleProfile.mf.active && result.details.axleProfile.mf.initialDate && moment(result.details.axleProfile.mf.initialDate).format('YYYY-MM-DD') || "";
			}
			if (result.axleConfig && result.axleConfig.config) {
				let inActiveAxles = result.axleConfig.config.filter(x => x.active == false); //ignore in-active axle positions
				for (let inActiveAxle of inActiveAxles) {
					if (inActiveAxle.position) {
						inActAxleCount += inActiveAxle.position.length;
					}
				};

				let mfAxlesList = result.axleConfig.config.filter(axle => axle.mf && axle.mf.active);
				if (mfAxlesList && mfAxlesList.length) {
					mfMarkedAxels = mfAxlesList.map(axle => axle.name).join(", ") || "";
				}
			}

			excelRows.push({
				client: result.Account && result.Account.tname || 'N/A',
				vehicle: result.lplate,
				date: moment(result.createdAt).format('YYYY-MM-DD'),
				wheeler: result.details && result.details.axleProfile && result.details.axleProfile.wheeler,
				config: result.details && result.details.axleProfile && result.details.axleProfile.config,
				name: result.details && result.details.axleProfile && result.details.axleProfile.name,
				make: result.VehicleModel && result.VehicleModel.VehicleBrand && result.VehicleModel.VehicleBrand.brandName || 'N/A',
				model: result.VehicleModel && result.VehicleModel.modelName || 'N/A',
				rcImage1: rcImages[0] && (cdnUrl + rcImages[0]) || "N/A",
				rcImage2: rcImages[1] && (cdnUrl + rcImages[1]) || "N/A",
				isMfMarked: isMfMarked,
				mfMarkingDate: mfMarkingDate,
				mfMarkedAxels: mfMarkedAxels
			})
		}

		let columns = [
			{ header: 'Client', key: 'client', width: 25 },
			{ header: 'Vehicle', key: 'vehicle', width: 20 },
			{ header: 'Onboarded On', key: 'date', width: 20 },
			{ header: 'Wheeler', key: 'wheeler', width: 15 },
			{ header: 'Config', key: 'config', width: 15 },
			{ header: 'Name', key: 'name', width: 30 },
			{ header: 'Marked as MF', key: 'isMfMarked' },
			{ header: 'MF Marking Date', key: 'mfMarkingDate' },
			{ header: 'MF Marked Axles', key: 'mfMarkedAxels' },
			{ header: 'Make', key: 'make', width: 20 },
			{ header: 'Model', key: 'model', width: 30 },
			{ header: 'RC Image 1', key: 'rcImage1', width: 50 },
			{ header: 'RC Image 2', key: 'rcImage2', width: 50 }
		];

		let fileName = `Fleet_Vehicles_${excelRows[0] && excelRows[0].client || 'List'}`;

		return await avolveHelper.avolveExcelExport(fileName, columns, excelRows, req, res);

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error creating ApolloFleet Customer Assets Excel', err);
	}

}

exports.listAssets = async function (req, res) {
	const ROUTE = 'app/assets/listAssets';
	try {
		let dataReceived = {
			sessionData: res.locals,
			useragent: req.headers['user-agent'] && req.headers['user-agent'] || ""
		}

		logger.RaiseLogEvent(ROUTE, 'Received Data', dataReceived, 'Session and Useragent');

		let Account = await models.Account.findOne({
			attributes: ['id', 'type', 'AccountIdParent'],
			where: {
				id: res.locals.AccountId
			},
			raw : true
		});

		if ([10, 11].indexOf(Account.type) == -1) {
			return res.send({ success: false, error: 'Not authorized.' });
		}

		let assetWhere = {
			AccountId: Account.id,
			remove: false
		}

		let inspectionWhere = {
			AccountId: Account.id
		}

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			let accountIds = [];
			if (res.locals.role == "AMCS FTE") {
				let geozoneResult = await avolveHelper.fetchGeozones(res);
				if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
					res.GeozoneId = geozoneResult.geozones.map(x => x.id);
					let result = await avolveHelper.fetchCustomers(res);
					accountIds = result && result.customers.map(x => x.id) || [];
				}
				assetWhere.plan = 1; //AMCS
			} else {
				accountIds = res.locals.accountIds;
				assetWhere.plan = 2; //AMCC
			}
			if (!accountIds.length) {
				return res.send({ success: false, error: `Workshop or customer not mapped for this ${res.locals.role} user.` });
			}
			assetWhere.AccountId = { [Op.in]: accountIds };
			inspectionWhere.AccountId = { [Op.in]: accountIds };
		}

		if (['XE FTE', 'ARSA'].indexOf(res.locals.role) > -1) { //For xpert edge - customers based
			if (!req.query.AccountId) {
				return res.send({ success: false, error: `Please select customer to proceed.` });
			}
			assetWhere.AccountId = req.query.AccountId;
			inspectionWhere.AccountId = req.query.AccountId;
		}

		let assets = await models.Asset.findAll({
			attributes: ['AccountId', 'active', 'alarm', 'createdAt', 'dtype', 'id', 'lastDeviceAttribute', 'lplate', 'name',
				'odo', 'engineHrs', 'engineHrsT', 'fuel', 'fuel2', 'fuel3', 'share', 'type', 'updatedAt', 'av', 'note', 'address',
				'caddress', 'vType', 'ownerName', 'sensor', 'tags', 'ptype', 'group', 'oldgrossweight', 'grossweight', 'unladenweight',
				'axleProfile', 'axleConfig', 'mfgYear', 'serviceBasedOn', 'restriction', 'chassisNo', 'engineNo', 'fTankCapacity',
				'maxspeed', 'idle', 'maxspeedN', 'idleN', 'fTankCapacity2', 'mfgMonth', 'sCapacity', 'avgKM', 'avgHrs', 'pLocation',
				'cards', 'sensors', 'assetCode', 'sensorConfig', 'reportConfig', 'rtoLocation', 'lmTime', 'maxspeed', 'maxspeedN',
				'idle', 'idleN', 'onoff2N', 'alarmSettings', 'expMileage', 'expMileageUom', 'flags', 'eLock', 'details', 'plan'],
			include: [
				{
					attributes: ['id', 'type', 'variant'],
					model: models.VehicleType
				},
				{
					attributes: ['id', 'modelName'],
					model: models.VehicleModel,
					include: [
						{
							attributes: ['id', 'brandName'],
							model: models.VehicleBrand
						}
					]
				}
			],
			where: assetWhere,
			order: [['lplate', 'ASC']]
		});

		inspectionWhere.inspectionDate = moment().subtract(72, 'hours').toISOString();
		if (['AMCS FTE', 'AMCC FTE', 'XE FTE', 'ARSA'].indexOf(res.locals.role) > -1) { //For AMC FTE fetch only their assets
			inspectionWhere.AssetId = { [Op.in]: assets.map(x => x.id) };
		}

		var histSql = `
		select
    		distinct on (I."AssetId", I."type") I."AssetId", I."type", I."date", I."details"
		from
			"Inspections" I
			left join "Assets" A on I."AssetId" = A."id"
		where
    		I."AccountId" in (:AccountId) and
			I."date" >= (:inspectionDate)
		order by
    		I."AssetId", I."type", I."date" desc`;

		let inspectionHistories = await models.sequelize.query(histSql, {
			replacements: inspectionWhere,
			type: models.sequelize.QueryTypes.SELECT
		});

		let results = [];
		for (let i = 0; i < assets.length; i++) {
			let asset = JSON.parse(JSON.stringify(assets[i]));
			let inspections = inspectionHistories.filter(x => x.AssetId == asset.id);
			let lastInspectionDate = '';
			let pendingInspection = false;
			let vehicleIns = inspections.find(x => x.type == "vd" && moment(x.date).isSameOrAfter(moment().subtract(72, 'hours')));
			if (vehicleIns && moment().diff(moment(vehicleIns.date), 'hours') < 72) { //Inspection window 72hrs
				let tyreInspection = inspections.find(x => x.type == "t");
				if (tyreInspection && moment(tyreInspection.date).isBefore(moment(vehicleIns.date))) {
					tyreInspection = "";
				}
				if (!tyreInspection) {
					pendingInspection = true;
					lastInspectionDate = vehicleIns.date;
				}
			}
			asset.pendingInspection = pendingInspection;
			asset.lastInspectionDate = lastInspectionDate;
			results.push(asset);
		}

		return res.send({ success: true, results: results });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching assets', err);
	}
}

exports.listCount = async function (req, res) {
	const ROUTE = "api/assets/listCount";
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { //Apollo Fleet
			return res.send({ success: false, error: 'Not authorized!' });
		}

		let assetWhere = {
			AccountId: res.locals.AccountId,
			remove: false
		};
		if (req.query && req.query.AccountId) {
			assetWhere.AccountId = req.query.AccountId;
		}

		let AssetsCount = await models.Asset.count({ where: assetWhere });
		let result = { vehicleCount: AssetsCount };

		return res.send({ success: true, result: result });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching count', err);
	}
}

exports.listAxleConfigs = async function (req, res) {
	const ROUTE = 'app/assets/listAxleConfigs';
	try {
		let Account = await models.Account.findOne({
			attributes: ['id', 'type'],
			where: {
				id: res.locals.AccountId,
				type: [10, 11]
			},
			raw : true
		});

		if (!Account) {
			return res.send({ success: false, error: 'Not authorized!' });
		}

		return res.send({ success: true, axleConfigs: axleConfigAvolve });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching axle configs', error);
	}
}

exports.listAxleProfiles = async function (req, res) {
	const ROUTE = 'app/assets/listAxleProfiles';
	try {
		let Account = await models.Account.findOne({
			attributes: ['id', 'type'],
			where: {
				id: res.locals.AccountId,
				type: [10, 11]
			},
			raw: true
		});

		if (!Account) {
			return res.send({ success: false, error: 'Not authorized!' });
		}

		let axleProfiles = [];
		for (var key in axleConfigAvolve) {
			axleProfiles.push({
				id: key,
				text: key
			});
		}

		return res.send({ success: true, results: axleProfiles });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching axle profiles', err);
	}
}

function getPartialEmail(email) {
	let parts = email.split('@');
	let username = parts[0];
	let domain = parts[1];

	let firstTwo = username.substring(0, 2);
	let lastTwo = username.substring(username.length - 2);
	let middlePart = "x".repeat(username.length - 4);

	let formattedEmail = firstTwo + middlePart + lastTwo + "@" + domain;

	return formattedEmail;
}

function getOfferName(plan) {
	let planName = '';
	switch (plan) {
		case 1:
			planName = 'AMC Shared';
			break;
		case 2:
			planName = 'AMC Captive';
			break;
		case 3:
			planName = 'Digital Edge';
			break;
		case 4:
			planName = 'Xpert Edge';
			break;
		default:
			break;
	}
	return planName;
}