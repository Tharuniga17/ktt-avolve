const models = require("../../../models");
const moment = require("moment");
const evt = require('../../../lib/event');
const md5 = require('../../../lib/md5').md5;
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const avolveHelper = require('../../../lib/helpers/avolveHelper');
const redisHelper = require('../../../lib/helpers/redis');
const tyreStatusConfig = require('../../../config/tyre-status.json');
const { Op } = require('sequelize');

exports.get = async function (req, res) {
	const ROUTE = 'app/tyres/get';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Tyre Id missing.' });
		}

		let Tyre = await models.Tyre.findOne({
			where: {
				id: req.params.id
			},
			raw: true
		});

		if (!Tyre) {
			return res.send({ success: false, error: 'Tyre not found.' });
		}

		return res.send({ success: true, tyre: Tyre });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching tyre');
		return res.send({ success: false, error: 'Error fetching tyre.' });
	}
}

exports.list = async function (req, res) {
	const ROUTE = 'app/tyres/list';
	try {
		var whereClause = {}, offset = 0, limit = 0;

		//#region filters
		if (req.query.pagination) {
			if (req.query.vehicle) {
				whereClause.AssetId = req.query.vehicle;
			}
			if (req.query.pagination) {
				offset = req.query.pagination['page'];
				limit = req.query.pagination['perPage'];
			}
			if (req.query.tyreNo) {
				whereClause.tyreNo = { [Op.iLike]: '%' + req.query.tyreNo + '%' };
				offset = null;
				limit = null;
			}
			if (req.query.assigned && !req.query.unAssigned) {
				whereClause.AssetId = {
					[Op.ne]: null
				};
			}
			if (req.query.unAssigned && !req.query.assigned) {
				whereClause.AssetId = null;
			}
			if (req.query.status) {
				whereClause.tyreStatus = req.query.status;
			}
		} else {
			if (req.query.sdate && req.query.edate) {
				let sdate = moment(req.query.sdate).startOf('day').format();
				let edate = moment(req.query.edate).endOf('day').format();
				let diffInMonths = (moment(edate).diff(moment(sdate), 'months') + 1);
				if (diffInMonths > 3) {
					return res.send({ success: false, error: 'Please select date range within 3 months.' });
				}

				whereClause.purchasedOn = {
					[Op.between]: [sdate, edate]
				}
			}
			if (req.query.branch) {
				whereClause['$Branch.id$'] = req.query.branch;
			}
			if (req.query.tyreNo) {
				whereClause.tyreNo = {
					[Op.iLike]: '%' + req.query.tyreNo + '%'
				};
				delete whereClause.purchasedOn;
			}
			if (req.query.status) {
				if (parseInt(req.query.status) == 0) {
					whereClause.tyreStatus = {
						[Op.in]: [0, 4]
					}
					whereClause.AssetId = null;
				} else {
					whereClause.tyreStatus = req.query.status;
				}
			}
			offset = limit = null;
		}

		if (req.query.mfgBy) {
			whereClause.mfgBy = req.query.mfgBy;
		}
		if (req.query.model) {
			whereClause.model = req.query.model;
		}
		if (req.query.position) {
			whereClause.details = { ...whereClause.details, recomPosn: req.query.position };
		}
		if (req.query.tyreCondition) {
			req.query.tyreCondition = req.query.tyreCondition.split(',');
			whereClause.condition = req.query.tyreCondition;
		}

		let accountWhere = {
			id: res.locals.AccountId
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) { //For xpert edge - customers based
			accountIds = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
			accountWhere.id = accountIds;
		}

		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			if (req.query.GeozoneId) {
				res.GeozoneId = req.query.GeozoneId;
				let result = await avolveHelper.fetchCustomers(res);
				let accountIds = result && result.customers.length && result.customers.map(x => x.id) || [];
				if (req.query.AccountId && req.query.AccountId != "null") {
					whereClause.AccountId = req.query.AccountId;
					accountWhere.id = req.query.AccountId;
				} else if (accountIds.length) {
					whereClause.AccountId = accountIds;
					accountWhere.id = accountIds;
				}
			}
		}

		if (res.locals.role == "AMCC FTE") { //For xpert edge - customers based
			accountIds = res.locals.accountIds;
			accountWhere.id = accountIds;
		}

		var groupInclude;
		if (req.query.vehicleGroup) {
			if (isNaN(req.query.vehicleGroup)) {
				return res.send({ success: false, results: [], error: 'Invalid group id.' });
			}
			groupInclude = {
				model: models.Asset,
				attributes: ["lplate", "AccountId"],
				include: [{
					model: models.Group,
					attributes: ['id', 'name'],
					where: {
						id: req.query.vehicleGroup
					},
					required: true
				}]
			}
		} else {
			groupInclude = {
				model: models.Asset,
				attributes: ["lplate", "AccountId"]
			}
		}
		//#endregion

		let tyres = await models.Tyre.findAll({
			include: [{
				model: models.Account,
				attributes: ["id"],
				where: accountWhere
			}, groupInclude,
			{
				model: models.Branch,
				attributes: ['id', 'name']
			}],
			offset: offset * limit,
			limit: limit,
			where: whereClause
		});

		return res.send({ success: true, results: tyres });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching data.');
		return res.send({ success: false, error: 'Error fetching data.' });
	}
}

exports.bulkCreate = async function (req, res) {
	const ROUTE = 'app/tyres/bulkCreate';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.username}`);
		if (!req.body.tyreNos) {
			return res.send({ success: false, error: 'Input Parameters missing.' });
		}
		if (!req.body.condition) {
			return res.send({ success: false, error: 'Please select condition to add tyre.' });
		}
		let tyreNos = JSON.parse(req.body.tyreNos).map(x => x.replace(' ', ''));

		//#region role based restriction
		let AccountId = res.locals.AccountId;
		if (['XE FTE', 'ARSA'].indexOf(res.locals.role) > -1) { //For xpert edge - customers based
			if (!req.query.AccountId) {
				return res.send({ success: false, error: 'Please select customer to add tyre.' });
			}
			let matchAcc = res.locals.accountIds.find(x => x == parseInt(req.query.AccountId));
			if (!matchAcc) {
				return res.send({ success: false, error: `Selected customer not mapped for this ${res.locals.role} user.` });
			}
			AccountId = matchAcc;
		}

		if (res.locals.role == 'AMCC FTE') {
			AccountId = res.locals.accountIds.length && res.locals.accountIds[0] || [];
		}

		//#region service 2.0 Tyre validation
		let tyreNoSet = new Set();
		for (const tyreNo of tyreNos) {
			if (tyreNoSet.has(tyreNo)) {
				return res.send({ success: false, error: `Duplicate Tyre serial no. found. Please check and enter correct tyre serial no.` });
			} else {
				tyreNoSet.add(tyreNo);
			}
			const regex = /[\s!@#$%^&*(),.?":{}|<>]|[^\x00-\x7F]/;
			let validateTyreNo = regex.test(tyreNo); //check if tyreNo has space or special character
			if (validateTyreNo) {
				return res.send({ success: false, error: `Please enter a valid tyre number. Special characters, spaces, or regional language characters are not allowed.` });
			}
		}

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'tyreNo', 'tyreStatus', 'lastStatus'],
			include: [{
				attributes: ['id', 'lplate'],
				model: models.Asset
			}, {
				attributes: ['id', 'tname'],
				model: models.Account,
				where: {
					status: 1, //Active customer
					AccountIdParent: res.locals.masterAccountId,
					id: AccountId
				}
			}],
			where: {
				tyreNo: tyreNos
			}
		});

		for (const Tyre of Tyres) {
			let status = '', position = '';
			if (Tyre.lastStatus && Object.keys(Tyre.lastStatus).length) {
				position = Tyre.lastStatus.position || '';
				status = Tyre.lastStatus.tyreStatus == null || Tyre.lastStatus.tyreStatus == '' ? parseInt(Tyre.tyreStatus) : parseInt(Tyre.lastStatus.tyreStatus);
				status = statusDisplay(status);
			} else {
				status = statusDisplay(parseInt(Tyre.tyreStatus));
			}
			if (Tyre.Asset) {
				let lplate = Tyre.Asset && Tyre.Asset.lplate || '';
				return res.send({ success: false, error: `<html>Tyre serial no.<b>${Tyre.tyreNo}</b> already exists with <b>${(Tyre.Account && Tyre.Account.tname) || ''}</b>${lplate ? ` under Vehicle <b>${lplate}</b>` : ''}${position ? ` in <b>${position}</b> Position` : ''}.</html>`, tyreNo: Tyre.tyreNo });
			}
			return res.send({ success: false, error: `<html>Tyre serial no.<b>${Tyre.tyreNo}</b> already exists with <b>${Tyre.Account && Tyre.Account.tname || ''}</b> under <b>${status}</b> Section.</html>`, tyreNo: Tyre.tyreNo });
		}
		//#endregion

		if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
			if (!req.body.AssetId) {
				return res.send({ success: false, error: 'Please select vehicle to add tyre.' });
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

			AccountId = Asset.AccountId;
		}
		//#endregion


		let TyreMakeModels = await models.TyreMakeModel.findAll({
			attributes: ['id', 'make', 'model', 'tyreType', 'codeSize'],
			where: {
				apollo: true
			}
		});

		let Asset;
		let condition = req.body.condition;
		if (req.body.AssetId) {
			if (!req.body.tyrePosition || req.body.tyrePosition == "null") {
				return res.send({ success: false, error: 'Tyre position missing.' });
			}

			let assetWhere = {
				id: req.body.AssetId,
				AccountId: AccountId
			}

			if (res.locals.role == "AMCS FTE") assetWhere.plan = 1;
			if (res.locals.role == "AMCC FTE") assetWhere.plan = 2;
			if (["XE FTE", "ARSA"].includes(res.locals.role)) assetWhere.plan = 4;
			if (res.locals.role == "DE FTE") assetWhere.plan = 3;

			Asset = await models.Asset.findOne({
				attributes: ['id', 'lplate', 'odo', 'AccountId', 'axleProfile', 'axleConfig', 'details'],
				include: [{
					attributes: ['id', 'tyreNo', 'lastStatus'],
					model: models.Tyre,
					where: {
						'lastStatus.position': req.body.tyrePosition
					},
					required: false
				}],
				where: assetWhere
			});

			if (!Asset) {
				return res.send({ success: false, error: 'Vehicle not found.' });
			}

			if (Asset && Asset.Tyres.length) {
				return res.send({ success: false, error: `Tyre ${Asset.Tyres[0].tyreNo} already exist in given position.` });
			}

			if (!Asset.odo || !req.body.odo || Number(req.body.odo) <= 0) {
				return res.send({ success: false, error: 'Please enter vehicle odo.' });
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

		if (!retreadTyre) {
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
		}

		let matchMakeModel = TyreMakeModels.find(x => x.make == req.body.mfgBy && x.model == req.body.model && x.codeSize == req.body.codeSize);
		let radial = null;
		if (matchMakeModel && ['Radial', 'Bias'].indexOf(matchMakeModel.tyreType) > -1) {
			radial = matchMakeModel.tyreType == "Radial" && true || false;
		}

		let initalTreadDepth = req.body.initialTreadDepth && req.body.initialTreadDepth || '';
		let currentTreadDepth = req.body.currentTreadDepth && req.body.currentTreadDepth || '';
		if (retreadTyre) {
			initalTreadDepth = currentTreadDepth;
		}

		let isObService = false;
		let AplJobCardId = null;
		let aplJobcard;
		let enRouteFitment = false;
		if (req.body.AplJobCardId != "null" && req.body.AplJobCardId > 0) {
			AplJobCardId = req.body.AplJobCardId;
		}

		if (AplJobCardId) {
			aplJobcard = await models.AplJobCard.findOne({
				attributes: ['id', 'status', 'services'],
				where: {
					id: AplJobCardId
				}
			});

			if (aplJobcard) {
				let services = JSON.parse(JSON.stringify(aplJobcard.services));
				let matchService = services.find(x => x.ServiceTypeId == req.body.ServiceTypeId);
				if (services.find(x => x.serviceName == "Onboarding Service")) {
					isObService = true;
				}
				if (matchService && matchService.serviceName == "En Route Tyre Replacement") { //En Route Tyre Replacement fitted count update
					enRouteFitment = true;
				}
			}

			if (aplJobcard && [2, 3].indexOf(aplJobcard.status) > -1) {
				return res.send({ success: false, error: 'Jobcard must be active to proceed onboarding service.' });
			}
		}

		let TyreVerification = {};
		if (req.body.isTyreVerification && req.body.isTyreVerification == 'true') { //enroute fitment true at tyre verification level
			enRouteFitment = true;
			TyreVerification = await models.Inspection.findOne({
				attributes: ['id', 'details'],
				where: {
					type: 'tv',
					AssetId: req.body.AssetId,
					AccountId: AccountId
				},
				order: [['id', 'desc']]
			});

			if (!TyreVerification) {
				return res.send({ success: false, error: 'Tyre Verification Pending.' });
			}
		}

		//#region invoice image upload
		let invoiceImgs = (req.files) && req.files.filter(files => {
			return files.originalname;
		}) || '';
		let imagesPush = [];
		if (req.files && invoiceImgs && invoiceImgs.length) {
			imagesPush = imagesPush.concat(invoiceImgs);
		}
		let imagePaths = req.body.billNumber && invoiceImgs.length > 0 ? invoiceImgs.map(obj => {
			return '/' + md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + req.body.billNumber.replace(/\\|\//g, "") + '_' + obj.filename;
		}).toString() : null;
		//#endregion

		let mfFitment = false;
		if (Asset) {
			let mf = mfTransactionCheck(Asset, req.body.tyrePosition);
			if (mf && req.body.condition == "New" && initalTreadDepth == currentTreadDepth) {
				mfFitment = true;
			}
		}
		//#endregion

		let newTyres = [];
		let tyreHistBulk = [];
		for (const tyreNo of tyreNos) {
			let newTyre = {
				tyreNo: tyreNo,
				condition: condition,
				mfgBy: req.body.mfgBy,
				model: req.body.model,
				tyreStatus: tyreStatus,
				codeSize: req.body.codeSize.trim(),
				radial: radial,
				purchasedFrom: req.body.purchasedFrom || "",
				billNumber: req.body.billNumber || "",
				purchasedOn: req.body.purchasedOn && moment(req.body.purchasedOn).toISOString() || moment().subtract(1, 'h').toISOString(),
				installedOn: moment().format(),
				odometer: Asset && (Asset.odo && Asset.odo || 0) || 0,
				initialTreadDepth: initalTreadDepth,
				amount: !isNaN(req.body.amount) ? req.body.amount : 0,
				AssetId: req.body.AssetId && req.body.AssetId || null,
				AccountId: Asset && Asset.AccountId || AccountId,
				invoiceImages: imagePaths,
				details: {
					mf: mfFitment
				}
			};
			newTyres.push(newTyre);

			tyreHistBulk.push({
				tyreNo: tyreNo,
				histDate: newTyre.purchasedOn,
				condition: req.body.condition,
				tyreStatus: tyreStatus,
				transaction: "Purchase",
				position: "",
				inflation: null,
				wearPattern: null,
				treadDepth: currentTreadDepth,
				inspectedBy: null,
				shopName: null,
				amount: newTyre.amount,
				odometer: null,
				tyreOdometer: 0,
				stockLocation: "",
				BranchId: null,
				comments: null,
				tpmsData: {},
				UserId: res.locals.UserId,
				username: res.locals.username,
				AplJobCardId: AplJobCardId && AplJobCardId || null,
				AccountId: newTyre.AccountId
			});

			if (newTyre.AssetId) {
				let recomPsi = "";
				//#region recommended PSI capture
				let Account = await models.Account.findOne({
					attributes: ['id', 'details'],
					where: {
						id: Asset && Asset.AccountId || AccountId
					}
				});

				let accountPsiConfig = Account && Account.details && Account.details.psiConfig || [];
				let tyreType = "";
				if (newTyre.radial == true) {
					tyreType = "Radial";
				} else if (newTyre.radial == false) {
					tyreType = "Bias";
				}

				if (Asset && Asset.axleProfile && Asset.details && Asset.details.axleProfile) {
					let matchAxleProfile = accountPsiConfig.find(x => x.wheeler == Asset.axleProfile && x.config == Asset.details.axleProfile.config && x.name == Asset.details.axleProfile.name);
					if (matchAxleProfile && matchAxleProfile.tyreSizes) {
						let matchTyreSize = matchAxleProfile.tyreSizes.find(x => x.size.trim() == newTyre.codeSize.trim() && x.type == tyreType);
						if (matchTyreSize && matchTyreSize.config && matchTyreSize.config.length) {
							let matchPosition = matchTyreSize.config.find(x => x.position == req.body.tyrePosition && req.body.tyrePosition || '');
							recomPsi = matchPosition && matchPosition.psi || "";
						}
					}
				}
				//#endregion

				tyreHistBulk.push({
					tyreNo: newTyre.tyreNo,
					histDate: moment().format(),
					condition: req.body.condition,
					tyreStatus: tyreStatus,
					transaction: "Fitment",
					position: req.body.tyrePosition && req.body.tyrePosition || '',
					odometer: req.body.odo || 0,
					tyreOdometer: 0,
					treadDepth: currentTreadDepth,
					amount: newTyre.amount,
					stockLocation: newTyre.stockLocation,
					BranchId: null,
					AssetId: newTyre.AssetId,
					UserId: res.locals.UserId,
					username: res.locals.username,
					AplJobCardId: AplJobCardId && AplJobCardId || null,
					AccountId: newTyre.AccountId,
					details: {
						grooves: newTyre.lastStatus && newTyre.lastStatus.details && newTyre.lastStatus.details.grooves || {},
						enRoute: enRouteFitment,
						recomPsi: recomPsi,
						mf: mfFitment,
						mfFitment: mfFitment
					}
				});
			}
		}

		await models.sequelize.transaction(async t => {
			const tyres = await models.Tyre.bulkCreate(newTyres, { returning: true, transaction: t });
			let tyreHistories = await models.TyreHistory.bulkCreate(tyreHistBulk, { returning: true, transaction: t });
			const tyreHistoriesMap = tyreHistories.reduce((acc, hist) => {
				if (!acc[hist.tyreNo] || hist.transaction == "Fitment") {
					acc[hist.tyreNo] = hist.toJSON();
				}
				return acc;
			}, {});

			await Promise.all(tyres.map(async (tyre) => {
				const matchTyreHist = tyreHistoriesMap[tyre.tyreNo] || null;
				if (!matchTyreHist) {
					matchTyreHist = tyreHistories.find(x => x.tyreNo == tyre.tyreNo);
				}

				if (!matchTyreHist) return;
				tyre.lastStatus = { ...matchTyreHist };
				await tyre.save({ transaction: t });

				if (Asset && tyre.AssetId) {
					if (req.body.odo && req.body.odo > Asset.odo) {
						await Asset.update({
							odo: Math.round(req.body.odo)
						}, { transaction: t });
					}
				}

				//#region capture enroute service details in tyre verification stage
				if (req.body.isTyreVerification && req.body.isTyreVerification == 'true' && TyreVerification && Object.keys(TyreVerification).length) {
					let details = JSON.parse(JSON.stringify(TyreVerification.details)) || {};
					let enrouteRemoveCount = details.enrouteServices && details.enrouteServices.fitment || 0;
					details.enrouteServices.fitment = enrouteRemoveCount + 1;
					details.enrouteServices.text = details.enrouteServices.rotation && `${details.enrouteServices.rotation} Tyres Rotated${!enrouteRemoveCount ? ' while Enroute' : ''}` || '';
					if (details.enrouteServices.fitment) {
						details.enrouteServices.text += details.enrouteServices.text && ` & ${details.enrouteServices.fitment} Tyres Replaced while Enroute.` || `${details.enrouteServices.fitment} Tyres Replaced while Enroute.`;
					}
					await TyreVerification.update({
						details: details
					}, { transaction: t });
				}
				//#endregion

				if (aplJobcard && req.body.ServiceTypeId) {
					let services = JSON.parse(JSON.stringify(aplJobcard.services));
					let matchService = services.find(x => x.ServiceTypeId == req.body.ServiceTypeId);
					//#region Tyre fitment service details update
					if (matchService && matchService.serviceName == "Tyre Fitment") { //Tyre fitment fitted count update
						if (!['SP', 'SP1', 'SP2', 'SP3', 'SP4'].includes(req.body.tyrePosition)) {
							matchService.execTyres = matchService.execTyres && Number(matchService.execTyres) + 1 || 1;
							if (matchTyreHist) {
								matchService.details.push({
									tyreNo: matchTyreHist.tyreNo,
									histDate: matchTyreHist.histDate,
									position: matchTyreHist.position
								});
							}
							await aplJobcard.update({
								services: services
							}, { transaction: t });
						}
					}
					//#endregion
					//#region en route tyre fitment service details update
					if (matchService && matchService.serviceName == "En Route Tyre Replacement") {
						matchService.details = matchService.details && matchService.details.length && matchService.details || [];
						matchService.execTyres = matchService.execTyres && Number(matchService.execTyres) + 1 || 1;
						if (matchTyreHist) {
							matchService.details.push({
								tyreNo: matchTyreHist.tyreNo,
								histDate: matchTyreHist.histDate,
								position: matchTyreHist.position
							});
						}
						await aplJobcard.update({
							services: services
						}, { transaction: t });
					}
					//#endregion
				}

				if (tyre.AssetId && ['XE FTE', 'ARSA', 'DE FTE'].indexOf(res.locals.role) > -1 && !AplJobCardId && matchTyreHist) {
					evt.events.emit('create-apollo-service-log', {
						AssetId: tyre.AssetId,
						AccountId: tyre.AccountId,
						serviceName: "Tyre Fitment",
						sTime: moment().toISOString(),
						odo: matchTyreHist.odo,
						transaction: "Tyre Fitment",
						details: [{
							tyreNo: matchTyreHist.tyreNo,
							histDate: matchTyreHist.histDate,
							position: matchTyreHist.position
						}],
						workshop: req.body.shopName && req.body.shopName || "",
						serviceType: req.body.serviceType && req.body.serviceType || "",
						user: {
							id: res.locals.UserId,
							username: res.locals.username,
							name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
							date: moment(matchTyreHist.histDate).toISOString()
						},
						updServiceSch: false
					});
				}

				//#region Process after tyre creation
				RecalculateCpkm([tyre.tyreNo], tyre.AccountId);
				if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1 && isObService) {
					evt.events.emit('check-allTyre-exists', {
						AssetId: tyre.AssetId,
						AccountId: tyre.AccountId
					});
				} else if (['XE FTE', 'ARSA', 'DE FTE'].includes(res.locals.role)) {
					evt.events.emit('check-allTyre-exists', {
						AssetId: tyre.AssetId,
						AccountId: tyre.AccountId
					});
				}

				for (const image of imagesPush) {
					if (image && image.path) {
						evt.events.emit('file-upload-handler-s3', {
							file: image.path,
							s3Path: md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + tyre.tyreNo.replace(/\\|\//g, "") + '_' + image.filename
						});
					}
				}

				evt.events.emit('apl-reportlog', {
					AccountId: tyre.AccountId,
					reportValues: ['cs'],
					month: moment().format('MM'),
					year: moment().format('YYYY')
				});
				//#endregion
			}));
		});

		return res.send({ success: true, results: newTyres });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		if (err.name == 'SequelizeUniqueConstraintError' || err.message == 'Validation error') {
			err = 'Tyre serial no. already exist in system.';
		}
		RaiseLogEvent(ROUTE, 'error', err, 'Error creating tyre');
		return res.send({ success: false, error: err });
	}
}

exports.inspect = async function (req, res) {
	const ROUTE = 'app/tyres/inspect';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		//#region requested tyre data
		var tyreData = [];
		var tyreNumbers = [];
		tyreData = JSON.parse(req.body.tyreData);
		for (const tyreRecord of tyreData) {
			tyreNumbers.push(tyreRecord.tyreNo);
		}
		//#endregion

		let AplJobCardId = null;
		if (req.body.AplJobCardId != "null" && req.body.AplJobCardId > 0) {
			AplJobCardId = req.body.AplJobCardId;
		}

		let AccountId = res.locals.AccountId;
		let aplJobcard = {};
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			let Asset = await models.Asset.findOne({
				attributes: ['id', 'lplate', 'AccountId'],
				where: {
					id: req.query.AssetId
				}
			});

			if (!Asset) {
				return res.send({ success: false, error: "Inspection restricted. Vehicle not found." });
			}

			AccountId = Asset.AccountId; //Assign AccountId from vehicle

			//#region fetch jobcard if Id send from APP
			if (AplJobCardId) {
				aplJobcard = await models.AplJobCard.findOne({
					attributes: ['id', 'status', 'AccountId', 'AssetId'],
					where: {
						id: AplJobCardId
					}
				});
				if (aplJobcard) { // Assign AccountId from Jobcard
					AccountId = aplJobcard.AccountId;
				}
			}
			//#endregion
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) { // For Xpert edge role fetch customers
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		//#region fetch tyres
		let tyres = await models.Tyre.findAll({
			include: [{
				model: models.Asset,
				attributes: ["id", "imei", "lplate", "odo", "billingType", "details", "axleProfile"]
			}],
			where: { AccountId: AccountId, tyreNo: { [Op.in]: tyreNumbers } }
		});

		if (tyres.length != tyreNumbers.length) {
			return res.send({ success: false, error: "Tyres not found." });
		}

		let assetCheck = tyres.find(x => !x.AssetId);
		if (assetCheck) {
			return res.send({ success: false, error: "Inspection restricted. Tyre already in removed status" });
		}
		//#endregion

		let branches = await models.Branch.findAll({
			attributes: ['id', 'name'],
			where: {
				AccountId: AccountId
			}
		});

		let Account = await models.Account.findOne({
			attributes: ['id', 'details'],
			where: {
				id: AccountId
			}
		});

		let AssetId = tyres[0].AssetId;

		let vehInspectWhere = {
			AssetId: AssetId,
			type: 'vd',
			AccountId: AccountId
		};

		let ignoreSpare = false;
		if (tyres[0].lastStatus && tyres[0].lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].includes(tyres[0].lastStatus.position)) {
			ignoreSpare = true;
		}

		let vehicleInspection = await models.Inspection.findOne({
			attributes: ['id', 'details', 'AssetId', 'ServiceBookingId'],
			where: vehInspectWhere,
			order: [['date', 'desc']]
		});

		if (ignoreSpare && !vehicleInspection) {
			vehInspectWhere.type = 'v';
			vehicleInspection = await models.Inspection.findOne({
				attributes: ['id', 'details', 'AssetId', 'ServiceBookingId'],
				where: vehInspectWhere,
				order: [['date', 'desc']]
			});
		}

		if (!vehicleInspection) {
			return res.send({ success: false, error: "Vehicle inspection not found. Please inspect vehicle before tyre inspection" });
		}

		let validateInspect = true;
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1 && AplJobCardId) {
			validateInspect = false;
		}

		if (validateInspect && moment().diff(vehicleInspection.date, 'h') > 72) { //Inspection window 72hrs
			return res.send({ success: false, error: "Vehicle inspection older than 72 hours. Please re-inspect" });
		}

		if (AplJobCardId) {
			let aplJobcard = await models.AplJobCard.findOne({
				attributes: ['id', 'status'],
				where: {
					id: AplJobCardId
				}
			});

			if (aplJobcard && [2, 3].indexOf(aplJobcard.status) > -1) {
				return res.send({ success: false, error: 'Jobcard must be active to proceed inspection.' });
			}
		}

		if (req.body.updateOdo && Math.round(req.body.odometer / 1000) && tyres[0].Asset) {
			var data = {};
			data.AssetId = AssetId;
			data.AccountId = AccountId;
			data.odo = Math.round(req.body.odometer / 1000);
			if (vehicleInspection.details && vehicleInspection.details.odo) {
				data.odo = Math.round(vehicleInspection.details.odo / 1000);
			}
			data.emp = {
				id: res.locals.UserId,
				number: res.locals.UserId,
				name: res.locals.username
			}
			// evt.events.emit('create-device-command', data); Not required until GPS are used for Apollo Fleet
		}

		let odo = req.body.odometer;
		if (vehicleInspection.details && vehicleInspection.details.odo) {
			odo = Number(vehicleInspection.details.odo);
			if (!odo) {
				odo = tyres[0].Asset.odo;
			}
		}

		if (ignoreSpare) {
			odo = tyres[0].Asset.odo;
		}

		let assetOdo = tyres[0].Asset.odo;
		RaiseLogEvent(ROUTE, AssetId, { inputOdo: odo, AssetOdo: assetOdo }, 'Odo details for inspection before update in vehicle');

		let odoValidation = true;
		if (vehicleInspection.details && (vehicleInspection.details.resetOdo || vehicleInspection.details.notOperOdo)) {
			odoValidation = false;
		}

		if (!tyres[0].Asset.imei && odoValidation && Number(assetOdo) > Number(odo)) {
			return res.send({ success: false, error: 'Odometer should be greater than previous inspection/vehicle odometer.' });
		}

		if (Number(odo) > Number(assetOdo)) {
			let updAsset = await tyres[0].Asset.update({
				odo: Math.round(odo)
			});

			if (updAsset) {
				RaiseLogEvent('inspections/inspect', AssetId, { inputOdo: odo, AssetOdo: updAsset.odo }, `Vehicle odo after update`);
			}
		}

		let assetAxleProfile = tyres[0].Asset && tyres[0].Asset.details && tyres[0].Asset.details.axleProfile || {};
		let axleProfile = tyres[0].Asset && tyres[0].Asset.axleProfile || "";
		let accountPsiConfig = Account && Account.details && Account.details.psiConfig || [];

		var histBulk = [];
		var tyreImages = [];
		var histDate = (moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss").isValid()) ? moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss") : moment();
		var amountSplit = !isNaN(req.body.amount) ? req.body.amount / tyreNumbers.length : 0;
		for (const tyre of tyres) {
			var tyreInspect = tyreData.find(x => x.tyreNo == tyre.tyreNo);
			if (!odo) {
				odo = tyre.Asset && tyre.Asset.odo || 0;
			}
			if (vehicleInspection.details && vehicleInspection.details.odo) {
				odo = Number(vehicleInspection.details.odo);
			}
			if (!tyre.lastStatus.tyreOdometer) {
				tyre.lastStatus.tyreOdometer = 0;
			}

			RaiseLogEvent(ROUTE, tyre.tyreNo, { odo: odo, lastAssetOdo: tyre.lastStatus.odometer, lastTyreOdo: tyre.lastStatus.tyreOdometer }, 'Previous transaction odo values.');

			var tyreOdo = (odo - parseInt(tyre.lastStatus.odometer)) > 0 ? parseInt(tyre.lastStatus.tyreOdometer) + (odo - parseInt(tyre.lastStatus.odometer)) : parseInt(tyre.lastStatus.tyreOdometer);
			//for reset odo add the vehicle odo with tyre odo
			if (vehicleInspection.details && vehicleInspection.details.resetOdo && vehicleInspection.details.resetOdo == true) {
				tyreOdo = parseInt(tyre.lastStatus.tyreOdometer) + Number(odo);
			}
			//for odo not operational use last tyre odo
			if (vehicleInspection.details && vehicleInspection.details.notOperOdo && vehicleInspection.details.notOperOdo == true) {
				tyreOdo = parseInt(tyre.lastStatus.tyreOdometer);
			}
			if (tyre.lastStatus && tyre.lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].indexOf(tyre.lastStatus.position) > -1) { //Reset tyre odo if prev is Stepney
				tyreOdo = parseInt(tyre.lastStatus.tyreOdometer);
			}
			var tyreImgs = (req.files) ? req.files.filter(files => {
				return files.originalname.substring(0, files.originalname.indexOf('_')) == tyre.tyreNo;
			}) : [];

			if (req.files && tyreImgs && tyreImgs.length) {
				tyreImages = tyreImages.concat(tyreImgs);
			}

			RaiseLogEvent(ROUTE, tyre.tyreNo, { tyreOdo: tyreOdo }, 'New tyre odo value');

			var imagePaths = tyreImgs.length > 0 ? tyreImgs.map(obj => {
				return '/' + md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + obj.filename
			}).toString() : null;

			// Multiple Grooves
			let details = tyre.lastStatus && JSON.parse(JSON.stringify(tyre.lastStatus.details)) || {};
			details.notOperOdo = vehicleInspection.details && vehicleInspection.details.notOperOdo || false;
			details.resetOdo = vehicleInspection.details && vehicleInspection.details.resetOdo || false;
			details.mf = (tyre.details && tyre.details.mf) && (details && details.mf) || false; //hist level mf marking
			if (tyreInspect.grooves && Object.keys(tyreInspect.grooves) && Object.keys(tyreInspect.grooves.depths).length) {
				if ((req.body.isTyreVerification && req.body.isTyreVerification == 'true') || ['DE FTE', 'XE FTE', 'ARSA'].includes(res.locals.role)) {
					let validateGroove = true;
					for (const groove in tyreInspect.grooves.depths) {
						let matchedDepth = details.grooves && details.grooves.depths && details.grooves.depths[groove] || '';
						if (Number(matchedDepth) && Number(tyreInspect.grooves.depths[groove]) && Number(tyreInspect.grooves.depths[groove]).toFixed(1) != Number(matchedDepth).toFixed(1)) {
							validateGroove = false;
							break;
						}
					}
					let isSpare = tyre.lastStatus && tyre.lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].includes(tyre.lastStatus.position) || false;
					if (validateGroove && details && details.grooves && details.grooves.depths && !isSpare) {
						return res.send({ success: false, error: 'The Tyre NSD must be reduced by at least 0.1mm to complete the inspection.' });
					}
				}
				details.grooves = tyreInspect.grooves;
				let grooveDepths = [];
				for (const depth in details.grooves.depths) {
					grooveDepths.push(parseFloat(details.grooves.depths[depth]));
				}
				if (grooveDepths.length) {
					if (tyreInspect.treadDepth > Math.min(...grooveDepths)) {
						tyreInspect.treadDepth = Math.min(...grooveDepths);
					}
				}
			}
			details.psiNotAccess = req.body.psiNotAccess && req.body.psiNotAccess == "true" && true || false;
			let inflation = tyreInspect.inflation;
			if (details && details.psiNotAccess) { //Clear PSI if it is not accessible
				inflation = "";
			}

			details.recomPsi = "";
			let tyreType = "";
			if (tyre.radial == true) {
				tyreType = "Radial";
			} else if (tyre.radial == false) {
				tyreType = "Bias";
			}
			if (assetAxleProfile && accountPsiConfig.length) {
				let matchAxleProfile = accountPsiConfig.find(x => x.wheeler == axleProfile && x.config == assetAxleProfile.config && x.name == assetAxleProfile.name);
				if (matchAxleProfile && matchAxleProfile.tyreSizes) {
					let matchTyreSize = matchAxleProfile.tyreSizes.find(x => x.size.trim() == tyre.codeSize.trim() && x.type == tyreType);
					if (matchTyreSize && matchTyreSize.config && matchTyreSize.config.length) {
						details.recomPsi = matchTyreSize.config.find(x => x.position == tyre.lastStatus.position) && matchTyreSize.config.find(x => x.position == tyre.lastStatus.position).psi || "";
					}
				}
			}

			histBulk.push({
				tyreNo: tyre.tyreNo,
				histDate: histDate,
				transaction: "Inspect",
				condition: tyre.lastStatus.condition || "",
				tyreStatus: tyre.lastStatus.tyreStatus || null,
				position: tyre.lastStatus.position,
				inflation: inflation,
				wearPattern: tyreInspect.wearPattern,
				treadDepth: tyreInspect.treadDepth,
				odometer: odo,
				tyreOdometer: tyreOdo,
				inspectedBy: res.locals.username,
				shopName: req.body.shopName,
				amount: amountSplit,
				stockLocation: tyre.lastStatus.stockLocation,
				BranchId: tyre.lastStatus.Branch ? (tyre.lastStatus.Branch.id ? tyre.lastStatus.Branch.id : null) : null,
				comments: tyreInspect.comments ? tyreInspect.comments : req.body.comments,
				AssetId: tyre.AssetId,
				tyreImages: imagePaths,
				tpmsData: tyre.tpmsData,
				details: details,
				AplJobCardId: AplJobCardId && AplJobCardId || null,
				AccountId: tyre.AccountId,
				UserId: res.locals.UserId,
				username: res.locals.username
			});
		}

		await models.sequelize.transaction(async (t) => {
			const tyreHistories = await models.TyreHistory.bulkCreate(histBulk, { returning: true, transaction: t });
			const historyMap = {};
			for (const hist of tyreHistories) {
				historyMap[hist.tyreNo] = hist;
			}

			for (const tyre of tyres) {
				const histInstance = historyMap[tyre.tyreNo];
				if (!histInstance) continue;
				const tyreHist = histInstance.get({ plain: true });
				let BranchId = null;
				if (tyre.lastStatus && tyre.lastStatus.Branch && tyre.lastStatus.Branch.id) {
					BranchId = tyre.lastStatus.Branch.id;
				}

				const matchedBranch = branches.find(b => b.id == BranchId);
				tyreHist.Branch = matchedBranch ? { id: matchedBranch.id, name: matchedBranch.name } : {};
				tyre.set('lastStatus', { ...tyreHist });
				tyre.changed('lastStatus', true);

				const lastWorkDone = tyre.lastWorkDone || {};
				lastWorkDone.Inspection = {
					date: tyreHist.histDate,
					tyreOdometer: tyreHist.tyreOdometer,
					nextService: null,
					nextServiceInMonth: null
				};
				tyre.set('lastWorkDone', { ...lastWorkDone });
				tyre.changed('lastWorkDone', true);
				await tyre.save({ transaction: t });
			}
		});

		tyreImages.map(image => {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + image.filename
				});
			}
		});

		RecalculateCpkm(tyreNumbers, AccountId);
		if (req.body.isTyreVerification != 'true') {
			for (const tyre of tyres) {
				if (tyre.AssetId) {
					evt.events.emit('tyre-inspection-summary', {
						tyreNo: tyre.tyreNo,
						AssetId: tyre.AssetId,
						isSpare: ignoreSpare,
						AccountId: AccountId,
						UserId: res.locals.UserId,
						userName: res.locals.username,
						role: res.locals.role,
						ServiceBookingId: vehicleInspection.ServiceBookingId || null
					});
				}
			}
		}
		RaiseLogEvent(ROUTE, 'log', tyres, 'Inspection Log');
		return res.send({ success: true, tyres: tyres });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Data: ${JSON.stringify(req.body)}`);
		return res.send({ success: false, reload: false, error: "Could not update Tyres", message: err.message });
	}
}

