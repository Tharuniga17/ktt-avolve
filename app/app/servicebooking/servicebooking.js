const models = require("../../../models");
const moment = require("moment");
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const avolveHelper = require('../../../lib/helpers/avolveHelper');
const rejectReasons = require('../../../config/apl-booking-rejectReasons.json');
const evt = require('../../../lib/event');
const { Op } = require('sequelize');
const { parseUTC } = require('../../../lib/dateFormatter');

exports.create = async function (req, res) {
	const ROUTE = 'app/servicebookings/create ';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.body.AssetId || !req.body.GeozoneId || !req.body.date || !req.body.schedules) {
			return res.send({ success: false, error: 'Missing input parameter.' });
		}

		const scheduledAtUTC = parseUTC(req.body.date, res.locals.region || 'IN');
		if (!scheduledAtUTC) {
			return res.send({ success: false, error: 'Invalid date format.' });
		}
		if (moment(scheduledAtUTC).utc().day() === 0) {
			return res.send({ success: false, error: 'Service scheduling restricted for Sunday.' });
		}


		await models.ServiceBooking.findOne({
			attributes: ['id', 'status'],
			where: {
				AssetId: req.body.AssetId,
				date: {
					[Op.between]: [
						moment().utc().startOf('day').toISOString(),
						moment().utc().endOf('day').toISOString()
					]
				}
			},
			order: [['id', 'desc']]
		});

		let scheduleIds = [];
		let brokenSchIds = [];
		if (req.body.schedules.length) {
			scheduleIds = req.body.schedules.filter(x => x.schedule).map(x => parseInt(x.id));
			brokenSchIds = req.body.schedules.filter(x => !x.schedule).map(x => parseInt(x.id));
		}

		let whereClause = {
			id: req.body.AssetId
		}

		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			if (!geozoneResult.success) {
				RaiseLogEvent(ROUTE, 'error', geozoneResult.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			res.GeozoneId = geozoneResult.geozones.map(x => x.id);
			let result = await avolveHelper.fetchCustomers(res);
			whereClause.AccountId = result.customers && result.customers.length && result.customers.map(x => x.id) || [];
		}

		if (res.locals.role == "AMCC FTE") {
			whereClause.AccountId = res.locals.accountIds;
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'details', 'AccountId', 'plan', 'odo'],
			include: [{
				attributes: ['id'],
				model: models.Account,
				where: {
					AccountIdParent: res.locals.masterAccountId
				},
				required: true
			}],
			where: whereClause
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found in system.' });
		}

		if (res.locals.role == "AMCC FTE" && Asset.plan != 2) {
			return res.send({ success: false, error: 'AMC Captive offer not offered for this vehicle.' });
		}

		if (res.locals.role == "AMCS FTE" && Asset.plan != 1) {
			return res.send({ success: false, error: 'AMC Shared offer not offered for this vehicle.' });
		}

		let Geozone = await models.Geozone.findOne({
			attributes: ['id', 'name', 'zoneCode', 'AccountId', 'center', 'address'],
			where: {
				id: req.body.GeozoneId
			}
		});

		if (!Geozone) {
			return res.send({ success: false, error: 'Geozone not found.' });
		}

		let reqCv = {};
		if (req.query.GeozoneId) {
			reqCv = await models.Geozone.findOne({
				attributes: ['id', 'name', 'city', 'zoneCode', 'AccountId', 'center', 'address'],
				where: {
					id: req.query.GeozoneId
				}
			});
		}


		let AplService = await models.AplService.findOne({
			attributes: ['id', 'services'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			}
		});

		if (!AplService) {
			return res.send({ success: false, error: 'services not found.' });
		}

		let status = 0;
		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			if (!geozoneResult.success) {
				RaiseLogEvent(ROUTE, 'error', geozoneResult.error, 'Workshops not assigned to this user');
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			if (geozoneResult.geozones.find(x => x.id == Geozone.id)) { //If selected cv is primary cv (Direct approval)
				status = 0;
			} else {
				status = 4; //if other cv is selected then it will be in approval section
			}
		}

		let Schedules = await models.VehicleServiceSchedule.findAll({
			attributes: ['id', 'profile', 'serviceBasedOn', 'isActive', 'VehicleServiceTypeId'],
			include: [
				{
					attributes: ["id", "componentName", "serviceName", "profile"],
					model: models.VehicleServiceType
				}
			],
			where: {
				id: scheduleIds,
				AccountId: Asset.AccountId
			}
		});

		let skipWheelRot = false;
		let services = [];
		for (const Schedule of Schedules) {
			if (Schedule) {
				let matchService = AplService.services.find(x => x.ServiceTypeId == Schedule.VehicleServiceTypeId);
				services.push({
					sNo: matchService && matchService.sNo || "",
					ScheduleId: Schedule.id,
					ServiceTypeId: Schedule.VehicleServiceTypeId,
					componentName: Schedule.VehicleServiceType && Schedule.VehicleServiceType.componentName || "",
					serviceName: Schedule.VehicleServiceType && Schedule.VehicleServiceType.serviceName || "",
					sub: []
				})
			}

			if (Schedule.VehicleServiceType && Schedule.VehicleServiceType.serviceName && Schedule.VehicleServiceType.serviceName == 'Tyre Rotation On Rim') {
				if (req.body.schedules.some(x => x.isSkipped) && req.body.schedules.some(x => Schedule.id == x.id)) {
					skipWheelRot = true;
				}
			}
		}

		services = services.sort(function (a, b) { return a.sNo - b.sNo });

		//#region consumption count validation
		if (AplService) {
			let serviceNames = [];
			for (const service of AplService.services) {
				let matchedService = services.find(x => x.serviceName == service.serviceName);
				if (matchedService && Number(service.consumed) >= Number(service.alloted)) {
					serviceNames.push(matchedService.serviceName);
				}
			}
			if (serviceNames && serviceNames.length) {
				return res.send({ success: false, error: `You have reached the maximum allowable count for the '${serviceNames.join(', ')}' services.` });
			}
		}
		//#endregion

		let asset = {
			id: Asset.id,
			lplate: Asset.lplate,
			wheeler: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.wheeler || "",
			config: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.config || "",
			name: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.name || ""
		}

		let geozone = {
			id: Geozone.id,
			name: Geozone.name,
			code: Geozone.zoneCode,
			center: Geozone.center,
			city: Geozone.city,
			type: status == 4 && 'Secondary' || 'Primary',
			address: Geozone.address
		}

		let notes = {};
		if (skipWheelRot) {
			notes.skipWheelRot = skipWheelRot;
		}

		const nowUTC = moment().utc().toISOString();
		let user = {
			createdBy: {
				id: res.locals.UserId,
				name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
				username: res.locals.username,
				role: res.locals.role,
				date: nowUTC,
				schDate: scheduledAtUTC
			}
		};

		let log = {
			createdBy: [user.createdBy]
		};
		user.requestedBy = user.createdBy;
		if (res.locals.role == "FM") {
			log.requestedBy = [user.requestedBy];
			//#region primary/secondary assignment
			geozone.type = 'Primary';
			res.GeozoneId = Geozone.id;
			res.AccountId = res.locals.masterAccountId;
			let result = await avolveHelper.fetchCustomers(res);
			let accountIds = result.customers && result.customers.length && result.customers.map(x => x.id) || [];
			let hasPrimaryCvCust = accountIds.find(x => x == Asset.AccountId);
			if (!hasPrimaryCvCust) {
				geozone.type = 'Secondary';
			}
			//#endregion
		} else {
			if (reqCv) {
				log.requestedBy = [{
					id: reqCv.id,
					name: `${reqCv.name}, ${reqCv.city}`,
					date: moment().toISOString()
				}]
			}
		}

		let ServiceBooking = await models.ServiceBooking.create({
			date: scheduledAtUTC,
			asset: asset,
			geozone: geozone,
			type: 0,
			status: status,
			user: user,
			log: log,
			AccountId: Asset.AccountId,
			GeozoneId: Geozone.id,
			AssetId: Asset.id,
			services: services,
			notes: notes
		});

		if (services.length) {
			await models.VehicleServiceSchedule.update({
				jobCardStatus: 0
			}, {
				where: {
					id: { [Op.in]: services.map(x => x.ScheduleId) },
					VehicleServiceTypeId: { [Op.in]: services.map(x => x.ServiceTypeId) },
					AccountId: Asset.AccountId,
					AssetId: Asset.id
				}
			});

			//#region alert schedule
			let AplAlerts = await models.AplAlert.findAll({
				attributes: ['id'],
				where: {
					status: 1,
					type: 1,
					AccountId: Asset.AccountId,
					AssetId: Asset.id,
					'details.BookingId': null,
					'details.ScheduleId': { [Op.in]: services.map(x => x.ScheduleId) },
					'details.ServiceTypeId': { [Op.in]: services.map(x => x.ServiceTypeId) }
				},
				order: [['dueDate', 'desc']]
			});

			if (AplAlerts.length) {
				for (const AplAlert of AplAlerts) {
					evt.events.emit('schedule-avolve-service-alert', {
						BookingId: ServiceBooking.id,
						AccountId: ServiceBooking.AccountId,
						schedule: true,
						AplAlertId: AplAlert.id
					});
				}
			}
			//#endregion
		}

		for (const Schedule of req.body.schedules) { // Skip wheel roation if it triggered with tyre rotation on rim
			if (Schedule.isSkipped && skipWheelRot) {
				evt.events.emit('avolve-update-rotation-serSch', {
					scheduleId: Schedule.id,
					AccountId: Asset.AccountId,
					AssetId: Asset.id,
					sTime: ServiceBooking.date,
					odo: Asset.odo
				});
			}
		}

		evt.events.emit('apl-reportlog', { //TODO: need to check if emit needed
			AccountId: ServiceBooking.AccountId,
			reportValues: ['ss'],
			month: moment(ServiceBooking.date).utc().format('MM'),
			year: moment(ServiceBooking.date).utc().format('YYYY')
		});

		if (Asset.plan == 1) {
			evt.events.emit('apl-fte-serviceSummary', {
				AccountId: res.locals.masterAccountId,
				plan: 1,
				month: moment(ServiceBooking.date).utc().format('MM'),
				year: moment(ServiceBooking.date).utc().format('YYYY')
			});
		}

		return res.send({ success: true, servicebooking: ServiceBooking });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Error creating service booking.`);
		return res.send({ success: false, error: "Error creating service booking." });
	}
}

exports.createAdhoc = async function (req, res) {
	const ROUTE = 'app/servicebookings/createAdhoc ';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: { msg: 'Not Authorized.' } });
		}

		if (!req.body.AssetId || !req.body.GeozoneId || !req.body.serviceTypes) {
			return res.send({ success: false, error: { msg: 'Missing input parameter.' } });
		}

		let SerBooking = await models.ServiceBooking.findOne({
			attributes: ['id', 'status', 'services'],
			where: {
				AssetId: req.body.AssetId,
				date: {
					[Op.between]: [moment().startOf('day').toISOString(), moment().endOf('day').toISOString()]
				}
			},
			order: [['id', 'desc']]
		});

		let serviceTypes = [];
		if (req.body.serviceTypes.length) {
			serviceTypes = req.body.serviceTypes.map(x => x);
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'details', 'AccountId', 'plan', 'odo'],
			include: [{
				attributes: ['id'],
				model: models.Account,
				where: {
					AccountIdParent: res.locals.masterAccountId
				},
				required: true
			}],
			where: {
				id: req.body.AssetId
			}
		});

		if (!Asset) {
			return res.send({ success: false, error: { msg: 'Vehicle not found in system.' } });
		}

		if (res.locals.role == "AMCC FTE" && Asset.plan != 2) {
			return res.send({ success: false, error: { msg: 'AMC Captive offer not offered for this vehicle.' } });
		}

		if (res.locals.role == "AMCS FTE" && Asset.plan != 1) {
			return res.send({ success: false, error: { msg: 'AMC Shared offer not offered for this vehicle.' } });
		}

		let AplService = await models.AplService.findOne({
			attributes: ['id', 'services'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			}
		});

		if (!AplService) {
			return res.send({ success: false, error: { msg: 'services not found.' } });
		}

		let Geozone = await models.Geozone.findOne({
			attributes: ['id', 'name', 'zoneCode', 'AccountId', 'center', 'address'],
			where: {
				id: req.body.GeozoneId
			}
		});

		if (!Geozone) {
			return res.send({ success: false, error: { msg: 'Geozone not found.' } });
		}

		let vehicleServiceSchedules = await models.VehicleServiceSchedule.findAll({
			attributes: ['id', 'nextServiceInMonth', 'VehicleServiceTypeId', 'alertThresholdInKm', 'nextServiceInKm', 'frequencyInKm', 'frequencyInMonth', 'serviceBasedOn', 'alertThresholdInDays', 'jobCardStatus'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			}
		});

		let AplJobCard = await models.AplJobCard.findOne({
			attributes: ['id', 'AssetId', 'services', 'status', 'workshop'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			},
			order: [['id', 'desc']]
		});

		let jobcardStatus = '';
		if (AplJobCard) {
			switch (AplJobCard.status) {
				case 0:
					jobcardStatus = 'Pending';
					break;
				case 1:
					jobcardStatus = 'Approved';
					break;
				case 2:
					jobcardStatus = 'Closed';
					break;
				default:
					break;
			}
		}

		let services = [];
		let serviceTypeIds = [];
		let assetOdo = Asset.odo && Asset.odo / 1000 || '';
		let serviceValidation = false;
		for (const serviceType of serviceTypes) {
			let matchService = AplService.services.find(x => x.sNo == serviceType);
			if (matchService) {
				if (matchService.ServiceTypeId) {
					serviceTypeIds.push(parseInt(matchService.ServiceTypeId));
				}
				if (matchService.sub && matchService.sub.length) {
					matchService.sub.map(x => serviceTypeIds.push(parseInt(x.ServiceTypeId)));
				}
				let schedule = vehicleServiceSchedules && vehicleServiceSchedules.find(x => x.VehicleServiceTypeId == matchService.ServiceTypeId) || {};
				if (schedule && schedule.serviceBasedOn == "ODO" && schedule.frequencyInKm) {
					//Vehicle ODO < Next Service KM and Alert KM > Remaining KM from next service KM
					if (schedule.nextServiceInKm && Number(assetOdo) <= Number(schedule.nextServiceInKm) && Number(schedule.alertThresholdInKm) >= Number(schedule.nextServiceInKm - assetOdo)) {
						serviceValidation = true;
					} else if (schedule.nextServiceInKm && Number(assetOdo) >= Number(schedule.nextServiceInKm)) { //Vehicle ODO > Next Service KM
						serviceValidation = true;
					} else {
						//Alert trigger if service alert days reached
						let nextServiceInDays = "";
						let showAlert = false;
						if (schedule.nextServiceInMonth) { //convert next serivce month to days
							nextServiceInDays = moment(schedule.nextServiceInMonth).diff(moment(), 'days');
							showAlert = true;
						}
						if (showAlert && schedule.frequencyInMonth && schedule.alertThresholdInDays && nextServiceInDays >= 0 && nextServiceInDays <= schedule.alertThresholdInDays) {
							serviceValidation = true;
						} else if (showAlert && nextServiceInDays < 0 && schedule.alertThresholdInDays && schedule.frequencyInMonth && schedule.alertThresholdInDays >= nextServiceInDays) {
							serviceValidation = true;
						}
					}
					let PrimaryCVzone = await avolveHelper.getGeozoneByCustomer(Asset.AccountId, null, res.locals.masterAccountId);
					if (PrimaryCVzone && PrimaryCVzone.success) {
						PrimaryCVzone = PrimaryCVzone.result || {};
					}

					if (AplJobCard) {
						let matchedService = AplJobCard.services.find(x => x.ServiceTypeId == schedule.VehicleServiceTypeId);
						if ([0, 1, 2].includes(AplJobCard.status) && matchedService) {
							return res.send({ success: false, error: { msg: `${Asset.lplate || ''} already exists in the ${jobcardStatus} section of the job card at ${AplJobCard.workshop && AplJobCard.workshop.name || ''}. Please close it to proceed with the ad-hoc service.` } });
						}
					}
					if (serviceValidation) {
						if (req.body.GeozoneId != (PrimaryCVzone && PrimaryCVzone.id)) {
							return res.send({ success: false, error: { msg: 'This Service is pending in Service Alert / Missed Alert / Missed Service Scheduled for Primary FTE. Please Call primary FTE to schedule these alerts.', call: PrimaryCVzone.fte && PrimaryCVzone.fte.mobile || '' } });
						}
						return res.send({ success: false, error: { msg: 'This Service is pending in Service Alert / Missed Alert / Missed Service Scheduled. Please check & schedule from mentioned sections.' } });
					}
				}
				//#endregion
				services.push(matchService);
			}
		}

		services = services.sort(function (a, b) { return a.sNo - b.sNo }); //Order services by serial number

		if (!AplJobCard) {
			if (!services.find(x => x.serviceName == "Onboarding Service")) {
				return res.send({ success: false, error: { msg: 'Please select onboarding service to proceed.' } });
			}
		}

		let autoCloseExBooking = false;
		let hasBookingAvail = {};
		let onbService = {};
		if (services.find(x => x.serviceName == "Onboarding Service")) {
			if (AplJobCard && AplJobCard.services.length) { //Check if onboarding service available in jobcard
				let matchService = AplJobCard.services.find(x => x.serviceName == "Onboarding Service");
				if (matchService) {
					return res.send({ success: false, error: { msg: `Onboarding service already ${AplJobCard.status > 1 ? 'completed' : 'found in jobcard'} for this vehicle.` } });
				}
			}

			hasBookingAvail = await models.ServiceBooking.findOne({
				attributes: ['id', 'status', 'date', 'services', 'geozone'],
				where: {
					AssetId: Asset.id
				},
				order: [['id', 'desc']]
			});

			if (hasBookingAvail && hasBookingAvail.services) {
				onbService = hasBookingAvail.services.find(x => x.serviceName == "Onboarding Service");
				if (onbService) {
					if (res.locals.role.split(' ')[0] == 'FTE') {
						if (Geozone) {
							return res.send({ success: false, error: { msg: `Onboarding service booking request already found on ${moment(hasBookingAvail.date).format('DD/MM/YYYY')} for ${Geozone.name || 'Requested CV Zone'}.` } });
						}
						return res.send({ success: false, error: { msg: `Onboarding service booking request already found on ${moment(hasBookingAvail.date).format('DD/MM/YYYY')} for this vehicle.` } });
					} else if (res.locals.role.split(' ')[1] == 'FTE' && hasBookingAvail.status == 4 && hasBookingAvail.geozone && (hasBookingAvail.geozone.id == req.body.GeozoneId) && moment().isBefore(moment(hasBookingAvail.date).endOf('day'))) {
						return res.send({ success: false, error: { msg: `Onboarding service request already exists for the scheduled CV zone. Please approve to proceed.` } });
					} else {
						autoCloseExBooking = true;
					}
				}
			}
		}

		if (SerBooking && SerBooking.status != 3 && !onbService) {
			let matchServices = SerBooking.services.filter(x => serviceTypeIds.indexOf(parseInt(x.ServiceTypeId)) > -1);
			if (matchServices.length) {
				return res.send({ success: false, error: { msg: `Services ${matchServices.map(x => x.serviceName).join(', ') || ""} already found in booking.` } });
			}
		}

		let activeBookings = await models.ServiceBooking.findAll({
			attributes: ['id', 'services', 'geozone'],
			where: {
				AssetId: Asset.id,
				status: [0, 1]
			}
		});

		if (activeBookings && activeBookings.length) {
			for (const booking of activeBookings) {
				for (const service of booking.services) {
					let matchedService = services.find(x => x.serviceName == service.serviceName);
					if (matchedService) {
						return res.send({ success: false, error: { msg: `One of the requested service is already found in service scheduled section for ${booking.geozone && booking.geozone.name || 'Requested CV Zone'}.` } });
					}
				}
			}
		}

		let asset = {
			id: Asset.id,
			lplate: Asset.lplate,
			wheeler: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.wheeler || "",
			config: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.config || "",
			name: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.name || "",
			gateIn: moment().toISOString()
		}

		let geozone = {
			id: Geozone.id,
			name: Geozone.name,
			code: Geozone.zoneCode,
			center: Geozone.center,
			city: Geozone.city,
			workshopType: 'Primary',
			address: Geozone.address
		}

		let user = {
			createdBy: {
				id: res.locals.UserId,
				name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
				username: res.locals.username,
				role: res.locals.role,
				date: moment().toISOString(),
				schDate: moment().toISOString()
			}
		};

		let log = { createdBy: [user.createdBy] };

		let ServiceBooking = await models.ServiceBooking.create({
			date: moment().toISOString(),
			asset: asset,
			geozone: geozone,
			status: 1,
			type: 1,
			user: user,
			log: log,
			AccountId: Asset.AccountId,
			GeozoneId: Geozone.id,
			AssetId: Asset.id,
			services: services
		});

		if (services.length) {//TODO: Need to check if alert removes from alert section
			await models.VehicleServiceSchedule.update({
				jobCardStatus: 0
			}, {
				where: {
					AssetId: Asset.id,
					AccountId: Asset.AccountId,
					VehicleServiceTypeId: serviceTypeIds
				}
			});
		}

		if (autoCloseExBooking && hasBookingAvail) {
			evt.events.emit('avolve-missedBooking-auto-close', {
				BookingId: hasBookingAvail.id,
				AccountId: ServiceBooking.AccountId,
				reason: 'New adhoc onboarding request created by FTE'
			});
		}

		evt.events.emit('apl-reportlog', { //TODO: need to check if emit needed
			AccountId: ServiceBooking.AccountId,
			reportValues: ['ss'],
			month: moment(ServiceBooking.date).format('MM'),
			year: moment(ServiceBooking.date).format('YYYY')
		});

		if (Asset.plan == 1) {
			evt.events.emit('apl-fte-serviceSummary', {
				AccountId: res.locals.masterAccountId,
				plan: 1,
				month: moment(ServiceBooking.date).format('MM'),
				year: moment(ServiceBooking.date).format('YYYY')
			});
		}

		return res.send({ success: true, servicebooking: ServiceBooking });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Error creating service booking.`);
		return res.send({ success: false, error: { msg: "Error creating adhoc service booking." } });
	}
}

