const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const redisHelper = require('../../../lib/helpers/redis');
const { handleApiError } = require('../../middlewares/helper');
const models = require('../../../models');

exports.get = async function (req, res) {
	const ROUTE = 'web/assetService/get';
	try {
		if (!req.params.id && Number.isInteger(req.params.id) && req.params.id < 0) {
			return res.send({ success: false, error: 'fields left empty' });
		}
		let AssetService = await models.AssetService.findOne({
			include: [
				{
					model: models.Asset,
					attributes: ['id', 'lplate'],
					required: false
				},
				{
					model: models.Account,
					attributes: ["id", "name", "oname", "tname"],
					required: false
				},
				{
					model: models.Employee,
					as: "serviceManager",
					attributes: ["firstName", "lastName", "number", "officePhone"],
					required: false
				},
				{
					model: models.Employee,
					as: "ServiceCreatedByEmployee",
					attributes: ["firstName", "lastName", "number"],
					required: false
				},
				{
					model: models.User,
					as: "ServiceCreatedByUser",
					attributes: ["username", "id"],
					required: false
				}
			],
			where: { id: req.params.id }
		});

		if (!AssetService) {
			return res.send({ success: false, error: `Service Id: ${req.params.id} not found` });
		}

		return res.send({ success: true, assetService: AssetService });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching asset service data', err);
	}
}

exports.create = async function (req, res) {
	const ROUTE = 'web/assetservices/create';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `User: ${res.locals.userFullName} (${res.locals.UserId})`);

		const Account = await redisHelper.getAccount(res.locals.AccountId);

		//#region validate
		if (!Account) {
			return res.send({ success: false, error: 'Account not found.' });
		}
		if (Account.status != 1) {
			return res.send({ success: false, error: 'Account not active. Please contact KTT.' });
		}
		let errMsg = validateServiceReq(req.body, res.locals);
		if (errMsg) {
			return res.send({ success: false, error: errMsg });
		}

		const vehicleInfo = {
			HierarchyId: req.body.hierarchyId || null,
			GroupId: req.body.groupId || null,
			VehicleBrandId: req.body.vehicleBrandId,
			VehicleModelId: req.body.vehicleModelId,
			VehicleTypeId: req.body.vehicleTypeId,
			axleProfile: req.body.axleProfile,
			mfgYear: req.body.mfgYear,
			remarks: req.body.remarks || '',
			billingRemarks: req.body.billingRemarks || ''
		};
		var serviceObj = {
			lplate: req.body.vehicleNo,
			type: 2,
			status: 1,
			city: Account.city,
			AssignedToBDM: Account.EmployeeIdBDM,
			AssignedToRelMgr: Account.EmployeeIdRM,
			clientContact: req.body.contactName,
			clientPhone: req.body.contactPhoneNo,
			serviceTime: moment(req.body.vehicleAvailTime, 'DD/MM/YYYY hh:mm A').format(),
			location: {
				locationName: req.body.vehicleLocation,
				location_lat: req.body.vehicle_lat,
				location_lon: req.body.vehicle_lon,
				serviceTime: moment(req.body.vehicleAvailTime, 'DD/MM/YYYY hh:mm A').format()
			},
			details: {
				vehicleInfo: vehicleInfo
			},
			AccountId: res.locals.AccountId,
			UserIdCreatedBy: res.locals.id
		};

		AssetService = await models.AssetService.create(serviceObj);
		evt.events.emit('crm-assign-service-manager', {
			AssetServiceId: AssetService.id,
			AccountId: AssetService.AccountId
		});

		return res.send({ success: true, assetService: AssetService });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error creating asset service request', err);
	}
}

function validateServiceReq(inputData, locals) {
	let error = '';
	if (!inputData.vehicleNo) {
		error = 'Vehicle No mandatory.';
	} else if (!inputData.vehicleBrandId) {
		error = 'Vehicle brand missing.';
	} else if (!inputData.vehicleModelId) {
		error = 'Vehicle model missing.';
	} else if (!inputData.vehicleTypeId) {
		error = 'Vehicle type missing.';
	} else if (!inputData.axleProfile) {
		error = 'Axle details missing.';
	} else if (!inputData.mfgYear) {
		error = 'Vehicle mfg year missing.';
	} else if (!inputData.contactName || !inputData.contactPhoneNo) {
		error = 'Please provide contact name / mobileNo to communicate further.';
	} else if (!inputData.vehicleAvailTime) {
		error = 'Please provide time of vehicle availability.';
	} else if (!inputData.vehicleLocation || !inputData.vehicle_lat || !inputData.vehicle_lon) {
		error = 'Please provide vehicle available location.';
	} else if (locals.AccountId == 3423 && (!inputData.ownerName || !inputData.ownerPhoneNo)) {
		error = 'Owner name / mobileNo missing.';
	}
	return error;
}

exports.listServiceStatus = async function (req, res) {
	const ROUTE = 'web/assetservices/listStatus';
	try {
		const SystemConfig = await models.SystemConfig.findOne({
			attributes: ['id', 'data'],
			where: {
				module: 'CRM',
				name: 'Asset Service Status'
			}
		});
	
		let status = SystemConfig.data && Object.keys(SystemConfig.data).length
			&& SystemConfig.data || [];
		return res.send({ success: true, results: status });

	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching service status list', error);
	}
}

exports.listIssueType = function (req, res) {
	return res.send({
		success: true, results: [
			{ id: 1, text: "Hardware" },
			{ id: 2, text: "Software" }
		]
	});
}