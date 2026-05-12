const models = require("../../../models");
const moment = require("moment");
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const avolveHelper = require('../../../lib/helpers/avolveHelper');
const axleConfig = require('../../../config/axleConfig-apollo.json');
const serviceTypes = require('../../../config/serviceType-apollo.json');
const { Op } = require("sequelize");
const xlsx = require('xlsx');
const exceljs = require("exceljs");
const workbook = new exceljs.Workbook();
const evt = require('../../../lib/event');
const redisHelper = require('../../../lib/helpers/redis');
const fs = require('fs');
const { handleApiError } = require('../../middlewares/helper');

exports.listWeb = async function (req, res) {
	const ROUTE = 'app/accounts/listWeb';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { // Apollo Fleet
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		let whereClause = {
			type: 11, // Apollo Fleet Customers
			AccountIdParent: res.locals.AccountId,
			status: 1
		};

		if (req.query.sdate && req.query.edate) {
			whereClause.createdAt = { [Op.between]: [moment(req.query.sdate).startOf('day').toISOString(), moment(req.query.edate).startOf('day').toISOString()] };
		}

		if (req.query.avolve) {
			if (req.query.avolve == 'true') {
				whereClause['details.avolve'] = true;
			} else if (req.query.avolve == 'false') {
				whereClause['details.avolve'] = false;
			}
		}

		if (req.query.inactive && req.query.inactive == 'true') {
			whereClause.status = [0, 1] // both active and inactive customers
		}

		if (!["Admin", "FTS Admin"].includes(res.locals.role)) {
			whereClause.id = res.locals.accountIds;
		}

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'name', 'tname', 'oname', 'email1', 'baddress', 'anote', 'createdAt', 'totalvehicle', 'phone1', 'details', 'status'],
			include: [{
				attributes: ['id', 'details', 'offerType', 'subOfferType', 'startDate', 'endDate', 'plan', 'slab'],
				model: models.AplOffer
			}],
			where: whereClause,
			order: [[models.AplOffer, 'id', 'DESC']]
		});
		return res.send({ success: true, results: Accounts });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching customers', err);
	}
}

exports.listPaykm = async function (req, res) {
	const ROUTE = 'app/accounts/listPaykm';
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
				'details.payKm': true,
				
			},
			raw : true
		});

		return res.send({ success: true, results: Accounts });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching customers', err);
	}
}

exports.list = async function (req, res) {
	const ROUTE = 'app/accounts/list';
	try {
		let authorized = res.locals.role == 'IOT Service' || res.locals.AccountId == res.locals.masterAccountId;
		if (!authorized) { //Apollo Fleet
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		let accountWhere = {
			type: 11, //Apollo Fleet Customers
			AccountIdParent: res.locals.masterAccountId,
			status: 1
		};
		if (req.query.inactive && req.query.inactive == 'true') {
			accountWhere.status = [0, 1]; //0-InActive 1-Active
		}

		if (req.query.avolve) {
			if (req.query.avolve == 'true') {
				accountWhere['details.avolve'] = true;
			} else if (req.query.avolve == 'false') {
				accountWhere['details.avolve'] = false;
			}
		}

		if (req.query.channel && req.query.channel == 1) { // TIS
			accountWhere['details.channel'] = Number(req.query.channel);
			if (req.query.slab) {
				accountWhere['details.slab'] = req.query.slab;
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
		if (['Service Ops', "Admin", "IOT Service", "FTS Admin", "KAM"].indexOf(res.locals.role) == -1) {
			accountWhere.id = res.locals?.accountIds?.length ? res.locals.accountIds : [];
		}

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'name', 'tname', 'phone1'],
			include: accountInclude,
			where: accountWhere
		});

		return res.send({ success: true, results: Accounts });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching data', err);
	}
}

exports.listVendors = async function (req, res) {
	const ROUTE = 'app/accounts/listVendors';
	try {
		let AccountId = res.locals.AccountId;
		if (req.query.AccountId) {
			AccountId = req.query.AccountId;
		}

		const STPVendors = await models.AplVendor.findAll({
			attributes: ['id', 'name', ['vendorCode', 'code']],
			where: {
				AccountId: AccountId,
				status: true
			},
			order: [['createdAt', 'desc']],
			raw:true
		});

		const Dealers = await models.AplVendor.findAll({
			attributes: ['id', 'name', ['vendorCode', 'code']],
			include: [
				{
					model: models.Account,
					as: 'AplCustomers',
					through: { attributes: [] },
					where: { id: AccountId },
					attributes: []
				}
			],
			where: {
				status: true
			}
		});

		return res.send({ success: true, results: [...STPVendors, ...Dealers] });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching vendors', err);
	}
}

exports.listByUser = async function (req, res) {
	const ROUTE = 'app/accounts/listByUser';
	try {
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let accountWhere = {
			id: { [Op.in]: await avolveHelper.getAccountIdByRole(res.locals, req.query, true)},
			type: 11, //Apollo Fleet Customers
			AccountIdParent: res.locals.masterAccountId
		}

		let offerWhere = {
			required: false
		};

		if (req.query.channel) {
			offerWhere.where = {
				plan: req.query.channel == 1 ? req.query.channel : [2, null]
			};
			offerWhere.required = true;
		}

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'name', 'tname', 'status', 'details'],
			include: [{
				attributes: ['id', 'details'],
				model: models.AplReport,
				where: {
					year: moment().format('YYYY'),
					month: moment().format('M')
				},
				required: false
			}, {
				...{
					attributes: ['id', 'offerType', 'subOfferType', 'startDate', 'endDate', 'slab', 'plan'],
					model: models.AplOffer,
					required: false
				},
				...offerWhere
			}],
			where: accountWhere,
			order: [
				['createdAt', 'ASC'],
				[{ model: models.AplOffer }, 'id', 'DESC']
			]  // Adjust order for the associated model
		});

		let isFTSUser = avolveHelper.isFTSUser(res.locals.role);
		let mfCustomers = await avolveHelper.isMFCustomer(Accounts.map(x => x.id));

		let results = [];
		for (let Account of Accounts) {
			let isAvolveUser = Account.details && Account.details.avolve || false;
			let AplOffer = Account.AplOffers && Account.AplOffers.length && Account.AplOffers[0] || {};
			let status = Account.status == 1 ? 'Active' : 'Inactive';
			const offerStartDate = AplOffer.startDate && moment(AplOffer.startDate).startOf('day') || '';
			const offerEndDate = AplOffer.endDate && moment(AplOffer.endDate).endOf('day') || '';
			if (offerStartDate && offerEndDate) {
				if (Account.status == 1 && (offerStartDate > moment() || offerEndDate < moment())) {
					status = 'Expired';
				}
			}

			let result = {
				id: Account.id,
				name: Account.name || '',
				tname: Account.tname || '',
				offer: AplOffer && AplOffer.offerType || '',
				subOffer: AplOffer && AplOffer.subOfferType || '',
				active: status || '',
				isObPending: true,
				plan: Account.details && Account.details.plan || null,
				slab: AplOffer && AplOffer.slab || null,
				channel: AplOffer && AplOffer.plan || 2,
				isMf: !isFTSUser && isAvolveUser ? mfCustomers[Account.id] || false : false,
				isAvolve: isAvolveUser
			}
			let AplReports = Account.AplReports;
			if (AplReports.length && AplReports[0].details && AplReports[0].details.os) {
				let os = AplReports[0].details.os;
				if (os.totalOfferVehicles > 0 && os.totalOfferTyres > 0) {
					if ((os.totalVehicles >= os.totalOfferVehicles) && (os.totalTyres >= os.totalOfferTyres)) {
						result.isObPending = false;
					}
				}
			}
			delete Account.details;
			results.push(result);
		}

		return res.send({ success: true, results: results });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching data', err);
	}
}

exports.listByUserWeb = async function (req, res) {
	const ROUTE = 'app/accounts/listByUserWeb';
	try {

		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM', 'Admin'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let accountWhere = {
			type: 11,
			AccountIdParent: res.locals.masterAccountId
		};

		if (res.locals.role != 'Admin') {
			if (['KAM', 'FTS KAM'].includes(res.locals.role)) {
				accountWhere.id = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
			} else {
				if (req.query.UserId) {
					let result = await avolveHelper.getCustomersByUser(req.query.UserId, true, res.locals.masterAccountId);
					if (result.success && result.results.length) {
						accountWhere.id = result.results.map(x => x.id);
					}
				} else {
					let zmId = ["HO Sales", "FTS HO"].includes(res.locals.role) && res.locals.zmIds || res.locals.UserId;
					let kamResult = await avolveHelper.getKamListByUser(zmId);
					if (kamResult.success && kamResult.results.length) {
						let custResult = await avolveHelper.getCustomersByUser(kamResult.results.map(x => x.id), true, res.locals.masterAccountId);
						accountWhere.id = custResult.results.map(x => x.id);
					}
				}
			}
		}

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'name', 'tname'],
			where: accountWhere,
			order: [['createdAt', 'DESC']],
			raw: true
		});

		return res.send({ success: true, results: Accounts });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching customers', err);
	}
}

