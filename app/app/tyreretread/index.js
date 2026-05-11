"use strict";

const express = require("express");
const controller = require("./tyreretread");
const router = express.Router();
const { requireLogin } = require("../../middlewares/helper");

router.get("/list", requireLogin, controller.list);

module.exports = router;
