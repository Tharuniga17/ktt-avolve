const models = require("../../../models");
const moment = require("moment");
const logger = require('../../../lib/helpers/rmqlog');
const avolveHelper = require('../../../lib/helpers/avolveHelper');
const evt = require('../../../lib/event');
const md5 = require('../../../lib/md5').md5;
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { Op } = require('sequelize');
const { handleApiError } = require('../../middlewares/helper');

exports.create = async function (req, res) {
    const ROUTE = 'app/jobcards/create';
    try {
        RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
        if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) == -1) {
            return res.send({ success: false, error: 'Not Authorized' });
        }

        if (!req.body.AssetId || !req.body.GeozoneId || !req.body.ServiceBookingId || !req.body.services || !req.body.fleetManagerId) {
            return res.send({ success: false, error: 'Missing input parameter.' });
        }

        let services = req.body.services;
        if (!services.length) {
            return res.send({ success: false, error: 'Missing Services.' });
        }

        //#region re-order/sort services
        let enRouteReplacement = services.find(x => x.serviceName == "En Route Tyre Replacement");
        let enRouteRotation = services.find(x => x.serviceName == "En Route Tyre Rotation");

        let sortServices = [];
        if (enRouteReplacement) {
            sortServices.push(enRouteReplacement);
            services = services.filter(x => x.serviceName != "En Route Tyre Replacement");
        }
        if (enRouteRotation) {
            sortServices.push(enRouteRotation);
            services = services.filter(x => x.serviceName != "En Route Tyre Rotation");
        }
        for (const service of services) {
            sortServices.push(service);
        }
        services = sortServices;
        //#endregion

        let Asset = await models.Asset.findOne({
            attributes: ['id', 'lplate', 'details', 'AccountId', 'odo', 'plan'],
            where: {
                id: req.body.AssetId
            }
        });

        if (!Asset) {
            return res.send({ success: false, error: 'Vehicle not found.' });
        }

        //#region validate cosumption count
        let AplService = await models.AplService.findOne({
            where: {
                AssetId: req.body.AssetId,
                AccountId: Asset.AccountId
            }
        });

        let latestJobCard = await models.AplJobCard.findOne({
            attributes: ['jobCardNo'],
            where: {
                AccountId: Asset.AccountId
            },
            order: [['id', 'desc']],
            raw: true
        });

        if (AplService) {
            for (const service of AplService.services) {
                let matchedService = services.find(x => x.serviceName == service.serviceName);
                let remainingService = Number(service.alloted) - Number(service.consumed);
                if (matchedService && matchedService.noOfTyres > remainingService) {
                    return res.send({ success: false, error: `You have reached the maximum allowable count of ${remainingService} for the '${matchedService.serviceName}' service.` });
                }
            }
        }

        let serviceCount = services.reduce((count, service) => count + (service.noOfTyres && Number(service.noOfTyres) || 0), 0);
        let inActAxleCount = 0;
        let ignorePositions = ["SP", "SP1", "SP2", "SP3", "SP4"];
        if (Asset.axleConfig && Asset.axleConfig.config) {
            let inActiveAxles = Asset.axleConfig.config.filter(x => x.active == false); //ignore in-active axle positions
            for (let inActiveAxle of inActiveAxles) {
                if (inActiveAxle.position) {
                    inActAxleCount += inActiveAxle.position.length;
                    inActiveAxle.position.map(x => ignorePositions.push(x));
                }
            }
        }

        let tyresCount = Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.wheeler && parseInt(Asset.details.axleProfile.wheeler.split('W')[0] || 0) - inActAxleCount || 0;
        if (serviceCount > tyresCount) {
            return res.send({ success: false, error: 'The count of selected service tyres cannot exceed that of active tyres. Please make the right tyre choice.' });
        }
        //#endregion

        if (res.locals.role == "AMCC FTE" && Asset.plan != 2) {
            return res.send({ success: false, error: 'AMC Captive offer not offered for this vehicle.' });
        }

        if (res.locals.role == "AMCS FTE" && Asset.plan != 1) {
            return res.send({ success: false, error: 'AMC Shared offer not offered for this vehicle.' });
        }

        let Geozone = await models.Geozone.findOne({
            attributes: ['id', 'name', 'zoneCode', 'AccountId', 'center'],
            where: {
                id: req.body.GeozoneId
            }
        });

        if (!Geozone) {
            return res.send({ success: false, error: 'Geozone not found.' });
        }

        let Account = await models.Account.findOne({
            attributes: ['id', 'serviceConfig', 'lastJobCardNo'],
            where: { id: Asset.AccountId }
        });

        let FleetManager = await models.User.findOne({
            attributes: ['id', 'username', 'firstName', 'lastName', 'mobile'],
            where: {
                id: req.body.fleetManagerId,
                activeStatus: true
            }
        });

        if (!FleetManager) {
            return res.send({ success: false, error: 'Fleet manager not found.' });
        }

        let User = await models.User.findOne({
            attributes: ['id', 'username', 'firstName', 'lastName', 'mobile'],
            where: {
                id: res.locals.UserId,
                activeStatus: true
            }
        });

        if (!User) {
            return res.send({ success: false, error: 'User not found.' });
        }

        let ServiceBooking = await models.ServiceBooking.findOne({
            attributes: ['id', 'user', 'asset', 'notes'],
            where: {
                id: req.body.ServiceBookingId
            }
        });

        if (!ServiceBooking) {
            return res.send({ success: false, error: 'Service booking not found.' });
        }

        let Inspection = await models.Inspection.findAll({
            attributes: ['id', 'details', 'type'],
            where: {
                type: ['v', 'tv', 't'],
                AssetId: Asset.id,
                AccountId: Asset.AccountId,
                ServiceBookingId: ServiceBooking.id
            },
            order: [['id', 'desc']]
        });

        let TyreVerification = Inspection.find(x => x.type == 'tv') || {};
        let details = { // capture renroute service counts in JC
            enrouteServices: TyreVerification.details && TyreVerification.details.enrouteServices || {}
        };
        if (ServiceBooking.notes && ServiceBooking.notes.skipWheelRot) { // skip wheel rotation
            details.skipWheelRot = true; // to reupdate next service cycle trigger date after JC execution
        }

        let vehicleInspection = Inspection.find(x => x.type == 'v') || {};
        let inTime = ServiceBooking.asset && ServiceBooking.asset.gateIn || null;
        inTime = inTime && moment(inTime) || null;
        let assetOdo = (vehicleInspection && vehicleInspection.details && vehicleInspection.details.odo) || (Asset.odo) || "";
        let asset = {
            id: Asset.id,
            lplate: Asset.lplate,
            odo: assetOdo,
            axleProfile: {
                wheeler: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.wheeler || "",
                config: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.config || "",
                name: Asset.details && Asset.details.axleProfile && Asset.details.axleProfile.name || ""
            }
        }

        let workshop = {
            id: Geozone.id,
            name: Geozone.name,
            code: Geozone.zoneCode,
            center: Geozone.center
        }

        let user = {
            createdBy: {
                id: User.id,
                name: User.firstName + (User.lastName ? ' ' + User.lastName : ''),
                username: User.username,
                date: moment().toISOString(),
                note: req.body.note
            }
        };

        let fleetManager = {
            id: FleetManager.id,
            name: FleetManager.firstName + (FleetManager.lastName ? ' ' + FleetManager.lastName : ''),
            username: FleetManager.username,
            phone: FleetManager.mobile,
            date: moment().toISOString()
        };

        let log = {};
        log.createdBy = user.createdBy;
        log.fleetManager = fleetManager;
        user.fleetManager = fleetManager;

        let isAdditionalSer = services.some(x => x.amount && Number(x.amount) > 0);

        let jobcard = {};
        await models.sequelize.transaction(async t => {
            let aplJobcard = await models.AplJobCard.findOne({
                attributes: ['id', 'status', 'jobCardNo', 'workshop'],
                where: {
                    AssetId: req.body.AssetId
                },
                order: [['id', 'desc']]
            });

            if (aplJobcard && aplJobcard.status !== 3) {
                throw new Error(`Job card already exists for this vehicle with Job ID: ${aplJobcard.jobCardNo || ''} at ${aplJobcard.workshop && aplJobcard.workshop.name || ''}.`);
            }

            jobcard = await models.AplJobCard.create({
                jobCardNo: generateJobCardNo(Geozone.zoneCode, (latestJobCard && latestJobCard.jobCardNo || null)),// auto generate jobcard No
                asset: asset,
                workshop: workshop,
                status: 0,
                user: user,
                AccountId: Asset.AccountId,
                GeozoneId: Geozone.id,
                AssetId: Asset.id,
                ServiceBookingId: req.body.ServiceBookingId,
                services: services,
                odo: assetOdo,
                log: log,
                inTime: inTime,
                totalCost: req.body.totalCost || 0,
                note: req.body.note,
                details: details
            }, { transaction: t });

            if (jobcard) {
                await Account.update({
                    lastJobCardNo: jobcard.jobCardNo
                }, { transaction: t })

                await models.ServiceBooking.update({
                    status: 2
                }, {
                    where: { id: jobcard.ServiceBookingId }
                }, { transaction: t })

                if (!isAdditionalSer) {
                    setTimeout(() => {
                        evt.events.emit('avolve-jobCard-auto-approval', {
                            AccountId: jobcard.AccountId,
                            AplJobCardId: jobcard.id
                        });
                        RaiseLogEvent(ROUTE, jobcard.id, jobcard, 'Request sent for jobcard auto approval');
                    }, 120000); // 2 minutes from jobCard creation
                }
            }
        });

        if (Inspection && Inspection.length) {
            await models.Inspection.update({
                AplJobCardId: Number(jobcard.id)
            }, { where: { id: Inspection.map(x => x.id) } });
        }

        //#region jobcard assign
        let AplAlerts = await models.AplAlert.findAll({
            attributes: ['id'],
            where: {
                status: 1,
                type: 1,
                'details.BookingId': jobcard.ServiceBookingId
            },
            order: [['dueDate', 'desc']]
        });

        if (AplAlerts.length) {
            for (const AplAlert of AplAlerts) {
                evt.events.emit('schedule-avolve-service-alert', {
                    BookingId: jobcard.ServiceBookingId,
                    AccountId: jobcard.AccountId,
                    jobcard: true,
                    AplAlertId: AplAlert.id,
                    AplJobCardId: jobcard.id
                });
            }
        }
        //#endregion

        //emit to AplReports to sync
        evt.events.emit('apl-reportlog', {
            AccountId: jobcard.AccountId,
            reportValues: ['ss'],
            month: moment(jobcard.createdAt).format('MM'),
            year: moment(jobcard.createdAt).format('YYYY')
        });

        if (Asset.plan == 1) {
            evt.events.emit('apl-fte-serviceSummary', {
                AccountId: res.locals.masterAccountId,
                plan: 1,
                month: moment(jobcard.createdAt).format('MM'),
                year: moment(jobcard.createdAt).format('YYYY')
            });
        }

        return res.send({ success: true, jobcard: jobcard });

    } catch (err) {
        let errMsg = 'Error creating jobcard.';
        if (err.message && err.message.startsWith('Job card already')) {
            errMsg = err.message;
        }
        return handleApiError(res, ROUTE, 'Error creating jobcard', err);
    }
}

