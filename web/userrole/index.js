'use strict';

const express = require('express');
const controller = require('./userrole');
const router = express.Router();
const { requireLogin } = require('../../middlewares/helper');

router.get('/user/:id', requireLogin, controller.getByUser);
router.get('/list', requireLogin, controller.list);
router.get('/menus', requireLogin, controller.getMenuList);
router.get('/:id', requireLogin, controller.get);

router.post('/', requireLogin, controller.save);

router.delete('/:id', requireLogin, controller.delete);

module.exports = router;