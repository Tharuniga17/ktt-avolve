const path = require('path');
const xlsx = require('xlsx');
const moment = require('moment');
const exceljs = require("exceljs");
const { Op } = require("sequelize");
const workbook = new exceljs.Workbook();
const models = require("../../../models");

const redisHelper = require('../../../lib/helpers/redis');
const avolveHelper = require('../../../lib/helpers/avolveHelper');
const { events } = require('../../../lib/event');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { getMasterAccIdByRegion } = require('../../../lib/helpers/region');
const { handleApiError } = require('../../middlewares/helper');

const regionsConfig = require('../../../config/region.json');
const axleConfig = require('../../../config/axleConfig-apollo.json');
const serviceTypes = require('../../../config/serviceType-apollo.json');

exports.list = async function (req, res) {
	const ROUTE = 'web/accounts/list';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) {
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		let accountWhere = {
			type: 11,
			AccountIdParent: res.locals.masterAccountId,
			status: 1
		};

		if (req.query.inactive && req.query.inactive == 'true') {
			accountWhere.status = { [Op.in]: [0, 1] }; //0-InActive 1-Active
		}

		if (req.query.sdate && req.query.edate) {
			accountWhere.createdAt = { [Op.between]: [moment(req.query.sdate).toISOString(), moment(req.query.sedate).toISOString()] };
		}

		if (req.query.avolve) {
			if (req.query.avolve == 'true') {
				accountWhere['details.avolve'] = true;
			} else if (req.query.avolve == 'false') {
				accountWhere['details.avolve'] = false;
			}
		}

		let accountInclude = [];
		if (req.query.payKm && req.query.payKm == 'true') {
			accountWhere['details.payKm'] = true;
			accountInclude = [{
				attributes: ['id', 'firstName', 'lastName', 'mobile'],
				model: models.User,
				include: [{
					attributes: [],
					model: models.UserRole,
					where: {
						name: 'FM'
					}
				}],
				where: {
					activeStatus: true
				},
				required: false
			}];
		}

		let accountAttributes = [];
		if (req.query?.offer == 'true') {
			accountInclude.push({
				attributes: ['id', 'details', 'offerType', 'subOfferType', 'startDate', 'endDate', 'plan', 'slab'],
				model: models.AplOffer
			});
			accountAttributes = ['serviceConfig', 'details', 'status', 'createdAt', 'baddress', 'oname'];
		}

		if (["Admin", "FTS Admin"].indexOf(res.locals.role) == -1) {
			accountWhere.id = res.locals?.accountIds?.length ? res.locals.accountIds : [];
		}

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'name', 'tname', 'phone1', 'email1', ...accountAttributes],
			include: accountInclude,
			where: accountWhere,
			order: [['tname', 'asc']],
			raw : true
		});

		return res.send({ success: true, results: Accounts });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching data', err);
	}
}

exports.regions = async function (req, res) {
	const ROUTE = 'web/accounts/regions';
	try {
		let results = [];
		for (const region in regionsConfig) {
			if (!Object.hasOwn(regionsConfig, region)) continue;
			results.push({
				code: region,
				...regionsConfig[region]
			});
		}
		return res.send({ success: true, results });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching regions', error);
	}
}

exports.region = async function (req, res) {
	const ROUTE = 'web/accounts/region';
	try {
		return res.send({ success: true, result: { ...regionsConfig[req.query.region || res.locals.region], masterAccountId: getMasterAccIdByRegion(req.get('X-AVL-Region')) } });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching region', error);
	}
}

exports.getOffer = async function (req, res) {
	const ROUTE = 'web/accounts/getOffer';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: `Missing input parameter` });
		}

		let Account = await redisHelper.getAccount(req.params.id);
		if (!Account) {
			return res.send({ success: false, error: 'Account not found' });
		}

		let AplOffer = await models.AplOffer.findOne({
			attributes: ['id', 'status', 'details', 'startDate', 'endDate', 'plan', 'slab'],
			where: {
				AccountId: req.params.id
			},
			order: [['createdAt', 'DESC']],
			raw: true
		});

		if (!AplOffer) {
			return res.send({ success: false, error: `Offer not found for this customer` });
		}

		if (!AplOffer.details) {
			return res.send({ success: false, error: `Offer details not found for this customer` });
		}

		let Assets = await models.Asset.findAll({
			attributes: [[models.sequelize.literal(`"details"->'axleProfile'`), 'axleProfile']],
			where: {
				AccountId: req.params.id,
				active: true,
				remove: false
			},
			raw: true
		});

		const getConfigKey = (axleProfile = {}) => {
			if (!axleProfile.wheeler || !axleProfile.config || !axleProfile.name) {
				return 'unknown';
			}
			return `${axleProfile.wheeler.toLowerCase().replace(/\s+/g, '')}@` +
				`${axleProfile.config.toLowerCase().replace(/\*/g, 'x').replace(/\s+/g, '')}@` +
				`${axleProfile.name.toLowerCase().replace(/\*/g, 'x').replace(/\s+/g, '')}`;
		};
		const AssetCountMap = new Map();
		for (const asset of Assets) {
			const key = getConfigKey(asset.axleProfile || {});
			AssetCountMap.set(key, (AssetCountMap.get(key) || 0) + 1);
		}

		let details = AplOffer.details;
		let status = AplOffer.status;
		const offerStartDate = AplOffer.startDate && moment(AplOffer.startDate).startOf('day') || '';
		const offerEndDate = AplOffer.endDate && moment(AplOffer.endDate).endOf('day') || '';
		if (offerStartDate && offerEndDate) {
			if (Account.status == 1 && (offerStartDate > moment() || offerEndDate < moment())) {
				status = 'Expired';
			}
		}

		let { slab, channel } = avolveHelper.avolveOfferLookUp(AplOffer) || {};
		let vehicleGroups = details && ((details.operations && details.operations.vehicleGroups) || details.vehicleGroups) || [];

		let totalOnbVehicles = 0;
		for (const vehicleGroup of vehicleGroups) {
			let groupKey = getConfigKey(vehicleGroup);
			let vehicleCount = AssetCountMap.get(groupKey);
			vehicleGroup.onbVehCount = vehicleCount || '';
			totalOnbVehicles += vehicleCount || 0;
		}
		let result = {
			id: AplOffer.id,
			offerType: details.offerType,
			subOffer: details.subOfferType || "",
			totalVehicles: details.vehicles && Number(details.vehicles) || 0,
			vehicleGroups: vehicleGroups,
			startDate: AplOffer.startDate && moment(AplOffer.startDate).toISOString() || "", // format it to Do MMM YYYY
			endDate: AplOffer.endDate && moment(AplOffer.endDate).toISOString() || "", // format it to Do MMM YYYY
			status: status || '',
			channel: channel || null,
			slab: slab || null,
			totalOnbVehicles: totalOnbVehicles
		};

		return res.send({ success: true, result: result });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching customer offer', err);
	}
}