function generateJobCardNo(cvZoneId, lastJobCardNo) {

    const splitJobCardNo = lastJobCardNo ? lastJobCardNo.split('/').map(x => x.trim()) : '';
    let jobcardSeqNo = lastJobCardNo ? parseInt(splitJobCardNo[splitJobCardNo.length - 1]) + 1 : 1;

    let seqNo = jobcardSeqNo.toString().padStart(3, '0');

    const currentDate = moment();
    const currentYear = currentDate.year();

    const startYear = currentDate.month() >= 3 ? currentYear : currentYear - 1;
    const endYear = startYear + 1;

    const startYearFormatted = moment(startYear, 'YYYY').format('YY');
    const endYearFormatted = moment(endYear, 'YYYY').format('YY');

    // New format (e.g., JC/24-25/29924/001)
    const jobCardNo = `JC/${startYearFormatted}-${endYearFormatted}/${cvZoneId}/${seqNo}`;
    return jobCardNo;
}

exports.listByStatus = async function (req, res) {
    const ROUTE = 'app/jobcards/listByStatus';
    try {
        RaiseLogEvent(ROUTE, res.locals.AccountId, req.query, `Requested by ${res.locals.username}`);

        //#region validations & workshop, customer access
        if (['AMCS FTE', 'AMCC FTE', 'FM'].indexOf(res.locals.role) == -1) {
            return res.send({ success: false, error: 'Not Authorized.' });
        }

        if (res.locals.role != "FM" && !req.query.GeozoneId) {
            return res.send({ success: false, error: "Please select workshop and proceed." });
        }

        let whereClause = {
            AccountId: res.locals.AccountId,
            status: 0
        };

        let assetWhere = {
            remove: false,
            active: true
        }

        if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
            assetWhere.plan = 1;
            whereClause.GeozoneId = req.query.GeozoneId;
            delete whereClause.AccountId;
        }

        if (res.locals.role == "AMCC FTE") {
            assetWhere.plan = 2;
            assetWhere.AccountId = res.locals.accountIds;
            whereClause.AccountId = res.locals.accountIds;
            whereClause.GeozoneId = req.query.GeozoneId;
        }

        //#endregion

        if (req.query.status) {
            whereClause.status = req.query.status;
            if (req.query.status == 2) {//For closed section, show completed & closed JC
                delete whereClause.status;
                whereClause = {
                    ...whereClause, ...{
                        [Op.or]: [
                            { status: 2 },
                            { status: 3, inTime: { [Op.gte]: moment().subtract(30, 'days').toISOString() } }
                        ]
                    }
                }
            }
        }

        if (req.query.sdate && req.query.edate) {
            let startDate = moment(req.query.sdate).startOf('day');
            let endDate = moment(req.query.edate).endOf('day');
            whereClause.inTime = {
                [Op.between]: [startDate, endDate]
            }
        }

        let Jobcards = await models.AplJobCard.findAll({
            include: [{
                attributes: ['id', 'lplate'],
                model: models.Asset,
                where: assetWhere,
                required: true
            }],
            where: whereClause,
            order: [['createdAt', 'DESC']]
        });

        Jobcards = JSON.parse(JSON.stringify(Jobcards));
        for (const JobCard of Jobcards) {
            JobCard.enrouteServices = JobCard.details && JobCard.details.enrouteServices || {};
            delete JobCard.details;
        }

        return res.send({ success: true, results: Jobcards });

    } catch (err) {
        return handleApiError(res, ROUTE, 'Error fetching jobcards list', err);
    }
}

exports.assetJobHist = async function (req, res) {
    const ROUTE = 'app/jobcards/assetJobHist';
    try {
        RaiseLogEvent(ROUTE, res.locals.AccountId, req.query, `Requested by ${res.locals.username}`);

        if (['AMCS FTE', 'AMCC FTE', 'FM', 'FO'].indexOf(res.locals.role) == -1) {
            return res.send({ success: false, error: 'Not Authorized.' });
        }

        //#region validations & workshop, customer access
        let whereClause = {
            AccountId: res.locals.AccountId
        };

        if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
            whereClause.GeozoneId = req.query.GeozoneId;
            delete whereClause.AccountId;
        }

        if (res.locals.role == "AMCC FTE") {
            whereClause.AccountId = res.locals.accountIds;
            whereClause.GeozoneId = req.query.GeozoneId;
        }

        if (req.query.sdate && req.query.edate) { //Hide date for now untill apollo confirm
            let startDate = moment(req.query.sdate).startOf('day').toISOString();
            let endDate = moment(req.query.edate).endOf('day').toISOString();
            whereClause.inTime = {
                [Op.between]: [startDate, endDate]
            }
        }

        let Jobcards = await models.AplJobCard.findAll({
            include: [{
                attributes: ['id', 'lplate'],
                model: models.Asset
            }],
            where: whereClause,
            order: [['createdAt', 'desc']]
        });

        let results = [];
        let assets = [... new Set(Jobcards.map(x => x.AssetId))];
        for (let asset of assets) {
            let matchAssets = Jobcards.filter(x => x.AssetId == asset);
            let totalMins = 0;
            for (const matchAsset of matchAssets) {
                if (matchAsset.inTime && matchAsset.outTime) {
                    totalMins += moment(matchAsset.outTime).diff(moment(matchAsset.inTime), 'minutes');
                }
            }
            if (totalMins > 0) {
                totalMins = totalMins / matchAssets.length;
            }

            let avgServiceTime = '-- hrs';
            if (totalMins > 0) {
                var avgHrs = Math.floor(totalMins / 60) > 0 ? Math.floor(totalMins / 60) : '00';
                var avgMins = Math.floor(totalMins % 60) > 0 ? Math.floor(totalMins % 60) : 0;
                avgMins = avgMins > 9 && avgMins || `0${avgMins}`;
                avgServiceTime = `${avgHrs}:${avgMins} hrs`;
            }

            let result = {
                AssetId: asset,
                lplate: matchAssets.length && matchAssets[0].Asset.lplate || "",
                lastServiceOn: matchAssets.length && moment(matchAssets[0].createdAt).format('DD/MM/YYYY hh:mm A') || "",
                totalServices: matchAssets.length,
                avgServiceTime: avgServiceTime
            };
            results.push(result);
        }
        return res.send({ success: true, results: results });
        //#endregion
    } catch (err) {
        return handleApiError(res, ROUTE, 'Error fetching vehicle jobcards history', err);
    }
}

