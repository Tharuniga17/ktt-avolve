'use strict';

const express = require('express');
const controller = require('./user');
const router = express.Router();
const { requireLogin } = require('../../middlewares/helper');
const models = require('../../../models');
const jwt = require("jsonwebtoken");
const config = require('../../../config/security.json');
const redisHelper = require('../../../lib/helpers/redis')

router.get('/listByRole', requireLogin, controller.listUserByRole);
router.get('/listByAccountId', requireLogin, controller.listByAccountId);
router.get('/:id', requireLogin, controller.get);

router.put('/:id', requireLogin, controller.update);
router.put('/assignZone/:id', requireLogin, controller.assignZone);
router.put('/assignUser/:id', requireLogin, controller.assignUser);
router.put('/assignCustomer/:id', requireLogin, controller.assignCustomer);
router.put('/assignUser/hoSales/:id', requireLogin, controller.assignZm);

router.post('/resetPassword', controller.resetPassword);
router.post('/resetPassword/sendOtp', controller.sendOtp);
router.post('/resetPassword/verifyOtp', controller.verifyOtp);
router.post('/create', requireLogin, controller.create);
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

router.delete('/:id', requireLogin, controller.delete);

module.exports = router;