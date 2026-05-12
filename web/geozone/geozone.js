const models = require('../../../models');
const { Op } = require('sequelize');
const { handleApiError } = require('../../middlewares/helper');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { events } = require('../../../lib/event');

exports.list = async function (req, res) {
	const ROUTE = 'web/geozones/list';
	try {
		const whereClause = {
			AccountId: res.locals.AccountId,
			activeStatus: true
		};

		const Geozones = await models.Geozone.findAll({
			attributes: ['id', 'name', 'city', 'ztype', 'zoneCode'],
			where: whereClause
		});

		if (!Geozones) {
			return res.send({ success: false, results: [] });
		} else {
			return res.send({ success: true, results: Geozones });
		}
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching geozones', error);
	}
}

exports.listByType = async function (req, res) {
	const ROUTE = 'web/geozones/listByType';
	try {
		const whereClause = {
			AccountId: res.locals.AccountId,
			activeStatus: true,
		};
		if (req.query.ztypes && req.query.ztypes != '[]' && JSON.parse(req.query.ztypes)) {
			whereClause.ztype = JSON.parse(req.query.ztypes);
		}

		const Geozones = await models.Geozone.findAll({
			include: [{
				attributes: ['id', 'username'],
				model: models.User
			}, {
				attributes: ['username'],
				model: models.User,
				as: 'GeozoneCreatedBy',
				required: false
			}, {
				attributes: ['username'],
				model: models.User,
				as: 'GeozoneUpdatedBy',
				required: false
			}],
			where: whereClause,
			order: [["name", "ASC"]]
		});

		if (!Geozones) {
			return res.send({ success: false, results: [] });
		} else {
			return res.send({ success: true, results: Geozones });
		}
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching geozones by type', error);
	}
}

exports.zoneTypes = async function (req, res) {
	return res.send({
		success: true,
		results: {
			"33": "CV Zone",
			"35": "Third Party",
			"11": "Own Workshop"
		}
	})
}

exports.get = async function (req, res) {
	const ROUTE = 'web/geozones/get';
	try {
		if (!req.params.id || isNaN(req.params.id)) {
			return res.send({ success: false, error: 'Missing or invalid input parameter' });
		}

		const Geozone = await models.Geozone.findOne({
			include: [{
				attributes: ['id', 'username'],
				model: models.User
			}, {
				attributes: ['username'],
				model: models.User,
				as: 'GeozoneCreatedBy',
				required: false
			}, {
				attributes: ['username'],
				model: models.User,
				as: 'GeozoneUpdatedBy',
				required: false
			}],
			where: { AccountId: res.locals.AccountId, id: req.params.id }
		});

		if (!Geozone) {
			return res.send({ success: true, geozone: [] });
		} else {
			return res.send({ success: true, geozone: Geozone });
		}

	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching geozone details', error);
	}
}

exports.getCustomerList = async function (req, res) {
	const ROUTE = 'app/geozones/getCustomerList';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: "Missing or invalid input parameter" });
		}

		let Geozone = await models.Geozone.findOne({
			attributes: ['id', 'accountIds'],
			where: { id: req.params.id, AccountId: res.locals.AccountId },
			raw: true
		});

		return res.send({ success: true, results: Geozone });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching geozone customer list', err);
	}
}


exports.assignCustomer = async function (req, res) {
	const ROUTE = 'app/geozones/assignCustomer';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		if (res.locals.AccountId != res.locals.masterAccountId) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: "Missing or invalid input parameter." });
		}

		let Geozone = await models.Geozone.findOne({
			attributes: ['id', 'accountIds'],
			where: { id: req.params.id, AccountId: res.locals.AccountId }
		});

		if (!Geozone) {
			return res.send({ success: false, error: "Geozone not found" });
		}

		let User = await models.User.findOne({
			attributes: ['id', 'firstName', 'lastName', 'email', 'mobile'],
			include: [{
				attributes: [],
				model: models.AplUser,
				required: true,
				where: {
					geozones: { [Op.contains]: [{ id: Geozone.id }] }
				}
			}],
			where: {
				activeStatus: true,
				AccountId: res.locals.masterAccountId
			},
			raw: true
		});

		if (!User) {
			return res.send({ success: false, error: `Cannot assign customer. Please assign FTE for this CV Zone.` });
		}

		let Geozones = await models.Geozone.findAll({
			attributes: ['id', 'name', 'accountIds'],
			where: { AccountId: res.locals.AccountId },
			raw: true
		});

		let accountIds = req.body.accountIds && JSON.parse(req.body.accountIds) || [];

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'tname', 'name', [models.sequelize.literal(`"details"->>'avolve'`), 'avolve']],
			where: {
				id: { [Op.in]: accountIds.map(x => parseInt(x.id)) },
				AccountIdParent: res.locals.masterAccountId
			},
			raw: true
		});

		let alreadyExists = [];
		for (const account of accountIds) {
			let matchZone = Geozones.find(x => x.accountIds.find(y => y.id == account.id));
			if (!Geozone.accountIds.length || (matchZone && matchZone.id != Geozone.id)) {
				if (matchZone) {
					alreadyExists.push(`${account.name} already assigned to zone ${matchZone.name}`);
				}
			}
		}

		if (alreadyExists.length) {
			return res.send({ success: false, error: `${alreadyExists.join(', ')}` });
		}

		// Find newly assigned customers
		const userIdSet = new Set(Geozone.accountIds.map(acc => Number(acc.id)));
		const newCustomers = accountIds.filter(acc => !userIdSet.has(Number(acc.id)));
		RaiseLogEvent(ROUTE, User.id, newCustomers, `Newly assigned customers for AMCS FTE`);
		if (newCustomers.length) {
			let userData = {
				name: User.firstName ? `${User.firstName} ${User.lastName || ''}` : '',
			};
			for (const account of newCustomers) {
				let acc = Accounts.find(x => x.id == account.id);
				if (acc.avolve == 'false') {
					continue;
				}
				let data = { AccountId: acc.id, tname: acc.tname || '', mdgId: acc.name.split('_')[0] || '', user: userData, type: 'fteAssign' };
				events.emit('trigger-avolve-customer-mailer', data);
				RaiseLogEvent('trigger-avolve-customer-mailer', 'fteAssign', data, `Email triggered for fteAssign.`);
			}
		}

		await Geozone.update({
			accountIds: {[Op.in]: accountIds}
		});

		return res.send({ success: true, geozone: Geozone });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error assigning customer to geozone', err);
	}
}