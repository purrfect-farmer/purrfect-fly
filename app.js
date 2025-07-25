"use strict";
require("dotenv/config");
require("./startup");
require("./cron");

const path = require("node:path");
const AutoLoad = require("@fastify/autoload");

// Pass --options via CLI arguments in command to enable these options.
const options = {
  logger: process.env.NODE_ENV !== "production",
};

module.exports = async function (fastify, opts) {
  // Place here your custom code!
  fastify.register(require("@fastify/jwt"), {
    secret: process.env.JWT_SECRET_KEY,
  });

  // Do not touch the following lines

  // This loads all plugins defined in plugins
  // those should be support plugins that are reused
  // through your application
  fastify.register(AutoLoad, {
    dir: path.join(__dirname, "plugins"),
    options: Object.assign({}, opts),
  });

  // This loads all plugins defined in routes
  // define your routes in one of these
  fastify.register(AutoLoad, {
    dir: path.join(__dirname, "routes"),
    options: Object.assign({}, opts),
  });
};

module.exports.options = options;
