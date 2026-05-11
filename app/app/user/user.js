const env = process.env.NODE_ENV || "development";
const app_json = process.env.NODE_ENV_APP_JSON || 'app.json';
const moment = require("moment");
const jwt = require('jsonwebtoken');
const models = require("../../../models");
const { Op } = require("sequelize");
const { events } = require('../../../lib/event');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const redisHelper = require('../../../lib/helpers/redis');
const AppConfig = require('../../../config/' + app_json)[env];
const config = require('../../../config/security.json');
const aplMenus = require('../../../config/apl-menu-list.json');
const avolveHelper = require('../../../lib/helpers/avolveHelper');
const md5 = require('../../../lib/md5').md5;
const { getEmailTemplate } = require('../../../lib/helpers/emailTemplates');
const MailBotBcc = ["mail@kttelematic.com"];
const itEmail = ["itsupport@kttelematic.com"];
const { isIndianRegion, getMasterAccIdByRegion } = require('../../../lib/helpers/region');

const ValueFirst = require('../../../lib/helpers/valueFirst');
const valueFirst = new ValueFirst();

const OTP_ATTEMPT_KEY_PREFIX = 'avl:otp';
const OTP_ATTEMPT_LIMIT = 3;
const OTP_ATTEMPT_TTL = 1800; // 30 mins lockout window

const OTP_RESEND_KEY_PREFIX = 'avl:otpResend';
const OTP_RESEND_LIMIT = 2;
const OTP_RESEND_TTL = 180; // 3 mins resend window

const OTP_AUTH_TOKEN_TTL = 600; // 10 mins — step 2 → step 3 gate
const OTP_TTL = 180; // 3 mins — OTP validity

function buildReplyUserLogin(user) {
	let replyUser = {};
	replyUser = user.dataValues;
	delete replyUser.password;
	delete replyUser.Geozones;
	delete replyUser.Groups;
	return replyUser;
}

function getRandomInt(min, max) {
	min = Math.ceil(min);
	max = Math.floor(max);
	return Math.floor(Math.random() * (max - min)) + min; //The maximum is exclusive and the minimum is inclusive
}

exports.get = async function (req, res) {
	const ROUTE = 'app/users/get';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'UserId Missing.' });
		}

		let User = await models.User.findOne({
			attributes: ['id', 'AccountId', 'username', 'email', 'mobile', 'firstName', 'lastName', 'images', 'userCode', 'accountIds', 'details'],
			include: [{
				attributes: ['id', 'geozones'],
				model: models.AplUser
			}, {
				attributes: ['id', 'name'],
				model: models.UserRole
			},
			{
				attributes: ['id', 'name', 'tname', 'city'],
				model: models.Account
			}],
			where: {
				id: req.params.id,
				AccountId: res.locals.AccountId
			}
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found' });
		}

		return res.send({ success: true, user: User });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching user.');
		return res.send({ success: false, error: 'Error fetching user.' });
	}
}

exports.getByManager = async function (req, res) {
	const ROUTE = 'app/users/getByManager';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'UserId Missing.' });
		}

		let User = await models.User.findOne({
			attributes: ['id', 'AccountId', 'username'],
			where: {
				id: req.params.id,
				AccountId: res.locals.masterAccountId,
				activeStatus: true
			}
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found' });
		}

		let response = await avolveHelper.getUsersByManager(User.id, res.locals.masterAccountId);
		if (!response.success) {
			return res.send({ success: false, error: 'Error fetching users' });
		}

		return res.send({ success: true, results: response.results });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, `Data ${JSON.stringify(req.params)}`);
		return res.send({ success: false, error: 'Error fetching users.' });
	}
}

exports.getKamList = async function (req, res) {
	const ROUTE = 'app/users/getKamList'
	try {
		if (!['HO Sales', 'FTS HO', 'ZM', 'FTS ZM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not authorized.' });
		}
		if (!req.params.id) {
			return res.send({ success: false, error: 'UserId Missing.' });
		}

		let User = await models.User.findOne({
			attributes: ['id', 'AccountId', 'username', 'details'],
			where: {
				id: req.params.id,
				AccountId: res.locals.masterAccountId,
				activeStatus: true
			}
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found' });
		}

		let zmId = User.id;
		if (["HO Sales", "FTS HO"].includes(res.locals.role)) {
			zmId = User.details && User.details.bdm || [];
		}
		let response = await avolveHelper.getKamListByUser(zmId, true, true);
		if (!response.success) {
			return res.send({ success: false, error: 'Error fetching users' });
		}

		return res.send({ success: true, results: response.results });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, `Data ${JSON.stringify(req.params)}`);
		return res.send({ success: false, error: 'Error fetching users.' });
	}
}

exports.getMenuList = async function (req, res) {
	const ROUTE = 'app/users/getMenuList';
	try {
		if (!res.locals.role) {
			return res.send({ success: false, error: 'UserId Missing.' });
		}

		let menus = aplMenus && aplMenus[res.locals.role] && aplMenus[res.locals.role] || [];
		if (res.locals.role == "FM") {
			if ([3, 4].indexOf(res.locals.plan) > -1) {
				menus = menus.filter(x => x != "Service Schedules");
			}
		}

		return res.send({ success: true, roleName: res.locals.role, results: menus });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, `Data ${JSON.stringify(req.params)}`);
		return res.send({ success: false, error: 'Error fetching user.' });
	}
}

exports.getSession = async function (req, res) {
	const ROUTE = 'app/users/getSession';
	try {
		if (!req.params.id) {
			return res.send({ success: false, error: 'UserId Missing.' });
		}

		const masterAccountId = getMasterAccIdByRegion(req.get('X-AVL-Region'));
		let User = await models.User.findOne({
			attributes: ['id', 'username', 'password', 'email', 'mobile', 'role', 'activeStatus', 'firstName', 'lastName', 'accountIds', 'AccountId', 'details'],
			include: [{
				attributes: ['id', 'name'],
				model: models.UserRole,
				where: {
					name: { [Op.ne]: 'Admin' }
				},
				required: true
			},
			{
				attributes: ['id', 'name', 'tname', 'status', 'type', 'details'],
				model: models.Account,
				where: {
					[Op.or]: {
						AccountIdParent: masterAccountId,
						id: masterAccountId
					},
					status: 1
				}
			}],
			where: {
				id: req.params.id
			}
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found' });
		}

		if (!User.UserRole) {
			return res.send({ success: false, error: 'Role not assigned to this user.' });
		}

		if (!User.Account) {
			return res.send({ success: false, error: 'Customer not assigned to this user.' });
		}

		if (['FM', 'FO', 'KAM', 'DE FTE', 'XE FTE', 'ARSA', 'AMCS FTE', 'AMCC FTE', 'ZM', 'FTS ZM', 'HO Sales', 'FTS HO', "FTS KAM"].indexOf(User.UserRole.name) == -1) {
			return res.send({ success: false, error: 'Not Authorized to this user role.' });
		}

		let userAgent = req.headers['user-agent'] === undefined ? '' : req.headers['user-agent'];
		let Account = User.Account;
		if (userAgent.includes("Load Board/") && Account.type != 6) {
			return res.send({ success: false, error: 'Account not authorized' });
		}

		let dataUserObj = initDataForAvolveLogin(Account, User);
		let userObj = dataUserObj.user;
		let dataObj = dataUserObj.data;

		let secret = await redisHelper.getAsync('accountsec:' + Account.id);
		if (secret == null) {
			secret = config.session.secret;
		}
		dataObj.success = true;
		dataObj.sessionToken = jwt.sign(buildReplyUserLogin(userObj), secret, { expiresIn: '7d' });
		return res.send(dataObj);

	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, `Data ${JSON.stringify(req.params)}`);
		return res.send({ success: false, error: 'Error fetching user.' });
	}
}

