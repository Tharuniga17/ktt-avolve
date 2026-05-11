const models = require('../../../models');
const { RaiseLogEvent } = require("../../../lib/helpers/rmqlog.js")
const path = require('path');

exports.list = async function (req, res) {
	const ROUTE = 'app/tyremakemodels/list'
	try {
		let TyreMakeModels = await models.TyreMakeModel.findAll({
			where: { apollo: true },
			raw: true
		});

		TyreMakeModels.map(x => {
			if (x.imagePath) x.imagePath = path.join('/images/tyres/', x.imagePath)
			return x
		});

		return res.send({ success: true, results: TyreMakeModels });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${error}`);
		RaiseLogEvent('TyreMakeModels Api', 'Tyre Make Model list', err, `Api Error`);
		return res.send({ success: false, error: 'Error fetching list.' });
	}
}

exports.saveEnquiry = async function (req, res) {
	const ROUTE = 'app/tyremakemodels/saveEnquiry';
	try {
		RaiseLogEvent(ROUTE, req.body.customerName, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		let Lead = await models.Lead.create({
			leadSource: 7,
			custName: req.body.customerName,
			custLocation: req.body.customerLocation,
			phone1: req.body.customerPhone,
			requirement: req.body.tyreMake + '-' + req.body.tyreModel,
			comments: 'Qty - ' + req.body.quantity,
			AccountId: res.locals.AccountId
		})

		return res.send({ success: true, info: Lead });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'lead create', err, `Api Error`);
		return res.send({ success: false, error: "error at creating Lead" });
	};
}
