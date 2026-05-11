const models = require('../../../models');
const moment = require('moment');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const avolveHelper = require('../../../lib/helpers/avolveHelper');
const redisHelper = require('../../../lib/helpers/redis');

exports.onboardTyre = async function (req, res) {
	const ROUTE = 'app/tyredrafts/onboardTyre';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.params, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.params.id) {
			return res.send({ success: false, error: 'Draft id missing' });
		}
		let TyreDraft = await models.TyreDraft.findOne({
			where: {
				id: req.params.id
			}
		});

		if (!TyreDraft) {
			return res.send({ success: false, error: 'Tyre draft not found' });
		}

		let details = TyreDraft.details;
		if (!details) {
			return res.send({ success: false, error: 'Tyre details not found' });
		}

		if (!details.initalTreadDepth) {
			return res.send({ success: false, error: 'InitialTreadDepth missing.' });
		}

		if (!details.condition) {
			return res.send({ success: false, error: 'Tyre conditon missing.' });
		}

		if (!details.currentTreadDepth) {
			return res.send({ success: false, error: 'CurrentTreadDepth missing.' });
		}

		if (details.initalTreadDepth && isNaN(details.initalTreadDepth)) {
			return res.send({ success: false, error: 'Invalid InitialTreadDepth.' });
		}

		if (details.currentTreadDepth && isNaN(details.currentTreadDepth)) {
			return res.send({ success: false, error: 'Invalid CurrentTreadDepth.' });
		}

		if (Number(details.currentTreadDepth) > Number(details.initialTreadDepth)) {
			return res.send({ success: false, error: 'CurrentTreadDepth should not be greater than InitialTreadDepth.' });
		}

		RaiseLogEvent('app/tyredrafts/onboardTyre', res.locals.AccountId, details, `Requested by ${res.locals.username}.`);

		let TyreMakeModel = await models.TyreMakeModel.findOne({
			where: {
				make: details.mfgBy && details.mfgBy || "",
				model: details.model && details.model || "",
				codeSize: details.codeSize && details.codeSize || ""
			}
		});

		if (!TyreMakeModel) {
			return res.send({ success: false, error: 'Tyre make model or code size not found.' });
		}
		let AssetId = details.AssetId && details.AssetId || null;
		let condition = details && details.condition || 'New';
		if (AssetId) {
			condition = details && details.condition || 'Used';
		}

		let radial = null;
		if (TyreMakeModel && ['Radial', 'Bias'].indexOf(TyreMakeModel.tyreType) > -1) {
			radial = TyreMakeModel.tyreType == "Radial" && true || false;
		}

		let tyre = {};
		await models.sequelize.transaction(async t => {
			tyre = await models.Tyre.create({
				tyreNo: TyreDraft.tyreNo,
				condition: condition,
				mfgBy: details.mfgBy,
				model: details.model,
				tyreStatus: details.tyreStatus,
				odometer: details && (details.odometer && details.odometer || 0) || 0,
				codeSize: details.codeSize.trim(),
				radial: radial,
				initialTreadDepth: details.initalTreadDepth || '',
				amount: !isNaN(details.amount) ? details.amount : 0,
				purchasedOn: moment().subtract(1, 'h').format(),
				installedOn: moment().format(),
				AssetId: AssetId,
				AccountId: TyreDraft.AccountId
			}, { transaction: t });


			let tyreHistBulk = [];
			tyreHistBulk.push({
				tyreNo: tyre.tyreNo,
				histDate: moment().subtract(1, 'h').format(),
				condition: details.histCondition || details.condition,
				tyreStatus: details.tyreStatus,
				transaction: "Purchase",
				position: null,
				inflation: null,
				wearPattern: null,
				treadDepth: tyre.initialTreadDepth,
				inspectedBy: null,
				shopName: null,
				amount: tyre.amount,
				odometer: null,
				tyreOdometer: 0,
				stockLocation: "",
				BranchId: null,
				comments: null,
				tpmsData: {},
				UserId: res.locals.UserId,
				username: res.locals.username,
				AccountId: tyre.AccountId
			})

			if (tyre.AssetId) {
				tyreHistBulk.push({
					tyreNo: tyre.tyreNo,
					histDate: moment().format(),
					condition: details.histCondition || details.condition,
					tyreStatus: details.tyreStatus,
					transaction: "Fitment",
					position: details.position && details.position || "",
					odometer: details && details.fitmentOdo || tyre.odometer,
					tyreOdometer: tyre.odometer,
					treadDepth: details.currentTreadDepth && details.currentTreadDepth || 0,
					amount: tyre.amount,
					stockLocation: tyre.stockLocation,
					BranchId: null,
					AssetId: tyre.AssetId,
					UserId: res.locals.UserId,
					username: res.locals.username,
					AccountId: tyre.AccountId
				})
			}

			let tyreHistories = await models.TyreHistory.bulkCreate(tyreHistBulk, {
				returning: true, transaction: t
			});

			var matchTyreHist = tyreHistories.find(x => x.tyreNo == tyre.tyreNo && x.transaction == 'Fitment');
			if (!matchTyreHist) {
				matchTyreHist = tyreHistories.find(x => x.tyreNo == tyre.tyreNo);
			}

			var tyreHist = JSON.parse(JSON.stringify(matchTyreHist));
			tyre.lastStatus = tyreHist;
			await tyre.save({ transaction: t });
			await TyreDraft.destroy({ transaction: t });
		});

		return res.send({ success: true, tyre: tyre });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error creating tyre');
		return res.send({ success: false, error: "Error creating tyre" });
	}
}

