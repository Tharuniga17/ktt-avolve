'use strict';

const express = require('express');
const controller = require('./user');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");
const allFileUpload = require("../../middlewares/upload");
const models = require('../../../models');
const jwt = require("jsonwebtoken");
const config = require('../../../config/security.json');
const redisHelper = require('../../../lib/helpers/redis')

router.post('/isSessionValid', async function (req, res, next) {
    try {
        const secret = await getSessionSecret(req);
        jwt.verify(req.get('X-AVL-SessionToken'), secret, function (err, decoded) {
            if (!decoded) {
                return res.send(false);
            }
            const useragent = req.headers['user-agent'] === undefined ? '' : req.headers['user-agent'];
            if (useragent) {
                const appName = useragent.toString().split('/')[0].replace(/\s+/g, '');
                const version = parseFloat(useragent.toString().split(/[ /]+/)[2]);
                const hkey = `ACC:${decoded.AccountId}:USER:${decoded.id}`;
                models.redis.HSET(`app:${appName}:${version}`, hkey, useragent);
            }
            res.send(true);
        });
    } catch (error) {
        console.log(error);
        res.send(false);
    }
});

async function getSessionSecret(req) {
    const decoded = jwt.decode(req.get('X-AVL-SessionToken'), { complete: true });
    let accountId = -1;
    if (decoded && decoded.payload) {
        accountId = decoded.payload.AccountId;
    }
    let secret;
    try {
        secret = await redisHelper.getAsync(`accountsec:${accountId}`);
    } catch (err) {
        console.error('Redis get error:', err);
    }
    return secret || config.session.secret;
}

router.get('/menuList', requireLogin, controller.getMenuList);
router.get('/list/:role', requireLogin, controller.listByRole);
router.get('/listByAccountId', requireLogin, controller.listByAccountId);
router.get('/teams', requireLogin, controller.getTeams);
router.get('/listByRole', requireLogin, controller.getUserByRole);
router.get('/email/unsubscribe', controller.emailUnsubscribe);
router.get('/fteList/kam', requireLogin, controller.getFteByKam);
router.get('/:id', requireLogin, controller.get);
router.get('/manager/:id', requireLogin, controller.getByManager);
router.get('/kamList/user/:id', requireLogin, controller.getKamList);
router.get('/summary/:id', requireLogin, controller.getUserSummay);
router.get('/accountSummary/:id', requireLogin, controller.getAccountSummary);
router.get('/session/:id', controller.getSession);
router.post('/config', requireLogin, controller.userConfig);

router.post('/register', controller.register);
router.post('/login', controller.login);
router.post('/reset', controller.resetPassword);
router.post('/otp/token/verify', controller.otpTokenVerify);
router.post('/google-login', controller.googlelogin);

router.put('/profile/:id', requireLogin, allFileUpload.fields([{ name: 'profile' }]), controller.updateProfile);

module.exports = router;