const moment = require('moment');
const models = require('../../../models');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { getAccountIdByRole, serviceStatusLookUp, getKamListByCustomers } = require('../../../lib/helpers/avolveHelper');
const { Op } = require("sequelize");
const axleConfigAvolve = require('../../../config/axleConfig-apollo.json');
const { handleApiError } = require('../../middlewares/helper');

exports.listSelect = async function (req, res) {
	try {
		const whereClause = {
			AccountId: res.locals.AccountId,
			active: true,
			remove: false
		};

		if (req.query.AccountId) {
			whereClause.AccountId = req.query.AccountId;
		}

		const fieldsParam = (req.query.fields || 'id').toString();
		const fields = fieldsParam.split(',').map(f => f.trim()).filter(Boolean);
		const attributes = Array.from(new Set(['id', ...fields]));

		let AssetInclude = [{
			attributes: ['tname', 'name'],
			model: models.Account,
			where: {
				'details.avolve': true
			},
			required: true
		}];
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
			const index = attributes.indexOf('vehicleType');
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
			raw: true
		});

		return res.send({ success: true, results: Assets });
	} catch (error) {
		console.log(`Error in assets/listSelect`, error);
		RaiseLogEvent('assets/listSelect', 'error', error, 'Error fetching assets');
		return res.send({ success: false, error: "Error in fetching assets!" });
	}
}

exports.getSelect = async function (req, res) {
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing input parameter' });
		}

		const fieldsParam = (req.query.fields || 'id').toString();
		const fields = fieldsParam.split(',').map(f => f.trim()).filter(Boolean);
		let attributes = Array.from(new Set(['id', ...fields]));

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
			const index = attributes.indexOf('vehicleType');
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

		if (req.query.detailed && req.query.detailed == 'true') {
			attributes = ['id', 'lplate', 'odo', 'imei', 'chassisNo', 'engineNo', 'mfgMonth', 'mfgYear', 'details', 'axleProfile', 'unladenweight', 'oldgrossweight', 'grossweight', 'fTankCapacity', 'fTankCapacity2', 'note', 'ownerName', 'address', 'axleConfig', 'AccountId']
		}
		if (Object.keys(vehicleTypeFilter).length) {
			AssetInclude = [vehicleTypeFilter];
		}

		if (req.query.vehicleModel && req.query.vehicleModel == 'true') {
			AssetInclude.push({
				attributes: ['id', 'modelName'],
				model: models.VehicleModel,
				include: [{
					attributes: ['id', 'brandName'],
					model: models.VehicleBrand
				}]
			});
		}

		if (req.query.tyres && req.query.tyres == 'true') {
			AssetInclude.push({
				attributes: ['id', 'tyreNo', 'lastStatus', 'mfgBy', 'model', 'codeSize', 'installedOn', 'tpmsId', 'rfid', 'condition', 'radial', 'tyreStatus', 'initialTreadDepth', 'cpkm'],
				model: models.Tyre,
				separate: true
			});
		}

		const Asset = await models.Asset.findOne({
			attributes: [...attributes],
			include: AssetInclude,
			where: { id: req.params.id },
		});

		return res.send({ success: true, result: Asset });
	} catch (error) {
		console.log(`Error in assets/listSelect`, error);
		RaiseLogEvent('assets/listSelect', 'error', error, 'Error fetching assets');
		return res.send({ success: false, error: "Error in fetching assets!" });
	}
}

async function resolveAccountIds(locals, query) {
	if (locals.role === 'Admin') return null;
	return await getAccountIdByRole(locals, query, true) || [];
}