exports.offerList = async function (req, res) {
	const ROUTE = 'web/accounts/offerList';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) {
			return res.send({ success: false, error: 'Not authorized to this API' });
		}
		let accountWhere = {
			type: 11,
			AccountIdParent: res.locals.AccountId,
			status: 1
		};

		if (req.query.avolve) {
			if (req.query.avolve == 'true') {
				accountWhere['details.avolve'] = true;
			} else if (req.query.avolve == 'false') {
				accountWhere['details.avolve'] = false;
			}
		}

		if (req.query.testAcc) {
			if (req.query.testAcc == 'true') {
				accountWhere['details.testAcc'] = { [Op.ne]: true };
			} else if (req.query.testAcc == 'false') {
				accountWhere[Op.or] = [{ ['details.testAcc']: null }, { ['details.testAcc']: false }];
			}
		}

		if (req.query.inactive && req.query.inactive == 'true') {
			accountWhere.status = [0, 1]; //both active & inactive customer
		}

		if (req.query.AccountIds && req.query.AccountIds.length) {
			accountWhere.id = req.query.AccountIds && JSON.parse(req.query.AccountIds);
		}

		if (req.query.sdate && req.query.edate) {
			accountWhere.createdAt = { $between: [moment(req.query.sdate).format('YYYY-MM-DDT[00:00:00]Z'), moment(req.query.edate).format('YYYY-MM-DDT[23:59:59]Z')] };
			delete accountWhere.id;
		}

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'name', 'tname', 'serviceConfig', 'details', 'status', 'createdAt', 'baddress'],
			include: [{
				attributes: ['id', 'details', 'offerType', 'subOfferType', 'startDate', 'endDate', 'plan', 'slab', 'offerId', 'status'],
				model: models.AplOffer
			}],
			where: accountWhere,
			order: [[models.AplOffer, 'id', 'DESC']]
		});

		let AccountOfferDetails = [];
		Accounts = JSON.parse(JSON.stringify(Accounts));
		for (let Account of Accounts) {
			let AplOffer = Account?.AplOffers?.[0] || {};
			let { slab, channel } = avolveHelper.avolveOfferLookUp(AplOffer);
			let { axleConfig, serviceMasterUpdatedBy } = Account.serviceConfig;
			let { psiConfig, psiMasterUpdatedBy } = Account.details;
			let serviceMaster = {
				active: (axleConfig && axleConfig.length) ? "Yes" : "No",
				updatedBy: { username: serviceMasterUpdatedBy?.username || '', date: serviceMasterUpdatedBy?.date || '' }
			}
			let ipMaster = {
				active: (psiConfig && psiConfig.length) ? "Yes" : "No",
				updatedBy: { username: psiMasterUpdatedBy?.username || '', date: psiMasterUpdatedBy?.date || '' }
			}

			let status = AplOffer.status || '';
			let accStatus = Account.status == 1 ? 'Active' : 'Inactive';
			const offerStartDate = AplOffer.startDate && moment(AplOffer.startDate).startOf('day') || '';
			const offerEndDate = AplOffer.endDate && moment(AplOffer.endDate).endOf('day') || '';
			if (offerStartDate && offerEndDate) {
				if (Account.status == 1 && (offerStartDate > moment() || offerEndDate < moment())) {
					accStatus = 'Expired';
				}
			}

			let offer = {
				id: Account.id,
				tname: Account.tname,
				mgdId: Account.name,
				createdAt: Account.createdAt && moment(Account.createdAt).toISOString() || '', // DD/MM/YYYY
				baddress: Account.baddress || '',
				offerName: AplOffer.offerType || '',
				subOfferName: AplOffer.subOfferType || '',
				vehSigned: AplOffer.details?.vehicles || '',
				slab, channel,
				opportunity: AplOffer.offerId || '',
				billing: Account.serviceConfig?.billingType || '',
				status: status || '',
				startDate: moment(AplOffer.startDate || '').toISOString(),
				endDate: moment(AplOffer.endDate || '').toISOString(),
				serviceMaster: serviceMaster,
				ipMaster: ipMaster,
				accStatus: accStatus
			}
			AccountOfferDetails.push(offer);
		}

		return res.send({ success: true, results: AccountOfferDetails });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching offer list', err);
	}
}

