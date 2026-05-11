const moment = require('moment');
const models = require('../../../models');
const { Op } = require('sequelize');
const { events } = require('../../../lib/event');
const { RaiseLogEvent } = require('../../../lib/helpers/rmqlog');
const { parseQueryParamList, handleApiError } = require('../../middlewares/helper');
const avolveHelper = require('../../../lib/helpers/avolveHelper');
const redisHelper = require("../../../lib/helpers/redis");

const ValueFirst = require('../../../lib/helpers/valueFirst');
const valueFirst = new ValueFirst();

exports.listUserByRole = async function (req, res) {
	const ROUTE = 'app/users/listUserByRole';
	try {
		if (res.locals.AccountId != res.locals.masterAccountId) {
			return res.send({ success: false, error: 'Not Authorized' });
		}

		if (!req.query.roles) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		const AccountId = req.query.AccountId || res.locals.masterAccountId || null;
		const userRoles = parseQueryParamList(req.query.roles);
		if (!userRoles?.length || !AccountId) {
			return res.send({ success: false, error: 'Input parameter missing' });
		}

		let Users = await models.User.findAll({
			attributes: ['id', 'firstName', 'lastName', 'username'],
			include: [{
				attributes: ['name'],
				model: models.UserRole,
				where: {
					name: { [Op.in]: userRoles }
				}
			}],
			where: {
				AccountId: AccountId,
				activeStatus: true
			},
			raw: true,
			nest: true
		});

		return res.send({ success: true, results: Users });
	} catch (err) {
		console.log(`avolve/users/listUserByRole`, err);
		RaiseLogEvent(ROUTE, 'error', err, `Data ${JSON.stringify(req.params)}`);
		return res.send({ success: false, error: 'Error fetching users.' });
	}
}

exports.listByAccountId = async function (req, res) {
	const ROUTE = 'web/users/listByAccountId';
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

		let Users = await models.User.findAll({
			attributes: ['id', 'username', 'firstName', 'lastName', 'userCode', 'AccountId', 'role', 'group', 'push', 'tripPush', 'accountsPush', 'email', 'mobile',
				'branchIds', 'activeStatus', 'driverGroupIds', 'driverZoneIds', 'primaryHierarchyIds', 'secondaryHierarchyIds',
				'smsNotification', 'emailNotification', 'notificationTypes', 'user', 'createdAt', 'updatedAt', 'accountIds'],
			include: [
				userRoleInclude,
				{
					attributes: ['id', 'geozones'],
					model: models.AplUser
				}
			],
			where: whereClause,
			order: [["id", "ASC"]]
		});

		return res.send({ success: true, results: Users });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error fetching users', error);
	}
}

exports.get = async function (req, res) {
	const ROUTE = 'web/users/get';
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
		return handleApiError(res, ROUTE, 'Error fetching user details', err);
	}
}

function getRandomInt(min, max) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