exports.getServiceLogs = async function (req, res) {
    const ROUTE = 'app/jobcards/getServiceLogs';
    try {
        RaiseLogEvent(ROUTE, res.locals.AccountId, req.query, `Requested by ${res.locals.username}`);

        if (['AMCS FTE', 'AMCC FTE', 'FM', 'FO'].indexOf(res.locals.role) == -1) {
            return res.send({ success: false, error: 'Not Authorized.' });
        }

        //#region validations & workshop, customer access
        let whereClause = {
            AccountId: res.locals.AccountId
        };

        if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
            whereClause.GeozoneId = req.query.GeozoneId;
            delete whereClause.AccountId;
        }

        if (res.locals.role == "AMCC FTE") {
            whereClause.AccountId = res.locals.accountIds;
            whereClause.GeozoneId = req.query.GeozoneId;
        }

        let Jobcards = await models.AplJobCard.findAll({
            include: [{
                attributes: ['id', 'details', 'axleProfile', 'lplate', 'plan'],
                model: models.Asset,
                include: [{
                    attributes: ['id', 'name', 'tname'],
                    model: models.Account,
                    include: [{
                        model: models.AplOffer,
                        attributes: ['id', 'plan', 'slab', 'offerType', 'subOfferType'],
                        required: false
                    }]
                }]
            }, {
                attributes: ['id', 'type'],
                model: models.ServiceBooking
            }],
            where: whereClause,
            order: [['AccountId', 'asc'], ['createdAt', 'desc']]
        });

        let excelResults = [];
        for (const Jobcard of Jobcards) {
            let Asset = Jobcard.Asset || {};
            let axleProfile = Asset.details && Asset.details.axleProfile || {};
            let Account = Jobcard.Asset && Jobcard.Asset.Account || {};
            let AplOffer = Account && Account.AplOffers && Account.AplOffers.length && Account.AplOffers[0] || {};
            let services = Jobcard.services && Jobcard.services.map(x => x.serviceName) || [];
            let approvedBy = Jobcard.log && Jobcard.log.approvedBy || '';
            let { slab, channel } = avolveHelper.avolveOfferLookUp(AplOffer) || {};
            let plan = getOfferName(Asset.plan);
            plan = plan && plan.split(' ');

            // get average service time.
            let serviceTime = moment(Jobcard.outTime).diff(moment(Jobcard.inTime), 'minutes');
            let avgServiceTime = serviceTime > 0 ? `${Math.floor(serviceTime / 60)}:${('0' + (serviceTime % 60)).slice(-2)} hrs` : '-- hrs';

            let enRouteServices = Jobcard.details && Jobcard.details.enrouteServices || {};
            let executedServices = Jobcard.services && Jobcard.services.length ? Jobcard.services : [];
            if (services.includes('Onboarding Service')) {
                executedServices = Jobcard.services[0] && Jobcard.services[0].sub && Jobcard.services[0].sub.length ? Jobcard.services[0].sub : [];
            }
            excelResults.push({
                month: Jobcard.inTime && moment(Jobcard.inTime).format('MMMM') || '',
                serviceDate: Jobcard.inTime && moment(Jobcard.inTime).format('DD/MM/YYYY') || '',
                zone: Jobcard.workshop && Jobcard.workshop.name || '',
                customer: Account.tname || '',
                mdgId: Account.name || '',
                offer: AplOffer && AplOffer.offerType || '',
                subOffer: AplOffer && AplOffer.subOfferType || '',
                slab: slab,
                plan: channel,
                lplate: Asset && Asset.lplate || '',
                wheeler: axleProfile.wheeler || '',
                config: axleProfile.config || '',
                name: axleProfile.name || '',
                serviceType: Jobcard.ServiceBooking && Jobcard.ServiceBooking.type == 1 && 'Adhoc' || 'Scheduled',
                serviceName: services.join(', ') || '',
                jobCardNo: Jobcard.jobCardNo || '',
                approvedBy: approvedBy && approvedBy.username && approvedBy.username == 'System' && 'Auto Approved' || `Approved By FM`,
                odo: Jobcard.asset && Jobcard.asset.odo && Jobcard.asset.odo / 1000 || '',
                avgServiceTime: avgServiceTime || '',
                onbTyres: Asset.details && Asset.details.tyresCount || '',
                tyreInpsect: await getServiceCount('Tyre & Vehicle Inspection', executedServices),
                ipcheck: await getServiceCount('IP Check & Correction', executedServices),
                wheelRotation: await getServiceCount('Wheel Rotation', executedServices),
                rotationOnRim: await getServiceCount('Tyre Rotation On Rim', executedServices),
                fitment: await getServiceCount('Tyre Fitment', executedServices),
                axleChecked: await getServiceCount('Wheel Alignment', executedServices, { checked: true }),
                axleCorrected: await getServiceCount('Wheel Alignment', executedServices, { corrected: true }),
                enRouteReplacement: await getServiceCount('En Route Tyre Replacement', executedServices) || enRouteServices.fitment || 0,
                enRouterotation: await getServiceCount('En Route Tyre Rotation', executedServices) || enRouteServices.rotation || 0
            });
        }

        let columnHeaders = [
            { header: 'Month', key: 'month', width: 10 },
            { header: 'Service Date', key: 'serviceDate', width: 15 },
            { header: 'CV Zone Name', key: 'zone', width: 15 },
            { header: 'Customer Name', key: 'customer', width: 25 },
            { header: 'MDG ID', key: 'mdgId', width: 13 },
            { header: 'Offer', key: 'offer', width: 12 },
            { header: 'Sub Offer', key: 'subOffer', width: 12 },
            { header: 'Plan', key: 'plan', width: 12 },
            { header: 'Slab', key: 'slab', width: 12 },
            { header: 'Vehicle Reg No.', key: 'lplate', width: 15 },
            { header: 'Wheeler', key: 'wheeler', width: 12 },
            { header: 'Config', key: 'config', width: 20 },
            { header: 'Name', key: 'name', width: 20 },
            { header: 'Service Type', key: 'serviceType', width: 25 },
            { header: 'Service Name', key: 'serviceName', width: 25 },
            { header: 'Job ID', key: 'jobCardNo', width: 25 },
            { header: 'Job Card approved by', key: 'approvedBy', width: 25 },
            { header: 'Service Odometer', key: 'odo', width: 25 },
            { header: 'Avg Service Time', key: 'avgServiceTime', width: 25 },
            { header: 'Tyre Onboarded', key: 'onbTyres', width: 25 },
            { header: 'Tyre Inspected', key: 'tyreInpsect', width: 25 },
            { header: 'IP Check & Correction', key: 'ipcheck', width: 25 },
            { header: 'Tyre Rotation', key: 'wheelRotation', width: 25 },
            { header: 'Tyre Rotation on Rim', key: 'rotationOnRim', width: 25 },
            { header: 'Tyre Fitment', key: 'fitment', width: 25 },
            { header: 'Axle Checked', key: 'axleChecked', width: 25 },
            { header: 'Axle Corrected', key: 'axleCorrected', width: 25 },
            { header: 'En Route Tyre Replacement', key: 'enRouteReplacement', width: 25 },
            { header: 'En Route Tyre Rotation', key: 'enRouterotation', width: 25 }
        ];

        let fileName = `Avolve_ServiceLog_Report`;
        return await avolveHelper.avolveExcelExport(fileName, columnHeaders, excelResults, req, res);
    } catch (error) {
        return handleApiError(res, ROUTE, 'Error getting serviceLog summary report', error);
    }
}

async function getServiceCount(serviceName, services, AlignStatus) {
    let serviceCount = 0;
    let service = services.find(x => x.serviceName == serviceName) || {};
    if (service) {
        if (serviceName == 'Tyre & Vehicle Inspection') {
            serviceCount = service.details && service.details.length && service.details.filter(detail => detail.active).length || 0;
        } else if (serviceName == 'IP Check & Correction') {
            serviceCount = service.details && service.details.length && service.details.filter(detail => detail.active).length || 0;
        } else if (serviceName == 'Wheel Rotation') {
            serviceCount = service.details && service.details.length && service.details.filter(x => x.currentPosition != "").length || 0;
        } else if (serviceName == 'Tyre Rotation On Rim') {
            serviceCount = service.noOfTyres || 0;
        } else if (serviceName == 'Tyre Fitment') {
            serviceCount = service.execTyres || 0;
        } else if (serviceName == 'Wheel Alignment') {
            if (AlignStatus.checked) {
                serviceCount = service.details && service.details.length && service.details.filter(x => x.checked == true).length || 0;
            }
            if (AlignStatus.corrected) {
                serviceCount = service.details && service.details.length && service.details.filter(x => x.corrected == true).length || 0;
            }
        } else if (serviceName == 'En Route Tyre Rotation') {
            serviceCount = service.details && service.details.length || 0;
        } else if (serviceName == 'En Route Tyre Rotation') {
            serviceCount = service.details && service.details.length && service.details.filter(x => x.currentPosition != "").length || 0;
        }
    }
    return serviceCount;
}

exports.assetJobHistById = async function (req, res) {
    const ROUTE = 'app/jobcards/assetJobHistById';
    try {
        RaiseLogEvent(ROUTE, res.locals.AccountId, req.params, `Requested by ${res.locals.username}`);

        if (!req.params.id) {
            return res.send({ success: false, error: 'Missing input parameter.' });
        }

        let whereClause = {
            AssetId: req.params.id
        }
        if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
            whereClause.GeozoneId = req.query.GeozoneId;
        }

        if (res.locals.role == "AMCC FTE") {
            whereClause.AccountId = res.locals.accountIds;
            whereClause.GeozoneId = req.query.GeozoneId;
        }

        let Asset = await models.Asset.findOne({
            attributes: ['id', 'lplate', 'AccountId', 'details'],
            where: {
                id: req.params.id
            },
            raw : true
        });

        if (!Asset) {
            return res.send({ success: false, error: 'Vehicle not found.' });
        }

        let AplService = await models.AplService.findOne({
            attributes: ['id', 'AssetId', 'services'],
            where: {
                AssetId: Asset.id,
                AccountId: Asset.AccountId
            },
            raw : true
        });

        let JobCards = await models.AplJobCard.findAll({
            where: whereClause,
            order: [['createdAt', 'desc']],
            raw : true
        });

        let serviceConsumptions = [];
        for (const service of AplService.services) {
            if (service.serviceName != 'Additional Service') {
                serviceConsumptions.push({
                    serviceName: service.serviceName,
                    alloted: service.alloted,
                    consumed: service.consumed
                });
            }
        }

        let result = {
            lplate: Asset.lplate,
            axleProfile: Asset.details && Asset.details.axleProfile || {},
            totalJobCards: JobCards.length,
            avgServiceTime: 0,
            serviceConsumptions: serviceConsumptions,
            jobcards: []
        }

        let jobcards = [];
        let avgSerMins = 0;
        let totalSerCount = 0;
        for (const JobCard of JobCards) {
            let serviceMins = 0;
            if (JobCard.inTime && JobCard.outTime) {
                serviceMins = moment(JobCard.outTime).diff(moment(JobCard.inTime), 'minutes');
                avgSerMins += serviceMins;
                totalSerCount += 1;
            }
            let serviceTime = '-- hrs';
            if (serviceMins > 0) {
                var avgHrs = Math.floor(serviceMins / 60) > 0 ? Math.floor(serviceMins / 60) : '00';
                var avgMins = Math.floor(serviceMins % 60) > 0 ? Math.floor(serviceMins % 60) : 0;
                avgMins = avgMins > 9 && avgMins || `0${avgMins}`;
                serviceTime = `${avgHrs}:${avgMins} hrs`;
            }
            let services = [];
            for (const service of JobCard.services) {
                services.push({
                    ServiceTypeId: service.ServiceTypeId,
                    serviceName: service.serviceName,
                    componentName: service.componentName
                })
            }
            jobcards.push({
                id: JobCard.id,
                jobCardNo: JobCard.jobCardNo,
                GeozoneId: JobCard.GeozoneId,
                serviceDate: moment(JobCard.createdAt).format('DD/MM/YYYY'),
                services: services,
                status: JobCard.status,
                odo: JobCard.odo,
                serviceTime: serviceTime
            })
        }
        avgSerMins = Number(avgSerMins / totalSerCount);
        let avgServiceTime = '-- hrs';
        if (avgSerMins > 0) {
            var avgHrs = Math.floor(avgSerMins / 60) > 0 ? Math.floor(avgSerMins / 60) : '00';
            var avgMins = Math.floor(avgSerMins % 60) > 0 ? Math.floor(avgSerMins % 60) : 0;
            avgMins = avgMins > 9 && avgMins || `0${avgMins}`;
            avgServiceTime = `${avgHrs}:${avgMins} hrs`;
        }
        result.avgServiceTime = avgServiceTime;
        result.jobcards = jobcards;

        return res.send({ success: true, result: result });
    } catch (err) {
        return handleApiError(res, ROUTE, 'Error fetching vehicle jobcard history', err);
    }
}