exports.getOfferConfig = async function (req, res) {
	const ROUTE = 'web/accounts/getOfferConfig';
	try {
		if (!['Admin', 'FTS Admin', 'KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not authorized' });
		}

		let SystemConfig = await models.SystemConfig.findOne({
			attributes: ['id', 'data'],
			where: {
				AccountId: res.locals.masterAccountId,
				module: 'Avolve',
				name: 'Offer Masters'
			},
			raw: true
		});

		let result = {};
		if (SystemConfig && SystemConfig.data && Object.keys(SystemConfig.data).length) {
			result = SystemConfig.data || {};
		}

		return res.send({ success: true, result: result });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching config', err);
	}
}

exports.offerUpdate = async (req, res) => {
	const ROUTE = 'web/accounts/offerUpdate';
	try {
		RaiseLogEvent(ROUTE, 'input', req.body, `Offer update request by ${res.locals.username}`);
		if (!req.params.id || !req.body.AccountId) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let AplOffer = await models.AplOffer.findOne({
			attributes: ['id', 'details', 'AccountId', 'plan', 'slab'],
			where: {
				id: req.params.id,
				AccountId: req.body.AccountId
			},
			order: [['createdAt', 'desc']],
			raw : true
		});

		if (!AplOffer) {
			return res.send({ success: false, error: "Offer not found" });
		}

		let SystemConfig = await models.SystemConfig.findOne({
			attributes: ['id', 'data'],
			where: {
				AccountId: res.locals.masterAccountId,
				module: 'Avolve',
				name: 'Offer Masters'
			},
			raw: true
		});

		if (!SystemConfig) {
			return res.send({ success: false, error: 'System config not found.' });
		}

		let { segments = [], applications = [] } = SystemConfig.data || {};
		if (AplOffer.plan == 1 && !req.body.slab) {
			return res.send({ success: false, error: "Offer Slab not found" });
		}

		let Assets = await models.Asset.findAll({
			attributes: [[models.sequelize.literal(`"details"->'axleProfile'`), 'axleProfile']],
			where: {
				AccountId: AplOffer.AccountId
			},
			raw: true
		});

		if (Assets.length > req.body.vehicles) {
			return res.send({ success: false, error: `Vehicle signed count(${req.body.vehicles}) cannot be less the total vehicle onboarded count (${Assets.length})` });
		}

		if (AplOffer.plan == 1 && !req.body.slab) {
			return res.send({ success: false, error: "Slab is mandatory, if the customer is plan is TIS" });
		}

		const getConfigKey = (axleProfile = {}) => {
			if (!axleProfile.wheeler || !axleProfile.config || !axleProfile.name) {
				return 'unknown';
			}
			return `${axleProfile.wheeler.toLowerCase().replace(/\s+/g, '')}@` +
				`${axleProfile.config.toLowerCase().replace(/\*/g, 'x').replace(/\s+/g, '')}@` +
				`${axleProfile.name.toLowerCase().replace(/\*/g, 'x').replace(/\s+/g, '')}`;
		};

		const AssetCountMap = new Map();
		for (const asset of Assets) {
			const key = getConfigKey(asset.axleProfile || {});
			AssetCountMap.set(key, (AssetCountMap.get(key) || 0) + 1);
		}
		const onboardedConfigKeys = new Set(AssetCountMap.keys());

		let existingDetails = AplOffer.details || {};
		if (typeof existingDetails === 'string') {
			existingDetails = JSON.parse(existingDetails);
		}
		if (!existingDetails.operations) {
			existingDetails.operations = {};
		}
		let masterVehGroups = existingDetails.operations.vehicleGroups
			|| existingDetails.vehicleGroups
			|| [];

		if (!Array.isArray(masterVehGroups)) {
			masterVehGroups = [];
		}

		const updatedConfigMap = new Map();
		let hasLiftAxleGroup = false;
		for (const vehGroup of req.body.vehicleGroups) {
			if (!vehGroup.name || !vehGroup.config || !vehGroup.wheeler || !vehGroup.vehicles || !vehGroup.segment || !vehGroup.application || !vehGroup.payload) {
				return res.send({ success: false, error: "Wheeler, Config, Name, segment, application, payload and Vehicles fields are mandatory for vehicle groups" });
			}
			if (/\blift\b/i.test(vehGroup.name)) {
				hasLiftAxleGroup = true;
			}
			const key = getConfigKey(vehGroup || {});
			updatedConfigMap.set(key, Number(vehGroup.vehicles) || 0);
		}
		const updatedConfigKeys = new Set(updatedConfigMap.keys());

		if (AplOffer.plan == 1 && res.locals.role != 'Admin') { // Tis plan		
			let matchedSlabData = SystemConfig && SystemConfig.data && SystemConfig.data.slabs && SystemConfig.data.slabs.find(x => x.id == Number(req.body.slab)) || {};
			let tyresInOffer = matchedSlabData && matchedSlabData.offerTyreCount || null;
			if (hasLiftAxleGroup) {
				tyresInOffer += 100; // Additional tyres for lift axle
			}
			if (!tyresInOffer) {
				return res.send({ success: false, error: `Tyres in offer data not found for the selected slab` });
			}
			if (!req.body.tyresInOffer) {
				return res.send({ success: false, error: `Total tyres in offer is mandatory for TIS plan customers` });
			}
			if (Number(req.body.tyresInOffer) > Number(tyresInOffer)) {
				return res.send({ success: false, error: `Total tyres in offer (${req.body.tyresInOffer}) cannot be more than the allowed tyres in slab` });
			}
		}

		for (const onboardedKey of onboardedConfigKeys) {
			let vehicleCount = AssetCountMap.get(onboardedKey);
			if (onboardedKey == 'unknown') continue;
			if (!updatedConfigKeys.has(onboardedKey)) {
				let config = onboardedKey.split('@').map(x => x);
				return res.send({
					success: false,
					error: `(${vehicleCount}) vehicles are already onboarded with ${config[0].toUpperCase()} - ${config[1].toUpperCase()} - ${config[2].toUpperCase()} configuration. Kindly retain this configuration to proceed.`
				});
			}
		}

		const masterMap = new Map();
		for (const g of masterVehGroups) {
			masterMap.set(getConfigKey(g), g);
		}
		const finalVehGroups = [];

		for (const vehGroup of req.body.vehicleGroups) {
			if (!vehGroup.name || !vehGroup.config || !vehGroup.wheeler || !vehGroup.vehicles) {
				return res.send({
					success: false,
					error: "Wheeler, Config, Name and Vehicles fields are mandatory for vehicle groups"
				});
			}

			const key = getConfigKey(vehGroup);
			const onboardedCount = AssetCountMap.get(key) || 0;
			const updatedCount = Number(vehGroup.vehicles) || 0;

			if (updatedCount < onboardedCount) {
				return res.send({
					success: false,
					error: `Specified vehicle count (${updatedCount}) cannot be less than the number of vehicles already onboarded (${onboardedCount}) for the configuration ${vehGroup.wheeler} - ${vehGroup.config} - ${vehGroup.name}.`
				});
			}

			const matchedGroup = masterMap.get(key) || {};

			const application = applications.find(x => x.id == vehGroup.application) || {};
			const segment = segments.find(x => x.id == vehGroup.segment) || {};

			finalVehGroups.push({
				...matchedGroup,
				...vehGroup,
				application: application.text || '',
				segment: segment.text || '',
				vehicles: updatedCount
			});
		}

		if (existingDetails.operations.vehicleGroups) {
			existingDetails.operations.vehicleGroups = finalVehGroups;
		} else if (existingDetails.vehicleGroups) {
			existingDetails.vehicleGroups = finalVehGroups;
		}

		if (existingDetails && existingDetails.vehicles) {
			existingDetails.vehicles = Number(req.body.vehicles);
			existingDetails.operations.vehicles = Number(req.body.vehicles);
		}

		let toUpdate = { details: existingDetails };
		if (AplOffer.plan == 1 && Number(AplOffer.slab) != Number(req.body.slab)) {
			toUpdate.slab = Number(req.body.slab)
		}
		if (AplOffer.plan == 1) {
			if ([1, 2].includes(Number(req.body.slab))) {
				toUpdate.subOfferType = 'Shared';
			} else {
				toUpdate.subOfferType = 'Captive';
			}
		}

		AplOffer.set(toUpdate);
		AplOffer.changed('details', true);
		await AplOffer.save();
		return res.send({ success: true });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in updating offer', err);
	}
}