exports.sendOtp = async function (req, res) {
	const ROUTE = 'avolve/users/sendOtp';
	RaiseLogEvent(ROUTE, req.body.mobile || req.body.email, req.body, 'Data received');

	try {
		const { username, resend } = req.body;
		const mobile = req.body.mobile ? req.body.mobile.replace(/\s/g, '').trim() : null;
		const email = req.body.email ? req.body.email.trim().toLowerCase() : null;

		// Determine channel
		const isEmailChannel = !!email && !mobile;

		// Basic validation
		if (!mobile && !email) {
			return res.send({ success: false, error: 'Mobile number or email address is required.' });
		}

		if (mobile && !/^\d{10}$/.test(mobile)) {
			return res.send({ success: false, error: 'Please enter a valid 10-digit mobile number.' });
		}

		if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			return res.send({ success: false, error: 'Please enter a valid email address.' });
		}

		// Lookup user
		const User = await avolveHelper.findUser(username, mobile, email);

		if (!User) {
			const contact = mobile || email;
			return res.send({ success: false, error: `No account found for ${username ? 'username ' + username : contact}.` });
		}

		if (isEmailChannel && !User.email) {
			return res.send({ success: false, error: 'No email address mapped to this account. Please contact support.' });
		}

		if (!isEmailChannel && !User.mobile) {
			return res.send({ success: false, error: 'Mobile number not mapped to this account.' });
		}

		if (User.Account && ![10, 11].includes(User.Account.type)) {
			return res.send({ success: false, error: 'Your account is not mapped to Avolve.' });
		}

		// Redis key
		const redisKey = isEmailChannel
			? `avolveUserOTP:${email}`
			: `avolveUserOTP:${mobile}`;

		// Delegate to redis callback (mirrors existing pattern)
		const otpRedis = await redisHelper.getAsync(redisKey);

		// RESEND
		if (resend) {
			if (!otpRedis) {
				return res.send({ success: false, error: 'No active OTP session found. Please start over.' });
			}

			if (isEmailChannel) {
				// const { response, error } = await sendOtpEmail(User.email, otpRedis);
				// if (error) {
				// 	RaiseLogEvent(ROUTE, User.email, { error: error.message }, 'Email resend failed');
				// 	return res.send({ success: false, error: 'Failed to resend OTP email.' });
				// }
				RaiseLogEvent(ROUTE, User.email, { messageId: response.messageId }, 'Email OTP resent');
			} else {
				// const otpMsg = `${otpRedis} is the one-time password(OTP) to reset your password for Avolve application. OTP is valid for next 3 minutes only. Team Avolve`;
				// const { response, error } = await valueFirst.sendMessage(User.mobile, otpMsg);
				// if (error && !response) {
				// 	RaiseLogEvent(ROUTE, User.mobile, { status: error.response?.status }, `SMS resend failed`);
				// 	return res.send({ success: false, error: 'Error resending OTP SMS.' });
				// }
			}
			console.log(otpRedis);

			const maskedContact = isEmailChannel
				? User.email.replace(/^(.{2}).*(@.*)$/, '$1****$2')
				: `******${User.mobile.slice(-4)}`;

			return res.send({
				success: true,
				message: `OTP re-sent to ${maskedContact}`
			});
		}

		// NEW OTP REQUEST
		if (!resend && !req.body.otp && !req.body.pwd) {
			if (otpRedis) {
				return res.send({
					success: false,
					error: 'An active OTP session is in progress. Please wait 3 minutes before requesting a new code.'
				});
			}

			const otpLength = isEmailChannel ? 6 : 5;
			const otp = getRandomInt(
				Math.pow(10, otpLength - 1),
				Math.pow(10, otpLength) - 1
			);

			let sendSuccess = false;

			if (isEmailChannel) {
				// const { response, error } = await sendOtpEmail(User.email, otp);
				// if (error) {
				// 	RaiseLogEvent(ROUTE, User.email, { error: error.message }, 'Email send failed');
				// 	return res.send({ success: false, error: 'Failed to send OTP email. Please try again.' });
				// }
				// RaiseLogEvent(ROUTE, User.email, { messageId: response.messageId }, `Email OTP sent`);
				sendSuccess = true;
			} else {
				const otpMsg = `${otp} is the one-time password(OTP) to reset your password for Avolve application. OTP is valid for next 3 minutes only. Team Avolve`;
				// const { response, error } = await valueFirst.sendMessage(User.mobile, otpMsg);
				// if (error && !response) {
				// 	RaiseLogEvent(ROUTE, User.mobile, { status: error.response?.status }, 'SMS send failed');
				// 	return res.send({ success: false, error: 'Failed to send OTP SMS. Please try again.' });
				// }
				// RaiseLogEvent(ROUTE, User.mobile, { status: response?.status }, 'SMS OTP sent');
				sendSuccess = true;
			}
			console.log(otp)

			if (sendSuccess) {
				models.redis.set(redisKey, otp);
				models.redis.expire(redisKey, 180); // 3 minutes TTL

				const maskedContact = isEmailChannel
					? User.email.replace(/^(.{2}).*(@.*)$/, '$1****$2')
					: `******${User.mobile.slice(-4)}`;

				return res.send({ success: true, message: `Verification code sent to ${maskedContact}` });
			}
		}

		return res.send({ success: false, error: 'Invalid request.' });

	} catch (err) {
		console.error(`Error in ${ROUTE} : ${err}`);
		RaiseLogEvent(ROUTE, 'error', err, 'Error sending OTP');
		return res.send({ success: false, error: 'Error sending OTP.' });
	}
};


/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/forgot-password/verify-otp
   ───────────────────────────────────────────────────────────────────────────
   Body (IN): { username, mobile, otp }
   Body (EU): { username, email,  otp }
   ═══════════════════════════════════════════════════════════════════════════ */