function buildWhereClause(accountIds, query, locals) {
	const where = {}, includes = [{
		model: models.Inspection,
		attributes: [],
		where: { type: 'v' },
		required: false
	}];

	if (accountIds != null) {
		where.AccountId = { [Op.in]: accountIds };
	}
	if (query.AccountId) {
		const ids = Array.isArray(query.AccountId) ? query.AccountId : [query.AccountId];
		where.AccountId = { [Op.in]: ids.map(Number) };
	}
	if (query.plan) {
		where.plan = Number(query.plan);
	}

	let accountInclude = {
		model: models.Account,
		attributes: ['id', 'tname', 'name'],
		where: { status: 1, AccountIdParent: locals.masterAccountId }
	};
	if (query.customerStatus == 'inactive') {
		accountInclude.where.status = 0;
	} else {
		accountInclude.where.status = 1;
	}
	includes.push(accountInclude);

	if (query.mfTyres) {
		where['details.axleProfile.mf.active'] = query.mfTyres === 'true';
	}
	if (query.removed !== undefined) {
		where.remove = query.removed === 'true';
	}
	if (query.sdate && query.edate) {
		where.createdAt = {
			[Op.between]: [new Date(query.sdate), new Date(query.edate)]
		};
	}
	if (query.search?.value) {
		where.lplate = { [Op.iLike]: `%${query.search.value}%` };
	}

	return { where, includes };
}

exports.list = async (req, res) => {
	try {
		const accountIds = await resolveAccountIds(res.locals, req.query);
		const { where, includes } = buildWhereClause(accountIds, req.query, res.locals);

		const draw = parseInt(req.query.draw, 10) || 1;
		const start = parseInt(req.query.start, 10) || 0;
		const length = parseInt(req.query.length, 10) || 10;

		// Run queries in PARALLEL
		const [total, assets] = await Promise.all([
			models.Asset.count({ where }),
			models.Asset.findAll({
				attributes: ['id', 'lplate', 'axleProfile', 'details',
					[models.sequelize.fn('MAX', models.sequelize.col('Inspections.date')), 'latestInspectionDate'],
					[models.sequelize.fn('COUNT', models.sequelize.col('Inspections.id')), 'inspectionCount'],
				],
				where,
				include: includes,
				group: ['Asset.id', 'Account.id'],
				limit: length === -1 ? undefined : length,
				offset: length === -1 ? 0 : start,
				subQuery: false
			}),
		]);

		const results = assets.map(a => {
			const axleProfile = (a.details?.axleProfile) || {};
			const mf = axleProfile.mf || {};
			return {
				id: a.id,
				lplate: a.lplate || '—',
				wheeler: axleProfile.wheeler || a.axleProfile || '—',
				config: axleProfile.config || '—',
				name: axleProfile.name || '—',
				Account: a.Account || {},
				mfMarked: mf.active === true,
			};
		});

		return res.json({
			success: true,
			draw,
			recordsTotal: total,
			recordsFiltered: total,
			results
		});

	} catch (error) {
		return handleApiError(res, ROUTE, "Error fetching assets", error);
	}
}

exports.count = async (req, res) => {
	try {
		return res.send({
			success: true,
			result: {
				vehiclesSigned: 0,
				vehiclesOnboarded: 0,
				vehiclesAllTyres: 0,
				iotEnabled: 0,
				mfMarked: 0,
				odoNotOperational: 0,
				mechanicalDefect: 0,
			}
		});
		const accountIds = await resolveAccountIds(res.locals, req.query);
		const base = buildWhereClause(accountIds, req.query, res.locals);

		// Run all counts in parallel
		const [
			vehiclesSigned,
			vehiclesOnboarded,
			vehiclesAllTyres,
			iotEnabled,
			mfMarked,
			odoNotOperational,
			mechanicalDefect,
		] = await Promise.all([
			// Vehicles Signed — all non-removed assets in scope
			models.Asset.count({
				where: { ...base, remove: false }
			}),

			// Vehicles Onboarded — active assets
			models.Asset.count({
				where: { ...base, remove: false, active: true }
			}),

			// Vehicles with all Tyres — details.allTyresOnb = true
			models.Asset.count({
				where: {
					...base,
					remove: false,
					'details.allTyresOnb': true,
				}
			}),

			// IOT Enabled — has a non-null imei
			models.Asset.count({
				where: {
					...base,
					remove: false
				}
			}),

			// MF Marked — details.axleProfile.mf.active = true
			models.Asset.count({
				where: {
					...base,
					remove: false,
					'details.axleProfile.mf.active': true,
				}
			}),

			// Odo Not Operational — odo = 0 and active
			models.Asset.count({
				where: {
					...base,
					remove: false,
					active: true,
					odo: 0,
				}
			}),

			// Mechanical Defect — placeholder: assets with alarm = true
			// Replace with your actual mechanic defect flag
			models.Asset.count({
				where: {
					...base,
					remove: false,
					alarm: true,
				}
			}),
		]);

		return res.send({
			success: true,
			result: {
				vehiclesSigned,
				vehiclesOnboarded,
				vehiclesAllTyres,
				iotEnabled,
				mfMarked,
				odoNotOperational,
				mechanicalDefect,
			}
		});
	} catch (error) {
		console.error('Error in assets/countWeb', error);
		RaiseLogEvent('assets/countWeb', 'error', error, 'Error fetching asset counts');
		return res.send({ success: false, error: 'Error fetching asset counts' });
	}
};

