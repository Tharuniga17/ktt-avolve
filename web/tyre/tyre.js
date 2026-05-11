'use strict';

const { Op, fn, col } = require('sequelize');
const models = require('../../../models');
const moment = require('moment');
const { events } = require('../../../lib/event')
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { fetchGeozones, fetchCustomers, validateNestedObj, tyreStatusLookUp, serviceStatusLookUp } = require('../../../lib/helpers/avolveHelper');
const { tyreStatusEnum } = require('../../../models/tyre');
const { isAdmin } = require('../../../lib/helpers/userroles')
const { formatByRegion } = require('../../../lib/dateFormatter')
const tyreCondition = require('../../../config/tyre-condition.json');
const { handleApiError } = require('../../middlewares/helper');

const MAX_PAGE_SIZE = 2000;
const DEFAULT_PAGE_SIZE = 100;

exports.get = async function (req, res) {
	const ROUTE = 'web/tyres/get';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Tyre Id missing.' });
		}
		const Tyre = await models.Tyre.findOne({
			where: {
				id: req.params.id
			}
		});

		if (!Tyre) {
			return res.send({ success: false, error: 'Tyre not found.' });
		}

		return res.send({ success: true, tyre: Tyre });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching tyre ', error);
	}
}

exports.list = async function (req, res) {
	const ROUTE = 'web/tyres/list';
	try {
		const AccountId = await resolveAccountIds(req, res);
		const baseWhere = buildBaseWhere(req.query, AccountId);
		const accountInclude = buildAccountInclude(req.query);

		// DataTables params
		const draw = parseInt(req.query.draw, 10) || 1;
		const length = Math.min(
			parseInt(req.query.length, 10) || DEFAULT_PAGE_SIZE,
			MAX_PAGE_SIZE
		);

		// Cursor params
		const direction = req.query.direction || 'next';
		const lastId = parseInt(req.query.lastId, 10) || null;   // smallest id seen
		const firstId = parseInt(req.query.firstId, 10) || null;   // largest  id seen

		// Build cursor WHERE on top of base filters
		// Using id (PK) — guaranteed sequential, always indexed, never null
		const dataWhere = { ...baseWhere };

		if (direction === 'next' && lastId) {
			// Moving forward: fetch rows with id < lastId (DESC order = next older batch)
			dataWhere.id = { [Op.lt]: lastId };
		} else if (direction === 'prev' && firstId) {
			// Moving back: fetch rows with id > firstId (ASC order, reversed after fetch)
			dataWhere.id = { [Op.gt]: firstId };
		}
		// First page: no cursor condition — start from the top

		const fetchOrder = direction === 'prev'
			? [['id', 'ASC']]    // ASC so we get the N rows just before firstId
			: [['id', 'DESC']];  // Standard DESC = newest first

		const paranoidOpt = req.query.removed === 'true'
			? { paranoid: false }   // include soft-deleted rows
			: {};

		// Run data fetch + grouped counts in parallel
		const [rows, groupCounts] = await Promise.all([

			// 1. Page data — cursor-bounded, no OFFSET
			models.Tyre.findAll({
				attributes: ['id', 'tyreNo', 'mfgBy', 'model', 'codeSize', 'purchasedOn', 'createdAt', 'amount', 'tyreStatus', 'condition', 'lastStatus', 'details'],
				include: [{
					model: models.Asset,
					attributes: ['id', 'lplate'],
					required: false
				}, accountInclude
				],
				where: dataWhere,
				order: fetchOrder,
				limit: length,
				...paranoidOpt,
				raw: false
			}),

			// 2. Stat counts — GROUP BY tyreStatus, no OFFSET, no cursor
			models.Tyre.findAll({
				attributes: [
					'tyreStatus',
					[fn('COUNT', col('Tyre.id')), 'count']
				],
				include: accountInclude.required ? [accountInclude] : [],
				where: baseWhere,
				group: ['tyreStatus'],
				...paranoidOpt,
				raw: true
			})
		]);

		// Prev direction — fetched ASC so the closest rows to firstId come last;
		// reverse to maintain consistent DESC presentation to the client
		if (direction === 'prev') rows.reverse();

		// Build stat map
		const countMap = Object.fromEntries(
			Object.keys(tyreStatusEnum).map(k => [k, 0])
		);
		let totalFiltered = 0;

		for (const row of groupCounts) {
			const status = parseInt(row.tyreStatus, 10);
			const n = parseInt(row.count, 10);
			totalFiltered += n;
			const key = Object.keys(tyreStatusEnum)
				.find(k => tyreStatusEnum[k] === status);
			if (key) countMap[key] = n;
		}

		// Cursor hints for client PaginationManager
		// Client stores these and sends them back on next/prev clicks
		const firstRowId = rows.length > 0 ? rows[0].id : null;
		const lastRowId = rows.length > 0 ? rows[rows.length - 1].id : null;
		const hasMore = rows.length === length; // if we got a full page, assume more exist

		const results = rows.map(serializeRow);

		return res.json({
			// DataTables serverSide required
			draw,
			recordsTotal: totalFiltered, // total matching filters (no cursor)
			recordsFiltered: totalFiltered,

			// Page data
			success: true,
			results,

			// Cursor hints
			pagination: {
				firstId: firstRowId, // largest  id on this page (for prev)
				lastId: lastRowId, // smallest id on this page (for next)
				hasMore,
				pageSize: length,
				count: results.length
			},

			// Stat counts (mirrors /tyres/count)
			stats: {
				total: totalFiltered,
				onboarded: totalFiltered,
				purchased: countMap.InStock || 0,
				running: countMap.InUse || 0,
				removed: countMap.Removed || 0,
				retreading: countMap.Retreading || 0,
				retreaded: countMap.Retreaded || 0,
				scrap: countMap.Scrap || 0,
				scrapped: countMap.ScrapComplete || 0
			}
		});

	} catch (error) {
		console.error(`Error in ${ROUTE}:`, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching tyres.');
		return res.json({
			draw: 0,
			recordsTotal: 0,
			recordsFiltered: 0,
			success: false,
			error: 'Error fetching tyres.'
		});
	}
}

/**
 * Resolve AccountId from role + query.
 * Returns a scalar id, an array of ids, or undefined (= all accounts).
 */
async function resolveAccountIds(req, res) {
	const role = res.locals.role;
	let AccountId = res.locals.AccountId;

	if (isAdmin(res.locals.role) && req.query.AccountId) {
		return req.query.AccountId;
	}

	if (role === 'AMCS FTE') {
		const geozoneResult = await fetchGeozones(res);
		if (geozoneResult?.geozones?.length) {
			res.GeozoneId = geozoneResult.geozones.map(x => x.id);
			if (req.query.GeozoneId) res.GeozoneId = req.query.GeozoneId;
			const result = await fetchCustomers(res);
			AccountId = result?.customers?.map(x => x.id) || [];
		}
	} else if (role === 'AMCC FTE') {
		AccountId = res.locals.accountIds;
	} else if (['XE FTE', 'ARSA'].includes(role)) {
		AccountId = req.query.AccountId || res.locals.accountIds;
	}

	if (!res.locals.isMasterAccount && !AccountId) {
		AccountId = res.locals.AccountId;
	} else {
		AccountId = null;
	}

	return AccountId;
}

/**
 * Build WHERE clause from filters.
 * Does NOT apply cursor conditions — those are added per-query.
 */
function buildBaseWhere(query, AccountId) {
	const where = {};

	// Account scope
	if (AccountId) {
		where.AccountId = Array.isArray(AccountId)
			? { [Op.in]: AccountId }
			: AccountId;
	}

	// Customer plan / sub-plan stored in Account — filtered via JOIN, not here
	// (pass through as include conditions if needed)

	// Tyre status
	if (query.status !== undefined && query.status !== '') {
		where.tyreStatus = parseInt(query.status, 10);
	}

	// MF tyre flag stored in JSONB details.mf
	if (query.mfTyres === 'true') {
		where['details.mf'] = true;
	} else if (query.mfTyres === 'false') {
		where['details.mf'] = { [Op.or]: [false, null] };
	}

	// Removed / soft-deleted tyres (paranoid = true by default)
	// When removed=true, include soft-deleted rows
	// Sequelize paranoid tables exclude deletedAt rows unless { paranoid: false }
	// We handle this in the findAll call, not in WHERE

	// Date range on purchasedOn
	if (query.sdate || query.edate) {
		where.purchasedOn = {};
		if (query.sdate) where.purchasedOn[Op.gte] = new Date(query.sdate);
		if (query.edate) where.purchasedOn[Op.lte] = new Date(query.edate);
	}

	// Tyre number search — prefix match, index-friendly
	if (query.search?.value) {
		where.tyreNo = { [Op.iLike]: `${query.search.value}%` };
	}

	return where;
}

/**
 * Build Account include with optional plan / subPlan / customerStatus filters.
 */
function buildAccountInclude(query) {
	const accountWhere = {};

	if (query.customerStatus) {
		// Assuming Account has an `active` boolean or similar field
		accountWhere.active = query.customerStatus === 'active';
	}

	if (query.plan) {
		accountWhere.plan = query.plan;
	}

	if (query.subPlan) {
		accountWhere.subPlan = query.subPlan;
	}

	return {
		model: models.Account,
		attributes: ['id', 'tname'],
		required: Object.keys(accountWhere).length > 0, // INNER JOIN only when filtering
		where: Object.keys(accountWhere).length > 0 ? accountWhere : undefined
	};
}

/**
 * Map a Tyre model instance to a flat result object for DataTables.
 */
function serializeRow(row) {
	const ls = row.lastStatus || {};
	return {
		id: row.id,
		tyreNo: row.tyreNo || '',
		mfgBy: row.mfgBy || '',
		model: row.model || '',
		codeSize: row.codeSize || '',
		purchasedOn: row.purchasedOn || '',
		createdAt: row.createdAt || '',
		amount: row.amount || 0,
		tyreStatus: row.tyreStatus,
		tyreStatusLabel: statusLabel(row.tyreStatus),
		condition: row.condition || '',
		position: ls.position || '',
		tyreOdometer: ls.tyreOdometer
			? Math.round(parseInt(ls.tyreOdometer, 10) / 1000)
			: 0,
		treadDepth: ls.treadDepth != null ? ls.treadDepth.toString() : '',
		isMfTyre: row.details?.mf || false,
		retreadDate: ls.retreadDate || '',
		retreadAmount: ls.retreadAmount || 0,
		// Dot-string keys — DataTables column.data reads these correctly
		'Asset.lplate': row.Asset?.lplate || '',
		Account: {
			id: row.Account?.id || null,
			tname: row.Account?.tname || ''
		}
	};
}

function statusLabel(status) {
	const labels = {
		[tyreStatusEnum.InStock]: 'In Stock',
		[tyreStatusEnum.InUse]: 'In Use',
		[tyreStatusEnum.Removed]: 'Removed',
		[tyreStatusEnum.Retreading]: 'Retreading',
		[tyreStatusEnum.Retreaded]: 'Retreaded',
		[tyreStatusEnum.Scrap]: 'Pending Decision',
		[tyreStatusEnum.ScrapComplete]: 'Scrapped'
	};
	return labels[status] ?? 'Unknown';
}

exports.getTyreHistory = async function (req, res) {
	const ROUTE = 'web/tyres/getTyreHistory';
	try {
		if (!req.params.tyreNo) {
			return res.json({ success: false, error: 'Tyre number is required.' });
		}

		const AccountId = await resolveAccountIds(req, res);
		let assetInclude = [];
		if (req.query.asset) {
			assetInclude = [{
				model: models.Asset,
				attributes: ['id', 'lplate', 'remove', 'active', 'details']
			}];
		}

		const TyreHistories = await models.TyreHistory.findAll({
			include: assetInclude,
			where: {
				tyreNo: req.params.tyreNo,
				AccountId: Array.isArray(AccountId) ? { [Op.in]: AccountId } : AccountId
			},
			order: [['id', 'DESC']]
		});

		return res.json({ success: true, results: TyreHistories });
	} catch (error) {
		console.error(`Error in ${ROUTE}:`, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching tyre history.');
		return res.json({ success: false, error: 'Error fetching tyre history.' });
	}
};

exports.listCustom = async function (req, res) {
	try {
		if (!isAdmin(res.locals.role) || !res.locals.isMasterAccount) {
			return res.send({ success: false, error: 'Not authorized' });
		}

		const whereClause = { AccountId: req.query.AccountId };
		if (req.query.AssetId) {
			whereClause.AssetId = req.query.AssetId;
		}

		const fieldsParam = (req.query.fields || 'id,tyreNo').toString();
		const fields = fieldsParam.split(',').map(f => f.trim()).filter(Boolean);
		const attributes = Array.from(new Set(fields));

		let Tyres = await models.Tyre.findAll({
			attributes: attributes,
			where: whereClause,
			raw: true
		});

		return res.send({ success: true, results: Tyres });
	} catch (error) {
		console.error(`Error in ${ROUTE}:`, error);
		RaiseLogEvent('avolve/tyres/listCustom', 'error', error, 'Error fetching tyres.');
		return res.send({ success: false, error: 'Error fetching tyres.' });
	}
}

exports.getTyresByAsset = async function (req, res) {
	const ROUTE = 'web/tyres/getTyresByAsset';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing Input parameter.' });
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'AccountId'],
			where: {
				id: req.params.id
			},
			raw: true
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'tyreNo', 'AccountId', 'lastStatus', 'tpmsData', 'tpmsId', 'createdAt'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			},
			order: [["id", "DESC"]],
			raw: true
		});

		let results = [];
		for (const tyre of Tyres) {
			let tpmsDisconnected = !tyre.tpmsData || !Object.keys(tyre.tpmsData).length;
			if (tyre.tpmsData?.TIME && moment().diff(moment(tyre.tpmsData.TIME), 'minutes') > 60) {
				tpmsDisconnected = true;
			}
			results.push({
				tyreNo: tyre.tyreNo,
				condition: tyre.lastStatus?.condition || '',
				position: tyre.lastStatus?.position || '',
				status: tyreStatusLookUp(parseInt(tyre.lastStatus?.tyreStatus || '')),
				tpmsId: tyre.tpmsId,
				tyreOdo: parseInt(tyre.lastStatus?.tyreOdometer) / 1000 || 0,
				tpmsStatus: tpmsDisconnected && 'TPMS Disconnected' || 'Active',
				tpmsTimeStamp: tyre.tpmsData?.TIME && moment(tyre.tpmsData.TIME) || '',
				onbDate: tyre.createdAt || ''
			});
		}

		return res.send({ success: true, results: results });
	} catch (error) {
		console.log(`${ROUTE}: ${error}`);
		RaiseLogEvent('${ROUTE}', 'error', error, 'Error fetching tyre by Asset.');
		return res.send({ success: false, error: 'Error fetching tyre by Asset.' });
	}
}