exports.verifyOtp = async function (req, res) {
	const ROUTE = 'avolve/users/verifyOtp';
	RaiseLogEvent(ROUTE, req.body.mobile || req.body.email, req.body, `Data Recieved: Requested by ${res.locals.userFullName}(${res.locals.UserId})`);

	try {
		const { username, otp } = req.body;
		const mobile = req.body.mobile ? req.body.mobile.replace(/\s/g, '').trim() : null;
		const email = req.body.email ? req.body.email.trim().toLowerCase() : null;

		if (!otp) return res.send({ success: false, error: 'OTP is required.' });
		if (!mobile && !email) return res.send({ success: false, error: 'Mobile or email is required.' });

		// Lookup user
		const User = await avolveHelper.findUser(username, mobile, email);

		if (!User) {
			const contact = mobile || email;
			return res.send({ success: false, error: `No account found for ${username ? 'username ' + username : contact}.` });
		}

		const isEmailChannel = !!email && !mobile;
		const redisKey = isEmailChannel
			? `avolveUserOTP:${email}`
			: `avolveUserOTP:${mobile}`;

		let otpRedis = await redisHelper.getAsync(redisKey);
		if (!otpRedis) {
			return res.send({ success: false, error: 'OTP has expired. Please request a new one.' });
		}

		if (String(otpRedis) !== String(otp)) {
			return res.send({ success: false, error: 'Invalid OTP. Please check and try again.' });
		}

		if (User) {
			await User.update({ activeStatus: true });
		}

		RaiseLogEvent(ROUTE, mobile || email, {}, 'OTP verified successfully');
		return res.send({ success: true });

	} catch (err) {
		console.error(`Error in avolve/users/verifyOtp : ${err}`);
		RaiseLogEvent('avolve/users/verifyOtp', 'error', err, 'Error verifying OTP');
		return res.send({ success: false, error: 'Error verifying OTP.' });
	}
};


/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/forgot-password/reset-password
   ───────────────────────────────────────────────────────────────────────────
   Body (IN): { username, mobile, otp, pwd }
   Body (EU): { username, email,  otp, pwd }
   ═══════════════════════════════════════════════════════════════════════════ */
exports.resetPassword = async function (req, res) {
	const ROUTE = 'avolve/forgot-password/reset-password';
	RaiseLogEvent(ROUTE, req.body.mobile || req.body.email, req.body, 'Data received');

	try {
		const { username, otp, pwd } = req.body;
		const mobile = req.body.mobile ? req.body.mobile.replace(/\s/g, '').trim() : null;
		const email = req.body.email ? req.body.email.trim().toLowerCase() : null;

		if (!otp) return res.send({ success: false, error: 'OTP is required.' });
		if (!pwd) return res.send({ success: false, error: 'New password is required.' });
		if (!mobile && !email) return res.send({ success: false, error: 'Mobile or email is required.' });

		if (pwd.length < 8) {
			return res.send({ success: false, error: 'Password must be at least 8 characters.' });
		}

		const isEmailChannel = !!email && !mobile;
		let User = {};
		if (isEmailChannel) {
			User = await avolveHelper.findUser(username, null, email);
		} else {
			User = await avolveHelper.findUser(username, mobile, null);
		}

		const redisKey = isEmailChannel
			? `avolveUserOTP:${email}`
			: `avolveUserOTP:${mobile}`;

		let otpRedis = await redisHelper.getAsync(redisKey);
		if (!otpRedis) {
			return res.send({ success: false, error: 'OTP has expired. Please start the process again.' });
		}

		if (String(otpRedis) !== String(otp)) {
			return res.send({ success: false, error: 'Invalid or expired OTP.' });
		}

		// Hash new password (mirrors existing resetPassword)
		const hash = await models.User.hashAsync(pwd);
		if (!hash) {
			return res.send({ success: false, error: 'Failed to update password. Please try again.' });
		}

		if (!isEmailChannel) {
			/* IN — handle multiple profiles sharing same mobile (existing logic) */
			const usersGroup = await avolveHelper.getUsers(mobile, email, false, res.locals.region);
			if (usersGroup.results && usersGroup.results.length > 1) {
				RaiseLogEvent(ROUTE, mobile, usersGroup.results, 'Multiple profile response');
				await models.User.update(
					{ password: hash },
					{ where: { id: usersGroup.results.map(x => x.id) } }
				);
			} else {
				if (User) await User.update({ password: hash });
			}
		} else {
			/* EU — single user by email */
			if (!User) {
				return res.send({ success: false, error: 'User not found.' });
			}
			await User.update({ password: hash });
		}

		/* Clean up OTP from Redis */
		await redisHelper.delAsync(redisKey);

		return res.send({ success: true, message: 'Password updated successfully.' });

	} catch (err) {
		RaiseLogEvent('avolve/forgot-password/reset-password', 'error', err, JSON.stringify(req.body));
		console.error('forgot-password/reset-password error:', err);
		return res.send({ success: false, error: 'Error processing your request.' });
	}
};