exports.login = async function (req, res) {
	const ROUTE = 'app/users/login';
	try {
		RaiseLogEvent(ROUTE, req.body.mobile, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		const mobileNo = req.body.mobile ? req.body.mobile.replace(/\s/g, '').trim() : null;
		const email = req.body.email ? req.body.email.trim() : null;
		const { pwd } = req.body;

		const isEmailChannel = !isIndianRegion(req.get('X-AVL-Region'));
		if (isEmailChannel) {
			if (!email) return res.send({ success: false, error: 'Email is required.' });
		} else {
			if (!mobileNo) return res.send({ success: false, error: 'Mobile is required.' });
			if (mobileNo.trim().length != 10) {
				return res.send({ success: false, error: 'Please enter valid mobile number.' });
			}
		}
		if (!pwd) {
			return res.status(401).send({ success: false, error: 'Missing password' });
		}

		let User = {};
		if (isEmailChannel) {
			User = await avolveHelper.findUser(req.get('X-AVL-Region'), null, email);
		} else {
			User = await avolveHelper.findUser(req.get('X-AVL-Region'), mobileNo, null);
		}

		if (!User) {
			let error = 'User not found';
			if (isEmailChannel) error = `User with email ${email} not found.`
			else error = `User with mobile ${mobileNo} not found.`;
			return res.send({ success: false, error: error });
		}
		if (!User.UserRole) {
			return res.send({ success: false, error: 'Role not assigned to this user.' });
		}
		if (!User.Account) {
			return res.send({ success: false, error: 'Customer not assigned to this user.' });
		}
		if (['FM', 'FO', 'KAM', 'DE FTE', 'XE FTE', 'ARSA', 'AMCS FTE', 'AMCC FTE', 'ZM', 'FTS ZM', 'HO Sales', 'FTS HO', 'FTS KAM'].indexOf(User.UserRole.name) == -1) {
			return res.send({ success: false, error: 'Not Authorized to this user role.' });
		}

		let userAgent = req.headers['user-agent'] === undefined ? '' : req.headers['user-agent'];
		let match = await models.User.checkPasswordAsync(pwd, User.password)
		if (!match) {
			return res.status(401).send({ success: false, error: 'Incorrect password' });
		}

		//#region logic to find mobile no in multiple profiles
		let usersGroup = await avolveHelper.getUsers(mobileNo, email, true, req.get('X-AVL-Region'));
		if (!usersGroup.success) {
			RaiseLogEvent(ROUTE, 'error', usersGroup.error, `Data ${JSON.stringify(req.body)}`);
			return res.send({ success: false, error: 'Error in processing your request.' });
		}
		if (usersGroup.results && usersGroup.results.length > 1) { //Multiple profile usersGroup
			return res.send({ success: false, multiple: true, results: usersGroup.results });
		}
		//#endregion

		let Account = User.Account;
		if (userAgent.includes("Load Board/") && Account.type != 6) {
			return res.send({ success: false, error: 'Account not authorized' });
		}

		let dataUserObj = initDataForAvolveLogin(Account, User);
		let userObj = dataUserObj.user;
		let dataObj = dataUserObj.data;
		let secret = await redisHelper.getAsync('accountsec:' + Account.id)
		if (secret == null) {
			secret = config.session.secret;
		}

		dataObj.success = true;
		dataObj.sessionToken = jwt.sign(buildReplyUserLogin(userObj), secret, { expiresIn: '7d' });

		return res.send(dataObj);
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, `Data ${JSON.stringify(req.body)}`);
		return res.send({ success: false, error: 'Error in processing your request.' });
	}
}

exports.listByRole = async function (req, res) {
	const ROUTE = 'app/users/listByRole';
	try {
		if (!req.params.role) {
			return res.send({ success: false, error: 'User Role Missing.' });
		}
		let Users = await models.User.findAll({
			attributes: ['id', 'username', 'firstName'],
			include: [{
				attributes: ['id', 'name'],
				model: models.UserRole,
				where: {
					name: decodeURIComponent(req.params.role)
				},
				required: true
			}],
			where: {
				AccountId: res.locals.masterAccountId,
				activeStatus: true
			}
		});
		return res.send({ success: true, results: Users });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, `Data ${JSON.stringify(req.params)}`);
		return res.send({ success: false, error: 'Error fetching user.' });
	}
}

exports.register = async function (req, res) {
	const ROUTE = 'app/users/register';
	try {
		RaiseLogEvent(ROUTE, req.body.mobile || 'log', req.body, `Data received`);
		const mobileNo = req.body.mobile ? req.body.mobile.replace(/\s/g, '').trim() : null;
		const email = req.body.email ? req.body.email.trim() : null;
		const { pwd } = req.body;

		const isEmailChannel = !isIndianRegion(req.get('X-AVL-Region'));
		if (isEmailChannel) {
			if (!email) return res.send({ success: false, error: 'Email is required.' });
		} else {
			if (!mobileNo) return res.send({ success: false, error: 'Mobile is required.' });
			if (mobileNo.trim().length != 10) {
				return res.send({ success: false, error: 'Please enter valid mobile number.' });
			}
		}

		let UserWhere = {};
		if (isEmailChannel) {
			UserWhere = { email };
		} else {
			UserWhere = { mobile: mobileNo };
		}

		let User = await models.User.findOne({
			include: [{
				model: models.UserRole,
				attributes: ['id', 'name'],
				where: {
					name: "FO"
				}
			}, {
				model: models.Account,
				attributes: ['id', 'name', 'tname', 'phone1'],
				where: {
					type: 11,
					AccountIdParent: getMasterAccIdByRegion(req.get('X-AVL-Region'))
				},
				required: false
			}],
			where: UserWhere
		});

		if (!User || !User.UserRole) {
			let error = 'User not found';
			if (isEmailChannel) error = `User with email ${email} not found.`
			else error = `User with mobile ${mobileNo} not found.`;
			return res.send({ success: false, error: error });
		}
		if (!User.Account) {
			return res.send({ success: false, error: `Your account is not associated with Avolve.` });
		}
		if (User.UserRole.name != 'FO') {
			return res.send({ success: false, error: `Only Fleet Owner logins are allowed to self register.` });
		}
		if (!pwd && User.activeStatus == true) {
			return res.send({ success: false, error: `User ${User.username} already registered and activated. Please login to use Avolve.` });
		}

		let redisKey = isEmailChannel ? `avolveUserOTP:${mobileNo}` : `avolveUserOTP:${email}`;
		let otpRedis = await redisHelper.getAsync(redisKey);
		if (req.body.step != 1 && !otpRedis) {
			RaiseLogEvent('users/register', 'error', {}, `Data ${JSON.stringify(req.body)}`);
			return res.status(500).send({ success: false, error: "Failed to send OTP. Please try again" });
		}

		if (req.body.resend) {
			if (!otpRedis) {
				return res.status(403).send({ success: false, error: 'No ongoing OTP found.' });
			}
			if (isEmailChannel) {
				const { subject, htmlTemplate } = getEmailTemplate('resetPasswordOtp', { otp: otpRedis });
				events.emit('send-avolve-mail', {
					to: email,
					title: subject,
					html: htmlTemplate
				});
				RaiseLogEvent(ROUTE, User.email, { otp: otpRedis, subject }, `Email OTP sent`);
				sendSuccess = true;
			} else {
				const otpMsg = `OTP to verify your Avolve customer registration is ${otpRedis}. Regards - Team Avolve`;
				const { response, error } = await valueFirst.sendMessage(User.mobile, otpMsg);
				if (error && !response) {
					RaiseLogEvent(ROUTE, User.mobile, { status: error.response?.status }, 'SMS send failed');
					return res.send({ success: false, error: 'Failed to send OTP SMS. Please try again.' });
				}
				RaiseLogEvent(ROUTE, User.mobile, { status: response?.status }, 'SMS OTP sent');
				sendSuccess = true;
			}
			return res.status(203).send({ success: true, error: `OTP re-sent to your registered mobile ******${User.mobile.substr(User.mobile.length - 4)}` });
		}

		if (req.body.step == 1) {
			if (otpRedis) {
				return res.status(403).send({ success: false, error: 'Ongoing OTP authentication pending. Please retry after 3 minutes' });
			}
			let otp = getRandomInt(10000, 99999);
			if (isEmailChannel) {
				const { subject, htmlTemplate } = getEmailTemplate('resetPasswordOtp', { otp });
				events.emit('send-avolve-mail', {
					to: email,
					title: subject,
					html: htmlTemplate
				});
				RaiseLogEvent(ROUTE, User.email, { otp, subject }, `Email OTP sent`);
				sendSuccess = true;
			} else {
				const otpMsg = `OTP to verify your Avolve customer registration is ${otp}. Regards - Team Avolve`;
				const { response, error } = await valueFirst.sendMessage(User.mobile, otpMsg);
				if (error && !response) {
					RaiseLogEvent(ROUTE, User.mobile, { status: error.response?.status }, 'SMS send failed');
					return res.send({ success: false, error: 'Failed to send OTP SMS. Please try again.' });
				}
				RaiseLogEvent(ROUTE, User.mobile, { status: response?.status }, 'SMS OTP sent');
				sendSuccess = true;
			}
			console.log(otp)
			models.redis.set(redisKey, otp);
			models.redis.expire(redisKey, 180); // 3 minutes
			return res.status(203).send({ success: true, error: `An SMS with verification code was sent to your registered mobile ******${User.mobile.substr(User.mobile.length - 4)}` });
		} else if (req.body.step == 2) {
			if (!req.body.otp) {
				return res.status(403).send({ success: false, error: 'Invalid OTP' });
			}
			if (otpRedis != req.body.otp) {
				return res.status(403).send({ success: false, error: 'Invalid OTP' });
			} else {
				await User.update({
					activeStatus: true
				});
				return res.send({ success: true });
			}
		} else if (req.body.step == 3) {
			if (!pwd) {
				return res.status(403).send({ success: false, error: 'Invalid password' });
			}
			let hash = await models.User.hashAsync(pwd);
			if (!hash) {
				RaiseLogEvent(ROUTE, 'error', {}, `Data ${JSON.stringify(req.body)}`);
				return res.status(500).send({ success: false, error: "Failed to update password. Please try again" });
			} else {
				await User.update({ password: hash });
				models.redis.del(redisKey);
				let welcomeMsg = `Dear ${Account.oname} Congratulations. You have been registered in ${offerType} program. For more information call us at our support number ${supportNumber}. Team Avolve`;
				let response = await valueFirst.sendMessage(User.mobile, otpMsg);
				return res.send({ success: true });
			}
		} else {
			return res.status(403).send({ success: false, error: 'Invalid operation' });
		}

	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error in processing your request.');
		return res.send({ success: false, error: 'Error in processing your request.' });
	}
}

