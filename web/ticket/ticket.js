const models = require("../../../models");
const { Op } = require("sequelize");
const moment = require('moment');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const avolveTicketConfig = require('../../../config/avolve-ticketConfig.json');
const { getAccount } = require('../../../lib/helpers/redis')
const evt = require('../../../lib/event');
const md5 = require('../../../lib/md5').md5;
const { handleApiError } = require('../../middlewares/helper');

exports.getCaseTypes = async (req, res) => {
	const ROUTE = 'web/tickets/getCaseTypes';
	try {
		return res.send({ success: true, results: avolveTicketConfig.caseTypes || [] });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching case types', error);
	}
}

exports.create = async (req, res) => {
	const ROUTE = 'web/tickets/create';
	try {
		RaiseLogEvent('avolve/ticket/create', res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName || res.locals.username}.`);
		if (req.body.AccountId) {
			const Account = await getAccount(req.body.AccountId);
			if (!Account) {
				return res.send({ success: false, error: 'Account not found.' });
			}
		}
		// Required fields validation
		if (!req.body.caseType || !req.body.caseSubType) {
			return res.send({ success: false, error: 'Case type or subtype is missing.' });
		}
		if (!req.body.subject) {
			return res.send({ success: false, error: 'Title is missing.' });
		}
		if (!req.body.description) {
			return res.send({ success: false, error: 'Description is missing.' });
		}

		// Find logged in user
		let User = await models.User.count({
			where: { id: res.locals.UserId }
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found' });
		}

		let ticketToIT = req.body.caseType == 3; //"Application Issue"

		let attachments = { files: [] };
		const files = Array.isArray(req.files) ? req.files : [];
		if (files?.length) {
			attachments.files = files.map(image => {
				return `/${md5(res.locals.masterAccountId)}/AVOLVE/AvolveTickets/${new Date().getFullYear()}/${res.locals.UserId}_${image.filename}`;
			});
			attachments.fileNames = getFileName(req.files, req.body.fileMetadata || []);;
		}

		// Create
		await models.sequelize.transaction(async (t) => {
			let crmTicket = {};
			let userName = res.locals.userFullName || res.locals.username || '';
			let notes = req.body.remarks ? [{
				empId: 1,
				empName: 'Admin 1',
				empNo: '1',
				department: 'Admin',
				date: moment().toISOString()
			}] : [];

			let crmCreateLog = [{
				emp: {
					id: 1,
					name: "Admin 1",
					number: "1"
				},
				time: "2026-01-06T12:06:15.805Z",
				status: 1,
				changes: []
			}];

			if (ticketToIT) {
				crmTicket = await models.CrmTicket.create({
					title: req.body.subject,
					description: req.body.description,
					priority: 'High',
					department: 'IT',
					status: 1,
					attachments: attachments,
					AccountId: req.body.AccountId || res.locals.masterAccountId,
					EmployeeIdCreatedBy: 1,
					users: {
						createdBy: {
							id: 1,
							date: moment().toISOString(),
							name: "Admin 1",
							number: "1",
							department: "Admin"
						}
					},
					notes: notes,
					logs: crmCreateLog
				}, { transaction: t });
			}

			await models.AplTicket.create({
				caseType: req.body.caseType,
				caseSubType: req.body.caseSubType,
				title: req.body.subject,
				description: req.body.description,
				attachments: attachments,
				status: 1,
				users: {
					createdBy: {
						id: res.locals.UserId,
						role: res.locals.role,
						username: userName,
						date: moment().toISOString()
					}
				},
				logs: [{
					date: moment().toISOString(),
					status: 1,
					note: req.body.remarks,
					id: res.locals.UserId,
					role: res.locals.role,
					username: userName
				}],
				UserIdCreatedBy: res.locals.UserId,
				AccountId: req.body.AccountId || null,
				CrmTicketId: ticketToIT ? crmTicket.id : null
			}, { transaction: t });
		});

		if (req?.files?.length) {
			files.forEach(file => {
				evt.events.emit('file-upload-handler-s3', {
					file: file.path,
					s3Path: `${md5(res.locals.masterAccountId)}/AVOLVE/AvolveTickets/${new Date().getFullYear()}/${res.locals.UserId}_${file.filename}`,
					contentType: file.mimetype
				});
			});
		}

		return res.send({ success: true });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching ticket create', error);
	}
};

exports.list = async (req, res) => {
	const ROUTE = 'web/tickets/list';
	try {
		RaiseLogEvent('avolve/ticket/list', res.locals.AccountId, req.body, `Requested by ${res.locals.username}.`);

		let ticketWhere = {};
		let Account = {};
		if (req.query.AccountId) {
			Account = await getAccount(req.query.AccountId);
			if (!Account) {
				return res.send({ success: false, error: 'Account not found.' });
			}
			ticketWhere.AccountId = req.query.AccountId;
		}

		if (req.query.accountIds) {
			ticketWhere.AccountId = req.query.accountIds;
		}
		
		if (!['Admin', 'FM', 'FO'].includes(res.locals.role)) {
			ticketWhere.UserIdAssignedTo = res.locals.UserId;
		}

		if (req.query.sdate && req.query.edate) {
			ticketWhere.createdAt = { [Op.between]: [req.query.sdate, req.query.edate] }
		}
		if (req.query.caseType) {
			ticketWhere.caseType = req.query.caseType;
		}
		if (req.query.ticketStatus) {
			ticketWhere.status = req.query.ticketStatus;
		}

		let AplTickets = await models.AplTicket.findAll({
			attributes: ['id', 'caseType', 'caseSubType', 'title', 'AccountId', 'status', 'completedAt',
				[models.sequelize.literal(`"users"->'createdBy'`), 'createdBy'],
				[models.sequelize.literal(`"users"->'assignedTo'`), 'assignedTo']
			],
			order: [['createdAt', 'desc']],
			where: ticketWhere,
			raw: true
		});

		for (const AplTicket of AplTickets) {
			let matchedCaseType = avolveTicketConfig.caseTypes.find(x => x.id == AplTicket.caseType) || {};
			AplTicket.caseType = matchedCaseType?.caseType || '';
			AplTicket.caseSubType = matchedCaseType.subTypes.find(x => x.id == AplTicket.caseSubType)?.text || '';
			AplTicket.tname = Account.tname || '';
		}

		return res.send({ success: true, results: AplTickets });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching the tickets', error);
	}
}

exports.get = async (req, res) => {
	const ROUTE = 'web/tickets/get';
	try {
		RaiseLogEvent('avolve/ticket/get', res.locals.AccountId, req.body, `Requested by ${res.locals.username}.`);

		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let AplTicket = await models.AplTicket.findOne({
			attributes: ['id', 'caseType', 'caseSubType', 'title', 'AccountId', 'status', 'logs', 'description', 'notes', 'createdAt', 'updatedAt', 'attachments', [models.sequelize.literal(`"users"->'assignedTo'`), 'assignedTo']],
			where: {
				id: req.params.id
			},
			raw: true
		});

		if (!AplTicket) {
			return res.send({ success: false, error: 'Ticket not found' });
		}

		const { tname = '' } = await getAccount(AplTicket.AccountId) || {};
		AplTicket.customer = tname;

		let matchedCaseType = avolveTicketConfig.caseTypes.find(x => x.id == AplTicket.caseType) || {};
		AplTicket.caseType = matchedCaseType?.caseType || '';
		AplTicket.caseSubType = matchedCaseType.subTypes.find(x => x.id == AplTicket.caseSubType)?.text || '';

		return res.send({ success: true, result: AplTicket });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching the ticket', error);
	}
}

exports.update = async (req, res) => {
	const ROUTE = 'web/tickets/update';
	try {
		RaiseLogEvent('avolve/ticket/update', res.locals.AccountId, req.body, `Requested by ${res.locals.username}.`);
		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing.' });
		}

		// Required fields validation
		if (!req.body.caseType || !req.body.caseSubType) {
			return res.send({ success: false, error: 'Case type or subtype is missing.' });
		}
		if (!req.body.subject) {
			return res.send({ success: false, error: 'Title is missing.' });
		}
		if (!req.body.description) {
			return res.send({ success: false, error: 'Description is missing.' });
		}

		// Find existing ticket
		let Ticket = await models.AplTicket.findOne({
			attributes: ['id', 'caseType', 'caseSubType', 'title', 'description', 'notes', 'users', 'logs', 'AccountId', 'CrmTicketId'],
			where: {
				id: Number(req.params.id)
			}
		});

		if (!Ticket) {
			return res.send({ success: false, error: 'Ticket not found' });
		}

		let userName = res.locals.userFullName || res.locals.username || '';
		let userData = {
			id: res.locals.UserId,
			role: res.locals.role,
			username: userName,
			date: moment().toISOString(),
		};

		// Prepare updated fields
		const updatedNotes = Array.isArray(Ticket.notes)
			? [...Ticket.notes]
			: [];

		const logs = [...Ticket.logs];
		let logNote = checkUpdateStatusLog(logs, Ticket.status, req.body.remarks, userData);
		if (logNote) {
			updatedNotes.push(logNote)
		}

		const updatedUsers = {
			...Ticket.users,
			updatedBy: userData
		};

		// Transaction
		await models.sequelize.transaction(async (t) => {
			await Ticket.update(
				{
					caseType: req.body.caseType || Ticket.caseType,
					caseSubType: req.body.caseSubType || Ticket.caseSubType,
					title: req.body.title || Ticket.title,
					description: req.body.description || Ticket.description,
					notes: updatedNotes,
					users: updatedUsers,
					logs,
					AccountId: req.body.AccountId || Ticket.AccountId
				},
				{ transaction: t }
			);
		});

		return res.send({ success: true });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error updating ticket', error);
	}
}

exports.updateStatus = async (req, res) => {
	const ROUTE = 'avolve/ticket/updateStatus';
	const LOG_KEY = 'avolve/ticket/updateStatus';
	try {
		RaiseLogEvent(LOG_KEY, res.locals.AccountId, req.body, `Requested by ${res.locals.username}.`);

		const ticketId = Number(req.params.id);
		const { status, remarks, assignedUserId } = req.body;

		if (!ticketId || !status) {
			return res.send({ success: false, error: 'Required parameters are missing.' });
		}

		const ticket = await models.AplTicket.findOne({
			attributes: ['id', 'users', 'status', 'logs', 'notes'],
			where: { id: ticketId }
		});

		if (!ticket) {
			return res.send({ success: false, error: 'Ticket not found.' });
		}

		const userName =
			res.locals.userFullName || res.locals.username || '';

		const actionUser = {
			id: res.locals.UserId,
			role: res.locals.role,
			username: userName,
			date: moment().toISOString()
		};

		let updatedUsers = { ...(ticket.users || {}) };

		if (Number(status) === 2) { // Assigned
			updatedUsers.assignedBy = actionUser;

			if (assignedUserId) {
				const assignedUser = await models.User.findOne({
					attributes: ['id', 'firstName', 'lastName', 'username'],
					include: [{
						model: models.UserRole,
						attributes: ['name']
					}],
					where: { id: assignedUserId },
					raw: true,
					nest: true
				});

				if (assignedUser) {
					updatedUsers.assignedTo = {
						id: assignedUser.id,
						role: assignedUser?.UserRole?.name || '',
						username:
							[assignedUser.firstName, assignedUser.lastName]
								.filter(Boolean)
								.join(' ') ||
							assignedUser.username ||
							'',
						date: moment().toISOString()
					};
				}
			}
		}

		let completedAt = null;
		if (Number(status) === 4) { // closed
			updatedUsers.closedBy = actionUser;
			completedAt = moment().toISOString();
		}

		if (Number(status) === 5) { // cancelled
			updatedUsers.cancelledBy = actionUser;
		}

		const updatedNotes = Array.isArray(ticket.notes)
			? [...ticket.notes]
			: [];


		const updatedLogs = Array.isArray(ticket.logs)
			? [...ticket.logs]
			: [];

		let logNote = checkUpdateStatusLog(
			updatedLogs,
			Number(status),
			remarks,
			actionUser
		);

		if (logNote) {
			updatedNotes.push(logNote);
		}

		let updateTicket = {
			status: Number(status),
			users: updatedUsers,
			notes: updatedNotes,
			logs: updatedLogs,
			completedAt: completedAt,
		}
		if (Number(status) == 2) {
			updateTicket.UserIdAssignedTo = assignedUserId || null,
			updateTicket.UserIdAssignedBy = res.locals.UserId;
		}

		await models.sequelize.transaction(async (t) => {
			await ticket.update(
				updateTicket,
				{ transaction: t }
			);
		});

		return res.send({ success: true });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error updating ticket status', error);
	}
}

exports.count = async (req, res) => {
	const ROUTE = 'web/tickets/count';
	try {
		let ticketWhere = {};
		if (req.query.AccountId) {
			ticketWhere.AccountId = req.query.AccountId;
		}
		
		if (res.locals.role != 'Admin') {
			ticketWhere.AccountId = req.query.AccountId;
		}

		const Tickets = await models.AplTicket.findAll({
			attributes: ['status', 'caseType', 'createdAt', 'completedAt'],
			where: ticketWhere,
			raw: true
		});

		let result = { created: 0, avgTat: 0, unresolved: 0, product: 0, billing: 0, application: 0, others: 0 };
		let totalTatMs = 0;
		let closedCount = 0;

		for (const ticket of Tickets) {
			result.created++;

			// Category counts (unresolved)
			if (![4, 5].includes(ticket.status)) {
				result.unresolved++;

				if (ticket.caseType === 1) result.product++;
				else if (ticket.caseType === 2) result.billing++;
				else if (ticket.caseType === 3) result.application++;
				else result.others++;
			}

			// Avg TAT calculation (ONLY closed tickets)
			if (ticket.status === 4 && ticket.completedAt) {
				const tatMs =
					new Date(ticket.completedAt) - new Date(ticket.createdAt);

				if (tatMs > 0) {
					totalTatMs += tatMs;
					closedCount++;
				}
			}
		}

		// Convert Avg TAT to hours
		if (closedCount > 0) {
			result.avgTat = Number(
				(totalTatMs / closedCount / (1000 * 60 * 60)).toFixed(2)
			);
		}

		return res.send({ success: true, result });

	} catch (error) {
		return handleApiError(res, ROUTE, 'Error calculating ticket stats', error);
	}
};

// Get ticket status
function getTicketStatus(status) {
	switch (status) {
		case 1: return 'Open';
		case 2: return 'Assigned';
		case 3: return 'In Progress';
		case 4: return 'Closed';
		case 5: return 'Cancelled';
		case 6: return 'Closed';
		default: return 'Reopened';
	}
}

const getFileName = (fileList, fileMetadata = [], oldFileNames = []) => {
	if (!Array.isArray(fileList)) return [];

	let metadata = [];
	if (fileMetadata) {
		if (typeof fileMetadata === 'string') {
			try {
				metadata = JSON.parse(fileMetadata);
			} catch {
				metadata = [];
			}
		} else if (Array.isArray(fileMetadata)) {
			metadata = fileMetadata;
		}
	}

	const fileNames = [];

	for (let file of fileList) {
		if (!file) continue;

		let fileId = '';
		let finalName = '';

		// Extract ID from stored filename
		if (file.filename) {
			fileId = file.filename.split('.')[0];
		}

		// Default name from original file
		if (file.originalname) {
			finalName = file.originalname.substring(0, file.originalname.lastIndexOf('.')) || file.originalname;
		}

		// Override name from metadata (if provided)
		const meta = metadata.find(m =>
			m &&
			(
				m.id === fileId ||
				m.originalName === finalName
			)
		);

		if (meta && meta.userFileName) {
			finalName = meta.userFileName;
		}

		fileNames.push({
			id: fileId,
			name: finalName || fileId
		});
	}

	return fileNames;
};


// check the existing status log, if exists then append notes and update latest date, else push new log {}
function checkUpdateStatusLog(logs, aplticketStatus, note, userData) {
	let lastLog = logs[logs.length - 1];
	let logNote = null;
	if (lastLog && aplticketStatus == lastLog.status) {
		lastLog.date = moment().toISOString();
		if (note) {
			logNote = {
				note: note,
				date: moment().toISOString(),
				id: userData.id,
				role: userData.role,
				username: userData.username
			}
		}
	} else {
		logs.push({
			note: note,
			date: moment().toISOString(),
			status: aplticketStatus,
			id: userData.id,
			role: userData.role,
			username: userData.username
		});
	}
	return logNote;
}