exports.resetPassword = async function (req, res) {
	const ROUTE = 'avolve/forgot-password/reset-password';
	RaiseLogEvent(ROUTE, req.body.mobile || req.body.email, req.body, 'Data received');
	try {
		const mobileNo = req.body.mobile ? req.body.mobile.replace(/\s/g, '').trim() : null;
		const email = req.body.email ? req.body.email.trim().toLowerCase() : null;
		const { pwd } = req.body;

		const isEmailChannel = !!email && !mobileNo;
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
			User = await avolveHelper.findUser(res.locals.region, null, email);
		} else {
			User = await avolveHelper.findUser(res.locals.region, mobileNo, null);
		}

		if (!User) {
			return res.status(401).send({ success: false, error: `User with mobile ${mobileNo} not found` });
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

		const redisKey = isEmailChannel
			? `avolveUserOTP:${email}`
			: `avolveUserOTP:${mobileNo}`;

		let otpRedis = await redisHelper.getAsync(redisKey);
		if (!otpRedis) {
			return res.send({ success: false, error: 'OTP has expired. Please start the process again.' });
		}

		if (!req.body.otp || otpRedis != req.body.otp) {
			return res.status(403).send({ success: false, error: 'Invalid or missing OTP' });
		} else {
			let hash = await models.User.hashAsync(pwd);
			if (!hash) {
				RaiseLogEvent('users/resetPassword', 'error', {}, `Data ${JSON.stringify(req.body)}`);
				return res.status(500).send({ success: false, error: "Failed to update password. Please try again" });
			} else {
				let usersGroup = await avolveHelper.getUsers(mobileNo, email, true, req.get('X-AVL-Region'));
				if (usersGroup.results && usersGroup.results.length > 1) { //reset password to multiple profiles
					RaiseLogEvent('users/resetPassword', req.body.mobile, usersGroup.results, `Multiple profile response`);
					await models.User.update({
						password: hash
					}, {
						where: {
							id: usersGroup.results.map(x => x.id)
						}
					});
				} else {
					await User.update({ password: hash });
				}
				await redisHelper.delAsync(redisKey);
				return res.send({ success: true });
			}
		}
	} catch (err) {
		console.error(`Error in avolve/users/resetPassword : ${err}`);
		RaiseLogEvent('avolve/users/resetPassword', 'error', err, `Error resetting password`);
		return res.send({ success: false, error: 'Error resetting password.' });
	}
}

exports.create = async function (req, res) {
	const ROUTE = 'web/users/create';
	try {
		if (!res.locals.AccountId || !req.body.username || !req.body.password) {
			return res.send({ success: false, error: 'fields left empty' });
		} else if (req.body.password.length < 5) {
			return res.send({ success: false, error: 'password too short' });
		} else if (req.body.username.length < 2) {
			return res.send({ success: false, error: 'username too short' });
		} else if (/[^a-zA-Z0-9\.\@]/.test(req.body.username)) {
			return res.send({ success: false, error: 'username must contain only letters, numbers and dots' });
		} else if (isNaN(req.body.role)) {
			return res.send({ success: false, error: 'Invalid user role' });
		} else {
			const Account = await models.Account.findOne({
				include: [{
					attributes: ['id', 'name'],
					model: models.UserRole
				}],
				where: {
					id: res.locals.AccountId
				}
			});

			if (!Account) {
				return res.send({ success: false, error: 'Account not found' });
			}
			let newUserRole = Account.UserRoles.find(x => x.id == req.body.role);
			let currUserRole = Account.UserRoles.find(x => x.id == res.locals.UserRoleId);
			if (newUserRole && newUserRole.name == 'Admin' && currUserRole && currUserRole.name != 'Admin') {
				return res.send({ success: false, error: 'Only admins can create this role' });
			}
			const User = await models.User.count({
				where: {
					username: { [Op.iLike]: req.body.username }
				}
			});

			if (User) {
				return res.send({ success: false, error: 'Username already taken' });
			}
			let hash = await models.User.hashAsync(req.body.password);
			var data = { username: req.body.username, password: hash };
			var hierarchyData = {
				id: req.body.primaryHierarchyIds ? req.body.primaryHierarchyIds : [],
				AccountId: res.locals.AccountId
			}

			data.primaryHierarchyIds = req.body.primaryHierarchyIds ? req.body.primaryHierarchyIds : [];
			data.UserRoleId = req.body.role;
			data.email = req.body.email ? req.body.email : null;
			data.mobile = req.body.mobile ? req.body.mobile : null;
			data.firstName = req.body.firstName && req.body.firstName || "";
			data.userCode = req.body.userCode && req.body.userCode || "";
			data.lastName = req.body.lastName && req.body.lastName || "";
			data.user = { // Capture created user
				created: {
					id: res.locals.id,
					username: res.locals.username
				}
			}
			data.details = {
				designation: req.body.designation || undefined
			}

			// Enforce OTP login from account config.
			if (Account.config && Account.config.loginOtp && Account.config.loginOtp == true) {
				data.otp = 1;
			}
			const NewUser = await models.User.create(data);
			await NewUser.setAccount(Account);

			events.emit("new-user", {
				id: NewUser.id,
				AccountId: NewUser.AccountId,
				Groups: []
			});

			if (newUserRole && ['AMCS FTE', 'DE FTE', 'XE FTE', 'ARSA', 'AMCC FTE'].includes(newUserRole.name)) {
				events.emit('apl-fte-serviceSummary', {
					AccountId: Account.id,
					role: newUserRole.name,
					month: moment().format('MM'),
					year: moment().format('YYYY')
				});
			}
			return res.send({ success: true, user: buildReplyUser(NewUser) });

			// Trigger FTE Assignment email to customer
			let isFTS = Account.details && Account.details.avolve == false || false;
			if (newUserRole.name && ['DE FTE', 'FO'].includes(newUserRole.name) && !isFTS) {
				let data = {
					account: { tname: Account.tname, id: Account.id, name: Account.name },
					user: { id: NewUser.id, firstName: NewUser.firstName, lastName: NewUser.lastName || '' },
					role: newUserRole.name || ''
				};
				events.emit('avolve-auto-mailer-triggerByUser', data);
				RaiseLogEvent('avolve-auto-mailer-triggerByUser', Account.id, data, `Process started for mail trigger based on the user creation.`);
			}
		}
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error creating user', error);
	}
}