exports.retreadSend = async function (req, res) {
	const ROUTE = 'app/tyres/retreadSend';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.body.tyreData || (req.body.tyreData && !Object.keys(req.body.tyreData).length)) {
			return res.send({ success: false, error: 'Tyre data missing.', message: 'Tyre data missing.' });
		}


		let AccountId = res.locals.AccountId;
		let AplJobCardId = null;
		let AplJobCard;
		if (req.body.AplJobCardId != "null" && req.body.AplJobCardId > 0) {
			AplJobCardId = req.body.AplJobCardId;
		}

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) { // For AMC FTE fetch customers from workshop
			if (res.locals.role == "AMCS FTE") {
				let geozoneResult = await avolveHelper.fetchGeozones(res);
				if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
					res.GeozoneId = geozoneResult.geozones.map(x => x.id);
					if (req.body.GeozoneId) {
						res.GeozoneId = req.body.GeozoneId;
					}
					let result = await avolveHelper.fetchCustomers(res);
					let accountIds = result && result.customers.map(x => x.id) || [];
					AccountId = accountIds;
				}
			} else {
				AccountId = res.locals.accountIds;
			}
		}

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) { // For AMC FTE fetch customers from workshop
			//#region fetch jobcard if Id send from APP
			if (AplJobCardId) {
				AplJobCard = await models.AplJobCard.findOne({
					attributes: ['id', 'AccountId'],
					where: {
						id: AplJobCardId
					},
					raw: true
				});
				if (AplJobCard) {
					AccountId = AplJobCard.AccountId;
				}
			}
			//#endregion
		}

		let Asset = {};
		if (req.body.assetId) {
			await models.Asset.findOne({
				attributes: ['id', 'axleConfig', 'details', 'AccountId'],
				where: {
					id: req.body.assetId
				}
			});
		}

		if (Asset.AccountId) {
			AccountId = Asset.AccountId;
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) { // For Xpert edge role fetch customers
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		//#region data received from input
		let tyreData = [],
			tyreNumbers = [];
		try {
			tyreData = JSON.parse(req.body.tyreData);
		} catch (err) {
			return res.send({ success: false, error: 'Error parsing tyre data.', message: 'Error parsing tyre data.' });
		}
		tyreData.forEach(tyreRecord => {
			tyreNumbers.push(tyreRecord.tyreNo);
		});
		//#endregion

		let tyres = await models.Tyre.findAll({
			include: [{
				model: models.Asset,
				attributes: ["id", "imei", "lplate", "odo", "billingType", 'AccountId']
			}],
			where: {
				AccountId: AccountId,
				tyreNo: {
					[Op.in]: tyreNumbers
				}
			}
		});

		let lastRetreadTyres = await models.TyreRetread.findAll({
			where: {
				AccountId: AccountId,
				tyreNo: {
					[Op.in]: tyreNumbers
				},
				[Op.or]: [
					{ status: 'recd' },
					{ status: 'sent' },
					{ status: 'scrap' }
				],
				[Op.or]: [
					models.sequelize.literal(`details->>'status' IS NULL`),
					models.sequelize.literal(`(details->>'status')::int != 2`)
				]
			},
			order: [['id', 'DESC']]
		});

		if (!tyres.length) {
			return res.send({ success: false, message: "Tyres not found.", error: "Tyres not found." });
		}

		//#region fetch tyre verification inspection to update enroute remove
		let TyreVerification = {};
		if (req.body.isTyreVerification && req.body.isTyreVerification == 'true') {
			TyreVerification = await models.Inspection.findOne({
				attributes: ['id', 'details'],
				where: {
					type: 'tv',
					AssetId: req.body.assetId,
					AccountId: AccountId
				},
				order: [['id', 'desc']]
			});

			if (!TyreVerification) {
				return res.send({ success: false, error: 'Tyre Verification Pending.' });
			}
		}
		//#endregion

		if (req.body.updateOdo && Math.round(req.body.odometer / 1000) && tyres[0].Asset) {
			let data = {};
			data.AssetId = tyres[0].Asset.id;
			data.AccountId = tyres[0].Asset.AccountId;
			data.odo = Math.round(req.body.odometer / 1000);
			data.emp = {
				id: res.locals.UserId,
				number: res.locals.UserId,
				name: res.locals.username
			}
			// evt.events.emit('create-device-command', data); Not required until GPS are used for Apollo Fleet
		}

		// Always update odo for Apollo Fleet gps
		if (tyres[0].Asset && tyres[0].Asset.billingType == 'Apollo Fleet') {
			let assetOdo = tyres[0].Asset.odo;
			//#region validate tyre ODO & NSD
			let removalValidationResult = await removalValidation(req, assetOdo, tyres, tyreData);
			if (removalValidationResult && !removalValidationResult.success) {
				return res.send({ success: false, error: removalValidationResult.error || 'Error removing tyre' });
			}
			//#endregion

			RaiseLogEvent(ROUTE, tyres[0].Asset.id, { inputOdo: req.body.odometer, AssetOdo: assetOdo }, `Odo details for tyre scrap before update in vehicle`);

			if (Number(assetOdo) > Number(req.body.odometer)) {
				return res.send({ success: false, error: 'Odometer should be greater than previous inspection/vehicle odometer.' });
			}

			if (Number(req.body.odometer) > Number(assetOdo)) {
				await tyres[0].Asset.update({
					odo: Math.round(req.body.odometer)
				});
			}
		}

		let bulkRetread = [];
		let amount = !isNaN(req.body.amount) ? req.body.amount : 0;
		tyres.forEach(tyre => {
			//#region Create Bulk Retread array
			let tyreInput = tyreData.find(x => x.tyreNo == tyre.tyreNo);

			let lastRetreadedTyre = lastRetreadTyres.find(x => x.tyreNo == tyre.tyreNo);
			let retreadSeq = 1;
			if (lastRetreadedTyre && lastRetreadedTyre.seq) {
				retreadSeq = lastRetreadedTyre.seq + 1;
			} else {
				const seqByCondition = Number(tyre.lastStatus.condition.split(' ')[1]);
				if (seqByCondition && !isNaN(seqByCondition)) {
					retreadSeq = seqByCondition + 1;
				}
			}
			let odo = Number(req.body.odometer);
			if (!odo) {
				odo = tyre.Asset && tyre.Asset.odo || 0;
			}
			if (!tyre.lastStatus.tyreOdometer) {
				tyre.lastStatus.tyreOdometer = 0;
			}
			let tyreOdo = (odo - parseInt(tyre.lastStatus.odometer)) > 0 ? parseInt(tyre.lastStatus.tyreOdometer) + (odo - parseInt(tyre.lastStatus.odometer)) : parseInt(tyre.lastStatus.tyreOdometer);

			bulkRetread.push({
				tyreNo: tyreInput.tyreNo,
				rtdCompany: req.body.rtdCompany ? req.body.rtdCompany : 'N/A',
				comments: req.body.comments,
				billNo: req.body.billNo,
				amount: amount,
				paidOn: (req.body.paidOn) ? moment.utc(req.body.paidOn) : null,
				paymentMode: req.body.paymentMode,
				sentOn: (req.body.sentOn) ? moment.utc(req.body.sentOn) : moment().format(),
				status: "sent",
				seq: retreadSeq,
				sentTyreOdo: tyreOdo,
				AccountId: tyre.AccountId
			});
			//#endregion
		});

		let imagesPush = [];
		let tyreRetreadStruct = [];
		let position = '';
		await models.sequelize.transaction(async t => {
			let tyreRetreads = await models.TyreRetread.bulkCreate(bulkRetread,
				{
					returning: true,
					transaction: t
				});

			tyreRetreadStruct = tyreRetreads.map(x => x);
			let histBulk = [];

			tyreRetreads.forEach(tyreRetread => {
				let tyreInput = tyreData.find(x => x.tyreNo == tyreRetread.tyreNo);
				let tyre = tyres.find(x => x.tyreNo == tyreRetread.tyreNo);
				position = tyre.lastStatus && tyre.lastStatus.position || '';
				let odo = Number(req.body.odometer);
				if (!odo) {
					odo = tyre.Asset && tyre.Asset.odo || 0;
				}
				if (!tyre.lastStatus.tyreOdometer) {
					tyre.lastStatus.tyreOdometer = 0;
				}
				let tyreOdo = (odo - parseInt(tyre.lastStatus.odometer)) > 0 ? parseInt(tyre.lastStatus.tyreOdometer) + (odo - parseInt(tyre.lastStatus.odometer)) : parseInt(tyre.lastStatus.tyreOdometer);

				if (tyre.lastStatus && tyre.lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].indexOf(tyre.lastStatus.position) > -1) { //Reset tyre odo if prev is Stepney
					tyreOdo = parseInt(tyre.lastStatus.tyreOdometer);
				}

				let histDetails = tyre.lastStatus && tyre.lastStatus.details || {}
				histDetails.retrdSeq = tyreRetread.seq;
				histDetails.mf = (tyre.details && tyre.details.mf) && (histDetails && histDetails.mf) || false; //hist level mf marking
				if (req.body.isTyreVerification && req.body.isTyreVerification == 'true') {
					histDetails.enRoute = true;
				}

				//#region service 2.0 changes
				let treadDepth = tyreInput.treadDepth || tyre.lastStatus.treadDepth;
				let grooves = tyreInput && tyreInput.grooves || {};
				if (grooves && Object.keys(grooves).length && Object.keys(grooves.depths).length) {
					histDetails.grooves = grooves;
					let grooveDepths = [];
					for (const depth in histDetails.grooves.depths) {
						grooveDepths.push(parseFloat(histDetails.grooves.depths[depth]));
					}
					if (grooveDepths.length) {
						treadDepth = Math.min(...grooveDepths);
					}
				}
				//#endregion

				//#region tyre image upload
				let tyreImgs = (req.files) && req.files.filter(files => {
					if (files.originalname && files.originalname.startsWith(`${tyre.tyreNo}_${tyre.id}`)) return files.originalname;
				}) || '';
				if (req.files && tyreImgs && tyreImgs.length) {
					imagesPush = imagesPush.concat(tyreImgs);
				}
				let imagePaths = tyreImgs.length > 0 ? tyreImgs.map(obj => {
					return '/' + md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/RetreadSend_' + obj.filename;
				}).toString() : null;
				//#endregion

				histBulk.push({
					tyreNo: tyreRetread.tyreNo,
					transaction: "Retread Sent",
					condition: tyre.lastStatus.condition || '',
					tyreStatus: 3, //3-Retreading
					histDate: (moment(req.body.sentOn, "YYYY-MM-DD HH:mm:ss").isValid()) ? moment(req.body.sentOn, "YYYY-MM-DD HH:mm:ss") : moment(),
					position: tyre.lastStatus.position,
					AssetId: tyre.lastStatus.AssetId || null,
					inflation: null,
					wearPattern: tyre.lastStatus.wearPattern,
					treadDepth: treadDepth,
					inspectedBy: res.locals.inspectedBy,
					shopName: tyreRetread.rtdCompany,
					amount: 0, // Actual amount will be updated when receiving from retread
					odometer: odo,
					tyreOdometer: tyreOdo,
					stockLocation: tyre.lastStatus.stockLocation,
					BranchId: tyre.lastStatus.Branch ? (tyre.lastStatus.Branch.id ? tyre.lastStatus.Branch.id : null) : null,
					comments: tyreRetread.comments,
					tpmsData: tyre.tpmsData,
					details: histDetails,
					UserId: res.locals.UserId,
					username: res.locals.username,
					AccountId: tyre.AccountId,
					tyreImages: imagePaths,
					AplJobCardId: AplJobCardId
				});
			});

			let tyreHistories = await models.TyreHistory.bulkCreate(histBulk,
				{
					returning: true,
					transaction: t
				});

			await Promise.all((tyres || []).map(async (tyre) => {
				const histInstance = historyMap[tyre.tyreNo];
				if (!histInstance) return;
				const tyreHist = histInstance.get({ plain: true });

				tyre.set('lastStatus', { ...tyreHist });
				tyre.changed('lastStatus', true);
				tyre.set('tyreStatus', 3); //3-Retreading
				tyre.set('AssetId', null);
				tyre.set('tpmsId', null);
				tyre.set('odometer', tyreHist.odometer);
				tyre.set('installedOn', null);

				await tyre.save({ transaction: t });
			}));

			//#region capture enroute service details in tyre verification stage
			if (req.body.isTyreVerification && req.body.isTyreVerification == 'true' && TyreVerification && Object.keys(TyreVerification).length) {
				let details = TyreVerification.details && JSON.parse(JSON.stringify(TyreVerification.details)) || {};
				let enrouteRemoveCount = details.enrouteServices && details.enrouteServices.remove || 0;
				if (details.enrouteServices) {
					details.enrouteServices.remove = enrouteRemoveCount + 1;
				}
				details.enrouteServices.text = details.enrouteServices && details.enrouteServices.rotation && `${details.enrouteServices.rotation} Tyres Rotated${!enrouteRemoveCount ? ' while Enroute' : ''}` || '';
				if (details.enrouteServices.remove) {
					details.enrouteServices.text += details.enrouteServices.text && ` & ${details.enrouteServices.remove} Tyres Replaced while Enroute.` || `${details.enrouteServices.remove} Tyres Replaced while Enroute.`;
				}

				await TyreVerification.update({
					details: details
				}, { transaction: t });
			}
			//#endregion
		});

		imagesPush.map(image => {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/RetreadSend_' + image.filename
				});
			}
		});

		//#region Asset axle MF marking while tyre removal 
		if (req.body.mfRemoval && req.body.mfRemoval == 'true') {
			let result = await axleMfMarkingByTyre([position], Asset);
			if (!result.success || result.error) {
				RaiseLogEvent(ROUTE, 'error', result.error || {}, `Error marking monitored fitment while removal`);
			}
		}
		//#endregion
		RecalculateCpkm(tyreNumbers, AccountId);
		return res.send({ success: true, tyres: tyres, tyreRetreads: tyreRetreadStruct });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching data.');
		return res.send({ success: false, error: 'Error fetching data.' });
	}
}