exports.get = async function (req, res) {
    const ROUTE = 'app/jobcards/get';
    try {
        //#region validations & workshop, customer access
        if (!req.params.id) {
            return res.send({ success: false, error: 'Missing input parameter.' });
        }

        if (res.locals.role != "FM" && !req.query.GeozoneId) {
            return res.send({ success: false, error: "Please select workshop and proceed." });
        }

        let whereClause = {
            AccountId: res.locals.AccountId,
            id: req.params.id
        };

        if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
            whereClause.GeozoneId = req.query.GeozoneId;
            delete whereClause.AccountId;
        }
        //#endregion

        if (res.locals.role == "AMCC FTE") {
            whereClause.GeozoneId = req.query.GeozoneId;
            whereClause.AccountId = res.locals.accountIds;
        }

        let AplJobCard = await models.AplJobCard.findOne({
            include: [{
                attributes: ['id', 'status', 'type'],
                model: models.ServiceBooking
            },
            {
                attributes: ['id', 'lplate', 'axleConfig'],
                model: models.Asset
            }],
            where: whereClause
        });

        if (!AplJobCard) {
            return res.send({ success: false, error: 'Jobcard not found.' });
        }

        AplJobCard = JSON.parse(JSON.stringify(AplJobCard));
        let inActivePositions = [], ignorePositions = ["SP", "SP1", "SP2", "SP3", "SP4"];
        if (AplJobCard.Asset && AplJobCard.Asset.axleConfig && AplJobCard.Asset.axleConfig.config) {
            let inActiveAxles = AplJobCard.Asset.axleConfig.config.filter(x => x.active == false); //ignore in-active axle positions
            for (let inActiveAxle of inActiveAxles) {
                if (inActiveAxle.position) {
                    for (let position of inActiveAxle.position) {
                        inActivePositions.push(position);
                        ignorePositions.push(position);
                    }
                }
            }
        }

        let Tyres = await models.Tyre.findAll({
            attributes: ['id', 'tyreNo', 'lastStatus', 'AssetId'],
            where: {
                AssetId: AplJobCard.AssetId,
                'lastStatus.position': { [Op.notIn]: ignorePositions }
            },
            raw : true
        });

        let services = JSON.parse(JSON.stringify(AplJobCard.services));
        //#region IP Check & Correction
        let ipCheckService = services.find(x => x.serviceName == "IP Check & Correction");
        if (!ipCheckService) {
            for (let service of services) {
                ipCheckService = service.sub.find(x => x.serviceName == "IP Check & Correction");
                if (ipCheckService) {
                    break;
                }
            }
        }
        if (ipCheckService && !ipCheckService.completed) {
            ipCheckService.details = fetchPsiDetails(Tyres, inActivePositions);
        }
        //#endregion

        //#region wheel alignment
        let wheelAlignment = services.find(x => x.serviceName == "Wheel Alignment");
        if (!wheelAlignment) {
            for (let service of services) {
                wheelAlignment = service.sub.find(x => x.serviceName == "Wheel Alignment");
                if (wheelAlignment) {
                    break;
                }
            }
        }

        if (wheelAlignment && !wheelAlignment.completed) {
            wheelAlignment.details = fetchAlignmentDetails(AplJobCard.Asset);
        } else if (!ipCheckService && wheelAlignment && !wheelAlignment.completed) {
            wheelAlignment.details = fetchAlignmentDetails(AplJobCard.Asset);
        }
        //#endregion

        //#region tyre rotation
        let tyreRotation = services.find(x => ["Tyre Rotation", "Wheel Rotation"].indexOf(x.serviceName) > -1);
        if (!tyreRotation) {
            for (let service of services) {
                tyreRotation = service.sub.find(x => ["Tyre Rotation", "Wheel Rotation"].indexOf(x.serviceName) > -1);
                if (tyreRotation) {
                    break;
                }
            }
        }

        if (tyreRotation && !tyreRotation.completed) {
            let rotation = fetchTyreRotationDetails(Tyres, inActivePositions);
            tyreRotation.details = rotation.details;
            tyreRotation.positions = rotation.positions;
        } else if (tyreRotation) {
            let positions = [];
            for (const details of tyreRotation.details) {
                positions.push(details.inspectedPosition);
            }
            tyreRotation.positions = positions;
        }
        //#endregion

        //#region enroute tyre rotation
        let enRouteRotation = services.find(x => ["En Route Tyre Rotation"].indexOf(x.serviceName) > -1);
        if (!enRouteRotation) {
            for (let service of services) {
                enRouteRotation = service.sub.find(x => ["En Route Tyre Rotation"].indexOf(x.serviceName) > -1);
                if (enRouteRotation) {
                    break;
                }
            }
        }

        if (enRouteRotation && !enRouteRotation.completed) {
            let rotation = fetchTyreRotationDetails(Tyres, inActivePositions);
            enRouteRotation.details = rotation.details;
            enRouteRotation.positions = rotation.positions;
        } else if (enRouteRotation) {
            let positions = [];
            for (const details of enRouteRotation.details) {
                positions.push(details.inspectedPosition);
            }
            enRouteRotation.positions = positions;
        }
        //#endregion

        //#region tyre rotation on rim
        let tyreRotationOnRim = services.find(x => x.serviceName == "Tyre Rotation On Rim");
        if (!tyreRotationOnRim) {
            for (let service of services) {
                tyreRotationOnRim = service.sub.find(x => x.serviceName == "Tyre Rotation On Rim");
                if (tyreRotationOnRim) {
                    break;
                }
            }
        }

        if (tyreRotationOnRim && !tyreRotationOnRim.completed) {
            let rotation = fetchTyreRotationOnRimDetails(Tyres, inActivePositions);
            tyreRotationOnRim.details = rotation.details;
            tyreRotationOnRim.positions = rotation.positions;
        } else if (tyreRotationOnRim) {
            let positions = [];
            for (const details of tyreRotationOnRim.details) {
                positions.push(details.inspectedPosition);
            }
            tyreRotationOnRim.positions = positions;
        }
        //#endregion

        AplJobCard.services = services;
        AplJobCard.enrouteServices = AplJobCard.details && AplJobCard.details.enrouteServices || {};
        delete AplJobCard.details;

        return res.send({ success: true, result: AplJobCard });

    } catch (err) {
        return handleApiError(res, ROUTE, 'Error fetching jobcard', err);
    }
}

