const models = require("../../../models");
const logger = require('../../../lib/helpers/rmqlog');
const redisHelper = require('../../../lib/helpers/redis');
const moment = require('moment');
const { getCustomersByUser } = require("../../../lib/helpers/avolveHelper");
const { Op } = require("sequelize");
const { handleApiError } = require('../../middlewares/helper');

exports.list = async function (req, res) {
	const ROUTE = 'web/vendors/list';
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

exports.get = async function (req, res) {
	const ROUTE = 'web/vendors/get';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let whereClause = { id: req.params.id, AccountId: req.query.AccountId };

		if (req.query.status === 'true') {
			whereClause.status = true;
		} else if (req.query.status === 'false') {
			whereClause.status = false;
		}

		if (req.query.type) {
			whereClause.type = req.query.type;
		}

		let AplVendorsInclude = {};
		if (req.query.AccountId == res.locals.masterAccountId) {
			AplVendorsInclude = {
				include: [{
					model: models.Account,
					attributes: ["id"],
					through: { attributes: [] },
					as: 'AplCustomers'
				}]
			};
		}
		const AplVendor = await models.AplVendor.findOne({
			attributes: ['id', 'name', 'vendorCode', 'status', 'type', 'AccountId'],
			...AplVendorsInclude,
			where: whereClause
		});

		if (!AplVendor) {
			return res.send({ success: false, error: "vendor not found" });
		}

		return res.send({ success: true, result: AplVendor });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching vendor', err);
	}
}

exports.create = async function (req, res) {
	const ROUTE = 'web/vendors/create';
	try {
		logger.RaiseLogEvent(ROUTE, req.body.vendorCode || 'log', req.body, `Requested By: ${res.locals.userFullName} (${res.locals.UserId})`);

		let Account = await redisHelper.getAccount(res.locals.AccountId);
		if (!Account) {
			return res.send({ success: false, error: "Account not found" });
		}

		if (!req.body.name || !req.body.vendorCode) {
			return res.send({ success: false, error: "Name and Vendor Code are required" });
		}

		let MasterVendor = await models.AplVendor.findOne({
			attributes: ['id', 'vendorCode'],
			where: {
				vendorCode: req.body.vendorCode,
				AccountId: res.locals.AccountId
			},
			raw: true
		});
		if (MasterVendor) {
			return res.send({ success: false, error: `Vendor code (${MasterVendor.vendorCode}) already found.` });
		}

		const result = await models.sequelize.transaction(async (transaction) => {
			const AplVendor = await models.AplVendor.create({
				name: req.body.name,
				vendorCode: req.body.vendorCode || "",
				status: req.body.status,
				type: Number(req.body.type),
				AccountId: Number(req.body.type) == 2 ? req.body.accountIds[0] : res.locals.masterAccountId,
				VendorCreatedBy: res.locals.UserId,
				user: {
					createdBy: {
						id: res.locals.UserId,
						name: res.locals.username,
						role: res.locals.role,
						date: moment().toISOString()
					}
				}
			}, { transaction });

			if (req.body.type == 1) { // Dealer
				let AplVendorsAccounts = [];
				for (const accountId of req.body.accountIds) {
					AplVendorsAccounts.push({
						AplVendorId: AplVendor.id,
						AccountId: accountId
					});
				}
				if (AplVendorsAccounts.length) {
					await models.AplVendorsAccount.bulkCreate(AplVendorsAccounts, { transaction });
				}
			}

			return AplVendor;
		});

		return res.send({ success: true, vendor: result });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error creating vendor', err);
	}
}