exports.retreadReceive = async function (req, res) {
	const ROUTE = 'app/tyres/retreadReceive';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.body.tyreData || (req.body.tyreData && !Object.keys(req.body.tyreData).length)) {
			return res.send({ success: false, error: 'Tyre data missing.', message: 'Tyre data missing.' });
		}

		//#region data received from input
		let tyreData = [], tyreNumbers = [], retreadIds = [];
		tyreData = req.body.tyreData && JSON.parse(req.body.tyreData) || [];

		for (const tyre of tyreData) {
			tyreNumbers.push(tyre.tyreNo);
			retreadIds.push(tyre.retreadId);
		}

		if (tyreData.filter(x => !x.grooveCount).length) {
			return res.send({ success: false, error: 'Groove count is mandatory.', message: 'Groove count is mandatory.' });
		}

		RaiseLogEvent(ROUTE, res.locals.AccountId, {}, `Total of ${tyreNumbers.length} tyres received from retread.`);
		//#endregion

		let AccountId = res.locals.AccountId;
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) { //For AMC FTE fetch customers from workshop
			if (res.locals.role == "AMCS FTE") {
				let geozoneResult = await avolveHelper.fetchGeozones(res);
				if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
					res.GeozoneId = geozoneResult.geozones.map(x => x.id);
					if (req.body.GeozoneId) {
						res.GeozoneId = req.body.GeozoneId;
					}
					let result = await avolveHelper.fetchCustomers(res);
					let accountIds = result && result.customers.map(x => x.id) || [];
					AccountId = accountIds;
				}
			} else {
				AccountId = res.locals.accountIds;
			}
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) { // For Xpert edge role fetch customers
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let TyreRetreads = await models.TyreRetread.findAll({
			where: {
				AccountId: AccountId,
				id: {
					[Op.in]: retreadIds
				},
				status: 'sent'
			}
		});

		let Tyres = await models.Tyre.findAll({
			where: {
				AccountId: AccountId,
				tyreNo: {
					[Op.in]: tyreNumbers
				}
			}
		});

		if (!TyreRetreads.length) {
			return res.send({ success: false, message: "Retread records not found.", error: "Retread records not found." });
		}
		if (!Tyres.length) {
			return res.send({ success: false, message: "Tyre records not found.", error: "Tyre records not found." });
		}

		let imagesPush = [];
		await models.sequelize.transaction(async t => {
			let histBulk = [];
			let histDate = (moment(req.body.recdOn, "YYYY-MM-DD HH:mm:ss").isValid()) ? moment(req.body.recdOn, "YYYY-MM-DD HH:mm:ss").toISOString() : moment();

			await Promise.all((TyreRetreads || []).map(async (TyreRetread) => {
				let odo = (req.body.odometer) ? req.body.odometer : 0;
				let tyreInput = tyreData.find(x => x.tyreNo == TyreRetread.tyreNo);
				let tyre = Tyres.find(x => x.tyreNo == TyreRetread.tyreNo);

				//#region tyre image upload
				let tyreImgs = (req.files) && req.files.filter(files => {
					if (files.originalname && files.originalname.startsWith(`${tyre.tyreNo}_${tyre.id}`)) return files.originalname;
				}) || '';
				if (req.files && tyreImgs && tyreImgs.length) {
					imagesPush = imagesPush.concat(tyreImgs);
				}
				let imagePaths = tyreImgs.length > 0 ? tyreImgs.map(obj => {
					return '/' + md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/RetreadReceive_' + obj.filename;
				}).toString() : null;
				//#endregion

				let histDetails = {
					retrdSeq: TyreRetread.seq
				};
				if (tyreInput.grooveCount) {
					histDetails.grooves = {};
					histDetails.grooves.count = tyreInput.grooveCount;
					histDetails.grooves.depths = {};
					for (let i = 0; i < tyreInput.grooveCount; i++) {
						histDetails.grooves.depths[`${i + 1}`] = tyreInput.treadDepth || tyre.lastStatus.treadDepth;
					}
				} else {
					histDetails.grooves = tyre.lastStatus && tyre.lastStatus.details && tyre.lastStatus.details.grooves || {};
				}
				let tyreOdometer = tyre.lastStatus && tyre.lastStatus.tyreOdometer && parseInt(tyre.lastStatus.tyreOdometer) || 0;
				histBulk.push({
					tyreNo: TyreRetread.tyreNo,
					transaction: "Retread Recd",
					condition: `Retread ${TyreRetread.seq || 1}`,
					tyreStatus: 4,
					histDate: histDate,
					position: tyre.lastStatus.position,
					AssetId: null,
					inflation: null,
					wearPattern: null,
					treadPattern: null,
					treadDepth: tyreInput.treadDepth || tyre.lastStatus.treadDepth,
					inspectedBy: res.locals.inspectedBy,
					shopName: TyreRetread.rtdCompany,
					amount: !isNaN(tyreInput.amount) ? tyreInput.amount : 0,
					odometer: odo,
					tyreOdometer: tyreOdometer,
					stockLocation: req.body.branchName && capitalizeWords(req.body.branchName) || '',
					BranchId: null,
					comments: TyreRetread.comments,
					tpmsData: tyre.tpmsData,
					details: histDetails,
					UserId: res.locals.UserId,
					AccountId: tyre.AccountId,
					username: res.locals.username,
					tyreImages: imagePaths
				});
				TyreRetread.comments = req.body.comments;
				TyreRetread.billNo = req.body.billNo;
				TyreRetread.amount = !isNaN(tyreInput.amount) ? tyreInput.amount : 0;
				TyreRetread.paidOn = (req.body.paidOn) ? moment.utc(req.body.paidOn) : null;
				TyreRetread.paymentMode = req.body.paymentMode;
				TyreRetread.recdOn = (req.body.recdOn) ? moment.utc(req.body.recdOn) : moment().format();
				TyreRetread.status = "recd";
				TyreRetread.details = { status: 1 };

				await TyreRetread.save({ transaction: t });
			}));

			let TyreHistories = await models.TyreHistory.bulkCreate(histBulk, { returning: true, transaction: t });
			const historyMap = {};
			for (const hist of TyreHistories) {
				historyMap[hist.tyreNo] = hist;
			}

			await Promise.all((Tyres || []).map(async (tyre) => {
				const histInstance = historyMap[tyre.tyreNo];
				if (!histInstance) return;
				const tyreHist = histInstance.get({ plain: true });
				tyre.set('lastStatus', { ...tyreHist });
				tyre.changed('lastStatus', true);
				tyre.set('tyreStatus', 4);
				tyre.set('condition', `Retread ${tyreHist.details && tyreHist.details.retrdSeq || 1}`);
				tyre.set('AssetId', null);
				tyre.set('tpmsId', null);
				tyre.set('odometer', 0);
				tyre.set('installedOn', null);
				tyre.set('initialTreadDepth', tyreHist.treadDepth);

				await tyre.save({ transaction: t });
			}));
		});

		for (const image of imagesPush) {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/RetreadReceive_' + image.filename
				});
			}
		}

		RecalculateCpkm(tyreNumbers, AccountId);
		RaiseLogEvent(ROUTE, res.locals.AccountId, {}, `Total of ${TyreRetreads.length} tyres moved to retreaded.`);
		return res.send({ success: true, tyres: Tyres, tyreRetreads: TyreRetreads });

	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Data: ${JSON.stringify(req.body)}`);
		return res.send({ success: false, reload: false, error: "Could not update retreads", message: "Could not update retreads" });
	}
}

exports.assign = async function (req, res) {
	const ROUTE = 'app/tyres/assign';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		let AccountId = res.locals.AccountId;
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) { //For AMC FTE fetch customers from workshop
			let Asset = await models.Asset.findOne({
				attributes: ['id', 'lplate', 'AccountId'],
				where: {
					id: req.query.AssetId
				}
			});

			if (!Asset) {
				return res.send({ success: false, error: "Assign restricted. Vehicle not found." });
			}

			AccountId = Asset.AccountId;
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) { // For Xpert edge role fetch customers
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let Tyre = await models.Tyre.findOne({
			include: [{
				model: models.Asset,
				attributes: ["id", "imei", "lplate", "odo", "billingType", 'AccountId']
			}],
			where: {
				AccountId: AccountId,
				tyreNo: req.params.tyreNo
			}
		});

		//#region Validations
		if (!Tyre) {
			return res.send({ success: false, message: "Tyre not found.", error: "Tyre not found." });
		}
		if (!req.body.AssetId || !req.body.position) {
			return res.send({ success: false, message: "Missing input parameters.", error: "Missing input parameters." });
		}
		if (Tyre.AssetId) {
			return res.send({ success: false, message: "Tyre already installed.", error: "Tyre already installed." });
		}
		if (!req.body.odometer || (Number(req.body.odometer) <= 0)) {
			return res.send({ success: false, error: 'Please enter odometer to proceed.' });
		}
		//#endregion

		let Asset = await models.Asset.findOne({
			attributes: ["id", "imei", "lplate", "odo", "AccountId", "billingType", 'axleProfile', 'details', 'axleConfig'],
			include: [{
				model: models.Tyre,
				attributes: ["id", "lastStatus", "deletedAt"],
			}],
			where: {
				AccountId: AccountId,
				id: req.body.AssetId
			}
		});

		let Branches = await models.Branch.findAll({
			attributes: ['id', 'name'],
			where: {
				AccountId: AccountId
			}
		});

		//#region More validations
		if (!Asset) {
			return res.send({ success: false, message: "Asset not found.", error: "Asset not found." });
		}

		let alreadyMapped = false;
		if (Asset.Tyres && Asset.Tyres.length) {
			Asset.Tyres.map(tyre => {
				if (tyre.lastStatus.position == req.body.position && !tyre.deletedAt) {
					alreadyMapped = true;
				}
			})
		}

		if (alreadyMapped === true) {
			return res.send({ success: false, message: "Tyre already installed in this position.", error: "Tyre already installed in this position." });
		}
		//#endregion

		//#region fetch tyre verification inspection to update enroute remove
		let TyreVerification = {};
		if (req.body.isTyreVerification && req.body.isTyreVerification == 'true') {
			TyreVerification = await models.Inspection.findOne({
				attributes: ['id', 'details'],
				where: {
					type: 'tv',
					AssetId: req.body.AssetId,
					AccountId: AccountId
				},
				order: [['id', 'desc']]
			});

			if (!TyreVerification) {
				return res.send({ success: false, error: 'Tyre Verification Pending.' });
			}
		}
		//#endregion

		//TODO: Check ODO variance & update GPS if req.body.odo is higher.
		if (req.body.updateOdo && Math.round(req.body.odometer / 1000)) {
			var data = {};
			data.AssetId = Asset.id;
			data.AccountId = Asset.AccountId;
			data.odo = Math.round(req.body.odometer / 1000);
			data.emp = {
				id: res.locals.UserId,
				number: res.locals.UserId,
				name: res.locals.username
			}
			// evt.events.emit('create-device-command', data); Not required until GPS are used for Apollo Fleet
		}

		var odo = Number(req.body.odometer);
		if (!odo) {
			odo = Tyre.Asset && Tyre.Asset.odo || 0;
		}

		var histDate = moment();
		if (!Tyre.lastStatus.tyreOdometer) {
			Tyre.lastStatus.tyreOdometer = 0;
		}

		let inspectedBy = req.body.inspectedBy;
		if (Asset.billingType == 'Apollo Fleet') { //Update Tyre odo for Apollo fleet
			RaiseLogEvent(ROUTE, Asset.id, { inputOdo: odo, AssetOdo: Asset.odo }, `Odo details for tyre assign before update in vehicle.`);

			if (Number(Asset.odo) > Number(odo)) {
				return res.send({ success: false, error: 'Odometer should be greater than previous inspection/vehicle odometer.' });
			}

			if (odo > Asset.odo) {
				await Asset.update({
					odo: Math.round(odo)
				});

				RaiseLogEvent(ROUTE, Asset.id, { inputOdo: odo, AssetOdo: Asset.odo }, `Odo details for tyre assign after update in vehicle`);
			}
			inspectedBy = res.locals.name;
		}

		let aplJobcard;
		let isObService = false;
		let enRouteFitment = false;
		let AplJobCardId = null;
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			if (req.body.AplJobCardId != "null" && req.body.AplJobCardId > 0) {
				AplJobCardId = req.body.AplJobCardId;
			}
			if (AplJobCardId) {
				aplJobcard = await models.AplJobCard.findOne({
					attributes: ['id', 'status', 'services'],
					where: {
						id: AplJobCardId
					}
				});
				if (aplJobcard) {
					let services = JSON.parse(JSON.stringify(aplJobcard.services));
					if (services.find(x => x.serviceName == "Onboarding Service")) {
						isObService = true;
					}
					let matchService = services.find(x => x.ServiceTypeId == req.body.ServiceTypeId);
					if (matchService && matchService.serviceName == "En Route Tyre Replacement") { //En Route Tyre Replacement fitted count update
						enRouteFitment = true;
					}
				}
			}
			if (req.body.isTyreVerification && req.body.isTyreVerification == 'true') { //enable enroute fitment at tyre verification
				enRouteFitment = true;
			}
		}

		let currentTreadDepth = req.body.currentTreadDepth;
		if (!currentTreadDepth) {
			currentTreadDepth = Tyre.lastStatus.treadDepth;
		}
		if (['Retread', 'Retread 1', 'Retread 2', 'Retread 3'].indexOf(req.body.condition) > -1) {
			if (!Tyre.lastStatus || (Tyre.lastStatus && !Object.keys(Tyre.lastStatus).length)) {
				currentTreadDepth = Tyre.initialTreadDepth;
			} else {
				currentTreadDepth = Tyre.lastStatus.treadDepth;
			}
		}

		if (req.body.condition && (['Retread', 'Retread 1', 'Retread 2', 'Retread 3'].indexOf(req.body.condition) == -1)) {
			if (!req.body.currentTreadDepth) {
				return res.send({ success: false, error: 'Current tread depth missing.' });
			}

			if (req.body.currentTreadDepth && isNaN(req.body.currentTreadDepth)) {
				return res.send({ success: false, error: 'Invalid current tread depth.' });
			}

			if (Number(req.body.currentTreadDepth) > Number(Tyre.initialTreadDepth)) {
				return res.send({ success: false, error: 'Current tread depth should not be greater than InitialTreadDepth.' });
			}
		}

		let condition = req.body.condition;
		if (condition == "Used") {
			condition = Tyre.lastStatus && Tyre.lastStatus.condition || req.body.condition;
		}

		let recomPsi = "";
		//#region recommended PSI capture
		let Account = await models.Account.findOne({
			attributes: ['id', 'details'],
			where: {
				id: Tyre.AccountId
			}
		});

		let accountPsiConfig = Account && Account.details && Account.details.psiConfig || [];
		let tyreType = "";
		if (Tyre.radial == true) {
			tyreType = "Radial";
		} else if (Tyre.radial == false) {
			tyreType = "Bias";
		}

		if (Asset && Asset.axleProfile && Asset.details && Asset.details.axleProfile) {
			let matchAxleProfile = accountPsiConfig.find(x => x.wheeler == Asset.axleProfile && x.config == Asset.details.axleProfile.config && x.name == Asset.details.axleProfile.name);
			if (matchAxleProfile && matchAxleProfile.tyreSizes) {
				let matchTyreSize = matchAxleProfile.tyreSizes.find(x => x.size.trim() == Tyre.codeSize.trim() && x.type == tyreType);
				if (matchTyreSize && matchTyreSize.config && matchTyreSize.config.length) {
					let matchPosition = matchTyreSize.config.find(x => x.position == req.body.position && req.body.position || '');
					recomPsi = matchPosition && matchPosition.psi || "";
				}
			}
		}
		//#endregion

		//#region MF capture
		let mfFitment = false;
		if (Asset) {
			let isMfTyre = Tyre && Tyre.details && Tyre.details.mf || false;
			let mf = mfTransactionCheck(Asset, req.body.position);
			if (mf && condition == "New" && Tyre.initialTreadDepth == currentTreadDepth) {
				mfFitment = true;
			} else if (mf && isMfTyre) {
				mfFitment = true;
			}
		}
		//#endregion

		var assignedTyre = {};
		await models.sequelize.transaction(async t => {
			let history = await models.TyreHistory.create({
				//#region Tyre History Creation
				tyreNo: req.params.tyreNo,
				histDate: histDate,
				condition: condition,
				tyreStatus: 1, //1-In Use
				transaction: "Fitment",
				position: req.body.position,
				inflation: req.body.inflation,
				wearPattern: Tyre.lastStatus.wearPattern,
				treadDepth: currentTreadDepth,
				odometer: odo,
				tyreOdometer: Tyre.lastStatus.tyreOdometer,
				inspectedBy: inspectedBy,
				shopName: req.body.shopName,
				amount: !isNaN(req.body.amount) ? req.body.amount : 0,
				stockLocation: Tyre.lastStatus.stockLocation,
				BranchId: Tyre.lastStatus.Branch ? (Tyre.lastStatus.Branch.id ? Tyre.lastStatus.Branch.id : null) : null,
				comments: req.body.comments,
				AssetId: req.body.AssetId,
				tpmsData: Tyre.tpmsData,
				UserId: res.locals.UserId,
				username: res.locals.username,
				AplJobCardId: AplJobCardId,
				AccountId: Tyre.AccountId,
				details: {
					ticketNo: req.body.ticketNo,
					grooves: Tyre.lastStatus && Tyre.lastStatus.details && Tyre.lastStatus.details.grooves || {},
					recomPsi: recomPsi,
					enRoute: enRouteFitment,
					mf: mfFitment,
					mfFitment: mfFitment
				}
				//#endregion
			}, {
				transaction: t
			});

			var matchedBranch = Branches.find(x => x.id == history.BranchId);
			var Branch = {};
			if (matchedBranch) {
				Branch.id = matchedBranch.id;
				Branch.name = matchedBranch.name;
			}
			var tyreHist = JSON.parse(JSON.stringify(history));
			tyreHist.Branch = Branch;
			Tyre.AssetId = req.body.AssetId;
			Tyre.installedOn = histDate;
			Tyre.odometer = odo;
			Tyre.lastStatus = history;
			if (Tyre.condition == 'New') {
				Tyre.condition = 'Used';
			}
			Tyre.tyreStatus = 1; //1-In Use
			let tyreDetails = JSON.parse(JSON.stringify(Tyre.details));
			tyreDetails.mf = tyreDetails.mf ? true : mfFitment;
			Tyre.details = tyreDetails;
			assignedTyre = await Tyre.save({ transaction: t });

			//#region capture enroute service details in tyre verification stage
			if (req.body.isTyreVerification && req.body.isTyreVerification == 'true' && TyreVerification && Object.keys(TyreVerification).length) {
				let details = JSON.parse(JSON.stringify(TyreVerification.details)) || {};
				let enrouteRemoveCount = details.enrouteServices && details.enrouteServices.fitment || 0;
				details.enrouteServices.fitment = enrouteRemoveCount + 1;
				details.enrouteServices.text = details.enrouteServices.rotation && `${details.enrouteServices.rotation} Tyres Rotated${!enrouteRemoveCount ? ' while Enroute' : ''}` || '';
				if (details.enrouteServices.fitment) {
					details.enrouteServices.text += details.enrouteServices.text && ` & ${details.enrouteServices.fitment} Tyres Replaced while Enroute.` || `${details.enrouteServices.fitment} Tyres Replaced while Enroute.`;
				}
				await TyreVerification.update({
					details: details
				}, { transaction: t });
			}
			//#endregion

			if (aplJobcard && req.body.ServiceTypeId) {
				let services = JSON.parse(JSON.stringify(aplJobcard.services));
				let matchService = services.find(x => x.ServiceTypeId == req.body.ServiceTypeId);
				//#region Tyre fitment service details update
				if (matchService && matchService.serviceName == "Tyre Fitment") {
					if (!['SP', 'SP1', 'SP2', 'SP3', 'SP4'].includes(req.body.position)) {
						matchService.execTyres = matchService.execTyres && Number(matchService.execTyres) + 1 || 1;
						if (tyreHist) {
							matchService.details.push({
								tyreNo: tyreHist.tyreNo,
								histDate: tyreHist.histDate,
								position: tyreHist.position
							});
						}
						await aplJobcard.update({
							services: services
						}, { transaction: t });
					}
				}
				//#endregion
				//#region en route tyre fitment service details update
				if (matchService && matchService.serviceName == "En Route Tyre Replacement") {
					matchService.details = matchService.details && matchService.details.length && matchService.details || [];
					matchService.execTyres = matchService.execTyres && Number(matchService.execTyres) + 1 || 1;
					if (tyreHist) {
						matchService.details.push({
							tyreNo: tyreHist.tyreNo,
							histDate: tyreHist.histDate,
							position: tyreHist.position
						});
					}
					await aplJobcard.update({
						services: services
					}, { transaction: t });
				}
				//#endregion

				if (tyreHist.AssetId && ['XE FTE', 'ARSA', 'DE FTE'].indexOf(res.locals.role) > -1 && !AplJobCardId && tyreHist) {
					evt.events.emit('create-apollo-service-log', {
						AssetId: tyreHist.AssetId,
						AccountId: tyreHist.AccountId,
						serviceName: "Tyre Fitment",
						sTime: moment(tyreHist.histDate).toISOString(),
						odo: tyreHist.odo,
						transaction: "Tyre Fitment",
						details: [{
							tyreNo: tyreHist.tyreNo,
							histDate: tyreHist.histDate,
							position: tyreHist.position
						}],
						workshop: req.body.shopName && req.body.shopName || "",
						serviceType: req.body.serviceType && req.body.serviceType || "",
						user: {
							id: res.locals.UserId,
							username: res.locals.username,
							name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
							date: moment(tyreHist.histDate).toISOString()
						},
						updServiceSch: false
					});
				}
			}
		});

		let tyreNumber = [Tyre.tyreNo];
		RecalculateCpkm(tyreNumber, Tyre.AccountId);

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1 && isObService) {
			evt.events.emit('check-allTyre-exists', {
				AssetId: Tyre.AssetId,
				AccountId: Tyre.AccountId
			});
		} else if (['XE FTE', 'ARSA', 'DE FTE'].includes(res.locals.role)) {
			evt.events.emit('check-allTyre-exists', {
				AssetId: Tyre.AssetId,
				AccountId: Tyre.AccountId
			});
		}
		return res.send({ success: true, tyre: assignedTyre });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', req.body, `Requested by ${res.locals.username}`);
		return res.send({ success: false, reload: false, message: 'Error fetching data.', error: 'Error fetching data.' });
	}
}

exports.align = async function (req, res) {
	const ROUTE = 'app/tyres/align';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		//#region data received from input
		var tyreData = [];
		var tyreNumbers = [];
		tyreData = JSON.parse(req.body.tyreData);
		tyreData.forEach(tyreRecord => {
			tyreNumbers.push(tyreRecord.tyreNo);
		});
		//#endregion

		let AccountId = res.locals.AccountId;
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) { //For AMC FTE fetch customers from workshop
			let Asset = await models.Asset.findOne({
				attributes: ['id', 'lplate', 'AccountId'],
				where: {
					id: req.query.AssetId
				}
			});

			if (!Asset) {
				return res.send({ success: false, error: "Assign restricted. Vehicle not found." });
			}
			AccountId = Asset.AccountId;
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) { // For Xpert edge role fetch customers
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let tyreWhere = {
			AccountId: AccountId,
			AssetId: req.body.AssetId,
			tyreNo: tyreNumbers
		}

		let correctedAxles = req.body.alignChecklist && JSON.parse(req.body.alignChecklist).filter(x => x.corrected == true) || [];
		let positions = [];
		if (correctedAxles.length) {
			let Asset = await models.Asset.findOne({
				attributes: ['id', 'lplate', 'axleConfig', 'AccountId', 'odo'],
				where: {
					AccountId: AccountId,
					id: req.body.AssetId
				}
			});

			if (!Asset) {
				return res.send({ success: false, message: "Vehicle not found." });
			}

			let axleConfig = Asset.axleConfig && Asset.axleConfig || {};
			for (let axle of correctedAxles) {
				if (axleConfig) {
					let matchAxle = axleConfig.config && axleConfig.config.find(x => x.name == axle.axlePosition && x.axle == parseInt(axle.axleNo));
					if (matchAxle) {
						let matchPositions = matchAxle.position && matchAxle.position || [];
						for (const matchPosition of matchPositions) {
							positions.push(matchPosition);
						}
					}
				}
			}
		}

		let tyres = await models.Tyre.findAll({
			include: [{
				model: models.Asset,
				attributes: ["id", "imei", "lplate", "odo", "billingType", 'AccountId']
			}],
			where: tyreWhere
		});

		let branches = await models.Branch.findAll({
			attributes: ['id', 'name'],
			where: {
				AccountId: AccountId
			}
		});

		if (!tyres) {
			return res.send({ success: false, message: "Tyres not found for this asset." });
		}

		if (!correctedAxles.length && tyres.length !== tyreNumbers.length) {
			return res.send({ success: false, message: "Tyre count does not match asset." });
		}

		if (req.body.updateOdo && Math.round(req.body.odometer / 1000) && tyres[0].Asset) {
			var data = {};
			data.AssetId = tyres[0].Asset.id;
			data.AccountId = tyres[0].Asset.AccountId;
			data.odo = Math.round(req.body.odometer / 1000);
			data.emp = {
				id: res.locals.UserId,
				number: res.locals.UserId,
				name: res.locals.username
			}
			// evt.events.emit('create-device-command', data); Not required until GPS are used for Apollo Fleet
		}

		let inspectedBy = req.body.inspectedBy;
		if (tyres[0].Asset && tyres[0].Asset.billingType == 'Apollo Fleet') {
			inspectedBy = res.locals.name;
		}

		let odoValidation = await getOdoValidation(res.locals.role, AccountId, tyres[0], req.body.odometer);
		if (!odoValidation.success) {
			return res.send({ success: false, error: odoValidation.error || 'Error removing tyre' });
		}

		var histBulk = [];
		var tyreImages = [];
		var histDate = (moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss").isValid()) ? moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss") : moment();
		var amountSplit = !isNaN(req.body.amount) ? req.body.amount / tyres.length : 0;
		tyres.forEach(tyre => {
			var tyreAlign = tyreData.find(x => x.tyreNo == tyre.tyreNo);
			var odo = Number(req.body.odometer);
			if (!odo) {
				odo = tyre.Asset && tyre.Asset.odo || 0;
			}
			if (!tyre.lastStatus.tyreOdometer) {
				tyre.lastStatus.tyreOdometer = 0;
			}
			var tyreOdo = (odo - parseInt(tyre.lastStatus.odometer)) > 0 ? parseInt(tyre.lastStatus.tyreOdometer) + (odo - parseInt(tyre.lastStatus.odometer)) : parseInt(tyre.lastStatus.tyreOdometer);

			if (tyre.lastStatus && tyre.lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].indexOf(tyre.lastStatus.position) > -1) { //Reset tyre odo if prev is Stepney
				tyreOdo = parseInt(tyre.lastStatus.tyreOdometer);
			}

			var tyreImgs = (req.files) ? req.files.filter(files => {
				return files.originalname.substring(0, files.originalname.indexOf('_')) == tyre.tyreNo;
			}) : '';

			if (req.files && tyreImgs && tyreImgs.length) {
				tyreImages = tyreImages.concat(tyreImgs);
			}

			var imagePaths = tyreImgs.length > 0 ? tyreImgs.map(obj => {
				return '/' + md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + obj.filename
			}).toString() : null;

			let details = tyre.lastStatus && tyre.lastStatus.details || {};
			details = JSON.parse(JSON.stringify(details));
			if (req.body.alignChecklist) {
				details.alignChecklist = JSON.parse(req.body.alignChecklist);
			}
			details.mf = (tyre.details && tyre.details.mf) && (details && details.mf) || false;

			histBulk.push({
				tyreNo: tyre.tyreNo,
				transaction: 'Alignment',
				histDate: histDate,
				condition: tyre.lastStatus.condition || "",
				tyreStatus: tyre.lastStatus.tyreStatus || null,
				position: tyre.lastStatus.position,
				AssetId: tyre.lastStatus.AssetId,
				inflation: tyreAlign.inflation,
				wearPattern: tyreAlign.wearPattern,
				treadDepth: tyreAlign.treadDepth || tyre.lastStatus.treadDepth,
				inspectedBy: inspectedBy,
				shopName: req.body.shopName,
				amount: amountSplit,
				odometer: odo,
				tyreOdometer: tyreOdo,
				stockLocation: tyre.lastStatus.stockLocation,
				BranchId: tyre.lastStatus.Branch ? (tyre.lastStatus.Branch.id ? tyre.lastStatus.Branch.id : null) : null,
				comments: req.body.comments,
				tpmsData: tyre.tpmsData,
				UserId: res.locals.UserId,
				AccountId: tyre.AccountId,
				username: res.locals.username,
				tyreImages: imagePaths,
				details: details
			});
		})

		let tyreHistoryStruct = [];
		await models.sequelize.transaction(async t => {
			let tyreHistories = await models.TyreHistory.bulkCreate(histBulk, { returning: true, transaction: t });
			tyreHistoryStruct = tyreHistories.map(x => x);

			const historyMap = {};
			for (const hist of tyreHistories) {
				historyMap[hist.tyreNo] = hist;
			}
			await Promise.all((tyres || []).map(async (tyre) => {
				const histInstance = historyMap[tyre.tyreNo];
				if (!histInstance) return;

				const tyreHist = histInstance.get({ plain: true });
				let BranchId = tyre.lastStatus.Branch ? (tyre.lastStatus.Branch.id ? tyre.lastStatus.Branch.id : null) : null;
				let matchedBranch = branches.find(x => x.id == BranchId);

				let Branch = {};
				if (matchedBranch) {
					Branch.id = matchedBranch.id;
					Branch.name = matchedBranch.name;
				}
				tyreHist.Branch = Branch;
				tyre.set('lastStatus', { ...tyreHist });
				tyre.changed('lastStatus', true);

				let alignmentJson = {
					date: tyreHist.histDate,
					tyreOdometer: tyreHist.tyreOdometer,
					nextService: null,
					nextServiceInMonth: null
				};
				let lastWorkDone = tyre.lastWorkDone || {};
				lastWorkDone.Alignment = alignmentJson;
				tyre.set('lastWorkDone', { ...lastWorkDone });
				tyre.changed('lastWorkDone', true);
				await tyre.save({ transaction: t });
			}));
		});

		tyreImages.map(image => {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + image.filename
				});
			}
		});

		if (tyres[0].Asset) {
			evt.events.emit('create-apollo-service-log', {
				AssetId: tyres[0].Asset.id,
				AccountId: tyres[0].Asset.AccountId,
				sTime: moment().toISOString(),
				serviceName: "Wheel Alignment",
				odo: tyreHistoryStruct.length && tyreHistoryStruct[0].odometer || tyres[0].Asset.odo,
				transaction: "Wheel Alignment",
				workshop: req.body.shopName && req.body.shopName || "",
				serviceType: req.body.serviceType && req.body.serviceType || "",
				user: {
					id: res.locals.UserId,
					username: res.locals.username,
					name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
					date: moment().toISOString()
				},
				details: req.body.alignChecklist && JSON.parse(req.body.alignChecklist) || [],
				updServiceSch: true
			});
		}
		//#region alignment cost for tyres
		let correctedTyres = [];
		for (const tyre of tyres) {
			if (tyre.lastStatus && tyre.lastStatus.position && positions.indexOf(tyre.lastStatus.position) > -1) {
				correctedTyres.push(tyre);
			}
		}
		//#endregion
		RecalculateCpkm(correctedTyres.map(x => x.tyreNo), AccountId);
		return res.send({ success: true, tyres: tyres, tyreHistories: tyreHistoryStruct });

	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Data: ${JSON.stringify(req.body)}`);
		return res.send({ success: false, error: 'Error align tyres' });
	}
}

