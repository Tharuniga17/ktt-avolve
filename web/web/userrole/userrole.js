const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const redisHelper = require('../../../lib/helpers/redis');
const { Op } = require('sequelize');
const { handleApiError } = require('../../middlewares/helper');
const models = require('../../../models');

exports.getByUser = async function (req, res) {
	const ROUTE = 'web/userroles/getByUser';
	try {
		if (!req.params.id) {
			return res.send({ success: false, message: "Input parameter missing." });
		}
		if (isNaN(req.params.id)) {
			return res.send({ success: false, message: "Input parameter invalid." });
		}

		let user, userRole, menus;
		// Fetch from redis
		const [userReply, Account] = await Promise.all([redisHelper.getUser(req.params.id), redisHelper.getAccount(res.locals.AccountId)]);

		user = userReply;
		if (!user) {
			return res.send({ success: false, userrole: {}, message: "User not found!" });
		}
		userRole = user.UserRole;
		if (!userRole) {
			return res.send({ success: false, userrole: {}, message: "User role not mapped" });
		}

		let userRoleMenus = userRole.menu ? userRole.menu.sidebar : [];
		// Fetch from redis
		let menusReply = await redisHelper.getMenus();

		menus = menusReply;

		if (userRole.name == "Admin") {
			userRoleMenus = menus.filter(x =>
				(x.accountIdsShow.length &&
					x.accountIdsShow.indexOf(userRole.AccountId) > -1 &&
					x.accountIdsHide.indexOf(userRole.AccountId) == -1)
				||
				(!x.accountIdsShow.length &&
					x.accountIdsHide.indexOf(userRole.AccountId) == -1)
			);
		}
		RaiseLogEvent('userrole/getByUser', req.params.id, userRole, 'Response');
		return res.send({
			success: true,
			userrole: userRole,
			userRoleMenus: userRoleMenus,
			tripConfig: (Account?.tripConfig) || {},
			tyreConfig: (Account?.config?.tyreConfig) || {},
			accountConfig: Account?.config || {}
		});
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching user role by user', err);
	}
}

exports.list = async function (req, res) {
	const ROUTE = 'web/userroles/list';
	try {
		const whereClause = { AccountId: res.locals.AccountId };

		if (res.locals.role == 'FTS Admin') {
			whereClause.name = {
				[Op.or]: [
					{ [Op.iLike]: '%FTS%' },
					{ [Op.eq]: 'ARSA' }
				]
			};
		}

		const UserRoles = await models.UserRole.findAll({
			where: whereClause,
			order: [['id', 'ASC']],
			raw: true
		});

		return res.send({ success: true, results: UserRoles });
	} catch (error) {
		handleApiError(res, ROUTE, 'Error fetching userroles', error);
	}
}

exports.getMenuList = async function (req, res) {
	const ROUTE = 'web/userroles/getMenuList';
	try {
		const Menus = await models.Menu.findAll({
			attributes: ['id', 'sequence', 'name', 'type', 'href', 'icon', 'components', 'parent', 'method', 'actions', 'accountIdsShow', 'accountIdsHide'],
			raw: true,
			where: {
				[Op.and]: models.Sequelize.literal(`CAST("actions" AS jsonb) @> '{"avolveFms": true}'`),
				accountIdsShow: { [Op.contains]: [res.locals.masterAccountId] },
				[Op.not]: {
					accountIdsHide: { [Op.contains]: [res.locals.masterAccountId] }
				}
			},
			order: [['sequence', 'ASC']],
			raw: true
		});

		return res.send({ success: true, results: Menus });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching menu list', error);
	}
}

exports.save = async function (req, res) {
	const ROUTE = 'web/userroles/save';
	try {
		RaiseLogEvent(ROUTE, 'request', req.body, `User: ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.body.name) {
			return res.status(401).send({ success: false, message: 'fields left empty' });
		}

		let Account = await redisHelper.getAccount(res.locals.AccountId);
		if (!Account) {
			return res.send({ success: false, message: 'Account not found' });
		}

		if (req.body.id == 'new' || req.body.id == '0') {
			let existingUserRole = await models.UserRole.count({
				where: {
					name: req.body.name,
					AccountId: res.locals.AccountId
				}
			});

			if (existingUserRole) {
				return res.send({ success: false, error: 'User Role already exists' });
			}

			let UserRole = await models.UserRole.create({
				name: req.body.name,
				menu: JSON.parse(req.body.menu),
				AccountId: res.locals.AccountId
			});
			return res.send({ success: true, reload: false, userRole: UserRole });
		} else if (req.body.id > 0) {
			let UserRole = await models.UserRole.findOne({
				attributes: ['id', 'name', 'menu', 'push', 'smsNotification', 'emailNotification', 'tripPush', 'accountsPush', 'servicePush', 'tyrePush', 'documentPush', 'AccountId'],
				where: {
					id: req.body.id
				}
			});
			if (!UserRole) {
				return res.send({ success: false, error: 'User Role not found' });
			}
			UserRole = await UserRole.update({
				name: req.body.name,
				menu: JSON.parse(req.body.menu),
				AccountId: res.locals.AccountId
			})
			let Users = await models.User.findAll({
				attributes: ['id'],
				where: {
					UserRoleId: UserRole.id,
					AccountId: res.locals.AccountId
				},
				raw: true
			});
			for (const user of Users) {
				await redisHelper.delUser(user.id);
			}
			return res.send({ success: true, reload: true, userRole: UserRole });
		}
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error saving user role', error);
	}
}

exports.delete = async function (req, res) {
	const ROUTE = 'web/userroles/delete';

	try {
		RaiseLogEvent(ROUTE, 'request', null, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		const roleId = req.params.id;
		if (!roleId) {
			return res.send({ success: false, message: "Input parameter missing." });
		}

		const userRole = await models.UserRole.findByPk(roleId);

		if (!userRole) {
			return res.send({ success: false, message: 'User Role not found' });
		}

		const usersCount = await models.User.count({
			where: { UserRoleId: roleId }
		});

		if (usersCount > 0) {
			return res.send({
				success: false,
				reload: false,
				message: 'Failed to delete..! This User Role is already assigned to users'
			});
		}

		await userRole.destroy();

		return res.send({
			success: true,
			reload: true,
			message: 'Deleted successfully'
		});

	} catch (error) {
		return handleApiError(res, ROUTE, 'Error deleting user role', error);
	}
};

exports.get = async function (req, res) {
	const ROUTE = 'web/userroles/get';
	try {
		if (!req.params.id) {
			return res.send({ success: false, message: "Input parameter missing." });
		}
		const Userrole = await models.UserRole.findOne({
			where: {
				id: req.params.id,
				AccountId: res.locals.AccountId
			},
			raw: true
		});

		if (!Userrole) {
			res.send({ success: false, error: 'User role not found', message: 'User role not found' });
		} else {
			res.send({ success: true, userrole: Userrole });
		}

	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching user role details', error);
	}
}