function maskMobile(mobile) {
	return `******${mobile.substr(mobile.length - 4)}`;
}

function getRemainingMins(ttlSeconds, firstTimestamp) {
	const remainingMs = (ttlSeconds * 1000) - (Date.now() - firstTimestamp);
	return Math.max(1, Math.ceil(remainingMs / 60000));
}

/**
 * Send OTP via SMS or Email based on channel.
 */
async function sendOtp(channel, otp, User, email, ROUTE) {
	if (channel === 'email') {
		const { subject, htmlTemplate } = getEmailTemplate('resetPasswordOtp', { otp });
		events.emit('send-avolve-mail', { to: email, title: subject, html: htmlTemplate });
		RaiseLogEvent(ROUTE, User.email, { otp, subject }, 'Email OTP sent');
	} else {
		const otpMsg = `${otp} is the one-time password(OTP) to reset your password for Avolve application. OTP is valid for next 3 minutes only. Team Avolve`;
		const { response, error } = await valueFirst.sendMessage(User.mobile, otpMsg);
		if (error && !response) {
			const log = { status: error.response?.status, statusText: error.response?.statusText };
			RaiseLogEvent(ROUTE, User.mobile, log, `SMS send failed`);
			throw new Error('SMS_SEND_FAILED');
		}
		RaiseLogEvent(ROUTE, User.mobile, { status: response?.status || '' }, 'SMS OTP sent');
	}
}

async function verifyAuthToken(headerToken, redisOtpTokenKey, secret) {
	try {
		if (!headerToken || !redisOtpTokenKey || !secret) return false;
		const decoded = jwt.verify(headerToken, secret);
		if (!decoded || !decoded.mobile || ![true, 'true'].includes(decoded.otpVerified)) return false;
		const storedToken = await redisHelper.GETAsync(redisOtpTokenKey);
		if (!storedToken || storedToken !== headerToken) return false;
		return true;
	} catch {
		return false;
	}
}

function maskEmail(email) {
	let [username, domain] = email.split('@');
	let firstTwoChars = username.substring(0, 2);
	let lastTwoChars = username.substring(username.length - 2);
	let middlePart = "x".repeat(username.length - 4);
	return firstTwoChars + middlePart + lastTwoChars + "@" + domain;
}