exports.onboardingRequest = async function (req, res) {
	const ROUTE = 'app/servicebookings/onboardingRequest';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (['AMCS FTE', 'AMCC FTE', 'FM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.body.AssetId || !req.body.GeozoneId || !req.body.serviceTypes || !req.body.date) {
			return res.send({ success: false, error: 'Missing input parameter.' });
		}

		if (!moment(req.body.date, 'DD/MM/YYYY').day()) { //Check if it is sunday
			return res.send({ success: false, error: 'Onboarding service restricted for Sunday.' });
		}

		let serviceTypes = [];
		if (req.body.serviceTypes.length) {
			serviceTypes = req.body.serviceTypes.map(x => x);
		}

		if (serviceTypes.length > 1 || serviceTypes.find(x => x != '1')) {
			return res.send({ success: false, error: 'Only onboarding service is allowed to schedule.' });
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'details', 'AccountId', 'plan'],
			include: [{
				attributes: ['id'],
				model: models.Account,
				where: {
					AccountIdParent: res.locals.masterAccountId
				},
				required: true
			}],
			where: {
				id: req.body.AssetId
			}
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Vehicle not found in system.' });
		}

		let hasBookingAvail = await models.ServiceBooking.findOne({
			attributes: ['id', 'status', 'date', 'services', 'geozone'],
			where: {
				AssetId: Asset.id
			},
			order: [['id', 'desc']]
		});

		let Geozone = await models.Geozone.findOne({
			attributes: ['id', 'name', 'city', 'zoneCode', 'AccountId', 'center', 'address'],
			where: {
				id: req.body.GeozoneId
			}
		});

		if (!Geozone) {
			return res.send({ success: false, error: 'Requested CV Zone not found in system.' });
		}

		let autoCloseExBooking = false;
		if (hasBookingAvail && hasBookingAvail.services) {
			let matchService = hasBookingAvail.services.find(x => x.serviceName == "Onboarding Service");
			if (matchService) {
				if (res.locals.role == 'FM') {
					if (Geozone) {
						return res.send({ success: false, error: `Onboarding service booking request already found on ${moment(hasBookingAvail.date).format('DD/MM/YYYY')} for ${Geozone.name || 'Requested CV Zone'}.` });
					}
					return res.send({ success: false, error: `Onboarding service booking request already found on ${moment(hasBookingAvail.date).format('DD/MM/YYYY')} for this vehicle.` });
				} else if (res.locals.role.split(' ')[1] == 'FTE' && hasBookingAvail.status == 4 && hasBookingAvail.geozone && (hasBookingAvail.geozone.id == req.body.GeozoneId) && moment().isBefore(moment(hasBookingAvail.date).endOf('day'))) {
					return res.send({ success: false, error: `Onboarding service request already exists for the scheduled CV zone. Please approve to proceed.` });
				} else {
					autoCloseExBooking = true;
				}
			}
		}

		let reqCv = {};
		if (req.query.GeozoneId) {
			reqCv = await models.Geozone.findOne({
				attributes: ['id', 'name', 'city', 'zoneCode', 'AccountId', 'center', 'address'],
				where: {
					id: req.query.GeozoneId
				}
			});
		}

		let status = 4;
		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			if (!geozoneResult.success) {
				RaiseLogEvent(ROUTE, 'error', geozoneResult.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			res.GeozoneId = geozoneResult.geozones.map(x => x.id);
			let result = await avolveHelper.fetchCustomers(res);
			let accountIds = result.customers && result.customers.length && result.customers.map(x => x.id) || [];
			let hasPrimaryCvCust = accountIds.find(x => x == Asset.AccountId);
			if (!hasPrimaryCvCust) {
				return res.send({ success: false, error: 'Only Primary CV FTE allowed to request onboarding service for this vehicle.' });
			}
			if (geozoneResult.geozones.find(x => x.id == Geozone.id)) { //If selected cv is primary cv (Direct approval)
				status = 0;
			}
		}

		if (res.locals.role == "AMCC FTE") {
			let hasPrimaryCvCust = res.locals.accountIds.find(x => x == Asset.AccountId);
			if (!hasPrimaryCvCust) {
				return res.send({ success: false, error: 'Only Primary CV FTE allowed to request onboarding service for this vehicle.' });
			}
			status = 0;
		}

		let AplJobCard = await models.AplJobCard.findOne({
			attributes: ['id', 'AssetId', 'services', 'status'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			}
		});

		if (AplJobCard && AplJobCard.services.length) {
			let matchService = AplJobCard.services.find(x => x.serviceName == "Onboarding Service");
			if (matchService) {
				return res.send({ success: false, error: `Onboarding service already ${AplJobCard.status > 1 ? 'completed' : 'found in jobcard'} for this vehicle.` });
			}
		}

		let AplService = await models.AplService.findOne({
			attributes: ['id', 'services'],
			where: {
				AssetId: Asset.id,
				AccountId: Asset.AccountId
			}
		});

		if (!AplService) {
			return res.send({ success: false, error: 'Service master missing for this vehicle.' });
		}

		let services = [];
		let serviceTypeIds = [];
		for (const serviceType of serviceTypes) {
			let matchService = AplService.services.find(x => x.sNo == serviceType);
			if (matchService) {
				if (matchService.ServiceTypeId) {
					serviceTypeIds.push(parseInt(matchService.ServiceTypeId));
				}
				if (matchService.sub && matchService.sub.length) {
					matchService.sub.map(x => serviceTypeIds.push(parseInt(x.ServiceTypeId)));
				}
				services.push(matchService);
			}
		}

		let asset = {
			id: Asset.id,
			lplate: Asset.lplate,
			wheeler: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.wheeler || "",
			config: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.config || "",
			name: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.name || ""
		}

		let geozone = {
			id: Geozone.id,
			name: Geozone.name,
			code: Geozone.zoneCode,
			center: Geozone.center,
			city: Geozone.city,
			type: status == 4 && 'Secondary' || 'Primary',
			address: Geozone.address
		}

		let user = {
			createdBy: {
				id: res.locals.UserId,
				name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
				username: res.locals.username,
				role: res.locals.role,
				date: moment().toISOString(),
				schDate: moment(req.body.date, 'DD/MM/YYYY').toISOString()
			}
		};

		user.requestedBy = {
			id: res.locals.UserId,
			name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
			username: res.locals.username,
			role: res.locals.role,
			date: moment().toISOString(),
			schDate: moment(req.body.date, 'DD/MM/YYYY').toISOString()
		}

		let log = {};
		log.createdBy = [user.createdBy];
		if (res.locals.role == "FM") {
			log.requestedBy = [user.requestedBy];
			//#region primary/secondary assignment
			geozone.type = 'Primary';
			res.GeozoneId = Geozone.id;
			res.AccountId = res.locals.masterAccountId;
			let result = await avolveHelper.fetchCustomers(res);
			let accountIds = result.customers && result.customers.length && result.customers.map(x => x.id) || [];
			let hasPrimaryCvCust = accountIds.find(x => x == Asset.AccountId);
			if (!hasPrimaryCvCust) {
				geozone.type = 'Secondary';
			}
			//#endregion
		} else {
			if (reqCv) {
				log.requestedBy = [{
					id: reqCv.id,
					name: `${reqCv.name}, ${reqCv.city}`,
					date: moment().toISOString()
				}]
			}
		}

		let ServiceBooking = await models.ServiceBooking.create({
			date: moment(req.body.date, 'DD/MM/YYYY').toISOString(),
			asset: asset,
			geozone: geozone,
			status: status,
			type: 0,
			user: user,
			log: log,
			AccountId: Asset.AccountId,
			GeozoneId: Geozone.id,
			AssetId: Asset.id,
			services: services
		});

		if (autoCloseExBooking && hasBookingAvail) {
			evt.events.emit('avolve-missedBooking-auto-close', {
				BookingId: hasBookingAvail.id,
				AccountId: ServiceBooking.AccountId,
				reason: 'New adhoc onboarding request created by FTE'
			});
		}

		//Emit to report
		evt.events.emit('apl-reportlog', {
			AccountId: ServiceBooking.AccountId,
			reportValues: ['ss'],
			month: moment(ServiceBooking.date).format('MM'),
			year: moment(ServiceBooking.date).format('YYYY')
		});

		if (Asset.plan == 1) {
			evt.events.emit('apl-fte-serviceSummary', {
				AccountId: res.locals.masterAccountId,
				plan: 1,
				month: moment(ServiceBooking.date).format('MM'),
				year: moment(ServiceBooking.date).format('YYYY')
			});
		}

		return res.send({ success: true, servicebooking: ServiceBooking });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, "Error creating onboarding service request.");
		return res.send({ success: false, error: "Error creating onboarding service request." });
	}
}