exports.list = async function (req, res) {
	const ROUTE = 'app/tyredrafts/list';
	try {
		let where = {};
		where.AccountId = res.locals.AccountId;
		if (['XE FTE', 'ARSA', 'AMCC FTE'].indexOf(res.locals.role) > -1) { //For xpert edge - customers based
			where.AccountId = res.locals.accountIds;
		}
		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			let accountIds = [];
			if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
				res.GeozoneId = geozoneResult.geozones.map(x => x.id);
				if (req.body.GeozoneId) {
					res.GeozoneId = req.body.GeozoneId;
				}
				let result = await avolveHelper.fetchCustomers(res);
				accountIds = result && result.customers.map(x => x.id) || [];
			}
			where.AccountId = accountIds;
		}
		let TyreDrafts = await models.TyreDraft.findAll({
			where: where
		});
		return res.send({ success: true, results: TyreDrafts });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching tyres');
		return res.send({ success: false, error: "Error fetching tyres" });
	}
}

exports.update = async function (req, res) {
	const ROUTE = 'app/tyredrafts/update';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.params.id) {
			return res.send({ success: false, error: 'Draft id missing' });
		}
		if (!req.body.condition) {
			return res.send({ success: false, error: 'Please select condition to add tyre.' });
		}

		if (!req.body.initialTreadDepth) {
			return res.send({ success: false, error: 'Initial tread depth missing.' });
		}

		if (!req.body.currentTreadDepth) {
			return res.send({ success: false, error: 'Current tread depth missing.' });
		}

		if (req.body.initialTreadDepth && isNaN(req.body.initialTreadDepth)) {
			return res.send({ success: false, error: 'Invalid InitialTreadDepth.' });
		}

		if (req.body.currentTreadDepth && isNaN(req.body.currentTreadDepth)) {
			return res.send({ success: false, error: 'Invalid CurrentTreadDepth.' });
		}

		if (Number(req.body.currentTreadDepth) > Number(req.body.initialTreadDepth)) {
			return res.send({ success: false, error: 'CurrentTreadDepth should not be greater than InitialTreadDepth.' });
		}

		//#region role based restriction
		let AccountId = res.locals.AccountId;
		if (['XE FTE', 'ARSA'].indexOf(res.locals.role) > -1) { //For xpert edge - customers based
			if (!req.query.AccountId) {
				return res.send({ success: false, error: `Please select customer to add tyre.` });
			}
			let matchAcc = res.locals.accounts.find(x => x == parseInt(req.query.AccountId));
			if (!matchAcc) {
				return res.send({ success: false, error: `Selected customer not mapped for this ${res.locals.role} user.` });
			}
			AccountId = matchAcc;
		}

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			if (!req.body.AssetId) {
				return res.send({ success: false, error: `Please select vehicle to add tyre.` });
			}
			let accountIds = [];
			if (res.locals.role == "AMCS FTE") {
				let geozoneResult = await avolveHelper.fetchGeozones(res);
				if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
					res.GeozoneId = geozoneResult.geozones.map(x => x.id);
					if (req.body.GeozoneId) {
						res.GeozoneId = req.body.GeozoneId;
					}
					let result = await avolveHelper.fetchCustomers(res);
					accountIds = result && result.customers.map(x => x.id) || [];
				}
			} else {
				accountIds = res.locals.accountIds;
			}

			let Asset = await models.Asset.findOne({
				attributes: ['id', 'lplate', 'plan', 'AccountId'],
				where: {
					id: req.body.AssetId,
					plan: res.locals.role == "AMCS FTE" && 1 || 2
				}
			});

			if (!Asset) {
				return res.send({ success: false, error: `Vehicle not offered for this ${res.locals.role} user.` });
			}

			let matchAcc = accountIds.find(x => x == Asset.AccountId);
			if (!matchAcc) {
				return res.send({ success: false, error: `Vehicle not offered for this ${res.locals.role} user.` });
			}
			AccountId = Asset.AccountId;
		}
		//#endregion

		let TyreDraft = await models.TyreDraft.findOne({
			where: {
				id: req.params.id,
				AccountId: AccountId
			}
		});

		if (!TyreDraft) {
			return res.send({ success: false, error: 'Tyre draft not found' });
		}

		let TyreMakeModels = await models.TyreMakeModel.findAll({
			attributes: ['id', 'make', 'model', 'tyreType', 'codeSize'],
			where: {
				apollo: true
			}
		});

		if (req.body.tyrePosition && req.body.AssetId) {
			let TyreHistories = await models.TyreHistory.findAll({
				attributes: ['id', 'tyreNo', 'position', 'AssetId', 'transaction'],
				where: {
					AssetId: req.body.AssetId,
					position: req.body.tyrePosition
				}
			});
			let isTyreRemoved = false;
			if (TyreHistories.find(x => ["Remove", "Retread Sent", "Retread Recd", "Scrap", "Scrap Complete", "Sold"].indexOf(x.transaction) > -1)) {
				isTyreRemoved = true;
			}
			if (TyreHistories.find(x => x.transaction == "Fitment") && !isTyreRemoved) {
				return res.send({ success: false, error: `Tyre ${TyreHistories.find(x => x.transaction == "Fitment").tyreNo} already exist in given position.` });
			}
		}

		let Asset;
		let condition = req.body.condition;
		if (condition != "New" && req.body.AssetId) {
			Asset = await models.Asset.findOne({
				attributes: ['id', 'lplate', 'odo'],
				include: [{
					attributes: ['id', 'tyreNo', 'lastStatus'],
					model: models.Tyre,
					where: {
						'lastStatus.position': req.body.tyrePosition
					},
					required: false
				}],
				where: {
					id: req.body.AssetId,
					AccountId: AccountId
				}
			});

			if (!Asset) {
				return res.send({ success: false, error: 'Vehicle not found.' });
			}

			if (!req.body.tyrePosition || req.body.tyrePosition == "null") {
				return res.send({ success: false, error: 'Tyre position missing.' });
			}
		}

		let tyreStatus = 0;
		let retreadTyre = false;
		if (['Retread', 'Retread 1', 'Retread 2', 'Retread 3'].indexOf(condition) > -1) {
			tyreStatus = 4;
			if (req.body.AssetId) tyreStatus = 1;
			retreadTyre = true;
		} else if (req.body.AssetId) {
			tyreStatus = 1;
			condition = "Used";
		}

		if (req.body.condition == "Used" && !req.body.AssetId) {
			tyreStatus = 2; //Removed
		}

		let initalTreadDepth = req.body.initialTreadDepth && req.body.initialTreadDepth || '';
		let currentTreadDepth = req.body.currentTreadDepth && req.body.currentTreadDepth || '';
		if (retreadTyre) {
			initalTreadDepth = currentTreadDepth;
		}

		let tyreNo = req.body.tyreNo.replace(' ', '');

		let details = JSON.parse(JSON.stringify(TyreDraft.details));
		let mfgBy = req.body.mfgBy == "Other" && req.body.mfgByOther || req.body.mfgBy;
		let model = req.body.model == "Other" && req.body.modelOther || req.body.model;
		let codeSize = req.body.codeSize == "Other" && req.body.codeSizeOther || req.body.codeSize;

		let matchMakeModel = TyreMakeModels.find(x => x.make == mfgBy && x.model == model && x.codeSize == codeSize);
		let radial = null;
		if (matchMakeModel && ['Radial', 'Bias'].indexOf(matchMakeModel.tyreType) > -1) {
			radial = matchMakeModel.tyreType == "Radial" && true || false;
		}

		details.mfgBy = mfgBy || '';
		details.model = model || '';
		details.codeSize = codeSize || '';
		details.radial = radial;
		details.initalTreadDepth = initalTreadDepth;
		details.currentTreadDepth = currentTreadDepth;
		details.condition = condition;
		details.histCondition = req.body.condition;
		details.position = req.body.tyrePosition && req.body.tyrePosition || '';
		details.amount = !isNaN(req.body.amount) ? req.body.amount : 0;
		details.tyreStatus = tyreStatus;
		details.AssetId = req.body.AssetId && req.body.AssetId || '';
		details.odometer = Asset && (Asset.odo && Asset.odo || 0) || 0;

		let updTyreDraft = await TyreDraft.update({
			tyreNo: tyreNo,
			AccountId: AccountId,
			details: details
		});

		return res.send({ success: true, tyreDraft: updTyreDraft });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching tyre');
		return res.send({ success: false, error: "Error fetching tyre" });
	}
}