exports.update = async function (req, res) {
	const ROUTE = 'web/vendors/update';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id || 'log', req.body, `Requested By: ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let Account = await redisHelper.getAccount(res.locals.AccountId);
		if (!Account) {
			return res.send({ success: false, error: "Account not found" });
		}

		let MasterVendor = await models.AplVendor.findOne({
			attributes: ['id', 'vendorCode'],
			where: {
				id: { [Op.ne]: req.params.id },
				vendorCode: req.body.vendorCode,
				AccountId: req.query.AccountId
			},
			raw: true
		});

		if (MasterVendor) {
			return res.send({ success: false, error: `Vendor code (${MasterVendor.vendorCode}) already found.` });
		}

		let AplVendor = await models.AplVendor.findOne({
			where: {
				id: req.params.id,
				AccountId: req.query.AccountId
			}
		});

		if (!AplVendor) {
			return res.send({ success: false, error: "vendor not found" });
		}

		let user = { ...AplVendor.user || {} };
		user.updatedBy = {
			id: res.locals.UserId,
			name: res.locals.username,
			role: res.locals.role,
			date: moment().toISOString()
		};

		let accountIds = req.body?.accountIds?.length ? req.body.accountIds.map(x => Number(x)) : [];
		await models.sequelize.transaction(async (t) => {
			if (req.body.type == 1) {
				// Fetch existing mappings
				const existingMappings = await models.AplVendorsAccount.findAll({
					attributes: ['AccountId'],
					where: {
						AplVendorId: req.params.id
					},
					transaction: t
				});

				const existingAccountIds = existingMappings.map(m => Number(m.AccountId));

				// Accounts to add
				const accountToAdd = accountIds.filter(id => !existingAccountIds.includes(Number(id)));

				// Accounts to remove
				const accountToRemove = existingAccountIds.filter(id => !accountIds.includes(Number(id)));

				// Bulk insert new mappings
				if (accountToAdd.length) {
					await models.AplVendorsAccount.bulkCreate(
						accountToAdd.map(accountId => ({
							AccountId: accountId,
							AplVendorId: AplVendor.id
						})),
						{ transaction: t }
					);
				}

				// Bulk delete removed mappings
				if (accountToRemove.length) {
					await models.AplVendorsAccount.destroy({
						where: {
							AplVendorId: AplVendor.id,
							AccountId: accountToRemove
						},
						transaction: t
					});
				}
			}

			await AplVendor.update({
				name: req.body.name,
				vendorCode: req.body.vendorCode || "",
				type: req.body.type,
				status: req.body.status,
				AccountId: Number(req.body.type) == 2 ? req.body.accountIds[0] : res.locals.masterAccountId,
				user: user
			}, { transaction: t });
		});

		return res.send({ success: true, vendor: AplVendor });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error updating vendors', err);
	}
}

exports.delete = async function (req, res) {
	const ROUTE = 'web/vendors/delete';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id || 'log', req.body, `Requested By: ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let AplVendor = await models.AplVendor.findOne({
			where: {
				id: req.params.id,
				AccountId: req.query.AccountId
			}
		});

		if (!AplVendor) {
			return res.send({ success: false, error: "vendor not found" });
		}

		await AplVendor.destroy();
		return res.send({ success: true });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error deleting vendors', err);
	}
}

exports.assignCustomers = async function (req, res) {
	const ROUTE = 'web/vendors/assignCustomers';
	try {
		logger.RaiseLogEvent(ROUTE, req.params.id, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		const vendorId = req.params.id;
		const { accountIds } = req.body;
		if (!vendorId) {
			return res.send({ success: false, error: 'Vendor id is required' });
		}

		if (!Array.isArray(accountIds)) {
			return res.send({ success: false, error: 'Invalid input' });
		}

		const Account = await redisHelper.getAccount(res.locals.AccountId);
		if (!Account) {
			return res.send({ success: false, error: 'Account not found' });
		}

		const vendor = await models.AplVendor.findOne({
			where: {
				id: vendorId,
				AccountId: req.query.AccountId
			}
		});

		if (!vendor) {
			return res.send({ success: false, error: 'Vendor not found' });
		}

		logger.RaiseLogEvent(ROUTE, 'info', { vendorId, accountIds }, `Vendor mapping request by user ${res.locals.userFullName} (${res.locals.UserId})`);

		await models.sequelize.transaction(async (t) => {
			// Fetch existing mappings
			const existingMappings = await models.AplVendorsAccount.findAll({
				attributes: ['AccountId'],
				where: {
					AplVendorId: vendorId
				},
				transaction: t
			});

			const existingAccountIds = existingMappings.map(m => Number(m.AccountId));

			// Accounts to add
			const accountToAdd = accountIds.filter(id => !existingAccountIds.includes(Number(id)));

			// Accounts to remove
			const accountToRemove = existingAccountIds.filter(id => !accountIds.includes(Number(id)));

			// Bulk insert new mappings
			if (accountToAdd.length) {
				await models.AplVendorsAccount.bulkCreate(
					accountToAdd.map(accountId => ({
						AccountId: accountId,
						AplVendorId: vendorId
					})),
					{ transaction: t }
				);
			}

			// Bulk delete removed mappings
			if (accountToRemove.length) {
				await models.AplVendorsAccount.destroy({
					where: {
						AplVendorId: vendorId,
						AccountId: accountToRemove
					},
					transaction: t
				});
			}
		});

		logger.RaiseLogEvent(ROUTE, 'info', { vendorId, accountIds }, `Vendor ${vendorId} successfully mapped to customers`);
		return res.send({ success: true });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error mapping vendor to customer', err);
	}
}