exports.getLog = async function (req, res) {
    const ROUTE = 'app/jobcards/getLog';
    try {
        if (['AMCS FTE', 'AMCC FTE', 'FM', 'FO'].indexOf(res.locals.role) == -1) {
            return res.send({ success: false, error: 'Not Authorized.' });
        }

        //#region validations & workshop, customer access
        if (!req.params.id) {
            return res.send({ success: false, error: 'Missing input parameter.' });
        }

        let whereClause = {
            AccountId: res.locals.AccountId,
            id: req.params.id
        };
        //#endregion

        if (['AMCS FTE'].indexOf(res.locals.role) > -1) {
            whereClause.GeozoneId = req.query.GeozoneId;
            delete whereClause.AccountId;
        }

        if (res.locals.role == "AMCC FTE") {
            whereClause.AccountId = res.locals.accountIds;
            whereClause.GeozoneId = req.query.GeozoneId;
        }

        let AplJobCard = await models.AplJobCard.findOne({
            include: [{
                attributes: ['id', 'status', 'type'],
                model: models.ServiceBooking
            }],
            where: whereClause,
            raw : true
        });

        if (!AplJobCard) {
            return res.send({ success: false, error: 'Jobcard not found.' });
        }

        let VehicleInspect = await models.Inspection.findOne({
            attributes: ['id', 'date', 'type'],
            where: {
                AplJobCardId: AplJobCard.id,
                type: 'v'
            },
            raw : true
        });

        let result = {
            lplate: AplJobCard.asset && AplJobCard.asset.lplate || "",
            axleProfile: AplJobCard.asset && AplJobCard.asset.axleProfile || {},
            workshop: AplJobCard.workshop && AplJobCard.workshop.name || "",
            serviceType: AplJobCard.ServiceBooking && AplJobCard.ServiceBooking.type,
            enrouteServices: AplJobCard.details && AplJobCard.details.enrouteServices || {},
            serviceOdo: AplJobCard.odo,
            jobCardNo: AplJobCard.jobCardNo,
            status: AplJobCard.status,
            createdBy: '',
            approvedBy: '',
            serviceTime: '',
            log: AplJobCard.log,
            note: AplJobCard.note || '',
            details: AplJobCard.details || {}
        }

        let timeLineLogs = [{ log: "Vehicle Gate In", time: AplJobCard.inTime || "" }, { log: "Vehicle Inspection Completed", time: '' }, { log: "Job Card Created", time: AplJobCard.createdAt || "" }, { log: "Customer Approved", time: '' }, { log: "Job Completed", time: '' }, { log: "Gate Pass Issued", time: '' }];

        if (AplJobCard.log && AplJobCard.log.createdBy && AplJobCard.log.createdBy.name) {
            result.createdBy = AplJobCard.log.createdBy.name;
        }
        if (AplJobCard.log && AplJobCard.log.approvedBy && AplJobCard.log.approvedBy.name) {
            result.approvedBy = AplJobCard.log.approvedBy.name;
        }

        if (AplJobCard.log && AplJobCard.log.approvedBy && AplJobCard.log.approvedBy.date) {
            timeLineLogs[3].time = AplJobCard.log.approvedBy.date;
        }

        if (AplJobCard.log && AplJobCard.log.completedBy && AplJobCard.log.completedBy.date) {
            timeLineLogs[4].time = AplJobCard.log.completedBy.date;
        }

        if (AplJobCard.log && AplJobCard.log.closedBy && AplJobCard.log.closedBy.date) {
            timeLineLogs[5].time = AplJobCard.log.closedBy.date;
        }

        if (AplJobCard.inTime && AplJobCard.outTime) {
            let serviceTime = moment(AplJobCard.outTime).diff(moment(AplJobCard.inTime), 'minutes');

            let avgServiceTime = '-- hrs';
            if (serviceTime > 0) {
                var avgHrs = Math.floor(serviceTime / 60) > 0 ? Math.floor(serviceTime / 60) : '00';
                var avgMins = Math.floor(serviceTime % 60) > 0 ? Math.floor(serviceTime % 60) : 0;
                avgMins = avgMins > 9 && avgMins || `0${avgMins}`;
                avgServiceTime = `${avgHrs}:${avgMins} hrs`;
            }
            result.serviceTime = avgServiceTime;
        }

        let searchData = {
            AssetId: AplJobCard.AssetId,
            date: AplJobCard.inTime,
            type: ['vd', 'v']
        };
        if ([2, 3].indexOf(AplJobCard.status) > -1) {
            searchData.type = "v";
            searchData.AplJobCardId = AplJobCard.id;
        }

        let inspectSummary = await avolveHelper.fetchInspectionByJobCard(searchData);
        if (!inspectSummary.success) {
            let searchData = {
                AssetId: AplJobCard.AssetId,
                date: AplJobCard.inTime,
                type: ['vd', 'v']
            }
            if ([2, 3].indexOf(AplJobCard.status) > -1) {
                searchData.startTime = AplJobCard.inTime;
                searchData.endTime = AplJobCard.outTime;
                if (!AplJobCard.outTime) {
                    if (AplJobCard.log && AplJobCard.log.completedBy && AplJobCard.log.completedBy.date) {
                        searchData.endTime = AplJobCard.log.completedBy.date;
                    }
                }
            }
            inspectSummary = await avolveHelper.fetchInspectionByJobCard(searchData);
        }

        if (inspectSummary && inspectSummary.Inspection) {
            timeLineLogs[1].time = inspectSummary.Inspection.date;
        }

        result.timeLineLogs = timeLineLogs;
        let services = JSON.parse(JSON.stringify(AplJobCard.services));
        let vehicleInpsection = services.find(x => x.serviceName == "Tyre & Vehicle Inspection");
        if (vehicleInpsection) {
            vehicleInpsection.InspectionId = VehicleInspect && VehicleInspect.id || null;
        }
        if (!vehicleInpsection) {
            for (let service of services) {
                vehicleInpsection = service.sub.find(x => x.serviceName == "Tyre & Vehicle Inspection");
                if (vehicleInpsection) {
                    vehicleInpsection.InspectionId = VehicleInspect && VehicleInspect.id || null;
                    break;
                }
            }
        }
        result.services = services;

        return res.send({ success: true, result: result });

    } catch (err) {
        return handleApiError(res, ROUTE, 'Error fetching jobcard', err);
    }
}

function fetchPsiDetails(Tyres, inActivePositions) {
    let details = [];
    for (let Tyre of Tyres) {
        let actPsi = Tyre.lastStatus && Tyre.lastStatus.inflation || "";
        if (Tyre.lastStatus && Tyre.lastStatus.details && Tyre.lastStatus.details.psiNotAccess && Tyre.lastStatus.details.psiNotAccess == true) {
            actPsi = "N/A";
        }
        details.push({
            histId: Tyre.lastStatus && Tyre.lastStatus.id || "",
            tyreNo: Tyre.tyreNo,
            position: Tyre.lastStatus && Tyre.lastStatus.position || "",
            recomPsi: Tyre.lastStatus && Tyre.lastStatus.details && Tyre.lastStatus.details.recomPsi || "",
            actPsi: actPsi,
            active: true,
            crctPsi: ""
        });
    }
    for (let position of inActivePositions) {//inactive positions
        details.push({
            histId: "",
            tyreNo: "",
            position: position,
            recomPsi: "",
            actPsi: "",
            active: false,
            crctPsi: ""
        });
    }
    return details;
}

function fetchAlignmentDetails(Asset) {
    let details = [];
    if (Asset.axleConfig && Asset.axleConfig.config) {
        let axles = Asset.axleConfig.config;
        for (let i = 0; i < axles.length; i++) {
            if (['Spare Wheel', 'Spares'].indexOf(axles[i].name) == -1) {
                details.push({
                    axlePosition: axles[i].name,
                    axleNo: axles[i].axle,
                    active: axles[i].active,
                    checked: true,
                    corrected: false
                });
            }
        }
    }
    return details;
}

function fetchTyreRotationDetails(Tyres, inActivePositions) {
    let details = [];
    let positions = [];
    for (let Tyre of Tyres) {
        positions.push(Tyre.lastStatus && Tyre.lastStatus.position || "");
        details.push({
            histId: Tyre.lastStatus && Tyre.lastStatus.id || "",
            tyreNo: Tyre.tyreNo,
            inspectedPosition: Tyre.lastStatus && Tyre.lastStatus.position || "",
            currentPosition: "",
            active: true
        });
    }
    for (let position of inActivePositions) {//inactive positions
        details.push({
            histId: "",
            tyreNo: "",
            inspectedPosition: position,
            currentPosition: "",
            active: false
        });
    }
    return {
        positions: positions,
        details: details
    };
}

function fetchTyreRotationOnRimDetails(Tyres, inActivePositions) {
    let details = [];
    let positions = [];
    for (let Tyre of Tyres) {
        positions.push(Tyre.lastStatus && Tyre.lastStatus.position || "");
        details.push({
            histId: Tyre.lastStatus && Tyre.lastStatus.id || "",
            tyreNo: Tyre.tyreNo,
            inspectedPosition: Tyre.lastStatus && Tyre.lastStatus.position || "",
            currentPosition: "",
            flipped: false,
            active: true
        });
    }
    for (let position of inActivePositions) {//inactive positions
        details.push({
            histId: "",
            tyreNo: "",
            inspectedPosition: position,
            currentPosition: "",
            flipped: false,
            active: false
        });
    }
    return {
        positions: positions,
        details: details
    };
}