exports.swap = async function (req, res) {
	const ROUTE = 'app/tyres/swap';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		//#region input data received
		var tyreData = [];
		var tyreNumbers = [];
		tyreData = JSON.parse(req.body.tyreData);
		tyreData.forEach(tyreRecord => {
			tyreNumbers.push(tyreRecord.tyreNo);
		});
		//#endregion

		let AccountId = res.locals.AccountId;
		let Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'AccountId', 'axleConfig'],
			where: {
				id: req.query.AssetId
			}
		});

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) { //For AMC FTE fetch customers from workshop
			if (!Asset) {
				return res.send({ success: false, error: "Swap restricted. Vehicle not found." });
			}
			AccountId = Asset.AccountId;
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) { // For Xpert edge role fetch customers
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let tyres = await models.Tyre.findAll({
			include: [{
				model: models.Asset,
				attributes: ["id", "imei", "lplate", "odo", "billingType", 'AccountId', 'details']
			}],
			where: { AccountId: AccountId, tyreNo: { [Op.in]: tyreNumbers } }
		});

		let branches = await models.Branch.findAll({
			attributes: ['id', 'name'],
			where: {
				AccountId: AccountId
			}
		});

		if (tyres.length != 2) {
			return res.send({ success: false, message: "One or both tyres not found." });
		}

		if (JSON.stringify(tyreNumbers) != JSON.stringify(tyres.map(x => x.tyreNo))) { //if input order and db order is diff then reverse db order
			tyres.reverse();
		}

		if (req.body.updateOdo && Math.round(req.body.odometer / 1000) && tyres[0].Asset) {
			var data = {};
			data.AssetId = tyres[0].Asset.id;
			data.AccountId = tyres[0].Asset.AccountId;
			data.odo = Math.round(req.body.odometer / 1000);
			data.emp = {
				id: res.locals.UserId,
				number: res.locals.UserId,
				name: res.locals.username
			}
			// evt.events.emit('create-device-command', data); Not required until GPS are used for Apollo Fleet
		}

		let inspectedBy = req.body.inspectedBy;
		// Always update odo for Apollo Fleet gps
		if (tyres[0].Asset && tyres[0].Asset.billingType == 'Apollo Fleet') {
			inspectedBy = res.locals.name;
		}

		let odoValidation = await getOdoValidation(res.locals.role, AccountId, tyres[0], req.body.odometer);
		if (!odoValidation.success) {
			return res.send({ success: false, error: odoValidation.error || 'Error removing tyre' });
		}

		//#region Tyre hist level mf marking
		if (tyres.some(x => x.details && x.details.mf)) {
			tyres.forEach(tyre => {
				let matchedTyre = tyres.find(x => x.tyreNo != tyre.tyreNo);
				let position = matchedTyre && matchedTyre.lastStatus && matchedTyre.lastStatus.position || '';
				if (!position) {
					return res.send({ success: false, error: `Position is missing for tyre ${matchedTyre.tyreNo}` });
				}
				if (tyre.lastStatus && tyre.lastStatus.position && tyre.lastStatus.details) {
					if (tyre.details && tyre.details.mf) {
						tyre.lastStatus.details.mf = mfTransactionCheck(Asset, position) || false;
					} else {
						tyre.lastStatus.details.mf = false;
					}
				}
			});
		}
		//#endregion

		var histDate = (moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss").isValid()) ? moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss") : moment();
		var odo = Number(req.body.odometer);
		if (!odo) {
			odo = tyres[0].Asset && tyres[0].Asset.odo || 0;
		}
		if (!tyres[0].lastStatus.tyreOdometer) {
			tyres[0].lastStatus.tyreOdometer = 0;
		}
		if (!tyres[1].lastStatus.tyreOdometer) {
			tyres[1].lastStatus.tyreOdometer = 0;
		}
		var tyre1Odo = (odo - parseInt(tyres[0].lastStatus.odometer)) > 0 ? parseInt(tyres[0].lastStatus.tyreOdometer) + (odo - parseInt(tyres[0].lastStatus.odometer)) : parseInt(tyres[0].lastStatus.tyreOdometer);

		var tyre2Odo = (odo - parseInt(tyres[1].lastStatus.odometer)) > 0 ? parseInt(tyres[1].lastStatus.tyreOdometer) + (odo - parseInt(tyres[1].lastStatus.odometer)) : parseInt(tyres[1].lastStatus.tyreOdometer);

		if (tyres[1].lastStatus && tyres[1].lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].indexOf(tyres[1].lastStatus.position) > -1) {
			tyre2Odo = parseInt(tyres[1].lastStatus.tyreOdometer);
			tyre1Odo = parseInt(tyres[0].lastStatus.tyreOdometer) + (Number(odo) - Number(tyres[0].lastStatus.odometer));
		}

		if (tyres[0].lastStatus && tyres[0].lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].indexOf(tyres[0].lastStatus.position) > -1) {
			tyre1Odo = parseInt(tyres[0].lastStatus.tyreOdometer);
			tyre2Odo = parseInt(tyres[1].lastStatus.tyreOdometer) + (Number(odo) - Number(tyres[1].lastStatus.odometer));
		}

		if (tyres[1].lastStatus && tyres[1].lastStatus.details) {
			tyres[1].lastStatus.details.notOperOdo = tyres[0].lastStatus && tyres[0].lastStatus.details && tyres[0].lastStatus.details.notOperOdo || false;
			tyres[1].lastStatus.details.resetOdo = tyres[0].lastStatus && tyres[0].lastStatus.details && tyres[0].lastStatus.details.resetOdo || false;
		}

		var tyre1Data = tyreData.find(x => x.tyreNo == tyres[0].tyreNo);
		var tyre2Data = tyreData.find(x => x.tyreNo == tyres[1].tyreNo);

		var tyre1Images = (req.files) ? req.files.filter(files => {
			return files.originalname.substring(0, files.originalname.indexOf('_')) == tyres[0].tyreNo;
		}) : '';
		var tyre1ImagePaths = tyre1Images.length > 0 ? tyre1Images.map(obj => {
			return '/' + md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + obj.filename
		}).toString() : null;

		var tyre2Images = (req.files) ? req.files.filter(files => {
			return files.originalname.substring(0, files.originalname.indexOf('_')) == tyres[1].tyreNo;
		}) : '';
		var tyre2ImagePaths = tyre2Images.length > 0 ? tyre2Images.map(obj => {
			return '/' + md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + obj.filename
		}).toString() : null;
		var amountSplit = !isNaN(req.body.amount) ? req.body.amount / tyreNumbers.length : 0;
		var histBulk = [
			{
				//#region History 1
				tyreNo: tyres[1].tyreNo,
				histDate: histDate,
				transaction: 'Rotation',
				condition: tyres[1].lastStatus.condition || "",
				tyreStatus: tyres[1].lastStatus.tyreStatus || null,
				position: tyres[0].lastStatus.position,
				inflation: tyres[1].lastStatus.inflation,
				wearPattern: tyres[1].lastStatus.wearPattern,
				treadDepth: tyre2Data.treadDepth || tyres[1].lastStatus.treadDepth,
				inspectedBy: inspectedBy,
				shopName: req.body.shopName,
				amount: amountSplit,
				odometer: odo,
				tyreOdometer: tyre2Odo ? tyre2Odo : 0,
				stockLocation: tyres[1].lastStatus.stockLocation,
				BranchId: tyres[1].lastStatus.Branch ? (tyres[1].lastStatus.Branch.id ? tyres[1].lastStatus.Branch.id : null) : null,
				comments: req.body.comments,
				AssetId: tyres[1].AssetId,
				tyreImages: tyre2ImagePaths,
				tpmsData: tyres[1].tpmsData,
				UserId: res.locals.UserId,
				AccountId: tyres[1].AccountId,
				username: res.locals.username,
				details: tyres[1].lastStatus && tyres[1].lastStatus.details || {}
				//#endregion
			},
			{
				//#region History 2
				tyreNo: tyres[0].tyreNo,
				histDate: histDate,
				transaction: 'Rotation',
				condition: tyres[0].lastStatus.condition || "",
				tyreStatus: tyres[0].lastStatus.tyreStatus || null,
				position: tyres[1].lastStatus.position,
				inflation: tyres[0].lastStatus.inflation,
				wearPattern: tyres[0].lastStatus.wearPattern,
				treadDepth: tyre1Data.treadDepth || tyres[0].lastStatus.treadDepth,
				inspectedBy: inspectedBy,
				shopName: req.body.shopName,
				amount: amountSplit,
				odometer: odo,
				tyreOdometer: tyre1Odo ? tyre1Odo : 0,
				stockLocation: tyres[0].lastStatus.stockLocation,
				BranchId: tyres[0].lastStatus.Branch ? (tyres[0].lastStatus.Branch.id ? tyres[0].lastStatus.Branch.id : null) : null,
				comments: req.body.comments,
				AssetId: tyres[0].AssetId,
				tyreImages: tyre1ImagePaths,
				tpmsData: tyres[0].tpmsData,
				UserId: res.locals.UserId,
				AccountId: tyres[0].AccountId,
				username: res.locals.username,
				details: tyres[0].lastStatus && tyres[0].lastStatus.details || {}
				//#endregion
			}
		];

		RaiseLogEvent(ROUTE, res.locals.AccountId, histBulk, `Initiate tyre swap for : ${tyreNumbers.join(',')}`);

		let tyreHistoryStruct = [];
		await models.sequelize.transaction(async t => {
			let tyreHistories = await models.TyreHistory.bulkCreate(histBulk, { returning: true, transaction: t });
			tyreHistoryStruct = tyreHistories;
			const historyMap = {};
			for (const hist of tyreHistories) {
				historyMap[hist.tyreNo] = hist;
			}

			await Promise.all((tyres || []).map(async (tyre) => {
				const histInstance = historyMap[tyre.tyreNo];
				if (!histInstance) return;
				const tyreHist = histInstance.get({ plain: true });

				let BranchId = tyre.lastStatus.Branch ? (tyre.lastStatus.Branch.id ? tyre.lastStatus.Branch.id : null) : null;
				let matchedBranch = branches.find(x => x.id == BranchId);
				let Branch = {};
				if (matchedBranch) {
					Branch.id = matchedBranch.id;
					Branch.name = matchedBranch.name;
				}

				tyreHist.Branch = Branch;
				tyre.set('lastStatus', { ...tyreHist });
				tyre.changed('lastStatus', true);
				let rotationJson = {
					date: tyreHist.histDate,
					tyreOdometer: tyreHist.tyreOdometer,
					nextService: null,
					nextServiceInMonth: null
				};

				let lastWorkDone = tyre.lastWorkDone || {};
				lastWorkDone.Rotation = rotationJson;
				tyre.set('lastWorkDone', { ...lastWorkDone });
				tyre.changed('lastWorkDone', true);
				await tyre.save({ transaction: t });
			}));
		});

		RaiseLogEvent(ROUTE, res.locals.AccountId, tyreNumbers, `Swaped tyres : ${tyreNumbers.join(',')}`);

		tyre1Images.map(image => {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + image.filename
				});
			}
		})
		tyre2Images.map(image => {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + image.filename
				});
			}
		})

		RecalculateCpkm(tyreNumbers, AccountId);

		if (tyres[0] && tyres[0].Asset) {
			let details = [{
				tyreNo: tyres[0].tyreNo,
				inspectedPosition: tyres[0].lastStatus.position,
				currentPosition: tyres[1].lastStatus.position,
				AssetId: tyres[0].AssetId
			}, {
				tyreNo: tyres[1].tyreNo,
				inspectedPosition: tyres[1].lastStatus.position,
				currentPosition: tyres[0].lastStatus.position,
				AssetId: tyres[1].AssetId
			}];
			evt.events.emit('create-apollo-service-log', {
				AssetId: tyres[0].Asset.id,
				AccountId: tyres[0].Asset.AccountId,
				sTime: moment().toISOString(),
				serviceName: "Wheel Rotation",
				odo: tyreHistoryStruct.length && tyreHistoryStruct[0].odometer || tyres[0].Asset.odo,
				transaction: "Wheel Rotation",
				details: details,
				workshop: req.body.shopName && req.body.shopName || "",
				serviceType: req.body.serviceType && req.body.serviceType || "",
				user: {
					id: res.locals.UserId,
					username: res.locals.username,
					name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
					date: moment().toISOString()
				},
				updServiceSch: true
			});
		}

		return res.send({ success: true, tyres: tyres });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Data: ${JSON.stringify(req.body)}`);
		return res.send({ success: false, error: "Error swapping tyres." });
	}
}

exports.swapAll = async function (req, res) {
	const ROUTE = 'app/tyres/swapAll';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		//#region data received from input
		var tyreData = [];
		var tyreNumbers = [];
		tyreData = JSON.parse(req.body.tyreData);
		tyreData.forEach(tyreRecord => {
			tyreNumbers.push(tyreRecord.tyreNo);
		});
		//#endregion

		let AccountId = res.locals.AccountId;
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) { // For AMC FTE fetch customers from workshop
			if (res.locals.role == "AMCS FTE") {
				let geozoneResult = await avolveHelper.fetchGeozones(res);
				if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
					res.GeozoneId = geozoneResult.geozones.map(x => x.id);
					if (req.body.GeozoneId) {
						res.GeozoneId = req.body.GeozoneId;
					}
					let result = await avolveHelper.fetchCustomers(res);
					let accountIds = result && result.customers.map(x => x.id) || [];
					AccountId = accountIds;
				}
			} else {
				AccountId = res.locals.accountIds;
			}
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) { // For Xpert edge role fetch customers
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let tyres = await models.Tyre.findAll({
			include: [{
				model: models.Asset,
				attributes: ["id", "imei", "lplate", "odo", "axleConfig", "billingType", 'AccountId']
			}],
			where: { AccountId: AccountId, tyreNo: { [Op.in]: tyreNumbers }, AssetId: req.body.AssetId }
		});

		let branches = await models.Branch.findAll({
			attributes: ['id', 'name'],
			where: {
				AccountId: AccountId
			}
		});

		if (!tyres) {
			return res.send({ success: false, message: "Tyres not found." });
		} else if (tyres.length !== tyreData.length) {
			return res.send({ success: false, message: "Tyres on this vehicle does not match database." });
		}

		if (req.body.updateOdo && Math.round(req.body.odometer / 1000) && tyres[0].Asset) {
			var data = {};
			data.AssetId = tyres[0].Asset.id;
			data.AccountId = tyres[0].Asset.AccountId;
			data.odo = Math.round(req.body.odometer / 1000);
			data.emp = {
				id: res.locals.UserId,
				number: res.locals.UserId,
				name: res.locals.username
			}
			// evt.events.emit('create-device-command', data); Not required until GPS are used for Apollo Fleet
		}

		// Always update odo for Apollo Fleet gps
		let inspectedBy = req.body.inspectedBy;
		if (tyres[0].Asset && tyres[0].Asset.billingType == 'Apollo Fleet') {
			inspectedBy = res.locals.name;
		}

		let odoValidation = await getOdoValidation(res.locals.role, AccountId, tyres[0], req.body.odometer);
		if (!odoValidation.success) {
			return res.send({ success: false, error: odoValidation.error || 'Error removing tyre' });
		}

		// Loop thru asset tyres by each axle
		tyres[0].Asset.axleConfig.config.forEach(async (axle) => {
			var tyreCount = parseInt(axle.tyres);
			if (!tyreCount || tyreCount % 2 != 0) {
				return;
			}
			for (var left = 0, right = tyreCount - 1; left < tyreCount / 2; left++, right--) {
				// Swap them (by 2 counts)
				var pos1 = axle.axle + axle.position[left];
				var pos2 = axle.axle + axle.position[right];
				var tyre1 = tyres.find(x => x.lastStatus.position === pos1);
				var tyre2 = tyres.find(x => x.lastStatus.position === pos2);

				if (!tyre1 || !tyre2) {
					continue;
				}
				if (pos1.substr(1, 1) == pos2.substr(1, 1)) {
					//console.log(`Skipping tyre pair due to mismatch L/R positions ${pos1} vs ${pos2}`);
					// Both tyres belong to same axle. Proceed to next positoin without failing.
				}
				if (tyre1 && tyre2) {
					var histDate = (moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss").isValid()) ? moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss") : moment();
					var odo = Number(req.body.odometer);
					if (!odo) {
						odo = tyre1.Asset && tyre1.Asset.odo || 0;
					}
					var amountSplit = !isNaN(req.body.amount) ? req.body.amount / tyreNumbers.length : 0;
					if (!tyre1.lastStatus.tyreOdometer) {
						tyre1.lastStatus.tyreOdometer = 0;
					}
					if (!tyre2.lastStatus.tyreOdometer) {
						tyre2.lastStatus.tyreOdometer = 0;
					}

					var tyre1Odo = (odo - parseInt(tyre1.lastStatus.odometer)) > 0 ? parseInt(tyre1.lastStatus.tyreOdometer) + (odo - parseInt(tyre1.lastStatus.odometer)) : parseInt(tyre1.lastStatus.tyreOdometer);

					var tyre2Odo = (odo - parseInt(tyre2.lastStatus.odometer)) > 0 ? parseInt(tyre2.lastStatus.tyreOdometer) + (odo - parseInt(tyre2.lastStatus.odometer)) : parseInt(tyre2.lastStatus.tyreOdometer);

					if (tyre1.lastStatus && tyre1.lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].indexOf(tyre1.lastStatus.position) > -1) {
						tyre1Odo = parseInt(tyre2.lastStatus.tyreOdometer);
						tyre2Odo = parseInt(tyre1.lastStatus.tyreOdometer) + Number(tyre1Odo);
					}

					if (tyre2.lastStatus && tyre2.lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].indexOf(tyre2.lastStatus.position) > -1) {
						tyre2Odo = parseInt(tyre2.lastStatus.tyreOdometer);
						tyre1Odo = parseInt(tyre1.lastStatus.tyreOdometer) + Number(tyre1Odo);
					}

					var histBulk = [
						{
							//#region History 1
							tyreNo: tyre1.tyreNo,
							histDate: histDate,
							transaction: 'Rotation',
							condition: tyre1.lastStatus.condition || "",
							tyreStatus: tyre1.lastStatus.tyreStatus || null,
							position: pos2,
							inflation: tyre1.lastStatus.inflation,
							wearPattern: tyre1.lastStatus.wearPattern,
							treadDepth: tyreData.find(x => x.tyreNo === tyre1.tyreNo).treadDepth,
							inspectedBy: inspectedBy,
							shopName: req.body.shopName,
							amount: amountSplit,
							odometer: odo,
							tyreOdometer: tyre1Odo,
							stockLocation: tyre1.lastStatus.stockLocation,
							BranchId: tyre1.lastStatus.Branch ? (tyre1.lastStatus.Branch.id ? tyre1.lastStatus.Branch.id : null) : null,
							comments: req.body.comments,
							AssetId: tyre1.AssetId,
							tyreImages: null,
							tpmsData: tyre1.tpmsData,
							UserId: res.locals.UserId,
							AccountId: tyre1.AccountId,
							username: res.locals.username
							//#endregion
						},
						{
							//#region History 1
							tyreNo: tyre2.tyreNo,
							histDate: histDate,
							transaction: 'Rotation',
							condition: tyre2.lastStatus.condition || "",
							tyreStatus: tyre2.lastStatus.tyreStatus || null,
							position: pos1,
							inflation: tyre2.lastStatus.inflation,
							wearPattern: tyre2.lastStatus.wearPattern,
							treadDepth: tyreData.find(x => x.tyreNo === tyre2.tyreNo).treadDepth,
							inspectedBy: inspectedBy,
							shopName: req.body.shopName,
							amount: amountSplit,
							odometer: odo,
							tyreOdometer: tyre2Odo,
							stockLocation: tyre2.lastStatus.stockLocation,
							BranchId: tyre2.lastStatus.Branch ? (tyre2.lastStatus.Branch.id ? tyre2.lastStatus.Branch.id : null) : null,
							comments: req.body.comments,
							AssetId: tyre2.AssetId,
							tyreImages: null,
							tpmsData: tyre2.tpmsData,
							UserId: res.locals.UserId,
							AccountId: tyre2.AccountId,
							username: res.locals.username
							//#endregion
						}
					];

					await models.sequelize.transaction(async t => {
						let tyreHistories = await models.TyreHistory.bulkCreate(histBulk, { returning: true, transaction: t });
						await Promise.all((tyreHistories || []).map(async (tyreHistory) => {
							let tyre = tyres.find(x => x.tyreNo === tyreHistory.tyreNo);
							const tyreHist = tyreHistory.get({ plain: true });
							let matchedBranch = branches.find(x => x.id == tyreHistory.BranchId);
							let Branch = {};
							if (matchedBranch) {
								Branch.id = matchedBranch.id;
								Branch.name = matchedBranch.name;
							}
							tyreHist.Branch = Branch;
							tyre.set('lastStatus', { ...tyreHist });
							tyre.changed('lastStatus', true);
							let rotationJson = {
								date: tyreHist.histDate,
								tyreOdometer: tyreHist.tyreOdometer,
								nextService: null,
								nextServiceInMonth: null
							};
							let lastWorkDone = tyre.lastWorkDone || {};
							lastWorkDone.Rotation = rotationJson;
							tyre.set('lastWorkDone', { ...lastWorkDone });
							tyre.changed('lastWorkDone', true);
							await tyre.save({ transaction: t });
						}));
					});

					RaiseLogEvent(ROUTE, res.locals.AccountId, histBulk, `Swaped all tyres : ${tyre1.tyreNo, tyre2.tyreNo}`);
				}
			}
		});

		RecalculateCpkm(tyreNumbers, AccountId);
		return res.send({ success: true, tyres: tyres });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Data: ${JSON.stringify(req.body)}`);
		return res.send({ success: false, error: err, message: "Could not swap tyres." });
	}
}

exports.scrap = async function (req, res) {
	const ROUTE = 'app/tyres/scrap';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.body.tyreData || (req.body.tyreData && !Object.keys(req.body.tyreData).length)) {
			return res.send({ success: false, error: 'Tyre data missing.', message: 'Tyre data missing.' });
		}

		let AccountId = res.locals.AccountId;
		let AplJobCardId = null;
		let AplJobCard;
		if (req.body.AplJobCardId != "null" && req.body.AplJobCardId > 0) {
			AplJobCardId = req.body.AplJobCardId;
		}

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) { // For AMC FTE fetch customers from workshop
			if (res.locals.role == "AMCS FTE") {
				let geozoneResult = await avolveHelper.fetchGeozones(res);
				if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
					res.GeozoneId = geozoneResult.geozones.map(x => x.id);
					if (req.body.GeozoneId) {
						res.GeozoneId = req.body.GeozoneId;
					}
					let result = await avolveHelper.fetchCustomers(res);
					let accountIds = result && result.customers.map(x => x.id) || [];
					AccountId = accountIds;
				}
			} else {
				AccountId = res.locals.accountIds;
			}
		}

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) { // For AMC FTE fetch customers from workshop
			//#region fetch jobcard if Id send from APP
			if (AplJobCardId) {
				AplJobCard = await models.AplJobCard.findOne({
					attributes: ['id', 'AccountId'],
					where: {
						id: AplJobCardId
					}
				});
				if (AplJobCard) {
					AccountId = AplJobCard.AccountId;
				}
			}
			//#endregion
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) { // For Xpert edge role fetch customers
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let Asset = {};
		if (req.body.assetId) {
			await models.Asset.findOne({
				attributes: ['id', 'axleConfig', 'details', 'AccountId'],
				where: {
					id: req.body.assetId
				}
			});
		}

		if (Asset.AccountId) {
			AccountId = Asset.AccountId;
		}

		//#region input data received
		let tyreData = [],
			tyreNumbers = [];
		try {
			tyreData = JSON.parse(req.body.tyreData);
		} catch (err) {
			return res.send({ success: false, error: 'Error parsing tyre data.', message: 'Error parsing tyre data.' });
		}
		tyreData.forEach(tyreRecord => {
			tyreNumbers.push(tyreRecord.tyreNo);
		});
		//#endregion

		RaiseLogEvent(ROUTE, res.locals.AccountId, {}, `Total of ${tyreNumbers.length} tyres processed for scrap.`);

		let tyres = await models.Tyre.findAll({
			include: [{
				model: models.Asset,
				attributes: ["id", "imei", "lplate", "odo", "billingType", "AccountId"]
			}],
			where: {
				AccountId: AccountId,
				tyreNo: { [Op.in]: tyreNumbers }
			}
		});

		if (!tyres || !tyres.length) {
			return res.send({ success: false, message: "Tyres not found.", error: "Tyres not found." });
		}

		let TyreVerification = {};
		if (req.body.isTyreVerification && req.body.isTyreVerification == 'true') {
			TyreVerification = await models.Inspection.findOne({
				attributes: ['id', 'details'],
				where: {
					type: 'tv',
					AssetId: req.body.assetId,
					AccountId: AccountId
				},
				order: [['id', 'desc']]
			});

			if (!TyreVerification) {
				return res.send({ success: false, error: 'Tyre Verification Pending.' });
			}
		}

		if (req.body.updateOdo && Math.round(req.body.odometer / 1000) && tyres[0].Asset) {
			let data = {};
			data.AssetId = tyres[0].Asset.id;
			data.AccountId = tyres[0].Asset.AccountId;
			data.odo = Math.round(req.body.odometer / 1000);
			data.emp = {
				id: res.locals.UserId,
				number: res.locals.UserId,
				name: res.locals.username
			}
			// evt.events.emit('create-device-command', data); Not required until GPS are used for Apollo Fleet
		}


		// Always update odo for Apollo Fleet gps
		if (tyres[0].Asset && tyres[0].Asset.billingType == 'Apollo Fleet') {
			let assetOdo = tyres[0].Asset.odo;
			//#region validate tyre ODO & NSD
			let removalValidationResult = await removalValidation(req, assetOdo, tyres, tyreData);
			if (removalValidationResult && !removalValidationResult.success) {
				return res.send({ success: false, error: removalValidationResult.error || 'Error removing tyre' });
			}
			//#endregion

			RaiseLogEvent(ROUTE, tyres[0].Asset.id, { inputOdo: req.body.odometer, AssetOdo: assetOdo }, `Odo details for tyre scrap before update in vehicle`);

			if (Number(assetOdo) > Number(req.body.odometer)) {
				return res.send({ success: false, error: 'Odometer should be greater than previous inspection/vehicle odometer.' });
			}

			if (Number(req.body.odometer) > Number(assetOdo)) {
				await tyres[0].Asset.update({
					odo: Math.round(req.body.odometer)
				});
			}
		}

		let bulkScrap = [];
		let histDate = (moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss").isValid()) ?
			moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss") : moment();
		let amountSplit = !isNaN(req.body.amount) ? req.body.amount / tyreNumbers.length : 0;
		tyres.forEach(tyre => {
			//#region Create Bulk Scrap array
			bulkScrap.push({
				tyreNo: tyre.tyreNo,
				scrapDate: histDate,
				soldTo: req.body.branchName || '',
				amount: amountSplit,
				paymentMode: '',
				comments: req.body.comments,
				status: "Scrap",
				AccountId: tyre.AccountId
			});
			//#endregion
		})

		let imagesPush = [];
		let tyreScrapStruct = [];
		let position = '';
		await models.sequelize.transaction(async t => {
			let tyreScraps = await models.TyreScrap.bulkCreate(bulkScrap, {
				returning: true,
				transaction: t
			});

			tyreScrapStruct = tyreScraps.map(x => x);
			let histBulk = [];
			let amountSplit = !isNaN(req.body.amount) ? req.body.amount / tyreNumbers.length : 0;
			tyreScraps.forEach(tyreScrap => {
				//#region Create Bulk Scrap array
				let tyre = tyres.find(x => x.tyreNo == tyreScrap.tyreNo);
				let tyreInput = tyreData.find(x => x.tyreNo == tyreScrap.tyreNo);
				position = tyre.lastStatus && tyre.lastStatus.position || '';;
				let odo = Number(req.body.odometer);
				if (!odo) {
					odo = tyre.Asset && tyre.Asset.odo || 0;
				}
				if (!tyre.lastStatus.tyreOdometer) {
					tyre.lastStatus.tyreOdometer = 0;
				}
				let tyreOdo = (odo - parseInt(tyre.lastStatus.odometer)) > 0 ? parseInt(tyre.lastStatus.tyreOdometer) + (odo - parseInt(tyre.lastStatus.odometer)) : parseInt(tyre.lastStatus.tyreOdometer);
				if (tyre.lastStatus && tyre.lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].indexOf(tyre.lastStatus.position) > -1) { //Reset tyre odo if prev is Stepney
					tyreOdo = parseInt(tyre.lastStatus.tyreOdometer);
				}

				//#region tyre image upload
				let tyreImgs = (req.files) && req.files.filter(files => {
					if (files.originalname && files.originalname.startsWith(`${tyre.tyreNo}_${tyre.id}`)) return files.originalname;
				}) || '';
				if (req.files && tyreImgs && tyreImgs.length) {
					imagesPush = imagesPush.concat(tyreImgs);
				}
				let imagePaths = tyreImgs.length > 0 ? tyreImgs.map(obj => {
					return '/' + md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/Scrap_' + obj.filename;
				}).toString() : null;
				//#endregion

				//#region service 2.0 changes
				let details = tyre.lastStatus && tyre.lastStatus.details || {};
				let treadDepth = tyreInput.treadDepth || tyre.lastStatus.treadDepth;
				let grooves = tyreInput && tyreInput.grooves || {};
				if (grooves && Object.keys(grooves).length && Object.keys(grooves.depths).length) {
					details.grooves = grooves;
					let grooveDepths = [];
					for (const depth in details.grooves.depths) {
						grooveDepths.push(parseFloat(details.grooves.depths[depth]));
					}
					if (grooveDepths.length) {
						treadDepth = Math.min(...grooveDepths);
					}
				}
				//#endregion

				if (req.body.isTyreVerification && req.body.isTyreVerification == 'true') {
					details.enRoute = true;
				}

				histBulk.push({
					tyreNo: tyreScrap.tyreNo,
					transaction: "Scrap",
					condition: tyre.lastStatus.condition || "",
					tyreStatus: 5,
					histDate: histDate,
					position: tyre.lastStatus.position,
					AssetId: tyre.AssetId || null,
					inflation: null,
					wearPattern: tyre.lastStatus.wearPattern,
					treadDepth: treadDepth,
					inspectedBy: res.locals.inspectedBy,
					shopName: null,
					amount: amountSplit,
					odometer: odo,
					tyreOdometer: tyreOdo,
					stockLocation: req.body.branchName || '',
					BranchId: tyre.lastStatus.Branch ? (tyre.lastStatus.Branch.id ? tyre.lastStatus.Branch.id : null) : null,
					comments: tyreScrap.comments,
					tpmsData: tyre.tpmsData,
					UserId: res.locals.UserId,
					AccountId: tyre.AccountId,
					username: res.locals.username,
					tyreImages: imagePaths,
					details: details,
					AplJobCardId: AplJobCardId
				});
				//#endregion
			});

			let tyreHistories = await models.TyreHistory.bulkCreate(histBulk, {
				returning: true,
				transaction: t
			});

			await Promise.all((tyres || []).map(async (tyre) => {
				const histInstance = historyMap[tyre.tyreNo];
				if (!histInstance) return;
				const tyreHist = histInstance.get({ plain: true });
				tyre.set('lastStatus', { ...tyreHist });
				tyre.changed('lastStatus', true);
				tyre.set('condition', "Scrap");
				tyre.set('tyreStatus', 5); //5-Scrap
				tyre.set('AssetId', null);
				tyre.set('tpmsId', null);
				tyre.set('odometer', tyreHist.odometer);
				tyre.set('installedOn', null);
				await tyre.save({ transaction: t });
			}));

			//#region capture enroute service details in tyre verification stage
			if (req.body.isTyreVerification && req.body.isTyreVerification == 'true' && TyreVerification && Object.keys(TyreVerification).length) {
				let details = TyreVerification.details && JSON.parse(JSON.stringify(TyreVerification.details)) || {};
				let enrouteRemoveCount = details.enrouteServices && details.enrouteServices.remove || 0;
				if (details.enrouteServices) {
					details.enrouteServices.remove = enrouteRemoveCount + 1;
				}
				details.enrouteServices.text = details.enrouteServices && details.enrouteServices.rotation && `${details.enrouteServices.rotation} Tyres Rotated${!enrouteRemoveCount ? ' while Enroute' : ''}` || '';
				if (details.enrouteServices.remove) {
					details.enrouteServices.text += details.enrouteServices.text && ` & ${details.enrouteServices.remove} Tyres Replaced while Enroute.` || `${details.enrouteServices.remove} Tyres Replaced while Enroute.`;
				}

				await TyreVerification.update({
					details: details
				}, { transaction: t });
			}
			//#endregion

			//#region Retread to Scrap status update
			let TyreRetread = await models.TyreRetread.findOne({
				attributes: ['status', 'details'],
				where: {
					tyreNo: tyreNumbers,
					status: "sent"
				},
				order: [['id', 'desc']]
			});
			let retreadDetails = TyreRetread && TyreRetread.details && JSON.parse(JSON.stringify(TyreRetread.details)) || {};
			if (retreadDetails) {
				retreadDetails.status = 2; // rejected
			}
			await models.TyreRetread.update({
				status: "scrap",
				details: retreadDetails,
				seq: null
			}, {
				where: {
					tyreNo: tyreNumbers,
					status: "sent"
				}
			}, { transaction: t });
			//#endregion
		});

		RaiseLogEvent(ROUTE, res.locals.AccountId, {}, `Total of ${tyreScrapStruct.length} tyres moved to scrap.`);

		for (const image of imagesPush) {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/Scrap_' + image.filename
				});
			}
		}
		//#region Asset axle MF marking while tyre removal 
		if (req.body.mfRemoval && req.body.mfRemoval == 'true') {
			let result = await axleMfMarkingByTyre([position], Asset);
			if (!result.success || result.error) {
				RaiseLogEvent(ROUTE, 'error', result.error || {}, `Error marking monitored fitment while removal`);
			}
		}
		//#endregion

		RecalculateCpkm(tyreNumbers, AccountId);
		return res.send({ success: true, tyres: tyres, tyreScraps: tyreScrapStruct });

	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Data: ${JSON.stringify(req.body)}`);
		return res.send({ success: false, error: 'Error updating tyre' });
	}
}

exports.remove = async function (req, res) {
	const ROUTE = 'app/tyres/remove';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		//#region data received from input
		let tyreData = [];
		let tyreNumbers = [];
		tyreData = JSON.parse(req.body.tyreData);
		tyreData.forEach(tyreRecord => {
			tyreNumbers.push(tyreRecord.tyreNo);
		});
		//#endregion

		let AplJobCardId = null;
		let AplJobCard;
		let AplJobCardUpd = false;
		if (req.body.AplJobCardId != "null" && req.body.AplJobCardId > 0) {
			AplJobCardId = req.body.AplJobCardId;
		}

		let AccountId = res.locals.AccountId;
		let Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'AccountId', 'axleConfig', 'details', 'odo'],
			where: {
				id: req.query.AssetId
			}
		});

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) { // For AMC FTE fetch customers from workshop
			if (!Asset) {
				return res.send({ success: false, error: "Remove restricted. Vehicle not found." });
			}
			AccountId = Asset.AccountId;

			//#region fetch jobcard if Id send from APP
			if (AplJobCardId) {
				AplJobCard = await models.AplJobCard.findOne({
					attributes: ['id', 'status', 'AccountId', 'AssetId', 'services'],
					where: {
						id: AplJobCardId
					}
				});
				if (AplJobCard) {
					AccountId = AplJobCard.AccountId;
					//#region tyre removal validation
					let fitmentService = AplJobCard.services.find(x => x.serviceName == "Tyre Fitment");
					if (fitmentService) {
						AplJobCardUpd = true;
					}
					if (fitmentService && fitmentService.noOfTyres && fitmentService.removedTyres) {
						if (Number(fitmentService.removedTyres) >= Number(fitmentService.noOfTyres)) {
							return res.send({ success: false, error: `Tyre removal restricted. Cannot remove more than ${Number(fitmentService.noOfTyres)} tyres` });
						}
					}
					//#endregion
				}
			}
			//#endregion
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) { // For Xpert edge role fetch customers
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let tyres = await models.Tyre.findAll({
			include: [{
				model: models.Asset,
				attributes: ["id", "imei", "lplate", "odo", "billingType", "AccountId"]
			}],
			where: { AccountId: AccountId, tyreNo: { [Op.in]: tyreNumbers } }
		});

		if (!tyres) {
			return res.send({ success: false, error: "Tyres not found." });
		}

		let TyreVerification = {};
		if (req.body.isTyreVerification && req.body.isTyreVerification == 'true' && ['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			TyreVerification = await models.Inspection.findOne({
				attributes: ['id', 'details'],
				where: {
					type: 'tv',
					AssetId: tyres[0].Asset.id,
					AccountId: AccountId
				},
				order: [['id', 'desc']]
			});

			if (!TyreVerification) {
				return res.send({ success: false, error: 'Tyre Verification Pending.' });
			}
		}

		let lastStatus = tyres[0] && tyres[0].lastStatus && tyres[0].lastStatus || {};
		let isSpare = lastStatus && lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].includes(lastStatus.position) || false;

		//#region validate tyre ODO & NSD
		let removalValidationResult = await removalValidation(req, Asset.odo, tyres, tyreData);
		if (removalValidationResult && !removalValidationResult.success) {
			return res.send({ success: false, error: removalValidationResult.error || 'Error removing tyre' });
		}
		//#endregion

		let odoValidation = await getOdoValidation(res.locals.role, AccountId, tyres[0], req.body.odometer, req.body.mfRemoval, isSpare);
		if (!odoValidation.success) {
			return res.send({ success: false, error: odoValidation.error || 'Error removing tyre' });
		}

		let histDate = (moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss").isValid()) ? moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss") : moment();
		let histBulk = [];
		let imagesPush = [];
		let amountSplit = !isNaN(req.body.amount) ? req.body.amount / tyreNumbers.length : 0;
		let position = ''
		tyres.forEach(tyre => {
			position = tyre.lastStatus.position || '';
			let inputTyreData = tyreData.find(x => x.tyreNo == tyre.tyreNo);

			let odo = Number(req.body.odometer);
			if (!odo) {
				odo = tyre.Asset && tyre.Asset.odo || 0;
			}
			if (!tyre.lastStatus.tyreOdometer) {
				tyre.lastStatus.tyreOdometer = 0;
			}
			let tyreOdo = (odo - parseInt(tyre.lastStatus.odometer)) > 0 ? parseInt(tyre.lastStatus.tyreOdometer) + (odo - parseInt(tyre.lastStatus.odometer)) : parseInt(tyre.lastStatus.tyreOdometer);
			if (tyre.lastStatus && tyre.lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].indexOf(tyre.lastStatus.position) > -1) { //Reset tyre odo if prev is Stepney
				tyreOdo = parseInt(tyre.lastStatus.tyreOdometer);
			}

			// Do not modify odo for spare tyres (as they are not run)
			if (["SP", "SP1", "SP2", "SP3", "SP4"].indexOf(tyre.lastStatus.position) > -1) {
				tyreOdo = tyre.lastStatus.tyreOdometer;
			}

			//#region tyre image upload
			let tyreImgs = (req.files) && req.files.filter(files => {
				if (files.originalname && files.originalname.startsWith(`${tyre.tyreNo}_${tyre.id}`)) return files.originalname;
			}) || '';
			if (req.files && tyreImgs && tyreImgs.length) {
				imagesPush = imagesPush.concat(tyreImgs);
			}
			let imagePaths = tyreImgs.length > 0 ? tyreImgs.map(obj => {
				return '/' + md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/Remove_' + obj.filename;
			}).toString() : null;
			//#endregion

			let details = {
				ticketNo: tyreData[0].ticketNo,
				grooves: tyre.lastStatus && tyre.lastStatus.details && tyre.lastStatus.details.grooves || {},
				resetOdo: tyre.lastStatus && tyre.lastStatus.details && tyre.lastStatus.details.resetOdo || false,
				notOperOdo: tyre.lastStatus && tyre.lastStatus.details && tyre.lastStatus.details.notOperOdo || false,
				enRoute: req.body.isTyreVerification && req.body.isTyreVerification == 'true' && true || false,
				mfRemoval: inputTyreData && inputTyreData.mf && inputTyreData.mf == 'true' && true || false,
				mf: tyre.lastStatus && tyre.lastStatus.details && tyre.lastStatus.details.mf || false
			};

			//#region service 2.0 changes
			let treadDepth = inputTyreData.treadDepth || tyre.lastStatus.treadDepth;
			let grooves = tyreData[0] && tyreData[0].grooves || {};
			if (grooves && Object.keys(grooves).length && Object.keys(grooves.depths).length) {
				details.grooves = grooves;
				let grooveDepths = [];
				for (const depth in details.grooves.depths) {
					grooveDepths.push(parseFloat(details.grooves.depths[depth]));
				}
				if (grooveDepths.length) {
					treadDepth = Math.min(...grooveDepths);
				}
			}
			//#endregion

			histBulk.push({
				tyreNo: tyre.tyreNo,
				histDate: histDate,
				transaction: "Remove",
				condition: tyre.lastStatus.condition || "",
				tyreStatus: 2, //Removed
				inflation: null,
				AssetId: tyre.lastStatus.AssetId,
				position: tyre.lastStatus.position,
				wearPattern: inputTyreData.wearPattern,
				treadDepth: treadDepth,
				inspectedBy: res.locals.inspectedBy,
				shopName: null,
				amount: amountSplit,
				odometer: odo,
				tyreOdometer: tyreOdo,
				stockLocation: req.body.branchName && capitalizeWords(req.body.branchName) || '',
				BranchId: null,
				comments: req.body.comments,
				tpmsData: tyre.tpmsData,
				UserId: res.locals.UserId,
				AccountId: tyre.AccountId,
				username: res.locals.username,
				tyreImages: imagePaths,
				AplJobCardId: req.body.AplJobCardId && req.body.AplJobCardId || null,
				details: details
			});
		});

		RaiseLogEvent(ROUTE, res.locals.AccountId, histBulk, `Initiate tyre removal for ${tyreNumbers.join(',')}`);

		await models.sequelize.transaction(async t => {
			let tyreHistories = await models.TyreHistory.bulkCreate(histBulk, { returning: true, transaction: t });
			const historyMap = {};
			for (const hist of tyreHistories) {
				historyMap[hist.tyreNo] = hist;
			}

			await Promise.all((tyres || []).map(async (tyre) => {
				const histInstance = historyMap[tyre.tyreNo];
				if (!histInstance) return;
				const tyreHist = histInstance.get({ plain: true });
				tyre.set('lastStatus', { ...tyreHist });
				tyre.changed('lastStatus', true);
				tyre.set('tyreStatus', 2); //2-Removed
				tyre.set('AssetId', null);
				tyre.set('tpmsId', null);
				tyre.set('odometer', tyreHist.odometer);
				await tyre.save({ transaction: t });
			}));

			//#region capture enroute service details in tyre verification stage
			if (req.body.isTyreVerification && req.body.isTyreVerification == 'true' && TyreVerification && Object.keys(TyreVerification).length) {
				let details = TyreVerification.details && JSON.parse(JSON.stringify(TyreVerification.details)) || {};
				let enrouteRemoveCount = details.enrouteServices && details.enrouteServices.remove || 0;
				if (details.enrouteServices) {
					details.enrouteServices.remove = enrouteRemoveCount + 1;
				}
				details.enrouteServices.text = details.enrouteServices && details.enrouteServices.rotation && `${details.enrouteServices.rotation} Tyres Rotated${!enrouteRemoveCount ? ' while Enroute' : ''}` || '';
				if (details.enrouteServices.remove) {
					details.enrouteServices.text += details.enrouteServices.text && ` & ${details.enrouteServices.remove} Tyres Replaced while Enroute.` || `${details.enrouteServices.remove} Tyres Replaced while Enroute.`;
				}

				await TyreVerification.update({
					details: details
				}, { transaction: t });
			}
			//#endregion

			//#region update removed tyres count
			if (AplJobCard && AplJobCardUpd) {
				let services = JSON.parse(JSON.stringify(AplJobCard.services));
				let fitmentService = services.find(x => x.serviceName == "Tyre Fitment");
				let enRouteReplacement = services.find(x => x.completed == false && x.serviceName == "En Route Tyre Replacement");
				let removedCount = 0, updateDb = false;
				if (enRouteReplacement) {
					removedCount = enRouteReplacement.removedTyres && Number(enRouteReplacement.removedTyres) || 0;
					enRouteReplacement.removedTyres = Number(removedCount) + 1;
					updateDb = true;
				} else if (fitmentService) {
					if (!['SP', 'SP1', 'SP2', 'SP3', 'SP4'].includes(position)) {
						removedCount = fitmentService.removedTyres && Number(fitmentService.removedTyres) || 0;
						fitmentService['removedTyres'] = Number(removedCount) + 1;
						updateDb = true;
					}
				}
				if (updateDb) {
					await AplJobCard.update({
						services: services
					}, { transaction: t });
				}
			}
			//#endregion
		});

		RaiseLogEvent(ROUTE, res.locals.AccountId, {}, `Removed tyres : ${tyreNumbers.join(',')}`);
		imagesPush.map(image => {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/Remove_' + image.filename
				});
			}
		});
		RecalculateCpkm(tyreNumbers, AccountId);

		//#region Asset axle MF marking while tyre removal 
		if (req.body.mfRemoval && req.body.mfRemoval == 'true') {
			let result = await axleMfMarkingByTyre([position], Asset);
			if (!result.success || result.error) {
				RaiseLogEvent(ROUTE, 'error', result.error || {}, `Error marking monitored fitment while removal`);
			}
		}
		//#endregion

		return res.send({ success: true, tyres: tyres });

	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Data: ${JSON.stringify(req.body)}`);
		return res.send({ success: false, error: 'Error fetching data' });
	}
}

