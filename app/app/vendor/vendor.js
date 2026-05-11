const models = require("../../../models");
const logger = require('../../../lib/helpers/rmqlog');
const redisHelper = require('../../../lib/helpers/redis');
const moment = require('moment');
const { getCustomersByUser } = require("../../../lib/helpers/avolveHelper");
const { Op } = require("sequelize");
const { handleApiError } = require('../../middlewares/helper');

exports.list = async function (req, res) {
	const ROUTE = 'app/vendors/list';
	try {
		var whereClause = {
			AccountId: res.locals.AccountId
		};

		if (req.query.status === 'true') {
			whereClause.status = true;
		} else if (req.query.status === 'false') {
			whereClause.status = false;
		}

		if (req.query.type) {
			whereClause.type = req.query.type;
		}

		let vendorAccountsWhere = { required: false };
		if (res.locals.role == 'KAM') {
			let customers = await getCustomersByUser(res.locals.UserId, false, res.locals.masterAccountId) || {};
			let accountIds = customers.results && customers.results.map(x => x.id) || [];
			if (!accountIds.length) {
				return res.send({ success: true, results: [] });
			}
			vendorAccountsWhere.where = { id: accountIds };
		}

		let AplVendorsInclude = {};
		if (req.query.stp == 'true') {
			if (req.query.AccountId) {
				whereClause.AccountId = req.query.AccountId;
			}
		} else {
			AplVendorsInclude = {
				include: [{
					model: models.Account,
					attributes: ["tname", "id", "name"],
					through: { attributes: [] },
					as: 'AplCustomers',
					...vendorAccountsWhere
				}]
			};
		}

		const AplVendors = await models.AplVendor.findAll({
			attributes: ['id', 'name', 'vendorCode', 'type', 'status', 'AccountId'],
			...AplVendorsInclude,
			where: whereClause,
			order: [['createdAt', 'desc']]
		});

		return res.send({ success: true, results: AplVendors });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching vendors', err);
	}
}