exports.execute = async function (req, res) {
    const ROUTE = 'app/jobcards/execute';
    try {
        RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

        //#region validations & workshop, customer access
        if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) == -1) {
            return res.send({ success: false, error: 'Not Authorized' });
        }

        if (!req.params.id || !req.body.ServiceTypeId) {
            return res.send({ success: false, error: 'Missing input parameter.' });
        }

        if (!req.query.GeozoneId) {
            return res.send({ success: false, error: "Please select workshop and proceed." });
        }

        let whereClause = {
            GeozoneId: req.query.GeozoneId,
            id: req.params.id
        };
        //#endregion

        let details = req.body.details && JSON.parse(req.body.details) || [];

        if (res.locals.role == "AMCC FTE") {
            whereClause.AccountId = res.locals.accountIds;
        }

        let AplJobCard = await models.AplJobCard.findOne({
            include: [{
                attributes: ['id', 'odo', 'axleProfile', 'axleConfig', 'AccountId', 'details'],
                model: models.Asset,
                required: true
            }],
            where: whereClause
        });

        if (!AplJobCard) {
            return res.send({ success: false, error: 'Jobcard not found.' });
        }

        let ServiceBooking = await models.ServiceBooking.findOne({
            attributes: ['id', 'status', 'type', 'date'],
            where: {
                id: AplJobCard.ServiceBookingId
            }
        });

        let ignorePositions = ["SP", "SP1", "SP2", "SP3", "SP4"];
        let inActAxleCount = 0;
        if (AplJobCard.Asset && AplJobCard.Asset.axleConfig && AplJobCard.Asset.axleConfig.config) {
            let inActiveAxles = AplJobCard.Asset.axleConfig.config.filter(x => x.active == false); //ignore in-active axle positions
            for (let inActiveAxle of inActiveAxles) {
                if (inActiveAxle.position) {
                    for (let position of inActiveAxle.position) {
                        inActAxleCount += 1;
                        ignorePositions.push(position);
                    }
                }
            }
        }

        RaiseLogEvent(ROUTE, AplJobCard.AssetId, ignorePositions, 'Ignore axle positions result');

        let Tyres = await models.Tyre.findAll({
            attributes: ['id', 'tyreNo', 'lastStatus', 'AssetId'],
            where: {
                AssetId: AplJobCard.AssetId,
                'lastStatus.position': { [Op.notIn]: ignorePositions }
            }
        });

        let services = JSON.parse(JSON.stringify(AplJobCard.services));

        let ipCheckService = false;
        let rimRotation = false;
        let wheelAlignment = false;
        let tyreRotation = false;
        let isAlignmentUnfit = false;
        let imagesPush = [];
        //#region service selection validation
        let matchService = services.find(x => x.ServiceTypeId == req.body.ServiceTypeId);
        if (!matchService) {
            return res.send({ success: false, error: 'Requested service not found in jobcard.' });
        }

        if ((matchService.sub && matchService.sub.length) && !req.body.SubServiceTypeId) {
            return res.send({ success: false, error: 'Please select child service for selected parent service.' });
        }

        if (req.body.ServiceName == "Tyre Onboarding" || req.body.SubServiceName == "Tyre Onboarding") {
            let Asset = AplJobCard.Asset;
            if (Tyres.length != parseInt(Asset.axleProfile.split('W')[0] - inActAxleCount)) {
                return res.send({ success: false, error: 'Tyre onboarding pending for this vehicle. Please onboard all tyres to complete this service.' });
            }
        } else if (req.body.ServiceName == "Tyre & Vehicle Inspection" || req.body.SubServiceName == "Tyre & Vehicle Inspection") {
            let data = {
                AssetId: AplJobCard.AssetId,
                date: AplJobCard.inTime,
                type: ['vd', 'v']
            };
            if ([2, 3].indexOf(AplJobCard.status) > -1) {
                data.type = "v";
                data.AplJobCardId = AplJobCard.id;
            }
            let vehInspt = await avolveHelper.fetchInspectionByJobCard(data);
            if (!vehInspt || !vehInspt.success) {
                return res.send({ success: false, error: 'Vehicle inspection pending for this vehicle. Please inspect to complete this service.' });
            }
            data.type = 't';
            let tyInspt = await avolveHelper.fetchInspectionByJobCard(data);
            if (!tyInspt || !tyInspt.success) {
                return res.send({ success: false, error: 'Tyre inspection pending for this vehicle. Please inspect to complete this service.' });
            }
        } else if (req.body.ServiceName == "Tyre Fitment") {
            if (!matchService.execTyres) {
                matchService.execTyres = 0;
            }
            if (matchService.noOfTyres && (matchService.noOfTyres != matchService.execTyres)) {
                return res.send({ success: false, error: 'Fitted tyres count mismatch with given tyre count.' });
            }
        } else if (req.body.ServiceName == "Tyre Rotation On Rim") {
            tyreRotation = true;
            let execTyres = details.filter(x => x.flipped == true);
            let rotationDetails = details.filter(x => x.currentPosition != "");
            if (matchService.noOfTyres) {
                if (matchService.noOfTyres > execTyres.length) {
                    return res.send({ success: false, error: `Atleast ${matchService.noOfTyres} tyres should be flipped to proceed.` });
                } else if (matchService.noOfTyres < execTyres.length) {
                    return res.send({ success: false, error: `Cannot flip more than ${matchService.noOfTyres} tyres to proceed.` });
                }
                let execPositions = execTyres.filter(x => x.currentPosition != "")
                if (matchService.noOfTyres > execPositions.length) {
                    return res.send({ success: false, error: `Please select flipped tyres current position to proceed.` });
                }
            }
            rotationDetails = rotationDetails.map(x => x.currentPosition);
            if (new Set(rotationDetails).size !== rotationDetails.length) {
                return res.send({ success: false, error: 'Duplicates found in current position. Please select different position and proceed.' });
            }
            rimRotation = true;

            if (AplJobCard.details && AplJobCard.details.skipWheelRot) {
                evt.events.emit('avolve-update-rotation-serSch', { // update tyreRotOnRim exeDate as next service cycle date for wheel roation
                    AccountId: AplJobCard.AccountId,
                    AssetId: AplJobCard.AssetId,
                    sTime: ServiceBooking.date,
                    odo: AplJobCard.Asset && AplJobCard.Asset.odo || ''
                });
            }
        } else if (req.body.ServiceName == "IP Check & Correction" || req.body.SubServiceName == "IP Check & Correction") {
            let psiData = details.filter(x => x.crctPsi != "");
            if ((details.length - inActAxleCount) != psiData.length) {
                return res.send({ success: false, error: 'Please enter corrected IP and proceed.' });
            }
            ipCheckService = true;
        } else {
            if (!details && !Object.keys(details).length) {
                return res.send({ success: false, error: 'Details must be mandatory for this service.' });
            }
            if (req.body.ServiceName == "Wheel Alignment" || req.body.SubServiceName == "Wheel Alignment") {
                wheelAlignment = true;
                isAlignmentUnfit = req.body.isAlignmentUnfit && true || false;
                if (!isAlignmentUnfit && (!details || (details && !details.length))) {
                    return res.send({ success: false, error: 'Wheel alignment details must be mandatory to complete this service.' });
                }
            }
            if (["Tyre Rotation", "Wheel Rotation", "En Route Tyre Rotation"].indexOf(req.body.ServiceName) > -1) {
                tyreRotation = true;

                //#region 
                let execTyres = details.filter(x => x.currentPosition);
                if (matchService.noOfTyres) {
                    if (matchService.noOfTyres > execTyres.length) {
                        return res.send({ success: false, error: `Atleast ${matchService.noOfTyres} tyres should be rotated to proceed.` });
                    } else if (matchService.noOfTyres < execTyres.length) {
                        return res.send({ success: false, error: `Cannot rotate more than ${matchService.noOfTyres} tyres to proceed.` });
                    }
                    let execPositions = execTyres.filter(x => x.currentPosition != "")
                    if (matchService.noOfTyres > execPositions.length) {
                        return res.send({ success: false, error: `Please select rotated tyre position to proceed.` });
                    }
                }
                //#endregion

                //#region tyre position validation
                let rotationDetails = details.filter(x => x.currentPosition != "");
                if (rotationDetails.length < 2) {
                    return res.send({ success: false, error: 'Atleast 2 tyres position to be changed to complete this service.' });
                }
                let validateSamePos = rotationDetails.find(x => x.inspectedPosition == x.currentPosition);
                if (validateSamePos) {
                    return res.send({ success: false, error: 'Inspected and current position cannot be same.' });
                }
                rotationDetails = rotationDetails.map(x => x.currentPosition);
                if (new Set(rotationDetails).size !== rotationDetails.length) {
                    return res.send({ success: false, error: 'Duplicates found in current position. Please select different position and proceed.' });
                }
                //#endregion
            }

            if (req.body.ServiceName == "En Route Tyre Replacement" || req.body.SubServiceName == "En Route Tyre Replacement") {
                let enrouteFitment = await models.TyreHistory.findOne({
                    attributes: ['id'],
                    where: {
                        transaction: 'Fitment',
                        AplJobCardId: AplJobCard.id
                    }
                });

                if (!enrouteFitment) {
                    return res.send({ success: false, error: 'Tyre replacement is required for this service.' });
                }
            }
        }
        //#endregion

        let matchSubService = {};
        if (matchService) {
            matchService.completed = true;
            if (["En Route Tyre Replacement", "Tyre Fitment"].indexOf(req.body.ServiceName) == -1) {
                matchService.details = details || [];
            }
            if (matchService.sub && matchService.sub.length) {
                matchService.completed = false;
                matchSubService = matchService.sub.find(x => x.ServiceTypeId == req.body.SubServiceTypeId);
                if (matchSubService) {
                    matchSubService.completed = true;
                    matchService.details = [];
                    matchSubService.details = details && details || [];
                }
                if (matchService.sub.length == matchService.sub.filter(x => x.completed == true).length) {
                    matchService.completed = true;
                }
            }
            let alignUnfitImgs = [];
            if (req.files && req.files.length) {
                alignUnfitImgs = req.files.map(obj => {
                    imagesPush.push(obj);
                    return '/' + md5(res.locals.AccountId) + '/Apollo/JobCard/' + AplJobCard.id + '_' + obj.filename;
                })
            }
            if (req.body.ServiceName == "Wheel Alignment") {
                matchService.images = alignUnfitImgs.length && alignUnfitImgs || matchService.alignUnfitImgs || [];
                matchService.remarks = req.body.remarks || '';
                matchService.isAlignmentUnfit = isAlignmentUnfit;
            }
            if (req.body.SubServiceName == "Wheel Alignment") {
                matchSubService.images = alignUnfitImgs.length && alignUnfitImgs || matchService.alignUnfitImgs || [];
                matchSubService.remarks = req.body.remarks || '';
                matchSubService.isAlignmentUnfit = isAlignmentUnfit;
            }
        }

        let enRouteReplacement = services.find(x => x.serviceName == "En Route Tyre Replacement");
        if (enRouteReplacement && !enRouteReplacement.completed) {
            return res.send({ success: false, error: 'Please complete En Route Tyre Replacement service and proceed.' });
        }

        //#region - update inspection & tyreOnb details in jobcard for Onb service.
        let isOnbService = services.some(x => x.serviceName == "Onboarding Service");
        if (isOnbService && matchSubService && matchSubService.completed == true) {
            if (matchSubService.serviceName == 'Tyre Onboarding') {
                let tyreOnbResult = await avolveHelper.getTyreOnbDetails(AplJobCard.id);
                if (!tyreOnbResult.success) {
                    RaiseLogEvent(ROUTE, AplJobCard.id, tyreOnbResult.error, 'Error fetching tyre Onboarding service details');
                } else {
                    matchSubService.details = tyreOnbResult.results;
                }
            }
            if (matchSubService.serviceName == 'Tyre & Vehicle Inspection') {
                let tyreInspectResult = await avolveHelper.getInspectionDetails(AplJobCard.id);
                if (!tyreInspectResult.success) {
                    RaiseLogEvent(ROUTE, AplJobCard.id, tyreInspectResult.error, 'Error fetching inspection service details');
                } else {
                    matchSubService.details = tyreInspectResult.results;
                }
            }
        } else if (matchService.serviceName == "Tyre & Vehicle Inspection") {
            let tyreInspectResult = await avolveHelper.getInspectionDetails(AplJobCard.id);
            if (!tyreInspectResult.success) {
                RaiseLogEvent(ROUTE, AplJobCard.id, tyreInspectResult.error, 'Error fetching inspection service details');
            } else {
                matchService.details = tyreInspectResult.results;
            }
        }
        //#endregion

        let updJobCard = await AplJobCard.update({
            services: services
        });

        if (imagesPush && imagesPush.length) {
            for (const image of imagesPush) {
                if (image && image.path) {
                    evt.events.emit('file-upload-handler-s3', {
                        file: image.path,
                        s3Path: md5(res.locals.AccountId) + '/Apollo/JobCard/' + updJobCard.id + '_' + image.filename
                    });
                }
            }
        }

        let assetOdo = AplJobCard && AplJobCard.odo || 0;
        if (matchService && matchService.completed == true) {
            RaiseLogEvent(ROUTE, updJobCard.AssetId, matchService, `${req.body.ServiceName} recieved  for avolve service sonsumed count update`)
            let consumedCount = 1;
            if (['Tyre Fitment', 'Tyre Rotation On Rim', 'Wheel Rotation'].indexOf(matchService.serviceName) > -1 && matchService.noOfTyres) {
                consumedCount = Number(matchService.noOfTyres);
            }
            let alignmentUnfit = matchService.serviceName == 'Wheel Alignment' && req.body.isAlignmentUnfit;

            if (!alignmentUnfit) {
                let AplService = await models.AplService.findOne({
                    attributes: ['id', 'services'],
                    where: {
                        AssetId: updJobCard.AssetId,
                        AccountId: updJobCard.AccountId
                    }
                });

                if (!AplService) {
                    RaiseLogEvent("rmq-apl-amc-count-update", updJobCard.AssetId, matchService, `AplService not found.`);
                }

                if (AplService) {
                    let services = JSON.parse(JSON.stringify(AplService.services));
                    let matchService = services.find(x => x.serviceName == req.body.ServiceName);
                    if (matchService) {
                        matchService.consumed = matchService.consumed && (Number(matchService.consumed) + Number(consumedCount)) || Number(consumedCount);
                        if (Number(matchService.consumed) >= Number(matchService.alloted)) {
                            matchService.valid = false;
                            matchService.completed = true;
                        }
                    }

                    await AplService.update({
                        services: services
                    });
                    RaiseLogEvent(ROUTE, updJobCard.AssetId, matchService, `${req.body.ServiceName} sent  for avolve service consumed count update`)
                }
            }

            let subServices = matchService.sub && matchService.sub || [];
            if (subServices.length) {
                for (const subService of subServices) {
                    evt.events.emit('update-service-schedule', {
                        AssetId: updJobCard.AssetId,
                        ServiceTypeId: subService.ServiceTypeId,
                        odo: assetOdo,
                        serviceTime: moment().format("YYYY-MM-DD"),
                        updateOdo: true
                    });
                }
                let sTime = req.body.startTime && moment(req.body.startTime, 'DD/MM/YYYY hh:mm A').toISOString() || moment().toISOString();
                evt.events.emit('create-apollo-service-log', { //:TODO need to check service log created properly & sTime need to add
                    AssetId: updJobCard.AssetId,
                    ServiceTypeId: matchService.ServiceTypeId,
                    AccountId: updJobCard.AccountId,
                    serviceName: matchService.serviceName,
                    odo: assetOdo,
                    transaction: matchService.serviceName,
                    details: matchService.details,
                    AplJobCardId: updJobCard.id,
                    inTime: sTime,
                    outTime: sTime,
                    sTime: sTime,
                    updServiceSch: false
                });
            } else {
                evt.events.emit('update-service-schedule', {
                    AssetId: updJobCard.AssetId,
                    ServiceTypeId: matchService.ServiceTypeId,
                    odo: assetOdo,
                    serviceTime: moment().format("YYYY-MM-DD"),
                    updateOdo: true
                });

                if (["Tyre Onboarding"].indexOf(matchService.serviceName) == -1) {
                    let sTime = req.body.startTime && moment(req.body.startTime, 'DD/MM/YYYY hh:mm A').toISOString() || moment().toISOString();
                    evt.events.emit('create-apollo-service-log', {
                        AssetId: updJobCard.AssetId,
                        ServiceTypeId: matchService.ServiceTypeId,
                        AccountId: updJobCard.AccountId,
                        serviceName: matchService.serviceName,
                        odo: assetOdo,
                        transaction: matchService.serviceName,
                        details: matchService.details,
                        AplJobCardId: updJobCard.id,
                        inTime: sTime,
                        outTime: sTime,
                        sTime: sTime,
                        updServiceSch: false
                    });
                }

                //update service alert execution
                if (ServiceBooking && ServiceBooking.type == 0) {
                    evt.events.emit('update-avolve-serviceAlert-status', {
                        AssetId: updJobCard.AssetId,
                        AccountId: updJobCard.AccountId,
                        ServiceTypeId: matchService.ServiceTypeId,
                        ScheduleId: matchService.ScheduleId,
                        BookingId: ServiceBooking.id,
                        AplJocardId: updJobCard.id,
                        odo: assetOdo,
                        serviceDate: req.body.startTime && moment(req.body.startTime, 'DD/MM/YYYY hh:mm A').format('YYYY-MM-DD') || moment().format('YYYY-MM-DD'),
                        booking: true
                    });
                }
            }
        }

        //#region IP Check & Correction tyre transaction capture
        if (ipCheckService) {
            let ipCheckData = updJobCard.services.find(x => x.serviceName == "IP Check & Correction");
            if (!ipCheckData) { //Check if it is in sub service
                for (let service of updJobCard.services) {
                    ipCheckData = service.sub.find(x => x.serviceName == "IP Check & Correction");
                    if (ipCheckData) {
                        break;
                    }
                }
            }
            if (ipCheckData.details && ipCheckData.details.length) {
                let ipCheckedTyres = ipCheckData.details.filter(x => x.tyreNo != "");
                for (let tyre of ipCheckedTyres) {
                    tyre.AccountId = updJobCard.AccountId;
                    tyre.AssetId = updJobCard.AssetId;
                    tyre.date = moment().toISOString();
                    tyre.AplJobCardId = updJobCard.id;
                    evt.events.emit('create-apl-psiCorrect-tyrehist', tyre);
                }
            }
        }
        //#endregion

        //#region Wheel Alignment tyre transaction capture
        if (!req.body.isAlignmentUnfit && wheelAlignment) {
            let alignData = updJobCard.services.find(x => x.serviceName == "Wheel Alignment");
            if (!alignData) {
                for (let service of updJobCard.services) {
                    alignData = service.sub.find(x => x.serviceName == "Wheel Alignment");
                    if (alignData) {
                        break;
                    }
                }
            }

            let alignment = {};
            alignment.AccountId = updJobCard.AccountId;
            alignment.AssetId = updJobCard.AssetId;
            alignment.date = moment().toISOString();
            alignment.AplJobCardId = updJobCard.id;
            alignment.assetOdo = assetOdo;
            alignment.inspectedBy = res.locals.username;
            alignment.UserId = res.locals.UserId;
            alignment.createHist = true;
            alignment.details = alignData.details && alignData.details || [];
            evt.events.emit('apl-fetch-axle-tyres', alignment);
        }
        //#endregion

        //#region Tyre rotation and wheel rotation
        if (tyreRotation || rimRotation) {
            let tyreRotationData = updJobCard.services.find(x => ["Tyre Rotation On Rim", "Wheel Rotation"].indexOf(x.serviceName) > -1);
            if (!tyreRotationData) {
                for (let service of updJobCard.services) {
                    tyreRotationData = service.sub.find(x => ["Tyre Rotation On Rim", "Wheel Rotation"].indexOf(x.serviceName) > -1);
                    if (tyreRotationData) {
                        break;
                    }
                }
            }

            if (!tyreRotationData) {
                RaiseLogEvent(ROUTE, updJobCard.AssetId, updJobCard.services, `Tyre rotation or rotation on rim not matching.`);
            }

            let matchedTyres = tyreRotationData.details && tyreRotationData.details.filter(x => x.currentPosition != "") || [];
            matchedTyres = matchedTyres.filter(x => x.tyreNo != "");
            for (let tyre of matchedTyres) {
                let isPosChange = tyre.currentPosition && tyre.inspectedPosition && tyre.inspectedPosition != tyre.currentPosition && true || false;
                tyre.AccountId = updJobCard.AccountId;
                tyre.AssetId = updJobCard.AssetId;
                tyre.date = moment().toISOString();
                tyre.AplJobCardId = updJobCard.id;
                tyre.assetOdo = assetOdo;
                tyre.inspectedBy = res.locals.username;
                tyre.UserId = res.locals.UserId;
                tyre.serviceName = req.body.ServiceName;
                if (isPosChange) {
                    if (rimRotation && tyre.flipped == true) {
                        tyre.flippedAndRoation = true;
                    }
                    evt.events.emit('create-avolve-amc-tyreRotation-tyrehist', tyre);
                } else if (tyre.flipped == true && rimRotation) {
                    evt.events.emit('create-apl-rotationOnRim-tyrehist', tyre);
                }
            }
        }
        //#endregion
        return res.send({ success: true, jobcard: updJobCard });

    } catch (err) {
        return handleApiError(res, ROUTE, 'Error executing jobcard', err);
    }
}