exports.getAxleConfigs = async function (req, res) {
	const ROUTE = 'web/assets/getAxleConfigs';
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

		return res.send({ success: true, axleConfig: axleConfigAvolve });
	} catch (error) {
		console.log(`Error in ${ROUTE} :`, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching axle config.');
		return res.send({ success: false, error: 'Error fetching axle config.' });
	}
}


exports.getAxleProfiles = async function (req, res) {
	const ROUTE = 'web/assets/getAxleProfiles';
	try {
		let Account = await models.Account.findOne({
			attributes: ['id', 'type'],
			where: {
				id: res.locals.AccountId,
				type: [10, 11]
			}
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
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, `Error fetching axle profile.`);
		return res.send({ success: false, error: 'Error fetching axle profile.' });
	}
}

exports.payKmList = async function (req, res) {
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
				model: models.Tyre,
				required: false
			}],
			where: assetWhere
		});

		let AssetServices = await models.AssetService.findAll({
			attributes: ['id', 'createdAt', 'status', 'AssetId', 'AccountId'],
			where: {
				AssetId: { [Op.in]: Assets.map(x => x.id) },
				status: { [Op.notIn]: [12, 13] } // closed, Invalid request
			},
			raw: true
		});

		let kamResults = await getKamListByCustomers(accountIds, res.locals.masterAccountId);
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
				mdgId: account?.name.split('_')[0] || '',
				offer: AplOffer && AplOffer.offerType || '',
				subOffer: AplOffer && AplOffer.subOfferType || '',
				AssetId: Asset.id,
				lplate: Asset.lplate || '',
				imeiNo: Asset.imei || '',
				satellite: satellite || '',
				gsm: gsm || '',
				batteryVoltage: updatedBatteryVoltage || '',
				wheeler: axleProfile?.wheeler || '',
				config: axleProfile?.config || '',
				name: axleProfile?.name || '',
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
					status: serviceStatusLookUp(matchedServices[0].status),
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
		return handleApiError(res, ROUTE, 'Error fetching vehicles', err);
	}
}
exports.listPaykmVehicles = async function (req, res) {
	const ROUTE = 'app/assets/listPaykmVehicles';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { // Avolve
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		let accountWhere = {
			type: 11, // Avolve Customers
			AccountIdParent: res.locals.masterAccountId,
			status: 1,
			'details.payKm': true
		}

		if (req.query.accountId) {
			accountWhere.id = req.query.accountId;
		}

		let Assets = await models.Asset.findAll({
			include: [{
				attributes: ['id', 'tname', 'name'],
				model: models.Account,
				where: accountWhere
			},
			{
				model: models.VehicleType
			}]
		});

		return res.send({ success: true, results: Assets });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching list paykm vehicles', error);
	}
}