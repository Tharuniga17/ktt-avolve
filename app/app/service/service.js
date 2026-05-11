const models = require("../../../models");
const logger = require('../../../lib/helpers/rmqlog');
const avolveHelper = require('../../../lib/helpers/avolveHelper');

exports.getServices = async function (req, res) {
	const ROUTE = 'service/getServices';
	try {
		logger.RaiseLogEvent(ROUTE, res.locals.AccountId, req.query, `Requested by ${res.locals.username}`);

		if (['AMCS FTE', 'AMCC FTE', 'FM'].indexOf(res.locals.role) == -1 || (res.locals.role != 'FM' && res.locals.AccountId != res.locals.masterAccountId)) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		if (!req.query.lplate) {
			return res.send({ success: false, error: 'Missing input parmater.' });
		}

		let lplate = req.query.lplate.replace(/\s/g, '').toUpperCase();

		let whereClause = {
			lplate: lplate,
			active: true,
			remove: false
		}

		if (res.locals.role == "AMCC FTE") {
			let AccountIds = res.locals.accountIds;
			if (!AccountIds.length) {
				return res.send({ success: false, error: `Customer not mapped for this ${res.locals.role} user.` });
			}
			whereClause.AccountId = AccountIds; //AMCC
		}

		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			let geozoneResult = await avolveHelper.fetchGeozones(res);

			if (!geozoneResult.success) {
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			whereClause.plan = 1;
		}

		if (['FM'].indexOf(res.locals.role) > -1) {
			whereClause.AccountId = res.locals.AccountId;
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'AccountId', 'plan'],
			include: [{
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
			return res.send({ success: false, error: 'Vehicle not found in system.' });
		}

		if (res.locals.role == "AMCC FTE" && Asset.plan != 2) {
			return res.send({ success: false, error: 'AMC Captive offer not offered for this vehicle.' });
		}

		if (res.locals.role == "AMCS FTE" && Asset.plan != 1) {
			return res.send({ success: false, error: 'AMC Shared offer not offered for this vehicle.' });
		}

		let AplService = await models.AplService.findOne({
			attributes: ['id', 'AssetId', 'services'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			}
		});

		if (!AplService) {
			return res.send({ success: false, error: 'Service master not found for this vehicle.' });
		}

		let AplJobCard = await models.AplJobCard.findOne({
			attributes: ['id', 'AssetId', 'services'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			}
		});

		let result = JSON.parse(JSON.stringify(AplService));

		if (!AplJobCard) {
			result.services = AplService.services.filter(x => ["Onboarding Service", "Additional Service"].indexOf(x.serviceName) > -1);
		}

		return res.send({ success: true, result: result });

	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		logger.RaiseLogEvent(ROUTE, 'error', err, "Error in gate in");
		return res.send({ success: false, error: "Error in gate in" });
	}
}

exports.getSummaryContent = async function (req, res) {
	const ROUTE = 'service/getSummaryContent';
	let summary = {
		header: "Service Summary",
		headerContent: "Service execution includes both scheduled and adhoc services.",
		body: [
			{
				title: "Primary Services Execution:",
				content: "Service alerts directly triggered and assigned to you as the primary FTE."
			},
			{
				title: "Secondary Services Assigned:",
				content: "Services you have assigned to other secondary FTEs."
			},
			{
				title: "Secondary Service Execution:",
				content: "Services assigned to you as a secondary FTE by another primary FTE."
			}
		]
	};
	return res.send({ success: true, result: summary });
}

exports.list = async function (req, res) {
	const ROUTE = 'service/list ';
	try {
		let filters = req.query;
		let conditionalWhere = [];
		if (filters.visibility)
			conditionalWhere.push({
				[Op.or]: [{ visibility: filters.visibility }, { visibility: "G" }]
			});

		let Account = await models.Account.findOne({
			attributes: ['id', 'type', 'AccountIdParent'],
			where: {
				id: res.locals.AccountId
			}
		});

		let AccountId = res.locals.AccountId;
		if (Account && [10, 11].indexOf(Account.type) > -1) {
			if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
				let geozoneResult = await avolveHelper.fetchGeozones(res);
				if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
					res.GeozoneId = geozoneResult.geozones.map(x => x.id);
					let result = await avolveHelper.fetchCustomers(res);
					let accountIds = result && result.customers.map(x => x.id) || [];
					if (accountIds.length) {
						AccountId = accountIds;
					}
				}
				if (req.query.AccountId) {
					AccountId = req.query.AccountId;
				}
			}

			if (["XE FTE", "ARSA", "AMCC FTE"].indexOf(res.locals.role) > -1) {
				AccountId = res.locals.accountIds;
			}

			conditionalWhere.push(
				{ isActive: true },
				{ AccountId: AccountId },
				{ apollo: true }
			);
		} else {
			conditionalWhere.push(
				{ isActive: true },
				{ [Op.or]: [{ AccountId: AccountId }, { AccountId: null }] }
			);
		}

		let serviceTypes = await models.VehicleServiceType.findAll({
			where: conditionalWhere,
			order: [["sortOrder", "ASC"]]
		});

		let AplService = await models.AplService.findOne({
			attributes: ['id', 'services'],
			where: {
				AssetId: req.query.AssetId,
				AccountId: AccountId
			}
		});

		serviceTypes = JSON.parse(JSON.stringify(serviceTypes)) || [];
		let results = [];
		let checkDuplicate = new Set();
		if (serviceTypes.length) {
			for (const serviceType of serviceTypes) {
				if (checkDuplicate.has(serviceType.serviceName)) {
					continue;
				}
				checkDuplicate.add(serviceType.serviceName);
				let matchedService = AplService && AplService.services && AplService.services.find(x => x.ServiceTypeId == serviceType.id) || {};
				if (matchedService && Object.keys(matchedService).length) {
					serviceType.consumed = matchedService.consumed >= matchedService.alloted;
				} else {
					serviceType.consumed = true;
				}
				results.push(serviceType);
			}
		}

		let serviceTypeResults = [];
		for (let i = 0; i < results.length; i++) {
			if (['Additional Service', 'En Route Tyre Replacement', 'En Route Tyre Rotation', 'Onboarding Service', 'Tyre Onboarding'].includes(serviceTypes[i].serviceName)) {
				continue;
			}
			let serviceType = JSON.parse(JSON.stringify(results[i]));
			serviceTypeResults.push(serviceType);
		}

		return res.send({ success: true, results: serviceTypeResults });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		logger.RaiseLogEvent(ROUTE, 'error', err, 'Error fetching service types.');
		return res.send({ success: false, error: 'Error fetching service types.' });
	}
}