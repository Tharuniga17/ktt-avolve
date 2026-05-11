const models = require('../../../models');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { isMasterAccount } = require('../../../lib/helpers/region');

exports.get = async function (req, res) {
	try {
		if (res.locals.role != 'Admin' || !isMasterAccount(res.locals.AccountId)) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: 'Input Parameter Missing.' });
		}

		let VehicleMakeModel = await models.VehicleModel.findOne({
			attributes: ['id', 'modelName', 'defaultAxle', 'year'],
			include: [{
				attributes: ['id', 'brandName'],
				model: models.VehicleBrand
			}],
			where: {
				id: req.params.id,
				discontinued: false
			},
			raw: true,
			nest: true
		});

		return res.send({ success: true, result: VehicleMakeModel });
	} catch (error) {
		console.log('Error in api/vehiclemodels/get: ', error);
		RaiseLogEvent('api/vehiclemodels/get', 'error', error, 'Error fetching vehicle make');
		return res.send({ success: false, error: error });
	}
}

exports.list = async function (req, res) {
	try {
		if (res.locals.role != 'Admin' || !isMasterAccount(res.locals.AccountId)) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		let VehicleMakeModels = await models.VehicleModel.findAll({
			attributes: ['id', 'modelName', 'defaultAxle', 'year'],
			include: [{
				attributes: ['id', 'brandName'],
				model: models.VehicleBrand
			}],
			where: {
				discontinued: false
			},
			raw: true,
			nest: true
		});

		return res.send({ success: true, results: VehicleMakeModels });
	} catch (error) {
		console.log('Error in api/vehiclemodels/list: ', error);
		RaiseLogEvent('api/vehiclemodels/list', 'error', error, 'Error fetching vehicle make');
		return res.send({ success: false, error: error, results: [] });
	}
}

exports.create = async function (req, res) {
	try {
		if (!req.body.model) {
			return res.send({ success: false, error: "Model name is missing." });
		}

		if (!req.body.vehicleBrand && !req.body.vehicleBrandId) {
			return res.send({ success: false, error: "Brand information is missing." });
		}

		let apollo = false;
		if (isMasterAccount(res.locals.AccountId)) {
			apollo = true;
		}

		let existingVehicleModel = await models.VehicleModel.findOne({
			where: {
				modelName: req.body.model,
				VehicleBrandId: req.body.vehicleBrandId || null
			}
		});

		if (existingVehicleModel) {
			return res.send({ success: false, error: "Vehicle model already exists." });
		}

		let VehicleModel = await getVehicleModelObj(req)

		let t = await models.sequelize.transaction();
		if (!req.body.vehicleBrandId) {
			let vehicleBrand = {
				brandName: req.body.vehicleBrand,
				discontinued: false
			};
			let VehicleBrand = await models.VehicleBrand.create(vehicleBrand, { transaction: t });
			VehicleModel.VehicleBrandId = VehicleBrand.id;
		} else {
			VehicleModel.VehicleBrandId = req.body.vehicleBrandId;
		}

		VehicleModel = await models.VehicleModel.create(VehicleModel, { transaction: t, returning: true });
		await t.commit();

		return res.send({ success: true, result: VehicleModel });
	} catch (error) {
		console.log('Error in api/vehiclemodels/create: ', error);
		RaiseLogEvent('api/vehiclemodels/create', 'error', error, 'Error creating vehicle model');
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

		let VehicleMakeModel = await models.VehicleModel.update(await getVehicleModelObj(req), {
			where: {
				id: req.params.id
			},
			returning: true
		});

		return res.send({ success: true, result: VehicleMakeModel[1][0] });
	} catch (error) {
		console.log('Error in api/vehiclemodels/update: ', error);
		RaiseLogEvent('api/vehiclemodels/update', 'error', error, 'Error updating vehicle model');
		return res.send({ success: false, error: error });
	}
}

exports.count = async function (req, res) {
	try {
		if (res.locals.role != 'Admin' || !isMasterAccount(res.locals.AccountId)) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		const [manufacturers, vehicleModels, wheelers] = await Promise.all([
			models.VehicleBrand.count(),
			models.VehicleModel.count(),
			models.VehicleModel.count({
				distinct: true,
				col: 'defaultAxle'
			})
		]);

		return res.send({
			success: true,
			result: {
				manufacturers,
				models: vehicleModels,
				wheelers
			}
		});

	} catch (error) {
		console.log('Error in api/vehiclemodels/count: ', error);
		RaiseLogEvent('api/vehiclemodels/count', 'error', error, 'Error fetching tyres make count');
		return res.send({ success: false, error: error });
	}
}

async function getVehicleModelObj(req) {
	return {
		modelName: req.body.model,
		defaultAxle: req.body.defaultWheeler,
		year: req.body.year
	}
}