exports.update = async function (req, res) {
	const ROUTE = 'web/users/update';
	try {
		RaiseLogEvent('users/update', res.locals.AccountId || 'log', req.body, `User update request by ${res.locals.username}`);
		if ((!req.params.id && req.params.id < 0) || (!req.body.password && !req.body.UserRoleId)) {
			return res.send({ success: false, error: 'Missing input parameters.', message: 'Missing input parameters.' });
		}
		if (req.body.username && /[^a-zA-Z0-9\.\@]/.test(req.body.username)) {
			return res.send({ success: false, error: 'username must contain only letters, numbers and dots' });
		}

		let User = await models.User.findOne({
			include: [{
				attributes: ['id', 'name'],
				model: models.UserRole
			}],
			where: {
				AccountId: res.locals.AccountId,
				id: req.params.id
			}
		});

		let AdminUsers = await models.User.findOne({
			group: ['UserRole.name'],
			attributes: [
				[models.sequelize.fn('COUNT', models.sequelize.col('User.id')), 'userCount']
			],
			include: [{
				attributes: ['name'],
				model: models.UserRole,
				where: {
					name: 'Admin',
				}
			}],
			where: {
				AccountId: res.locals.AccountId,
				activeStatus: true
			},
			raw: true
		});

		let UserRole = await models.UserRole.findOne({
			attributes: ['id', 'name'],
			where: {
				AccountId: res.locals.AccountId,
				id: User?.UserRole?.id || req.body.UserRoleId
			}
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found', message: 'User not found' });
		}
		if (!req.body.password && !UserRole) {
			return res.send({ success: false, error: 'Role not found', message: 'Role not found' });
		}
		if (!req.body.password && (AdminUsers && AdminUsers.userCount == 1)) { // if last admin user restrict changing user role
			if (UserRole.name != 'Admin' && (User.UserRole && User.UserRole.name == "Admin")) {
				if (User.UserRole.id != req.body.UserRoleId) {
					let message = 'Cannot change role. Atleast one admin user should be present in the account!';
					return res.send({ success: false, error: message, message: message });
				}
			}
		}
		if (User.UserRole.name == 'Admin' && req.body.activeStatus == "false" && (!AdminUsers || AdminUsers.userCount < 2)) {
			return res.send({ success: false, error: 'Cannot change active status. Atleast one admin user should be present in the account!' });
		}

		// Capture updated user.
		let userData = JSON.parse(JSON.stringify(User.user || {}));
		userData.updated = {
			id: res.locals.id,
			username: res.locals.username
		}
		User.user = userData;

		if (req.body.password) {
			// Sankari Roadways - Prevent accountsec update (causing token expiry in BASF API)
			if (res.locals.AccountId == 17 && res.locals.id != 6922) {
				return res.send({ success: false, error: 'Only Sangeeth can change passwords!' });
			}
			let hash = await models.User.hashAsync(req.body.password);
			User.password = hash;
			await User.save();
			if (User.UserRole && User.UserRole.name == 'Admin') {
				const secret = makeid();
				await models.redis.set("accountsec:" + User.AccountId, secret);
				events.emit("password-change", { accountId: User.AccountId, secret, type: "account" });
			}
			return res.send({ success: true, user: buildReplyUser(User) });
		} else if (req.body.otp) {
			User.otp = req.body.otp;
			if (req.body.mobile) {
				User.mobile = req.body.mobile;
			}
			await User.save();
			await models.redis.del('user:' + User.id);
			await redisHelper.delUser(User.id);
			return res.send({ success: true, user: buildReplyUser(User) });
		} else {
			if (req.body.username && User.username != req.body.username.replace(/[^a-zA-Z0-9\.\@]/gi, '')) {
				let existingUser = await models.User.findOne({
					where: {
						username: { ilike: req.body.username }
					}
				});
				if (existingUser) {
					return res.send({ success: false, error: 'username/email already taken' });
				}
				User.username = req.body.username.replace(/[^a-zA-Z0-9\.\@]/gi, '');
			}

			User.UserRoleId = req.body.UserRoleId || null;
			User.activeStatus = req.body.activeStatus == "false" ? false : true;
			User.email = req.body.email || null;
			User.mobile = req.body.mobile || null;
			User.firstName = req.body.firstName || "";
			User.lastName = req.body.lastName || "";
			User.userCode = req.body.userCode || "";
			await User.save();

			models.redis.HDEL("ug" + User.id, "assetIds");
			await redisHelper.delUser(User.id);

			let updatedUser = await models.User.findOne({
				include: [{
					attributes: ['id', 'name'],
					model: models.UserRole
				}],
				where: { id: User.id }
			});

			events.emit('new-user', buildReplyUser(updatedUser));

			await redisHelper.delAsync('user:' + User.id);
			return res.send({ success: true, user: buildReplyUser(User) });
		}
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error updating user', error);
	}
}

exports.delete = async function (req, res) {
	const ROUTE = 'web/users/delete';
	try {
		RaiseLogEvent('users/delete', res.locals.AccountId || 'log', { user: res.locals.username, id: req.params.id, AccountId: res.locals.AccountId }, `User delete request by ${res.locals.userFullName} (${res.locals.UserId})`);
		const [user, adminUsers] = await Promise.all([
			models.User.findOne({
				include: [{
					attributes: ['id', 'name'],
					model: models.UserRole
				}],
				where: {
					id: req.params.id,
					AccountId: res.locals.AccountId
				}
			}),
			models.User.findOne({
				group: ['UserRole.name'],
				attributes: [[models.sequelize.fn('COUNT', models.sequelize.col('User.id')), 'userCount']],
				include: [{
					attributes: ['name'],
					model: models.UserRole,
					where: { name: 'Admin' }
				}],
				where: {
					AccountId: res.locals.AccountId,
				},
				raw: true
			})
		])
		if (!user) {
			return res.send({ success: false, error: 'User not found' });
		}
		if (adminUsers && adminUsers.userCount == 1) { // if last admin user restrict changing user role
			if (user.UserRole.name == 'Admin') {
				let message = 'Cannot delete user. Atleast one admin user should be present in the account!';
				return res.send({ success: false, error: message, message: message });
			}
		}

		await user.destroy();
		await redisHelper.delAsync("ug" + req.params.id);
		await redisHelper.delAsync('user:' + user.id);
		await redisHelper.delUser(user.id);

		return res.send({ success: true, error: 'User successfully deleted.' });
	} catch (error) {
		return handleApiError(res, ROUTE, 'Error deleting user', error);
	}
}

function buildReplyUser(user) {
	var replyUser = {};
	replyUser = user.dataValues;
	delete replyUser.password;
	return replyUser;
}

exports.assignZm = async function (req, res) {
	const ROUTE = 'app/users/assignZm';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		if (!req.params.id) {
			return res.send({ success: false, error: 'UserId Missing.' });
		}

		let User = await models.User.findOne({
			attributes: ['id', 'username', 'AccountId', 'details'],
			include: [{
				attributes: ['id', 'name'],
				model: models.UserRole,
				required: true
			}],
			where: {
				id: req.params.id,
				AccountId: res.locals.masterAccountId
			}
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found' });
		}

		if (!req.body.userIds || !req.body.userIds.length) {
			await User.update({
				'details.bdm': []
			});
			return res.send({ success: true });
		}

		let ReqUsers = await models.User.findAll({
			attributes: ['id', 'username', 'AccountId', 'ManagerId'],
			include: [{
				attributes: ['id', 'name'],
				model: models.UserRole,
				where: {
					name: ['ZM', 'FTS ZM']
				}
			}],
			where: {
				id: req.body.userIds,
				activeStatus: true,
				AccountId: res.locals.masterAccountId
			}
		});

		if (!ReqUsers.length) {
			return res.send({ success: false, error: 'Selected users not found' });
		}

		let details = User.details && JSON.parse(JSON.stringify(User.details)) || {};
		details.bdm = ReqUsers.map(x => x.id) || [];

		await User.update({
			details: details
		});

		return res.send({ success: true });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error assigning ZMs.', err);
	}
}

exports.assignUser = async function (req, res) {
	const ROUTE = 'app/users/assignUser';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);

		if (!req.params.id) {
			return res.send({ success: false, error: 'UserId Missing.' });
		}

		let User = await models.User.findOne({
			attributes: ['id', 'username', 'AccountId'],
			include: [{
				attributes: ['id', 'name'],
				model: models.UserRole,
				required: true
			}],
			where: {
				id: req.params.id,
				AccountId: res.locals.masterAccountId
			}
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found' });
		}

		if (!User.UserRole || (User.UserRole && ['HO Sales', 'FTS HO', 'ZM', 'FTS ZM'].indexOf(User.UserRole.name) == -1)) {
			return res.send({ success: false, error: 'Not authorized to this user.' });
		}

		if (!req.body.userIds || !req.body.userIds.length) {
			await models.User.update({
				ManagerId: null
			}, {
				where: {
					ManagerId: User.id
				}
			});
			return res.send({ success: true });
		}

		let ReqUsers = await models.User.findAll({
			attributes: ['id', 'username', 'AccountId', 'ManagerId'],
			include: [{
				attributes: ['id', 'name'],
				model: models.UserRole
			}],
			where: {
				id: req.body.userIds,
				AccountId: res.locals.masterAccountId
			}
		});

		if (!ReqUsers.length) {
			return res.send({ success: false, error: 'Selected users not found' });
		}

		let MgrUsers = await models.User.findAll({
			attributes: ['id', 'username', 'AccountId', 'ManagerId'],
			include: [{
				attributes: ['id', 'name'],
				model: models.UserRole
			}],
			where: {
				id: ReqUsers.map(x => x.ManagerId),
				AccountId: res.locals.masterAccountId
			}
		});

		if (!['HO Sales', 'FTS HO'].includes(User.UserRole.name)) {
			for (let ReqUser of ReqUsers) {
				if (ReqUser.ManagerId && ReqUser.ManagerId != User.id) {
					let matchMgr = MgrUsers.find(x => x.id == ReqUser.ManagerId);
					if (!matchMgr) {
						continue;
					}
					return res.send({ success: false, error: `${ReqUser.UserRole.name} (${ReqUser.username}) already map with ${matchMgr.UserRole.name} (${matchMgr.username}), Do you want to re-map it with ${User.UserRole.name} (${User.username})` });
				}
			}

			await models.User.update({
				ManagerId: null
			}, {
				where: {
					ManagerId: User.id
				}
			});
		}


		await models.User.update({
			ManagerId: User.id
		}, {
			where: {
				id: ReqUsers.map(x => x.id)
			}
		});

		return res.send({ success: true });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error assigning users.', err);
	}

}