exports.approve = async function (req, res) {
    const ROUTE = 'app/jobcards/approve';
    try {
        RaiseLogEvent(ROUTE, res.locals.AccountId, req.params, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

        if (['FM'].indexOf(res.locals.role) == -1) {
            return res.send({ success: false, error: 'Not Authorized.' });
        }

        if (!req.params.id) {
            return res.send({ success: false, error: "Missing or invalid input parameter" });
        }

        let AplJobCard = await models.AplJobCard.findOne({
            attributes: ['id', 'asset', 'status', 'log'],
            where: { id: req.params.id, AccountId: res.locals.AccountId }
        });

        if (!AplJobCard) {
            return res.send({ success: false, error: "Jobcard not found" });
        }

        let User = await models.User.findOne({
            attributes: ['id', 'username', 'firstName', 'lastName', 'mobile'],
            where: {
                id: res.locals.UserId,
                activeStatus: true
            }
        });

        if (!User) {
            return res.send({ success: false, error: 'User not found.' });
        }

        let log = JSON.parse(JSON.stringify(AplJobCard.log));
        log.approvedBy = {
            id: User.id,
            name: User.firstName + (User.lastName ? ' ' + User.lastName : ''),
            username: User.username,
            note: req.body.note,
            date: moment().toISOString()
        };

        let updJobCard = await AplJobCard.update({
            log: log,
            status: 1 //approved
        });

        return res.send({ success: true, jobcard: updJobCard });
    } catch (err) {
        return handleApiError(res, ROUTE, 'Error approving jobcard', err);
    }
}

exports.complete = async function (req, res) {
    const ROUTE = 'app/jobcards/complete';
    try {
        RaiseLogEvent(ROUTE, res.locals.AccountId, req.params, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

        if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) == -1) {
            return res.send({ success: false, error: 'Not Authorized.' });
        }

        if (!req.params.id) {
            return res.send({ success: false, error: "Missing or invalid input parameter" });
        }

        if (!req.query.GeozoneId) {
            return res.send({ success: false, error: "Please select workshop and proceed." });
        }

        let whereClause = {
            id: req.params.id,
            GeozoneId: req.query.GeozoneId
        };

        if (res.locals.role == "AMCC FTE") {
            whereClause.AccountId = res.locals.accountIds;
        }


        let AplJobCard = await models.AplJobCard.findOne({
            attributes: ['id', 'asset', 'status', 'log', 'details'],
            where: whereClause
        });

        if (!AplJobCard) {
            return res.send({ success: false, error: "Jobcard not found" });
        }

        let User = await models.User.findOne({
            attributes: ['id', 'username', 'firstName', 'lastName', 'mobile'],
            where: {
                id: res.locals.UserId,
                activeStatus: true
            }
        });

        if (!User) {
            return res.send({ success: false, error: 'User not found.' });
        }

        let log = JSON.parse(JSON.stringify(AplJobCard.log));
        log.completedBy = {
            id: User.id,
            name: User.firstName + (User.lastName ? ' ' + User.lastName : ''),
            username: User.username,
            note: req.body.note,
            date: moment().toISOString()
        };

        let details = JSON.parse(JSON.stringify(AplJobCard.details));
        let jobCardImgs = [];
        let imagesPush = [];
        if (req.files && req.files.length) {
            jobCardImgs = req.files.map(obj => {
                imagesPush.push(obj);
                return '/' + md5(res.locals.AccountId) + '/Apollo/JobCard/' + AplJobCard.id + '_' + obj.filename;
            })
        }
        details.jobCardImgs = jobCardImgs.length && jobCardImgs || details.jobCardImgs;

        let updJobCard = await AplJobCard.update({
            log: log,
            details: details,
            status: 2 //completed
        });

        for (const image of imagesPush) {
            if (image && image.path) {
                evt.events.emit('file-upload-handler-s3', {
                    file: image.path,
                    s3Path: md5(res.locals.AccountId) + '/Apollo/JobCard/' + updJobCard.id + '_' + image.filename
                });
            }
        }

        return res.send({ success: true, jobcard: updJobCard });
    } catch (err) {
        return handleApiError(res, ROUTE, 'Error completing jobcard', err);
    }
}