exports.syncServiceMaster = async function (req, res) {
	const ROUTE = 'web/accounts/syncServiceMaster';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { //Apollo Fleet
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		RaiseLogEvent(ROUTE, 'Request', { AccountId: req.params.id }, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		if (!req.params.id) {
			return res.send({ success: false, error: 'Account Id missing' });
		}

		let Assets = await models.Asset.findAll({
			attributes: ['id', 'lplate', 'AccountId'],
			where: {
				remove: false,
				active: true,
				AccountId: req.params.id
			},
			raw: true
		});

		if (!Assets.length) {
			return res.send({ success: false, error: 'Vehicles not found for this account' });
		}

		for (const Asset of Assets) {
			let data = {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			}
			evt.events.emit('apl-vehicle-service-schedule-update', data);
			evt.events.emit('apl-asset-service-master-update', data);
		}
		return res.send({ success: true, message: 'Service Master Refresh Batch Process is initiated. Please check after few mins.' });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in syncing service master', err);
	}
}

exports.syncIPMaster = async function (req, res) {
	const ROUTE = 'web/accounts/syncIPMaster';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { //Apollo Fleet
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		RaiseLogEvent(ROUTE, 'Request', { AccountId: req.params.id }, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		if (!req.params.id) {
			return res.send({ success: false, error: 'Account Id missing' });
		}

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'tyreNo', 'AssetId', 'AccountId', 'lastStatus'],
			where: {
				AccountId: req.params.id,
				AssetId: { [Op.ne]: null }
			},
			raw: true
		});

		if (!Tyres.length) {
			return res.send({ success: false, error: 'Tyres not found for this account' });
		}

		let TyreHistories = await models.TyreHistory.findAll({
			attributes: ['id', 'tyreNo', 'AssetId', 'AccountId'],
			where: {
				AccountId: req.params.id,
				AssetId: { [Op.ne]: null }
			},
			raw: true
		});

		let Inspections = await models.Inspection.findAll({
			attributes: ['id', 'date', 'details', 'AccountId', 'AssetId'],
			where: {
				type: 't',
				AccountId: req.params.id
			},
			raw: true
		});

		for (const TyreHistory of TyreHistories) {
			evt.events.emit('apollo-tyreHist-recom-psi-update', {
				tyreNo: TyreHistory.tyreNo,
				AssetId: TyreHistory.AssetId,
				TyreHistoryId: TyreHistory.id,
				AccountId: TyreHistory.AccountId
			});
		}

		for (const Tyre of Tyres) {
			evt.events.emit('apollo-tyre-recom-psi-update', {
				tyreNo: Tyre.tyreNo,
				AssetId: Tyre.AssetId,
				AccountId: Tyre.AccountId
			});
		}

		for (const Inspection of Inspections) {
			evt.events.emit('apollo-inspectHist-recom-psi-update', {
				id: Inspection.id,
				AssetId: Inspection.AssetId,
				AccountId: Inspection.AccountId
			});
		}
		return res.send({ success: true, message: 'IP Master Refresh Batch Process is initiated. Please check after few mins.' })
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in syncing IP master', err);
	}
}

