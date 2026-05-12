const models = require("../../../models");
const logger = require('../../../lib/helpers/rmqlog');
const avolveHelper = require('../../../lib/helpers/avolveHelper');
const evt = require('../../../lib/event');
const cities = require('../../../config/cities.json');
const { Op } = require('sequelize')
const { handleApiError } = require('../../middlewares/helper');

exports.listByRole = async function (req, res) {
	const ROUTE = 'app/geozones/listByRole';

	try {
		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) == -1 || res.locals.AccountId != res.locals.masterAccountId) {
			return res.send({ success: false, error: 'Not Authorized to this user.' });
		}

		let whereClause = {
			AccountId: res.locals.AccountId
		};

		let primaryZones = [];
		if (res.locals.role == "AMCS FTE") {
			let result = await avolveHelper.fetchGeozones(res);
			if (!result.success) {
				logger.RaiseLogEvent(ROUTE, 'error', result.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			if (req.query.ztypes && req.query.ztypes.split(',').length) {
				whereClause.ztype = { [Op.in]: req.query.ztypes.split(',').map(x => parseInt(x)) };
			}
			res.GeozoneId = result.geozones.map(x => x.id);
			let custResult = await avolveHelper.fetchCustomers(res);
			if (custResult.customers && custResult.customers.length) {
				primaryZones = result.geozones;
				whereClause.id = res.GeozoneId;
			} else {
				primaryZones = result.geozones;
				whereClause.id = res.GeozoneId;
			}

		} else {
			whereClause.AccountId = { [Op.in]: res.locals.accountIds };
		}

		let Geozones = await models.Geozone.findAll({
			attributes: ['id', 'name', 'zoneCode', 'ztype', 'center'],
			where: whereClause,
			raw : true
		});

		let results = [];
		for (let Geozone of Geozones) {
			Geozone = JSON.parse(JSON.stringify(Geozone));
			let matchGeozone = primaryZones.find(x => x.id == Geozone.id);
			Geozone.primary = matchGeozone && matchGeozone.primary || false;
			results.push(Geozone);
		}

		results.sort(function (a, b) {
			return b.primary - a.primary //sort by dist asc
		});
		return res.send({ success: true, results: results });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Data fetching workshops', err);
	}
}

exports.mapview = async function (req, res) {
	const ROUTE = 'app/geozones/mapview';
	try {
		logger.RaiseLogEvent(ROUTE, res.locals.AccountId, req.query, `Requested by ${res.locals.userFullName}`);

		if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) == -1 || res.locals.AccountId != res.locals.masterAccountId) {
			return res.send({ success: false, error: 'Not Authorized to this user.' });
		}

		let accountIds = []; //AMCS Customers
		let geozoneWhere = {
			activeStatus: true,
			AccountId: res.locals.AccountId
		}
		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);

			if (!geozoneResult.success) {
				logger.RaiseLogEvent(ROUTE, 'error', geozoneResult.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}

			res.GeozoneId = geozoneResult.geozones.map(x => x.id);

			let result = await avolveHelper.fetchCustomers(res);

			if (result.customers && result.customers.length) {
				accountIds = result.customers.map(x => x.id) || [];
			} else {
				geozoneWhere.activeStatus = true;
				delete geozoneWhere.AccountId;
			}

		} else {
			geozoneWhere.AccountId = res.locals.accountIds;
		}

		let Geozones = await models.Geozone.findAll({
			attributes: ['id', 'name', 'zoneCode', 'ztype', 'center', 'accountIds', 'address'],
			where: geozoneWhere,
			raw : true
		});


		let results = [];
		for (let Geozone of Geozones) {
			Geozone = JSON.parse(JSON.stringify(Geozone));
			let matchGeozone = Geozone.accountIds.find(y => accountIds.indexOf(y.id) > -1);
			Geozone.primary = matchGeozone && true || false;
			if ((req.query.radius && !isNaN(req.query.radius)) && req.query.lat, req.query.lon) {
				if (Geozone.center.length) {
					let dist = distance(req.query.lat, req.query.lon, Geozone.center[0], Geozone.center[1]);
					if (dist <= (parseInt(req.query.radius))) {
						Geozone.distMeter = Math.round(dist * 1000);
						delete Geozone.accountIds;
						results.push(Geozone);
					}
				}
			} else {
				delete Geozone.accountIds;
				results.push(Geozone);
			}
		}

		if ((req.query.radius && !isNaN(req.query.radius)) && req.query.lat, req.query.lon && req.query.GeozoneId) {
			let primaryZones = results.filter(x => x.id == req.query.GeozoneId);
			let secondayZones = results.filter(x => x.id != req.query.GeozoneId);
			secondayZones = secondayZones.sort(function (a, b) {
				return a.distMeter - b.distMeter //sort by dist asc
			});
			results = primaryZones.concat(secondayZones);
		}

		return res.send({ success: true, results: results });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching workshops', err);
	}
}

