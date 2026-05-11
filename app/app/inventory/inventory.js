const models = require('../../../models');
const { Op } = require('sequelize');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { handleApiError } = require('../../middlewares/helper');

exports.fetchBranches = async function (req, res) {
	const ROUTE = 'app/inventory/fetchBranches';
	try {
		var whereClause = {
			AccountId: res.locals.AccountId
		};

		if (req.query.status == "true") {
			whereClause.status = true;
		} else if (req.query.status == "false") {
			whereClause.status = false;
		}

		const UserBranch = await models.User.findOne({
			attributes: ['id', 'role', 'branchIds'],
			where: {
				id: res.locals.UserId
			},
			raw: true
		});

		if (Array.isArray(UserBranch.branchIds)) {
			whereClause.id = { [Op.in]: UserBranch.branchIds };
		} else if (UserBranch.branchIds) {
			whereClause.id = UserBranch.branchIds;
		}

		const Branches = await models.Branch.findAll({
			where: whereClause,
			order: [["name", "ASC"]],
			raw: true
		});

		return res.send({ success: true, results: Branches });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching branches', err);
	}
}