exports.getAccountSummary = async function (req, res) {
	const ROUTE = 'app/accounts/getAccountSummary';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: `Missing input parameter` });
		}

		let Account = await models.Account.findOne({
			attributes: ['id', 'name', 'tname', 'status', 'details', 'serviceConfig', 'createdAt'],
			include: [{
				model: models.AplOffer,
				required: false
			}],
			where: {
				id: req.params.id,
				AccountIdParent: res.locals.masterAccountId
			},
			order: [[{ model: models.AplOffer }, 'id', 'DESC']] // sort order for the associated offer model
		});

		if (!Account) {
			return res.send({ success: false, error: `Account not found` });
		}

		let FoUser = await models.User.findOne({
			attributes: ['id', 'email'],
			include: [{
				model: models.UserRole,
				where: {
					name: ['FO']
				}
			}],
			where: {
				AccountId: Account.id
			}
		});

		let totInvoice = await models.AplInvoice.count({
			where: {
				AccountId: Account.id
			}
		});

		let paidCount = await models.AplInvoice.count({
			include: [{
				attributes: ['id', 'amount'],
				model: models.AplPayment,
				required: true
			}],
			where: {
				AccountId: Account.id
			}
		});

		let offer = Account.details && Account.details.plan || null;
		let obSummary = await avolveHelper.onboardSummary(req.params.id);
		let AplOffer = Account.AplOffers && Account.AplOffers.length && Account.AplOffers[0] || {};

		let serviceMaster = 'Inactive';
		if (Account.serviceConfig && Account.serviceConfig.axleConfig && Account.serviceConfig.axleConfig.length && Account.details && Account.details.psiConfig && Account.details.psiConfig.length) {
			serviceMaster = 'Active';
		}
		let actMdgId = Account.name.split('_')[0] || '';

		let offerExpired = false;
		const offerStartDate = AplOffer.startDate && moment(AplOffer.startDate).startOf('day') || '';
		const offerEndDate = AplOffer.endDate && moment(AplOffer.endDate).endOf('day') || '';
		if (offerStartDate && offerEndDate) {
			if (Account.status == 1 && (offerStartDate > moment() || offerEndDate < moment())) {
				offerExpired = true;
			}
		}
		let { slab, channel } = avolveHelper.avolveOfferLookUp(AplOffer) || {};
		let isFTSUser = avolveHelper.isFTSUser(res.locals.role);
		let isAvolveUser = Account.details && Account.details.avolve || false;
		let mfCustomers = await avolveHelper.isMFCustomer([Account.id]);

		let detailsVehGroups = AplOffer.details && (AplOffer.details.vehicleGroups || (AplOffer.details.operations && AplOffer.details.operations.vehicleGroups)) || [];
		let vehicleGroups = [];
		for (const vehicleGroup of detailsVehGroups) {
			vehicleGroups.push({
				...vehicleGroup,
				vehicles: vehicleGroup.vehicles && Number(vehicleGroup.vehicles) || 0,
				payload: vehicleGroup.payload && String(vehicleGroup.payload) || ''
			});
		}

		let result = {
			id: Account.id,
			custId: actMdgId,
			maskedCustId: `${actMdgId.substring(0, 5)}***${actMdgId.substring(actMdgId.length - 2)}`,
			email: FoUser && FoUser.email || '',
			oppId: AplOffer && AplOffer.offerId || (AplOffer.details && AplOffer.details.oppId) || '',
			tname: Account.tname,
			status: Account.status,
			offerExpired: offerExpired,
			offer: AplOffer && AplOffer.offerType || '',
			channel: channel || null,
			slab: slab || null,
			subOffer: AplOffer && AplOffer.subOfferType || '',
			offerVehicles: parseInt(obSummary.totalOfferVehicles) || 0,
			offerTyres: obSummary.totalOfferTyres || 0,
			offerSdate: AplOffer && AplOffer.startDate && moment(AplOffer.startDate).format('DD MMMM YYYY') || '',
			offerEdate: AplOffer && AplOffer.startDate && moment(AplOffer.endDate).format('DD MMMM YYYY') || '',
			kam: { name: '', code: '', assigned: false },
			fte: { name: '', code: '', assigned: false },
			serviceMaster: serviceMaster,
			apolloSharePercentage: obSummary.apolloShare && obSummary.apolloShare.tyresPercentage || 0,
			apolloShareCount: obSummary.apolloShare && obSummary.apolloShare.tyresCount || 0,
			pendingInvoices: totInvoice - paidCount,
			activatedDate: moment(Account.createdAt).format('DD-MM-YYYY'),
			obVehicleCount: obSummary.totalVehicles || 0,
			obVehiclePer: obSummary.totalOfferVehicles && ((obSummary.totalVehicles / obSummary.totalOfferVehicles) * 100).toFixed() || 0,
			obTyreCount: obSummary.totalTyres || 0,
			obTyrePer: obSummary.totalOfferTyres && ((obSummary.totalTyres / obSummary.totalOfferTyres) * 100).toFixed() || 0,
			isMf: !isFTSUser && isAvolveUser ? mfCustomers[Account.id] || false : false,
			vehicleGroups: vehicleGroups
		}

		let Users = await models.User.findAll({
			attributes: ['id', 'username', 'accountIds', 'userCode', 'firstName', 'lastName'],
			include: [{
				attributes: ['id', 'name'],
				model: models.UserRole,
				where: {
					name: ['KAM', 'FTS KAM']
				},
			}],
			where: {
				AccountId: res.locals.masterAccountId
			},
			raw: true
		});

		let kam = Users.find(x => x.accountIds.find(y => y.id == Account.id)) || {};
		if (kam && Object.keys(kam).length) {
			result.kam.name = (kam.firstName && `${kam.firstName} ${kam.lastName || ''}`) || (kam.username || '');
			result.kam.code = kam.userCode || "";
			result.kam.assigned = true;
		}

		let fteResult = {};
		if (offer == 3) {
			fteResult = await avolveHelper.getDEFteUsers([Account.id]);
		} else if (offer == 4 || offer == 2) {
			fteResult = await avolveHelper.getAmccXEFteUsers([Account.id], res.locals.masterAccountId);
		} else if (offer == 1) {
			fteResult = await avolveHelper.getAmcsFteUsers([Account.id], res.locals.masterAccountId);
		}

		if (fteResult.success && fteResult.results.length) {
			result.fte.name = fteResult.results[0].name || "";
			result.fte.code = fteResult.results[0].userCode || "";
			result.fte.assigned = true;
		}

		return res.send({ success: true, result: result });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching data', err);
	}
}

exports.getServiceMaster = async function (req, res) {
	const ROUTE = 'app/accounts/getServiceMaster';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: `Missing input parameter` });
		}

		let Account = await models.Account.findOne({
			attributes: ['id', 'name', 'tname', 'details', 'serviceConfig'],
			where: {
				id: req.params.id,
				AccountIdParent: res.locals.masterAccountId
			},
			raw : true
		});

		if (!Account) {
			return res.send({ success: false, error: `Account not found` });
		}

		var vehicleServiceTypes = await models.VehicleServiceType.findAll({
			attributes: ['id', 'serviceName'],
			where: {
				serviceName: ['IP Check & Correction', 'Tyre & Vehicle Inspection', 'Tyre Rotation On Rim', 'Wheel Alignment', 'Wheel Rotation', 'Onboarding Service', 'Additional Service', 'Tyre Fitment', 'Tyre Onboarding'],
				AccountId: Account.id
			},
			raw: true
		});

		var worksheet1Columns = [{ header: 'Wheeler', key: 'wheeler', width: 20 },
		{ header: 'Configuration', key: 'config', width: 20 },
		{ header: 'Name', key: 'name', width: 20 },
		{ header: 'Service Name', key: 'serviceName', width: 20 },
		{ header: 'LOI Count', key: 'count', width: 10 },
		{ header: 'Service Based On', key: 'serviceBasedOn', width: 10 },
		{ header: 'Cycle (KM)', key: 'frequencyInKm', width: 10 },
		{ header: 'Cycle (Days)', key: 'frequencyInDays', width: 10 },
		{ header: 'Alert Reminder (KM)', key: 'alertThresholdInKm', width: 10 },
		{ header: 'Alert Reminder (Days)', key: 'alertThresholdInDays', width: 10 }]


		var worksheet2columns = [{ header: 'Wheeler', key: 'wheeler', width: 20 },
		{ header: 'Configuration', key: 'config', width: 20 },
		{ header: 'Name', key: 'name', width: 20 },
		{ header: 'Segment', key: 'segment', width: 20 },
		{ header: 'Tyre Size', key: 'tyreSize', width: 15 },
		{ header: 'Construction', key: 'type', width: 15 }];

		let psiConfigs = Account.details && Account.details.psiConfig || [];
		let serviceConfigs = Account.serviceConfig && Account.serviceConfig.axleConfig || [];

		let psiMaster = [], serviceMaster = [];
		let positions = new Set();
		for (const psiconfig of psiConfigs) {
			for (const tyreSize of psiconfig.tyreSizes) {
				let obj = {};
				obj.name = psiconfig.name
				obj.config = psiconfig.config
				obj.segment = psiconfig.segment
				obj.wheeler = psiconfig.wheeler;
				obj.tyreSize = tyreSize.size;
				obj.type = tyreSize.type;
				for (let config of tyreSize.config) {
					obj[config.position] = config.psi;
					positions.add(config.position);
				}
				psiMaster.push(obj);
			}
		}

		for (let psi of psiMaster) {
			for (let pos of positions) {
				if (!psi.hasOwnProperty(pos))
					psi[pos] = '';
			}
		}

		positions = [...positions]
		positions = positions.map(x => worksheet2columns.push({ header: x, key: x, width: 15 }));

		for (let serviceConfig of serviceConfigs) {
			let offer = {};
			offer.name = serviceConfig.name;
			offer.wheeler = serviceConfig.wheeler;
			offer.config = serviceConfig.config;
			for (let schedule of serviceConfig.schedules) {
				let VehicleService = vehicleServiceTypes.find(x => x.id == schedule.VehicleServiceTypeId) || '';
				schedule.serviceName = VehicleService && VehicleService.serviceName || '';
				schedule.count = serviceConfig.aplServices.find(x => x.ServiceTypeId == schedule.VehicleServiceTypeId).alloted || '';
				schedule.frequencyInDays = schedule.frequencyInMonth * 30;
				serviceMaster.push({ ...offer, ...schedule });
			}
			//#region push onboarding and tyre fitment service
			for (let aplservice of serviceConfig.aplServices) {
				if (aplservice.sNo === '1' || aplservice.sNo === '2') {
					aplservice.count = aplservice.alloted;
					serviceMaster.push({ ...offer, ...aplservice });
				}
			}
			//#endregion
		}

		var fileName = `${Account.name}_service_master`;
		res.setHeader('Content-Disposition', `attachment;filename=${fileName}`);
		res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
		const workbook = new exceljs.stream.xlsx.WorkbookWriter({
			stream: res
		});
		const worksheet1 = workbook.addWorksheet(`Service Schedules`);
		const worksheet2 = workbook.addWorksheet(`PSI Recomendation`);

		worksheet1.columns = worksheet1Columns;
		worksheet2.columns = worksheet2columns;

		for (const service of serviceMaster) {
			worksheet1.addRow(service).commit();
		}
		for (const psi of psiMaster) {
			worksheet2.addRow(psi).commit();
		}
		worksheet1.commit();
		worksheet2.commit();
		await workbook.commit();
		return res.end();

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching data', err);
	}
}

exports.getOffer = async function (req, res) {
	const ROUTE = 'app/accounts/getOffer';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: `Missing input parameter` });
		}

		let Account = await models.Account.findOne({
			attributes: ['id', 'name', 'tname', 'status', 'details', 'serviceConfig', 'createdAt'],
			include: [{
				model: models.AplOffer,
				required: false
			}],
			where: {
				id: req.params.id,
				AccountIdParent: res.locals.masterAccountId
			},
			order: [[{ model: models.AplOffer }, 'id', 'DESC']]  // Adjust order for the associated model
		});

		if (!Account) {
			return res.send({ success: false, error: `Customer not found` });
		}

		let AplOffer = Account.AplOffers && Account.AplOffers.length && Account.AplOffers[0] || {};

		if (!AplOffer) {
			return res.send({ success: false, error: `Offer not found for this customer` });
		}

		if (!AplOffer.details) {
			return res.send({ success: false, error: `Offer details not found for this customer` });
		}

		let activeCount = await models.Asset.count({
			where: {
				AccountId: AplOffer.AccountId,
				remove: false,
				active: true
			}
		});

		let inactiveCount = await models.Asset.count({
			where: {
				AccountId: AplOffer.AccountId,
				remove: true,
				active: false
			}
		});

		let details = AplOffer.details;
		let address = {};
		if (details.operations && details.operations.yards && details.operations.yards.length && details.operations.yards[0].address) {
			address = details.operations.yards[0].address;
		}
		let serviceMaster = 'Inactive';
		if (Account && Account.serviceConfig && Account.serviceConfig.axleConfig && Account.serviceConfig.axleConfig.length && Account.details && Account.details.psiConfig && Account.details.psiConfig.length) {
			serviceMaster = 'Active';
		}

		let status = AplOffer.status;
		const offerStartDate = AplOffer.startDate && moment(AplOffer.startDate).startOf('day') || '';
		const offerEndDate = AplOffer.endDate && moment(AplOffer.endDate).endOf('day') || '';
		if (offerStartDate && offerEndDate) {
			if (Account.status == 1 && (offerStartDate > moment() || offerEndDate < moment())) {
				status = 'Expired';
			}
		}

		let { slab, channel } = avolveHelper.avolveOfferLookUp(AplOffer) || {};
		let result = {
			offerId: AplOffer.offerId,
			offerType: details.offerType,
			subOffer: details.subOfferType || "",
			totalVehicles: details.vehicles && Number(details.vehicles) || 0,
			serviceMaster: serviceMaster,
			obVehiclesPer: details.vehicles && (parseInt((activeCount + inactiveCount) / details.vehicles * 100)) || 0,
			vehicleGroups: [],
			activeVehicles: activeCount,
			inactiveVehicles: inactiveCount,
			startDate: AplOffer.startDate && moment(AplOffer.startDate).format('Do MMM YYYY') || "",
			endDate: AplOffer.endDate && moment(AplOffer.endDate).format('Do MMM YYYY') || "",
			status: status || '',
			address: address,
			channel: channel || null,
			slab: slab || null
		}

		if (details.operations && details.operations.vehicleGroups && details.operations.vehicleGroups.length) {
			for (const group of details.operations.vehicleGroups) {
				result.vehicleGroups.push({
					wheeler: group.wheeler,
					config: group.config,
					name: group.name,
					vehicles: group.vehicles
				});
			}
		}

		return res.send({ success: true, result: result })
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching data', err);
	}
}