exports.getAccMasterDetails = async function (req, res) {
	const ROUTE = 'web/accounts/getAccMasterDetails';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) {
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: 'Account Id missing' });
		}

		let Account = await models.Account.findOne({
			attributes: ['id', 'tname', 'name', 'details', 'serviceConfig'],
			where: {
				type: 11,
				AccountIdParent: res.locals.AccountId,
				status: 1,
				id: req.params.id
			},
			raw: true
		});

		if (!Account) {
			return res.send({ success: false, error: "Account not found.", message: "Account not found." });
		}

		var vehicleServiceTypes = await models.VehicleServiceType.findAll({
			attributes: ['id', 'serviceName'],
			where: {
				serviceName: ['IP Check & Correction', 'Tyre & Vehicle Inspection', 'Tyre Rotation On Rim', 'Wheel Alignment', 'Wheel Rotation', 'Onboarding Service', 'Additional Service', 'Tyre Fitment', 'Tyre Onboarding'],
				AccountId: req.params.id
			},
			raw: true
		});

		let results = [];
		if (req.query.master == 'service') {
			let serviceConfigs = Account.serviceConfig.axleConfig;
			if (serviceConfigs) {
				for (let serviceConfig of serviceConfigs) {
					let offer = {};
					offer.name = serviceConfig.name;
					offer.wheeler = serviceConfig.wheeler;
					offer.config = serviceConfig.config;
					for (let schedule of serviceConfig.schedules) {
						let VehicleService = vehicleServiceTypes.find(x => x.id == schedule.VehicleServiceTypeId) || ''
						schedule.serviceName = VehicleService && VehicleService.serviceName || '';
						let aplService = serviceConfig.aplServices && serviceConfig.aplServices.length && serviceConfig.aplServices.find(x => x.ServiceTypeId == schedule.VehicleServiceTypeId) || '';
						schedule.count = aplService && aplService.alloted;
						results.push({ ...offer, ...schedule });
					}
					for (let aplservice of serviceConfig.aplServices) {
						if (aplservice.sNo === '1' || aplservice.sNo === '2') {
							aplservice.serviceName = aplservice.serviceName
							aplservice.count = aplservice.alloted;
							results.push({ ...offer, ...aplservice });
						}
					}
				}
			}
		} else if (req.query.master == 'IP') {
			let psiConfig = Account.details.psiConfig;
			let positions = new Set();
			if (psiConfig) {
				for (const psiconfig of psiConfig) {
					for (const tyreSize of psiconfig.tyreSizes) {
						let obj = {};
						obj.wheeler = psiconfig.wheeler;
						obj.config = psiconfig.config
						obj.name = psiconfig.name
						obj.segment = psiconfig.segment
						obj.tyreSize = tyreSize.size;
						obj.type = tyreSize.type;
						for (const config of tyreSize.config) {
							obj[config.position] = config.psi;
							positions.add(config.position);
						}
						results.push(obj);
					}
				}
				for (const res of results) {
					for (const pos of positions) {
						if (!res.hasOwnProperty(pos))
							res[pos] = '';
					}
				}
			} else {
				let obj = {};
				obj.wheeler = "";
				obj.config = "";
				obj.name = "";
				obj.segment = "No data available in table";
				obj.tyreSize = "";
				obj.type = "";
				results.push(obj);
			}
		}
		return res.send({ success: true, results: results, tname: Account.tname });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching account', err);
	}
}