exports.getPsiDetails = async function (req, res) {
	const ROUTE = 'app/tyres/getPsiDetails';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing.' });
		}

		let AccountId = res.locals.AccountId;
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			if (res.locals.role == "AMCS FTE") {
				let geozoneResult = await avolveHelper.fetchGeozones(res);
				if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
					res.GeozoneId = geozoneResult.geozones.map(x => x.id);
					if (req.body.GeozoneId) {
						res.GeozoneId = req.body.GeozoneId;
					}
					let result = await avolveHelper.fetchCustomers(res);
					let accountIds = result && result.customers.map(x => x.id) || [];
					AccountId = accountIds;
				}
			} else {
				AccountId = res.locals.accountIds;
			}
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) {
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let Tyre = await models.Tyre.findOne({
			attributes: ['id', 'tyreNo', 'AssetId', 'AccountId'],
			where: {
				AssetId: req.params.id,
				AccountId: AccountId
			}
		});

		if (!Tyre) {
			return res.send({ success: false, error: 'Tyre Not found.' });
		}

		let VehicleInpsect = await models.Inspection.findOne({
			where: {
				AssetId: Tyre.AssetId,
				type: 'v',
				AccountId: Tyre.AccountId,
				date: { [Op.gte]: moment().subtract(72, 'hours').toISOString() },
			},
			order: [['date', 'desc']]
		});

		let TyreInspect;
		if (VehicleInpsect) {
			TyreInspect = await models.Inspection.findOne({
				include: [
					{
						attributes: ['id', 'lplate', 'axleConfig'],
						model: models.Asset
					}],
				where: {
					AssetId: Tyre.AssetId,
					type: 't',
					date: { [Op.gte]: VehicleInpsect.date },
					AccountId: Tyre.AccountId
				},
				order: [['date', 'desc']]
			});
		}

		if (!VehicleInpsect || !TyreInspect) {
			return res.send({ success: false, error: 'Please initiate Vehicle & Tyre Inspection and then perform IP Check & Correction.' });
		}

		let inActivePositions = [];
		if (TyreInspect.Asset && TyreInspect.Asset.axleConfig && TyreInspect.Asset.axleConfig.config) {
			let inActiveAxles = TyreInspect.Asset.axleConfig.config.filter(x => x.active == false); //ignore in-active axle positions
			for (let inActiveAxle of inActiveAxles) {
				if (inActiveAxle.position) {
					inActiveAxle.position.map(x => inActivePositions.push(x));
				}
			}
		}

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'tyreNo', 'lastStatus', 'AssetId'],
			where: {
				AssetId: TyreInspect.AssetId,
				'lastStatus.position': { [Op.notIn]: ["SP", "SP1", "SP2", "SP3"] }
			}
		});

		let results = [];
		for (let Tyre of Tyres) {
			let actPsi = Tyre.lastStatus && Tyre.lastStatus.inflation || "";
			if (Tyre.lastStatus && Tyre.lastStatus.details && Tyre.lastStatus.details.psiNotAccess && Tyre.lastStatus.details.psiNotAccess == true) {
				actPsi = "N/A";
			}
			results.push({
				histId: Tyre.lastStatus && Tyre.lastStatus.id || "",
				tyreNo: Tyre.tyreNo,
				position: Tyre.lastStatus && Tyre.lastStatus.position || "",
				recomPsi: Tyre.lastStatus && Tyre.lastStatus.details && Tyre.lastStatus.details.recomPsi.toString() || "",
				actPsi: actPsi.toString(),
				active: true,
				crctPsi: ""
			});
		}
		for (let position of inActivePositions) {//inactive positions
			results.push({
				histId: "",
				tyreNo: "",
				position: position,
				recomPsi: "",
				actPsi: "",
				active: false,
				crctPsi: ""
			});
		}

		return res.send({ success: true, results: results });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching psi details.');
		return res.send({ success: false, error: 'Error fetching psi details.' });
	}
}

exports.updatePsiUpdate = async function (req, res) {
	const ROUTE = 'app/tyres/updatePsiUpdate';
	try {
		RaiseLogEvent(ROUTE, req.params.id, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing.' });
		}

		let AccountId = res.locals.AccountId;
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			if (res.locals.role == "AMCS FTE") {
				let geozoneResult = await avolveHelper.fetchGeozones(res);
				if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
					res.GeozoneId = geozoneResult.geozones.map(x => x.id);
					if (req.body.GeozoneId) {
						res.GeozoneId = req.body.GeozoneId;
					}
					let result = await avolveHelper.fetchCustomers(res);
					let accountIds = result && result.customers.map(x => x.id) || [];
					AccountId = accountIds;
				}
			} else {
				AccountId = res.locals.accountIds;
			}
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) {
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'AccountId', 'odo'],
			where: {
				id: req.params.id,
				AccountId: AccountId
			}
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		let vehicleInspection = await models.Inspection.findOne({
			attributes: ['id', 'details', 'AssetId'],
			where: {
				AssetId: Asset.id,
				type: 'v',
				AccountId: AccountId
			},
			order: [['date', 'desc']]
		});

		let workshop = "";
		if (vehicleInspection && vehicleInspection.details && vehicleInspection.details.location) {
			workshop = vehicleInspection.details.location.name || "";
		}

		//#region requested tyre data
		var tyreData = JSON.parse(req.body.tyreData);
		tyreData = tyreData.filter(x => x.tyreNo != '');
		var tyreNumbers = tyreData.map(x => x.tyreNo);
		//#endregion
		let validatePsi = tyreData.find(x => x.crctPsi == "");
		if (validatePsi) {
			return res.send({ success: false, error: 'Please enter corrected PSI and proceed.' });
		}

		let tyres = await models.Tyre.findAll({
			where: { AccountId: AccountId, tyreNo: { [Op.in]: tyreNumbers } }
		});

		if (tyres.length != tyreNumbers.length) {
			return res.send({ success: false, error: "Tyres not found." });
		}

		for (const tyre of tyreData) {
			tyre.AccountId = Asset.AccountId;
			tyre.AssetId = Asset.id;
			tyre.date = moment().toISOString();
			evt.events.emit('create-apl-psiCorrect-tyrehist', tyre);
		}

		evt.events.emit('create-apollo-service-log', {
			AssetId: Asset.id,
			AccountId: Asset.AccountId,
			serviceName: "IP Check & Correction",
			sTime: moment().toISOString(),
			odo: Asset.odo,
			transaction: "IP Check & Correction",
			details: tyreData,
			workshop: workshop,
			serviceType: req.body.serviceType && req.body.serviceType || "",
			user: {
				id: res.locals.UserId,
				username: res.locals.username,
				name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
				date: moment().toISOString()
			},
			updServiceSch: true
		});

		return res.send({ success: true });

	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error updating psi details.');
		return res.send({ success: false, error: 'Error updating psi details.' });
	}
}

exports.getAlignDetails = async function (req, res) {
	const ROUTE = 'app/tyres/getAlignDetails';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing.' });
		}

		let AccountId = res.locals.AccountId;
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			if (res.locals.role == "AMCS FTE") {
				let geozoneResult = await avolveHelper.fetchGeozones(res);
				if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
					res.GeozoneId = geozoneResult.geozones.map(x => x.id);
					if (req.body.GeozoneId) {
						res.GeozoneId = req.body.GeozoneId;
					}
					let result = await avolveHelper.fetchCustomers(res);
					let accountIds = result && result.customers.map(x => x.id) || [];
					AccountId = accountIds;
				}
			} else {
				AccountId = res.locals.accountIds;
			}
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) {
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'details', 'axleConfig', 'AccountId'],
			where: {
				id: req.params.id,
				AccountId: AccountId
			}
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle Not found.' });
		}

		let results = [];
		if (Asset.axleConfig && Asset.axleConfig.config) {
			let axles = Asset.axleConfig.config;
			for (let i = 0; i < axles.length; i++) {
				if (['Spare Wheel', 'Spares'].indexOf(axles[i].name) == -1) {
					results.push({
						axlePosition: axles[i].name,
						axleNo: axles[i].axle,
						active: axles[i].active,
						checked: true,
						corrected: false
					});
				}
			}
		}

		return res.send({ success: true, results: results });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching psi details.');
		return res.send({ success: false, error: 'Error fetching psi details.' });
	}
}