exports.updateHistories = async function (req, res) {
	const ROUTE = "web/tyres/updateHistories";
	try {
		RaiseLogEvent(ROUTE, req.body.tyreNo || res.locals.AccountId, req.body, `History Correction - Requested by ${res.locals.Username}`);

		if (!req.body.tyreData || !req.body.tyreData.length || !req.body.tyreNo) {
			return res.send({ success: false, error: 'Input data missing.' });
		}

		let Tyre = await models.Tyre.findOne({
			attributes: ['id', 'tyreNo', 'AssetId', 'lastStatus', 'AccountId', 'tyreOdo', 'odometer', 'lastWorkDone'],
			where: {
				tyreNo: req.body.tyreNo,
				AccountId: req.body.AccountId
			}
		});

		if (!Tyre) {
			return res.send({ success: false, error: 'Tyre not found.' });
		}

		let TyreHistories = await models.TyreHistory.findAll({
			attributes: ['id', 'tyreNo', 'AssetId', 'transaction', 'position', 'odometer', 'tyreOdometer', 'histDate', 'treadDepth', 'details'],
			where: {
				tyreNo: Tyre.tyreNo,
				AccountId: Tyre.AccountId
			},
			order: [['histDate', 'ASC']]
		});

		if (!TyreHistories.length) {
			return res.send({ success: false, error: 'Tyre Histories not found.' });
		}

		let remarks = {};
		req.body.tyreData = req.body.tyreData.sort((a, b) => {
			return new Date(a.histDate) - new Date(b.histDate);
		});

		let validateTyreHist = false;
		for (let i = 0; i < req.body.tyreData.length; i++) {
			let currHist = req.body.tyreData[i];
			let prevHist = req.body.tyreData[i - 1];
			let isDateValidated = false;
			let remark = '';
			if (prevHist && prevHist.histDate == currHist.histDate) {
				remark = `Tyre transaction date cannot be same for multiple transactions.`;
				isDateValidated = true;
			}
			if (currHist.transaction == 'Purchase' && prevHist && Object.keys(prevHist).length) {
				remark = `Purchase must be the initial transaction for a tyre. Please verify and correct the transaction order.`;
				isDateValidated = true;
			}
			if (currHist.transaction == 'Fitment' && prevHist && !['Remove', 'Retread Recd', 'Purchase'].includes(prevHist.transaction)) {
				remark = `Fitment can only be performed when the tyre is in 'In Stock' status. The previous transaction '${prevHist.transaction}' does not allow fitment. Please correct the transaction order.`;
				isDateValidated = true;
			}
			if (currHist.transaction == 'Retread Recd' && prevHist && prevHist.transaction != 'Retread Sent') {
				remark = `Tyre cannot be marked as 'Retread Received' without 'Retread Sent' transaction. Please correct the transaction order.`;
				isDateValidated = true;
			}

			if (currHist.transaction == 'Remove' && prevHist && ['Retread Recd', 'Remove', 'Purchase', 'Retread Sent'].includes(prevHist.transaction)) {
				remark = `Tyre removal can only occur when the tyre is fitted on a vehicle. The previous transaction '${prevHist.transaction}' does not allow removal. Please correct the transaction order.`;
				isDateValidated = true;
			}
			if (currHist.transaction == 'Purchase' && currHist.odo && Number(currHist.odo)) {
				remark = `Purchase entries do not require an odometer reading. Please remove the value to continue.`;
				isDateValidated = true;
			}

			if (!isDateValidated && prevHist) {
				if (!['Retread Recd', 'Retread Sent', 'Scrap', 'Scrap Complete'].includes(currHist.transaction)) {
					let prevOdo = prevHist && prevHist.odo && parseInt(prevHist.odo) || 0;
					let currentOdo = currHist.odo && parseInt(currHist.odo) || 0;
					let prevMasterHist = TyreHistories.find(x => x.id == prevHist.id) || {};
					let currMasterHist = TyreHistories.find(x => x.id == currHist.id) || {};
					if (currentOdo < prevOdo && prevMasterHist.AssetId == currMasterHist.AssetId) {
						isDateValidated = true;
						remark = `Entered odometer value (${currentOdo}) cannot be less than the previous odometer (${prevOdo}). Please verify and correct the value.`;
					}
				}
			}
			if (!isDateValidated) {
				if (['Purchase', 'Retread Sent', 'Retread Recd'].includes(currHist.transaction)) {
					continue;
				}
				if (prevHist && prevHist.grooves && prevHist.grooves.count && currHist && currHist.grooves && currHist.grooves.count) {
					for (const depth in currHist.grooves.depths) {
						if (Number(currHist.grooves.depths[depth]) > Number(prevHist.grooves.depths[depth])) {
							isDateValidated = true;
							remark = `Entered tread depth at G${Number(depth) + 1} (${currHist.grooves.depths[depth]}) ` +
								`cannot be greater than the previous value (${prevHist.grooves.depths[depth]}).`;
							break;
						}
					}
				} else {
					let prevDepth = prevHist && prevHist.depth && Number(prevHist.depth) || 0;
					let currentDepth = currHist.depth && Number(currHist.depth) || 0;
					if (currentDepth > prevDepth) {
						isDateValidated = true;
						remark = `Entered tread depth (${currentDepth}) cannot be greater than the previous tread depth (${prevDepth}). Please verify and correct the value.`;
					}
				}
			}
			if (isDateValidated) {
				validateTyreHist = true;
			}
			remarks[currHist.id] = remark;
		}

		if (validateTyreHist) {
			return res.send({ success: false, remarks });
		}

		let assetIds = TyreHistories.filter(hist => hist.AssetId).map(x => x.AssetId);

		let Inspections = await models.Inspection.findAll({
			attributes: [
				'id', 'date', 'AssetId', 'type',
				[models.Sequelize.literal(`"details"->>'resetOdo'`), 'resetOdo'],
				[models.Sequelize.literal(`"details"->>'notOperOdo'`), 'notOperOdo']
			],
			where: {
				type: ['v', 'vd', 't'],
				AccountId: req.body.AccountId,
				AssetId: [...new Set(assetIds)]
			},
			order: [['date', 'desc']],
			raw: true
		});

		validateTyreHist = false;
		for (let i = 0; i < req.body.tyreData.length; i++) {
			let remark = '';
			let currHist = req.body.tyreData[i];
			let inspectedBasedService = ['Inspect', 'Rotation', 'Alignment', 'Rotation On Rim', 'IP Check & Correction'].includes(currHist.transaction);

			if (inspectedBasedService) {
				let prevHistData = req.body.tyreData[i - 1];
				let prevTyreHistory = TyreHistories.find(x => x.id == Number(prevHistData.id));
				let TyreHistory = TyreHistories.find(x => x.id == Number(currHist.id));
				let VehicleInspection = {}, TyreInspection = {};

				if (prevTyreHistory && TyreHistory.AssetId && prevTyreHistory.AssetId && (TyreHistory.AssetId == prevTyreHistory.AssetId)) {// Asset odo decrease
					VehicleInspection = Inspections.find(x => ['v', 'vd'].includes(x.type) && x.AssetId == TyreHistory.AssetId && moment(x.date).isSameOrBefore(moment(TyreHistory.histDate), 'day'));
					if (VehicleInspection && VehicleInspection.type == 'v' && TyreHistory.transaction == 'Inspect') {
						TyreInspection = Inspections.find(x => x.type == 't' && x.AssetId == TyreHistory.AssetId && moment(VehicleInspection.date).isSameOrAfter(moment(x.date), 'day'));
					}

					if (VehicleInspection && moment(currHist.histDate).isBefore(moment(VehicleInspection.date))) {
						remark = `The transaction date cannot be before the last vehicle inspection date (${formatByRegion(VehicleInspection.date, res.locals.region, 'DD-MMM-YYYY hh:mm:ss A ')}).`;
						validateTyreHist = true;
					}
					if (TyreInspection && moment(currHist.histDate).isAfter(moment(TyreInspection.date))) {
						remark = `The transaction date cannot be after the last tyre inspection date (${formatByRegion(TyreInspection.date, res.locals.region, 'DD-MMM-YYYY hh:mm:ss A')}).`;
					}
					if (VehicleInspection && Number(currHist.odometer * 1000) > Number(VehicleInspection.odo) && !validateTyreHist) {
						remark = `The transaction odometer cannot be greater than the last vehicle inspection odometer (${VehicleInspection.odo / 1000} km).`;
						validateTyreHist = true;
					}
				}
			}
			remarks[currHist.id] = remark;
		}

		if (validateTyreHist) {
			return res.send({ success: false, remarks });
		}

		let updateHistById = {};
		let updateInspection = {};
		await models.sequelize.transaction(async (t) => {
			for (let tyreHist of req.body.tyreData) {
				let TyreHistory = TyreHistories.find(x => x.id == Number(tyreHist.id));
				if (!TyreHistory) {
					RaiseLogEvent(ROUTE, req.body.tyreNo, req.body, 'Tyre History not found');
					throw new Error('Tyre History not found.');
				}

				updateHistById[tyreHist.id] = false;
				const dataToUpdate = {};
				if (Number(TyreHistory.odometer) !== Number(tyreHist.odo) * 1000) {
					updateHistById[tyreHist.id] = true;
					TyreHistory.odometer = Number(tyreHist.odo) * 1000;
					dataToUpdate.odometer = Number(tyreHist.odo) * 1000;
				}

				if (tyreHist.grooves && TyreHistory.details && TyreHistory.details.grooves && !validateNestedObj(tyreHist.grooves, TyreHistory.details.grooves)) {
					updateHistById[tyreHist.id] = true;
					TyreHistory.details = { ...TyreHistory.details, grooves: tyreHist.grooves };
					dataToUpdate.details = TyreHistory.details;
				}

				if (Number(tyreHist.depth) !== Number(TyreHistory.treadDepth)) {
					updateHistById[tyreHist.id] = true;
					TyreHistory.treadDepth = Number(tyreHist.depth);
					dataToUpdate.treadDepth = Number(tyreHist.depth);
				}

				if (tyreHist.histDate && moment(tyreHist.histDate).toISOString() !== moment(TyreHistory.histDate).toISOString()) {
					updateHistById[tyreHist.id] = true;
					TyreHistory.histDate = moment(tyreHist.histDate).toISOString();
					dataToUpdate.histDate = moment(tyreHist.histDate).toISOString();
				}

				if (!updateHistById[tyreHist.id]) continue;

				await TyreHistory.update(dataToUpdate, {
					transaction: t,
					silent: true
				});
			}

			let lastestHistory = TyreHistories.length - 1;
			for (let i = 1; i < TyreHistories.length; i++) {
				let TyreHistory = TyreHistories[i];
				let prevRec = TyreHistories[i - 1];
				let prevOdo = (prevRec && prevRec.odometer && parseInt(prevRec.odometer)) || 0;
				let currentOdo = (TyreHistory.odometer && parseInt(TyreHistory.odometer)) || 0;
				let prevTyreOdo = (prevRec && prevRec.tyreOdometer && parseInt(prevRec.tyreOdometer)) || 0;
				let currentTyreOdo = prevTyreOdo + (currentOdo - prevOdo);

				if (['Purchase', 'Retread Recd', 'Repair Recd'].indexOf(TyreHistory.transaction) > -1 || (prevRec && prevRec.transaction == 'Purchase')) {
					currentTyreOdo = 0;
				} else if (prevRec && ['SP', 'SP1', 'SP2', 'SP3', 'SP4'].indexOf(prevRec.position) > -1) {
					currentTyreOdo = prevTyreOdo;
				}

				if (prevRec.AssetId != TyreHistory.AssetId) {
					currentTyreOdo = prevTyreOdo;
				}

				if (['Scrap Cancel', 'Scrap Complete'].indexOf(TyreHistory.transaction) > -1) {
					currentTyreOdo = prevTyreOdo;
				}

				if (TyreHistory.transaction == 'Fitment' && ['Remove', 'Purchase'].includes(prevRec.transaction)) {
					currentTyreOdo = prevTyreOdo;
				}

				let VehicleInspection = {}, TyreInspection = {};

				if (prevRec && TyreHistory.AssetId && prevRec.AssetId && TyreHistory.AssetId == prevRec.AssetId) {
					VehicleInspection = Inspections.find(x => ['v', 'vd'].includes(x.type) && x.AssetId == TyreHistory.AssetId && moment(x.date).isSameOrBefore(moment(TyreHistory.histDate), 'day')) || {};

					if (VehicleInspection && VehicleInspection.type == 'v' && TyreHistory.transaction == 'Inspect') {
						TyreInspection = Inspections.find(x => x.type == 't' && x.AssetId == TyreHistory.AssetId && moment(VehicleInspection.date).isSameOrAfter(moment(x.date), 'day')) || {};
					}

					if (prevOdo > currentOdo) {
						if (!VehicleInspection || !Object.keys(VehicleInspection).length) {
							RaiseLogEvent('rmq-avolve-tyreodo-recalc-update', data.tyreNo, data, 'Tyre odo recalc ignored due to mismatch in vehicle odo.');
							throw new Error('Tyre odo recalc ignored due to mismatch in vehicle odo.');
						}

						if (VehicleInspection.resetOdo == true || VehicleInspection.resetOdo === 'true') {
							currentTyreOdo = prevTyreOdo + TyreHistory.odometer;
						}
						if (VehicleInspection.notOperOdo == true || VehicleInspection.notOperOdo === 'true') {
							currentTyreOdo = prevTyreOdo;
						}
					}
				}

				if (VehicleInspection && Object.keys(VehicleInspection).length) {
					if (updateHistById[TyreHistory.id]) {
						if (!updateInspection[VehicleInspection.id]) {
							updateInspection[VehicleInspection.id] = {};
						}

						if (TyreInspection && TyreInspection.date && moment(TyreInspection.date).isBetween(TyreHistory.histDate, moment(TyreHistory.histDate).add(3, 'days'))) {
							if (TyreHistory.transaction == 'Inspect') {
								if (!updateInspection[VehicleInspection.id].tyreHistIds) {
									updateInspection[VehicleInspection.id].tyreHistIds = [];
								}
								updateInspection[VehicleInspection.id].vehInspectionId = VehicleInspection.id;
								updateInspection[VehicleInspection.id].tyreInspectionId = TyreInspection.id;
								updateInspection[VehicleInspection.id].tyreHistIds.push(TyreHistory.id);
								updateInspection[VehicleInspection.id].AccountId = req.body.AccountId;
							}
						}

						if (Number(TyreHistory.tyreOdometer) != Number(currentTyreOdo)) {
							updateInspection[VehicleInspection.id].vehInspectionId = VehicleInspection.id;
							updateInspection[VehicleInspection.id].updateVehInspection = true;
							updateInspection[VehicleInspection.id].vehOdometer = TyreHistory.odometer;
							updateInspection[VehicleInspection.id].AccountId = req.body.AccountId;
						}
					}
				}

				if (Number(TyreHistory.tyreOdometer) != Number(currentTyreOdo)) {
					await TyreHistory.update(
						{ tyreOdometer: currentTyreOdo },
						{ transaction: t, silent: true }
					);

					if (lastestHistory == i) {
						let lastStatus = JSON.parse(JSON.stringify(Tyre.lastStatus));
						lastStatus.tyreOdometer = currentTyreOdo;
						lastStatus.odometer = currentOdo;

						let lastWorkDone = JSON.parse(JSON.stringify(Tyre.lastWorkDone));
						let transaction = lastStatus.transaction == 'Inspect' ? 'Inspection' : lastStatus.transaction;
						if (lastWorkDone[transaction]) {
							lastWorkDone.date = lastStatus.histDate;
							lastWorkDone.tyreOdometer = lastStatus.tyreOdometer;
						}

						await Tyre.update(
							{
								lastStatus: lastStatus,
								tyreOdo: currentTyreOdo,
								odometer: currentOdo,
								lastWorkDone: lastWorkDone
							},
							{ transaction: t, silent: true }
						);
					}
				}
			}
		});

		for (const inspectionId in updateInspection) {
			if (!updateInspection[inspectionId] || !Object.keys(updateInspection[inspectionId]).length) {
				continue;
			}
			events.emit('avolve-inspection-odometer-correction', updateInspection[inspectionId]);
		}
		events.emit('tyre-cpkm-refresh', { tyreNo: Tyre.tyreNo, AccountId: Tyre.AccountId });

		return res.send({ success: true });
	} catch (error) {
		console.log(`Error in ${ROUTE}:  `, error);
		RaiseLogEvent(ROUTE, 'error', error, `Error updating tyre history data.`);
		return res.send({ success: false, error: 'Error updating tyre history data.' });
	}
}

