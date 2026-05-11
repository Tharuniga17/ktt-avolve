const models = require('../../../models');
const moment = require('moment');
const { getInsightDump } = require('../../../lib/helpers/avolveHelper');
const { Op } = require('sequelize');
const { handleApiError } = require('../../middlewares/helper');

exports.listDownloads = async function (req, res) {
	const ROUTE = 'app/insights/listDownloads';
	try {
		let insightWhere = {
			AccountId: res.locals.AccountId,
			UserId: res.locals.UserId,
			createdAt: { [Op.gte]: moment().subtract(4, 'days').toISOString() }
		}

		let Insights = await models.Insight.findAll({
			attributes: ['id', 'input', 'type', 'progress', 'createdAt'],
			where: insightWhere,
			order: [['createdAt', 'DESC']],
			raw: true
		});

		let accountIds = [...new Set(
			Insights.map(x => x.input && x.input.accountIds || []).flat().map(Number).filter(x => !isNaN(x))
		)];

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'tname'],
			where: { id: accountIds },
			raw: true
		});

		let AccountMap = new Map();
		for (const acc of Accounts) {
			AccountMap.set(acc.id, acc.tname);
		}

		let results = [];
		for (const Insight of Insights) {
			let input = Insight.input || {};
			if (!input.typeId) {
				continue;
			}
			if (!input.expireDate || moment(input.expireDate).isSameOrAfter(moment())) {
				let customers = []
				if (input.accountIds && !input.allCustomers) {
					if (Array.isArray(input.accountIds) && input.accountIds.length) {
						let accIds = input.accountIds.map(Number).filter(x => !isNaN(x));
						customers = accIds.map(id => AccountMap.get(id)).filter(Boolean);
					} else if (typeof input.accountIds === 'string' || typeof input.accountIds === 'number') {
						let id = Number(input.accountIds);
						if (!isNaN(id)) {
							let acc = AccountMap.get(id);
							if (acc) customers = [acc];
						}
					}
				}
				results.push({
					id: Insight.id,
					customers,
					progress: Insight.progress || 0,
					startTime: Insight.createdAt && moment(Insight.createdAt).format('DD MMM hh:mm A') || '',
					title: getInsightDump(input.typeId, 'title') || '',
					filePath: input.s3Path || null,
					noData: input.note && input.note == 'No data found' ? true : false
				});
			}
		}

		return res.send({ success: true, results: results });

	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching downloads', error);
	}
}