exports.resetPassword = async function (req, res) {
	const ROUTE = 'avolve/users/resetPassword';
	try {
		RaiseLogEvent(ROUTE, req.body.mobile || req.body.email || 'log', req.body, 'Data received');

		// Channel detection
		const isEmailChannel = !isIndianRegion(req.get('X-AVL-Region'));
		const mobileNo = !isEmailChannel ? (req.body.mobile || '').replace(/\D/g, '').trim() : null;
		const email = isEmailChannel ? (req.body.email || '').trim() : null;

		// Input validation
		if (isEmailChannel) {
			if (!email) {
				return res.status(400).send({ success: false, error: 'Email is required.' });
			}
		} else {
			if (!mobileNo) {
				return res.status(400).send({ success: false, error: 'Mobile number is required.' });
			}
			if (mobileNo.length !== 10) {
				return res.status(400).send({ success: false, error: 'Please enter a valid 10-digit mobile number.' });
			}
		}

		// User lookup
		const User = await avolveHelper.findUser(req.get('X-AVL-Region'), mobileNo, email);

		if (!User) {
			const error = isEmailChannel ? `User with email ${maskEmail(email)} not found.` : `User with mobile ${maskMobile(mobileNo)} not found.`;
			return res.status(404).send({ success: false, error });
		}
		if (!User.UserRole) {
			return res.status(403).send({ success: false, error: 'Role not assigned to this user.' });
		}
		if (!isEmailChannel && !User.mobile) {
			return res.status(403).send({ success: false, error: 'Mobile number not mapped with user. Please update and proceed.' });
		}
		if (!User.Account) {
			return res.status(403).send({ success: false, error: `Account not found for user ${User.username}.` });
		}
		if (![10, 11].includes(User.Account.type)) {
			RaiseLogEvent(ROUTE, 'error', req.body, 'Account not mapped to Avolve');
			return res.status(403).send({ success: false, error: 'Your account is not mapped to Avolve.' });
		}

		// Redis key setup
		const identifier = isEmailChannel ? email : User.mobile;
		const accountId = User.Account.id;
		const redisOtpKey = `avl:userOtp:${identifier}`; // stores the OTP value
		const redisOtpTokenKey = `avl:otpToken:${identifier}`; // stores JWT after step 2
		const otpAttemptKey = `${OTP_ATTEMPT_KEY_PREFIX}:${accountId}:${identifier}`; // wrong-OTP counter
		const otpResendKey = `${OTP_RESEND_KEY_PREFIX}:${accountId}:${identifier}`; // resend counter
		const secret = config.session.secret;
		const { step } = req.body;

		// STEP 1 — Generate & send OTP
		if (step == 1) {
			// Check attempt lockout before even reading the OTP key
			const attemptRaw = await redisHelper.GETAsync(otpAttemptKey);
			const attemptData = attemptRaw ? JSON.parse(attemptRaw) : null;

			if (attemptData && attemptData.count >= OTP_ATTEMPT_LIMIT) {
				const remainingMins = getRemainingMins(OTP_ATTEMPT_TTL, attemptData.firstAttemptAt);
				RaiseLogEvent(ROUTE, identifier, { count: attemptData.count }, 'Step 1 — still locked');
				return res.status(429).send({ success: false, redirect: true, error: `Too many incorrect OTP attempts. Please try again after ${remainingMins} minute(s).` });
			}

			// Block if a live OTP already exists — avoids OTP flooding
			const existingOtp = await redisHelper.GETAsync(redisOtpKey);
			if (existingOtp) {
				return res.status(403).send({ success: false, error: 'OTP already sent. Please check your inbox/SMS or use the resend option.' });
			}

			const otp = getRandomInt(10000, 99999);
			try {
				await sendOtp(isEmailChannel ? 'email' : 'sms', otp, User, email, ROUTE);
			} catch {
				return res.status(500).send({ success: false, error: 'Error sending OTP. Please try again.' });
			}

			await redisHelper.setAsync(redisOtpKey, otp, 'EX', OTP_TTL);
			return res.status(203).send({ success: true, message: isEmailChannel ? `A verification code was sent to ${maskEmail(email)}.` : `A verification code was sent to ${maskMobile(User.mobile)}.` });

		// RESEND — Re-send existing OTP (rate-limited separately)
		} else if (req.body.resend) {
			const otpRedis = await redisHelper.GETAsync(redisOtpKey);
			if (!otpRedis) {
				return res.status(403).send({ success: false, error: 'No active OTP session found. Please request a new OTP.' });
			}

			const resendRaw = await redisHelper.GETAsync(otpResendKey);
			const resendData = resendRaw ? JSON.parse(resendRaw) : null;

			if (resendData && resendData.count >= OTP_RESEND_LIMIT) {
				const remainingMins = getRemainingMins(OTP_RESEND_TTL, resendData.firstResendAt);
				RaiseLogEvent(ROUTE, identifier, { count: resendData.count }, 'Resend rate limit hit');
				return res.status(429).send({ success: false, redirect: true, error: `OTP resend limit reached. Please request a new OTP after ${remainingMins} minute(s).` });
			}

			try {
				await sendOtp(isEmailChannel ? 'email' : 'sms', otpRedis, User, email, ROUTE);
			} catch {
				return res.status(500).send({ success: false, error: 'Error resending OTP. Please try again.' });
			}

			const newResendCount = (resendData?.count || 0) + 1;
			const resendRecord = JSON.stringify({
				count: newResendCount,
				firstResendAt: resendData?.firstResendAt || Date.now()
			});

			// Reset wrong-attempt counter on resend so user gets fresh attempts
			await redisHelper.delAsync(otpAttemptKey);
			await redisHelper.setAsync(otpResendKey, resendRecord, 'EX', OTP_RESEND_TTL);

			RaiseLogEvent(ROUTE, identifier, { newResendCount, resendsLeft: OTP_RESEND_LIMIT - newResendCount }, 'OTP resent');
			return res.status(203).send({ success: true, message: isEmailChannel ? `OTP resent to ${maskEmail(email)}.` : `OTP resent to ${maskMobile(User.mobile)}.` });

		// STEP 2 — Verify OTP -> issues otpAuthToken
		} else if (step == 2) {
			if (!req.body.otp) {
				return res.status(400).send({ success: false, error: 'OTP is required.' });
			}

			const attemptRaw = await redisHelper.GETAsync(otpAttemptKey);
			const attemptData = attemptRaw ? JSON.parse(attemptRaw) : null;

			if (attemptData && attemptData.count >= OTP_ATTEMPT_LIMIT) {
				const remainingMins = getRemainingMins(OTP_ATTEMPT_TTL, attemptData.firstAttemptAt);
				RaiseLogEvent(ROUTE, identifier, { count: attemptData.count }, 'Step 2 — OTP locked');
				return res.status(429).send({ success: false, redirect: true, error: `Too many incorrect attempts. Please try again after ${remainingMins} minute(s).` });
			}

			const otpRedis = await redisHelper.GETAsync(redisOtpKey);

			if (!otpRedis || String(req.body.otp) !== String(otpRedis)) {
				const newCount = (attemptData?.count || 0) + 1;
				const attemptsLeft = OTP_ATTEMPT_LIMIT - newCount;
				const record = JSON.stringify({
					count: newCount,
					firstAttemptAt: attemptData?.firstAttemptAt || Date.now(),
					verified: false
				});
				await redisHelper.setAsync(otpAttemptKey, record, 'EX', OTP_ATTEMPT_TTL);
				RaiseLogEvent(ROUTE, identifier, { newCount, attemptsLeft }, 'Step 2 — invalid OTP');

				if (attemptsLeft <= 0) {
					// Wipe OTP + resend keys so step 1 shows lockout, not "OTP already sent"
					await redisHelper.delAsync(redisOtpKey);
					await redisHelper.delAsync(otpResendKey);
					return res.status(429).send({ success: false, redirect: true, error: `Too many incorrect OTP attempts. Please request a new OTP after 30 minute(s).` });
				}

				return res.status(403).send({ success: false, error: `Invalid OTP. You have ${attemptsLeft} attempt(s) remaining.` });
			}

			// OTP correct — stamp verified flag, issue auth token
			const verifiedRecord = JSON.stringify({
				count: attemptData?.count || 0,
				firstAttemptAt: attemptData?.firstAttemptAt || Date.now(),
				verified: true
			});
			await redisHelper.setAsync(otpAttemptKey, verifiedRecord, 'EX', OTP_ATTEMPT_TTL);

			const otpAuthToken = jwt.sign(
				{ UserId: User.id, mobile: User.mobile, otpVerified: true },
				secret,
				{ expiresIn: OTP_AUTH_TOKEN_TTL }
			);
			await redisHelper.setAsync(redisOtpTokenKey, otpAuthToken, 'EX', OTP_AUTH_TOKEN_TTL);
			await User.update({ activeStatus: true });

			RaiseLogEvent(ROUTE, identifier, {}, 'Step 2 — OTP verified, token issued');
			return res.send({ success: true, otpAuthToken });

		// STEP 3 — Set new password (requires valid otpAuthToken + OTP)
		} else if (step == 3) {
			if (!req.body.pwd) {
				return res.status(400).send({ success: false, error: 'Password is required.' });
			}

			const attemptRaw = await redisHelper.GETAsync(otpAttemptKey);
			const attemptData = attemptRaw ? JSON.parse(attemptRaw) : null;

			if (attemptData && attemptData.count >= OTP_ATTEMPT_LIMIT) {
				const remainingMins = getRemainingMins(OTP_ATTEMPT_TTL, attemptData.firstAttemptAt);
				RaiseLogEvent(ROUTE, identifier, { count: attemptData.count }, 'Step 3 — locked');
				return res.status(429).send({ success: false, redirect: true, error: `Too many incorrect OTP attempts. Please try again after ${remainingMins} minute(s).` });
			}

			// Verified flag guard — step 2 must have completed successfully
			if (!attemptData?.verified) {
				return res.status(403).send({ success: false, redirect: true, error: 'OTP verification required before setting a new password.' });
			}

			// Re-validate OTP (defence-in-depth — prevents token replay without live OTP)
			const otpRedis = await redisHelper.GETAsync(redisOtpKey);
			if (!req.body.otp || !otpRedis || String(req.body.otp) !== String(otpRedis)) {
				const newCount = (attemptData?.count || 0) + 1;
				const attemptsLeft = OTP_ATTEMPT_LIMIT - newCount;
				const record = JSON.stringify({
					count: newCount,
					firstAttemptAt: attemptData?.firstAttemptAt || Date.now(),
					verified: attemptData?.verified || false
				});
				await redisHelper.setAsync(otpAttemptKey, record, 'EX', OTP_ATTEMPT_TTL);
				RaiseLogEvent(ROUTE, identifier, { newCount, attemptsLeft }, 'Step 3 — invalid OTP');

				if (attemptsLeft <= 0) {
					await redisHelper.delAsync(redisOtpKey);
					await redisHelper.delAsync(otpResendKey);
					return res.status(429).send({ success: false, redirect: true, error: 'Too many incorrect OTP attempts. Please request a new OTP after 30 minute(s).' });
				}
				return res.status(403).send({ success: false, error: `Invalid or missing OTP. You have ${attemptsLeft} attempt(s) remaining.` });
			}

			// Validate otpAuthToken from header — the step 2 → step 3 gate
			const headerToken = req.get('X-AVL-OtpToken');
			if (!headerToken) {
				RaiseLogEvent(ROUTE, 'error', req.body, 'OTP auth token missing in header');
				return res.status(403).send({ success: false, error: 'OTP auth token missing.' });
			}
			const isTokenVerified = await verifyAuthToken(headerToken, redisOtpTokenKey, secret);
			if (!isTokenVerified) {
				RaiseLogEvent(ROUTE, 'error', req.body, 'Invalid or expired OTP token');
				return res.status(403).send({ success: false, error: 'Invalid or expired OTP token.' });
			}

			// Hash and persist
			const hash = await models.User.hashAsync(req.body.pwd);
			if (!hash) {
				RaiseLogEvent(ROUTE, 'error', {}, 'Password hash failed');
				return res.status(500).send({ success: false, error: 'Failed to update password. Please try again.' });
			}

			try {
				const multiProfile = await avolveHelper.getUsers(mobileNo, email, true, req.get('X-AVL-Region'));
				if (multiProfile.results && multiProfile.results.length > 1) {
					RaiseLogEvent(ROUTE, identifier, multiProfile.results, 'Multiple profiles — bulk update');
					await models.User.update(
						{ password: hash },
						{ where: { id: multiProfile.results.map(x => x.id) } }
					);
				} else {
					await User.update({ password: hash });
				}
			} catch (dbErr) {
				RaiseLogEvent(ROUTE, identifier, dbErr, 'DB update failed');
				return res.status(500).send({ success: false, error: 'Failed to update password. Please try again.' });
			}

			// Clean up all Redis keys only after confirmed DB write
			await redisHelper.delManyAsync(otpAttemptKey, redisOtpKey, otpResendKey, redisOtpTokenKey);

			RaiseLogEvent(ROUTE, identifier, {}, 'Step 3 — password reset successful');
			return res.send({ success: true });

		} else {
			return res.status(400).send({ success: false, error: 'Invalid step. Expected step 1, 2, or 3.' });
		}

	} catch (err) {
		console.error(`${ROUTE} error:`, err);
		RaiseLogEvent(ROUTE, 'error', err, `Data: ${JSON.stringify(req.body)}`);
		return res.status(500).send({ success: false, error: 'Error processing your request.' });
	}
}

exports.otpTokenVerify = async (req, res) => {
	const ROUTE = 'avolve/otp/token/verify';
	try {
		const token = req.get('X-AVL-OtpToken');
		RaiseLogEvent(ROUTE, 'log', { token }, 'Data received');
		if (!token) {
			RaiseLogEvent(ROUTE, 'error', {}, 'Missing OTP auth token in header');
			return res.status(401).send({ success: false, error: 'Missing OTP auth token' });
		}
		const secret = config.session.secret;
		if (!secret) {
			RaiseLogEvent(ROUTE, 'error', { token }, 'JWT secret not configured');
			return res.status(500).send({ success: false, error: 'Server configuration error' });
		}

		//#region header token verification
		let decoded;
		try {
			decoded = jwt.verify(token, secret);
		} catch (error) {
			RaiseLogEvent(ROUTE, 'error', { token, error }, 'JWT verification failed');
			return res.status(401).send({ success: false, error: 'Invalid or expired token' });
		}

		if (!decoded || !decoded.mobile) {
			RaiseLogEvent(ROUTE, 'error', { token, decoded }, 'Invalid token payload');
			return res.status(401).send({ success: false, error: 'Invalid token payload' });
		}

		//#region redis token verification
		const redisKey = `avl:otpToken:${decoded.mobile}`;
		let storedToken;
		try {
			storedToken = await redisHelper.GETAsync(redisKey);
		} catch (error) {
			RaiseLogEvent(ROUTE, 'error', { token, error }, 'Redis error');
			return res.status(500).send({ success: false, error: 'Session validation failed' });
		}
		if (!storedToken) {
			RaiseLogEvent(ROUTE, 'error', { mobile: decoded.mobile }, 'Token not found in Redis');
			return res.status(401).send({ success: false, error: 'Session expired or invalid' });
		}
		if (storedToken !== token) {
			RaiseLogEvent(ROUTE, 'error', { mobile: decoded.mobile, token, storedToken }, 'Token mismatch');
			return res.status(401).send({ success: false, error: 'Invalid session' });
		}
		//#endregion

		RaiseLogEvent(ROUTE, 'log', { mobile: decoded.mobile, token, storedToken }, 'Token verified');
		return res.status(200).send({ success: true, message: 'Token verified successfully' });
	} catch (error) {
		console.log(`API ${ROUTE} Error:`, error);
		RaiseLogEvent(ROUTE, 'error', error, 'Unexpected error in OTP token verification');
		return res.status(500).send({ success: false, error: 'Unexpected error in OTP token verification' });
	}
}

