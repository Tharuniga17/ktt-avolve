'use strict';

const express = require('express');
const controller = require('./tyreMakeModel');
const helper = require('../../middlewares/helper');
const requireLogin = helper.requireLogin;
const router = express.Router();

router.get('/list', requireLogin, controller.list);
router.post('/enquiry', requireLogin, controller.saveEnquiry);

module.exports = router;