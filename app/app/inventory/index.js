'use strict';

const express = require('express');
const router = express.Router();
const controller = require('./inventory');
const { requireLogin } = require("../../middlewares/helper");

router.get('/branches', requireLogin, controller.fetchBranches);

module.exports = router;