exports.listByStatus = async function (req, res) {
	const ROUTE = 'app/servicebookings/listByStatus';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.query, `Requested by ${res.locals.username}`);

		//#region validations & workshop, customer access
		if (['AMCS FTE', 'AMCC FTE', 'FM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized', results: [] });
		}

		if (res.locals.role != "FM" && !req.query.GeozoneId) {
			return res.send({ success: false, error: "Please select workshop and proceed." });
		}

		let whereClause = {
			status: 0
		}

		if (req.query.status == 0) {//scheduled screen
			whereClause.date = {
				[Op.gt]: moment().subtract(1, 'day').format('YYYY-MM-DD')
			}
		}

		if (req.query.status > 0) {//Arrived screen
			whereClause.status = req.query.status;
		}

		if (req.query.sdate && req.query.edate) {
			// sdate/edate arrive as ISO UTC strings from frontend
			const startDate = moment(req.query.sdate).startOf('day').toISOString();
			const endDate = moment(req.query.edate).endOf('day').toISOString();
			whereClause.date = { [Op.between]: [startDate, endDate] };
		}

		if (res.locals.role == "FM") {
			whereClause.AccountId = res.locals.AccountId;
		} else {
			if (req.query.status == 0) {
				whereClause.status = [0, 4];
			}
			if (res.locals.role == "AMCC FTE") {
				whereClause.GeozoneId = req.query.GeozoneId;
				whereClause.AccountId = res.locals.accountIds;
			}
		}

		let accountIds = [];
		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			if (!geozoneResult.success) {
				RaiseLogEvent(ROUTE, 'error', geozoneResult.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			res.GeozoneId = geozoneResult.geozones.map(x => x.id);
			if (req.query.GeozoneId) {
				res.GeozoneId = req.query.GeozoneId;
			}
			let result = await avolveHelper.fetchCustomers(res);
			if (result.customers && result.customers.length) {
				result.customers.map(x => accountIds.push(x.id));
			}
		}
		//#endregion

		let ServiceBookings = await models.ServiceBooking.findAll({
			where: whereClause
		});

		let assetIds = ServiceBookings.map(x => x.AssetId);

		var histSql = `
			select
				distinct on (I."ServiceBookingId") I."ServiceBookingId", I."date", I."AssetId", I."details"
			from
				"Inspections" I
				left join "Assets" A on I."AssetId" = A."id"
			where
				I."AssetId" in (:AssetId) and
				I."type" = :type
			order by
				I."ServiceBookingId", I."date" desc`;

		let vehInspectHistories = await models.sequelize.query(histSql, {
			replacements: {
				AssetId: assetIds.length && assetIds || null,
				type: 'v'
			},
			type: models.sequelize.QueryTypes.SELECT
		});

		let vehDraftInspectHistories = await models.sequelize.query(histSql, {
			replacements: {
				AssetId: assetIds.length && assetIds || null,
				type: 'vd'
			},
			type: models.sequelize.QueryTypes.SELECT
		});

		let tyreVerificationHistories = await models.sequelize.query(histSql, {
			replacements: {
				AssetId: assetIds.length && assetIds || null,
				type: 'tv'
			},
			type: models.sequelize.QueryTypes.SELECT
		});

		let tyreInspectHistories = await models.sequelize.query(histSql, {
			replacements: {
				AssetId: assetIds.length && assetIds || null,
				type: 't'
			},
			type: models.sequelize.QueryTypes.SELECT
		});

		let results = [];
		for (const ServiceBooking of ServiceBookings) {
			let result = JSON.parse(JSON.stringify(ServiceBooking));
			let vehInspection = vehInspectHistories.find(x => x.ServiceBookingId == ServiceBooking.id && x.AssetId == result.AssetId);
			let vehDraftInspection = vehDraftInspectHistories.find(x => x.ServiceBookingId == ServiceBooking.id && x.AssetId == result.AssetId);
			let tyreVerification = tyreVerificationHistories.find(x => x.ServiceBookingId == ServiceBooking.id && x.AssetId == result.AssetId);
			let tyreInspection = tyreInspectHistories.find(x => x.ServiceBookingId == ServiceBooking.id && x.AssetId == result.AssetId);
			result.vehicleInspection = false;
			result.reschedule = false;
			result.gateIn = false;
			if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) > -1) {
				if (req.query.GeozoneId == result.GeozoneId && result.status == 0) {
					result.gateIn = true;
				}
			}
			if (result.status == 0) {
				if (result.user && result.user.requestedBy && result.user.requestedBy.id) {
					if (result.user.requestedBy.id == res.locals.UserId) { //only requested user can access reschedule option
						result.reschedule = true;
					}
				}
			}
			if (result.status > 0 && (result.asset && result.asset.gateIn)) {
				if (vehInspection && moment(vehInspection.date).isAfter(moment(result.asset.gateIn))) {
					let InitateJobCard = await getInspectionStatus(ServiceBooking.services, { vehInspection, vehDraftInspection, tyreVerification, tyreInspection });
					if (InitateJobCard) {
						result.vehicleInspection = true;
					}
				}
				if (vehDraftInspection && moment(vehDraftInspection.date).isAfter(moment(result.asset.gateIn))) {
					let InitateJobCard = await getInspectionStatus(ServiceBooking.services, { vehInspection, vehDraftInspection, tyreVerification, tyreInspection });
					if (InitateJobCard) {
						result.vehicleInspection = true;
					}
				}
			}
			if (res.locals.role == "AMCS FTE") {
				let matchCust = accountIds.find(x => x == result.AccountId);
				if (matchCust && result.status == 0) {
					results.push(result);
				} else {
					if (result.GeozoneId == req.query.GeozoneId) {
						results.push(result);
					}
				}
			} else {
				results.push(result);
			}
		}

		return res.send({ success: true, results: results });

	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Error fetching booking list`);
		return res.send({ success: false, error: "Error fetching booking list." });
	}
}

async function getInspectionStatus(services, InspectionData) {
	let { vehInspection, vehDraftInspection, tyreVerification, tyreInspection } = InspectionData;
	let isonbService = services.find(x => x.serviceName == 'Onboarding Service');
	let initiateJobCard = false;

	// Inspections under  72hrs window check
	let validTill = moment().subtract(72, 'hours');
	let latestVehInspection = vehInspection && vehInspection.date && moment(vehInspection.date).isAfter(moment(validTill));
	let latestVehDraftInspection = vehDraftInspection && vehDraftInspection.date && moment(vehDraftInspection.date).isAfter(moment(validTill));
	let latestTyreVerification = tyreVerification && tyreVerification.date && moment(tyreVerification.date).isAfter(moment(validTill));
	let latestTyreInspection = tyreInspection && tyreInspection.date && moment(tyreInspection.date).isAfter(moment(validTill));

	if (vehDraftInspection && isonbService && latestVehDraftInspection) {
		initiateJobCard = true;
	}
	if (tyreVerification && vehDraftInspection && (tyreVerification.details && tyreVerification.details.skipTyreInspection == true)) {
		if (latestVehDraftInspection && latestTyreVerification) {
			if (moment(tyreVerification.date).isAfter(moment(vehDraftInspection.date))) {
				initiateJobCard = true;
			}
		}
	}
	if (vehInspection && tyreVerification && tyreInspection) {
		if (latestVehInspection && latestTyreVerification && latestTyreInspection) {
			if (moment(tyreVerification.date).isAfter(moment(vehInspection.date)) && moment(tyreInspection.date).isAfter(moment(vehInspection.date))) {
				initiateJobCard = true;
			}
		}
	}
	return initiateJobCard;
}

exports.missedListDownload = async function (req, res) {
	const ROUTE = 'app/servicebookings/missedListDownload';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.query, `Requested by ${res.locals.username}`);

		//#region validations & workshop, customer access
		if (['AMCS FTE', 'AMCC FTE', 'FM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized', results: [] });
		}

		if (res.locals.role != "FM" && !req.query.GeozoneId) {
			return res.send({ success: false, error: "Please select workshop and proceed." });
		}

		let startDate, endDate;
		if (!req.query.sdate || !req.query.edate) {
			startDate = null;
			endDate = moment().subtract(1, 'day').endOf('day').toISOString();
		} else {
			startDate = moment(req.query.sdate).startOf('day').toISOString();
			endDate = moment(req.query.edate).endOf('day').toISOString();
		}

		let whereClause = { //TODO: Need to check if adhoc need to include
			type: [0, 1],
			status: [0, 1, 4], //Scheduled, Arrived, PendingApproval
			date: {
				[Op.lte]: moment().subtract(1, 'day').endOf('day')
			}
		};

		if (res.locals.role == "FM") {
			whereClause.AccountId = res.locals.AccountId;
		}

		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			if (!geozoneResult.success) {
				RaiseLogEvent(ROUTE, 'error', geozoneResult.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			res.GeozoneId = geozoneResult.geozones.map(x => x.id);
			if (req.query.GeozoneId) {
				res.GeozoneId = req.query.GeozoneId;
			}
			let result = await avolveHelper.fetchCustomers(res);
			whereClause.AccountId = result.customers && result.customers.length && result.customers.map(x => x.id) || [];
		}

		if (res.locals.role == "AMCC FTE") {
			whereClause.AccountId = res.locals.accountIds;
		}

		//#region missed alerts from bookings
		let ServiceBookings = await models.ServiceBooking.findAll({
			where: whereClause
		});

		let results = [];
		for (const ServiceBooking of ServiceBookings) {
			let due = moment(ServiceBooking.date).startOf('day');
			if (startDate && endDate) {
				if (!(due.isSameOrAfter(moment(startDate)) && due.isSameOrBefore(moment(endDate)))) {
					continue;
				}
			}
			for (const service of ServiceBooking.services) {
				service.date = moment(ServiceBooking.date).format('DD/MM/YYYY');
			};
			let bookingResult = {
				id: ServiceBooking.id,
				booking: true,
				type: ServiceBooking.type,
				date: ServiceBooking.date,
				dueDays: moment().diff(moment(ServiceBooking.date), 'days'),
				dueDate: moment(ServiceBooking.date).format('DD/MM/YYYY'),
				services: ServiceBooking.services,
				asset: ServiceBooking.asset,
				status: ServiceBooking.status,
				AssetId: ServiceBooking.AssetId,
				AccountId: ServiceBooking.AccountId,
				GeozoneId: ServiceBooking.GeozoneId,
				user: ServiceBooking.user
			}
			results.push(bookingResult);
		}
		//#endregion

		//#region missed alerts from service schedules
		let schedules = await models.VehicleServiceSchedule.findAll({
			attributes: {
				exclude: ['jobCardStatus', 'isActive', 'profile', 'VehicleModelId', 'createdAt', 'updatedAt']
			},
			include: [{
				attributes: ['id', 'lplate', 'details'],
				model: models.Asset,
				where: {
					'details.allTyresOnb': true
				},
				required: true
			},
			{
				attributes: ["id", "componentName", "serviceName", "profile"],
				model: models.VehicleServiceType
			}],
			where: {
				isActive: true,
				AccountId: whereClause.AccountId,
				AssetId: { [Op.ne]: null },
				nextServiceInMonth: {
					[Op.lt]: moment().subtract(1, 'day').toISOString()
				},
				frequencyInKm: { [Op.gt]: 0 },
				[Op.or]: [
					{ jobCardStatus: [3, 4] },
					{ jobCardStatus: null },
				]
			}
		});

		let uniqAssets = [... new Set(schedules.map(x => x.AssetId))];
		for (const AssetId of uniqAssets) {
			let schByAssets = schedules.filter(x => x.AssetId == AssetId);
			let services = [];
			for (const schedule of schByAssets) {
				let due = moment(schedule.nextServiceInMonth).startOf('day');
				if (startDate && endDate) {
					if (!(due.isSameOrAfter(moment(startDate)) && due.isSameOrBefore(moment(endDate)))) {
						continue;
					}
				}
				let triggeredDate = due.clone().subtract(schedule.alertThresholdInDays, 'days');
				let service = {};
				service.id = schedule.id;
				service.VehicleServiceTypeId = schedule.VehicleServiceTypeId;
				service.componentName = schedule.VehicleServiceType && schedule.VehicleServiceType.componentName || "";
				service.serviceName = schedule.VehicleServiceType && schedule.VehicleServiceType.serviceName || "";
				service.AccountId = schedule.AccountId;
				service.AssetId = schedule.AssetId;
				service.triggeredDate = moment(triggeredDate).format('DD/MM/YYYY');
				service.alertMissedDate = due ? moment(due).add(1, 'day').format('DD/MM/YYYY') : '',
					service.date = schedule.nextServiceInMonth;
				services.push(service);
			}
			services = services.sort((a, b) => a.date - b.date);
			if (services.length) {
				let axleProfile = schByAssets[0].Asset && schByAssets[0].Asset.details && schByAssets[0].Asset.details.axleProfile || {};
				let asset = {
					id: schByAssets[0].AssetId,
					name: axleProfile && axleProfile.name || "",
					config: axleProfile && axleProfile.config || "",
					lplate: schByAssets[0].Asset && schByAssets[0].Asset.lplate || "",
					wheeler: axleProfile && axleProfile.wheeler || ""
				}
				let schResult = {
					id: null,
					booking: false,
					type: 0,
					date: services[0].date,
					dueDays: moment().diff(moment(services[0].date), 'days'),
					dueDate: moment(services[0].date).format('DD/MM/YYYY'),
					services: services,
					asset: asset,
					status: 0,
					AssetId: services[0].AssetId,
					AccountId: services[0].AccountId,
					GeozoneId: null
				}
				results.push(schResult);
			}
		}
		//#endregion

		if (req.query && req.query.excel && req.query.excel == "true") {
			let workbook = await missedAlertsExcel(results, req, res);
			return workbook;
		} else {
			return res.send({ success: true, results: results });
		}

	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Error fetching booking list`);
		return res.send({ success: false, error: "Error fetching booking list." });
	}
}