exports.serviceConfigBulkUpdate = async function (req, res) {
	const ROUTE = 'app/accounts/serviceConfigBulkUpdate';
	try {
		RaiseLogEvent(ROUTE, req.file, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (res.locals.AccountId != res.locals.masterAccountId) { // Apollo Fleet
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		if (!req.file) {
			return res.send({ success: false, error: "file not found", message: "file not found" });
		}

		if (!req.body.AccountId) {
			return res.send({ success: false, error: "Missing AccountId", message: "Missing AccountId" });
		}

		var Account = await models.Account.findOne({
			where: {
				id: req.body.AccountId,
				type: { [Op.in]: [11, 10] },
				AccountIdParent: res.locals.AccountId
			},
			attributes: ["id", "tname", "serviceConfig"]
		});

		if (!Account) {
			return res.send({ success: false, error: "Account not found.", message: "Account not found." });
		}

		var scheduleServiceTypes = ["IP Check & Correction", "Tyre & Vehicle Inspection", "Tyre Rotation On Rim", "Wheel Alignment", "Wheel Rotation"];

		var vehicleServiceTypes = await models.VehicleServiceType.findAll({
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
		console.log(`Reading data from Excel file`);

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
						alloted: row.values[11] && Number(row.values[11].toString().replace('x', '').replace('X', '').replace(/ /g, '')) || 0,
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
				id: res.locals.UserId,
				username: res.locals.userFullName,
				date: moment().toISOString()
			}

			let AccountServiceConfig = { axleConfig: newserviceConfig, serviceMasterUpdatedBy: serviceMasterUpdatedBy };

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
		return handleApiError(res, ROUTE, 'Error fetching data', err);
	}
}

exports.psiConfigBulkUpdate = async function (req, res) {
	const ROUTE = 'app/accounts/psiConfigBulkUpdate';
	try {
		RaiseLogEvent(ROUTE, req.body.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (res.locals.AccountId != res.locals.masterAccountId) { // Apollo Fleet
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		if (!req.file) {
			return res.send({ success: false, error: "file not found", message: "file not found" });
		}

		if (!req.body.AccountId) {
			return res.send({ success: false, error: "Missing AccountId", message: "Missing AccountId" });
		}

		var Account = await models.Account.findOne({
			where: {
				id: req.body.AccountId,
				type: { [Op.in]: [11, 10] },
				AccountIdParent: res.locals.AccountId
			},
			attributes: ["id", "tname", "details"]
		});

		if (!Account) {
			return res.send({ success: false, error: "Account not found.", message: "Account not found." });
		}

		let filePath = req.file.path;
		const Excel = xlsx.readFile(filePath);

		var sheet = Excel.Sheets["PSI Recommendation"];
		if (!sheet) {
			return res.send({ success: false, error: "PSI Recommendation not found in the Excel.", message: "PSI Recommendation not found in the Excel." });
		} else {
			const range = xlsx.utils.decode_range(sheet['!ref']);
			var psiConfig = []
			const rowDataMap = {};
			for (var i = range.s.c + 1; i <= range.e.c; i += 2) {
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
				for (var j = range.s.r; j <= 6; j++) {

					var cellAddress = xlsx.utils.encode_cell({ c: i, r: j });

					var data = sheet[cellAddress] ? sheet[cellAddress].v : '';

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

					for (var j = range.s.r + 8; j <= range.e.r; j++) {

						var cellAddress = xlsx.utils.encode_cell({ c: i, r: j });
						var cellAddress1 = xlsx.utils.encode_cell({ c: i + 1, r: j });

						var data1 = sheet[cellAddress] ? sheet[cellAddress].v : '';
						var data2 = sheet[cellAddress1] ? sheet[cellAddress1].v : '';

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
					id: res.locals.UserId,
					username: res.locals.userFullName,
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
		return handleApiError(res, ROUTE, 'Error uploading service config', err);
	}
}

exports.getAccount = async function (req, res) {
	const ROUTE = 'app/accounts/getAccount';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { //Apollo Fleet
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: 'Account Id missing' });
		}

		let Account = await models.Account.findOne({
			attributes: ['id', 'tname', 'name', 'details', 'serviceConfig'],
			where: {
				type: 11, //Apollo Fleet Customers
				AccountIdParent: res.locals.AccountId,
				status: 1,
				id: req.params.id
			},
			raw : true
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
			raw : true
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

exports.syncServiceMaster = async function (req, res) {
	const ROUTE = 'app/accounts/syncServiceMaster';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { //Apollo Fleet
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		RaiseLogEvent('avolve/accounts/syncServiceMaster', req.params.id, { AccountId: req.params.id }, `Requested by ${res.locals.userFullName}`);

		if (!req.params.id) {
			return res.send({ success: false, error: 'Account Id missing' });
		}

		let Assets = await models.Asset.findAll({
			attributes: ['id', 'lplate', 'AccountId'],
			include: [{
				attributes: ['id', 'serviceConfig'],
				model: models.Account,
				where: {
					status: 1,
					AccountIdParent: res.locals.masterAccountId
				},
				required: true
			}],
			where: {
				remove: false,
				active: true,
				AccountId: req.params.id
			}
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
		return handleApiError(res, ROUTE, 'Error initiating process', err);
	}
}

exports.syncIPMaster = async function (req, res) {
	const ROUTE = 'app/accounts/syncIPMaster';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { //Apollo Fleet
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		RaiseLogEvent('avolve/accounts/syncIPMaster', 'Request', { AccountId: req.params.id }, `Requested by ${res.locals.userFullName}`);

		if (!req.params.id) {
			return res.send({ success: false, error: 'Account Id missing' });
		}

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'tyreNo', 'AssetId', 'AccountId', 'lastStatus'],
			include: [{
				attributes: ['id', 'details'],
				model: models.Account,
				where: {
					status: 1,
					AccountIdParent: res.locals.masterAccountId
				},
				required: true
			}],
			where: {
				AccountId: req.params.id,
				AssetId: { [Op.ne]: null }
			}
		});

		if (!Tyres.length) {
			return res.send({ success: false, error: 'Tyres not found for this account' });
		}

		let TyreHistories = await models.TyreHistory.findAll({
			attributes: ['id', 'tyreNo', 'AssetId', 'AccountId'],
			include: [{
				attributes: ['id', 'details'],
				model: models.Account,
				where: {
					status: 1,
					AccountIdParent: res.locals.masterAccountId
				},
				required: true
			}],
			where: {
				AccountId: req.params.id,
				AssetId: { [Op.ne]: null }
			}
		});

		let Inspections = await models.Inspection.findAll({
			attributes: ['id', 'date', 'details', 'AccountId', 'AssetId'],
			include: [{
				attributes: ['id', 'details'],
				model: models.Account,
				where: {
					status: 1,
					AccountIdParent: res.locals.masterAccountId
				},
				required: true
			}],
			where: {
				type: 't',
				AccountId: req.params.id
			}
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
		return handleApiError(res, ROUTE, 'Error Batch processing', err);
	}
}

exports.createWeb = async function (req, res) {
	const ROUTE = 'app/accounts/createWeb';
	try {
		RaiseLogEvent(ROUTE, req.body.custId, req.body, `Requested by ${res.local.userFullName} (${res.locsls.UserId})`);

		if (res.locals.AccountId != res.locals.masterAccountId && res.locals.role == 'Admin') { //Avolve Master Login
			return res.send({ success: false, error: 'Not authorized to this API.' });
		}

		if (req.body.createCustomer && req.body.createCustomer == 'false' && !req.body.AccountId) {
			return res.send({ success: false, error: 'Missing input parameter.' });
		}

		let users = JSON.parse(req.body.users);
		let validateRequest = validateInput(req.body, users);
		if (validateRequest && !validateRequest.success && validateRequest.message) {
			return res.send({ success: false, error: validateRequest.message });
		}

		let userNames = users.map(x => x.username.toLowerCase());
		let User = await models.User.findOne({
			attributes: ['id', 'username'],
			where: {
				[Op.and]: models.sequelize.where(
					models.sequelize.fn('LOWER', models.sequelize.col('username')),
					{ [Op.in]: userNames }
				)
			}
		});

		if (User) {
			return res.send({ success: false, error: `User already found with provided username ${User && User.username ? "- " + User.username : ''}, Please try different username` });
		}

		let accountWhere = {
			AccountIdParent: res.locals.masterAccountId,
			id: req.body.AccountId,
			name: req.body.mdgId
		};

		if (req.body.createCustomer && req.body.createCustomer == 'true') {
			delete accountWhere.id;
		}

		let Account = await models.Account.findOne({
			attributes: ['id', 'name', 'details'],
			where: accountWhere
		});

		let accountDetails = {};
		if (req.body.createCustomer && req.body.createCustomer == 'true') {
			if (Account && Account.name && Account.name.trim() == req.body.mdgId.trim()) {
				return res.send({ success: false, error: 'Customer already found with provided MDGID.' });
			}
			accountDetails = {
				channel: 2,
				avolve: false,
				testAcc: req.body.testAcc == 'true'
			};
			if (req.body.billingType) {
				accountDetails.billingType = req.body.billingType;
			}
		} else {
			if (!Account) {
				return res.send({ success: false, error: 'Customer not found.' });
			}
			let AplOffer = await models.AplOffer.count({
				where: {
					startDate: { [Op.lte]: moment().format('YYYY-MM-DD') },
					endDate: { [Op.gte]: moment().format('YYYY-MM-DD') },
					AccountId: Account.id,
					status: 'Active'
				}
			});
			if (AplOffer) {
				return res.send({ success: false, error: 'This customer already has an active offer.' });
			}
		}

		let SystemConfig = await models.SystemConfig.findOne({
			attributes: ['id', 'data'],
			where: {
				AccountId: res.locals.masterAccountId,
				module: 'Avolve',
				name: 'Offer Masters'
			}
		});

		if (!SystemConfig) {
			return res.send({ success: false, error: 'System config not found.' });
		}

		let vehicleGroups = [];
		let totalVehCount = 0;
		let { segments = [], applications = [] } = SystemConfig.data || {};
		for (var i = 0; i < req.body.wheeler.length; i++) {
			let validateVehGroup = req.body.vehCount[i] || req.body.wheeler[i] || req.body.config[i] || req.body.name[i] || req.body.vehGrpId[i];
			if (validateVehGroup && (!req.body.vehCount[i] || !req.body.wheeler[i] || !req.body.config[i] || !req.body.name[i])) {
				return res.send({ success: false, error: 'Please fill all fields for vehicle group creation.' });
			}
			totalVehCount += req.body.vehCount[i] && Number(req.body.vehCount[i]) || 0;
			let macthedSegment = segments.find(x => x.id == req.body.segment[i]) || {};
			let macthedApplication = applications.find(x => x.id == req.body.application[i]) || {};
			vehicleGroups.push({
				name: req.body.name[i],
				yards: [req.body.vehGrpId[i]],
				config: req.body.config[i],
				segment: "",
				wheeler: req.body.wheeler[i],
				services: [],
				payload: req.body.payload[i],
				application: macthedApplication.text || req.body.application[i],
				segment: macthedSegment.text || req.body.segment[i],
				vehicles: req.body.vehCount[i] && Number(req.body.vehCount[i]) || 0,
			});
		}

		if (totalVehCount != req.body.totVehCount) {
			return res.send({ success: false, error: 'Total vehicle count need to be matched with vehicle count in vehicle groups.' });
		}


		let offerDetails = {
			oppId: req.body.opprtunityId || '',
			custId: req.body.mdgId,
			vehicles: req.body.totVehCount && Number(req.body.totVehCount) || 0,
			offerType: req.body.offerType || '',
			subOfferType: req.body.subOfferType || '',
			operations: {
				oppId: req.body.opprtunityId || '',
				yards: [],
				custId: req.body.mdgId,
				startDate: moment(req.body.offerStartDate, 'DD/MM/YYYY').format("YYYY-MM-DD"),
				endDate: moment(req.body.offerEndDate, 'DD/MM/YYYY').format("YYYY-MM-DD"),
				vehicles: req.body.totVehCount && Number(req.body.totVehCount) || 0,
				paymentTerms: "Monthly",
				vehicleGroups: vehicleGroups
			}
		}

		let cust = req.body;
		let kttPlan = avolveHelper.getAvolveKTTPlan(req.body.offerType, req.body.subOfferType);
		let { slab, channel } = avolveHelper.kttOfferLookUp({ plan: req.body.plan, slab: req.body.slab });
		accountDetails.plan = kttPlan;
		await models.sequelize.transaction(async t => {
			if (req.body.createCustomer && req.body.createCustomer == 'true') {
				accountDetails.avolve = false;
				let Lead = await models.Lead.create({
					partnerAccount: res.locals.masterAccountId,
					custName: cust.ownerName,
					transportName: cust.transportName,
					contactName: "Shekhar Mishra",
					phone1: cust.phoneNo,
					gst: cust.mdgId,
					email1: cust.emailId,
					leadSource: 9, // Apollo Tyres 
					subleadSource: "Avolve",
					followUpDate: moment().add(7, 'days'),
					comments: "Apollo Tyres MF customer.",
					details: accountDetails,
					baddress: req.body.billingAdd,
					LeadBy: 1 // Admin
				}, { returning: true, transaction: t });

				Account = await models.Account.create({
					AccountIdParent: res.locals.masterAccountId,
					name: cust.mdgId, // Apollo Customer Code
					type: 11, // Default for Avolve customers
					tname: Lead.transportName,
					oname: Lead.custName,
					status: 1, // Active
					phone1: Lead.phone1,
					email1: Lead.email1,
					city: "Corporate",
					baddress: Lead.baddress ? Lead.baddress.toUpperCase() : '',
					gst: Lead.gst,
					EmployeeIdLeadSource: 1, // 1 - Admin
					EmployeeIdRM: 1,
					EmployeeIdCT: 1,
					EmployeeIdBDM: 1,
					EmployeeIdTC: 1,
					anote: Lead.comments,
					details: accountDetails
				}, { returning: true, transaction: t });

				await Lead.update({
					AccountId: Account.id
				}, { transaction: t });
				RaiseLogEvent(ROUTE, req.body.mdgId, { AccountId: Account.id, LeadId: Lead.id }, `Response`);
			}

			if (offerDetails && offerDetails.operations) {
				offerDetails.operations.AccountId = Account.id;
			}

			await models.AplOffer.create({
				AccountId: Account.id,
				offerId: req.body.opprtunityId || '',
				offer: kttPlan, // Xpert Edge
				plan: channel || 2,
				slab: slab || null,
				details: offerDetails,
				status: 'Active',
				startDate: moment(req.body.offerStartDate, 'DD/MM/YYYY').format("YYYY-MM-DD"),
				endDate: moment(req.body.offerEndDate, 'DD/MM/YYYY').format("YYYY-MM-DD"),
				offerType: req.body.offerType || '',
				subOfferType: req.body.subOfferType || '',
				assetIds: []
			}, { transaction: t });

			if (channel == 1) {
				let details = Account.details && JSON.parse(JSON.stringify(Account.details)) || {};
				details.channel = channel || 2;
				details.plan = kttPlan;
				details.slab = slab || null;
				await Account.update({
					details: details
				}, { transaction: t });
			}
		});

		// Create roles and users
		let isFTS = Account.details && Account.details.avolve == false || false;
		evt.events.emit("create-avolve-users", { AccountId: Account.id, users: users, mdgId: Account.name, isFTS });

		// Create service types
		evt.events.emit("create-apollo-service-types", { AccountId: Account.id });

		return res.send({ success: true });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error creating customer', err);
	}
}

exports.ftsCreate = async function (req, res) {
	const ROUTE = 'app/accounts/ftsCreate';
	try {
		RaiseLogEvent(ROUTE, req.body.custId, req.body, `Requested by ${res.local.userFullName} (${res.locsls.UserId})`);
		if (res.locals.AccountId != res.locals.masterAccountId) { //Avolve Master Login
			return res.send({ success: false, error: 'Not authorized to this API.' });
		}

		if (!req.body.ownerName || !req.body.emailId || !req.body.phoneNo || !req.body.billingAdd || !req.body.transportName || !req.body.wheeler || !req.body.config || !req.body.name || !req.body.segment || !req.body.application || !req.body.payload || !req.body.vehCount) {
			return res.send({ success: false, error: 'Please provide all mandatory fields for account creation.' });
		}

		const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
		const phoneRegex = /^[0-9]{10}$/;
		if (!emailRegex.test(req.body.emailId)) {
			return res.send({ success: false, error: `Invalid email. Please enter a valid email (e.g., example@gmail.com).` });
		}

		if (!phoneRegex.test(req.body.phoneNo)) {
			return res.send({ success: false, error: `Invalid mobile number. It must be exactly 10 digits.` });
		}

		if (typeof req.body.transportName != 'string') {
			return res.send({ success: false, error: `Invalid Transport Name. It should be text.` });
		}

		let accountWhere = {
			AccountIdParent: res.locals.masterAccountId,
			tname: req.body.transportName
		};

		let Account = await models.Account.findOne({
			attributes: ['id', 'name', 'details'],
			where: accountWhere
		});

		if (Account) {
			return res.send({ success: false, error: `Customer already found with ${req.body.transportName}.` });
		}

		const latestFTSCust = await models.Account.findOne({
			attributes: ['name'],
			where: {
				AccountIdParent: res.locals.masterAccountId,
				'details.avolve': false,
				name: { [Op.like]: '%FTS%' }
			},
			order: [[models.sequelize.literal("CAST(REGEXP_REPLACE(name, '\\D', '', 'g') AS BIGINT)"), 'DESC']],
			raw: true
		});

		if (!latestFTSCust) {
			return res.send({ success: false, error: "Last MDG series not found.", preview: excelData });
		}

		let lastNum = 0;
		if (latestFTSCust.name) {
			const match = latestFTSCust.name.match(/\d+$/);
			lastNum = match ? parseInt(match[0], 10) : 0;
		}

		const nextMdgNum = lastNum + 1;
		const mdgId = `00000FTS${nextMdgNum}`;

		let SystemConfig = await models.SystemConfig.findOne({
			attributes: ['id', 'data'],
			where: {
				AccountId: res.locals.masterAccountId,
				module: 'Avolve',
				name: 'Offer Masters'
			}
		});

		if (!SystemConfig) {
			return res.send({ success: false, error: 'System config not found.' });
		}

		let vehicleGroups = [];
		let totalVehCount = 0;
		let { segments = [], applications = [] } = SystemConfig.data || {};
		for (var i = 0; i < req.body.wheeler.length; i++) {
			let validateVehGroup = req.body.vehCount[i] || req.body.wheeler[i] || req.body.config[i];
			if (validateVehGroup && (!req.body.vehCount[i] || !req.body.wheeler[i] || !req.body.config[i])) {
				return res.send({ success: false, error: 'Please fill all fields for vehicle group creation.' });
			}
			totalVehCount += req.body.vehCount[i] && Number(req.body.vehCount[i]) || 0;
			let macthedSegment = segments.find(x => x.id == req.body.segment[i]) || {};
			let macthedApplication = applications.find(x => x.id == req.body.application[i]) || {};
			vehicleGroups.push({
				config: req.body.config[i],
				wheeler: req.body.wheeler[i],
				services: [],
				payload: req.body.payload[i],
				application: macthedApplication.text || req.body.application[i],
				segment: macthedSegment.text || req.body.segment[i],
				vehicles: req.body.vehCount[i] && Number(req.body.vehCount[i]) || 0,
				name: req.body.name[i]
			});
		}

		if (totalVehCount != req.body.totVehCount) {
			return res.send({ success: false, error: 'Total vehicle count need to be matched with vehicle count in vehicle groups.' });
		}

		let startDate = moment().startOf('day');
		let endDate = moment(startDate).add(1, 'year').endOf('month');

		let offerDetails = {
			vehicles: req.body.totVehCount && Number(req.body.totVehCount) || 0,
			offerType: "Xpert Edge",
			subOfferType: "Shared",
			operations: {
				startDate: startDate.format("YYYY-MM-DD"),
				endDate: endDate.format("YYYY-MM-DD"),
				vehicles: req.body.totVehCount && Number(req.body.totVehCount) || 0,
				vehicleGroups: vehicleGroups
			}
		}

		let cust = req.body;
		let kttPlan = 4; // Xpert Edge
		let accountDetails = {
			plan: kttPlan,
			avolve: false
		};

		await models.sequelize.transaction(async t => {
			let Lead = await models.Lead.create({
				partnerAccount: res.locals.masterAccountId,
				custName: cust.ownerName,
				transportName: cust.transportName,
				contactName: "Shekhar Mishra",
				phone1: cust.phoneNo,
				gst: mdgId,
				email1: cust.emailId,
				leadSource: 9, // Apollo Tyres 
				subleadSource: "Avolve",
				followUpDate: moment().add(7, 'days'),
				comments: "Apollo Tyres MF customer.",
				details: accountDetails,
				baddress: req.body.billingAdd,
				LeadBy: 1 // Admin
			}, { returning: true, transaction: t });

			Account = await models.Account.create({
				AccountIdParent: res.locals.masterAccountId,
				name: mdgId, // Apollo Customer Code
				type: 11, // Default for Avolve customers
				tname: Lead.transportName,
				oname: Lead.custName,
				status: 1, // Active
				phone1: Lead.phone1,
				email1: Lead.email1,
				city: "Corporate",
				baddress: Lead.baddress ? Lead.baddress.toUpperCase() : '',
				gst: Lead.gst,
				EmployeeIdLeadSource: 1, // 1 - Admin
				EmployeeIdRM: 1,
				EmployeeIdCT: 1,
				EmployeeIdBDM: 1,
				EmployeeIdTC: 1,
				anote: Lead.comments,
				details: accountDetails
			}, { returning: true, transaction: t });

			await Lead.update({
				AccountId: Account.id
			}, { transaction: t });
			RaiseLogEvent(ROUTE, req.body.mdgId, { AccountId: Account.id, LeadId: Lead.id }, `Response`);

			if (offerDetails && offerDetails.operations && Account && Account.id) {
				offerDetails.operations.AccountId = Account.id;
			}

			await models.AplOffer.create({
				AccountId: Account && Account.id,
				offer: kttPlan, // Xpert Edge
				details: offerDetails,
				status: 'Active',
				startDate: startDate.format("YYYY-MM-DD"),
				endDate: endDate.format("YYYY-MM-DD"),
				offerType: "Xpert Edge" || '',
				subOfferType: "Shared",
				assetIds: []
			}, { transaction: t });

			evt.events.emit("create-apollo-service-types", { AccountId: Account.id });

			let users = [{
				role: "Admin",
				firstName: cust.ownerName,
				username: `${cust.transportName}admin`.toLowerCase(),
				password: cust.phoneNo,
				mobile: cust.phoneNo,
				email: cust.emailId
			}];

			evt.events.emit("create-avolve-users", { AccountId: Account.id, users: users, mdgId: Account.name, isFTS: true });
		});

		return res.send({ success: true });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error creating customer', err);
	}
}

function validateInput(request, users) {
	const {
		ownerName, emailId, phoneNo, billingAdd, transportName,
		offerType, subOfferType, offerStartDate, offerEndDate, totVehCount,  //offer details
		adminFirstName, adminLastName, adminUsername, adminPassword, adminPhoneNo, adminEmailId, // admin user details
		foFirstName, foUsername, foPassword, foPhoneNo, // FO user details
		fmFirstName, fmUsername, fmPassword, fmPhoneNo, // FM user details
		mdgId, createCustomer
	} = request;

	if (createCustomer && createCustomer == 'true') {
		if (!mdgId || !mdgId.startsWith('00000')) {
			return { success: false, message: 'Please provide valid MDGID. Example: 00000xxxxx' };
		}
		if (mdgId) {
			const pattern = /^0{5}.+$/; // 00000xxxxx
			if (!pattern.test(mdgId.toString())) {
				return { success: false, message: 'Please provide valid MDGID. Example: 00000xxxxx' };
			}
		}

		if (!ownerName || !emailId || !phoneNo || !billingAdd || !transportName) {
			return { success: false, message: 'Please provide all mandatory fields for account creation.' };
		}
	}

	if (!offerType || !offerStartDate || !offerEndDate || !totVehCount) {
		return { success: false, message: 'Please provide all mandatory fields for offer creation.' };
	}

	if (offerType != 'Digital Edge' && !subOfferType) {
		return { success: false, message: 'Please provide all mandatory fields for offer creation.' };
	}

	if (!adminFirstName || !adminUsername || !adminPassword || !adminPhoneNo || !adminEmailId) {
		return { success: false, message: 'Please provide all mandatory fields for admin user creation.' };
	}

	const isAnyFOFieldFilled = foFirstName || foUsername || foPassword || foPhoneNo;
	if (isAnyFOFieldFilled && (!foFirstName || !foUsername || !foPassword || !foPhoneNo)) {
		return { success: false, message: 'Please fill fields Username, Password, FirstName, PhoneNo for FO user creation.' };
	}

	const isAnyFMFieldFilled = fmFirstName || fmUsername || fmPassword || fmPhoneNo;
	if (isAnyFMFieldFilled && (!fmFirstName || !fmUsername || !fmPassword || !fmPhoneNo)) {
		return { success: false, message: 'Please fill fields Username, Password, FirstName, PhoneNo for FM user creation.' };
	}

	if ((foUsername && foUsername && fmUsername == foUsername) || adminUsername == foUsername || adminUsername == fmUsername) {
		return { success: false, message: 'Please enter different username for users.' };
	}

	const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
	const phoneRegex = /^[0-9]{10}$/;
	const usernameRegex = /[^a-zA-Z0-9\.\@]/;
	for (const user of users) {
		if (user.email && !emailRegex.test(user.email)) {
			return { success: false, message: `Invalid email for ${user.role} user. Please enter a valid email (e.g., example@gmail.com).` };
		}

		if (!phoneRegex.test(user.mobile)) {
			return { success: false, message: `Invalid mobile number for ${user.role} user. It must be exactly 10 digits.` };
		}

		if (usernameRegex.test(user.username)) {
			return { success: false, message: `Invalid Username for ${user.role} Role. Special characters or empty spaces are not allowed.` };
		}
	}
	return { success: true };
}

exports.getOfferConfig = async function (req, res) {
	const ROUTE = 'app/accounts/getOfferConfig';
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
			raw : true
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

exports.ftsBulkCreate = async function (req, res) {
	const ROUTE = 'app/accounts/ftsBulkCreate';
	try {
		RaiseLogEvent(ROUTE, req.file, req.body, `Requested by ${res.local.userFullName} (${res.locsls.UserId})`);
		if (!req.file) {
			return res.send({ success: false, error: 'File not found' });
		}

		// Fetch system config for vehicle groups
		let SystemConfig = await models.SystemConfig.findOne({
			attributes: ['id', 'data'],
			where: {
				AccountId: res.locals.masterAccountId,
				module: 'Avolve',
				name: 'Offer Masters'
			}
		});

		if (!SystemConfig) {
			return res.send({ success: false, error: 'System configuration missing. Please contact support.' });
		}

		const workbook = new exceljs.Workbook();
		await workbook.xlsx.readFile(req.file.path);
		const worksheet = workbook.worksheets[0];

		if (!worksheet || worksheet.rowCount < 2) {
			return res.send({ success: false, error: 'Invalid or empty sheet' });
		}

		// Extract merged + sub headers
		const mainHeaders = worksheet.getRow(1).values.slice(1);
		const subHeaders = worksheet.getRow(2).values.slice(1);

		let columnHeaders = [];
		let columnHeaderKeys = [];
		let mandatoryColumns = [];

		for (let i = 0; i < subHeaders.length; i++) {
			let header = subHeaders[i];
			if (!header || header.toString().trim() === '') {
				header = mainHeaders[i] || `Column${i + 1}`;
			} else if (mainHeaders[i] && mainHeaders[i] !== header) {
				header = `${mainHeaders[i]}_${header}`;
			}
			columnHeaders.push(header);
			columnHeaderKeys.push(toCamelCase(header));

			// Track mandatory columns if they have *
			if (header.startsWith("Vehicle Group")) {
				continue;
			}
			if (/\*/.test(header)) {
				mandatoryColumns.push({ index: i + 1, header: header.replace(/\*/g, '').trim() });
			}
		}

		let excelData = [];
		const preview = [];
		let isRequirePreview = false;

		const seen = { transportName: new Set(), phone: new Set(), emailId: new Set() };
		function checkUnique(field, value, label, missingFields) {
			if (!value) return;
			const key = field === 'phone' ? value : (typeof value == 'string') ? value.toLowerCase() : value;
			if (seen[field].has(key)) {
				missingFields.push(`${label} duplication found: ${value}`);
			} else {
				seen[field].add(key);
			}
		}

		const { segments = [], applications = [] } = SystemConfig.data || {};
		worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
			if (rowNumber <= 2) return; // Skip first two header rows
			let rowData = {};
			let missingFields = [];

			// Parse columns into object
			for (let i = 1; i < row.values.length; i++) {
				const key = columnHeaderKeys[i - 1];
				rowData[key] = row.values[i] !== undefined ? row.values[i] : null;
			}

			let emailVal = rowData.emailId;
			if (emailVal && typeof emailVal === 'object') {
				rowData.emailId = emailVal.text || emailVal.hyperlink || null;
			} else if (emailVal && typeof emailVal === 'string') {
				rowData.emailId = emailVal;
			}

			checkUnique('transportName', rowData.transportName, 'Transport Name', missingFields);
			checkUnique('emailId', rowData.emailId, 'Email Id', missingFields);
			checkUnique('phone', rowData.phone, 'Phone', missingFields);

			const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
			const phoneRegex = /^[0-9]{10}$/;
			if (!emailRegex.test(rowData.emailId)) {
				missingFields.push(`Invalid Email Id format. Example: example@gmail.com.`);
			}
			if (!phoneRegex.test(rowData.phone)) {
				missingFields.push(`Invalid Phone No. It must be exactly 10 digits.`);
			}

			if (rowData.transportName && typeof rowData.transportName != 'string') {
				missingFields.push(`Invalid Transport Name. It should be text.`);
			}

			// Dynamically find maxGroups instead of hardcoding
			const groupKeys = Object.keys(rowData).filter(key => /^vehicleGroup\d+/i.test(key));
			const groupNumbers = [...new Set(groupKeys.map(k => parseInt(k.match(/\d+/)[0])))];
			const maxGroups = Math.max(...groupNumbers);

			// Extract vehicle group data dynamically
			let vehicleGroups = [];
			for (let g = 1; g <= maxGroups; g++) {
				let macthedSegment = segments.find(x => x.text == rowData[`vehicleGroup${g}Segment`]) || {};
				let macthedApplication = applications.find(x => x.text == rowData[`vehicleGroup${g}Application`]) || {};
				let group = {
					wheeler: rowData[`vehicleGroup${g}Wheeler`] || null,
					config: rowData[`vehicleGroup${g}Config`] || null,
					name: rowData[`vehicleGroup${g}Name`] || null,
					vehicles: rowData[`vehicleGroup${g}VehicleCount`] || null,
					segment: macthedSegment.text || null,
					application: macthedApplication.text || null,
					payload: rowData[`vehicleGroup${g}Payload`] || null
				};
				const isVehGrpFieldFound = group.wheeler || group.config || group.name || group.vehicles || group.segment || group.application || group.payload;

				if (isVehGrpFieldFound) {
					if (!group.wheeler) missingFields.push(`Wheeler is required for Vehicle Group ${g}`);
					if (!group.config) missingFields.push(`Config is required for Vehicle Group ${g}`);
					if (!group.name) missingFields.push(`Name is required for Vehicle Group ${g}`);
					if (!group.vehicles) missingFields.push(`Vehicle Count is required for Vehicle Group ${g}`);
					if (!group.segment) missingFields.push(`Segment is required for Vehicle Group ${g}`);
					if (!group.application) missingFields.push(`Application is required for Vehicle Group ${g}`);
					if (!group.payload) missingFields.push(`Payload is required for Vehicle Group ${g}`);
				}
				vehicleGroups.push(group);

				// Validate wheeler, config and name 
				let { wheeler, config, name } = group;
				if (wheeler && config && name) {
					if (!axleConfig[wheeler]) { // Check wheeler
						missingFields.push(`Invalid wheeler for vehicle group ${g}: ${wheeler}`);
					} else if (!axleConfig[wheeler][config]) {   // Check config inside wheeler
						missingFields.push(`Invalid config for vehicle group ${g}: ${config}`);
					} else if (!axleConfig[wheeler][config].some(c => c.name === name)) {  // Check name inside config
						missingFields.push(`Invalid name for vehicle group ${g}: ${name}`);
					}
				}

				// Cleanup flat keys to avoid duplication
				delete rowData[`vehicleGroup${g}Wheeler`];
				delete rowData[`vehicleGroup${g}Config`];
				delete rowData[`vehicleGroup${g}Name`];
				delete rowData[`vehicleGroup${g}VehicleCount`];
				delete rowData[`vehicleGroup${g}Segment`];
				delete rowData[`vehicleGroup${g}Application`];
				delete rowData[`vehicleGroup${g}Payload`];
			}
			rowData.vehicleGroups = vehicleGroups;
			rowData.maxGroups = maxGroups;
			// Count vehicleCount
			let groupVehicleCount = vehicleGroups.reduce((sum, g) => {
				return sum + (parseInt(g.vehicles) || 0);
			}, 0);

			// Get totalVehicleCount
			let totalVehicleCount = rowData.totalVehicleCount !== undefined && rowData.totalVehicleCount !== null ? parseInt(rowData.totalVehicleCount) || 0 : null;

			// check totalVehicleCount and groups vehicleCount
			if (totalVehicleCount !== null && groupVehicleCount !== totalVehicleCount) {
				missingFields.push(`Total vehicle count mismatch: Expected ${totalVehicleCount}, found ${groupVehicleCount}`);
			}

			// Validate mandatory fields
			mandatoryColumns.forEach(col => {
				if (
					row.values[col.index] === undefined ||
					row.values[col.index] === null ||
					row.values[col.index].toString().trim() === ''
				) {
					missingFields.push(`${col.header} is missing`);
				}
			});

			if (missingFields.length > 0) {
				rowData.remark = missingFields.join(', ');
				isRequirePreview = true;
				preview.push(rowData);
			} else {
				preview.push(rowData);
				excelData.push(rowData);
			}
		});

		fs.unlink(req.file.path, err => { if (err) console.error(err); });

		if (isRequirePreview && preview && preview.length > 0) {
			return res.send({ success: false, error: 'Some value are incorrect or missing, Please correct it & retry.', preview });
		}

		const latestFTSCust = await models.Account.findOne({
			attributes: ['name'],
			where: {
				AccountIdParent: res.locals.masterAccountId,
				'details.avolve': false,
				name: { [Op.like]: '%FTS%' }
			},
			order: [[models.sequelize.literal("CAST(REGEXP_REPLACE(name, '\\D', '', 'g') AS BIGINT)"), 'DESC']],
			raw: true
		});

		if (!latestFTSCust) {
			return res.send({ success: false, error: "Unable to fetch last customer series No. Please contact support.", preview: excelData });
		}

		let lastNum = 0;
		if (latestFTSCust.name) {
			const match = latestFTSCust.name.match(/\d+$/);
			lastNum = match ? parseInt(match[0], 10) : 0;
		}

		let accountNames = excelData.map(x => x.transportName.trim());
		let existingAccounts = await models.Account.findAll({
			attributes: ['tname'],
			where: { tname: accountNames },
			raw: true
		});

		let existingNamesSet = new Set(existingAccounts.map(acc => acc.tname.trim().toLowerCase()));
		excelData = excelData.map(row => {
			let remarks = [];
			if (existingNamesSet.has(row.transportName.trim().toLowerCase())) {
				remarks.push(`Customer ${row.transportName} already exists`);
			}

			return { ...row, remark: remarks.length ? remarks.join(', ') : row.remark || '' };
		});

		let hasDuplicates = excelData.some(row => row.remark && row.remark.includes('already exists'));
		if (preview.length && hasDuplicates) {
			return res.send({ success: false, error: 'Duplicate Transport Name found in system', preview: excelData });
		}

		if (req.body.preview == "true") {
			return res.send({ success: true, data: excelData });
		}

		const startDate = moment().startOf('day');
		const endDate = moment(startDate).add(1, 'year').endOf('month');
		const accountDetails = {};

		// Final result arrays
		let successRows = [];
		let failedRows = [];

		// Process customers one by one
		for (const cust of excelData) {
			try {
				await models.sequelize.transaction(async (t) => {
					const nextMdgNum = ++lastNum;
					cust.mdgId = `00000FTS${nextMdgNum}`;

					const offerDetails = {
						vehicles: cust.totalVehicleCount,
						offerType: "Xpert Edge",
						subOfferType: "Shared",
						operations: {
							startDate: startDate.format("YYYY-MM-DD"),
							endDate: endDate.format("YYYY-MM-DD"),
							vehicles: cust.totalVehicleCount,
							vehicleGroups: cust.vehicleGroups
						}
					};

					const kttPlan = 4;
					accountDetails.plan = kttPlan;
					accountDetails.avolve = false;

					// Create Lead
					const Lead = await models.Lead.create({
						partnerAccount: res.locals.masterAccountId,
						custName: cust.ownerName,
						transportName: cust.transportName,
						contactName: "Shekhar Mishra",
						phone1: cust.phone,
						gst: cust.mdgId,
						email1: cust.emailId,
						leadSource: 9,
						subleadSource: "Avolve",
						followUpDate: moment().add(7, 'days'),
						comments: "Apollo Tyres MF customer.",
						details: accountDetails,
						baddress: cust.address,
						LeadBy: 1
					}, { transaction: t });

					// Create Account
					const Account = await models.Account.create({
						AccountIdParent: res.locals.masterAccountId,
						name: cust.mdgId,
						type: 11,
						tname: Lead.transportName,
						oname: Lead.custName,
						status: 1,
						phone1: Lead.phone1,
						email1: Lead.email1,
						city: "Corporate",
						baddress: Lead.baddress ? Lead.baddress.toUpperCase() : '',
						gst: Lead.gst,
						EmployeeIdLeadSource: 1,
						EmployeeIdRM: 1,
						EmployeeIdCT: 1,
						EmployeeIdBDM: 1,
						EmployeeIdTC: 1,
						anote: Lead.comments,
						details: accountDetails
					}, { returning: true, transaction: t });

					await Lead.update({ AccountId: Account.id }, { transaction: t });

					// Log creation
					RaiseLogEvent(ROUTE, cust.mdgId, { AccountId: Account.id, LeadId: Lead.id }, 'Response');

					// Attach AccountId to offerDetails
					offerDetails.operations.AccountId = Account.id;

					// Create Offer
					await models.AplOffer.create({
						AccountId: Account.id,
						offerId: req.body.opprtunityId || '',
						offer: kttPlan,
						details: offerDetails,
						status: 'Active',
						startDate: startDate.format("YYYY-MM-DD"),
						endDate: endDate.format("YYYY-MM-DD"),
						offerType: req.body.offerType || '',
						subOfferType: "Shared",
						assetIds: []
					}, { transaction: t });

					evt.events.emit("create-apollo-service-types", { AccountId: Account.id });

					let users = [{
						role: "Admin",
						firstName: cust.ownerName,
						username: `${cust.transportName}admin`.toLowerCase(),
						password: cust.phone,
						mobile: cust.phone,
						email: cust.emailId
					}];

					evt.events.emit("create-avolve-users", { AccountId: Account.id, users: users, mdgId: Account.name, isFTS: true });
				});

				// Push into success if everything went fine
				successRows.push({ ...cust, remark: "" });

			} catch (err) {
				// Capture error per customer
				console.log(`Error in ${ROUTE}: ${err}`);
				RaiseLogEvent(ROUTE, 'error', err, `Error creating customer ${cust.transportName}`);
				cust.remark = "Failed to create customer. Please contact support.";
				failedRows.push(cust);
			}
		}

		// Decide response
		if (failedRows.length > 0) {
			return res.send({ success: false, error: "Some customers could not be created. Please review and retry.", preview: failedRows.concat(successRows) });
		} else {
			return res.send({ success: true, result: successRows });
		}

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error creating customers', err);
	}
}

exports.count = async function (req, res) {
	const ROUTE = 'app/accounts/count';
	try {
		if (!['KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not authorized' });
		}

		let accountIds = res.locals.accountIds;
		let custResult = await avolveHelper.getCustomersByUser(res.locals.UserId, false, res.locals.masterAccountId);
		if (custResult.success && custResult.results.length) {
			accountIds = custResult.results.map(x => x.id);
		}

		let tisCreated = await models.Account.count({
			where: {
				AccountIdParent: res.locals.masterAccountId,
				status: 1, //active
				'details.channel': 1,
				id: accountIds
			},
			raw : true
		});

		let draft = await models.AplAccountDraft.count({
			where: {
				status: [1, 2], // drafted, partially completed
				AccountId: accountIds
			},
			raw : true
		});

		return res.send({ success: true, result: { created: tisCreated, draft: draft } });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching customers count', error);
	}
}

exports.vehicleGroupsList = async function (req, res) {
	const ROUTE = 'app/accounts/vehicleGroupsList';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId || !['KAM', 'FTS KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		if (!req.query.AccountId) {
			return res.send({ success: false, error: 'Input Parameter missing' });
		}

		let { details } = await redisHelper.getAccount(Number(req.query.AccountId));
		if ((details && (!details.avolve || details.avolve == 'false') || details.testAcc) || avolveHelper.isFTSUser(res.locals.role)) {
			return res.send({ success: true, axleConfig });
		}

		let AplOffer = await models.AplOffer.findOne({
			attributes: ['id', 'details'],
			where: { AccountId: req.query.AccountId },
			raw: true,
			order: [['id', 'desc']]
		});

		if (!AplOffer) {
			return res.send({ success: false, error: 'Offer not found' });
		}

		let operations = AplOffer.details.operations && AplOffer.details.operations || {};
		let vehicleGroups = (operations && operations.vehicleGroups) || (AplOffer.details && AplOffer.details.vehicleGroups) || [];

		let matchedAxleConfig = {};

		function normalizeString(str) {
			return str.replace(/\s+/g, '').replace(/\*/g, 'x').toLowerCase();
		}

		for (const vg of vehicleGroups) {
			const wheeler = vg.wheeler.replace(/\s+/g, '').toUpperCase();
			const config = vg.config.replace(/\*/g, 'x');
			const normalizedName = normalizeString(vg.name);

			if (!axleConfig[wheeler]) {
				continue;
			}

			if (!axleConfig[wheeler][config]) {
				continue;
			}

			const matchedConfigArr = axleConfig[wheeler][config].filter(item => {
				const masterName = normalizeString(item.name);
				const isMatch = masterName === normalizedName;
				return isMatch;
			});

			if (matchedConfigArr.length > 0) {
				if (!matchedAxleConfig[wheeler]) {
					matchedAxleConfig[wheeler] = {};
				}

				if (!matchedAxleConfig[wheeler][config]) {
					matchedAxleConfig[wheeler][config] = [];
				}

				matchedConfigArr.forEach(newItem => {
					const exists = matchedAxleConfig[wheeler][config].some(
						existing => normalizeString(existing.name) === normalizeString(newItem.name)
					);
					if (!exists) {
						matchedAxleConfig[wheeler][config].push(newItem);
					}
				});
			}
		}

		return res.send({ success: true, axleConfig: matchedAxleConfig });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching vehicle groups', err);
	}
}

exports.draftList = async function (req, res) {
	const ROUTE = 'app/accounts/draftList';
	try {
		if (!['KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not authorized' });
		}

		let accountIds = res.locals.accountIds;
		let custResult = await avolveHelper.getCustomersByUser(res.locals.UserId, false, res.locals.masterAccountId);
		if (custResult.success && custResult.results.length) {
			accountIds = custResult.results.map(x => x.id);
		}

		let accountDraftWhere = {
			status: [1, 2], //drafted
			AccountId: accountIds
		}

		if (req.query.status) {
			if (req.query.status == 1) {
				accountDraftWhere.status = 1;
			} else {
				accountDraftWhere.status = 2;
			}
		}

		let AplAccountDrafts = await models.AplAccountDraft.findAll({
			attributes: ['id', 'AccountId', 'status',
				[models.sequelize.literal(`"details"->>'tname'`), 'tname'],
				[models.sequelize.literal(`"details"->>'mdgId'`), 'mdgId']
			],
			where: accountDraftWhere,
			raw: true
		});

		return res.send({ success: true, results: AplAccountDrafts });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching accounts drafts', error);
	}
}

exports.getDraftAccount = async function (req, res) {
	const ROUTE = 'app/accounts/getDraftAccount';
	try {
		if (!['KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not authorized' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let AplAccountDraft = await models.AplAccountDraft.findOne({
			attributes: ['id', 'AccountId', 'details'],
			where: {
				id: req.params.id
			},
			raw: true
		});

		if (!AplAccountDraft) {
			return res.send({ success: false, error: 'Draft account not found' });
		}

		let result = {
			id: AplAccountDraft.id,
			AccountId: AplAccountDraft.AccountId,
			...AplAccountDraft.details
		};

		return res.send({ success: true, result: result });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching draft account', error);
	}
}

exports.draftUpdate = async function (req, res) {
	const ROUTE = 'app/accounts/draftUpdate';
	try {
		const { AccountId, mdgId } = req.body;
		RaiseLogEvent(ROUTE, mdgId, req.body, `Requested by ${res.local.userFullName} (${res.locsls.UserId})`);

		if (res.locals.role != 'KAM') {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		const AccountDraft = await models.AplAccountDraft.findOne({
			attributes: ['id', 'details', 'status'],
			where: { id: req.params.id, AccountId },
		});

		if (!AccountDraft) {
			return res.send({ success: false, error: 'Draft account not found.' });
		}

		if (AccountDraft.status && AccountDraft.status == 3) { //created
			return res.send({ success: false, error: "Customer details have already been submitted. Please get back to the draft list." });
		}

		const Account = await models.Account.findOne({
			attributes: ['id', 'name'],
			where: { id: AccountId },
			raw: true,
		});

		if (!Account) {
			return res.send({ success: false, error: 'Account not found.' });
		}

		// Compare new vs old details
		const changedKeys = findJsonDifferences(req.body, AccountDraft.details);
		let details = req.body && JSON.parse(JSON.stringify(req.body)) || {};
		delete details.id;
		delete details.AccountId;
		if (changedKeys.length) {
			await AccountDraft.update({ details: details, status: 2 });
		}

		return res.send({ success: true });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error updating draft account', err);
	}
}

exports.tisCreate = async function (req, res) {
	const ROUTE = 'app/accounts/tisCreate';
	try {
		RaiseLogEvent(ROUTE, req.body.mdgId, req.body, `Requested by ${res.local.userFullName} (${res.locsls.UserId})`);
		if (res.locals.role != 'KAM') {
			return res.send({ success: false, error: 'Not authorized to this API.' });
		}

		let { config } = await redisHelper.getAccount(res.locals.masterAccountId);
		let validationResult = await validateCustomerPayload(req.body, config);
		if (!validationResult.success || validationResult.error) {
			return res.send({ success: false, error: validationResult.error || 'Error validating customer data' });
		}
		if (!validationResult.tyresInOffer) {
			return res.send({ success: false, error: 'Tyre condition count is missing for selected slab' });
		}

		if (req.body.vendors && req.body.vendors.length) {
			let MasterVendor = await models.AplVendor.findOne({
				attributes: ['id', 'vendorCode'],
				where: {
					vendorCode: req.body.vendors.map(x => String(x.code)),
					AccountId: res.locals.masterAccountId
				}
			});
			if (MasterVendor) {
				return res.send({ success: false, error: `Vendor code (${MasterVendor.vendorCode}) already found.` });
			}
		}

		let AplAccountDraft = await models.AplAccountDraft.findOne({
			attributes: ['id', 'details'],
			where: {
				id: req.params.id,
				AccountId: req.body.AccountId
			}
		});

		if (!AplAccountDraft || !AplAccountDraft.details || !Object.keys(AplAccountDraft.details).length) {
			return res.send({ success: false, error: 'Account draft not found.' });
		}

		// Compare new vs old details
		const changedKeys = findJsonDifferences(req.body, AplAccountDraft.details);
		if (changedKeys.length) {
			await AplAccountDraft.update({ details: req.body });
		}

		let Account = await models.Account.findOne({
			attributes: ['id', 'name', 'details', 'createdAt'],
			where: {
				id: req.body.AccountId
			}
		});

		if (!Account) {
			return res.send({ success: false, error: `Account not found` });
		}

		let AplOffer = await models.AplOffer.count({
			where: {
				AccountId: Account.id,
				status: 'Active'
			}
		});

		if (AplOffer) {
			return res.send({ success: false, error: 'This customer already has an active offer.' });
		}

		let FTEUser = await models.User.findOne({
			attributes: ['id', 'accountIds', 'email', 'firstName', 'lastName', 'mobile'],
			include: [{
				attributes: [],
				model: models.UserRole,
				where: {
					name: 'XE FTE'
				}
			}],
			where: {
				id: req.body.fte
			}
		});

		if (!FTEUser) {
			return res.send({ success: false, error: 'FTE user not found' });
		}

		let KAMUser = await models.User.findOne({
			attributes: ['id', 'accountIds', 'email', 'firstName', 'lastName', 'mobile'],
			include: [{
				attributes: [],
				model: models.UserRole,
				where: {
					name: 'KAM'
				}
			}],
			where: {
				id: res.locals.UserId
			}
		});

		if (!KAMUser) {
			return res.send({ success: false, error: 'KAM user not found' });
		}

		let offer = req.body.offer;
		let subOfferType = 'Shared'
		if (offer.slab && [3, 4].includes(offer.slab)) {
			subOfferType = 'Captive';
		}

		const totalVehicleCount = (req.body.vehicleGroups || []).reduce((sum, group) => sum + (group.vehicles ? Number(group.vehicles) : 0), 0);
		let offerDetails = {
			custId: req.body.mdgId,
			vehicles: totalVehicleCount || 0,
			offerType: "Xpert Edge",
			subOfferType: subOfferType || '',
			tyresInOffer: validationResult.tyresInOffer,
			tyresOnbPerMonth: req.body.tyresOnbPerMonth,
			operations: {
				custId: req.body.mdgId,
				startDate: moment(req.body.deploymentDate).format("YYYY-MM-DD"),
				endDate: moment(req.body.deploymentDate).add(1, 'year').endOf('month').format("YYYY-MM-DD"),
				vehicles: totalVehicleCount || 0,
				paymentTerms: "Monthly",
				vehicleGroups: req.body.vehicleGroups,
				AccountId: Account.id
			}
		};

		let fteAccountIds = FTEUser.accountIds || [];
		let updateFTE = false;
		if (!fteAccountIds.some(x => x.id == req.body.fte)) {
			fteAccountIds.push({ id: String(Account.id), name: req.body.tname });
			updateFTE = true;
		}

		let kamAccountIds = KAMUser.accountIds || [];
		let updateKAM = false;
		if (!kamAccountIds.some(x => x.id == res.locals.UserId)) {
			kamAccountIds.push({ id: String(Account.id), name: req.body.tname });
			updateKAM = true;
		}

		let vendors = [];
		for (const vendor of req.body.vendors) {
			vendors.push({ ...vendor, vendorCode: vendor.code, AccountId: res.locals.masterAccountId, VendorCreatedBy: res.locals.UserId });
		}

		for (const vendor of req.body.stpDetails) {
			vendors.push({ ...vendor, vendorCode: vendor.code, AccountId: Account.id, type: 2, VendorCreatedBy: res.locals.UserId });
		}

		await models.sequelize.transaction(async t => {
			await Account.update({
				details: {
					avolve: true,
					channel: offer.plan || 1,
					plan: 4,
					slab: offer.slab || null
				}
			}, { returning: true, transaction: t });

			let Vendors = await models.AplVendor.bulkCreate(vendors, { returning: true, transaction: t });
			Vendors = Vendors.filter(x => x.AccountId == Account.id);

			let AplVendorsAccounts = [];
			for (const Vendor of Vendors) {
				AplVendorsAccounts.push({ AccountId: Account.id, AplVendorId: Vendor.id });
			}
			await models.AplVendorsAccount.bulkCreate(AplVendorsAccounts, { transaction: t });

			if (updateFTE) {
				await FTEUser.update({
					accountIds: fteAccountIds
				}, { transaction: t });
			}

			if (updateKAM) {
				await KAMUser.update({
					accountIds: kamAccountIds
				}, { transaction: t });
			}
			RaiseLogEvent(ROUTE, req.body.mdgId, { AccountId: Account.id }, `Response`);

			await AplAccountDraft.update({ status: 3 }, { transaction: t });

			await models.AplOffer.create({
				AccountId: Account.id,
				offer: 4, // Xpert Edge/Captive
				plan: offer.plan || 1,
				slab: offer.slab || null,
				details: offerDetails,
				status: 'Active',
				startDate: moment(req.body.deploymentDate).format("YYYY-MM-DD"),
				endDate: moment(req.body.deploymentDate).add(1, 'year').endOf('month').format("YYYY-MM-DD"),
				offerType: 'Xpert Edge',
				subOfferType: subOfferType || ''
			}, { transaction: t });

			// Create roles and users
			let users = [...req.body.users];
			let userBysSameAsFlag = {};

			// creating another user based on the isSameAsPrimaryUser flag
			for (const user of users) {
				if (user.isSameAsPrimaryUser) {
					delete user.isSameAsPrimaryUser;
					if (user.role == 'FM') {
						userBysSameAsFlag = { ...user, role: 'FO' };
					}
					if (user.role == 'FO') {
						userBysSameAsFlag = { ...user, role: 'FM' };
					}
				}
			}
			if (Object.keys(userBysSameAsFlag).length) {
				users.push(userBysSameAsFlag);
			}

			// Admin user object creation and password assignment
			const adminPass = (req.body.phoneNo && req.body.phoneNo.trim()) || req.body.users.find(u => u.mobile).mobile || '';
			users.unshift({
				role: "Admin",
				firstName: req.body.oname,
				username: req.body.tname,
				mobile: req.body.phoneNo,
				password: adminPass,
				email: req.body.email
			});
			for (const user of users) {
				user.geozones = req.body.workshops.filter(x => user.geozones && user.geozones.includes(x.id));
				user.username = (`${(user.username || user.firstName || '')
					.replace(/[\s.,'"@!#$%^&*()\-_=+{}\[\]:;<>?/\\|`~]/g, '')}tis${user.role}`
				).toLowerCase();
				if (!user.password) {
					user.password = String(user.mobile) || user.username || '';
				}
			}

			// user creation event
			evt.events.emit("create-avolve-users", { AccountId: Account.id, tname: req.body.tname, users: users, mdgId: req.body.mdgId, isFTS: false, FTEUser, KAMUser });

			// Create service types
			evt.events.emit("create-apollo-service-types", { AccountId: Account.id });

			// Create geozone
			let workshops = req.body.workshops || {};
			for (const workshop of workshops) {
				evt.events.emit("create-avolve-geozone", {
					AccountId: Account.id,
					lat: workshop.lat,
					lon: workshop.lon,
					kamId: KAMUser.id,
					name: workshop.name
				});
			}
		});

		return res.send({ success: true });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error creating customer', err);
	}
}

function findJsonDifferences(newData, oldData, parentKey = '') {
	let differences = [];
	for (const key in newData) {
		const fullKey = parentKey ? `${parentKey}.${key}` : key;
		const newValue = newData[key];
		const oldValue = oldData ? oldData[key] : undefined;

		if (Array.isArray(newValue) && Array.isArray(oldValue)) {
			// Compare arrays
			if (newValue.length !== oldValue.length) {
				differences.push(fullKey);
			} else {
				newValue.forEach((val, i) => {
					if (typeof val === 'object' && val !== null) {
						differences.push(
							...findJsonDifferences(val, oldValue[i], `${fullKey}[${i}]`)
						);
					} else if (val !== oldValue[i]) {
						differences.push(`${fullKey}[${i}]`);
					}
				});
			}
		} else if (typeof newValue === 'object' && newValue !== null) {
			// For nested objects
			differences.push(...findJsonDifferences(newValue, oldValue, fullKey));
		} else if (newValue !== oldValue) {
			// Direct value difference
			differences.push(fullKey);
		}
	}

	return differences;
}

async function validateCustomerPayload(cust, materConfig) {
	if (!cust) {
		return { success: false, error: "Customer data is missing." };
	}

	var offer = cust.offer || {};
	var workshops = cust.workshops || [];
	var vehicleGroups = Array.isArray(cust.vehicleGroups) ? cust.vehicleGroups : [];
	var users = Array.isArray(cust.users) ? cust.users : [];

	// Validate MDG
	if (!cust.mdgId) {
		return { success: false, error: "MDG Id not found for this customer." };
	}
	if (!cust.mdgId || !cust.mdgId.startsWith('00000')) {
		return { success: false, error: 'Please provide valid MDGID. Example: 00000xxxxx' };
	}
	if (cust.mdgId) {
		const pattern = /^0{5}.+$/; // 00000xxxxx
		if (!pattern.test(cust.mdgId.toString())) {
			return { success: false, error: 'Please provide valid MDGID. Example: 00000xxxxx' };
		}
	}

	// Basic customer details
	if (!cust.phoneNo) {
		return { success: false, error: "Please provide a customer mobile number." };
	}
	if (!cust.email) {
		return { success: false, error: "Please provide a customer email." };
	}
	if (!cust.address) {
		return { success: false, error: "Please provide a customer address." };
	}
	const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
	const phoneRegex = /^[0-9]{10}$/;
	if (!emailRegex.test(cust.email)) {
		return { success: false, error: "Please provide a valid customer email (e.g., example@gmail.com)." };
	}

	// Workshop Validation
	for (const workshop of workshops) {
		if (!workshop.name || workshop.name.trim() === '') {
			return { success: false, error: "Please provide the workshop name." };
		}
		if (!workshop.lat || !workshop.lon) {
			return { success: false, error: "Latitude/Longitude is require for the workshop." };
		}
	}

	// Offer Validation
	if (!offer.plan) {
		return { success: false, error: "Please select a valid offer plan." };
	}
	if (!offer.slab) {
		return { success: false, error: "Please select a slab." };
	}
	if (!offer.tyresOnbPerMonth) {
		return { success: false, error: "Please enter the committed tyre count." };
	}
	// Vehicle Groups Validation
	let hasLiftAxle = false;
	let positionCount = 0;
	if (!vehicleGroups.length) {
		return { success: false, error: "Please add at least one vehicle group." };
	} else {
		let totalVehCount = 0;
		for (var i = 0; i < vehicleGroups.length; i++) {
			var vg = vehicleGroups[i];
			var index = i + 1;
			if (!vg.name || vg.name.trim() === '') {
				return { success: false, error: `Select name for the vehicle group.` };
			}
			if (!vg.config || vg.config.trim() === '') {
				return { success: false, error: `Select configuration for the vehicle group.` };
			}
			if (!vg.segment || vg.segment.trim() === '') {
				return { success: false, error: `Select segment for the vehicle group.` };
			}
			if (!vg.wheeler || vg.wheeler.trim() === '') {
				return { success: false, error: `Select wheeler for the vehicle group.` };
			}
			if (!vg.application || vg.application.trim() === '') {
				return { success: false, error: `Select Application for the vehicle group.` };
			}
			if (!vg.vehicles) {
				return { success: false, error: `Vehicle group ${index}: Vehicle count is required.` };
			}
			if (!vg.payload) {
				return { success: false, error: `Vehicle group ${index}: Payload is required.` };
			}
			totalVehCount += Number(vg.vehicles);
			positionCount += Number(vg.wheeler.replace(/W/g, "").replace(/\s*or\s*/g, ", ").trim()) * Number(vg.vehicles);
		}
		if (/\blift\b/i.test(vg.name)) {
			hasLiftAxle = true;
		}
	}

	// FTE Validation
	if (!cust.fte) {
		return { success: false, error: "Please select an FTE to map." };
	}

	// Deployement date
	if (!cust.deploymentDate || cust.deploymentDate.trim() === '') {
		return { success: false, error: 'Deployment date is required.' };
	}

	// Users Validation
	if (!users.length) {
		return { success: false, error: "Please add at least one user contact." };
	} else {
		for (var j = 0; j < users.length; j++) {
			const user = users[j];
			const indexUser = j + 1;

			if (!user.role || user.role.trim() === '') {
				return { success: false, error: `User ${indexUser}: Role is required.` };
			}

			const role = user.role.trim().toUpperCase();
			const hasAnyField = user.firstName || user.lastName || user.mobile || user.email;

			// all fields mandatory
			if (role === 'FO' || hasAnyField) {
				if (!user.firstName || user.firstName.trim() === '') {
					return { success: false, error: `First name is required for ${role}.` };
				}
				if (!user.lastName || user.lastName.trim() === '') {
					return { success: false, error: `Last name is required for ${role}.` };
				}
				if (!user.mobile) {
					return { success: false, error: `Mobile number is required for ${role}.` };
				}
				if (!user.email || user.email.trim() === '') {
					return { success: false, error: `Email is required for ${role}.` };
				}
				if (!phoneRegex.test(user.mobile)) {
					return { success: false, error: `Invalid mobile number for ${user.role} user. It must be exactly 10 digits.` };
				}
				if (!emailRegex.test(user.email)) {
					return { success: false, error: `Invalid email for ${user.role} user. Please enter a valid email (e.g., example@gmail.com).` };
				}
			}
		}
	}

	let { slabsConfig } = await models.SystemConfig.findOne({
		attributes: [[models.sequelize.literal(`"data"->'slabs'`), 'slabsConfig']],
		where: {
			AccountId: res.locals.masterAccountId,
			module: 'Avolve',
			name: 'Offer Masters'
		},
		raw: true
	});

	if (!slabsConfig) {
		return res.send({ success: false, error: 'System config not found.' });
	}

	let matchedConfig = slabsConfig && slabsConfig.find(x => x.id == offer.slab) || {};
	let tyresInOffer = matchedConfig.offerTyreCount && Number(matchedConfig.offerTyreCount) || 0;

	if (!tyresInOffer) {
		return { success: false, error: `Tyres in offer count not found for plan ${matchedConfig.name}.` };
	}
	if (hasLiftAxle) {
		tyresInOffer += 100; // increase count 100 with the fixed slab based tyre condition count
	}
	if (positionCount >= tyresInOffer) {
		return { success: false, error: `The total tyres count exceed ${/\blift\b/i.test(vg.name) ? '' : '(' + tyresInOffer + ')'} tyres as per selected slab.` };
	}

	return { success: true, tyresInOffer: tyresInOffer };
}

exports.getOfferWeb = async function (req, res) {
	const ROUTE = 'app/accounts/getOfferWeb';
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
			raw : true
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
				AccountId: req.params.id
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
			startDate: AplOffer.startDate && moment(AplOffer.startDate).format('Do MMM YYYY') || "",
			endDate: AplOffer.endDate && moment(AplOffer.endDate).format('Do MMM YYYY') || "",
			status: status || '',
			channel: channel || null,
			slab: slab || null,
			totalOnbVehicles: totalOnbVehicles
		}

		return res.send({ success: true, result: result });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching customer offer', err);
	}
}

exports.offerUpdate = async (req, res) => {
	const ROUTE = 'app/accounts/offerUpdate';
	try {
		RaiseLogEvent(ROUTE, AplOffer, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.params.id || !req.body.AccountId) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let AplOffer = await models.AplOffer.findOne({
			attributes: ['id', 'details', 'AccountId', 'plan', 'slab'],
			where: {
				id: req.params.id,
				AccountId: req.body.AccountId
			},
			order: [['createdAt', 'desc']]
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
			}
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

		await AplOffer.update(toUpdate);
		return res.send({ success: true });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in updating offer', err);
	}
}

exports.listCustomers = async function (req, res) {
	const ROUTE = 'app/accounts/listCustomers';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { //Apollo Fleet
			return res.send({ success: false, error: 'Not authorized to this API' });
		}
		let accountWhere = {
			type: 11, //Apollo Fleet Customers
			AccountIdParent: res.locals.AccountId,
			status: 1
		};
		if (res.locals.role != "Admin") {
			accountWhere.id = res.locals?.accountIds?.length ? res.locals.accountIds : [];
		}
		if (res.locals.role == "KAM") {
			let custResult = await avolveHelper.getCustomersByUser(res.locals.UserId, true, res.locals.masterAccountId);
			if (custResult.success && custResult.results.length) {
				accountWhere.id = custResult.results.map(x => x.id);
			}
		}
		let vendors = await models.Account.findAll({
			attributes: ['id', 'name', 'tname', 'phone1',
				[models.sequelize.literal(`"Account"."details"->>'plan'`), 'plan'],
				[models.sequelize.literal(`"Account"."details"->>'avolve'`), 'avolve']
			],
			where: accountWhere,
			raw: true
		});

		let isFTSUser = avolveHelper.isFTSUser(res.locals.role);
		let mfCustomers = await avolveHelper.isMFCustomer(vendors.map(x => x.id));
		for (let vendor of vendors) {
			if (!isFTSUser) {
				vendor.isMf = vendor.avolve == 'true' ? mfCustomers[vendor.id] || false : false;
			}
			vendor.isAvolve = vendor.avolve && vendor.avolve == 'true' || false;
		}
		return res.send({ success: true, results: vendors });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching data', err);
	}
}

exports.serviceConfig = async function (req, res) {
	const ROUTE = 'app/accounts/serviceConfig';
	try {
		let Account = await models.Account.findOne({
			attributes: ['serviceConfig'],
			where: {
				id: res.locals.AccountId
			},
			raw: true
		});

		if (!Account) {
			res.send({ success: false, error: "Account not found" });
		}

		return res.send({ success: true, serviceConfig: Account.serviceConfig ? Account.serviceConfig : {} });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching serviceConfig', error);
	}
}

function toCamelCase(header) {
	const cleaned = header.toString().trim().replace(/\*/g, '').replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '');
	return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}