exports.rimRotation = async function (req, res) {
	const ROUTE = 'app/tyres/rimRotation';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		//#region data received from input
		var tyreData = [];
		var tyreNumbers = [];
		tyreData = JSON.parse(req.body.tyreData);
		tyreData.forEach(tyreRecord => {
			tyreNumbers.push(tyreRecord.tyreNo);
		});
		//#endregion

		let AccountId = res.locals.AccountId;
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) { //For AMC FTE fetch customers from workshop
			if (res.locals.role == "AMCS FTE") {
				let geozoneResult = await avolveHelper.fetchGeozones(res);
				if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
					res.GeozoneId = geozoneResult.geozones.map(x => x.id);
					if (req.body.GeozoneId) {
						res.GeozoneId = req.body.GeozoneId;
					}
					let result = await avolveHelper.fetchCustomers(res);
					let accountIds = result && result.customers.map(x => x.id) || [];
					AccountId = accountIds;
				}
			} else {
				AccountId = res.locals.accountIds;
			}
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) { // For Xpert edge role fetch customers
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let tyres = await models.Tyre.findAll({
			include: [{
				model: models.Asset,
				attributes: ["id", "imei", "lplate", "odo", "billingType", 'AccountId']
			}],
			where: { AccountId: AccountId, AssetId: req.body.AssetId, tyreNo: tyreNumbers }
		});

		let branches = await models.Branch.findAll({
			attributes: ['id', 'name'],
			where: {
				AccountId: AccountId
			}
		});

		if (!tyres) {
			return res.send({ success: false, message: "Tyres not found for this asset." });
		}
		if (tyres.length !== tyreNumbers.length) {
			return res.send({ success: false, message: "Tyre count does not match asset." });
		}

		if (req.body.updateOdo && Math.round(req.body.odometer / 1000) && tyres[0].Asset) {
			var data = {};
			data.AssetId = tyres[0].Asset.id;
			data.AccountId = tyres[0].Asset.AccountId;
			data.odo = Math.round(req.body.odometer / 1000);
			data.emp = {
				id: res.locals.UserId,
				number: res.locals.UserId,
				name: res.locals.username
			}
			// evt.events.emit('create-device-command', data); Not required until GPS are used for Apollo Fleet
		}

		let inspectedBy = req.body.inspectedBy;
		// Always update odo for Apollo Fleet gps
		if (tyres[0].Asset && tyres[0].Asset.billingType == 'Apollo Fleet') {
			inspectedBy = res.locals.name;
		}

		let odoValidation = await getOdoValidation(res.locals.role, AccountId, tyres[0], req.body.odometer);
		if (!odoValidation.success) {
			return res.send({ success: false, error: odoValidation.error || 'Error removing tyre' });
		}

		var histBulk = [];
		var tyreImages = [];
		var histDate = (moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss").isValid()) ? moment(req.body.histDate, "YYYY-MM-DD HH:mm:ss") : moment();
		var amountSplit = !isNaN(req.body.amount) ? req.body.amount / tyreNumbers.length : 0;
		tyres.forEach(tyre => {
			var tyreRimRotation = tyreData.find(x => x.tyreNo == tyre.tyreNo);
			var odo = Number(req.body.odometer);
			if (!odo) {
				odo = tyre.Asset && tyre.Asset.odo || 0;
			}
			if (!tyre.lastStatus.tyreOdometer) {
				tyre.lastStatus.tyreOdometer = 0;
			}
			var tyreOdo = (odo - parseInt(tyre.lastStatus.odometer)) > 0 ? parseInt(tyre.lastStatus.tyreOdometer) + (odo - parseInt(tyre.lastStatus.odometer)) : parseInt(tyre.lastStatus.tyreOdometer);

			if (tyre.lastStatus && tyre.lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].indexOf(tyre.lastStatus.position) > -1) { //Reset tyre odo if prev is Stepney
				tyreOdo = parseInt(tyre.lastStatus.tyreOdometer);
			}

			var tyreImgs = (req.files) ? req.files.filter(files => {
				return files.originalname.substring(0, files.originalname.indexOf('_')) == tyre.tyreNo;
			}) : '';

			if (req.files && tyreImgs && tyreImgs.length) {
				tyreImages = tyreImages.concat(tyreImgs);
			}

			var imagePaths = tyreImgs.length > 0 ? tyreImgs.map(obj => {
				return '/' + md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + obj.filename
			}).toString() : null;

			let details = tyre.lastStatus && JSON.parse(JSON.stringify(tyre.lastStatus.details)) || {};
			details.mf = (tyre.details && tyre.details.mf) && (details && details.mf) || false; //hist level mf marking

			histBulk.push({
				tyreNo: tyre.tyreNo,
				transaction: 'Rotation On Rim',
				histDate: histDate,
				condition: tyre.lastStatus.condition || "",
				tyreStatus: tyre.lastStatus.tyreStatus || null,
				position: tyre.lastStatus.position,
				AssetId: tyre.lastStatus.AssetId,
				inflation: tyreRimRotation.inflation,
				wearPattern: tyreRimRotation.wearPattern,
				treadDepth: tyreRimRotation.treadDepth || tyre.lastStatus.treadDepth,
				inspectedBy: inspectedBy,
				shopName: req.body.shopName,
				amount: amountSplit,
				odometer: odo,
				tyreOdometer: tyreOdo,
				stockLocation: tyre.lastStatus.stockLocation,
				BranchId: tyre.lastStatus.Branch ? (tyre.lastStatus.Branch.id ? tyre.lastStatus.Branch.id : null) : null,
				comments: req.body.comments,
				tpmsData: tyre.tpmsData,
				UserId: res.locals.UserId,
				AccountId: tyre.AccountId,
				username: res.locals.username,
				tyreImages: imagePaths,
				details: details
			});
		})

		let tyreHistoryStruct = [];
		await models.sequelize.transaction(async t => {
			let tyreHistories = await models.TyreHistory.bulkCreate(histBulk, { returning: true, transaction: t });
			tyreHistoryStruct = tyreHistories.map(x => x);
			const historyMap = {};
			for (const hist of tyreHistories) {
				historyMap[hist.tyreNo] = hist;
			}

			await Promise.all((tyres || []).map(async (tyre) => {
				const histInstance = historyMap[tyre.tyreNo];
				if (!histInstance) return;
				const tyreHist = histInstance.get({ plain: true });
				let BranchId = tyre.lastStatus.Branch ? (tyre.lastStatus.Branch.id ? tyre.lastStatus.Branch.id : null) : null;
				let matchedBranch = branches.find(x => x.id == BranchId);
				let Branch = {};
				if (matchedBranch) {
					Branch.id = matchedBranch.id;
					Branch.name = matchedBranch.name;
				}
				tyreHist.Branch = Branch;
				tyre.set('lastStatus', { ...tyreHist });
				tyre.changed('lastStatus', true);
				let lastWorkDone = tyre.lastWorkDone || {};
				lastWorkDone.rimRotation = {
					date: tyreHist.histDate,
					tyreOdometer: tyreHist.tyreOdometer,
					nextService: null,
					nextServiceInMonth: null
				};;
				tyre.set('lastWorkDone', { ...lastWorkDone });
				tyre.changed('lastWorkDone', true);
				await tyre.save({ transaction: t });
			}));
		});

		tyreImages.map(image => {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(res.locals.AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/' + image.filename
				});
			}
		});

		RecalculateCpkm(tyreNumbers, AccountId);
		if (tyres[0] && tyres[0].Asset) {
			let details = [];
			for (const hist of histBulk) {
				details.push({
					tyreNo: hist.tyreNo,
					currentPosition: hist.position,
					inspectedPosition: hist.position,
					AssetId: hist.AssetId,
					odometer: hist.odometer,
					tyreOdometer: hist.tyreOdometer
				})
			}
			evt.events.emit('create-apollo-service-log', {
				AssetId: tyres[0].Asset.id,
				AccountId: tyres[0].Asset.AccountId,
				sTime: moment().toISOString(),
				serviceName: "Tyre Rotation On Rim",
				odo: tyreHistoryStruct.length && tyreHistoryStruct[0].odometer || tyres[0].Asset.odo,
				transaction: "Tyre Rotation On Rim",
				details: details,
				workshop: req.body.shopName && req.body.shopName || "",
				serviceType: req.body.serviceType && req.body.serviceType || "",
				user: {
					id: res.locals.UserId,
					username: res.locals.username,
					name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
					date: moment().toISOString()
				},
				updServiceSch: true
			});
		}

		return res.send({ success: true, tyres: tyres, tyreHistories: tyreHistoryStruct });

	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Data: ${JSON.stringify(req.body)}`);
		return res.send({ success: false, error: 'Error align tyres' });
	}
}

function RecalculateCpkm(tyres, AccountId) {
	for (const tyreNo of tyres) {
		evt.events.emit('tyre-cpkm-refresh', { tyreNo: tyreNo, AccountId: AccountId });
	}
}

exports.getTyreHistory = async function (req, res) {
	const ROUTE = 'app/tyres/getTyreHistory';
	try {
		if (!req.params.tyreNo) {
			return res.send({ success: false, error: 'Tyre no missing.' });
		}

		let AccountId = res.locals.AccountId;
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
			if (res.locals.role == "AMCS FTE") {
				let geozoneResult = await avolveHelper.fetchGeozones(res);
				if (geozoneResult && geozoneResult.geozones && geozoneResult.geozones.length) {
					res.GeozoneId = geozoneResult.geozones.map(x => x.id);
					if (req.query.GeozoneId) {
						res.GeozoneId = req.query.GeozoneId;
					}
					let result = await avolveHelper.fetchCustomers(res);
					AccountId = result && result.customers.map(x => x.id) || [];
				}
			} else {
				AccountId = res.locals.accountIds;
			}
		}

		if (["XE FTE", "ARSA"].includes(res.locals.role)) {
			AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let TyreHistories = await models.TyreHistory.findAll({
			include: [{
				model: models.Asset,
				attributes: ['id', 'lplate', 'remove', 'active', 'details']
			}],
			where: {
				tyreNo: req.params.tyreNo,
				AccountId: AccountId
			},
			order: [['id', 'DESC']]
		});

		return res.send({ success: true, results: TyreHistories });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching tyre history.');
		return res.send({ success: false, error: 'Error fetching tyre history.' });
	}
}

exports.getHistoryByAsset = async function (req, res) {
	const ROUTE = 'app/tyres/getHistoryByAsset';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing Input parameter.' });
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'AccountId'],
			where: {
				id: req.params.id
			}
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found.' });
		}

		let TyreHistories = await models.TyreHistory.findAll({
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			},
			order: [['id', 'DESC']]
		});

		return res.send({ success: true, results: TyreHistories });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching tyre history.');
		return res.send({ success: false, error: 'Error fetching tyre history.' });
	}
}

exports.getByAsset = async function (req, res) {
	const ROUTE = 'app/tyres/getByAsset';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Asset Id missing.' });
		}

		let Tyres = await models.Tyre.findAll({
			where: {
				AssetId: req.params.id
			},
			raw: true
		});

		let psiTypeKeys = ["actPsi", "crctPsi", "recomPsi"];
		for (const tyre of Tyres) {
			if (tyre.lastStatus && tyre.lastStatus.details) {
				const details = tyre.lastStatus.details;
				for (const key in details) {
					if (psiTypeKeys.includes(key)) {
						details[key] = details[key].toString();
					}
				}
				if (details.grooves && details.grooves.depths) {
					const depths = details.grooves.depths;
					for (const depthKey in depths) {
						depths[depthKey] = depths[depthKey].toString();
					}
				}
			}
		}

		return res.send({ success: true, results: Tyres });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, `Error fetching tyres.`);
		return res.send({ success: false, error: 'Error fetching tyres.' });
	}
}

exports.tyreSummary = async function (req, res) {
	const ROUTE = 'app/tyres/tyreSummary';
	try {
		if (!['FM', 'FO', 'DE FTE', 'XE FTE', 'ARSA', 'AMCC FTE'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let AccountId = res.locals.AccountId;
		if (['HO Sales', 'FTS HO', 'FTS ZM', 'ZM', 'FTS KAM', 'KAM', 'XE FTE', 'ARSA'].includes(res.locals.role)) {
			AccountId = req.query.AccountId || [];
		} else if (['AMCC FTE'].includes(res.locals.role)) {
			AccountId = res.locals.accountIds || [];
		}

		let statusCounts = {};
		let tyreSummary = await avolveHelper.getDashboardTyreSummary(AccountId, false, false);
		if (tyreSummary && tyreSummary.success && tyreSummary.result) {
			statusCounts = tyreSummary.result && tyreSummary.result.statusCounts || {};
		}

		let result = {
			inv: {
				total: statusCounts.invTotal,
				groups: [
					{ name: 'New', status: 0, count: statusCounts.New || 0 },
					{ name: 'Removed', status: 2, count: statusCounts.removed || 0 },
					{ name: 'Retreaded', status: 4, count: statusCounts.retreaded || 0 }
				]
			}
		};

		if (req.query.isInStock && req.query.isInStock == 'false') {
			result.inv.groups.splice(1, 0, { name: 'Running', status: 1, count: statusCounts.running || 0 });
			result.inv.groups.splice(4, 0, { name: 'Pending for Decision', status: 5, count: statusCounts.pendingForDecision || 0 });
			result.outOfInv = {
				total: statusCounts.outOfInvTotal,
				groups: [
					{ name: 'Sent for Retread', status: 3, count: statusCounts.sentForRetread || 0 },
					{ name: 'Scrapped', status: 6, count: statusCounts.scrapped || 0 }
				]
			};
		} else if (req.query.isInStock && req.query.isInStock == 'true') {
			result.inv.total = statusCounts.New + statusCounts.removed + statusCounts.retreaded;
		}

		return res.send({ success: true, result: result });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, "Error fetching tyres data.");
		return res.send({ success: false, error: 'Error fetching tyres data.' });
	}
}

exports.listByStatus = async function (req, res) {
	const ROUTE = 'app/tyres/listByStatus';
	try {
		if (!['FM', 'FO', 'DE FTE', 'XE FTE', 'ARSA', 'AMCC FTE'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let AccountId = res.locals.AccountId;
		if (['XE FTE', 'ARSA'].includes(res.locals.role)) {
			AccountId = req.query.AccountId || [];
		}
		if (['AMCC FTE'].includes(res.locals.role)) {
			AccountId = res.locals.accountIds || [];
		}

		const queryOptions = {
			where: {
				AccountId: AccountId
			}
		};

		if (req.query.status) {
			queryOptions.where.tyreStatus = req.query.status;
		}

		if (req.query.limit && req.query.limit != -1) {
			let page = parseInt(req.query.page) || 1;
			let limit = parseInt(req.query.limit) || 40;
			queryOptions.limit = limit;
			queryOptions.offset = (page - 1) * limit;
		}

		if (req.query.isMfTyre && JSON.parse(req.query.isMfTyre)) {
			queryOptions.where["details.mf"] = true;
		}

		let Tyres = await models.Tyre.findAll({
			...{
				attributes: ['id', 'lastStatus', 'tyreNo', 'mfgBy', 'model', 'codeSize', 'AssetId', 'rfid', 'tpmsData', 'details'],
				include: [{
					attributes: ['id', 'lplate'],
					model: models.Asset
				}]
			},
			...queryOptions
		});

		if (!Tyres.length) {
			return res.send({ success: true, results: [] });
		}

		let TyreHistories = [];
		if (['5'].includes(req.query.status)) {//For Scrap status, fetch last 2 status for retread rejected flag
			TyreHistories = await models.sequelize.query(`
				SELECT * FROM (
					SELECT "id", "tyreNo", "transaction", "histDate", ROW_NUMBER() OVER (PARTITION BY "tyreNo" ORDER BY "histDate" DESC, "id" DESC) AS row_num
					FROM "TyreHistories" WHERE "tyreNo" IN (:tyreNos)
				) t
				WHERE row_num <= 2 ORDER BY "histDate" DESC, "id" DESC;`, {
				replacements: { tyreNos: Tyres.map(x => x.tyreNo) },
				type: models.sequelize.QueryTypes.SELECT,
			});
		}

		let tyreHistoryMap = avolveHelper.createMap(TyreHistories, 'tyreNo', true);
		TyreHistories = null;

		let TyresInScrap = await models.TyreScrap.findAll({
			where: {
				AccountId: AccountId,
				status: 'Scrap'
			}
		});

		let TyresInScrapMap = {};
		for (const tyreScrap of TyresInScrap) {
			TyresInScrapMap[tyreScrap.tyreNo] = tyreScrap;
		}

		let results = [];
		let retreadList = []
		if (['3', '5'].includes(req.query.status)) { //Retreading, Scrap
			let status = req.query.status == 3 ? 'sent' : 'scrap';
			let retreadResult = await getTyresInRetread(Tyres.map(x => x.tyreNo), AccountId, status);
			if (retreadResult.success && retreadResult.results && retreadResult.results.length) {
				retreadList = retreadResult.results;
			}
		}

		for (const Tyre of Tyres) {
			let { lastStatus } = Tyre;
			let matchedHists = tyreHistoryMap.get(Tyre.tyreNo) || [];
			let matchedTyreInScrap = TyresInScrapMap[Tyre.tyreNo] || {};
			let retread = {};
			if (['3', '5'].includes(req.query.status)) { //Retreading, Scrap
				retread = retreadList.find(x => x.tyreNo == Tyre.tyreNo) || {};
			}
			let depth = lastStatus && (lastStatus.treadDepth || lastStatus.treadDepth == 0) ? lastStatus.treadDepth.toString() : '';

			// groove wise depth
			const grooves = getGrooveWiseDepth(lastStatus);
			// Retread status
			const retreadStatus = getRetreadStatus(retread, matchedHists);
			results.push({
				id: Tyre.id,
				tyreNo: Tyre.tyreNo,
				tyreOdo: lastStatus && lastStatus.tyreOdometer && Math.round(parseInt(lastStatus.tyreOdometer) / 1000).toString() || '',
				depth: depth,
				position: lastStatus && lastStatus.position || '',
				transaction: lastStatus && lastStatus.transaction || '',
				make: Tyre.mfgBy || '',
				model: Tyre.model || '',
				codeSize: Tyre.codeSize,
				rfId: Tyre.rfid,
				tpmsId: Tyre.tpmsData && Tyre.tpmsData.TPID || '',
				AssetId: Tyre.AssetId,
				lplate: Tyre.Asset && Tyre.Asset.lplate || '',
				dealer: retread && retread.rtdCompany || '',
				tyreScrapId: matchedTyreInScrap && matchedTyreInScrap.id || null,
				tyreRetreadId: retread && retread.id || null,
				isMfTyre: Tyre.details && Tyre.details.mf || false,
				grooves: grooves,
				retreadStatus: retreadStatus
			});
		}

		return res.send({ success: true, results: results });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching tyres.');
		return res.send({ success: false, error: 'Error fetching tyres.' });
	}
}

exports.summarySearch = async function (req, res) {
	const ROUTE = 'app/tyres/summarySearch';
	try {
		if (!['FM', 'FO', 'DE FTE', 'XE FTE', 'ARSA', 'AMCC FTE'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.params.tyreNo) {
			return res.send({ success: false, error: 'Missing input field.' });
		}

		let AccountId = res.locals.AccountId;
		if (['XE FTE', 'ARSA'].includes(res.locals.role)) {
			AccountId = req.query.AccountId || [];
		}
		if (['AMCC FTE'].includes(res.locals.role)) {
			AccountId = res.locals.accountIds || [];
		}

		let Tyre = await models.Tyre.findOne({
			attributes: ['id', 'lastStatus', 'tyreNo', 'mfgBy', 'model', 'codeSize', 'AssetId', 'rfid', 'tpmsData', 'tyreStatus', 'details'],
			include: [{
				attributes: ['id', 'lplate'],
				model: models.Asset
			}],
			where: {
				tyreNo: req.params.tyreNo.trim().toUpperCase(),
				AccountId: AccountId
			}
		});

		if (!Tyre) {
			return res.send({ success: true, result: { message: `<html><p>Tyre Serial no. "<b>${req.params.tyreNo}</b>" not found</p></html>` } });
		}

		let status = Tyre.lastStatus.tyreStatus == null || Tyre.lastStatus.tyreStatus == '' ? Tyre.tyreStatus : Tyre.lastStatus.tyreStatus;
		status = statusDisplay(parseInt(status)) || '';
		let TyresCount = 0;
		if (status) {
			if (req.query.isInStock && req.query.isInStock == 'true' && !['New', 'Removed', 'Retreaded'].includes(status)) {
				return res.send({ success: true, result: { message: `<html><p>"<b>${Tyre.tyreNo}</b>" found under <b>${status}</b> Tyres</p></html>` } });
			}
			TyresCount = await models.Tyre.count({
				where: {
					AccountId: AccountId,
					'lastStatus.tyreStatus': Tyre.lastStatus.tyreStatus
				}
			});
		}

		let { lastStatus } = Tyre;
		let retread = {};
		if (['Sent for Retread', 'Pending for Decision'].includes(status)) { //Retreading, Scrap
			let retreadStatus = status == 'Sent for Retread' ? 'sent' : 'scrap';
			let retreadResult = await getTyresInRetread([Tyre.tyreNo], AccountId, retreadStatus);
			if (retreadResult.success && retreadResult.results && retreadResult.results.length) {
				let retreadList = retreadResult.results;
				retread = retreadList[0] || {};
			}
		}

		// groove wise depth
		const grooves = getGrooveWiseDepth(lastStatus);
		let depth = lastStatus && (lastStatus.treadDepth || lastStatus.treadDepth == 0) ? lastStatus.treadDepth.toString() : '';
		let result = {
			tyreData: {
				id: Tyre.id,
				tyreNo: Tyre.tyreNo,
				tyreOdo: lastStatus && lastStatus.tyreOdometer && Math.round(parseInt(lastStatus.tyreOdometer) / 1000).toString() || '',
				depth: depth,
				position: lastStatus && lastStatus.position || '',
				transaction: lastStatus && lastStatus.transaction || '',
				make: Tyre.mfgBy || '',
				model: Tyre.model || '',
				codeSize: Tyre.codeSize,
				rfId: Tyre.rfid,
				tpmsId: Tyre.tpmsData && Tyre.tpmsData.TPID || '',
				AssetId: Tyre.AssetId,
				lplate: Tyre.Asset && Tyre.Asset.lplate || '',
				dealer: retread && retread.rtdCompany || '',
				isMfTyre: Tyre.details && Tyre.details.mf || false,
				grooves,
				retreadStatus: retread && retread.details && retread.details.status == 2 ? 'Retread Rejected' : ''
			},
			group: {
				name: status,
				count: TyresCount,
				status: Tyre.lastStatus && Number(Tyre.lastStatus.tyreStatus)
			},
			message: `<html><p>"<b>${Tyre.tyreNo}</b>" found under <b>${status}</b> Tyres</p></html>`
		};

		return res.send({ success: true, result: result });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, "Error searching tyre summary.");
		return res.send({ success: false, error: 'Error searching tyre summary.' });
	}
}

exports.listByStatusSearch = async function (req, res) {
	const ROUTE = 'app/tyres/listByStatusSearch';
	try {
		if (!['FM', 'FO', 'DE FTE', 'XE FTE', 'ARSA', 'AMCC FTE'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.query.status || !req.params.tyreNo) {
			return res.send({ success: false, error: 'Missing input field.' });
		}

		let AccountId = res.locals.AccountId;
		if (['XE FTE', 'ARSA'].includes(res.locals.role)) {
			AccountId = req.query.AccountId || [];
		}
		if (['AMCC FTE'].includes(res.locals.role)) {
			AccountId = res.locals.accountIds || [];
		}

		let tyreWhere = {
			tyreNo: {
				$like: `%${req.params.tyreNo.trim().toUpperCase()}%`
			},
			AccountId: AccountId,
			tyreStatus: parseInt(req.query.status),
		};

		if (req.query.isMfTyre && JSON.parse(req.query.isMfTyre)) {
			tyreWhere["details.mf"] = true;
		}

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'lastStatus', 'tyreNo', 'mfgBy', 'model', 'codeSize', 'AssetId', 'rfid', 'tpmsData', 'details'],
			include: [{
				attributes: ['id', 'lplate'],
				model: models.Asset
			}],
			where: tyreWhere
		});

		let results = [];
		if (['3', '5'].includes(req.query.status)) { //Retreading, Scrap
			let status = req.query.status == 3 ? 'sent' : 'scrap';
			let retreadResult = await getTyresInRetread(Tyres.map(x => x.tyreNo), AccountId, status);
			if (retreadResult.success && retreadResult.results && retreadResult.results.length) {
				retreadList = retreadResult.results;
			}
		}

		for (const Tyre of Tyres) {
			let { lastStatus } = Tyre;
			let retread = {};
			if (['3', '5'].includes(req.query.status)) { //Retreading, Scrap
				retread = retreadList.find(x => x.tyreNo == Tyre.tyreNo);
			}

			// groove wise depth
			const grooves = getGrooveWiseDepth(lastStatus);
			let depth = lastStatus && (lastStatus.treadDepth || lastStatus.treadDepth == 0) ? lastStatus.treadDepth.toString() : '';

			results.push({
				id: Tyre.id,
				tyreNo: Tyre.tyreNo,
				tyreOdo: lastStatus && lastStatus.tyreOdometer && Math.round(parseInt(lastStatus.tyreOdometer) / 1000).toString() || '',
				depth: depth,
				position: lastStatus && lastStatus.position || '',
				transaction: lastStatus && lastStatus.transaction || '',
				make: Tyre.mfgBy || '',
				model: Tyre.model || '',
				codeSize: Tyre.codeSize || '',
				rfId: Tyre.rfid || '',
				tpmsId: Tyre.tpmsData && Tyre.tpmsData.TPID || '',
				AssetId: Tyre.AssetId,
				lplate: Tyre.Asset && Tyre.Asset.lplate || '',
				dealer: retread && retread.rtdCompany || '',
				isMfTyre: Tyre.details && Tyre.details.mf || false,
				grooves,
				retreadStatus: retread && retread.details && retread.details.status == 2 ? 'Retread Rejected' : ''
			});
		}

		return res.send({ success: true, results: results });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, "Error fetching tyres.");
		return res.send({ success: false, error: 'Error fetching tyres.' });
	}
}

exports.listByLife = async function (req, res) {
	const ROUTE = 'app/tyres/listByLife';
	try {
		if (!['FM', 'FO', 'DE FTE', 'XE FTE', 'ARSA'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.query.slab) {
			return res.send({ success: false, error: 'Missing input field.' });
		}

		let AccountId = res.locals.AccountId;
		if (['XE FTE', 'ARSA'].includes(res.locals.role)) {
			AccountId = req.query.AccountId || [];
		}
		if (['AMCC FTE'].includes(res.locals.role)) {
			AccountId = res.locals.accountIds || [];
		}

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'initialTreadDepth', 'tyreStatus', 'lastStatus', 'tyreNo', 'mfgBy', 'model', 'codeSize', 'AssetId', 'tpmsData', 'rfid'],
			include: [{
				attributes: ['id', 'lplate'],
				model: models.Asset
			}],
			where: {
				AccountId: AccountId,
				tyreStatus: { [Op.notIn]: [3, 6] }//Sent for retread and Scrapped
			}
		});

		let tyreLifeSlabs = [
			{ id: 1, start: 0, end: 15.4 }, { id: 2, start: 15.5, end: 30.4 },
			{ id: 3, start: 30.5, end: 50.4 }, { id: 4, start: 50.5, end: 70.4 },
			{ id: 5, start: 70.5, end: 85.4 }, { id: 6, start: 85.5, end: 100 }
		];

		let slabFilter = tyreLifeSlabs.find(x => x.id == req.query.slab);
		let results = [];
		for (const Tyre of Tyres) {
			let { lastStatus } = Tyre;
			if (slabFilter) {
				let initDepth = parseFloat(Tyre.initialTreadDepth || 0);
				let curDepth = lastStatus && lastStatus.treadDepth || 0;
				let usage = ((parseFloat(curDepth) / (initDepth)) * 100).toFixed(1);
				usage = usage && !isFinite(usage) ? 0 : parseFloat(usage);
				if (usage >= slabFilter.start && (slabFilter.end == 100 || usage <= slabFilter.end)) {
					let status = lastStatus.tyreStatus == null || lastStatus.tyreStatus == '' ? Tyre.tyreStatus : lastStatus.tyreStatus;
					status = parseInt(status);
					let depth = lastStatus && (lastStatus.treadDepth || lastStatus.treadDepth == 0) ? lastStatus.treadDepth.toString() : '';
					results.push({
						id: Tyre.id,
						tyreNo: Tyre.tyreNo,
						tyreStatus: status,
						tyreOdo: lastStatus && lastStatus.tyreOdometer && Math.round(parseInt(lastStatus.tyreOdometer) / 1000).toString() || '',
						depth: depth,
						make: Tyre.mfgBy || '',
						model: Tyre.model || '',
						codeSize: Tyre.codeSize || '',
						rfId: Tyre.rfid || '',
						tpmsId: Tyre.tpmsData && Tyre.tpmsData.TPID || '',
						AssetId: Tyre.AssetId,
						lplate: Tyre.Asset && Tyre.Asset.lplate || ''
					});
				}
			}
		}

		return res.send({ success: true, results: results });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, "Error fetching tyres.");
		return res.send({ success: false, error: 'Error fetching tyres.' });
	}
}

exports.getTyresByIds = async function (req, res) {
	const ROUTE = 'app/tyres/getTyresByIds';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!['FM', 'FO', 'DE FTE', 'XE FTE', 'ARSA', 'AMCC FTE'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let AccountId = res.locals.AccountId;
		if (['XE FTE', 'ARSA'].includes(res.locals.role)) {
			AccountId = req.body.AccountId || [];
		}
		if (['AMCC FTE'].includes(res.locals.role)) {
			AccountId = res.locals.accountIds || [];
		}

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'lastStatus', 'tyreNo', 'mfgBy', 'model', 'codeSize'],
			include: [{
				attributes: ['id', 'lplate'],
				model: models.Asset
			}],
			where: {
				id: req.body.tyreIds,
				AccountId: AccountId
			}
		});

		let TyresInScrap = await models.TyreScrap.findAll({
			where: {
				AccountId: AccountId,
				tyreNo: Tyres.map(x => x.tyreNo),
				status: 'Scrap'
			}
		});

		let TyresInScrapMap = {};
		for (const tyreScrap of TyresInScrap) {
			TyresInScrapMap[tyreScrap.tyreNo] = tyreScrap;
		}

		let results = [];
		let retreadList = []
		if (req.body.status == 3) { //Retreading
			let retreadResult = await getTyresInRetread(Tyres.map(x => x.tyreNo), AccountId, 'sent');
			if (retreadResult.success && retreadResult.results && retreadResult.results.length) {
				retreadList = retreadResult.results;
			}
		}

		for (const Tyre of Tyres) {
			let { lastStatus } = Tyre;
			let matchedTyreInScrap = TyresInScrapMap[Tyre.tyreNo] || {};
			let retread = {};
			if (req.body.status == 3) { //Retreading
				retread = retreadList.find(x => x.tyreNo == Tyre.tyreNo);
			}
			let grooves = null;
			if (lastStatus && lastStatus.details && lastStatus.details.grooves && Object.keys(lastStatus.details.grooves).length) {
				grooves = lastStatus.details.grooves;
			}
			let depth = lastStatus && (lastStatus.treadDepth || lastStatus.treadDepth == 0) ? lastStatus.treadDepth.toString() : '';
			results.push({
				id: Tyre.id,
				tyreNo: Tyre.tyreNo,
				depth: depth,
				make: Tyre.mfgBy || '',
				model: Tyre.model || '',
				codeSize: Tyre.codeSize,
				tyreScrapId: matchedTyreInScrap && matchedTyreInScrap.id || null,
				tyreRetreadId: retread && retread.id || null,
				grooves: grooves
			});
		}

		return res.send({ success: true, results: results });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching tyres.');
		return res.send({ success: false, error: 'Error fetching tyres.' });
	}
};

exports.scrapCancel = async function (req, res) {
	const ROUTE = 'app/tyres/scrapCancel';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.body.tyreData || (req.body.tyreData && !Object.keys(req.body.tyreData).length)) {
			return res.send({ success: false, error: 'Tyre data missing.', message: 'Tyre data missing.' });
		}

		let tyreData = [], tyreNumbers = [];
		try {
			tyreData = JSON.parse(req.body.tyreData);
		} catch (err) {
			return res.send({ success: false, error: 'Error parsing tyre data.', message: 'Error parsing tyre data.' });
		}

		tyreData.forEach(tyreRecord => {
			tyreNumbers.push(tyreRecord.tyreNo);
		});

		let AccountId = res.locals.AccountId;
		if (["XE FTE", "ARSA"].includes(res.locals.role)) {
			AccountId = res.locals.accountIds;
		}
		if (res.locals.role == "AMCC FTE") {
			AccountId = res.locals.accountIds;
		}

		let tyres = await models.Tyre.findAll({
			include: [{
				model: models.Asset,
				attributes: ["id", "imei", "lplate", "odo"]
			}],
			where: {
				AccountId: AccountId,
				tyreNo: { [Op.in]: tyreNumbers }
			}
		});

		if (!tyres.length) {
			return res.send({ success: false, message: "Tyres not found.", error: "Tyres not found." });
		}

		let histDate = (moment(req.body.date, "YYYY-MM-DD HH:mm:ss").isValid()) ? moment(req.body.date, "YYYY-MM-DD HH:mm:ss") : moment();

		let tyreScrapStruct = [], imagesPush = [];
		await models.sequelize.transaction(async t => {
			await models.TyreScrap.update({
				scrapDate: histDate,
				soldTo: req.body.soldTo,
				amount: !isNaN(req.body.amount) ? req.body.amount : 0,
				paymentMode: req.body.paymentMode,
				comments: req.body.comments,
				status: "Scrap Cancel"
			}, {
				where: { tyreNo: { [Op.in]: tyreNumbers } },
				transaction: t
			});

			let histBulk = [];
			let amountSplit = !isNaN(req.body.amount) ? req.body.amount / tyreNumbers.length : 0;
			tyres.forEach(tyre => {
				tyreScrapStruct.push(tyre);
				let tyreInput = tyreData.find(x => x.tyreNo == tyre.tyreNo);

				//#region tyre image upload
				let tyreImgs = (req.files) && req.files.filter(files => {
					if (files.originalname && files.originalname.startsWith(`${tyre.tyreNo}_${tyre.id}`)) return files.originalname;
				}) || '';
				if (req.files && tyreImgs && tyreImgs.length) {
					imagesPush = imagesPush.concat(tyreImgs);
				}
				let imagePaths = tyreImgs.length > 0 ? tyreImgs.map(obj => {
					return '/' + md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/ScrapCancel_' + obj.filename;
				}).toString() : null;
				//#endregion

				//#region service 2.0 changes
				let details = tyre.lastStatus && tyre.lastStatus.details || {};
				let treadDepth = tyreInput.treadDepth || tyre.lastStatus.treadDepth;
				let grooves = tyreInput && tyreInput.grooves || {};
				if (grooves && Object.keys(grooves).length && Object.keys(grooves.depths).length) {
					details.grooves = grooves;
					let grooveDepths = [];
					for (const depth in details.grooves.depths) {
						grooveDepths.push(parseFloat(details.grooves.depths[depth]));
					}
					if (grooveDepths.length) {
						treadDepth = Math.min(...grooveDepths);
					}
				}
				//#endregion

				//#region Create Bulk Scrap Cancel array
				histBulk.push({
					tyreNo: tyre.tyreNo,
					transaction: "Scrap Cancel",
					histDate: histDate,
					treadDepth: treadDepth || 0,
					condition: tyre.lastStatus.condition || "",
					tyreStatus: 2,
					inspectedBy: res.locals.inspectedBy,
					shopName: null,
					amount: amountSplit,
					tyreOdometer: tyre.lastStatus.tyreOdometer,
					odometer: tyre.lastStatus.odometer,
					stockLocation: req.body.branchName && capitalizeWords(req.body.branchName) || '',
					AccountId: tyre.AccountId,
					BranchId: null,
					comments: req.body.comments || '',
					details: details,
					tpmsData: tyre.tpmsData,
					tyreImages: imagePaths,
					username: res.locals.username,
					UserId: res.locals.UserId
				});
				//#endregion
			});

			let tyreHistories = await models.TyreHistory.bulkCreate(histBulk, {
				returning: true,
				transaction: t
			});

			await Promise.all((tyres || []).map(async (tyre) => {
				const histInstance = historyMap[tyre.tyreNo];
				if (!histInstance) return;
				const tyreHist = histInstance.get({ plain: true });
				tyre.set('condition', tyre.lastStatus.condition);
				tyre.set('lastStatus', { ...tyreHist });
				tyre.changed('lastStatus', true);

				tyre.set('AssetId', null);
				tyre.set('tpmsId', null);
				tyre.set('tyreStatus', 2); //2-Removed
				tyre.set('odometer', 0);
				tyre.set('installedOn', null);
				return tyre.save({ transaction: t });
			}));
		});

		for (const image of imagesPush) {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/ScrapCancel_' + image.filename
				});
			}
		}

		RecalculateCpkm(tyreNumbers, res.locals.AccountId);
		return res.send({ success: true, tyres: tyres, tyreScraps: tyreScrapStruct });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, `Error fetching data`);
		return res.send({ success: false, error: 'Error fetching data.' });
	}
}

exports.getDealersList = async function (req, res) {
	const ROUTE = 'app/tyres/getDealersList';
	try {
		if (!['FM', 'FO', 'DE FTE', 'XE FTE', 'ARSA', 'AMCC FTE'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let AccountId = res.locals.AccountId;
		if (['XE FTE', 'ARSA'].includes(res.locals.role)) {
			AccountId = req.query.AccountId || [];
		}
		if (['AMCC FTE'].includes(res.locals.role)) {
			AccountId = res.locals.accountIds || [];
		}

		let TyreRetreads = await models.TyreRetread.findAll({
			attributes: ['id', 'rtdCompany'],
			where: { AccountId },
			raw: true
		});

		// Extract, filter, and unique the `rtdCompany` values
		let uniqueRtdCompanies = [...new Set(
			TyreRetreads.map(tyreRetread => tyreRetread.rtdCompany).filter(company => company && company != 'N/A')
		)];

		return res.send({ success: true, results: uniqueRtdCompanies });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, `Error fetching data`);
		return res.send({ success: false, error: 'Error fetching data.' });
	}
}

exports.branchList = async function (req, res) {
	const ROUTE = 'app/tyres/branchList';
	try {
		if (!['FM', 'FO', 'DE FTE', 'XE FTE', 'ARSA', 'AMCC FTE', 'AMCS FTE'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let AccountId = res.locals.AccountId;
		if (['XE FTE', 'ARSA', 'AMCS FTE'].includes(res.locals.role)) {
			AccountId = req.query.AccountId || [];
		}
		if (['AMCC FTE'].includes(res.locals.role)) {
			AccountId = res.locals.accountIds || [];
		}

		let uniqueBranches = await models.TyreHistory.findAll({
			attributes: [
				[models.sequelize.fn('DISTINCT', models.sequelize.col('stockLocation')), 'stockLocation']
			],
			where: {
				AccountId,
				transaction: ['Remove', 'Retread Recd', 'Scrap Cancel', 'Scrap'],
				stockLocation: { [Op.and]: [{ [Op.ne]: "" }, { [Op.ne]: null }] }
			},
			raw: true
		});

		uniqueBranches = uniqueBranches.map(entry => entry.stockLocation);

		return res.send({ success: true, results: uniqueBranches });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, `Error fetching data`);
		return res.send({ success: false, error: 'Error fetching data.' });
	}
}

function capitalizeWords(str) {
	return str
		.toLowerCase() // Ensure all letters are lowercase first
		.split(' ') // Split words by space
		.map(word => word.charAt(0).toUpperCase() + word.slice(1)) // Capitalize first letter
		.join(' '); // Join words back
}

async function getOdoValidation(role, AccountId, tyre, odo, mf, isSpare) {
	const ROUTE = 'app/tyres/getOdoValidation';
	try {
		let inspectionWhere = {
			AssetId: tyre.Asset.id,
			type: 'v',
			AccountId: AccountId,
			date: { [Op.gt]: moment().subtract(72, 'hours').toISOString() }
		}

		let vehicleInspection = await models.Inspection.findOne({
			attributes: ['id', 'date', 'details', 'AssetId', 'ServiceBookingId'],
			where: inspectionWhere,
			order: [['date', 'desc']]
		});

		inspectionWhere.type = 'vd';
		if (vehicleInspection && vehicleInspection.date) {
			inspectionWhere.date = { [Op.gt]: moment(vehicleInspection.date).toISOString() }
		}
		let vehicleDraftInspection = await models.Inspection.findOne({
			attributes: ['id', 'details', 'AssetId', 'ServiceBookingId'],
			where: inspectionWhere,
			order: [['date', 'desc']]
		});

		if (vehicleDraftInspection) {
			vehicleInspection = vehicleDraftInspection;
		}

		let validateInspect = false;
		if (['AMCS FTE', 'AMCC FTE'].indexOf(role) > -1) {
			validateInspect = true;
		}
		if (isSpare || (mf && mf == 'true')) {
			validateInspect = false;
		}

		if (!vehicleInspection && validateInspect) {
			return { success: false, error: "Vehicle inspection not found. Please inspect vehicle before tyre inspection" };
		}

		if (validateInspect && vehicleInspection && moment().diff(vehicleInspection.date, 'h') > 72) { //Inspection window 72hrs
			return { success: false, error: "Vehicle inspection older than 72 hours. Please re-inspect" };
		}

		if (validateInspect && !vehicleInspection) { // fetch last vehicle draft inspecion for XE, DE
			delete inspectionWhere.date;
			inspectionWhere.type = ['vd', 'v'];
			vehicleInspection = await models.Inspection.findOne({
				attributes: ['id', 'date', 'details', 'AssetId', 'ServiceBookingId'],
				where: inspectionWhere,
				order: [['date', 'desc']]
			});
		}

		let odoValidation = true;
		if (vehicleInspection && vehicleInspection.details && (vehicleInspection.details.resetOdo || vehicleInspection.details.notOperOdo)) {
			odoValidation = false;
		}

		if (tyre.lastStatus && tyre.lastStatus.details) {
			tyre.lastStatus.details.notOperOdo = vehicleInspection && vehicleInspection.details && vehicleInspection.details.notOperOdo || false;
			tyre.lastStatus.details.resetOdo = vehicleInspection && vehicleInspection.details && vehicleInspection.details.resetOdo || false;
		}

		if (tyre.Asset && tyre.Asset.billingType == 'Apollo Fleet') {
			let assetOdo = tyre.Asset.odo;
			RaiseLogEvent(ROUTE, tyre.Asset.id, { inputOdo: odo, AssetOdo: assetOdo }, `Odo details for tyre before update in vehicle`);
			if (!tyre.Asset.imei && odoValidation && Number(assetOdo) > Number(odo)) {
				return { success: false, error: 'Odometer should be greater than previous inspection/vehicle odometer.' };
			}

			let updAsset = {};
			if (Number(odo) > Number(assetOdo)) {
				updAsset = await tyre.Asset.update({
					odo: Math.round(odo)
				});
			}

			if (updAsset) {
				RaiseLogEvent(ROUTE, tyre.Asset.id, { inputOdo: odo, AssetOdo: Math.round(odo) }, `Vehicle odo after update`);
			}
		}

		return { success: true }
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching tyre history.');
		return { success: false, error: 'Error fetching tyre history.' };
	}
}

exports.payKmList = async function (req, res) {
	const ROUTE = 'app/tyres/payKmList';
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
			type: 11, // Avolve Customers
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

		assetWhere.AccountId = Accounts.map(x => x.id);

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
				AssetId: Assets.map(x => x.id),
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
					status: avolveHelper.serviceStatusLookUp(matchedServices[0].status),
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
						status: avolveHelper.tyreStatusLookUp(parseInt(tyre.lastStatus && tyre.lastStatus.tyreStatus || '')),
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
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching assets.');
		return res.send({ success: false, error: 'Error fetching assets.' });
	}
}

exports.getRemoveReasons = async function (req, res) {
	const ROUTE = 'app/tyres/getRemoveReasons';
	try {
		if (!['AMCS FTE', 'AMCC FTE', 'XE FTE', 'ARSA', 'DE FTE'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not authorized' });
		}

		let SystemConfig = await models.SystemConfig.findOne({
			attributes: ['id', 'data'],
			where: {
				AccountId: res.locals.masterAccountId,
				module: 'Avolve',
				name: 'Tyre Masters'
			}
		});

		let results = [];
		if (SystemConfig && SystemConfig.data && Object.keys(SystemConfig.data).length) {
			results = SystemConfig.data.removeReasons || [];
		}

		return res.send({ success: true, results: results });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching remove reasons.');
		return res.send({ success: false, error: 'Error fetching remove reasons.' });
	}
}

exports.getWearPatterns = async function (req, res) {
	const ROUTE = 'app/tyres/getWearPatterns';
	try {
		if (!['AMCS FTE', 'AMCC FTE', 'XE FTE', 'ARSA', 'DE FTE'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not authorized' });
		}

		let SystemConfig = await models.SystemConfig.findOne({
			attributes: ['id', 'data'],
			where: {
				AccountId: res.locals.masterAccountId,
				module: 'Avolve',
				name: 'Tyre Masters'
			}
		});

		let results = [];
		if (SystemConfig && SystemConfig.data && Object.keys(SystemConfig.data).length) {
			results = SystemConfig.data.wearPatterns || [];
		}

		return res.send({ success: true, results: results });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching wear patterns.');
		return res.send({ success: false, error: 'Error fetching wear patterns.' });
	}
}

exports.getRemoveTypes = async function (req, res) {
	const ROUTE = 'app/tyres/getRemoveTypes';
	try {
		if (!['AMCS FTE', 'AMCC FTE', 'XE FTE', 'ARSA', 'DE FTE', 'FM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not authorized' });
		}

		let SystemConfig = await models.SystemConfig.findOne({
			attributes: ['id', 'data'],
			where: {
				AccountId: res.locals.masterAccountId,
				module: 'Avolve',
				name: 'Tyre Masters'
			}
		});

		let results = [];
		if (SystemConfig && SystemConfig.data && Object.keys(SystemConfig.data).length) {
			results = SystemConfig.data.removeTypes || [];
		}

		return res.send({ success: true, results: results });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching remove types.');
		return res.send({ success: false, error: 'Error fetching remove types.' });
	}
}

exports.getTyreScrapSurvey = async function (req, res) {
	const ROUTE = 'app/tyres/getTyreScrapSurvey';
	try {
		RaiseLogEvent(ROUTE, req.body.tyreIds, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		if (!['AMCS FTE', 'AMCC FTE', 'XE FTE', 'ARSA', 'DE FTE', 'FM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not authorized' });
		}

		if (!req.body.tyreIds || !req.body.tyreIds.length) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let Tyres = await models.Tyre.findAll({
			attributes: ['id', 'tyreNo', 'mfgBy', 'model', 'lastStatus', 'codeSize', 'AccountId'],
			include: [{
				attributes: [],
				model: models.Account,
				where: {
					AccountIdParent: res.locals.masterAccountId
				}
			}],
			where: {
				id: req.body.tyreIds
			},
			raw: true
		});

		if (!Tyres || !Tyres.length) {
			return res.send({ success: false, error: 'Tyres not found.' });
		}

		let TyreRetreads = await models.TyreRetread.findAll({
			attributes: ['id', 'details', 'tyreNo'],
			where: {
				tyreNo: Tyres.map(x => x.tyreNo),
				AccountId: Tyres.map(x => x.AccountId),
				status: 'scrap'
			},
			raw: true
		});

		let TyreScraps = await models.TyreScrap.findAll({
			attributes: ['id', 'tyreNo'],
			where: {
				tyreNo: Tyres.map(x => x.tyreNo),
				AccountId: Tyres.map(x => x.AccountId),
				status: 'Scrap'
			},
			raw: true
		});

		let SystemConfig = await models.SystemConfig.findOne({
			attributes: ['id', 'data'],
			where: {
				AccountId: res.locals.masterAccountId,
				module: 'Avolve',
				name: 'Tyre Masters'
			}
		});

		let result = { tyreData: [] };
		for (const Tyre of Tyres) {
			let matchedTyreRetread = TyreRetreads.find(x => x.tyreNo == Tyre.tyreNo) || {};
			let matchedTyreScrap = TyreScraps.find(x => x.tyreNo == Tyre.tyreNo) || {};
			let treadDepth = Tyre.lastStatus && (Tyre.lastStatus.treadDepth || Tyre.lastStatus.treadDepth == 0) ? Number(Tyre.lastStatus.treadDepth) : null;
			let depths = Tyre.lastStatus && Tyre.lastStatus.details && Tyre.lastStatus.details.grooves && Tyre.lastStatus.details.grooves.depths || {};
			let grooves = [];
			for (const key in depths) {
				grooves.push({
					label: `Groove ${key}`,
					depth: depths[key] && parseFloat(depths[key])
				});
			}
			Tyre.grooves = grooves;
			Tyre.treadDepth = treadDepth;
			delete Tyre.lastStatus;

			if (matchedTyreRetread && matchedTyreRetread.details && matchedTyreRetread.details.status == 2) {
				Tyre.retreadStatus = 'Retread Rejected';
			}
			Tyre.tyreScrapId = matchedTyreScrap && matchedTyreScrap.id || null;
			result.tyreData.push(Tyre);
		}

		if (SystemConfig && SystemConfig.data) {
			["scrapReasons", "failureAreas", "failureReasons"].forEach(x => {
				result[x] = SystemConfig.data[x] || [];
			});
		}

		return res.send({ success: true, result: result });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching tyre.');
		return res.send({ success: false, error: 'Error fetching tyre.' });
	}
}

exports.scrapSurvey = async function (req, res) {
	const ROUTE = 'app/tyres/scrapSurvey';
	try {
		RaiseLogEvent(ROUTE, req.body.tyreData, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		if (!['AMCS FTE', 'AMCC FTE', 'XE FTE', 'ARSA', 'DE FTE', 'FM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not authorized' });
		}

		if (!req.body.tyreData || (req.body.tyreData && !Object.keys(req.body.tyreData).length)) {
			return res.send({ success: false, error: 'Tyre data missing.' });
		}

		let tyreData = JSON.parse(req.body.tyreData);
		let tyreNumbers = tyreData.map(x => x.tyreNo);
		let scrapIds = [];
		for (const data of tyreData) {
			if (data.tyreScrapId) scrapIds.push(data.tyreScrapId);
			if (!data.tyreNo && !data.tyreScrapId) {
				return res.send({ success: false, error: `Input data missing.` });
			}
		}

		let AccountId = res.locals.AccountId;
		if (["XE FTE", "ARSA", "AMCC FTE"].includes(res.locals.role)) {
			AccountId = res.locals.accountIds;
		}

		let Tyres = await models.Tyre.findAll({
			where: {
				tyreNo: tyreNumbers,
				AccountId
			}
		});

		if (!Tyres || !Tyres.length) {
			return res.send({ success: false, error: 'Tyre not found.' });
		}

		//#region mandatory groove reduce check
		for (const tyre of Tyres) {
			const matchedInput = tyreData.find(x => x.tyreNo == tyre.tyreNo);
			const { details = {} } = tyre.lastStatus || {};
			if (matchedInput && matchedInput.grooves && Object.keys(matchedInput.grooves).length && matchedInput.grooves.depths && Object.keys(matchedInput.grooves.depths).length) {
				let validateGroove = true;
				for (const groove in matchedInput.grooves.depths) {
					let matchedDepth = details.grooves && details.grooves.depths && details.grooves.depths[groove] || '';
					if (Number(matchedDepth) && Number(matchedInput.grooves.depths[groove]) && Number(matchedInput.grooves.depths[groove]).toFixed(1) != Number(matchedDepth).toFixed(1)) {
						validateGroove = false;
						break;
					}
				}
				let isSpare = tyre.lastStatus && tyre.lastStatus.position && ["SP", "SP1", "SP2", "SP3", "SP4"].includes(tyre.lastStatus.position) || false;
				if (validateGroove && details && details.grooves && details.grooves.depths && !isSpare) {
					return res.send({ success: false, error: 'The Tyre NSD must be reduced by at least 0.1mm to complete the scrap survey.' });
				}
			}
		}
		//#endregion

		let SystemConfig = await models.SystemConfig.findOne({
			attributes: ['id', 'data'],
			where: {
				AccountId: res.locals.masterAccountId,
				module: 'Avolve',
				name: 'Tyre Masters'
			}
		});

		const scrapDetails = {
			status: 1 // Approved
		};
		let config = SystemConfig && SystemConfig.data || {};
		['failureReason', 'failureArea', 'scrapReason'].forEach(x => {
			let matchedValue = config[`${x}s`] && config[`${x}s`].find(item => item.id == req.body[`${x}Id`]);
			scrapDetails[x] = matchedValue || {};
		});

		var histDate = moment().toISOString();
		let imagesPush = [];
		await models.sequelize.transaction(async t => {
			let tyreScrapWhere = {
				tyreNo: { [Op.in]: tyreNumbers },
				AccountId
			}
			if (scrapIds && scrapIds.length) tyreScrapWhere.id = scrapIds;
			let [count, TyreScraps] = await models.TyreScrap.update({
				scrapDate: histDate,
				soldTo: req.body.soldTo || '',
				amount: !isNaN(req.body.amount) ? req.body.amount : 0,
				paymentMode: req.body.paymentMode || '',
				comments: req.body.comments || '',
				status: "Scrap Complete",
				details: scrapDetails
			}, {
				where: tyreScrapWhere,
				returning: true,
				transaction: t
			});

			if (count == 0) {
				TyreScraps = Tyres.map((tyre, index) => ({
					tyreNo: tyre.tyreNo,
					AccountId: tyre.AccountId,
					scrapDate: histDate,
					soldTo: req.body.soldTo || '',
					amount: !isNaN(req.body.amount) ? req.body.amount : 0,
					paymentMode: req.body.paymentMode || '',
					comments: req.body.comments || '',
					status: "Scrap Complete",
					details: scrapDetails,
				}));

				await models.TyreScrap.bulkCreate(TyreScraps, { transaction: t });
			}

			//#region Create Bulk Scrap Complete array
			let histBulk = []
			for (const tyreScrap of TyreScraps) {
				const matchedInput = tyreData.find(x => x.tyreNo == tyreScrap.tyreNo) || {};
				const matchedTyre = Tyres.find(x => x.tyreNo == tyreScrap.tyreNo) || {};

				//#region tyre image upload
				let tyreImgs = (req.files) && req.files.filter(files => {
					if (files.originalname && files.originalname.startsWith(`${matchedTyre.tyreNo}_${matchedTyre.id}`)) return files.originalname;
				}) || '';
				if (req.files && tyreImgs && tyreImgs.length) {
					imagesPush = imagesPush.concat(tyreImgs);
				}
				let imagePaths = tyreImgs.length > 0 ? tyreImgs.map(obj => {
					return '/' + md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/ScrapComplete_' + obj.filename;
				}).toString() : null;
				//#endregion

				let details = {};
				let { grooves, treadDepth } = avolveHelper.getGroovesWiseDepth(matchedInput.grooves, matchedTyre.lastStatus.treadDepth);
				details.grooves = Object.keys(grooves).length ? grooves : matchedTyre.lastStatus && matchedTyre.lastStatus.grooves || {};

				histBulk.push({
					tyreNo: tyreScrap.tyreNo,
					transaction: "Scrap Complete",
					histDate: histDate,
					condition: matchedTyre.lastStatus && matchedTyre.lastStatus.condition || "",
					treadDepth: treadDepth || matchedTyre.lastStatus.treadDepth || 0,
					tyreStatus: 6,
					inspectedBy: res.locals.inspectedBy,
					shopName: '',
					amount: matchedInput.amount || 0,
					tyreOdometer: matchedTyre.lastStatus.tyreOdometer,
					stockLocation: matchedTyre.lastStatus.stockLocation,
					AccountId: matchedTyre.AccountId,
					comments: req.body.comments || '',
					details: details,
					tyreImages: imagePaths
				});
				//#endregion
			}

			let tyreHistories = await models.TyreHistory.bulkCreate(histBulk, { returning: true, transaction: t })
			await Promise.all((Tyres || []).map(async (tyre) => {
				const histInstance = historyMap[tyre.tyreNo];
				if (!histInstance) return;
				const tyreHist = histInstance.get({ plain: true });
				tyre.set('condition', "Archived");
				tyre.set('tyreStatus', 6); //6-Scrap Complete
				tyre.set('lastStatus', { ...tyreHist });
				tyre.changed('lastStatus', true);
				tyre.set('AssetId', null);
				tyre.set('tpmsId', null);
				tyre.set('odometer', 0);
				tyre.set('installedOn', null);

				evt.events.emit('apl-reportlog', { //update scrap count in consumption summary
					AccountId: tyre.AccountId,
					reportValues: ['cs'],
					month: moment().format('MM'),
					year: moment().format('YYYY')
				});
				await tyre.save({ transaction: t });
			}));
		});

		for (const image of imagesPush) {
			if (image && image.path) {
				evt.events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(AccountId) + '/TyreTracker/' + new Date().getFullYear() + '/ScrapComplete_' + image.filename
				});
			}
		}

		return res.send({ success: true, result: [] });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', err, 'Error updating tyre scrap.');
		return res.send({ success: false, error: 'Error updating tyre scrap.' });
	}
}

exports.listCustom = async function (req, res) {
	const ROUTE = 'app/tyres/listCustom';
	try {
		if (!['Admin'].includes(res.locals.role)) {
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
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching tyres.');
		return res.send({ success: false, error: 'Error fetching tyres.' });
	}
}

exports.updateHistories = async function (req, res) {
	const ROUTE = 'app/tyres/updateHistories';
	try {
		RaiseLogEvent(ROUTE, req.body.tyreNo || res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

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
			attributes: ['id', 'date', 'AssetId', 'type',
				[models.Sequelize.json('"details"->\'resetOdo\''), 'resetOdo'],
				[models.Sequelize.json('"details"->\'notOperOdo\''), 'notOperOdo']],
			where: {
				type: ['v', 'vd', 't'],
				AccountId: req.body.AccountId,
				AssetId: [... new Set(assetIds)]
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
						remark = `The transaction date cannot be before the last vehicle inspection date (${moment(VehicleInspection.date).format('DD-MMM-YYYY hh:mm:ss A ')}).`;
						validateTyreHist = true;
					}
					if (TyreInspection && moment(currHist.histDate).isAfter(moment(TyreInspection.date))) {
						remark = `The transaction date cannot be after the last tyre inspection date (${moment(TyreInspection.date).format('DD-MMM-YYYY hh:mm:ss A')}).`;
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

				if (tyreHist.grooves && TyreHistory.details && TyreHistory.details.grooves && !avolveHelper.validateNestedObj(tyreHist.grooves, TyreHistory.details.grooves)) {
					updateHistById[tyreHist.id] = true;
					TyreHistory.details.grooves = tyreHist.grooves;
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
					where: { id: TyreHistory.id },
					silent: true
				});
			}

			let lastestHistory = TyreHistories.length - 1;
			for (let i = 1; i < TyreHistories.length; i++) {
				let TyreHistory = TyreHistories[i];
				let prevRec = TyreHistories[i - 1];
				let prevOdo = prevRec && prevRec.odometer && parseInt(prevRec.odometer) || 0;
				let currentOdo = TyreHistory.odometer && parseInt(TyreHistory.odometer) || 0;
				let prevTyreOdo = prevRec && prevRec.tyreOdometer && parseInt(prevRec.tyreOdometer) || 0;
				let currentTyreOdo = (prevTyreOdo) + (currentOdo - prevOdo);

				if (['Purchase', 'Retread Recd', 'Repair Recd'].indexOf(TyreHistory.transaction) > -1 || (prevRec && prevRec.transaction == 'Purchase')) {
					currentTyreOdo = 0;
				} else if (prevRec && ["SP", "SP1", "SP2", "SP3", "SP4"].indexOf(prevRec.position) > -1) {
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
				if (prevRec && TyreHistory.AssetId && prevRec.AssetId && (TyreHistory.AssetId == prevRec.AssetId)) {// Asset odo decrease
					VehicleInspection = Inspections.find(x => ['v', 'vd'].includes(x.type) && x.AssetId == TyreHistory.AssetId && moment(x.date).isSameOrBefore(moment(TyreHistory.histDate), 'day'));
					if (VehicleInspection && VehicleInspection.type == 'v' && TyreHistory.transaction == 'Inspect') {
						TyreInspection = Inspections.find(x => x.type == 't' && x.AssetId == TyreHistory.AssetId && moment(VehicleInspection.date).isSameOrAfter(moment(x.date), 'day'));
					}
					if (prevOdo > currentOdo) {
						if (!VehicleInspection) {
							RaiseLogEvent('rmq-avolve-tyreodo-recalc-update', data.tyreNo, data, 'Tyre odo recalc ignored due to mismatch in vehicle odo.');
							throw new Error('Tyre odo recalc ignored due to mismatch in vehicle odo.');
						}
						VehicleInspection = JSON.parse(JSON.stringify(VehicleInspection));
						if (VehicleInspection.resetOdo == true) {
							currentTyreOdo = prevTyreOdo + TyreHistory.odometer;
						}
						if (VehicleInspection.notOperOdo == true) {
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
					await TyreHistory.update({
						tyreOdometer: currentTyreOdo
					}, {
						transaction: t
					}, {
						silent: true
					});

					if (lastestHistory == i) {
						let lastStatus = JSON.parse(JSON.stringify(Tyre.lastStatus));
						lastStatus.tyreOdometer = currentTyreOdo;
						lastStatus.odometer = currentOdo;
						let lastWorkDone = JSON.parse(JSON.stringify(Tyre.lastWorkDone));
						let transaction = (lastStatus.transaction == 'Inspect') ? 'Inspection' : lastStatus.transaction;
						if (lastWorkDone[transaction]) {
							lastWorkDone.date = lastStatus.histDate;
							lastWorkDone.tyreOdometer = lastStatus.tyreOdometer;
						}
						await Tyre.update({
							lastStatus: lastStatus,
							tyreOdo: currentTyreOdo,
							odometer: currentOdo,
							lastWorkDone: lastWorkDone
						}, {
							transaction: t
						}, {
							silent: true
						});
					}
				}
			}
		});

		for (const inspectionId in updateInspection) {
			if (!updateInspection[inspectionId] || !Object.keys(updateInspection[inspectionId]).length) {
				continue;
			}
			evt.events.emit('avolve-inspection-odometer-correction', updateInspection[inspectionId]);
		}
		evt.events.emit('tyre-cpkm-refresh', { tyreNo: Tyre.tyreNo, AccountId: Tyre.AccountId });

		return res.send({ success: true });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, `Error updating tyre history data.`);
		return res.send({ success: false, error: 'Error updating tyre history data.' });
	}
}

exports.listWeb = async function (req, res) {
	const ROUTE = 'app/tyres/listWeb';
	try {
		let accountIds = avolveHelper.getAccountIdByRole(res.locals, req.query, false);
		const queryOptions = {
			where: {
				AccountId: accountIds
			}
		};

		if (req.query.status) {
			queryOptions.where.tyreStatus = req.query.status;
		}

		if (req.query.limit && req.query.limit != -1) {
			let page = parseInt(req.query.page) || 1;
			let limit = parseInt(req.query.limit) || 40;
			queryOptions.limit = limit;
			queryOptions.offset = (page - 1) * limit;
		}

		if (req.query.isMfTyre && JSON.parse(req.query.isMfTyre)) {
			queryOptions.where["details.mf"] = true;
		}

		let Tyres = await models.Tyre.findAll({
			...{
				attributes: ['id', 'lastStatus', 'tyreNo', 'mfgBy', 'model', 'codeSize', 'AssetId', 'rfid', 'tpmsData', 'details'],
				include: [{
					attributes: ['id', 'lplate'],
					model: models.Asset
				}]
			},
			...queryOptions
		});

		let TyresInScrap = await models.TyreScrap.findAll({
			where: {
				AccountId: AccountId,
				status: 'Scrap'
			}
		});

		let TyresInScrapMap = {};
		for (const tyreScrap of TyresInScrap) {
			TyresInScrapMap[tyreScrap.tyreNo] = tyreScrap;
		}

		let results = [];
		let retreadList = []
		if (req.query.status == 3) { //Retreading
			let retreadResult = await getTyresInRetread(Tyres.map(x => x.tyreNo), AccountId, 'sent');
			if (retreadResult.success && retreadResult.results && retreadResult.results.length) {
				retreadList = retreadResult.results;
			}
		}

		for (const Tyre of Tyres) {
			let { lastStatus } = Tyre;
			let matchedTyreInScrap = TyresInScrapMap[Tyre.tyreNo] || {};
			let retread = {};
			if (req.query.status == 3) { //Retreading
				retread = retreadList.find(x => x.tyreNo == Tyre.tyreNo);
			}
			let depth = lastStatus && (lastStatus.treadDepth || lastStatus.treadDepth == 0) ? lastStatus.treadDepth.toString() : '';
			results.push({
				id: Tyre.id,
				tyreNo: Tyre.tyreNo,
				tyreOdo: lastStatus && lastStatus.tyreOdometer && Math.round(parseInt(lastStatus.tyreOdometer) / 1000).toString() || '',
				depth: depth,
				position: lastStatus && lastStatus.position || '',
				transaction: lastStatus && lastStatus.transaction || '',
				make: Tyre.mfgBy || '',
				model: Tyre.model || '',
				codeSize: Tyre.codeSize,
				rfId: Tyre.rfid,
				tpmsId: Tyre.tpmsData && Tyre.tpmsData.TPID || '',
				AssetId: Tyre.AssetId,
				lplate: Tyre.Asset && Tyre.Asset.lplate || '',
				dealer: retread && retread.rtdCompany || '',
				tyreScrapId: matchedTyreInScrap && matchedTyreInScrap.id || null,
				tyreRetreadId: retread && retread.id || null,
				isMfTyre: Tyre.details && Tyre.details.mf || false
			});
		}

		return res.send({ success: true, results: results });
	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching tyres.');
		return res.send({ success: false, error: 'Error fetching tyres.' });
	}
}

exports.updateWeb = function (req, res) {
	const ROUTE = 'app/tyres/updateWeb';
	RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

	var where = {};
	where.tyreNo = req.params.tyreNo;
	where.AccountId = res.locals.AccountId;
	if (req.body.field == 'tyreNo') {
		where.tyreNo = req.body.fingerprintValue;
	}
	models.Tyre.findOne({
		where: where
	})
		.then(function (tyre) {
			if (!tyre) {
				return res.send({ success: false, message: "Tyre not found." });
			}

			tyre[req.body.field] = req.body.value;

			if (req.body.field == 'modelPropsMeta') {
				tyre.codeSize = req.body.value.split('-')[0];
				tyre.loadIndex = req.body.value.split('-')[1];
				tyre.speedRating = req.body.value.split('-')[2];
			} else if (req.body.field == 'mfgDate') {
				tyre.mfgDate = moment(req.body.value, "DD/MM/YYYY");
			} else if (req.body.field == 'radial') {
				tyre.radial = tyre.radial == "YES" ? true : false;
			} else if (req.body.field == 'tubeStatus') {
				tyre.tubeStatus = tyre.tubeStatus == "YES" ? true : false;
			} else if (req.body.field == 'flapStatus') {
				tyre.flapStatus = tyre.flapStatus == "YES" ? true : false;
			} else if (req.body.field == 'purchasedOn') {
				tyre.purchasedOn = moment(req.body.value, "DD/MM/YYYY");
			} else if (req.body.field == 'rfid') {
				tyre.rfid = req.body.value ? req.body.value : null;
			}

			var response;
			return models.sequelize.transaction(t => {
				if (req.body.field != 'tyreNo') {
					return tyre.save({ transaction: t })
						.then(function (tyre) {
							response = tyre
						})
				} else {
					return tyre.save({ transaction: t })
						.then(function (update) {
							response = update
							return models.TyreHistory
								.update(
									{ tyreNo: req.body.value },
									{ where: { tyreNo: req.body.fingerprintValue }, transaction: t }
								).then(function (update) {
									return models.TyreScrap
										.update(
											{ tyreNo: req.body.value },
											{ where: { tyreNo: req.body.fingerprintValue }, transaction: t }
										).then(function (update) {
											return models.TyreRetread
												.update(
													{ tyreNo: req.body.value },
													{ where: { tyreNo: req.body.fingerprintValue }, transaction: t }
												)
										})

								})
						})
				}
			}).then(result => {
				return res.send({ success: true, tyre: response });
			}).catch(err => {
				return res.send({ success: false, error: err.message, debug: err.stack });
			});

		})
		.catch(err => {
			res.send({ success: false, message: err.message });
		})

};

exports.tyreAnalysis = function (req, res) {
	return res.send({
		success: true, tyreAnalysis:
			{ "harsh_acc": "20", "harsh_braken": "20", "start/stop": "20", "road_type": { "up_hill": "20", "down_hill": "20", "plain": "20", "roads": [{ "color": "#fed376", "data": "6", "text": "NH" }, { "color": "#f8b42d", "data": "20", "text": "SH" }, { "color": "#8ed72b", "data": "31", "text": "Muddy" }, { "color": "#5aa3e8", "data": "43", "text": "Other" }] }, "idle": [{ "text": "Idle", "hrs": "350", "data": "20", "color": "#8ed72b" }, { "text": "Move", "hrs": "1234", "data": "80", "color": "#5aa3e8" }], "load": [{ "text": "Load", "kms": "5635", "data": "75", "color": "#8ed72b" }, { "text": "Empty", "kms": "800", "data": "25", "color": "#5aa3e8" }], "speed_distribution": [{ "data": [[0, 0]], "color": "#d73027" }, { "data": [[1, 0]], "color": "#db392b" }, { "data": [[2, 0]], "color": "#e0422f" }, { "data": [[3, 0]], "color": "#e44c34" }, { "data": [[4, 1]], "color": "#e95538" }, { "data": [[5, 0]], "color": "#ed5f3c" }, { "data": [[6, 0]], "color": "#f26841" }, { "data": [[7, 19]], "color": "#f47245" }, { "data": [[8, 26]], "color": "#f67c4a" }, { "data": [[9, 20]], "color": "#f7874f" }, { "data": [[10, 17]], "color": "#f99153" }, { "data": [[11, 16]], "color": "#fa9b58" }, { "data": [[12, 24]], "color": "#fba55d" }, { "data": [[14, 20]], "color": "#fdaf61" }, { "data": [[14, 26]], "color": "#fdb668" }, { "data": [[15, 22]], "color": "#fdbe6f" }, { "data": [[16, 19]], "color": "#fdc675" }, { "data": [[17, 22]], "color": "#fdce7c" }, { "data": [[18, 26]], "color": "#fdd682" }, { "data": [[19, 28]], "color": "#fddd89" }, { "data": [[20, 35]], "color": "#f9e18b" }, { "data": [[21, 32]], "color": "#f4e48b" }, { "data": [[22, 33]], "color": "#eee68b" }, { "data": [[23, 35]], "color": "#e8e88b" }, { "data": [[24, 34]], "color": "#e2eb8b" }, { "data": [[25, 24]], "color": "#dded8b" }, { "data": [[26, 45]], "color": "#d6ee89" }, { "data": [[27, 33]], "color": "#ceea84" }, { "data": [[28, 33]], "color": "#c6e77f" }, { "data": [[29, 42]], "color": "#bee37a" }, { "data": [[30, 46]], "color": "#b7e075" }, { "data": [[31, 46]], "color": "#afdc6f" }, { "data": [[32, 82]], "color": "#a7d96a" }, { "data": [[33, 63]], "color": "#9dd569" }, { "data": [[34, 86]], "color": "#93d067" }, { "data": [[35, 72]], "color": "#89cc66" }, { "data": [[36, 113]], "color": "#7fc865" }, { "data": [[37, 177]], "color": "#75c364" }, { "data": [[38, 260]], "color": "#6bbf63" }, { "data": [[39, 280]], "color": "#60ba61" }, { "data": [[40, 414]], "color": "#55b45e" }, { "data": [[41, 458]], "color": "#49af5b" }, { "data": [[42, 485]], "color": "#3da958" }, { "data": [[43, 498]], "color": "#31a355" }, { "data": [[44, 517]], "color": "#259d52" }, { "data": [[45, 364]], "color": "#1a9850" }, { "data": [[46, 265]], "color": "#31a355" }, { "data": [[47, 226]], "color": "#49af5b" }, { "data": [[48, 167]], "color": "#60ba61" }, { "data": [[49, 110]], "color": "#75c364" }, { "data": [[50, 59]], "color": "#89cc66" }, { "data": [[51, 68]], "color": "#9dd569" }, { "data": [[52, 56]], "color": "#afdc6f" }, { "data": [[53, 34]], "color": "#bee37a" }, { "data": [[54, 36]], "color": "#ceea84" }, { "data": [[55, 27]], "color": "#dded8b" }, { "data": [[56, 14]], "color": "#e8e88b" }, { "data": [[57, 10]], "color": "#f4e48b" }, { "data": [[58, 17]], "color": "#fddd89" }, { "data": [[59, 8]], "color": "#fdce7c" }, { "data": [[60, 8]], "color": "#fdbe6f" }, { "data": [[61, 8]], "color": "#fdaf61" }, { "data": [[62, 1]], "color": "#fa9b58" }, { "data": [[63, 4]], "color": "#f7874f" }, { "data": [[64, 11]], "color": "#f47245" }, { "data": [[65, 10]], "color": "#ed5f3c" }, { "data": [[66, 3]], "color": "#e44c34" }, { "data": [[67, 5]], "color": "#db392b" }, { "data": [[68, 4]], "color": "#d73027" }, { "data": [[69, 3]], "color": "#d73027" }, { "data": [[70, 2]], "color": "#d73027" }, { "data": [[71, 6]], "color": "#d73027" }, { "data": [[72, 1]], "color": "#d73027" }, { "data": [[73, 0]], "color": "#d73027" }, { "data": [[74, 2]], "color": "#d73027" }, { "data": [[75, 2]], "color": "#d73027" }, { "data": [[76, 1]], "color": "#d73027" }, { "data": [[77, 2]], "color": "#d73027" }], "psi_distribution": [{ "data": [[0, 0]], "color": "#d73027" }, { "data": [[1, 0]], "color": "#db392b" }, { "data": [[2, 0]], "color": "#e0422f" }, { "data": [[3, 0]], "color": "#e44c34" }, { "data": [[4, 1]], "color": "#e95538" }, { "data": [[5, 0]], "color": "#ed5f3c" }, { "data": [[6, 0]], "color": "#f26841" }, { "data": [[7, 19]], "color": "#f47245" }, { "data": [[8, 26]], "color": "#f67c4a" }, { "data": [[9, 20]], "color": "#f7874f" }, { "data": [[10, 17]], "color": "#f99153" }, { "data": [[11, 16]], "color": "#fa9b58" }, { "data": [[12, 24]], "color": "#fba55d" }, { "data": [[13, 20]], "color": "#fdaf61" }, { "data": [[14, 26]], "color": "#fdb668" }, { "data": [[15, 22]], "color": "#fdbe6f" }, { "data": [[16, 19]], "color": "#fdc675" }, { "data": [[17, 22]], "color": "#fdce7c" }, { "data": [[18, 26]], "color": "#fdd682" }, { "data": [[19, 28]], "color": "#fddd89" }, { "data": [[20, 35]], "color": "#f9e18b" }, { "data": [[21, 32]], "color": "#f4e48b" }, { "data": [[22, 33]], "color": "#eee68b" }, { "data": [[23, 35]], "color": "#e8e88b" }, { "data": [[24, 34]], "color": "#e2eb8b" }, { "data": [[25, 24]], "color": "#dded8b" }, { "data": [[26, 45]], "color": "#d6ee89" }, { "data": [[27, 33]], "color": "#ceea84" }, { "data": [[28, 33]], "color": "#c6e77f" }, { "data": [[29, 42]], "color": "#bee37a" }, { "data": [[30, 46]], "color": "#b7e075" }, { "data": [[31, 46]], "color": "#afdc6f" }, { "data": [[32, 82]], "color": "#a7d96a" }, { "data": [[33, 63]], "color": "#9dd569" }, { "data": [[34, 86]], "color": "#93d067" }, { "data": [[35, 72]], "color": "#89cc66" }, { "data": [[36, 113]], "color": "#7fc865" }, { "data": [[37, 177]], "color": "#75c364" }, { "data": [[38, 260]], "color": "#6bbf63" }, { "data": [[39, 280]], "color": "#60ba61" }, { "data": [[40, 414]], "color": "#55b45e" }, { "data": [[41, 461]], "color": "#49af5b" }, { "data": [[42, 503]], "color": "#3da958" }, { "data": [[43, 528]], "color": "#31a355" }, { "data": [[44, 543]], "color": "#259d52" }, { "data": [[45, 384]], "color": "#1a9850" }, { "data": [[46, 276]], "color": "#31a355" }, { "data": [[47, 228]], "color": "#49af5b" }, { "data": [[48, 168]], "color": "#60ba61" }, { "data": [[49, 111]], "color": "#75c364" }, { "data": [[50, 60]], "color": "#89cc66" }, { "data": [[51, 69]], "color": "#9dd569" }, { "data": [[52, 56]], "color": "#afdc6f" }, { "data": [[53, 35]], "color": "#bee37a" }, { "data": [[54, 36]], "color": "#ceea84" }, { "data": [[55, 27]], "color": "#dded8b" }, { "data": [[56, 14]], "color": "#e8e88b" }, { "data": [[57, 10]], "color": "#f4e48b" }, { "data": [[58, 17]], "color": "#fddd89" }, { "data": [[59, 8]], "color": "#fdce7c" }, { "data": [[60, 8]], "color": "#fdbe6f" }, { "data": [[61, 8]], "color": "#fdaf61" }, { "data": [[62, 1]], "color": "#fa9b58" }, { "data": [[63, 4]], "color": "#f7874f" }, { "data": [[64, 11]], "color": "#f47245" }, { "data": [[65, 10]], "color": "#ed5f3c" }, { "data": [[66, 3]], "color": "#e44c34" }, { "data": [[67, 5]], "color": "#db392b" }, { "data": [[68, 4]], "color": "#d73027" }, { "data": [[69, 3]], "color": "#d73027" }, { "data": [[70, 2]], "color": "#d73027" }, { "data": [[71, 6]], "color": "#d73027" }, { "data": [[72, 1]], "color": "#d73027" }, { "data": [[73, 0]], "color": "#d73027" }, { "data": [[74, 2]], "color": "#d73027" }, { "data": [[75, 2]], "color": "#d73027" }, { "data": [[76, 1]], "color": "#d73027" }, { "data": [[77, 2]], "color": "#d73027" }], "load_type": [{ "name": "Wood", "data": "20" }, { "name": "Household goods", "data": "18" }, { "name": "Machinery", "data": "32" }, { "name": "electronics", "data": "20" }] }
	});
}

exports.getReminders = async function (req, res) {
	const ROUTE = 'app/tyres/getReminders';
	try {
		RaiseLogEvent(ROUTE, 'log', req.query, `res.locals: ${JSON.stringify(res.locals)}`);
		if (req.query.AssetId && isNaN(req.query.AssetId)) {
			return res.send({ success: false, error: "Invalid inputs found" })
		}
		let whereClause = {
			AccountId: res.locals.AccountId
		}
		if (req.query.AssetId) {
			whereClause.AssetId = req.query.AssetId;
		}
		let Tyres = await models.Tyre.findAll({
			include: [{
				model: models.Asset,
				attributes: ["id", "lplate", "odo", "engineHrs", "axleConfig"]
			}],
			where: whereClause
		});
		if (!Tyres.length) {
			return res.status(412).send({ success: false, error: "No Tyres found", message: "No Tyres found." });
		}

		let Schedules = await models.VehicleServiceSchedule.findAll({
			include: [{
				model: models.VehicleServiceType,
				where: { componentName: 'Wheel & Tyres' }
			}, {
				model: models.Asset,
				attributes: ['id', 'lplate', 'odo']
			}],
			where: whereClause
		});

		var AssetIds = [...new Set(Schedules.map(x => x.AssetId))];
		var serviceTypeMap = [
			{ serviceName: 'Tyre Rotation', transaction: 'Rotation', component: 'Wheel & Tyres' },
			{ serviceName: 'Tyre Air Checkup', transaction: 'Inspection', component: 'Wheel & Tyres' },
			{ serviceName: 'Wheel Alignment - All Wheel', transaction: 'Alignment', component: 'Wheel & Tyres' },
		];
		var reminders = [];
		AssetIds.map(AssetId => {
			var reminder = [];
			var assetTyres = Tyres.filter(x => x.AssetId == AssetId);
			var assetSchedules = Schedules.filter(x => x.AssetId == AssetId);
			assetTyres.map(Tyre => {
				transactions = [];
				assetSchedules.filter(schedule => {
					var transformedServiceType = serviceTypeMap.find(x => x.serviceName == schedule.VehicleServiceType.serviceName);
					var tyreTransaction = Tyre.lastWorkDone[transformedServiceType ? transformedServiceType.transaction : null];
					if (tyreTransaction && assetSchedules[0] && assetSchedules[0].Asset) {
						var odo = assetSchedules[0].Asset.odo - (tyreTransaction.tyreOdometer ? tyreTransaction.tyreOdometer : 0);
						if (schedule.frequencyInKm && tyreTransaction.nextService && tyreTransaction.nextService - odo <= (schedule.alertThresholdInKm * 1000)) {
							transactions.push({
								transaction: serviceTypeMap.find(x => x.serviceName == schedule.VehicleServiceType.serviceName).transaction,
							})
						}
					}
				})
				if (transactions.length) {
					reminder.push({
						tyreNo: Tyre.tyreNo,
						tyreId: Tyre.id,
						AssetId: Tyre.AssetId,
						transactions: transactions
					})
				}
			})
			if (reminder.length) {
				reminders.push({
					AssetId: AssetId,
					reminders: reminder
				})
			}
		})
		return res.send({ success: true, tyreReminders: reminders });

	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, "Error in fetching tyres.");
		res.send({ success: false, error: "Error in fetching tyres." });
	}
}

exports.bulkCreateByFile = async function (req, res) {
	const ROUTE = 'app/tyres/bulkCreateByFile';
	try {
		if (!req.file) {
			return res.send({ success: false, error: 'file not found' });
		}

		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.username}`);

		var workbook = new Excel.Workbook();
		var excelData = [];
		await workbook.xlsx.readFile(req.file.path);

		if (!workbook || !workbook.worksheets || !workbook.worksheets.length) {
			return res.send({ success: false, error: 'No sheets found' });
		}

		const worksheet = workbook.worksheets[0];
		worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
			if (row.values.length && rowNumber != 1 && row.values[1] && row.values[1].toString().trim().length > 5) {
				excelData.push({
					tyreNo: row.values[1] ? row.values[1].toString().replace(/\s/g, "").replace(/[^\w\s]/gi, '') : null,
					mfgBy: row.values[2] ? row.values[2].trim() : null,
					model: row.values[3] ? row.values[3].trim() : null,
					condition: row.values[4] ? row.values[4].trim() : '',
					initialTreadDepth: row.values[5] ? row.values[5] : null,
					currentTreadDepth: row.values[6] ? row.values[6] : null,
					amount: row.values[7] ? row.values[7] : 0,
					vehicle: row.values[8] ? row.values[8] : null,
					position: row.values[9] ? row.values[9] : null,
					recomPosn: row.values[10] ? row.values[10] : '',
					installedOn: row.values[11] ?
						(moment(row.values[11], "DD/MM/YYYY").isValid() ? moment(row.values[11], "DD/MM/YYYY") : moment())
						: (row.values[8] ? moment() : null),
					codeSize: row.values[12] ? row.values[12].toString().trim() : 0,
					loadIndex: row.values[13] ? row.values[13] : 0,
					speedRating: row.values[13] ? row.values[13] : 0,
					mfgDate: row.values[15] ?
						(moment(row.values[15], "DD/MM/YYYY").isValid() ? moment(row.values[15], "DD/MM/YYYY") : null) : null,
					treadPattern: row.values[16] ? row.values[16].trim() : null,
					radial: row.values[17] == "Yes" ? true : false,
					tubeStatus: row.values[18] == "Yes" ? true : false,
					flapStatus: row.values[19] == "Yes" ? true : false,
					billNumber: row.values[20] ? row.values[19] : null,
					purchasedOn: row.values[21] ?
						(moment(row.values[21], "DD/MM/YYYY").isValid() ? moment(row.values[21], "DD/MM/YYYY") : null) : null,
					purchasedFrom: row.values[22] ? row.values[22].trim() : null,
					paymentMode: row.values[23] ? row.values[23] : null,
					comments: row.values[24] ? row.values[24] : null,
					AccountId: res.locals.AccountId,
					branchName: row.values[25] ? row.values[25].trim() : null,
					rfid: row.values[26] ? row.values[26] : null,
					odometer: row.values[27] && !isNaN(row.values[27]) ? (Math.round(row.values[27]) * 1000) : 0,
					remarks: ''
				});
			}
		});

		fs.unlink(req.file.path, (err) => { if (err) console.log(err) });

		const axlePositions = tyreAxlePositions.axlePositions;

		//#region Check for duplicates in excel
		const tyreNumbers = excelData.map(x => x.tyreNo);
		const duplicates = tyreNumbers.filter((item, index) => tyreNumbers.indexOf(item) != index);
		if (duplicates.length > 0) {
			return res.send({
				success: false,
				error: `Duplicate tyres found in the sheet : ${[...new Set(duplicates)]}`
			});
		}
		//#endregion

		const tyreIndex = await models.Tyre.findAll({
			attributes: ["tyreNo", "lastStatus", "deletedAt", "AssetId", "AccountId"],
			where: { AccountId: res.locals.AccountId },
			paranoid: false
		});


		const assets = await models.Asset.findAll({
			attributes: ['id', 'lplate', 'odo'],
			where: { AccountId: res.locals.AccountId }
		});


		const branches = await models.Branch.findAll({
			attributes: ['id', 'name', 'tyreMinMax', 'AccountId'],
			where: { AccountId: res.locals.AccountId }
		});

		const tyreStocks = await models.Tyre.findAll({
			attributes: [
				"BranchId",
				[models.Sequelize.fn('COUNT', models.Sequelize.col('BranchId')), 'tyreCount']
			],
			group: ['BranchId'],
			where: { AccountId: res.locals.AccountId, AssetId: null },
			raw: true
		});

		var branchResult = branches;

		var invalidTyreInfo = [],
			duplicateTyreInfo = [],
			tyreInfoTocreate = [],
			previewTyres = [];
		var isMandatory = false,
			isDuplicateAxle = false;
		var axleMap = {};
		var errMsg = '';

		for (let i = 0; i < excelData.length; i++) {
			if (!excelData[i].tyreNo || !excelData[i].mfgBy || !excelData[i].model ||
				!excelData[i].condition || !excelData[i].initialTreadDepth ||
				!excelData[i].amount
			) {
				isMandatory = true;
				errMsg = "Please fill all the required fields and try again.";
				break;
			}

			if (['New', 'Used', 'Retread 1', 'Retread 2', 'Retread 3'].indexOf(excelData[i].condition) == -1) {
				excelData[i].remarks = 'Invalid tyre condition.';
				invalidTyreInfo.push(excelData[i]);
			} else if (excelData[i].condition == 'New' && excelData[i].vehicle) {
				excelData[i].remarks = `Invalid tyre condition when assigned to the vehicle.`;
				invalidTyreInfo.push(excelData[i]);
			} else if (excelData[i].condition == 'Used' && !excelData[i].vehicle) {
				excelData[i].remarks = 'Vehicle missing for tyre condition - Used.';
				invalidTyreInfo.push(excelData[i]);
			} else if (excelData[i].initialTreadDepth && isNaN(excelData[i].initialTreadDepth)) {
				excelData[i].remarks = 'Invalid initial tread depth.';
				invalidTyreInfo.push(excelData[i]);
			} else if (excelData[i].currentTreadDepth && isNaN(excelData[i].currentTreadDepth)) {
				excelData[i].remarks = 'Invalid current tread depth.';
				invalidTyreInfo.push(excelData[i]);
			} else if (!excelData[i].vehicle && excelData[i].position) {
				excelData[i].remarks = 'Vehicle missing for provided axle position.';
			} else if (excelData[i].vehicle && !excelData[i].position) {
				excelData[i].remarks = `Axle position missing for this vehicle.`;
				invalidTyreInfo.push(excelData[i]);
			} else if (excelData[i].installedOn && !excelData[i].purchasedOn) {
				excelData[i].remarks = 'Purchased date mandatory for tyre assigned in vehicle.'
				invalidTyreInfo.push(excelData[i]);
			} else if (excelData[i].installedOn &&
				moment(excelData[i].purchasedOn).format() > moment(excelData[i].installedOn).format()
			) {
				excelData[i].remarks = 'Installation date should be greather than the purchased date.';
				invalidTyreInfo.push(excelData[i]);
			} else {
				let isDuplicate = tyreIndex.find(x => x.tyreNo == excelData[i].tyreNo) || '';
				if (isDuplicate) {
					if (isDuplicate.deletedAt) {
						excelData[i].remarks = 'Tyre soft deleted. Can be restored if needed.';
					} else {
						excelData[i].remarks = 'Tyre already exists.';
					}
					duplicateTyreInfo.push(excelData[i]);
				} else if (excelData[i].tyreNo.length > 150 || excelData[i].mfgBy.length > 100
					|| excelData[i].model.length > 100 ||
					(excelData[i].treadPattern && excelData[i].treadPattern.length > 10) ||
					(excelData[i].codeSize && excelData[i].codeSize.length > 50)
				) {
					if (excelData[i].tyreNo.length > 150 || excelData[i].mfgBy.length > 100
						|| excelData[i].model.length > 100) {
						excelData[i].remarks = 'TyreNo / MfgBy / Model limit exceeds.';
					} else if (excelData[i].treadPattern && excelData[i].treadPattern.length > 10) {
						excelData[i].remarks = 'Tread Pattern limit exceeds.';
					} else if (excelData[i].codeSize && excelData[i].codeSize.length > 50) {
						excelData[i].remarks = 'Code Size limit exceeds.';
					}
					invalidTyreInfo.push(excelData[i]);
				} else if (res.locals.AccountId == 491 &&
					(!excelData[i].purchasedFrom || !excelData[i].billNumber)
				) {
					excelData[i].remarks = 'Bill No / Purchased date missing.';
					invalidTyreInfo.push(excelData[i]);
				} else {
					let vehicle;
					let rejectTyre = false;
					if (excelData[i].vehicle && excelData[i].position) {
						let axleKey = excelData[i].vehicle.replace(/\s+/g, "").toLowerCase() + '-' + excelData[i].position;
						if (axleMap[axleKey] == true) {
							let matchedTyre = excelData.find(x => x.vehicle == excelData[i].vehicle &&
								x.position == excelData[i].position && x.tyreNo != excelData[i].tyreNo) || {};
							if (matchedTyre && matchedTyre.tyreNo) {
								isDuplicateAxle = true;
								errMsg = `Tyres ${excelData[i].tyreNo}, ${matchedTyre.tyreNo} from the sheet already exists in same vehicle position.`;
								break;
							}
						}
						axleMap[axleKey] = true;
						vehicle = assets.find(x => x.lplate.replace(/\s+/g, "").toLowerCase() == excelData[i].vehicle.replace(/\s+/g, "").toLowerCase());
						if (vehicle && axlePositions.indexOf(excelData[i].position) > -1) {
							let assetTyres = tyreIndex.filter(x => x.AssetId == vehicle.id && x.deletedAt == null);
							let existPosition = assetTyres.find(x => x.lastStatus && x.lastStatus.position == excelData[i].position || '');
							if (!existPosition) {
								excelData[i].AssetId = vehicle.id;
								excelData[i].vehicle = vehicle.lplate;
								excelData[i].odo = vehicle.odo;
								excelData[i].tyreStatus = 1; //1-In Use
							} else {
								rejectTyre = true;
								excelData[i].remarks = `Tyre ${existPosition.tyreNo} already exists in the position.`;
								invalidTyreInfo.push(excelData[i]);
							}
						} else {
							if (['Retread 1', 'Retread 2', 'Retread 3'].indexOf(excelData[i].condition) > -1) {
								rejectTyre = true;
								if (!vehicle) {
									excelData[i].remarks = 'Vehicle not found in KTT. Rejecting record.';
								} else {
									excelData[i].remarks = 'Invalid axle position. Rejecting record.';
								}
								invalidTyreInfo.push(excelData[i]);
							} else {
								excelData[i].vehicle = null;
								excelData[i].position = null;
								excelData[i].installedOn = null;
								excelData[i].tyreStatus = 0; //1-In Stock
								excelData[i].condition = 'New';
								if (!vehicle) {
									excelData[i].remarks = 'Vehicle not found in KTT. Good to go!';
								} else {
									excelData[i].remarks = 'Invalid axle position. Good to go!';
								}
							}
						}
					} else {
						if (excelData[i].condition == 'New') {
							excelData[i].tyreStatus = 0; //1-In Stock
						} else {
							excelData[i].tyreStatus = 4; //4-Retreaded
						}
					}

					let branch;
					if (excelData[i].branchName) {
						branch = branchResult.find(x => x.name.replace(/\s+/g, "").toLowerCase() == excelData[i].branchName.replace(/\s+/g, "").toLowerCase());
						if (branch) {
							excelData[i].BranchId = branch.id;
							excelData[i].branchName = branch.name;
						} else {
							excelData[i].BranchId = null;
							excelData[i].branchName = "";
							excelData[i].remarks = 'Branch not found in KTT. Good to go!'
						}
					}
					if (res.locals.AccountId == 2826) {
						excelData[i].details = { recomPosn: excelData[i].recomPosn || '' };
					}

					if (!rejectTyre) {
						excelData[i].installedOn = excelData[i].installedOn && moment(excelData[i].installedOn, 'DD/MM/YYYY').toISOString() || null;
						excelData[i].purchasedOn = excelData[i].purchasedOn && moment(excelData[i].purchasedOn, 'DD/MM/YYYY').toISOString() || null;
						tyreInfoTocreate.push(excelData[i]);
					}
				}
			}
			previewTyres.push(excelData[i]);
		}

		//#region validate
		if (isMandatory || isDuplicateAxle) {
			return res.send({
				success: false, reload: false,
				error: errMsg
			});
		}
		if (isDuplicateAxle) {
			return res.send({
				success: false, reload: false,
				error: "Please fill all the required fields and try again."
			});
		}
		if (req.body.preview == 'true') {
			return res.send({ success: true, reload: true, tyres: previewTyres });
		}
		if (!tyreInfoTocreate.length) {
			if (duplicateTyreInfo.length) {
				return res.send({
					success: false, reload: false, duplicateEntries: duplicateTyreInfo,
					error: 'Please remove already available tyres.'
				});
			}
			if (invalidTyreInfo.length) {
				return res.send({
					success: false, reload: false, invalidEntries: invalidTyreInfo,
					error: 'Please validate tyre data.'
				});
			}
			return res.send({ success: false, reload: false, error: 'Nothing to create.' });
		}
		if (tyreInfoTocreate.length > 10000) {
			return res.send({
				success: false, reload: false, tyres: tyreInfoTocreate,
				error: 'You cannot upload more than 10,000 entries'
			});
		}
		//#endregion

		let branchResponse = tyreBranchValidation(branchResult, tyreStocks, tyreInfoTocreate, res.locals);
		let validateBranch = branchResponse.validateBranch;
		let validateMaxStock = branchResponse.validateMaxStock;

		//#region branch access validation
		if (validateBranch && validateBranch.length) {
			if (validateBranch.length == 1) {
				return res.send({ success: false, reload: false, error: `You are not assigned to this branch ${validateBranch[0]}` });
			} else {
				return res.send({ success: false, reload: false, error: `You are not assigned to these branches ${validateBranch.join("\r\n")}` });
			}
		}

		if (validateMaxStock && validateMaxStock.length) {
			if (validateMaxStock.length == 1) {
				return res.send({ success: false, reload: false, error: `Maximum stock level reached for this branch ${validateMaxStock[0]}.` });
			} else {
				return res.send({ success: false, reload: false, error: `Maximum stock level reached for these branches ${validateMaxStock.join("\r\n")}.` });
			}
		}
		//#endregion

		let tyreStruct = [];
		await models.sequelize.transaction(async t => {
			let tyres = await models.Tyre.bulkCreate(tyreInfoTocreate, { returning: true, transaction: t });
			let histBulk = [];
			tyreStruct = tyres.map(x => x);
			for (const tyre of tyres) {
				let tyreInfo = tyreInfoTocreate.find(x => x.tyreNo == tyre.tyreNo);
				let currentDate = moment(moment().format('DD/MM/YYYY'), 'DD/MM/YYYY').format();
				let purchasedDate = tyre.purchasedOn ? moment(tyre.purchasedOn, 'DD/MM/YYYY').format()
					: currentDate;
				histBulk.push({
					tyreNo: tyre.tyreNo,
					histDate: purchasedDate,
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
					//tyreOdometer: tyre.odometer,
					stockLocation: tyreInfo ? tyreInfo.stockLocation : null,
					BranchId: tyreInfo ? tyreInfo.BranchId : null,
					comments: tyre.comments,
					UserId: res.locals.UserId,
					AccountId: tyre.AccountId,
					username: res.locals.username
				});
				if (['Retread 1', 'Retread 2', 'Retread 3'].indexOf(tyreInfo.condition) > -1) {
					let retrdSeq = parseInt(tyreInfo.condition.split(' ')[1]);
					histBulk.push({
						tyreNo: tyre.tyreNo,
						transaction: "Retread Recd",
						condition: tyre.condition,
						tyreStatus: tyre.tyreStatus,
						histDate: moment(purchasedDate).add(1, 'second').format(),
						position: tyreInfo.position,
						AssetId: null,
						inflation: null,
						wearPattern: null,
						treadPattern: null,
						treadDepth: tyreInfo.currentTreadDepth ? tyreInfo.currentTreadDepth
							: tyreInfo.initialTreadDepth,
						inspectedBy: null,
						shopName: '',
						amount: 0,
						odometer: tyre.odometer ? tyre.odometer : tyreInfo.odo,
						tyreOdometer: 0,
						BranchId: tyreInfo.BranchId || null,
						comments: '',
						tpmsData: tyre.tpmsData,
						details: { retrdSeq: retrdSeq },
						UserId: res.locals.UserId,
						AccountId: tyre.AccountId,
						username: res.locals.username
					});
				}
				if (tyreInfo.AssetId && tyreInfo.position) {
					histBulk.push({
						tyreNo: tyre.tyreNo,
						histDate: tyre.installedOn ?
							moment(tyre.installedOn, 'DD/MM/YYYY').format() : moment(currentDate).add(1, 'minute').toISOString() || '',
						transaction: "Fitment",
						condition: tyre.condition,
						tyreStatus: tyre.tyreStatus,
						position: tyreInfo.position,
						odometer: tyre.odometer ? tyre.odometer : tyreInfo.odo,
						//tyreOdometer: tyre.odometer,
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
					});
				}
				if (
					tyreInfo.initialTreadDepth &&
					tyreInfo.currentTreadDepth &&
					tyreInfo.initialTreadDepth != tyreInfo.currentTreadDepth
				) {
					histBulk.push({
						tyreNo: tyre.tyreNo,
						histDate: moment(currentDate).add(2, 'minute').format(),
						transaction: "Inspect",
						condition: tyre.condition,
						tyreStatus: tyre.tyreStatus,
						position: tyreInfo.position,
						treadDepth: tyreInfo.currentTreadDepth,
						odometer: tyre.odometer ? tyre.odometer : tyreInfo.odo,
						//tyreOdometer: tyre.odometer,
						AssetId: tyre.AssetId,
						tpmsData: tyre.tpmsData,
						UserId: res.locals.UserId,
						AccountId: tyre.AccountId,
						username: res.locals.username
					});
				}
				if (tyre && tyre.tpmsId) {
					evt.events.emit('tpms-history-update', {
						tyreId: tyre.id,
						tpmsId: tyre.tpmsId,
						user: {
							id: res.locals.UserId,
							username: res.locals.username
						},
						position: tyreInfo && tyreInfo.position,
						actionType: tpmsActionsEnum.Assign
					});
				}
			};

			let TyreHistories = await models.TyreHistory.bulkCreate(histBulk, { returning: true, transaction: t });
			await Promise.all((tyres || []).map(async (tyre) => {
				var tyreHist = {};
				if (['Retread 1', 'Retread 2', 'Retread 3'].indexOf(tyre.condition) > -1 && !tyre.AssetId) {
					tyreHist = TyreHistories.find(x => x.tyreNo == tyre.tyreNo && x.transaction == 'Retread Recd');
				} else {
					tyreHist = TyreHistories.find(x => x.tyreNo == tyre.tyreNo && x.transaction == 'Inspect');
					if (!tyreHist) {
						tyreHist = TyreHistories.find(x => x.tyreNo == tyre.tyreNo && x.transaction == 'Fitment');
					}
				}
				if (!tyreHist || (tyreHist && !Object.keys(tyreHist).length)) {
					tyreHist = TyreHistories.find(x => x.tyreNo == tyre.tyreNo);
				}
				if (!tyreHist) return;
				const tyreHistPlain = tyreHist.get ? tyreHist.get({ plain: true }) : tyreHist;
				var matchedBranch = branchResult.find(x => x.id == tyre.BranchId);
				var Branch = {};
				if (matchedBranch) {
					Branch.id = matchedBranch.id;
					Branch.name = matchedBranch.name;
				}

				tyreHistPlain.Branch = Branch;
				tyre.set('lastStatus', { ...tyreHistPlain });
				tyre.changed('lastStatus', true);

				await tyre.save({ transaction: t });
			}));

		});

		let defaultMsg = `Upload ${tyreInfoTocreate.length} tyres successfully.`
		if (duplicateTyreInfo.length) {
			return res.send({
				success: false, reload: false, duplicateEntries: duplicateTyreInfo,
				message: `${defaultMsg}. Please remove already available tyres.`
			});
		}
		if (invalidTyreInfo.length) {
			return res.send({
				success: false, reload: false, invalidEntries: invalidTyreInfo,
				message: `${defaultMsg}. Please validate tyre data.`
			});
		}
		return res.send({ success: true, reload: true, tyres: tyreStruct, message: defaultMsg });

	} catch (error) {
		console.log(`Error in ${ROUTE}: `, error);
		RaiseLogEvent(ROUTE, res.locals.AccountId, error, error.stack);
		return res.send({ success: false, error: 'Error processing data.' });
	}
}