exports.listTyreCondition = function (req, res) {
	return res.send({ success: true, condition: tyreCondition.condition });
}

exports.create = async function (req, res) {
	const ROUTE = 'web/tyres/create';
	try {
		RaiseLogEvent('tyres/create', res.locals.AccountId, req.body, `Requested by ${res.locals.username}`);

		var tyreNumbers = [];
		tyreNumbers = req.body.tyreNo.replace(' ', '').split(",");

		var tyreBulk = [], invoiceImages = [];

		//#region validate
		if (!tyreNumbers.length || !req.body.tyreNo) {
			return res.send({ success: false, error: 'Tyre number is required', message: 'Tyre number is required' });
		}
		if (!req.body.purchasedFrom && res.locals.AccountId == 491) { //Subham
			return res.send({ success: false, error: 'Purchased From is required', message: 'Purchased From is required' });
		}
		if (res.locals.role != "Admin" && res.locals.branchIds.length && req.body.BranchId) {
			var branchAccess = res.locals.branchIds.find(x => x == req.body.BranchId);
			if (!branchAccess) {
				return res.send({ success: false, error: 'You are not assigned to this branch', message: 'You are not assigned to this branch' });
			}
		}
		if (req.body.initialTreadDepth && isNaN(req.body.initialTreadDepth)) {
			return res.send({ success: false, error: 'Invalid InitialTreadDepth.', message: 'Invalid InitialTreadDepth.' });
		}
		if (req.body.currentTreadDepth && isNaN(req.body.currentTreadDepth)) {
			return res.send({ success: false, error: 'Invalid CurrentTreadDepth.', message: 'Invalid CurrentTreadDepth.' });
		}
		//#endregion

		const { branch, tyreStocks } = await tyreStockCount(req.body.BranchId, res.locals.AccountId);
		//validation tyre max stock level
		if (branch && branch.tyreMinMax && branch.tyreMinMax.max > 0) {
			var branchMaxTyreCount = parseInt(branch.tyreMinMax.max);
			var existingTyreCount = 0;
			if (tyreStocks && tyreStocks.length) {
				existingTyreCount = parseInt(tyreStocks[0].tyreCount);
			}
			var currentTyreCount = tyreNumbers.length;
			var totalTyres = existingTyreCount + currentTyreCount;
			if (totalTyres > branchMaxTyreCount) {
				return res.send({ success: false, error: `Maximum stock level reached for this branch.` });
			}
		}
		const [assets, branches] = await Promise.all([
			models.Asset.findAll({
				attributes: ['id', 'lplate', 'odo'],
				where: { AccountId: res.locals.AccountId }
			}),
			models.Branch.findAll({
				attributes: ['id', 'name'],
				where: {
					AccountId: res.locals.AccountId
				}
			})
		]);
		// Remove spaces 
		for (var i = tyreNumbers.length - 1; i >= 0; i--) {
			if (tyreNumbers[i].includes(" ")) {
				tyreNumbers[i] = tyreNumbers[i].replace(/\s/g, "").replace(/[^\w\s]/gi, '');
			}
		}

		// Check for duplicates
		let duplicates = tyreNumbers.filter((item, index) => tyreNumbers.indexOf(item) != index);
		if (duplicates.length > 0) {
			return res.send({
				success: false,
				error: `Duplicate tyres found: ${[...new Set(duplicates)]}`,
				message: `Duplicate tyres found: ${[...new Set(duplicates)]}`
			});
		}

		const tyres = await models.Tyre.findAll({
			where: {
				AccountId: res.locals.AccountId,
				tyreNo: { [Op.in]: tyreNumbers }
			}
		});
		if (tyres.length > 0) {
			var existingTyres = [];
			tyres.forEach(tyre => {
				existingTyres.push(tyre.tyreNo);
			});
			return res.send({ success: false, error: `Tyres ${existingTyres.toString()} already exists in database.` });
		}
		var amount = !isNaN(req.body.amount) ? req.body.amount : 0;
		tyreNumbers.forEach(tyreNo => {
			//#region Create bulk tyre info
			var invoiceImgs = (req.files) ? req.files.filter(files => {
				return files.originalname;
			}) : '';
			if (req.files && invoiceImgs && invoiceImgs.length) {
				invoiceImages = invoiceImages.concat(invoiceImgs);
			}
			var imagePaths = invoiceImgs.length > 0 ? invoiceImgs.map(obj => {
				return '/' + md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + req.body.billNumber.replace(/\\|\//g, "") + '_' + obj.filename;
			}).toString() : null;

			var vehicleInfo,
				tyre = {
					tyreNo: tyreNo,
					treadPattern: req.body.treadPattern,
					condition: req.body.condition ? req.body.condition : 'New',
					mfgBy: req.body.mfgBy,
					model: req.body.model,
					mfgDate: req.body.mfgDate ? moment(req.body.mfgDate).format() : null,
					stockLocation: req.body.stockLocation,
					BranchId: req.body.BranchId ? req.body.BranchId : null,
					tyreStatus: 0,//0-In Stock
					codeSize: req.body.codeSize ? req.body.codeSize.trim() : '',
					radial: req.body.radial,
					loadIndex: req.body.loadIndex,
					speedRating: req.body.speedRating,
					tubeStatus: req.body.tubeStatus,
					flapStatus: req.body.flapStatus,
					initialTreadDepth: req.body.initialTreadDepth,
					purchasedFrom: req.body.purchasedFrom,
					purchasedOn: req.body.purchasedOn ? moment(req.body.purchasedOn, "YYYY-MM-DD HH:mm:ss").format() : moment().format(),
					amount: amount,
					paymentMode: req.body.paymentMode,
					billNumber: req.body.billNumber,
					comments: req.body.comments,
					rfid: req.body.rfid ? req.body.rfid : null,
					tpmsId: null,
					AccountId: res.locals.AccountId,
					AssetId: null,
					lastStatus: {},
					lastWorkDone: {},
					invoiceImages: imagePaths,
					odo: req.body.odo
				};
			if (["Used", "Retread"].indexOf(req.body.condition) > -1 && req.body.installedVehicle) {
				vehicleInfo = assets.find(x => x.id == req.body.installedVehicle);
				if (vehicleInfo) {
					tyre.AssetId = vehicleInfo.id;
					tyre.odo = tyre.odo || vehicleInfo.odo;
					tyre.installedOn = req.body.installedOn ? moment(req.body.installedOn, "YYYY-MM-DD HH:mm:ss").format() : moment().format()
					if (req.body.condition == 'Used') {
						tyre.tyreStatus = 1; //1-In Use
					} else if (req.body.condition == 'Retread') {
						tyre.tyreStatus = 3; //3-Retreading
					} else if (req.body.condition == 'Retreaded') {
						tyre.tyreStatus = 4; //4-Retreaded
					}
				}
			}
			tyreBulk.push(tyre);
			//#endregion
		});

		var tyreStruct = [];

		return await models.sequelize.transaction(async (t) => {

			let tyres = await models.Tyre.bulkCreate(tyreBulk, { returning: true, transaction: t });
			var histBulk = [];
			tyres.forEach(tyre => {
				//#region Create bulk tyre info
				tyreStruct.push(tyre);
				let purchaseHistDetails = {};
				if (tyre.condition && tyre.condition.startsWith('Retread')) {
					purchaseHistDetails.design = req.body.design;
					purchaseHistDetails.quality = req.body.quality;
					purchaseHistDetails.retreadCost = Number(req.body.retreadCost) || 0;
					purchaseHistDetails.casingCost = Number(req.body.casingCost) || 0;
				}
				histBulk.push({
					tyreNo: tyre.tyreNo,
					histDate: req.body.purchasedOn ? moment(req.body.purchasedOn, "YYYY-MM-DD HH:mm:ss").format() : moment().format(),
					transaction: "Purchase",
					condition: tyre.condition,
					tyreStatus: tyre.tyreStatus,
					position: null,
					inflation: null,
					wearPattern: null,
					treadDepth: tyre.initialTreadDepth,
					inspectedBy: null,
					shopName: null,
					amount: tyre.amount,
					odometer: null,
					tyreOdometer: 0,
					stockLocation: req.body.stockLocation,
					BranchId: tyre.BranchId ? tyre.BranchId : null,
					comments: tyre.comments,
					tpmsData: tyre.tpmsData,
					UserId: res.locals.UserId,
					AccountId: tyre.AccountId,
					username: res.locals.username,
					details: purchaseHistDetails
				});
				if (tyre.AssetId) {
					histBulk.push({
						tyreNo: tyre.tyreNo,
						histDate: req.body.installedOn ? moment(req.body.installedOn, "YYYY-MM-DD HH:mm:ss").format() : moment().format(),
						transaction: "Fitment",
						condition: tyre.condition,
						tyreStatus: tyre.tyreStatus,
						position: req.body.tyrePosition,
						odometer: tyre.odometer,
						tyreOdometer: 0,
						treadDepth: tyre.initialTreadDepth,
						amount: tyre.amount,
						stockLocation: tyre.stockLocation,
						BranchId: tyre.BranchId ? tyre.BranchId : null,
						comments: tyre.comments,
						AssetId: tyre.AssetId,
						tpmsData: tyre.tpmsData,
						UserId: res.locals.UserId,
						AccountId: tyre.AccountId,
						username: res.locals.username
					})
					if (
						req.body.initialTreadDepth &&
						req.body.currentTreadDepth &&
						req.body.initialTreadDepth != req.body.currentTreadDepth
					) {
						histBulk.push({
							tyreNo: tyre.tyreNo,
							histDate: moment(),
							transaction: "Inspect",
							condition: tyre.condition,
							tyreStatus: tyre.tyreStatus,
							position: req.body.tyrePosition,
							treadDepth: req.body.currentTreadDepth,
							odometer: tyre.odometer,
							tyreOdometer: 0,
							AssetId: tyre.AssetId,
							tpmsData: tyre.tpmsData,
							UserId: res.locals.UserId,
							AccountId: tyre.AccountId,
							username: res.locals.username
						});
					}
				}

				if (tyre && tyre.tpmsId) {
					evt.events.emit('tpms-history-update', {
						tyreId: tyre.id,
						tpmsId: tyre.tpmsId,
						user: {
							id: res.locals.id,
							username: res.locals.username
						},
						position: req.body.tyrePosition || '',
						actionType: tpmsActionsEnum.Assign
					});
				}

				//#endregion
			});

			let tyreHistories = await models.TyreHistory.bulkCreate(histBulk, { returning: true, transaction: t });

			for (const tyre of tyres) {
				var tyreHist = tyreHistories.find(x => x.tyreNo == tyre.tyreNo && x.transaction == 'Inspect');
				if (!tyreHist) {
					tyreHist = tyreHistories.find(x => x.tyreNo == tyre.tyreNo && x.transaction == 'Fitment');
				}
				if (!tyreHist) {
					tyreHist = tyreHistories.find(x => x.tyreNo == tyre.tyreNo);
				}
				var matchedBranch = branches.find(x => x.id == tyreHist.BranchId);
				var Branch = {};
				if (matchedBranch) {
					Branch.id = matchedBranch.id;
					Branch.name = matchedBranch.name;
				}
				var tyreHist = JSON.parse(JSON.stringify(tyreHist));
				tyreHist.Branch = Branch;
				tyre.lastStatus = tyreHist;
				await tyre.save({ transaction: t });
			}
		});
		invoiceImages.map(image => {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + req.body.billNumber.replace(/\\|\//g, "") + '_' + image.filename
				});
			}
		});
		return res.send({ success: true, reload: true, tyres: tyreStruct });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in tyre create ', err);
	}
};