exports.nearbyZones = async function (req, res) {
	const ROUTE = 'app/geozones/nearbyZones';
	try {
		if (!req.query.lat || !req.query.lon) {
			return res.send({ success: false, error: 'Input paramters missing.' });
		}

		let Account = await models.Account.findOne({
			attributes: ['id', 'tripConfig', 'details'],
			where: {
				id: res.locals.AccountId
			},
			raw : true
		});

		if (!Account) {
			return res.send({ success: false, error: 'Account not found' });
		}

		let whereClause = {
			AccountId: Account.id,
			activeStatus: true
		}

		let amcsPlan = Account.details && Account.details.plan == 1 && true || false;
		let fteWorkshops = [];
		if (res.locals.role == "AMCS FTE") {
			let geozoneResult = await avolveHelper.fetchGeozones(res);
			if (!geozoneResult.success) {
				logger.RaiseLogEvent(ROUTE, 'error', geozoneResult.error, `Workshops not assigned to this user.`);
				return res.send({ success: false, error: 'Workshops not assigned to this user.' });
			}
			fteWorkshops = geozoneResult.geozones.map(x => parseInt(x.id)) || [];
			whereClause.AccountId = res.locals.masterAccountId;
			whereClause.ztype = 33;
		}

		if (amcsPlan) {
			whereClause.AccountId = res.locals.masterAccountId;
			whereClause.ztype = 33;
		}

		if (["AMCC FTE"].indexOf(res.locals.role) > -1) {
			whereClause.AccountId = res.locals.accountIds;
		}

		if (["XE FTE", "ARSA"].indexOf(res.locals.role) > -1) {
			whereClause.AccountId = req.query.AccountId && req.query.AccountId || res.locals.accountIds;
		}

		let Geozones = await models.Geozone.findAll({
			attributes: [
				'id', 'ztype', 'type', 'name', 'zoneCode', 'geojson',
				'scale', 'fullName', 'address', 'city', 'phone', 'area', 'accountIds', 'center'],
			where: whereClause,
			raw : true
		});

		let results = [];
		for (let Geozone of Geozones) {
			Geozone = JSON.parse(JSON.stringify(Geozone));
			Geozone.primary = true;
			if (res.locals.role == "AMCS FTE") {
				Geozone.primary = fteWorkshops.find(x => x == Geozone.id) && true || false;
			} else if (amcsPlan) {
				let matchAcc = Geozone.accountIds.find(x => parseInt(x.id) == res.locals.AccountId);
				Geozone.primary = matchAcc && true || false;
			}
			if ((req.query.radius && !isNaN(req.query.radius)) && req.query.lat, req.query.lon) {
				if (Geozone.center.length && parseInt(req.query.radius) > 0) {
					let dist = distance(req.query.lat, req.query.lon, Geozone.center[0], Geozone.center[1]);
					if (dist <= (parseInt(req.query.radius))) {
						Geozone.distMeter = Math.round(dist * 1000);
						results.push(Geozone);
					}
				} else {
					results.push(Geozone);
				}
			} else {
				results.push(Geozone);
			}
		}

		let primaryCvs = results.filter(x => x.primary == true);
		results = primaryCvs.concat(results.filter(x => x.primary == false));
		return res.send({ success: true, results: results });

	} catch (err) {
		return handleApiError(res, ROUTE, 'Error fetching zones', err);
	}
}

exports.listCities = function (req, res) {
	res.send({ success: true, results: cities });
}

exports.zoneTypes = function (req, res) {
	return res.send({
		success: true,
		results: {
			"33": "CV Zone",
			"35": "Third Party",
			"11": "Own Workshop"
		}
	})
}

var distance = function (lat1, lon1, lat2, lon2) {
	var radlat1 = (Math.PI * lat1) / 180;
	var radlat2 = (Math.PI * lat2) / 180;
	var theta = lon1 - lon2;
	var radtheta = (Math.PI * theta) / 180;
	var dist = Math.sin(radlat1) * Math.sin(radlat2) + Math.cos(radlat1) * Math.cos(radlat2) * Math.cos(radtheta);
	dist = Math.acos(dist);
	dist = (dist * 180) / Math.PI;
	dist = dist * 60 * 1.1515;
	dist = dist * 1.609344;
	if (dist > 0) {
		return dist;
	} else {
		return 0;
	}
}