exports.serviceConfigBulkUpdate = async function (req, res) {
	const ROUTE = 'web/accounts/serviceConfigBulkUpdate';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { // Apollo Fleet
			return res.send({ success: false, error: 'Not authorized to this API' });
		}
		if (!req.file) {
			return res.send({ success: false, error: "file not found", message: "file not found" });
		}
		if (!req.body.AccountId) {
			return res.send({ success: false, error: "Missing AccountId", message: "Missing AccountId" });
		}

		const Account = await models.Account.findOne({
			attributes: ["id", "tname", "serviceConfig"],
			where: {
				id: req.body.AccountId,
				type: { [Op.in]: [11, 10] },
				AccountIdParent: res.locals.AccountId
			}
		});

		if (!Account) {
			return res.send({ success: false, error: "Account not found.", message: "Account not found." });
		}

		const scheduleServiceTypes = ["IP Check & Correction", "Tyre & Vehicle Inspection", "Tyre Rotation On Rim", "Wheel Alignment", "Wheel Rotation"];
		const vehicleServiceTypes = await models.VehicleServiceType.findAll({
			attributes: ['id', 'serviceName'],
			where: {
				serviceName: [...scheduleServiceTypes, ...['Onboarding Service', 'Additional Service', 'Tyre Fitment', 'Tyre Onboarding']],
				AccountId: req.body.AccountId
			},
			raw: true
		});

		if (!vehicleServiceTypes.length) {
			return res.send({ success: false, error: "Account has no Vehicle Service Types.", message: "Account has no Vehicle Service Types." });
		}

		let filePath = req.file.path;
		await workbook.xlsx.readFile(filePath);
		let newserviceConfig = [], seviceConfig = {}, schedules = [], aplServices = [];
		workbook.getWorksheet("Service Schedules").eachRow({ includeEmpty: false }, async function (row, rowNumber) {
			if (row.values.length && rowNumber != 1 && row.values[2] && row.values[3] && row.values[4]) {
				for (const wheeler in axleConfig) {
					if (wheeler.toString().replace(/ /g, '').toUpperCase() == row.values[2].toString().toUpperCase().replace(/\s+/g, "").replace(/(\r\n|\n|\r)/gm, "")) {
						seviceConfig.wheeler = wheeler;
						for (const config in axleConfig[wheeler]) {
							if (config.toString().replace(/ /g, '').toUpperCase() == row.values[3].toString().replace(/[*\n\r]/gi, 'x').toUpperCase().replace(/(\r\n|\n|\r)/gm, "").replace(/\s+/g, "")) {
								seviceConfig.config = config;
								for (const wheelerConfig of axleConfig[wheeler][config]) {
									if (wheelerConfig.name.toString().replace(/ /g, '').toUpperCase() == row.values[4].toString().replace(/[*\n\r]/gi, 'x').toUpperCase().replace(/(\r\n|\n|\r)/gm, "").replace(/\s+/g, "")) {
										seviceConfig.name = wheelerConfig.name;
									}
								}
							}
						}
					}
				}

				let scheduleServices = vehicleServiceTypes.filter(x => (scheduleServiceTypes.indexOf(x.serviceName) > -1));
				let vehicleServiceType = scheduleServices.find(x => x.serviceName && x.serviceName.toUpperCase().replace(/ /g, '') == row.values[5].toUpperCase().replace(/ /g, '')) || '';
				if (vehicleServiceType) {
					let alertThresholdInKm = row.values[9] && Number(row.values[9]) || 0;
					if (row.values[9] && row.values[9].formula) alertThresholdInKm = Number(row.values[9].result) || 0;
					schedules.push({
						frequencyInMonth: row.values[8] && Number(row.values[8]) / 30 || "",
						alertThresholdInKm: alertThresholdInKm,
						VehicleServiceTypeId: Number(vehicleServiceType.id),
						alertThresholdInDays: Number(row.values[10]),
						frequencyInKm: Number(row.values[7]) || "",
						serviceBasedOn: 'ODO',
						jobCardStatus: null,
						serviceName: vehicleServiceType.serviceName,
						isActive: true,
					});
				}

				let vehicleAplservice = vehicleServiceTypes.find(x => x.serviceName && x.serviceName.toUpperCase().replace(/ /g, '') == row.values[5].toUpperCase().replace(/ /g, '')) || '';
				if (vehicleAplservice) {
					let serviceType = serviceTypes.find(x => x.serviceName == vehicleAplservice.serviceName)
					let aplService = {
						amc: true,
						sNo: serviceType.sNo,
						sub: [],
						valid: true,
						alloted: row.values11 && Number(row.values11.toString().replace('x', '').replace('X', '').replace(/ /g, '')) || 0,
						consumed: 0,
						ScheduleId: null,
						serviceName: vehicleAplservice.serviceName,
						ServiceTypeId: vehicleAplservice.id,
						componentName: serviceType.componentName
					};

					if (vehicleAplservice.serviceName == 'Onboarding Service') {
						aplService.sub = [
							{
								"sNo": "1-1",
								"ScheduleId": null,
								"serviceName": "Tyre Onboarding",
								"ServiceTypeId": vehicleServiceTypes.find(x => x.serviceName == "Tyre Onboarding").id,
								"componentName": "Tyre"
							},
							{
								"sNo": "1-2",
								"ScheduleId": null,
								"serviceName": "Tyre & Vehicle Inspection",
								"ServiceTypeId": vehicleServiceTypes.find(x => x.serviceName == "Tyre & Vehicle Inspection").id,
								"componentName": "Tyre"
							},
							{
								"sNo": "1-3",
								"ScheduleId": null,
								"serviceName": "IP Check & Correction",
								"ServiceTypeId": vehicleServiceTypes.find(x => x.serviceName == "IP Check & Correction").id,
								"componentName": "Tyre"
							},
							{
								"sNo": "1-4",
								"ScheduleId": null,
								"serviceName": "Wheel Alignment",
								"ServiceTypeId": vehicleServiceTypes.find(x => x.serviceName == "Wheel Alignment").id,
								"componentName": "Tyre"
							}
						]
					}
					aplServices.push(aplService);
				}

				if (aplServices.length == 7 && schedules.length == 5 && aplServices.every(x => x.ServiceTypeId != '') && schedules.every(x => x.VehicleServiceTypeId != '')) {
					seviceConfig.schedules = schedules;
					aplServices.push({
						amc: false,
						sNo: "8",
						sub: [],
						valid: true,
						alloted: 32,
						consumed: 0,
						ScheduleId: null,
						serviceName: "Additional Service",
						ServiceTypeId: vehicleServiceTypes.find(x => x.serviceName == "Additional Service").id,
						componentName: "Other"
					})
					seviceConfig.aplServices = aplServices;
					newserviceConfig.push(seviceConfig);
					seviceConfig = {}, schedules = [], aplServices = [];
				}
			}

		});

		newserviceConfig = newserviceConfig.filter(x => { return (!x.name || !x.wheeler || !x.config) ? 0 : 1 });

		if (req.body.preview && req.body.preview == 'true') {
			let previewConfig = [];
			for (let serviceConfig of JSON.parse(JSON.stringify(newserviceConfig))) {
				let offer = {};
				offer.name = serviceConfig.name;
				offer.wheeler = serviceConfig.wheeler;
				offer.config = serviceConfig.config;
				for (let schedule of serviceConfig.schedules) {
					let VehicleService = vehicleServiceTypes.find(x => x.id == schedule.VehicleServiceTypeId) || ''
					schedule.serviceName = VehicleService && VehicleService.serviceName || '';
					let aplService = serviceConfig.aplServices && serviceConfig.aplServices.length && serviceConfig.aplServices.find(x => x.ServiceTypeId == schedule.VehicleServiceTypeId) || '';
					schedule.count = aplService && aplService.alloted || '';
					previewConfig.push({ ...offer, ...schedule });
				}
				for (let aplservice of serviceConfig.aplServices) {
					if (aplservice.sNo === '1' || aplservice.sNo === '2') {
						aplservice.serviceName = aplservice.serviceName
						aplservice.count = aplservice.alloted;
						previewConfig.push({ ...offer, ...aplservice });
					}
				}
			}
			return res.send({ success: true, preview: true, results: previewConfig });
		} else {
			let serviceMasterUpdatedBy = {
				id: res.locals.id,
				username: res.locals.username,
				date: moment().toISOString()
			}

			const AccountServiceConfig = { axleConfig: newserviceConfig, serviceMasterUpdatedBy: serviceMasterUpdatedBy };
			if (Object.keys(Account.serviceConfig).length) {
				AccountServiceConfig = JSON.parse(JSON.stringify(Account.serviceConfig));
				AccountServiceConfig.axleConfig = newserviceConfig;
				AccountServiceConfig.serviceMasterUpdatedBy = serviceMasterUpdatedBy;
			}

			await Account.update({
				serviceConfig: AccountServiceConfig
			});
			return res.send({ success: true, preview: false, AccountName: Account.tname });
		}

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in service config bulk update', err);
	}
}