async function tyreStockCount(BranchId, AccountId) {
	try {
		if (!BranchId) {
			return { branch: null, tyreStocks: null };
		}
		const [branch, tyreStocks] = await Promise.all([
			models.Branch.findOne({
				attributes: ['id', 'name', 'tyreMinMax', 'AccountId'],
				where: {
					id: BranchId,
					AccountId: AccountId
				}
			}),
			models.Tyre.findAll({
				group: ['BranchId'],
				attributes: [
					[models.Sequelize.fn('COUNT', models.Sequelize.col('BranchId')), 'tyreCount']
				],
				where: {
					AccountId: AccountId,
					BranchId: BranchId,
					AssetId: null
				},
				raw: true
			})
		]);
		return { branch, tyreStocks };
	} catch (err) {
		console.log(moment().format() + ' Error:', err);
		throw err;
	}
};

exports.update = async function (req, res) {
	const ROUTE = 'web/tyres/update';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'TyreId missing.', message: 'TyreId missing.' });
		}

		RaiseLogEvent('tyres/update', res.locals.AccountId, req.body, `Requested by ${res.locals.username}`);

		let tyre = await models.Tyre.findOne({
			where: {
				id: req.params.id,
				AccountId: req.query.AccountId
			}
		});

		if (!tyre) {
			return res.send({ success: false, message: "Tyre not found.", error: 'Tyre not found.' });
		}

		if (req.body.tyreNo && (req.body.tyreNo != tyre.tyreNo)) {
			return res.send({ success: false, error: 'Tyre No update restricted.', message: 'Tyre No update restricted.' });
		}
		if (req.body.initialTreadDepth && isNaN(req.body.initialTreadDepth)) {
			return res.send({ success: false, error: 'Invalid InitialTreadDepth.', message: 'Invalid InitialTreadDepth.' });
		}
		try {
			//TODO: lastStatus may not be needed here. Only for transactions needed.
			if (req.body.lastStatus) {
				tyre.lastStatus = JSON.parse(req.body.lastStatus);
			}
		} catch (err) {
			return res.send({ success: false, error: "lastStatus failed json validation.", message: "lastStatus failed json validation." });
		}

		let currentTreadDepth = tyre.lastStatus && tyre.lastStatus.treadDepth && parseInt(tyre.lastStatus.treadDepth) || 0;
		if (parseInt(req.body.initialTreadDepth) < currentTreadDepth) {
			return res.send({ success: false, error: `Initial tread depth ${req.body.initialTreadDepth} should not be less than current depth ${currentTreadDepth}.` });
		}

		//#region capture casing & retread cost while tyre edit
		let tyreHistories = await models.TyreHistory.findAll({
			attributes: ['id', 'tyreNo', 'transaction', 'amount', 'details'],
			where: {
				tyreNo: tyre.tyreNo,
				transaction: ['Purchase', 'Retread Recd'],
				AccountId: tyre.AccountId
			},
			order: [['histDate', 'DESC'], ['id', 'DESC']]
		});

		if (tyreHistories.length) {
			let matchTyreHist = tyreHistories.find(x => x.transaction == "Retread Recd" || "Purchase");
			if (matchTyreHist && Object.keys(matchTyreHist).length) {
				let details = matchTyreHist.details && JSON.parse(JSON.stringify(matchTyreHist.details)) || {};
				details.retreadCost = !isNaN(req.body.retreadCost) && req.body.retreadCost || 0;
				details.casingCost = !isNaN(req.body.casingCost) && req.body.casingCost || 0;
				matchTyreHist.update({
					details: details,
					amount: !isNaN(req.body.amount) && req.body.amount || 0
				});

				evt.events.emit('apl-refresh-tyre-lastStatus', {
					tyreNo: tyre.tyreNo,
					AccountId: tyre.AccountId
				});
			}
		}
		//#endregion

		tyre.mfgBy = req.body.mfgBy;
		tyre.model = req.body.model;
		tyre.mfgDate = req.body.mfgDate && moment(req.body.mfgDate, 'DD/MM/YYYY HH:mm:ss').format() || tyre.mfgDate;
		tyre.codeSize = req.body.codeSize;
		tyre.radial = req.body.radial;
		tyre.loadIndex = req.body.loadIndex;
		tyre.speedRating = req.body.speedRating;
		tyre.treadPattern = req.body.treadPattern;
		tyre.tubeStatus = req.body.tubeStatus;
		tyre.flapStatus = req.body.flapStatus;
		tyre.initialTreadDepth = req.body.initialTreadDepth;
		tyre.purchasedFrom = req.body.purchasedFrom;
		tyre.purchasedOn = moment(req.body.purchasedOn, "YYYY-MM-DD HH:mm:ss").isValid() && moment(req.body.purchasedOn, "YYYY-MM-DD HH:mm:ss").format() || tyre.purchasedOn;
		tyre.amount = !isNaN(req.body.amount) && req.body.amount || 0;
		tyre.paymentMode = req.body.paymentMode;
		tyre.comments = req.body.comments;
		tyre.stockLocation = req.body.stockLocation;
		tyre.billNumber = req.body.billNumber;
		tyre.rfid = ('rfid' in req.body) ? req.body.rfid || null : tyre.rfid;
		tyre.tpmsId = req.body.tpmsId || tyre.tpmsId;
		tyre.condition = req.body.condition || tyre.condition;


		let invoiceImages = [];
		let invoiceImgs = (req.files) ? req.files.filter(files => files.originalname) : '';
		if (req.files && invoiceImgs && invoiceImgs.length) {
			invoiceImages = invoiceImages.concat(invoiceImgs);
		}
		let existImages = tyre.invoiceImages && tyre.invoiceImages.split(',') || [];
		let totalImages = invoiceImages.length + existImages.length;
		if (totalImages > 2) {
			return res.send({
				success: false, error: 'Max only 2 invoices can be uploaded.',
				message: 'Max only 2 invoices can be uploaded.'
			});
		}
		if (invoiceImages.length) {
			let invoiceImageUrl = "";
			let imagePaths = invoiceImgs.length && invoiceImgs.map(obj => {
				return '/' + md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + req.body.billNumber.replace(/\\|\//g, "") + '_' + obj.filename;
			}).toString() || null;
			invoiceImageUrl = imagePaths;
			existImages.forEach(image => {
				invoiceImageUrl += `,${image}`;
			});
			tyre.invoiceImages = invoiceImageUrl;
		}
		let updatedTyre = await tyre.save();
		invoiceImages.map(image => {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + req.body.billNumber.replace(/\\|\//g, "") + '_' + image.filename
				});
			}
		});
		if (tyre && tyre.tpmsId) {
			evt.events.emit('tpms-history-update', {
				tyreId: tyre.id,
				tpmsId: tyre.tpmsId,
				user: {
					id: res.locals.id,
					username: res.locals.username
				},
				position: tyre.lastStatus && tyre.lastStatus.position || null,
				actionType: tpmsActionsEnum.Move
			});
		}
		RecalculateCpkm([tyre.tyreNo], res.locals.AccountId);

		return res.send({ success: true, tyre: updatedTyre });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error in tyre update ', err);
	}
};