exports.checkAllTyreExists = async function (req, res) {
	const ROUTE = 'app/tyredrafts/checkAllTyreExists';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Asset id missing' });
		}

		let tyreWhere = {
			AssetId: req.params.id,
			AccountId: res.locals.AccountId
		}

		let assetWhere = {
			id: req.params.id,
			AccountId: res.locals.AccountId
		}

		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			let accountIds = [];
			if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
				let result = await avolveHelper.fetchCustomers(res);
				accountIds = result && result.customers.map(x => x.id) || [];
			}
			tyreWhere.AccountId = accountIds;
			assetWhere.AccountId = accountIds;
			assetWhere.plan = 1; //AMCS
		}

		if (['XE FTE', 'ARSA', 'AMCC FTE'].indexOf(res.locals.role) > -1) { //For xpert edge - customers based
			let accountIds = req.query.AccountId && [req.query.AccountId] || res.locals.accountIds
			if (!accountIds.length) {
				return res.send({ success: false, error: `Customers not mapped for this ${res.locals.role} user.` });
			}
			assetWhere.AccountId = accountIds;
			tyreWhere.AccountId = accountIds;
			assetWhere.plan = 4;
			if (res.locals.role == 'AMCC FTE') assetWhere.plan = 2; //AMCC
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'axleProfile', 'axleConfig', 'AccountId'],
			where: assetWhere,
			raw: true
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		let Account = await redisHelper.getAccount(Asset.AccountId);
		let axleProfile = Asset.axleProfile.split('W');

		let allTyres = await models.Tyre.findAll({
			attributes: ['id', 'tyreNo', 'lastStatus', 'AssetId'],
			where: tyreWhere,
			raw: true
		});

		let ignorePositions = ["SP", "SP1", "SP2", "SP3", "SP4"];
		let inActAxleCount = 0;
		if (Asset.axleConfig && Asset.axleConfig.config) {
			let inActiveAxles = Asset.axleConfig.config.filter(x => x.active == false); //ignore in active axle positions
			for (let inActiveAxle of inActiveAxles) {
				if (inActiveAxle.position) {
					inActAxleCount += inActiveAxle.position.length;
					inActiveAxle.position.map(x => ignorePositions.push(x));
				}
			}
		}

		let Tyres = [];
		for (let allTyre of allTyres) {
			let isSpare = false;
			if (allTyre.lastStatus && allTyre.lastStatus.position && ignorePositions.indexOf(allTyre.lastStatus.position) > -1) {
				isSpare = true;
			}
			if (!isSpare) {
				Tyres.push(allTyre);
			}
		}

		let allTyreExist = false;
		if (Tyres.length == parseInt(axleProfile[0] - inActAxleCount)) {
			allTyreExist = true;
		}

		if (Account && Account.details && Account.details.avolve && JSON.parse(Account.details.avolve) == true) {
			let AplService = await models.AplService.count({
				where: tyreWhere
			});
			if (!AplService && !allTyreExist) {
				return res.send({ success: false, error: '1. Tyre Onboarding is pending for the vehicle.\n2. Service master is not updated for the vehicle configuration. Please connect with your KAM.' });
			}
			if (!AplService && (!Account.details.testAcc || JSON.parse(Account.details.testAcc) != true)) { // ignore test accounts
				return res.send({ success: false, error: 'Service master is not updated for the vehicle configuration. Please connect with your KAM.' });
			}
		}

		return res.send({ success: true, result: allTyreExist });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching tyres count');
		return res.send({ success: false, error: "Error fetching tyres count" });
	}
}