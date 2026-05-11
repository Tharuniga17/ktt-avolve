'use strict';

const express = require('express');
const controller = require('./assetservice');
const { requireLogin } = require('../../middlewares/helper');
const router = express.Router();

router.get('/listIssueTypes', requireLogin, controller.listIssueType);
router.get('/listStatus', requireLogin, controller.listServiceStatus);
router.get('/:id', requireLogin, controller.get);

router.post('/create', requireLogin, controller.create);

module.exports = router;