function RecalculateCpkm(tyres, AccountId) {
	for (const tyreNo of tyres) {
		evt.events.emit('tyre-cpkm-refresh', { tyreNo: tyreNo, AccountId: AccountId });
	}
}

exports.payKmList = async function (req, res) {
	const ROUTE = 'web/tyres/payKmList';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) { // Avolve
			return res.send({ success: false, error: 'Not authorized to this API' });
		}

		let sDate = moment().subtract(30, 'days').startOf('day');
		let eDate = moment();
		if (req.query.sdate && req.query.edate) {
			sDate = moment(req.query.sdate).startOf('day');
			eDate = moment(req.query.edate).endOf('day');
		}

		let accountWhere = {
			type: [11], // Avolve Customers
			AccountIdParent: res.locals.masterAccountId,
			status: 1,
			'details.payKm': true
		}

		let assetWhere = {
			active: true,
			remove: false,
			createdAt: { [Op.between]: [sDate.toISOString(), eDate.toISOString()] }
		};

		if (req.query.accountId) {
			delete assetWhere.createdAt;
			accountWhere.id = req.query.accountId;
		}

		if (req.query.allDates == 'true' || req.query.allDates == true) {
			delete assetWhere.createdAt;
		}

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'name', 'tname', 'oname', 'email1', 'baddress', 'anote', 'createdAt', 'totalvehicle', 'phone1'],
			include: [{
				attributes: ['id', 'offerType', 'subOfferType'],
				model: models.AplOffer
			}],
			where: accountWhere,
			order: [[models.AplOffer, 'id', 'DESC']]
		});

		if (!Accounts.length) {
			return res.send({ success: false, results: [] });
		}

		assetWhere.AccountId = { [Op.in]: Accounts.map(x => x.id) };

		let Assets = await models.Asset.findAll({
			attributes: ['id', 'lplate', 'imei', 'details', 'AccountId', 'createdAt', 'lastDeviceAttribute'],
			include: [{
				attributes: ['id', 'tyreNo', 'AccountId', 'lastStatus', 'tpmsData', 'tpmsId', 'createdAt'],
				model: models.Tyre
			}],
			where: assetWhere
		});

		let AssetServices = await models.AssetService.findAll({
			attributes: ['id', 'createdAt', 'status', 'AssetId', 'AccountId'],
			where: {
				AssetId: { [Op.in]: Assets.map(x => x.id) },
				status: { [Op.notIn]: [12, 13] } // closed, Invalid request
			},
			raw: true
		});

		let AssetServicesMap = new Map();
		for (const AssetService of AssetServices) {
			if (!AssetServicesMap.has(AssetService.AssetId)) {
				AssetServicesMap.set(AssetService.AssetId, []);
			}
			AssetServicesMap.get(AssetService.AssetId).push(AssetService);
		}

		let AccountMap = new Map();
		for (const Account of Accounts) {
			if (!AccountMap.has(Account.id)) {
				AccountMap.set(Account.id, Account);
			}
		}

		let tyres = [];
		for (const Asset of Assets) {
			let account = AccountMap.get(Asset.AccountId) || '';
			let AplOffer = account && account.AplOffers && account.AplOffers.length && account.AplOffers[0] || {};
			let dTime = Asset.lastDeviceAttribute && Asset.lastDeviceAttribute.dTime || '';
			let matchedServices = AssetServicesMap.get(Asset.id) || '';
			let serviceDetails = {}
			if (matchedServices && matchedServices.length && matchedServices[0]) {
				serviceDetails = {
					id: matchedServices[0].id,
					status: serviceStatusLookUp(matchedServices[0].status),
					date: matchedServices[0].createdAt || ''
				};
			}

			let gpsStatus = 'Active';
			if (!dTime || moment().diff(moment(dTime).add(330, 'minutes'), 'minutes') > 60) {
				gpsStatus = 'Disconnected';
			}
			if (Asset.Tyres && Asset.Tyres.length) {
				for (const tyre of Asset.Tyres) {
					let tpmsDisconnected = false;
					if (!tyre.tpmsData || !Object.keys(tyre.tpmsData).length) {
						tpmsDisconnected = true;
					} else if (!tyre.tpmsData || !tyre.tpmsData.TIME || moment().diff(moment(tyre.tpmsData.TIME), 'minutes') > 60) {
						tpmsDisconnected = true;
					}
					tyres.push({
						tyreNo: tyre.tyreNo,
						condition: tyre.lastStatus && tyre.lastStatus.condition || '',
						position: tyre.lastStatus && tyre.lastStatus.position || '',
						status: tyreStatusLookUp(parseInt(tyre.lastStatus && tyre.lastStatus.tyreStatus || '')),
						tpmsId: tyre.tpmsId,
						tyreOdo: tyre.lastStatus && tyre.lastStatus.tyreOdometer && parseInt(tyre.lastStatus.tyreOdometer) / 1000 || 0,
						tpmsStatus: tpmsDisconnected && 'TPMS Disconnected' || 'Active',
						tpmsTimeStamp: tyre.tpmsData && tyre.tpmsData.TIME && moment(tyre.tpmsData.TIME) || '',
						onbDate: tyre.createdAt && tyre.createdAt || '',
						vehicleId: Asset.id,
						lplate: Asset.lplate || '',
						gpsStatus: gpsStatus,
						installedOn: Asset.createdAt || '',
						gpsTimestamp: dTime || '',
						AccountId: account.id,
						tname: account && account.tname || '',
						mdgId: account && account.name && account.name.split('_')[0] || '',
						offer: AplOffer && AplOffer.offerType || '',
						subOffer: AplOffer && AplOffer.subOfferType || '',
						serviceDetails: serviceDetails
					});
				}
			}
		}

		if (req.query.gpsIssue == 'true' || req.query.gpsIssue == true) {
			tyres = tyres.filter(x => x.gpsStatus == 'Disconnected');
		}

		if (req.query.tpmsIssue == 'true' || req.query.tpmsIssue == true) {
			tyres = tyres.filter(x => x.tpmsStatus == 'TPMS Disconnected');
		}

		return res.send({ success: true, results: tyres });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching vehicles', err);
	}
}

