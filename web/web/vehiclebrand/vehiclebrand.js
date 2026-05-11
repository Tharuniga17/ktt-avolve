const models = require('../../../models');
const moment = require('moment');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { isMasterAccount } = require('../../../lib/helpers/region');

exports.list = async function (req, res) {
	try {
		if (res.locals.role != 'Admin' || !isMasterAccount(res.locals.AccountId)) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		let VehicleBrands = await models.VehicleBrand.findAll({
			attributes: ['id', 'brandName'],
			where: {
				discontinued: false
			},
			raw: true
		});

		return res.send({ success: true, results: VehicleBrands });
	} catch (error) {
		console.log('Error in api/vehiclebrands/list: ', error);
		RaiseLogEvent('api/vehiclebrands/list', 'error', error, 'Error fetching vehicle brands');
		return res.send({ success: false, error: error, results: [] });
	}
}