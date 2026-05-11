const models = require('../../../models');
const moment = require('moment');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { isMasterAccount } = require('../../../lib/helpers/region');
const { handleApiError } = require('../../middlewares/helper');

exports.get = async function (req, res) {
	try {
		if (res.locals.role != 'Admin' || !isMasterAccount(res.locals.AccountId)) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: 'Input Parameter Missing.' });
		}

		let TyreMakeModel = await models.TyreMakeModel.findOne({
			attributes: ['id', 'make', 'model', 'codeSize', 'tyreType', 'initialTreadDepth', 'loadIndex', 'speedRating', 'treadPattern', 'tube', 'flap'],
			where: {
				apollo: true,
				id: req.params.id
			},
			raw: true
		});

		delete TyreMakeModel.user;

		return res.send({ success: true, result: TyreMakeModel });
	} catch (error) {
		console.log('Error in api/tyremakemodels/get: ', error);
		RaiseLogEvent('api/tyremakemodels/get', 'error', error, 'Error fetching tyre make');
		return res.send({ success: false, error: error });
	}
}

exports.list = async function (req, res) {
	try {
		if (res.locals.role != 'Admin' || !isMasterAccount(res.locals.AccountId)) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		let TyreMakeModels = await models.TyreMakeModel.findAll({
			attributes: ['id', 'make', 'model', 'codeSize', 'tyreType', 'initialTreadDepth', 'loadIndex', 'speedRating', 'treadPattern', 'tube', 'flap', 'createdAt', 'user'],
			where: {
				apollo: true
			},
			raw: true
		});

		let results = [];
		for (const TyreMakeModel of TyreMakeModels) {
			TyreMakeModel.createdBy = TyreMakeModel?.user?.createdBy ? TyreMakeModel.user.createdBy : {
				username: 'System',
				role: '',
				date: moment(TyreMakeModel.createdAt).format('DD/MM/YYYY hh:mm A')
			};

			delete TyreMakeModel.user;
			results.push(TyreMakeModel);
		}

		return res.send({ success: true, results: results });
	} catch (error) {
		console.log('Error in api/tyremakemodels/list: ', error);
		RaiseLogEvent('api/tyremakemodels/list', 'error', error, 'Error fetching tyre make');
		return res.send({ success: false, error: error, results: [] });
	}
}

exports.getDistinctModels = async function (req, res) {
	const ROUTE = 'web/tyremakemodels/distinctModels';
	try {
		const Models = await models.Tyre.findAll({
			attributes: [[models.Sequelize.fn('DISTINCT', models.Sequelize.col('model')), 'model']],
			where: {
				AccountId: res.locals.AccountId,
			},
			raw: true
		});

		return res.send({ success: true, results: Models });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching assets', error);
	}
}

exports.create = async function (req, res) {
	try {
		if (!req.body.make || !req.body.model) {
			return res.send({ success: false, error: "Fields missing" });
		}

		let apollo = false;
		if (isMasterAccount(res.locals.AccountId)) {
			apollo = true;
		}

		let user = {
			createdBy: {
				id: res.locals.UserId,
				role: res.locals.role,
				username: res.locals.userFullName,
				date: moment().toISOString()
			}
		};

		let TyreMakeModel = await models.TyreMakeModel.create(await getTyreMakeModelObj(req, res, apollo, user))
		return res.send({ success: true, result: TyreMakeModel });
	} catch (error) {
		console.log('Error in api/tyremakemodels/create: ', error);
		RaiseLogEvent('api/tyremakemodels/create', 'error', error, 'Error creating tyre make');
		return res.send({ success: false, error: error });
	}
}

exports.update = async function (req, res) {
	try {
		if (!req.body.make || !req.body.model) {
			return res.send({ success: false, error: "Fields missing" });
		}

		let apollo = false;
		if (isMasterAccount(res.locals.AccountId)) {
			apollo = true;
		}

		let user = {
			updatedBy: {
				id: res.locals.UserId,
				role: res.locals.role,
				username: res.locals.userFullName,
				date: moment().toISOString()
			}
		};

		let TyreMakeModel = await models.TyreMakeModel.update(await getTyreMakeModelObj(req, res, apollo, user));
		return res.send({ success: true, result: TyreMakeModel });
	} catch (error) {
		console.log('Error in api/tyremakemodels/update: ', error);
		RaiseLogEvent('api/tyremakemodels/update', 'error', error, 'Error updating tyre make');
		return res.send({ success: false, error: error });
	}
}

exports.count = async function (req, res) {
	try {
		if (res.locals.role != 'Admin' || !isMasterAccount(res.locals.AccountId)) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		const TyreMakeModels = await models.TyreMakeModel.findAll({
			attributes: ['id', 'make', 'model', 'codeSize'],
			where: { apollo: true },
			raw: true
		});

		const makeSet = new Set();
		const modelSet = new Set();
		const sizeSet = new Set();

		for (const row of TyreMakeModels) {
			if (row.make) makeSet.add(row.make.trim());
			if (row.model) modelSet.add(row.model.trim());
			if (row.codeSize) sizeSet.add(row.codeSize.trim());
		}

		const result = {
			tyreSKUs: TyreMakeModels.length,
			tyreMake: makeSet.size,
			tyreModel: modelSet.size,
			tyreCodeSize: sizeSet.size
		};

		return res.send({ success: true, result: result });

	} catch (error) {
		console.log('Error in api/tyremakemodels/count: ', error);
		RaiseLogEvent('api/tyremakemodels/count', 'error', error, 'Error fetching tyres make count');
		return res.send({ success: false, error: error });
	}
}

async function getTyreMakeModelObj(req, res, apollo, user) {
	return {
		make: req.body.make,
		model: req.body.model,
		codeSize: req.body.size,
		tyreType: req.body.tyreType,
		speedRating: req.body.speedRating,
		loadIndex: req.body.loadIndex,
		initialTreadDepth: req.body.initialTreadDepth,
		treadPattern: req.body.treadPattern,
		tube: req.body.tube,
		flap: req.body.flap,
		apollo: apollo,
		user: user
	}
}