exports.calculateCPKM = async function (req, res) {
	const ROUTE = 'web/calculate/cpkm';
	try {
		if (!req.body.tyreId) {
			return res.send({ success: false, error: 'Tyre ID missing.' });
		}

		let { tyreId, tyreLifeCycle } = req.body;

		if (!tyreLifeCycle || typeof tyreLifeCycle !== 'object') {
			return res.send({ success: false, error: 'Invalid tyre life cycle data.' });
		}

		let tyre = await models.Tyre.findOne({ where: { id: tyreId } });
		if (!tyre) {
			return res.send({ success: false, error: 'Tyre not found.' });
		}

		let cpkmDetails = tyre.cpkmDetails || {};
		if (!cpkmDetails || Object.keys(cpkmDetails).length === 0) {
			return res.send({ success: false, error: 'Tyre CPKM details not found.' });
		}

		let cpkmList = [];
		Object.keys(tyreLifeCycle).forEach(key => {
			let data = tyreLifeCycle[key];           // Input values
			let config = cpkmDetails[key] || {};     // DB config values
			let maxDepth = Number(config.startDepth) || 0;
			let minDepth = Number(data.minDepth) || 0;
			let treadCons = Number(data.depthCons) || 0;
			let diff = maxDepth - minDepth;
			if (diff <= 0) diff = 1;
			let treadConsPercent = (treadCons / diff) * 100;
			let tyreCost = Number(config.tyreCost) || 0;
			let casingCost = Number(data.casingCost) || 0;
			let consCost = ((tyreCost + casingCost) * treadConsPercent) / 100;
			let unUsedCost = (tyreCost + casingCost) - consCost;
			let runKM = Number(data.tyreRunKM) || 0;
			let maintCost = Number(config.maintCost) || 0;
			let sellingPrice = Number(data.soldCost) || 0;
			let cpkm = runKM ? ((consCost + maintCost + unUsedCost) - sellingPrice) / runKM : 0;
			if (cpkm) { cpkmList.push(cpkm); }
		});
		let totalCPKM = cpkmList.reduce((a, b) => a + b, 0);
        let overAllCPKM = (cpkmList.length > 0 && totalCPKM > 0) ? (totalCPKM / cpkmList.length) : 0;

		return res.send({ success: true, results: overAllCPKM });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error calculating CPKM', err);
	}
}