exports.updateProfile = async function (req, res) {
	const ROUTE = 'app/users/updateProfile';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.files, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		if (!req.params.id) {
			return res.send({ success: false, error: 'UserId Missing' });
		}

		let User = await models.User.findOne({
			attributes: ['id', 'images'],
			where: {
				id: req.params.id,
				AccountId: res.locals.AccountId
			}
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found' });
		}

		let images = JSON.parse(JSON.stringify(User.images));
		let profile = '';
		let imagesPush = [];
		if (req.files && req.files.profile && req.files.profile.length) {
			profile = req.files.profile.map(file => {
				imagesPush.push(file);
				return '/' + md5(res.locals.AccountId) + '/Apollo/User/' + User.id + '_' + file.filename;
			}).toString();
		}
		images.profile = profile;

		let updUser = await User.update({
			images: images
		});

		for (const image of imagesPush) {
			if (image && image.path) {
				events.emit('file-upload-handler-s3', {
					file: image.path,
					s3Path: md5(res.locals.AccountId) + '/Apollo/User/' + User.id + '_' + image.filename
				});
			}
		}

		return res.send({ success: true, images: updUser.images });

	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error assigning users.');
		return res.send({ success: false, error: 'Error assigning users.' });
	}
}

exports.getTeams = async function (req, res) {
	const ROUTE = 'app/users/getTeams';
	try {
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		let results = [], excelResults = [], accountIds = [], UserIds = [], fteAlerts = [];
		if (['KAM', 'FTS KAM'].includes(res.locals.role)) { // KAM, FTS KAM
			let fteResult = await avolveHelper.getFteUsersByCustomers(res.locals.accountIds, false, res.locals.masterAccountId);
			let fteUsers = fteResult.success && fteResult.results || [];
			let fteUserCount = fteUsers.length;
			fteUsers = req.query.role && fteUsers.filter(x => x.role == req.query.role) || fteUsers;
			let result = await avolveHelper.getCustomersByUser(res.locals.UserId, false, res.locals.masterAccountId);
			let fteSummary = await fetchFtePerformance(fteUsers.map(x => x.id), req.query.excel);
			if (fteSummary.success == true && fteSummary.details) {
				fteAlerts = fteSummary.details;
			}
			results.push({
				id: res.locals.UserId,
				name: res.locals.firstName + (res.locals.lastName && ' ' + res.locals.lastName || "") || res.locals.username || "",
				userCode: res.locals.userCode || "",
				customerCount: result.results.length,
				usersCount: fteUserCount,
				alertTriggered: fteSummary.success == true && fteSummary.summary.alertsTriggered || 0,
				alertExecuted: fteSummary.success == true && fteSummary.summary.alertsExecuted || 0,
				users: fteUsers.map(x => {
					return {
						id: x.id,
						name: x.name,
						userCode: x.userCode,
						workshops: x.workshops,
						customers: x.customers,
						role: x.role,
						highlight: x.role == 'AMCS FTE' && true || false
					}
				})
			});
			excelResults = results;
		} else { //Ho-Sales or ZM
			if (req.query.UserId) {
				let result = await avolveHelper.getCustomersByUser(req.query.UserId, false, res.locals.masterAccountId);
				accountIds = result.results.map(x => x.id);
				UserIds = req.query.UserId;
			} else {
				let zmId = ["HO Sales", "FTS HO"].includes(res.locals.role) && res.locals.zmIds || res.locals.UserId;
				let kamResult = await avolveHelper.getKamListByUser(zmId);
				if (kamResult.success && kamResult.results.length) {
					UserIds = kamResult.results.map(x => x.id);
					let custResult = await avolveHelper.getCustomersByUser(UserIds, false, res.locals.masterAccountId);
					accountIds = custResult.results.map(x => x.id);
				}
			}

			let Users = await models.User.findAll({
				attributes: ['id', 'username', 'firstName', 'lastName', 'userCode', 'accountIds', 'createdAt'],
				include: [{
					attributes: ['id', 'name'],
					model: models.UserRole,
					where: {
						name: ['KAM', 'FTS KAM']
					},
					required: true
				}],
				where: {
					id: UserIds,
					activeStatus: true,
					AccountId: res.locals.masterAccountId
				}
			});


			for (let User of Users) {
				let kamAccids = User.accountIds.map(x => parseInt(x.id));
				kamAccids = kamAccids.filter(x => accountIds.includes(x));
				//#region get FTE for KAM's
				let result = await avolveHelper.getFteUsersByCustomers(kamAccids, false, res.locals.masterAccountId);
				let fteUsers = result.success && result.results || [];
				let fteUsersCount = fteUsers.length;
				fteUsers = req.query.role && fteUsers.filter(x => x.role == req.query.role) || fteUsers;
				//#endregion

				let fteSummary = await fetchFtePerformance(fteUsers.map(x => x.id), req.query.excel);
				if (fteSummary.success == true && fteSummary.details) {
					for (const detail of fteSummary.details) {
						fteAlerts.push(detail);
					}
				}
				results.push({
					id: User.id,
					name: User.firstName + (User.lastName && ' ' + User.lastName || "") || User.username || "",
					userCode: User.userCode,
					customerCount: kamAccids.length,
					usersCount: fteUsersCount,
					alertTriggered: fteSummary.success == true && fteSummary.summary.alertsTriggered || 0,
					alertExecuted: fteSummary.success == true && fteSummary.summary.alertsExecuted || 0,
					users: fteUsers.map(x => {
						return {
							id: x.id,
							name: x.name,
							userCode: x.userCode,
							workshops: x.workshops,
							customers: x.customers,
							role: x.role,
							highlight: x.role == 'AMCS FTE' && true || false
						}
					})
				});
			}
			excelResults = results;
		}

		let destFileUrl = '';
		if (req.query.excel == 'true') {
			try {

				let columns = [
					{ header: 'FTE', key: 'fteUser', width: 15 },
					{ header: 'FTE Type', key: 'ftetype', width: 15 },
					{ header: 'Customers Assigned', key: 'customerCount', width: 30 },
					{ header: 'Name of customer/CV zone', key: 'customerAndCvZones', width: 15 },
					{ header: 'Month', key: 'month', width: 10 },
					{ header: 'Alert Triggred', key: 'alertTriggered', width: 10 },
					{ header: 'Alert Executed', key: 'alertExecuted', width: 10 },
					{ header: 'KAM', key: 'kam', width: 10 }
				];

				let results = [];
				for (const result of excelResults) {
					if (result.users && result.users.length) {
						for (let fteUser of result.users) {
							let months = [moment(), moment().subtract(1, 'month')];
							for (let date of months) {
								if (fteUser.name) {
									let matchFteAlert = fteAlerts.find(x => x.UserId == fteUser.id && x.month == date.format('MM'));
									results.push({
										fteUser: fteUser.name,
										ftetype: fteUser.role,
										kam: result.name,
										customerCount: fteUser.customers && fteUser.customers.length || 0,
										customerAndCvZones: [...fteUser.customers, ...fteUser.workshops].map(x => x.name).join(","),
										month: date.format('MMMM'),
										alertTriggered: matchFteAlert && matchFteAlert.alertsTriggered || 0,
										alertExecuted: matchFteAlert && matchFteAlert.alertsExecuted || 0
									});
								}
							}
						}
					}
				}

				let fileName = `APL_Teams_${res.locals.UserId}_${res.locals.AccountId}`;

				return await avolveHelper.avolveExcelExportTeams(fileName, columns, results, res);

			} catch (err) {
				console.log(`Error in ${ROUTE}: ${err}`);
				RaiseLogEvent(ROUTE, 'error', err, `Error creating excel`);
			}
		}
		return res.send({ success: true, results: results, destFileUrl: destFileUrl, error: null });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching users.');
		return res.send({ success: false, error: 'Error fetching users.' });
	}
}