exports.gatepass = async function (req, res) {
    const ROUTE = 'app/jobcards/gatepass';
    try {
        RaiseLogEvent(ROUTE, res.locals.AccountId, req.params, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

        if (['AMCS FTE', 'AMCC FTE'].indexOf(res.locals.role) == -1) {
            return res.send({ success: false, error: 'Not Authorized.' });
        }
        if (!req.params.id) {
            return res.send({ success: false, error: "Missing or invalid input parameter" });
        }

        if (!req.query.GeozoneId) {
            return res.send({ success: false, error: "Please select workshop and proceed." });
        }

        let whereClause = {
            id: req.params.id,
            GeozoneId: req.query.GeozoneId
        };

        if (res.locals.role == "AMCC FTE") {
            whereClause.AccountId = res.locals.accountIds;
        }


        let AplJobCard = await models.AplJobCard.findOne({
            attributes: ['id', 'asset', 'status', 'log', 'details', 'services', 'ServiceBookingId', 'AssetId', 'inTime', 'AccountId'],
            include: [{
                attributes: ['id', 'plan'],
                model: models.Asset
            }],
            where: whereClause
        });

        if (!AplJobCard) {
            return res.send({ success: false, error: "Jobcard not found" });
        }

        let User = await models.User.findOne({
            attributes: ['id', 'username', 'firstName', 'lastName', 'mobile'],
            where: {
                id: res.locals.UserId,
                activeStatus: true
            }
        });

        if (!User) {
            return res.send({ success: false, error: 'User not found.' });
        }

        let log = JSON.parse(JSON.stringify(AplJobCard.log));
        log.closedBy = {
            id: User.id,
            name: User.firstName + (User.lastName ? ' ' + User.lastName : ''),
            username: User.username,
            date: moment().toISOString()
        };

        let details = JSON.parse(JSON.stringify(AplJobCard.details));

        let signatureImages = [];
        let imagesPush = [];
        if (req.files && req.files.length) {
            signatureImages = req.files.map(obj => {
                imagesPush.push(obj);
                return '/' + md5(res.locals.AccountId) + '/Apollo/JobCard/' + AplJobCard.id + '_' + obj.filename;
            })
        }
        details.signatureImages = signatureImages.length && signatureImages || details.signatureImages;
        details.driverName = req.body.driverName;

        let updJobCard = {};
        await models.sequelize.transaction(async t => {
            updJobCard = await AplJobCard.update({
                log: log,
                details: details,
                outTime: moment().toISOString(),
                status: 3 //closed
            }, { transaction: t });

            await models.ServiceBooking.update({ //Service Boooking Closure
                status: 3
            }, {
                where: { id: updJobCard.ServiceBookingId }
            }, { transaction: t });
        });

        for (const image of imagesPush) {
            if (image && image.path) {
                evt.events.emit('file-upload-handler-s3', {
                    file: image.path,
                    s3Path: md5(res.locals.AccountId) + '/Apollo/JobCard/' + updJobCard.id + '_' + image.filename
                });
            }
        }

        for (const service of updJobCard.services) {
            let subServices = service.sub && service.sub || [];
            for (const subService of subServices) {
                evt.events.emit('update-service-schedule', {
                    AssetId: updJobCard.AssetId,
                    ServiceTypeId: subService.ServiceTypeId,
                    updateOdo: false
                });
            }
            evt.events.emit('update-service-schedule', {
                AssetId: updJobCard.AssetId,
                ServiceTypeId: service.ServiceTypeId,
                updateOdo: false
            });
        }

        //emit to AplReports to sync
        evt.events.emit('apl-reportlog', {
            AccountId: updJobCard.AccountId,
            reportValues: ['ss'],
            month: moment(updJobCard.createdAt).format('MM'),
            year: moment(updJobCard.createdAt).format('YYYY')
        });

        if (AplJobCard.Asset && AplJobCard.Asset.plan && AplJobCard.Asset.plan == 1) {
            evt.events.emit('apl-fte-serviceSummary', {
                AccountId: res.locals.masterAccountId,
                plan: 1,
                month: moment(updJobCard.createdAt).format('MM'),
                year: moment(updJobCard.createdAt).format('YYYY')
            });
        }

        return res.send({ success: true, jobcard: updJobCard });
    } catch (err) {
        return handleApiError(res, ROUTE, 'Error closing jobcard', err);
    }
}

exports.getJobCardbyAsset = async function (req, res) {
    const ROUTE = 'app/jobcards/getJobCardbyAsset';
    try {
        if (!['AMCC FTE', 'AMCS FTE'].includes(res.locals.role)) {
            return res.send({ success: false, error: 'Not Authorized.' });
        }

        if (!req.params.id) {
            return res.send({ success: false, error: 'Missing input parameter.' });
        }

        let Asset = await models.Asset.findOne({
            attributes: ['id', 'AccountId'],
            include: [{
                attributes: [],
                model: models.Account,
                where: {
                    AccountIdParent: res.locals.masterAccountId
                }
            }],
            where: {
                id: req.params.id,
                active: true,
                remove: false
            }
        });

        if (!Asset) {
            return res.send({ success: false, error: 'Vehicle not found.' });
        }

        let AplJobCard = await models.AplJobCard.findOne({
            attributes: ['id', 'jobCardNo', 'workshop', 'user', 'status', 'GeozoneId'],
            where: {
                status: { [Op.in]: [0, 1] }, //Pending, Approved
                AssetId: Asset.id,
                AccountId: Asset.AccountId
            },
            order: [['id', 'desc']],
            raw : true
        });

        if (AplJobCard) {
            let jobcardStatus = '';
            switch (AplJobCard.status) {
                case 0: jobcardStatus = 'Pending'; break;
                case 1: jobcardStatus = 'Approved'; break;
                default: jobcardStatus = ''; break;
            }

            let message = `<html><p>The vehicle has an active job card`;
            if (AplJobCard.workshop && AplJobCard.workshop.name) {
                message += ` in the CV zone at <b>${AplJobCard.workshop.name}</b>`;
            }
            if (jobcardStatus) {
                message += `, with the status <b>${jobcardStatus}</b>`;
            }
            if (AplJobCard.jobCardNo) {
                message += ` ${jobcardStatus ? 'and' : 'with'} job card number <b>${AplJobCard.jobCardNo}</b>`;
            }
            message += ', Please complete the jobcard to proceed.</html></p>';

            let result = {
                status: jobcardStatus,
                secFte: false,
                message: message
            };

            let createdBy = AplJobCard.user && AplJobCard.user.createdBy && AplJobCard.user.createdBy.id || '';
            if (createdBy != res.locals.UserId) {
                result.secFte = true;
            }

            if (result.secFte) {
                let User = await models.User.findOne({
                    attributes: ['id', 'mobile'],
                    include: [{
                        attributes: [],
                        model: models.AplUser,
                        required: true,
                        where: {
                            geozones: { [Op.contains]: [{ id: AplJobCard.GeozoneId }] }
                        }
                    }],
                    where: {
                        activeStatus: true
                    }
                });
                result.secFteNumber = User && User.mobile || '';
            }
            return res.send({ success: false, result: result });
        } else {
            return res.send({ success: true });
        }
    } catch (error) {
        return handleApiError(res, ROUTE, 'Error fetching jobcard', error);
    }
}

function getOfferName(plan) {
    let planName = '';
    switch (plan) {
        case 1:
            planName = 'AMC Edge Shared';
            break;
        case 2:
            planName = 'AMC Edge Captive';
            break;
        case 3:
            planName = 'Digital Edge';
            break;
        case 4:
            planName = 'Xpert Edge';
            break;
        default:
            break;
    }
    return planName;
}