exports.psiConfigBulkUpdate = async function (req, res) {
	const ROUTE = 'web/accounts/psiConfigBulkUpdate';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { // Apollo Fleet
			return res.send({ success: false, error: 'Not authorized to this API' });
		}
		if (!req.file) {
			return res.send({ success: false, error: "file not found", message: "file not found" });
		}
		if (!req.body.AccountId) {
			return res.send({ success: false, error: "Missing AccountId", message: "Missing AccountId" });
		}

		const Account = await models.Account.findOne({
			attributes: ["id", "tname", "details"],
			where: {
				id: req.body.AccountId,
				type: { [Op.in]: [11, 10] },
				AccountIdParent: res.locals.AccountId
			}
		});

		if (!Account) {
			return res.send({ success: false, error: "Account not found.", message: "Account not found." });
		}

		const filePath = req.file.path;
		const Excel = xlsx.readFile(filePath);
		const sheet = Excel.Sheets["PSI Recommendation"];
		if (!sheet) {
			return res.send({ success: false, error: "PSI Recommendation not found in the Excel.", message: "PSI Recommendation not found in the Excel." });
		} else {
			const range = xlsx.utils.decode_range(sheet['!ref']);
			let psiConfig = []
			const rowDataMap = {};
			for (let i = range.s.c + 1; i <= range.e.c; i += 2) {
				let rowData = rowDataMap[i];
				if (!rowData) {
					rowData = {
						name: null,
						config: null,
						segment: null,
						wheeler: null,
						tyreSizes: []
					}
					rowDataMap[i] = rowData;
				}
				const tyres = {
					size: null,
					type: null,
					config: []
				}
				const tempData = [];
				for (let j = range.s.r; j <= 6; j++) {
					let cellAddress = xlsx.utils.encode_cell({ c: i, r: j });
					let data = sheet[cellAddress] ? sheet[cellAddress].v : '';
					tempData.push(data);
				}
				if (tempData[0] && tempData[1] && tempData[2] && tempData[3] && tempData[4] && tempData[6]) {
					rowData.segment = tempData[0]
					for (const wheeler in axleConfig) {
						if (wheeler.toString().replace(/ /g, '').toUpperCase() == tempData[1].toString().toUpperCase().replace(/\s+/g, "").replace(/(\r\n|\n|\r)/gm, "")) {
							rowData.wheeler = wheeler;
							for (const config in axleConfig[wheeler]) {
								if (config.toString().replace(/ /g, '').toUpperCase() == tempData[2].toString().replace(/[*\n\r]/gi, 'x').toUpperCase().replace(/(\r\n|\n|\r)/gm, "").replace(/\s+/g, "")) {
									rowData.config = config;
									for (const wheelerConfig of axleConfig[wheeler][config]) {
										if (wheelerConfig.name.toString().replace(/ /g, '').toUpperCase() == tempData[3].toString().replace(/[*\n\r]/gi, 'x').toUpperCase().replace(/(\r\n|\n|\r)/gm, "").replace(/\s+/g, "")) {
											rowData.name = wheelerConfig.name;
										}
									}
								}
							}
						}
					}

					tyres.size = tempData[4];
					tyres.type = tempData[6];
					let existingRowData = psiConfig.find(item => item.name === rowData.name && item.wheeler === rowData.wheeler && item.config === rowData.config);

					for (let j = range.s.r + 8; j <= range.e.r; j++) {
						let cellAddress = xlsx.utils.encode_cell({ c: i, r: j });
						let cellAddress1 = xlsx.utils.encode_cell({ c: i + 1, r: j });
						let data1 = sheet[cellAddress] ? sheet[cellAddress].v : '';
						let data2 = sheet[cellAddress1] ? sheet[cellAddress1].v : '';

						if (data1 == '' && data2 == '') {
							break;
						}

						if (data1.startsWith('Spare')) {
							const numberPart = Number(data1.substring('Spare'.length));
							data1 = 'SP' + (numberPart + 1);
						}

						const wheelConfig = {
							psi: data2,
							position: data1
						};
						tyres.config.push(wheelConfig);
					}
					if (existingRowData) {
						existingRowData.tyreSizes.push(tyres);
					} else {
						rowData.tyreSizes.push(tyres);
						psiConfig.push(rowData);
					}
				}
			}

			if (req.body.preview && req.body.preview == 'true') {
				let result = [];
				let positions = new Set();
				for (const psiconfig of psiConfig) {
					for (const tyreSize of psiconfig.tyreSizes) {
						let obj = {};
						obj.name = psiconfig.name
						obj.config = psiconfig.config
						obj.segment = psiconfig.segment
						obj.wheeler = psiconfig.wheeler;
						obj.tyreSize = tyreSize.size;
						obj.type = tyreSize.type;
						for (const config of tyreSize.config) {
							obj[config.position] = config.psi;
							positions.add(config.position);
						}
						result.push(obj);
					}
				}
				for (const res of result) {
					for (const pos of positions) {
						if (!res.hasOwnProperty(pos))
							res[pos] = '';
					}
				}
				return res.send({ success: true, preview: true, results: result });
			} else {
				let psiMasterUpdatedBy = {
					id: res.locals.id,
					username: res.locals.username,
					date: moment().toISOString()
				}

				let details = { psiConfig: psiConfig, psiMasterUpdatedBy: psiMasterUpdatedBy };

				if (Object.keys(Account.details).length) {
					details = JSON.parse(JSON.stringify(Account.details));
					details.psiConfig = psiConfig;
					details.psiMasterUpdatedBy = psiMasterUpdatedBy;
				}

				await Account.update({
					details: details
				});

				return res.send({ success: true, preview: false, AccountName: Account.tname });
			}
		}
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in PSI config bulk update', err);
	}
}