exports.listTyreStatus = function (req, res) {
	return res.send({ success: true, status: tyreStatusConfig.status });
}


async function axleMfMarkingByTyre(positions, Asset) {
	const ROUTE = 'app/tyres/axleMfMarkingByTyre';
	try {
		RaiseLogEvent('avolve/tyres/remove', 'log', { AssetId: Asset.id, position: positions }, `Axle recieved for MF axle marking`);

		let reqAxle = null, reqAxlePositions = [];
		let axleConfig = Asset && Asset.axleConfig && JSON.parse(JSON.stringify(Asset.axleConfig)) || {};
		if (axleConfig && axleConfig.config) {
			reqAxle = axleConfig.config.find(axle => axle.position.some(x => positions.includes(x))) || {};  //filter matched axles
			reqAxlePositions = reqAxle && reqAxle.position || []; //filter matched positions
		}

		let TyreCount = await models.Tyre.count({
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId,
				'lastStatus.position': { [Op.in]: reqAxlePositions }
			}
		});

		if (TyreCount) {
			RaiseLogEvent(ROUTE, 'log', { AssetId: Asset.id, position: positions, TyreCount: TyreCount }, `Request rejected: All tyre were not removed from requested axle`);
			return { success: false };
		}

		let details = Asset && Asset.details && JSON.parse(JSON.stringify(Asset.details)) || {};
		if (reqAxle && reqAxle.name) {
			for (const config of axleConfig.config) {
				if (config.name == reqAxle.name && config.axle == reqAxle.axle) {
					config.mf.active = true;
					config.mf.req = false;
					break;
				}
			}
		}

		let pendingMfReq = axleConfig.config.some(x => x.mf && x.mf.req);
		if (details && details.axleProfile && details.axleProfile.mf) {
			details.axleProfile.mf.active = true;
			if (pendingMfReq) {
				details.axleProfile.mf.req = true;
			} else {
				details.axleProfile.mf.req = false;
			}
			details.axleProfile.mf.initialDate = details.axleProfile.mf.initialDate || moment().toISOString();
		}

		await Asset.update({
			axleConfig: axleConfig,
			details: details
		});

		RaiseLogEvent(ROUTE, 'log', Asset, `Requested axle marked as MF`);

		return { success: true };
	} catch (error) {
		return { success: false, error: error };
	}
}

