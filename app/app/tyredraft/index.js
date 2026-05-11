'use strict';

const express = require('express');
const controller = require('./tyredraft');
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper"); 

router.get('/asset/tyre/exists/:id', requireLogin, controller.checkAllTyreExists);
router.get('/list', requireLogin, controller.list);
router.put('/onboardTyre/:id', requireLogin, controller.onboardTyre);
router.put('/:id', requireLogin, controller.update);

module.exports = router;