exports.getUserSummay = async function (req, res) {
	const ROUTE = 'app/users/getUserSummay';
	try {
		if (['HO Sales', 'FTS HO', 'ZM', 'FTS ZM', 'KAM', 'FTS KAM'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}
		if (!req.params.id) {
			return res.send({ success: false, error: 'FTE Id missing' });
		}
		if (!req.query.KamId) {
			return res.send({ success: false, error: 'KAM Id missing' });
		}

		let date = req.query.date && moment(req.query.date, 'YYYY-MM-DD') || moment();

		let User = await models.User.findOne({
			attributes: ['id', 'username', 'firstName', 'lastName', 'accountIds', 'AccountId', 'userCode'],
			include: [{
				attributes: ['id', 'tname', 'name'],
				model: models.Account,
				required: true
			}, {
				attributes: ['id', 'geozones'],
				model: models.AplUser,
				required: false
			},
			{
				attributes: ['id', 'name'],
				model: models.UserRole,
				where: {
					name: ['AMCS FTE', 'AMCC FTE', 'DE FTE', 'XE FTE', 'ARSA']
				},
				required: true
			}],
			where: {
				id: req.params.id,
				activeStatus: true
			}
		});

		if (!User) {
			return res.send({ success: false, error: 'FTE not found' });
		}

		let KamUser = await models.User.findOne({
			attributes: ['id', 'username', 'firstName', 'lastName', 'accountIds', 'userCode'],
			include: [{
				attributes: ['id', 'name'],
				model: models.UserRole,
				where: {
					name: ['KAM', 'FTS KAM']
				},
				required: true
			}],
			where: {
				AccountId: res.locals.masterAccountId,
				id: req.query.KamId,
				activeStatus: true
			}
		});

		if (!KamUser) {
			return res.send({ success: false, error: 'KAM not found' });
		}

		let accountIds = [];
		if (['XE FTE', 'ARSA', 'AMCC FTE'].includes(User.UserRole.name)) {
			accountIds = User.accountIds.map(x => parseInt(x.id));
		} else if (User.UserRole.name == 'DE FTE') {
			accountIds = [User.AccountId];
		} else {
			if (User.AplUser && User.AplUser.geozones) {
				let Geozones = await models.Geozone.findAll({
					attributes: ['id', 'accountIds'],
					where: {
						AccountId: res.locals.masterAccountId,
						activeStatus: true,
						id: User.AplUser.geozones.map(x => parseInt(x.id))
					}
				});
				for (let Geozone of Geozones) {
					Geozone.accountIds.map(x => parseInt(accountIds.push(x.id)));
				}
			}
		}

		let custResult = await avolveHelper.getAvolveCustomers(accountIds, res.locals.masterAccountId);
		if (!custResult.success) {
			return res.send({ success: false, error: 'Error fetching customers.' });
		}
		accountIds = custResult.activeAccIds;

		let AplOffers = await models.AplOffer.findAll({
			attributes: ['id', 'details'],
			where: {
				startDate: { [Op.lte]: moment().format('YYYY-MM-DD') },
				endDate: { [Op.gte]: moment().format('YYYY-MM-DD') },
				AccountId: accountIds,
				status: 'Active'
			}
		});

		let totalOfferVehicles = 0, totalOfferTyres = 0;
		for (let AplOffer of AplOffers) {
			if (AplOffer && AplOffer.details && AplOffer.details.vehicles) {
				totalOfferVehicles = AplOffer.details.vehicles;
			}
			if (AplOffer && AplOffer.details && AplOffer.details.operations && AplOffer.details.operations.vehicleGroups) {
				for (let vehicleGroup of AplOffer.details.operations.vehicleGroups) {
					totalOfferTyres += Number(vehicleGroup.vehicles) * (vehicleGroup.wheeler && Number(vehicleGroup.wheeler.split('W')[0]) || 0);
				}
			}
		}

		let AplReport = await models.AplReport.findOne({
			attributes: ['id', 'details'],
			where: {
				UserId: User.id,
				month: moment(date).format("M"),
				year: moment(date).format("YYYY")
			}
		});

		let serviceSummary = AplReport && AplReport.details && AplReport.details.ss || {};
		let alerts = serviceSummary && serviceSummary.alerts || {};
		let priAlerts = serviceSummary && serviceSummary.priAlerts || {};
		let secAlertsAssgnd = serviceSummary && serviceSummary.secAlertsAssgnd || {};
		let secServiceExecd = serviceSummary && serviceSummary.secServiceExecd || {};

		let result = {
			fteId: User.id,
			fteName: User.firstName + (User.lastName && ' ' + User.lastName || "") || User.username || "",
			fteCode: User.userCode || "",
			fteRole: User.UserRole.name,
			workShopCount: User.AplUser && User.AplUser.geozones && User.AplUser.geozones.length || 0,
			customerCount: accountIds.length,
			VehicleCount: totalOfferVehicles,
			TyreCount: totalOfferTyres,
			workshops: User.AplUser && User.AplUser.geozones || [],
			Account: User.Account,
			customers: custResult.customers,
			kamId: KamUser.id,
			kamName: KamUser.firstName + (KamUser.lastName && ' ' + KamUser.lastName || "") || KamUser.username || "",
			kamCode: KamUser.userCode || "",
			serviceSummary: {
				alerts: {
					overall: {
						triggered: alerts && alerts.triggered || 0,
						executed: alerts && alerts.executed || 0,
						percentage: alerts && alerts.percentage || 0
					},
					primaryExec: {
						triggered: priAlerts && priAlerts.triggered || 0,
						executed: priAlerts && priAlerts.executed || 0,
						percentage: priAlerts && priAlerts.percentage || 0
					},
					secondaryAsgd: {
						triggered: secAlertsAssgnd && secAlertsAssgnd.triggered || 0,
						executed: secAlertsAssgnd && secAlertsAssgnd.executed || 0,
						percentage: secAlertsAssgnd && secAlertsAssgnd.percentage || 0
					},
					secondaryExec: {
						triggered: secServiceExecd && secServiceExecd.triggered || 0,
						executed: secServiceExecd && secServiceExecd.executed || 0,
						percentage: secServiceExecd && secServiceExecd.percentage || 0
					}
				},
				services: [],
				priServices: [],
				secServices: []
			}
		}

		if (['DE FTE', 'XE FTE', 'ARSA', 'AMCC FTE'].includes(User.UserRole.name)) {
			result.workShopCount = await models.Geozone.count({
				where: {
					AccountId: accountIds
				}
			});
		}

		if (User.UserRole.name == "AMCS FTE") {
			result.serviceSummary.priServices = priAlerts && priAlerts.details || [];
			result.serviceSummary.priServices.map(x => {
				x.name = x.sName;
				return;
			});
			result.serviceSummary.secServices = secServiceExecd && secServiceExecd.details || [];
			result.serviceSummary.secServices.map(x => {
				x.name = x.sName;
				return;
			});
		} else {
			result.serviceSummary.services = priAlerts && priAlerts.details || [];
			result.serviceSummary.services.map(x => {
				x.name = x.sName;
				return;
			});
		}

		return res.send({ success: true, result: result });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching users.');
		return res.send({ success: false, error: 'Error fetching users.' });
	}
}

exports.getUserByRole = async function (req, res) {
	const ROUTE = 'app/users/getUserByRole';
	try {
		if (['Admin'].indexOf(res.locals.role) == -1) {
			return res.send({ success: false, error: 'Not Authorized' });
		}
		if (!req.query.AccountId) {
			return res.send({ success: false, error: 'Customer Id missing' });
		}
		if (!req.query.role) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let Users = await models.User.findAll({
			attributes: ['id', 'firstName', 'lastName'],
			include: [{
				attributes: [],
				model: models.UserRole,
				where: {
					name: req.query.role
				}
			}],
			where: {
				AccountId: req.query.AccountId,
				activeStatus: true
			},
			raw: true
		});

		return res.send({ success: true, results: Users });
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching users.');
		return res.send({ success: false, error: 'Error fetching users.' });
	}
}

function initDataForAvolveLogin(Account, User) {
	let data = buildReplyUserLogin(User);
	if (User.role == '1') {
		data.utype = 'admin';
	} else if (User.role == '2') {
		data.utype = 'manager';
	} else if (User.role == '3') {
		data.utype = 'viewer';
	}

	data.ZoneGroups = [];
	data.Zones = [];
	data.AccountType = Account.type;
	data.tName = Account.tname;
	data.userType = User.UserRole && User.UserRole.name || "";
	data.offer = Account.details && getOfferName(Account.details.plan) || "";
	data.plan = Account.details && Account.details.plan || "";
	data.success = true;
	data.cdnUrl = AppConfig.cdn.url;

	delete User.dataValues.Groups;
	delete User.dataValues.Account;
	const initData = { user: User, data: data };
	return initData;
}

async function trigExecCount(AplAlerts, AdhocServices, serviceName) {
	let triggered = AplAlerts.filter(x => x.details && x.details.serviceName && x.details.serviceName == serviceName).length;
	let executed = AplAlerts.filter(x => x.status == 2 && x.details && x.details.serviceName && x.details.serviceName == serviceName).length;
	let adhocExec = AdhocServices.filter(x => x.note == serviceName).length;
	let totalExec = executed + adhocExec;
	let percentage = (!triggered && !totalExec && 0) || (totalExec && !triggered && 100) || (triggered && parseInt((totalExec / triggered) * 100) || 0);
	return {
		name: serviceName,
		triggered: triggered,
		executed: totalExec,
		percentage: percentage
	}
}

function getOfferName(plan) {
	let planName = '';
	switch (plan) {
		case 1:
			planName = 'AMC Shared';
			break;
		case 2:
			planName = 'AMC Captive';
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

async function fetchFtePerformance(UserIds, excel) {
	const ROUTE = 'app/users/fetchFtePerformance';
	try {

		let whereClause = {
			month: moment().format('MM'),
			year: moment().format('YYYY'),
			UserId: UserIds
		}

		if (excel == "true") {
			whereClause.month = [moment().subtract(1, 'month').format('MM'), moment().format('MM')];
			let year = moment().format('YYYY');
			if (moment().subtract(1, 'month').format('MM') == "12") {
				year = [moment().subtract(1, 'year').format('YYYY'), moment().format('YYYY')];
			}
			whereClause.year = year;
		}

		let AplReports = await models.AplReport.findAll({
			attributes: ['id', 'details', 'UserId', 'month', 'year'],
			where: whereClause
		});

		let results = []; let allAlertsTriggered = 0; let allAlertsExecuted = 0;
		if (excel == "true") {
			for (const UserId of UserIds) {
				let months = [moment().subtract(1, 'month').format('MM'), moment().format('MM')];
				for (const month of months) {
					let alertsTriggered = 0; let alertsExecuted = 0;
					let matchAlerts = AplReports.filter(x => x.UserId == UserId && x.month == month);
					for (const AplReport of matchAlerts) {
						if (AplReport && AplReport.details && AplReport.details.ss && AplReport.details.ss.alerts) {
							alertsTriggered += AplReport.details.ss.alerts && Number(AplReport.details.ss.alerts.triggered) || 0;
							alertsExecuted += AplReport.details.ss.alerts && Number(AplReport.details.ss.alerts.executed) || 0;
						}
					}
					allAlertsTriggered += Number(alertsTriggered);
					allAlertsExecuted += Number(alertsExecuted);
					let result = {
						UserId: UserId,
						month: month,
						alertsTriggered: alertsTriggered,
						alertsExecuted: alertsExecuted
					}
					results.push(result);
				}
			}
		} else {
			for (const AplReport of AplReports) {
				if (AplReport && AplReport.details && AplReport.details.ss && AplReport.details.ss.alerts) {
					allAlertsTriggered += AplReport.details.ss.alerts && Number(AplReport.details.ss.alerts.triggered) || 0;
					allAlertsExecuted += AplReport.details.ss.alerts && Number(AplReport.details.ss.alerts.executed) || 0;
				}
			}
		}

		return {
			success: true,
			details: results,
			summary: {
				alertsTriggered: allAlertsTriggered,
				alertsExecuted: allAlertsExecuted
			}
		}
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching AplReports.');
		return { success: false, error: 'Error fetching AplReports.' };
	}
}

async function fetchAplAlerts(accountIds, excelExport) {
	const ROUTE = 'app/users/fetchAplAlerts';
	try {

		let whereClause = {
			type: 1,
			status: [1, 2],
			AccountId: accountIds,
			alertDate: {
				[Op.between]: [
					moment().startOf('month').format('YYYY-MM-DD'),
					moment().endOf('month').format('YYYY-MM-DD')
				]
			},
			'details.serviceName': {
				[Op.ne]: 'Onboarding Service'
			}
		}

		if (excelExport && excelExport == 'true') {
			whereClause.alertDate = {
				[Op.between]: [
					moment().subtract(1, 'month').startOf('month').format('YYYY-MM-DD'),
					moment().endOf('month').format('YYYY-MM-DD')
				]
			}
		}

		let AplAlerts = await models.AplAlert.findAll({
			attributes: ['id', 'alertDate', 'status', 'AccountId'],
			include: [{
				attributes: ['id'],
				model: models.Account,
				where: {
					status: 1
				},
				required: true
			}],
			where: whereClause
		});
		return AplAlerts;
	} catch (err) {
		console.log(`Error in ${ROUTE}: ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error fetching aplAlerts.');
		return { success: false, error: 'Error fetching aplAlerts.' };
	}
}

exports.emailUnsubscribe = async (req, res) => {
	const ROUTE = 'app/users/emailUnsubscribe';
	try {
		RaiseLogEvent(ROUTE, req.query.email, req.query, 'Data Received');
		if (!req.query.email) {
			return res.status(400).send('Email is required for emailUnsubscribe.');
		}

		const emails = req.query.email.split(',').map(e => e.trim()).filter(Boolean);
		const Users = await models.User.findAll({
			attributes: ['id', 'firstName', 'lastName', 'details'],
			include: [{
				model: models.UserRole,
				attributes: ['name']
			}, {
				model: models.Account,
				attributes: ['tname', 'name'],
				where: { AccountIdParent: res.locals.masterAccountId }
			}],
			where: {
				email: emails,
				activeStatus: true
			},
			raw: true
		});

		if (!Users.length) {
			return res.status(400).send('No users found with requested email(s).');
		}

		for (const User of Users) {
			let details = User.details || {};
			details.isEmailUnSubscribed = true;
			await models.User.update({ details }, { where: { id: User.id } });

			const userData = {
				role: User['UserRole.name'] || '',
				name: [User.firstName, User.lastName].filter(Boolean).join(' '),
				email: req.query.email,
				tname: User['Account.tname'] || '',
				mdgId: User['Account.name'] || '',
				date: moment().format('DD/MM/YYYY hh:mm A'),
				subject: req.query.subject || ''
			};

			const { subject, htmlTemplate } = getEmailTemplate('unsubscribe', userData);
			events.emit('sendMail', {
				recipients: { to: itEmail, bcc: MailBotBcc },
				title: subject,
				html: htmlTemplate
			});
		}

		return res.status(200).send(`Email(s) ${emails.join(', ')} have been unsubscribed successfully.`);
	} catch (error) {
		console.log(`Error in ${ROUTE}: ${error}`);
		RaiseLogEvent(ROUTE, req.query.email, error, 'Error');
		return res.status(500).send('Internal Server Error');
	}
}

exports.getFteByKam = async (req, res) => {
	const ROUTE = 'app/users/getFteByKam';
	try {
		if (!['KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		const User = await models.User.findOne({
			attributes: ['id', 'accountIds', 'userCode'],
			where: {
				id: res.locals.UserId
			},
			raw: true
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found.' });
		}

		let results = [];
		if (User.accountIds && User.accountIds.length) {
			let fteResult = await avolveHelper.getFteUsersByCustomers(User.accountIds.map(x => x.id), true, res.locals.masterAccountId);
			if (fteResult && fteResult.success) {
				results = fteResult.results.filter(fte => fte.role === 'XE FTE').map(fte => ({ id: fte.id, text: fte.name, userCode: fte.userCode || null }));
			}
		}

		const accountIds = (
			await models.Account.findAll({
				attributes: ['id'],
				where: { status: 1, 'details.avolve': true, AccountIdParent: res.locals.masterAccountId },
				raw: true
			})
		).map(a => a.id);

		let FteUsers = await models.User.findAll({
			attributes: ['id', 'firstName', 'lastName', 'userCode', 'accountIds'],
			include: [{
				model: models.UserRole,
				attributes: [],
				required: true,
				where: { name: 'XE FTE' }
			}],
			where: {
				activeStatus: true
			},
			raw: true
		});

		for (const fte of FteUsers) {
			if (results.some(r => r.id === fte.id)) continue;

			const accounts = fte.accountIds || [];
			const hasActiveCust = accounts.some(a => accountIds.includes(Number(a.id)));

			if (!accounts.length || !hasActiveCust) {
				results.push({
					id: fte.id,
					text: [fte.firstName, fte.lastName].filter(Boolean).join(' '),
					userCode: fte.userCode || null
				});
			}
		}

		return res.send({ success: true, results: results });
	} catch (error) {
		console.log(`Error in ${ROUTE}: ${error}`);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching user');
		return res.send({ success: false, error: 'Error fetching user' });
	}
}

exports.getAccountSummary = async (req, res) => {
	const ROUTE = 'app/users/getAccountSummary';
	try {
		if (!['KAM'].includes(res.locals.role)) {
			return res.send({ success: false, error: 'Not Authorized.' });
		}

		if (!req.params.id) {
			return res.send({ success: false, error: 'Input parameter missing.' });
		}

		const User = await models.User.findOne({
			attributes: ['id', 'accountIds'],
			where: { id: req.params.id },
			raw: true
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found.' });
		}

		let Accounts = await models.Account.findAll({
			attributes: ['id'],
			where: {
				id: User.accountIds.map(x => x.id),
				status: 1
			},
			raw: true
		});

		let AplOffers = await models.AplOffer.findAll({
			attributes: [
				[models.sequelize.literal('DISTINCT ON ("AccountId") "AccountId"'), 'AccountId'], 'id', 'details'
			],
			where: {
				AccountId: Accounts.map(x => x.id)
			},
			order: [['AccountId', 'ASC'], ['id', 'DESC']],
			raw: true
		});

		let result = {
			vehicle: 0,
			tyre: 0
		};
		for (const AplOffer of AplOffers) {
			let vehicleGroups = AplOffer.details && ((AplOffer.details.operations && AplOffer.details.operations.vehicleGroups) || AplOffer.details.vehicleGroups) || [];
			for (const vehicleGroup of vehicleGroups) {
				let wheeler = vehicleGroup.wheeler && parseInt(vehicleGroup.wheeler) || 0;
				result.vehicle += vehicleGroup.vehicles && Number(vehicleGroup.vehicles) || 0;
				result.tyre += Number(result.vehicle * wheeler);
			}
		}

		return res.send({ success: true, totalAllocatedCount: result });
	} catch (error) {
		console.log(`Error in ${ROUTE}: ${error}`);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching account summary');
		return res.send({ success: false, error: 'Error fetching account summary' });
	}
}

exports.googlelogin = function (req, res) {
	const ROUTE = 'users/googlelogin';
	RaiseLogEvent(ROUTE, 'log', `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
	if (!(req.body && req.body.idToken)) {
		res.status(401);
		return res.send({ success: false, error: 'Token not found' });
	}

	let platform = req.body && req.body.platform || "web_android";

	const CLIENT_ID = googleAuthConfig[platform].client_id;
	const authClient = new google.auth.OAuth2(CLIENT_ID);

	new Promise(function (resolve, reject) {
		authClient.verifyIdToken({
			idToken: req.body.idToken,
			audience: CLIENT_ID
		},
			function (e, loginTicket) {
				if (loginTicket) {
					const payload = loginTicket.getPayload();
					resolve(payload);
				} else {
					reject("invalid token");
				}
			}
		)
	}).then(function (payload) {
		const userEmail = payload.email;
		if (!userEmail) {
			res.status(401);
			return res.send({ success: false, error: 'Gmail id not extracted/found!' });
		}
		var useragent = req.headers['user-agent'] === undefined ? '' : req.headers['user-agent'];
		models.User.findOne({
			include: [
				{
					attributes: ['id'],
					model: models.Group
				},
				{
					attributes: ['id'],
					model: models.Geozone
				},
				{
					attributes: ['id', 'name'],
					model: models.ZoneGroup,
					include: [{
						attributes: ['id'],
						model: models.Geozone
					}]
				},
				{
					attributes: ['id', 'name'],
					model: models.UserRole
				}
			],
			where: { username: { ilike: userEmail }, activeStatus: true }
		}).then(function (user) {
			if (!user) {
				RaiseLogEvent('ROUTE', 'not found', { payload, useragent, body: req.body }, `User not found`)
				return res.status(401).send({ success: false, error: 'user not found' });
			}
			models.Account.findOne({ where: { id: user.AccountId } }).then(function (account) {
				if (!account) {
					res.status(401);
					res.send({ success: false, error: 'account not found' });
				} else {
					if (account.status != 1) {
						return res.status(401).send({ success: false, error: 'Login failed. Your account is inactive' });
					}

					var data = buildReplyUserLogin(JSON.parse(JSON.stringify(user)));

					if (user.role == '1') {
						data.utype = 'admin';
					} else if (user.role == '2') {
						data.utype = 'manager';
					} else if (user.role == '3') {
						data.utype = 'viewer';
					}

					var Groups = [];
					let group = null;
					if (user.Groups.map(x => x.id).length > 0) {
						// for asset tracker and other api use this format
						group = 'ug' + user.id;
						// for notification
						if (user.Groups.length > 0) {
							for (var i = 0; i < user.Groups.length; i++) {
								Groups.push(user.Groups[i].id);
							}
						}
					}

					data.group = group;
					user.group = group;
					data.VehicleGroups = Groups;

					var ZoneGroups = [];
					var Zones = [];
					if (user.ZoneGroups.length > 0) {
						for (var i = 0; i < user.ZoneGroups.length; i++) {
							ZoneGroups.push(user.ZoneGroups[i].id);
							if (user.ZoneGroups[i].Geozones.length > 0) {
								for (var j = 0; j < user.ZoneGroups[i].Geozones.length; j++) {
									Zones.push(parseInt(user.ZoneGroups[i].Geozones[j].id));
								}
							}
						}
					}
					for (var i = 0; i < user.Geozones.length; i++) {
						Zones.push(parseInt(user.Geozones[i].id));

					}
					Zones = [...new Set(Zones)];
					data.ZoneGroups = ZoneGroups;
					data.Zones = Zones;
					data.MarkerWithLabel = 0;
					data.MarkerClusterer = 0;
					data.MapShowZone = 1;
					data.AccountType = account.type;
					data.userType = user.UserRole ? user.UserRole.name : "";
					data.success = true;
					data.cdnUrl = AppConfig.cdn.url;
					// console.log(data);
					models.redis.get('accountsec:' + account.id, function (err, secret) {
						//console.log('secret'+secret);
						if (secret == null) {
							secret = config.session.secret;
						}
						if (account.config && account.config.sessionTimeoutHrs && !isNaN(account.config.sessionTimeoutHrs)) {
							data.sessionToken = jwt.sign(buildReplyUserLogin(JSON.parse(JSON.stringify(user))), secret, { expiresIn: 60 * 60 * account.config.sessionTimeoutHrs });
						} else {
							data.sessionToken = jwt.sign(buildReplyUserLogin(JSON.parse(JSON.stringify(user))), secret);
						}
						console.log('signin complete for user: ' + data.username);
						res.send(data);
					});
				}
			});
		});
	}).catch(function (error) {
		console.log(`Error in ${ROUTE}: ${error}`);
		RaiseLogEvent(ROUTE, 'error', error, 'Error');
		return res.status(401).send({ success: false, error: 'Invalid token!' });
	})
}

exports.listByAccountId = async function (req, res) {
	const ROUTE = 'app/users/listByAccountId';
	try {
		let whereClause = {
			AccountId: res.locals.AccountId
		};
		if (req.query && req.query.userRoleIds && JSON.parse(req.query.userRoleIds).length) {
			whereClause.UserRoleId = JSON.parse(req.query.userRoleIds);
		}

		const userRoleInclude = {
			attributes: ['id', 'name'],
			model: models.UserRole
		}

		if (res.locals.role == 'FTS Admin') {
			userRoleInclude.required = true;
			userRoleInclude.where = {
				name: {
					[Op.or]: [
						{ [Op.iLike]: '%FTS%' },
						{ [Op.eq]: 'ARSA' }
					]
				}
			}
		}

		let users = await models.User.findAll({
			attributes: ['id', 'username', 'userCode', 'AccountId', 'role', 'group', 'push', 'tripPush', 'accountsPush', 'email', 'mobile',
				'branchIds', 'activeStatus', 'driverGroupIds', 'driverZoneIds', 'primaryHierarchyIds', 'secondaryHierarchyIds',
				'smsNotification', 'emailNotification', 'notificationTypes', 'user', 'createdAt', 'updatedAt', 'accountIds'],
			include: [
				userRoleInclude,
				{
					attributes: ['id', 'name'],
					model: models.Group
				},
				{
					attributes: ['id', 'name'],
					model: models.ZoneGroup
				},
				{
					attributes: ['id', 'geozones'],
					model: models.AplUser
				}
			],
			where: whereClause,
			order: [['id', 'ASC']]
		});
		return res.send({ success: true, results: users });
	} catch (error) {
		console.log(`Error in ${ROUTE}: ${error}`);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching userlist.');
		return res.send({ success: false, error: 'Error fetching userlist.' });
	}
}

exports.userConfig = async function (req, res) {
	const ROUTE = 'app/users/userConfig';
	try {
		RaiseLogEvent(ROUTE, res.locals.UserId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		const Users = await models.User.findOne({
			attributes: ['id', 'menu'],
			include: [
				{
					attributes: ['id', 'name', 'config', 'tripConfig', 'driverConfig', 'serviceConfig'],
					model: models.Account
				},
				{
					attributes: ['id', 'name'],
					model: models.UserRole
				}
			],
			where: {
				AccountId: res.locals.AccountId,
				id: res.locals.UserId
			},
			raw: true,
			nest: true
		})

		if (!Users) {
			return res.send({ success: false, error: 'User not found.' });
		}
		let user = JSON.parse(JSON.stringify(Users));
		let result = {};
		result.userId = user.id;
		result.config = user.Account.config;
		result.AccountId = user.Account.id;
		result.tripConfig = user.Account.tripConfig;
		result.driverConfig = user.Account.driverConfig;
		result.serviceConfig = user.Account.serviceConfig;
		result.components = user.menu ? (user.menu.components ? user.menu.components : []) : [];
		res.send({ success: true, userConfig: result, config: result });
	} catch (error) {
		console.log(`Error in ${ROUTE}: ${error}`);
		RaiseLogEvent(ROUTE, 'error', error, 'Error fetching data.');
		return res.send({ success: false, error: 'Error fetching data.' });
	}
}