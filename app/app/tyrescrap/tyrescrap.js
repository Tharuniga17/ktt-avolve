const models = require("../../../models");
const moment = require("moment");
const evt = require('../../../lib/event');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');

exports.list = async function (req, res) {
	const ROUTE = 'app/tyrescraps/list';
	try {
		if (["XE FTE", "ARSA"].includes(res.locals.role) && !req.query.AccountId) {
			return res.send({ success: false, error: 'Please select customer to proceed.' });
		}

		const AccountId = req.query.AccountId || res.locals.AccountId;
		const tyreScraps = await models.TyreScrap.findAll({
			where: { status: 'Scrap', AccountId },
			order: [['tyreNo', 'ASC'], ['id', 'DESC']],
			raw: true
		});

		const unique = Object.values(tyreScraps.reduce((a, c) => { if (!a[c.tyreNo]) a[c.tyreNo] = c; return a; }, {}));
		return res.send({ success: true, results: unique });

	} catch (err) {
		console.log(`Error in ${ROUTE}`, err);
		RaiseLogEvent(ROUTE, res.locals.AccountId, err, `Error in API: ${err.message}`);
		return res.send({ success: false, results: [], error: 'Error fetching data' });
	}
};

exports.archivelist = async function (req, res) {
	const ROUTE = 'app/tyrescraps/archivelist';
	try {
		if (["XE FTE", "ARSA"].includes(res.locals.role) && !req.query.AccountId) {
			return res.send({ success: false, error: 'Please select customer to proceed.' });
		}

		const AccountId = req.query.AccountId || res.locals.AccountId;
		const tyreScraps = await models.TyreScrap.findAll({
			where: { status: 'Scrap Complete' },
			order: [['tyreNo', 'ASC'], ['id', 'DESC']],
			raw: true
		});

		const unique = Object.values(tyreScraps.reduce((a, c) => { if (!a[c.tyreNo]) a[c.tyreNo] = c; return a; }, {}));
		return res.send({ success: true, results: unique });

	} catch (err) {
		console.log(`Error in ${ROUTE}`, err);
		RaiseLogEvent(ROUTE, res.locals.AccountId, err, `Error in API: ${err.message}`);
		return res.send({ success: false, results: [], error: 'Error fetching data' });
	}
};

exports.scrapComplete = async function (req, res) {
	const ROUTE = 'app/tyrescraps/scrapComplete';
	try {
		if (!req.body.tyreData || !Object.keys(req.body.tyreData).length) return res.send({ success: false, error: 'Tyre data missing.', message: 'Tyre data missing.' });

		let tyreData; try { tyreData = JSON.parse(req.body.tyreData); } catch { return res.send({ success: false, error: 'Error parsing tyre data.', message: 'Error parsing tyre data.' }); }

		const tyreNumbers = tyreData.map(x => x.tyreNo);
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Total ${tyreNumbers.length} tyres received for scrap complete.`);

		let AccountId = res.locals.AccountId;
		if (["XE FTE", "ARSA", "AMCC FTE"].includes(res.locals.role)) AccountId = res.locals.accountIds;

		const tyres = await models.Tyre.findAll({
			include: [{
				model: models.Asset,
				attributes: ["id", "imei", "lplate", "odo"]

			}],
			where: {
				AccountId,
				tyreNo: { [models.Sequelize.Op.in]: tyreNumbers }
			}
		});

		if (!tyres.length) {
			return res.send({ success: false, error: 'Tyres not found.', message: 'Tyres not found.' });
		}

		const histDate = moment(req.body.date, "YYYY-MM-DD HH:mm:ss").isValid() ? moment(req.body.date, "YYYY-MM-DD HH:mm:ss") : moment();
		let tyreScrapStruct = [];

		await models.sequelize.transaction(async t => {
			const updated = await models.TyreScrap.update({
				scrapDate: histDate,
				soldTo: req.body.soldTo,
				amount: !isNaN(req.body.amount) ? req.body.amount : 0,
				paymentMode: req.body.paymentMode,
				comments: req.body.comments,
				status: "Scrap Complete"
			}, {
				where: {
					tyreNo: { [models.Sequelize.Op.in]: tyreNumbers }
				},
				returning: true,
				transaction: t
			});

			tyreScrapStruct = updated[1];

			const amountSplit = !isNaN(req.body.amount) ? req.body.amount / tyreNumbers.length : 0;

			const histBulk = tyres.map(tyre => ({
				tyreNo: tyre.tyreNo,
				transaction: "Scrap Complete",
				histDate,
				condition: tyre.lastStatus.condition || "",
				treadDepth: tyre.lastStatus.treadDepth || 0,
				tyreStatus: 6,
				inspectedBy: null,
				shopName: null,
				amount: amountSplit,
				tyreOdometer: tyre.lastStatus.tyreOdometer,
				stockLocation: tyre.lastStatus.stockLocation,
				AccountId: tyre.AccountId,
				BranchId: tyre.lastStatus.BranchId || null,
				comments: req.body.comments
			}));

			const tyreHistories = await models.TyreHistory.bulkCreate(histBulk, { returning: true, transaction: t });

			for (const tyre of tyres) {
				const tyreHist = tyreHistories.find(x => x.tyreNo == tyre.tyreNo);
				tyre.condition = "Archived"; tyre.tyreStatus = 6; tyre.lastStatus = tyreHist; tyre.AssetId = null; tyre.tpmsId = null; tyre.odometer = 0; tyre.installedOn = null;

				evt.events.emit('apl-reportlog', { AccountId: tyre.AccountId, reportValues: ['cs'], month: moment().format('MM'), year: moment().format('YYYY') });
				await tyre.save({ transaction: t });
			}
		});

		RaiseLogEvent(ROUTE, res.locals.AccountId, tyreScrapStruct.length, `Total of ${tyreScrapStruct.length} tyres moved to scrap complete.`);
		RecalculateCpkm(tyreNumbers, res.locals.AccountId);

		return res.send({ success: true, tyres, tyreScraps: tyreScrapStruct });

	} catch (err) {
		console.log(`Error in ${ROUTE}`, err);
		RaiseLogEvent(ROUTE, res.locals.AccountId, err, `Error in API: ${err.message}`);
		return res.send({ success: false, error: 'Could not process scrap.', message: 'Could not process scrap.' });
	}
};

function RecalculateCpkm(tyres, AccountId) {
	for (const tyreNo of tyres) {
		evt.events.emit('tyre-cpkm-refresh', { tyreNo: tyreNo, AccountId: AccountId });
	}
}

/**
 * Calculates the minimum tread depth across all grooves and returns the updated groove data.
 * @param {Object} grooves - An object containing groove depth measurements.
 * @param {number} latestDepth - The most recent depth value measured.
 * @returns {Object} - An object with original groove data and the minimum tread depth found.
 * Description:
 * This function determines the shallowest groove depth (minimum) from the provided groove depths. If groove depths are valid, it compares each depth value against `latestDepth` and updates the
 * tread depth accordingly. Useful for identifying worn-out tyres based on groove analysis.
 */
function getGroovesWiseDepth(grooves, latestDepth) {
	let treadDepth = latestDepth;
	if (grooves && grooves.depths && Object.keys(grooves.depths).length) {
		let depths = [];
		for (const depth in grooves.depths) {
			depths.push(Number(grooves.depths[depth]));
		}
		treadDepth = (Math.min(...depths)).toFixed(1);
	} else {
		grooves = {};
	}
	return { grooves, treadDepth };
}