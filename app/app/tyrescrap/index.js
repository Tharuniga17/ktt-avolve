"use strict";

const express = require("express");
const controller = require("./tyrescrap");
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");

router.get("/list", requireLogin, controller.list);
router.put('/scrapComplete', requireLogin, controller.scrapComplete);
router.get("/archivelist", requireLogin, controller.archivelist);

// Add Other operations as needed.

module.exports = router;