exports.signInTrigger = async function (req, res) {
	const ROUTE = 'app/accounts/signInTrigger';
	try {
		RaiseLogEvent(ROUTE, req.params.id, req.body, `Requested by ${res.locals?.userFullName} (${res.locals?.UserId})`);
		if (res.locals.AccountId != res.locals.masterAccountId && res.locals.role == 'Admin') { //Avolve Master Login
			return res.send({ success: false, error: 'Not authorized to this API.' });
		}
		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing.' });
		}

		if (!req.body.fos || !req.body.fos.length) {
			return res.send({ success: false, error: 'Please select alteast one FO to trigger mail.' });
		}

		let mailerData = JSON.parse(req.body.mailerData);
		if (!mailerData.find(x => x.trigger == true)) {
			return res.send({ success: false, error: 'Pleae check atleast one mailer type to proceed.' });
		}

		let Account = await models.Account.findOne({
			attributes: ['id', 'tname', 'name', 'details'],
			where: {
				id: req.params.id,
				AccountIdParent: res.locals.masterAccountId
			},
			raw: true
		});

		if (!Account) {
			return res.send({ success: false, error: 'Customer not found.' });
		}

		if (Account.details && Account.details.avolve == false) {
			return res.send({ success: false, error: "Can't trigger manual trigger for FTS customer." });
		}

		let Users = await models.User.findAll({
			attributes: ['id', 'firstName', 'lastName'],
			include: [{
				attributes: [],
				model: models.UserRole,
				where: {
					name: 'FO'
				}
			}],
			where: {
				id: req.body.fos,
				AccountId: req.params.id
			},
			raw: true
		});

		const custData = {
			tname: Account.tname || '',
			AccountId: Number(Account.id),
			mdgId: Account.name.split('_')[0] || ''
		};

		for (const user of Users) {
			custData.foUserId = user.id;
			for (const { trigger, type } of mailerData) {
				if (!trigger || !type) continue;
				let userData = {};
				if (type == 'fteAssign') {
					const { results = [] } = await avolveHelper.getFteUsersByCustomers([Account.id], false, res.locals.masterAccountId) || {};
					const fteUser = results[0] || {};
					userData.name = fteUser.name || '';
					if (!userData.name) {
						RaiseLogEvent('trigger-avolve-customer-mailer', type, custData, 'FTE user not found. Ensure FTE is mapped.');
					}
				}

				if (type == 'kamAssign') {
					const { success, results = [] } = await avolveHelper.getKamListByCustomers([Account.id], res.locals.masterAccountId) || {};
					const kam = success && results[0] || {};
					userData = {
						name: `${kam.firstName || ''} ${kam.lastName || ''}`.trim(),
						mobile: kam.mobile || '',
						email: kam.email || ''
					};

					if (!userData.name && !userData.mobile && !userData.email) {
						RaiseLogEvent('trigger-avolve-customer-mailer', type, custData, 'KAM user not found. Ensure KAM is mapped.');
					}
				}

				events.emit('trigger-avolve-customer-mailer', {
					...custData,
					user: userData,
					type
				});

				RaiseLogEvent('trigger-avolve-customer-mailer', type, custData, `Email triggered for ${type}.`);
			}
		}
		return res.send({ success: true, message: 'Email triggered to Customer. It will reflect in customer inbox shortly.' });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in signInTrigger', err);
	}
}

exports.listPaykm = async function (req, res) {
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { // Avolve
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'name', 'tname'],
			where: {
				type: 11, // Avolve Customers
				AccountIdParent: res.locals.masterAccountId,
				status: 1,
				'details.payKm': true
			},
			raw : true
		});
		return res.send({ success: true, results: Accounts });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in signInTrigger', err);
	}
}