function mfTransactionCheck(Asset, position) {
	let mf = false;
	if (Asset && Asset.axleConfig) {
		let axleConfig = JSON.parse(JSON.stringify(Asset.axleConfig)) || {};
		if (axleConfig && axleConfig.config) {
			let mfAxle = axleConfig.config.find(axle => axle.position.includes(position)) || {}; //filter matched axles
			if (mfAxle.mf && mfAxle.mf.active) {
				mf = true;
			}
		}
	}
	return mf;
}

async function getTyresInRetread(tyreNos, AccountId, status) {
	try {
		let attributes = ['id', 'tyreNo', 'rtdCompany'];
		if (status == 'scrap') {
			attributes.push('details');
		}

		let TyresInRetread = await models.TyreRetread.findAll({
			attributes,
			where: {
				tyreNo: tyreNos,
				AccountId: AccountId,
				status: status
			},
			raw: true
		});

		return { success: true, results: TyresInRetread };
	} catch (error) {
		return { success: false, error: 'Error fetching tyre retreads.' };
	}
}

async function removalValidation(req, assetOdo, tyres, tyreData) {
	try {
		let body = req.body;
		for (const tyre of tyres) {
			let { details } = await redisHelper.getAccount(tyre.AccountId);
			let isPayKMCustomer = details && details.payKm || false;
			let tyreImgs = (req.files) && req.files.filter(files => {
				if (files.originalname && files.originalname.startsWith(`${tyre.tyreNo}_${tyre.id}`)) return files.originalname;
			}) || '';
			if ((!tyreImgs || !tyreImgs.length) && isPayKMCustomer && tyre.AssetId) {
				return { success: false, error: 'Please update image for tyre removal.' };
			}

			let inputTyreData = tyreData.find(x => x.tyreNo == tyre.tyreNo);
			let validateNSD = Number(body.odometer) && Number(tyre.odometer) && Number(body.odometer) > Number(assetOdo) || false;
			let validateOdo = false;
			let histDetails = tyre.lastStatus && tyre.lastStatus.details || {};
			if (tyre.lastStatus && tyre.lastStatus.position && !['SP', 'SP1', 'SP2', 'SP3', 'SP4'].includes(tyre.lastStatus.position)) {
				if (inputTyreData.grooves && inputTyreData.grooves.depths && Object.keys(inputTyreData.grooves.depths).length) {
					for (const groove in inputTyreData.grooves.depths) {
						let matchedDepth = histDetails.grooves && histDetails.grooves.depths && histDetails.grooves.depths[groove] || '';
						if (Number(matchedDepth) && Number(inputTyreData.grooves.depths[groove]) && Number(inputTyreData.grooves.depths[groove]).toFixed(1) != Number(matchedDepth).toFixed(1)) {
							validateOdo = true;
							break;
						}
					}
				}
				if (histDetails.grooves && histDetails.grooves.depths && Object.keys(histDetails.grooves.depths).length) {
					if (validateOdo && (Number(body.odometer) == Number(assetOdo))) {
						return { success: false, error: 'Odometer should be increased if the tyre NSD is changed.' };
					}
					if (validateNSD && !validateOdo) {
						return { success: false, error: 'NSD should be decreased if odometer is changed.' };
					}
				}
			}
		}
		return { success: true };
	} catch (error) {
		return { success: false, error: 'Error fetching tyre retreads.' };
	}
}

function statusDisplay(status) {
	switch (status) {
		case 0: return 'New';
		case 1: return 'Running';
		case 2: return 'Removed';
		case 3: return 'Sent for Retread';
		case 4: return 'Retreaded';
		case 5: return 'Pending for Decision';
		case 6: return 'Scrappped';
		default: return '';
	}
}

function getGrooveWiseDepth(lastStatus) {
	let depths = lastStatus && lastStatus.details && lastStatus.details.grooves && lastStatus.details.grooves.depths || {};
	let grooves = [];
	for (const key in depths) {
		grooves.push({
			label: `Groove ${key}`,
			depth: depths[key] && parseFloat(depths[key])
		});
	}
	return grooves;
}

function getRetreadStatus(retread, histories) {
	let hist = histories[1] || null;
	let status = '';
	if (hist && hist.transaction == 'Retread Sent' && retread) {
		status = retread.details && retread.details.status == 2 ? 'Retread Rejected' : '';
	}
	return status;
}