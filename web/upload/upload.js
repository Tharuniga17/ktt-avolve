"use strict";

const evt = require("../../../lib/event");
const AWS = require("aws-sdk");

const env = process.env.NODE_ENV || "development";
const app_json = process.env.NODE_ENV_APP_JSON || "app.json";
const config = require("../../../config/" + app_json)[env];
const { RaiseLogEvent } = require("../../../lib/helpers/rmqlog");

const cdnUrl = (config && config.cdn && config.cdn.url) || null;

let s3conf = {
	accessKeyId: config.AWS.AWS_ACCESS_KEY,
	secretAccessKey: config.AWS.AWS_SECRET_ACCESS_KEY
};

// Local server config
if (env !== "production") {
	s3conf.endpoint = config.AWS.S3.endpoint;
	s3conf.s3ForcePathStyle = true;
	s3conf.sslEnabled = false;
	s3conf.signatureVersion = "v4";
}

const s3 = new AWS.S3(s3conf);

/**
 * Download file from main S3 bucket
 */
exports.getFile = async function (req, res) {
	try {
		RaiseLogEvent("upload/getFile", "log", {
			url: req.url,
			baseUrl: req.baseUrl,
			params: req.params
		}, "File download request");

		let awsKey = (req.params && req.params[0]) || null;
		if (awsKey && awsKey[0] === "/") awsKey = awsKey.slice(1);

		if (!awsKey) {
			return res.send({ success: false, error: "Unknown file path" });
		}

		const bucketParams = {
			Bucket: config.AWS.S3.bucket,
			Key: awsKey
		};

		const data = await s3.getObject(bucketParams).promise();

		res.setHeader("Content-Security-Policy", "frame-ancestors *");
		res.setHeader("Content-Type", data.ContentType);

		s3.getObject(bucketParams).createReadStream().pipe(res);

	} catch (err) {
		console.error("s3 download error:", err);
		RaiseLogEvent("upload/getFile", "error", err, "S3 download error");
		return res.send({ success: false, error: err.message || err });
	}
}