exports.assignCustomer = async function (req, res) {
	const ROUTE = 'app/users/assignCustomer';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.params.id) {
			return res.send({ success: false, error: 'UserId Missing.' });
		}

		let accountIds = JSON.parse(req.body.accountIds);

		let User = await models.User.findOne({
			attributes: ['id', 'username', 'AccountId', 'accountIds', 'email', 'firstName', 'lastName', 'mobile'],
			include: [{
				attributes: ['id', 'name'],
				model: models.UserRole
			}],
			where: {
				id: req.params.id,
				AccountId: res.locals.AccountId
			}
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found' });
		}

		if (!accountIds.length) {
			await User.update({
				accountIds: []
			});
			return res.send({ success: true });
		}

		let Accounts = await models.Account.findAll({
			attributes: ['id', 'tname', 'name', [models.sequelize.literal(`"details"->'avolve'`), 'avolve']],
			where: {
				id: accountIds.map(x => parseInt(x.id)),
				AccountIdParent: res.locals.masterAccountId
			},
			raw: true
		});

		let AplAccountDrafts = await models.AplAccountDraft.findAll({
			attributes: ['id', 'AccountId', 'status'],
			where: {
				AccountId: accountIds.map(x => parseInt(x.id))
			},
			raw: true
		});

		let kamUsers = await models.User.findAll({
			attributes: ['id', 'username', 'AccountId', 'accountIds'],
			include: [{
				attributes: ['id', 'name'],
				model: models.UserRole,
				where: {
					name: ['KAM', 'FTS KAM']
				},
				required: true
			}],
			where: {
				id: { [Op.ne]: User.id },
				AccountId: res.locals.masterAccountId
			}
		});

		if (!['AMCC FTE', 'XE FTE', 'ARSA'].includes(User.UserRole.name)) {
			for (let Account of Accounts) {
				let matchKam = kamUsers.find(x => x.accountIds.find(account => parseInt(account.id) == Account.id));
				if (matchKam) {
					return res.send({ success: false, error: `${Account.tname} already map with ${matchKam.UserRole.name} (${matchKam.username}), Do you want to re-map it with ${User.UserRole.name} (${User.username})` });
				}
			}
		}

		if (User.UserRole && ['AMCC FTE', 'XE FTE', 'KAM'].includes(User.UserRole.name)) {
			const userIdSet = new Set(User.accountIds.map(acc => Number(acc.id)));
			const newCustomers = accountIds.filter(acc => !userIdSet.has(Number(acc.id)));//check if new customers are assigned
			RaiseLogEvent(ROUTE, User.id, newCustomers, `New customers to trigger email`);
			if (newCustomers.length) {
				let type = 'mdgAssign';
				if (['AMCC FTE', 'XE FTE'].includes(User.UserRole.name)) {
					type = 'fteAssign';
				}
				let userData = {
					name: User.firstName && `${User.firstName} ${User.lastName || ''}` || '',
					mobile: User.mobile || '',
					email: User.email || ''
				};
				for (const account of newCustomers) {
					let acc = Accounts.find(x => x.id == account.id) || {};
					if (!acc.avolve) {
						continue;
					}
					let custCreated = AplAccountDrafts.find(x => x.AccountId == acc.id);
					if (!custCreated || custCreated.status != 1) { // ignore email trigger non draft customer
						continue;
					}
					let data = { AccountId: acc.id, tname: acc.tname || '', mdgId: acc.name.split('_')[0] || '', user: userData, type };
					if (type == 'mdgAssign') {
						events.emit('trigger-avolve-kam-mailer', data);
						events.emit('notify', {
							type: "KAM_CUSTOMER_ASSIGNED",
							UserIds: User.id,
							data: {
								title: 'New Customer Assigned',
								body: `${acc.tname} (MDG ID: ${acc.name}) has been assigned to you. Please complete onboarding from the Draft section.`,
								AccountDraftId: custCreated.id.toString()
							}
						});
					} else {
						events.emit('trigger-avolve-customer-mailer', data);
					}
					RaiseLogEvent('trigger-avolve-customer-mailer', type, data, `Email triggered for ${type}.`);
				}
			}
		}

		await User.update({
			accountIds: accountIds
		});

		return res.send({ success: true });
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error assigning zones', err);
	}

}

