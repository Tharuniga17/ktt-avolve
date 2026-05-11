'use strict';

const express = require('express');
const controller = require('./ticket');
const router = express.Router();
const upload = require('../../middlewares/upload');
const { requireLogin } = require('../../middlewares/helper');

router.get('/caseTypes', requireLogin, controller.getCaseTypes);
router.get('/list', requireLogin, controller.list);
router.get('/get/:id', requireLogin, controller.get);
router.get('/count', requireLogin, controller.count);
router.put('/update/:id', requireLogin, controller.update);
router.put('/updateStatus/:id', requireLogin, controller.updateStatus);
router.post('/create', requireLogin, upload.array('files[]', 5), controller.create);

module.exports = router;