exports.missedList = async function (req, res) {
	const ROUTE = 'app/servicebookings/missedList';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.query, `Requested by ${res.locals.username}`);

		//#region validations & workshop, customer access
		if (['AMCS FTE', 'AMCC FTE', 'FM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized', results: [] });
		}

		if (res.locals.role != "FM" && !req.query.GeozoneId) {
			return res.send({ success: false, error: "Please select workshop and proceed." });
		}

		let startDate, endDate;
		if (!req.query.sdate || !req.query.edate) {
			startDate = null;
			endDate = moment().subtract(1, 'day').endOf('day').toISOString();
		} else {
			startDate = moment(req.query.sdate).startOf('day').toISOString();
			endDate = moment(req.query.edate).endOf('day').toISOString();
		}

		let excel = false;
		if (req.query && req.query.excel && req.query.excel == "true") {
			excel = true;
		}

		let whereClause = {
			type: [0, 1],
			status: [0, 1, 4], //Scheduled, Arrived, PendingApproval
			date: {
				[Op.lte]: moment().subtract(1, 'day').endOf('day')
			}
		};

		let AccountId = res.locals.AccountId;
		//#region fetch customer for FTE's
		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			if (!geozoneResult.success) {
				RaiseLogEvent(ROUTE, 'error', geozoneResult.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			res.GeozoneId = geozoneResult.geozones.map(x => x.id);
			if (req.query.GeozoneId) {
				res.GeozoneId = req.query.GeozoneId;
			}
			let result = await avolveHelper.fetchCustomers(res);
			AccountId = result.customers && result.customers.length && result.customers.map(x => x.id) || [];
		}

		if (res.locals.role == "AMCC FTE") {
			AccountId = res.locals.accountIds;
		}
		whereClause.AccountId = AccountId;
		//#endregion

		let Accounts = [], FMUsers = [];
		let accountsResult = await avolveHelper.getAvolveAccFMUser(AccountId, res.locals.masterAccountId);
		if (accountsResult && accountsResult.success) {
			Accounts = accountsResult.result && accountsResult.result.Accounts || [];
			FMUsers = accountsResult.result && accountsResult.result.FMUsers || [];
		}

		//#region missed alerts from bookings
		let ServiceBookings = await models.ServiceBooking.findAll({
			where: whereClause
		});
		//#endregion

		//#region missed alerts from service schedules
		let schedules = [];
		if (req.query.isSchedule && req.query.isSchedule == 'false') {//This is used for missed service alert screen
			schedules = await models.VehicleServiceSchedule.findAll({
				attributes: {
					exclude: ['jobCardStatus', 'isActive', 'profile', 'VehicleModelId', 'createdAt', 'updatedAt']
				},
				include: [{
					attributes: ['id', 'lplate', 'details'],
					model: models.Asset,
					where: {
						'details.allTyresOnb': true
					},
					required: true
				},
				{
					attributes: ["id", "componentName", "serviceName", "profile"],
					model: models.VehicleServiceType
				}],
				where: {
					isActive: true,
					AccountId: whereClause.AccountId,
					AssetId: { [Op.ne]: null },
					nextServiceInMonth: {
						[Op.lt]: moment().subtract(1, 'day').toISOString()
					},
					frequencyInKm: { [Op.gt]: 0 },
					[Op.or]: [
						{ jobCardStatus: [3, 4] },
						{ jobCardStatus: null },
					]
				}
			});
		}
		//#endregion

		let results = [];
		for (const Account of Accounts) {
			let matchedFMUser = FMUsers[Account.id] || {};
			let result = !excel && {
				id: Account.id,
				name: Account.tname,
				fmName: matchedFMUser && `${matchedFMUser.firstName || ''} ${matchedFMUser.lastName || ''}`.trim() || "",
				phone: matchedFMUser && matchedFMUser.mobile || '',
				alerts: []
			} || {};

			if (req.query.isSchedule && req.query.isSchedule == 'true') {
				let mactchedBooking = ServiceBookings.filter(x => x.AccountId == Account.id);
				for (const ServiceBooking of mactchedBooking) {
					let due = moment(ServiceBooking.date).startOf('day');
					if (startDate && endDate) {
						if (!(due.isSameOrAfter(moment(startDate)) && due.isSameOrBefore(moment(endDate)))) {
							continue;
						}
					}
					for (const service of ServiceBooking.services) {
						service.date = moment(ServiceBooking.date).format('DD/MM/YYYY');
					};
					let bookingResult = {
						id: ServiceBooking.id,
						booking: true,
						type: ServiceBooking.type,
						date: ServiceBooking.date,
						dueDays: moment().diff(moment(ServiceBooking.date), 'days'),
						dueDate: moment(ServiceBooking.date).format('DD/MM/YYYY'),
						services: ServiceBooking.services,
						asset: ServiceBooking.asset,
						status: ServiceBooking.status,
						AssetId: ServiceBooking.AssetId,
						AccountId: ServiceBooking.AccountId,
						GeozoneId: ServiceBooking.GeozoneId,
						user: ServiceBooking.user
					}
					if (excel) {
						results.push(bookingResult);
					} else {
						result.alerts.push(bookingResult);
					}
				}
			} else {//This is used for missed service alert screen
				let uniqAssets = [... new Set(schedules.map(x => x.AccountId == Account.id && x.AssetId))];
				for (const AssetId of uniqAssets) {
					let schByAssets = schedules.filter(x => x.AssetId == AssetId);
					let services = [];
					for (const schedule of schByAssets) {
						let due = moment(schedule.nextServiceInMonth).startOf('day');
						if (startDate && endDate) {
							if (!(due.isSameOrAfter(moment(startDate)) && due.isSameOrBefore(moment(endDate)))) {
								continue;
							}
						}
						let service = {};
						service.id = schedule.id;
						service.VehicleServiceTypeId = schedule.VehicleServiceTypeId;
						service.componentName = schedule.VehicleServiceType && schedule.VehicleServiceType.componentName || "";
						service.serviceName = schedule.VehicleServiceType && schedule.VehicleServiceType.serviceName || "";
						service.AccountId = schedule.AccountId;
						service.AssetId = schedule.AssetId;
						service.date = schedule.nextServiceInMonth;
						services.push(service);
					}
					services = services.sort((a, b) => a.date - b.date);
					if (services.length) {
						let axleProfile = schByAssets[0].Asset && schByAssets[0].Asset.details && schByAssets[0].Asset.details.axleProfile || {};
						let asset = {
							id: schByAssets[0].AssetId,
							name: axleProfile && axleProfile.name || "",
							config: axleProfile && axleProfile.config || "",
							lplate: schByAssets[0].Asset && schByAssets[0].Asset.lplate || "",
							wheeler: axleProfile && axleProfile.wheeler || ""
						}
						let schResult = {
							id: null,
							booking: false,
							type: 0,
							date: services[0].date,
							dueDays: moment().diff(moment(services[0].date), 'days'),
							dueDate: moment(services[0].date).format('DD/MM/YYYY'),
							services: services,
							asset: asset,
							status: 0,
							AssetId: services[0].AssetId,
							AccountId: services[0].AccountId,
							GeozoneId: null
						}
						if (excel) {
							results.push(schResult);
						} else {
							result.alerts.push(schResult);
						}
					}
				}
			}
			if (!excel && result.alerts && result.alerts.length) {
				results.push(result);
			}
		}

		if (req.query && req.query.excel && req.query.excel == "true") {
			let workbook = await missedAlertsExcel(results, req, res);
			return workbook;
		} else {
			return res.send({ success: true, results: results });
		}

	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Error fetching booking list`);
		return res.send({ success: false, error: "Error fetching booking list." });
	}
}

exports.rejectReasons = async function (req, res) {
	const ROUTE = 'app/servicebookings/rejectReasons';
	try {
		if (!res.locals.role) {
			return res.send({ success: false, error: 'User role missing.' });
		}
		return res.send({ success: true, results: rejectReasons });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching reject reasons');
		return res.send({ success: false, error: 'Error fetching reject reasons.' });
	}
}

exports.get = async function (req, res) {
	const ROUTE = 'app/servicebookings/get ';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.params, `Requested by ${res.locals.username}`);

		//#region validations & workshop, customer access
		if (['AMCS FTE', 'AMCC FTE', 'FM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing input parameter.' });
		}

		if (res.locals.role != "FM" && !req.query.GeozoneId) {
			return res.send({ success: false, error: "Please select workshop and proceed." });
		}

		let whereClause = {
			GeozoneId: req.query.GeozoneId,
			id: req.params.id
		}

		if (res.locals.role == "AMCC FTE") {
			whereClause.AccountId = res.locals.accountIds;
		}

		if (res.locals.role == "FM") {
			delete whereClause.GeozoneId;
			whereClause.AccountId = res.locals.AccountId;
		}

		let ServiceBooking = await models.ServiceBooking.findOne({
			include: [{
				attributes: ['id', 'lplate', 'odo', 'details'],
				model: models.Asset
			}],
			where: whereClause
		});

		if (!ServiceBooking) {
			return res.send({ success: false, error: 'Service booking not found.' });
		}


		let isOnbService = ServiceBooking && ServiceBooking.services.find(x => x.serviceName == 'Onboarding Service') || {};
		let TyreVerificaiton = {};
		if (!isOnbService) {
			TyreVerificaiton = await models.Inspection.findOne({
				attributes: ['id', 'details'],
				where: {
					type: 'tv',
					AssetId: ServiceBooking.AssetId,
					AccountId: ServiceBooking.AccountId,

				},
				order: [['id', 'desc']]
			});

			if (!TyreVerificaiton) {
				return res.send({ success: false, error: 'Tyre Verification not found.' });
			}
		}

		let User = await models.User.findOne({
			attributes: ['id', 'username', 'firstName', 'lastName', 'mobile'],
			include: [{
				attributes: ['name'],
				model: models.UserRole,
				where: {
					name: 'FM',
				}
			}],
			where: {
				AccountId: ServiceBooking.AccountId,
				activeStatus: true
			},
			raw: true
		});

		ServiceBooking = JSON.parse(JSON.stringify(ServiceBooking));
		ServiceBooking.asset.odo = ServiceBooking.Asset.odo;
		ServiceBooking.enrouteServices = TyreVerificaiton && TyreVerificaiton.details && TyreVerificaiton.details.enrouteServices || {};

		ServiceBooking.fleetManager = {};
		if (User) {
			ServiceBooking.fleetManager = User;
		}
		delete ServiceBooking.Asset;

		return res.send({ success: true, result: ServiceBooking });

	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, `Error fetching service booking.`);
		return res.send({ success: false, error: "Error fetching service booking." });
	}
}

exports.reschedule = async function (req, res) {
	const ROUTE = 'app/servicebookings/reschedule ';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.params, `Requested by ${res.locals.username}`);

		if (['AMCS FTE', 'AMCC FTE', 'FM'].indexOf(res.locals.role) == -1 || (res.locals.role != 'FM' && res.locals.AccountId != res.locals.masterAccountId)) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		if (!req.params.id || !req.body.GeozoneId || !req.body.date || req.params.id == "null") {
			return res.send({ success: false, error: "Missing or invalid input parameter" });
		}

		const newDateUTC = parseUTC(req.body.date, res.locals.region || 'IN');
		if (!newDateUTC) return res.send({ success: false, error: 'Invalid date.' });

		if (res.locals.role != "FM" && !req.query.GeozoneId) {
			return res.send({ success: false, error: "Please select workshop and proceed." });
		}

		if (!moment(newDateUTC).utc().day()) { //Check if it is sunday
			return res.send({ success: false, error: 'Rescheduling restricted for Sunday.' });
		}

		let whereClause = {
			id: req.params.id
		}

		let geozoneWhere = {
			id: req.body.GeozoneId
		}

		let ServiceTypeIds = req.body.schedules && req.body.schedules.length && req.body.schedules.filter(x => x.schedule).map(x => parseInt(x.ServiceTypeId)) || [];
		if (!ServiceTypeIds.length) {
			return res.send({ success: false, error: 'Please select atleast one service to proceed.' });
		}

		let missedServiceTypeIds = req.body.schedules && req.body.schedules.length && req.body.schedules.filter(x => !x.schedule).map(x => parseInt(x.ServiceTypeId)) || [];

		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			if (!geozoneResult.success) {
				RaiseLogEvent(ROUTE, 'error', geozoneResult.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			res.GeozoneId = geozoneResult.geozones.map(x => x.id);
			if (req.query.GeozoneId) {
				res.GeozoneId = req.query.GeozoneId;
			}
			let result = await avolveHelper.fetchCustomers(res);
			if (result.customers && result.customers.length) {
				whereClause.AccountId = result.customers.map(x => x.id);
			} else {
				whereClause.AccountId = [];
			}
		}

		if (res.locals.role == "AMCC FTE") {
			whereClause.AccountId = res.locals.accountIds;
			geozoneWhere.AccountId = res.locals.accountIds;
		}

		if (res.locals.role == "FM") {
			whereClause.AccountId = res.locals.AccountId;
		}

		let ServiceBooking = await models.ServiceBooking.findOne({
			attributes: ['id', 'asset', 'status', 'geozone', 'date', 'user', 'log', 'AssetId', 'services', 'type', 'AccountId', 'createdAt'],
			include: [{
				attributes: ['id', 'plan', 'odo'],
				model: models.Asset
			}],
			where: whereClause
		});

		if (!ServiceBooking) {
			return res.send({ success: false, error: "Service booking not found" });
		}

		if (ServiceBooking.user && ServiceBooking.user.requestedBy) {
			if (ServiceBooking.user.requestedBy.id != res.locals.UserId) {
				return res.send({ success: false, error: 'Rescheduling restricted. Service booking is rescheduled only by the initiator.' });
			}
		}

		let services = ServiceBooking.services.filter(x => !(missedServiceTypeIds.includes(parseInt(x.ServiceTypeId)))) || [];
		if (!services) {
			return res.send({ success: false, error: "No services were found to proceed." });
		}

		//#region consumed count validation
		let AplService = await models.AplService.findOne({
			where: {
				AssetId: ServiceBooking.AssetId,
				AccountId: ServiceBooking.AccountId
			}
		});

		if (AplService) {
			let serviceNames = [];
			for (const service of AplService.services) {
				let matchedService = services.find(x => x.serviceName == service.serviceName);
				if (matchedService && Number(service.consumed) >= Number(service.alloted)) {
					serviceNames.push(matchedService.serviceName);
				}
			}
			if (serviceNames && serviceNames.length) {
				return res.send({ success: false, error: `You have reached the maximum allowable count for the '${serviceNames.join(', ')}' service.` });
			}
		}
		//#endregion

		let Geozone = await models.Geozone.findOne({
			attributes: ['id', 'name', 'zoneCode', 'AccountId', 'center', 'address'],
			where: geozoneWhere
		});

		if (!Geozone) {
			return res.send({ success: false, error: 'Geozone not found.' });
		}

		let geozone = {
			id: Geozone.id,
			name: Geozone.name,
			code: Geozone.zoneCode,
			center: Geozone.center,
			address: Geozone.address
		}

		let notes = {
			skipWheelRot: req.body.schedules.some(x => x.isSkipped)
		}

		let user = JSON.parse(JSON.stringify(ServiceBooking.user));

		user.updatedBy = {
			id: res.locals.UserId,
			name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
			username: res.locals.username,
			role: res.locals.role,
			date: moment().toISOString()
		}

		let log = JSON.parse(JSON.stringify(ServiceBooking.log));
		let status = 0;
		user.rescheduledBy = user.updatedBy;
		user.rescheduledBy.schDate = newDateUTC;
		if (log.rescheduledBy && log.rescheduledBy.length) {
			log.rescheduledBy.push(user.rescheduledBy);
		} else {
			log.rescheduledBy = [user.rescheduledBy];
		}
		status = 4;
		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			if (!geozoneResult.success) {
				RaiseLogEvent(ROUTE, 'error', geozoneResult.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			if (geozoneResult.geozones.find(x => x.id == Geozone.id)) { //If selected cv is primary cv (Direct approval)
				status = 0;
			}
		}
		geozone.type = status == 4 && 'Secondary' || 'Primary';

		if (res.locals.role == "AMCC FTE") { // if amcc default primary and schedule
			status = 0;
			geozone.type = 'Primary';
		}

		if (res.locals.role == "FM") {
			//#region primary/secondary assignment
			geozone.type = 'Primary';
			res.GeozoneId = Geozone.id;
			res.AccountId = res.locals.masterAccountId;
			let result = await avolveHelper.fetchCustomers(res);
			let accountIds = result.customers && result.customers.length && result.customers.map(x => x.id) || [];
			let hasPrimaryCvCust = accountIds.find(x => x == (ServiceBooking.Asset && ServiceBooking.Asset.AccountId));
			if (!hasPrimaryCvCust) {
				geozone.type = 'Secondary';
			}
			//#endregion
		}

		let updSerBook = await ServiceBooking.update({
			date: newDateUTC,
			geozone: geozone,
			user: user,
			log: log,
			GeozoneId: Geozone.id,
			services: services,
			status: status,
			notes: notes
		});

		if (missedServiceTypeIds.length) { //reset original status
			await models.VehicleServiceSchedule.update({
				jobCardStatus: null
			}, {
				where: {
					VehicleServiceTypeId: missedServiceTypeIds,
					AssetId: updSerBook.AssetId,
					AccountId: updSerBook.AccountId
				}
			});
		}

		//#region alert schedule
		let AplAlerts = await models.AplAlert.findAll({
			attributes: ['id'],
			where: {
				status: 1,
				type: 1,
				'details.BookingId': updSerBook.id
			},
			order: [['dueDate', 'desc']]
		});

		if (AplAlerts.length) {
			for (const AplAlert of AplAlerts) {
				evt.events.emit('schedule-avolve-service-alert', {
					BookingId: updSerBook.id,
					AccountId: updSerBook.AccountId,
					reschedule: true,
					AplAlertId: AplAlert.id
				});
			}
		}
		//#endregion

		for (const schdeule of req.body.schedules) {
			if (schdeule.isSkipped) {
				evt.events.emit('avolve-update-rotation-serSchp', {//rename
					serviceTypeId: schdeule.ServiceTypeId,
					AssetId: ServiceBooking.AssetId,
					AccountId: ServiceBooking.AccountId,
					sTime: updSerBook.date,
					odo: ServiceBooking.Asset && ServiceBooking.Asset.odo || ''
				});
			}
		}

		//emit to AplReports to sync for reschedule date
		evt.events.emit('apl-reportlog', {
			AccountId: updSerBook.AccountId,
			reportValues: ['ss'],
			month: moment(updSerBook.date).format('MM'),
			year: moment(updSerBook.date).format('YYYY')
		});

		if (ServiceBooking.Asset && ServiceBooking.Asset.plan && ServiceBooking.Asset.plan == 1) {
			evt.events.emit('apl-fte-serviceSummary', {
				AccountId: res.locals.masterAccountId,
				plan: 1,
				month: moment(updSerBook.date).format('MM'),
				year: moment(updSerBook.date).format('YYYY')
			});
		}

		return res.send({ success: true, servicebooking: updSerBook })
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, "Error in rescheduling");
		return res.send({ success: false, error: "Error in rescheduling" })
	}
}

exports.gateIn = async function (req, res) {
	const ROUTE = 'app/servicebookings/gateIn';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.params, `Requested by ${res.locals.username}`);

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) == -1 || res.locals.AccountId != res.locals.masterAccountId) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: "Missing or invalid input parameter" });
		}

		if (!req.query.GeozoneId) {
			return res.send({ success: false, error: "Please select workshop and proceed." });
		}

		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			if (!geozoneResult.success) {
				RaiseLogEvent(ROUTE, 'error', geozoneResult.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			res.GeozoneId = geozoneResult.geozones.map(x => x.id);
		}

		if (req.query.GeozoneId) {
			res.GeozoneId = req.query.GeozoneId;
		}

		let whereClause = {
			id: req.params.id,
			GeozoneId: req.query.GeozoneId
		}

		if (res.locals.role == "AMCC FTE") {
			whereClause.AccountId = res.locals.accountIds;
		}

		let ServiceBooking = await models.ServiceBooking.findOne({
			attributes: ['id', 'asset', 'date', 'status', 'user', 'log'],
			include: [{
				attributes: ['id', 'plan'],
				model: models.Asset
			}],
			where: whereClause
		});

		if (!ServiceBooking) {
			return res.send({ success: false, error: "Service booking not found" });
		}

		let asset = JSON.parse(JSON.stringify(ServiceBooking.asset));
		asset.gateIn = moment().toISOString();

		let user = JSON.parse(JSON.stringify(ServiceBooking.user));

		user.gateInBy = {
			id: res.locals.UserId,
			name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
			username: res.locals.username,
			role: res.locals.role,
			date: moment().toISOString()
		}

		let log = JSON.parse(JSON.stringify(ServiceBooking.log));
		if (log.gateInBy && log.gateInBy.length) {
			log.gateInBy.push(user.gateInBy);
		} else {
			log.gateInBy = [user.gateInBy];
		}

		let updSerBook = await ServiceBooking.update({
			date: moment().toISOString(),
			asset: asset,
			user: user,
			log: log,
			status: 1 //arrived
		});

		//emit to AplReports to sync
		evt.events.emit('apl-reportlog', {
			AccountId: updSerBook.AccountId,
			reportValues: ['ss'],
			month: moment(updSerBook.date).format('MM'),
			year: moment(updSerBook.date).format('YYYY')
		});

		if (ServiceBooking.Asset && ServiceBooking.Asset.plan && ServiceBooking.Asset.plan == 1) {
			evt.events.emit('apl-fte-serviceSummary', {
				AccountId: res.locals.masterAccountId,
				plan: 1,
				month: moment(updSerBook.date).format('MM'),
				year: moment(updSerBook.date).format('YYYY')
			});
		}

		return res.send({ success: true, servicebooking: updSerBook });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, "Error in gate in");
		return res.send({ success: false, error: "Error in gate in" })
	}
}

exports.approve = async function (req, res) {
	const ROUTE = 'app/servicebookings/approve';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.params, `Requested by ${res.locals.username}`);

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) == -1 || res.locals.AccountId != res.locals.masterAccountId) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: "Missing or invalid input parameter" });
		}

		if (!req.query.GeozoneId) {
			return res.send({ success: false, error: "Please select workshop and proceed." });
		}

		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			if (!geozoneResult.success) {
				RaiseLogEvent(ROUTE, 'error', geozoneResult.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			res.GeozoneId = geozoneResult.geozones.map(x => x.id);
		}

		if (req.query.GeozoneId) {
			res.GeozoneId = req.query.GeozoneId;
		}

		let whereClause = {
			id: req.params.id,
			GeozoneId: req.query.GeozoneId
		}

		if (res.locals.role == "AMCC FTE") {
			whereClause.AccountId = res.locals.accountIds;
		}

		let ServiceBooking = await models.ServiceBooking.findOne({
			attributes: ['id', 'asset', 'date', 'status', 'user', 'log', 'AccountId', 'AssetId'],
			include: [{
				attributes: ['id', 'plan'],
				model: models.Asset
			}],
			where: whereClause
		});

		if (!ServiceBooking) {
			return res.send({ success: false, error: "Service booking not found" });
		}

		if (ServiceBooking.status == 6) {
			return res.send({ success: true, bookingClosed: true, error: 'Requested booking is closed.' });
		}

		let user = JSON.parse(JSON.stringify(ServiceBooking.user));

		user.approvedBy = {
			id: res.locals.UserId,
			name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
			username: res.locals.username,
			role: res.locals.role,
			date: moment().toISOString()
		}

		let log = JSON.parse(JSON.stringify(ServiceBooking.log));
		if (log.approvedBy && log.approvedBy.length) {
			log.approvedBy.push(user.approvedBy);
		} else {
			log.approvedBy = [user.approvedBy];
		}

		let updSerBook = await ServiceBooking.update({
			user: user,
			log: log,
			status: 0
		});

		//#region alert approve
		let AplAlerts = await models.AplAlert.findAll({
			attributes: ['id'],
			where: {
				status: 1,
				type: 1,
				'details.BookingId': updSerBook.id
			},
			order: [['dueDate', 'desc']]
		});

		if (AplAlerts.length) {
			for (const AplAlert of AplAlerts) {
				evt.events.emit('schedule-avolve-service-alert', {
					BookingId: updSerBook.id,
					AccountId: updSerBook.AccountId,
					approve: true,
					AplAlertId: AplAlert.id
				});
			}
		}
		//#endregion

		//emit to AplReports to sync
		evt.events.emit('apl-reportlog', {
			AccountId: updSerBook.AccountId,
			reportValues: ['ss'],
			month: moment().format('MM'),
			year: moment().format('YYYY')
		});

		if (ServiceBooking.Asset && ServiceBooking.Asset.plan && ServiceBooking.Asset.plan == 1) {
			evt.events.emit('apl-fte-serviceSummary', {
				AccountId: res.locals.masterAccountId,
				plan: 1,
				month: moment().format('MM'),
				year: moment().format('YYYY')
			});
		}

		return res.send({ success: true, servicebooking: updSerBook });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, "Error approving service request");
		return res.send({ success: false, error: "Error approving service request" })
	}
}

exports.reject = async function (req, res) {
	const ROUTE = 'app/servicebookings/reject ';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.params, `Requested by ${res.locals.username}`);

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) == -1 || res.locals.AccountId != res.locals.masterAccountId) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		if (!req.params.id || !req.body.reason) {
			return res.send({ success: false, error: "Missing or invalid input parameter" });
		}

		if (!req.query.GeozoneId) {
			return res.send({ success: false, error: "Please select workshop and proceed." });
		}

		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			if (!geozoneResult.success) {
				RaiseLogEvent('avolve/servicebooking/reject', 'error', geozoneResult.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			res.GeozoneId = geozoneResult.geozones.map(x => x.id);
		}

		if (req.query.GeozoneId) {
			res.GeozoneId = req.query.GeozoneId;
		}

		let whereClause = {
			id: req.params.id,
			GeozoneId: req.query.GeozoneId
		}

		if (res.locals.role == "AMCC FTE") {
			whereClause.AccountId = res.locals.accountIds;
		}

		let ServiceBooking = await models.ServiceBooking.findOne({
			attributes: ['id', 'asset', 'date', 'status', 'user', 'log', 'AccountId', 'AssetId'],
			include: [{
				attributes: ['id', 'plan'],
				model: models.Asset
			}],
			where: whereClause
		});

		if (!ServiceBooking) {
			return res.send({ success: false, error: "Service booking not found" });
		}

		let user = JSON.parse(JSON.stringify(ServiceBooking.user));

		user.rejectedBy = {
			id: res.locals.UserId,
			name: res.locals.firstName + (res.locals.lastName ? ' ' + res.locals.lastName : ''),
			username: res.locals.username,
			role: res.locals.role,
			date: moment().toISOString(),
			reason: req.body.reason,
			note: req.body.note
		}

		let log = JSON.parse(JSON.stringify(ServiceBooking.log));
		if (log.rejectedBy && log.rejectedBy.length) {
			log.rejectedBy.push(user.rejectedBy);
		} else {
			log.rejectedBy = [user.rejectedBy];
		}

		let updSerBook = await ServiceBooking.update({
			user: user,
			log: log,
			status: 5
		});

		//#region alert approve
		let AplAlerts = await models.AplAlert.findAll({
			attributes: ['id'],
			where: {
				status: 1,
				type: 1,
				'details.BookingId': updSerBook.id
			},
			order: [['dueDate', 'desc']]
		});

		if (AplAlerts.length) {
			for (const AplAlert of AplAlerts) {
				evt.events.emit('schedule-avolve-service-alert', {
					BookingId: updSerBook.id,
					AccountId: updSerBook.AccountId,
					reject: true,
					AplAlertId: AplAlert.id
				});
			}
		}
		//#endregion

		//emit to AplReports to sync
		evt.events.emit('apl-reportlog', {
			AccountId: updSerBook.AccountId,
			reportValues: ['ss'],
			month: moment().format('MM'),
			year: moment().format('YYYY')
		});

		if (ServiceBooking.Asset && ServiceBooking.Asset.plan && ServiceBooking.Asset.plan == 1) {
			evt.events.emit('apl-fte-serviceSummary', {
				AccountId: res.locals.masterAccountId,
				plan: 1,
				month: moment().format('MM'),
				year: moment().format('YYYY')
			});
		}

		return res.send({ success: true, servicebooking: updSerBook });
	} catch (err) {
		console.log(`Error in ${ROUTE}: `, err);
		RaiseLogEvent(ROUTE, 'error', err, "Error rejecting service request");
		return res.send({ success: false, error: "Error rejecting service request" })
	}
}

exports.getServicesByAsset = async function (req, res) { //Service schedule screen API
	const ROUTE = 'app/servicebookings/getServicesByAsset ';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'Missing InputParameter.' });
		}

		if (['AMCS FTE', 'AMCC FTE', 'FM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		let Asset = await models.Asset.findOne({
			attributes: ['id', 'lplate', 'axleProfile', 'details'],
			include: [{
				attributes: [],
				model: models.Account,
				where: {
					AccountIdParent: res.locals.masterAccountId
				}
			}],
			where: {
				id: req.params.id
			}
		});

		if (!Asset) {
			return res.send({ success: false, error: 'Asset not found.' });
		}

		let result = {
			AssetId: Asset.id,
			lplate: Asset.lplate || '',
			config: Asset.details && `${Asset.axleProfile || ''} ${Asset.details.axleProfile && Asset.details.axleProfile.config || ''}`,
			activeAxles: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.name || '',
			isAdhoc: false,
			services: []
		};

		let reshedule = false;
		if (req.query.ServiceBookingId) {
			reshedule = true;
		}

		if (!reshedule && (!req.query.ScheduleIds || !req.query.ScheduleIds.length)) {
			return res.send({ success: false, error: 'Input parameters missing.' });
		}

		let scheduleIds = req.query.ScheduleIds && JSON.parse(req.query.ScheduleIds) || [];
		let scheduleWhere = {
			AssetId: req.params.id
		}

		if (!reshedule) {
			scheduleWhere = { ...scheduleWhere, ...{ id: scheduleIds } };
		}

		let VehicleServiceSchedules = await models.VehicleServiceSchedule.findAll({
			attributes: ['id', 'nextServiceInMonth', 'VehicleServiceTypeId'],
			include: [{
				attributes: ['id', 'serviceName'],
				model: models.VehicleServiceType
			}],
			where: scheduleWhere
		});

		if (reshedule) {
			let ServiceBooking = await models.ServiceBooking.findOne({
				attributes: ['id', 'services', 'type', 'date', 'status'],
				where: {
					id: req.query.ServiceBookingId,
					AssetId: req.params.id
				}
			});

			if (!ServiceBooking) {
				return res.send({ success: false, error: 'Services not found.' });
			}

			if (ServiceBooking.status == 6) {
				return res.send({ success: true, bookingClosed: true, error: 'Requested booking is closed.' });
			}

			let WheelRotation = ServiceBooking.services.some(x => x.serviceName && x.serviceName == 'Wheel Rotation');
			let TyreRotOnRim = ServiceBooking.services.some(x => x.serviceName && x.serviceName == 'Tyre Rotation On Rim');

			for (const service of ServiceBooking.services) {
				let matchedSerSch = VehicleServiceSchedules.find(x => x.VehicleServiceTypeId == service.ServiceTypeId);
				let dueDate = matchedSerSch && matchedSerSch.nextServiceInMonth && moment(matchedSerSch.nextServiceInMonth).format('DD/MM/YYYY') || ''
				result.isAdhoc = ServiceBooking.type == 1 && true || false;
				let schedule = {
					serviceName: service.serviceName || '',
					ServiceTypeId: service.ServiceTypeId,
					dueDate: dueDate || (ServiceBooking.date && moment(ServiceBooking.date).format('DD/MM/YYYY')) || "",
					isSkipped: service.serviceName && service.serviceName == 'Wheel Rotation' && WheelRotation && TyreRotOnRim && true || false
				}
				if (schedule.isSkipped) {
					schedule.skippedNote = 'Wheel rotation and Tyre rotation on rim cannot be scheduled together, priority will be given to Tyre rotation on rim.';
				}
				result.services.push(schedule);
			}
		} else {
			if (!VehicleServiceSchedules || !VehicleServiceSchedules.length) {
				return res.send({ success: false, error: 'Services not found.' });
			}

			let WheelRotation = VehicleServiceSchedules.some(x => x.VehicleServiceType && x.VehicleServiceType.serviceName && x.VehicleServiceType.serviceName == 'Wheel Rotation');
			let TyreRotOnRim = VehicleServiceSchedules.some(x => x.VehicleServiceType && x.VehicleServiceType.serviceName && x.VehicleServiceType.serviceName == 'Tyre Rotation On Rim');

			for (const VehicleServiceSchedule of VehicleServiceSchedules) {
				let serviceName = VehicleServiceSchedule.VehicleServiceType && VehicleServiceSchedule.VehicleServiceType.serviceName || '';
				let schedule = {
					id: VehicleServiceSchedule.id,
					serviceName: serviceName,
					ServiceTypeId: VehicleServiceSchedule.VehicleServiceTypeId,
					dueDate: VehicleServiceSchedule.nextServiceInMonth && moment(VehicleServiceSchedule.nextServiceInMonth).format('DD/MM/YYYY') || '',
					isSkipped: serviceName && serviceName == 'Wheel Rotation' && WheelRotation && TyreRotOnRim && true || false
				}
				if (schedule.isSkipped) {
					schedule.skippedNote = 'Wheel rotation and Tyre rotation on rim cannot be scheduled together, priority will be given to Tyre rotation on rim.';
				}
				result.services.push(schedule);
			}
		}

		return res.send({ success: true, result: result });
	} catch (error) {
		console.log(`Error in ${ROUTE}: ${error}`);
		RaiseLogEvent(ROUTE, 'error', error, "Error fetching services");
		return res.send({ success: false, error: "Error fetching services" })
	}
}

async function missedAlertsExcel(missedAlerts, req, res) {
	try {
		let accountIds = ["XE FTE", "ARSA"].includes(res.locals.role) ? [req.query.AccountId] : [res.locals.AccountId];
		let kamUsers = [];
		if (["AMCC FTE"].includes(res.locals.role)) {
			accountIds = res.locals.accountIds;
		}

		if (res.locals.role == 'AMCS FTE') {
			let custResult = await avolveHelper.getAMCSCustomersByFte(res.locals.UserId, res.locals.masterAccountId);
			accountIds = custResult.success && custResult.results.map(x => x.id) || [];
		}

		let kamResult = await avolveHelper.getKamListByCustomers(accountIds, data.masterAccountId);
		kamUsers = kamResult.success && kamResult.results || [];

		let accountUsers = await avolveHelper.getUsersByAccounts(accountIds, kamUsers, []);
		accountUsers = accountUsers.results || [];

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'tname', 'name'],
			include: [{
				attributes: ['id', 'offerType', 'subOfferType', 'plan', 'slab'],
				model: models.AplOffer,
				where: {
					status: 'Active',
					startDate: { [Op.lte]: moment().format('YYYY-MM-DD') },
					endDate: { [Op.gte]: moment().format('YYYY-MM-DD') }
				},
				required: false
			}],
			where: {
				id: accountIds
			}
		});

		let columnHeaders = [
			{ header: 'KAM', key: 'kamName', width: 15 },
			{ header: 'FTE', key: 'fteName', width: 15 },
			{ header: 'MDG ID', key: 'mdgId', width: 15 },
			{ header: 'Customer Name', key: 'accName', width: 15 },
			{ header: 'Offer', key: 'offerType', width: 15 },
			{ header: 'Sub Offer', key: 'subOfferType', width: 15 },
			{ header: 'Plan', key: 'channel', width: 15 },
			{ header: 'Slab', key: 'slab', width: 15 },
			{ header: 'Veh Reg No', key: 'lplate', width: 15 },
			{ header: 'Service Name', key: 'serviceName', width: 15 },
			{ header: 'Alert Triggered Date', key: 'triggeredDate', width: 15 },
			{ header: 'Alert Based On', key: 'alertBasedOn', width: 15 },
			{ header: 'Alert Due Date', key: 'dueDate', width: 15 },
			{ header: 'Alerts Missed Date', key: 'alertMissedDate', width: 15 },
			{ header: 'Overdue Days', key: 'dueDays', width: 10 },
			{ header: 'Status', key: 'status', width: 10 }
		];

		let excelResults = [];
		for (const missedAlert of missedAlerts) {
			if (missedAlert.booking) {
				continue;
			}

			let baseResult = {};
			if (missedAlert.asset) {
				baseResult.lplate = missedAlert.asset.lplate || "";
				baseResult.wheeler = missedAlert.asset.wheeler || "";
				baseResult.config = missedAlert.asset.config || "";
				baseResult.name = missedAlert.asset.name || "";
			}

			let matchedAccount = Accounts.find(x => x.id === missedAlert.AccountId);
			let accountUser = accountUsers.length && accountUsers.find(x => x.AccountId == missedAlert.AccountId) || '';
			if (matchedAccount) {
				let aplOffer = matchedAccount.AplOffers && matchedAccount.AplOffers.length && matchedAccount.AplOffers[0] || {};
				baseResult.accName = matchedAccount.tname || "";
				baseResult.mdgId = matchedAccount.name && matchedAccount.name.split('_')[0] || "";
				if (aplOffer) {
					baseResult.offerType = aplOffer.offerType || "";
					baseResult.subOfferType = aplOffer.subOfferType || "";
					let { slab = '', channel = '' } = avolveHelper.avolveOfferLookUp(aplOffer) || {};
					baseResult.slab = slab;
					baseResult.channel = channel;
				}
			}

			baseResult.dueDate = missedAlert.date && moment(missedAlert.date).format('DD/MM/YYYY hh:mm:ss A') || "";
			baseResult.dueDays = missedAlert.dueDays || "";
			baseResult.serviceType = missedAlert.tyre == 0 ? "Scheduled" : "Adhoc";
			baseResult.kamName = accountUser && accountUser.kamName || '';
			baseResult.fteName = res.locals.firstName && `${res.locals.firstName} ${res.locals.lastName || ''}` || res.locals.username || "";
			baseResult.alertBasedOn = 'Days';

			let keys = Object.keys(missedAlert.user || {});
			if (missedAlert.status == 5) {
				baseResult.status = 'Rejected';
			} else if (missedAlert.status == 4) {
				baseResult.status = 'Approved';
			} else if (keys.includes('rescheduledBy') && [0, 1].includes(missedAlert.status)) {
				baseResult.status = 'Rescheduled';
			} else {
				baseResult.status = 'Scheduled';
			}
			baseResult.status = 'Missed';
			for (const service of missedAlert.services) {
				let result = { ...baseResult }; // Create a new result object for each service
				result.serviceName = service && service.serviceName || "";
				result.triggeredDate = service.triggeredDate;
				result.alertMissedDate = service.alertMissedDate;
				excelResults.push(result);
			}
		}

		let fileName = `Missed_Service_Alerts_Report`;
		return await avolveHelper.avolveExcelExport(fileName, columnHeaders, excelResults, req, res);
	} catch (error) {
		console.log(`Error in ${ROUTE}: ${error}`);
		RaiseLogEvent(ROUTE, 'error', error, `Excel download error`);
		return { error: error };
	}
}