exports.assignZone = async function (req, res) {
	const ROUTE = 'app/users/assignZone';
	try {
		RaiseLogEvent(ROUTE, res.locals.AccountId, req.body, `Requested by ${res.locals.userFullName} (${res.locals.UserId})`);
		if (!req.params.id) {
			return res.send({ success: false, error: 'UserId Missing.' });
		}

		let User = await models.User.findOne({
			attributes: ['id', 'AccountId'],
			include: [{
				model: models.AplUser
			}],
			where: {
				id: req.params.id,
				AccountId: res.locals.AccountId
			}
		});

		if (!User) {
			return res.send({ success: false, error: 'User not found' });
		}

		let AplUser = User.AplUser && User.AplUser || {};

		if (!Object.keys(AplUser).length) { //Create AplUser
			let createdUser = await models.AplUser.create({
				geozones: req.body.geozones && JSON.parse(req.body.geozones) || [],
				user: {
					createdBy: {
						id: res.locals.UserId,
						username: res.locals.username,
						date: moment().toISOString()
					}
				},
				UserId: User.id,
				AccountId: User.AccountId
			});

			return res.send({ success: true, user: createdUser });
		} else {
			let user = JSON.parse(JSON.stringify(AplUser.user));
			user.updatedBy = {
				id: res.locals.UserId,
				username: res.locals.username,
				date: moment().toISOString()
			}

			let updUser = await AplUser.update({
				user: user,
				geozones: req.body.geozones && JSON.parse(req.body.geozones) || [],
				UserId: User.id,
				AccountId: User.AccountId
			});

			return res.send({ success: true, user: updUser });
		}
	} catch (err) {
		return handleApiError(res, ROUTE, 'Error assigning zones', err);
	}

}
