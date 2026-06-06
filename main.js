/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libConfig from "mws/config.js";
import * as libServer from "mws/server.js";
import * as libLog from "mws/log.js";

const logger = libLog.Logger('main');

async function Setup(module, err) {
	if (err != null)
		return logger.error(`Unable to load local module [module/setup.js]: ${err.message}`);
	if (module == null || module.Run == null)
		return logger.error('Unable to run local module [module/setup.js:Run]');
	logger.log('Setup module loaded');

	/* load the server and configure it */
	const server = new libServer.Server();
	try {
		await module.Run(server);
		logger.log('Server started and configured');
	}
	catch (e) {
		logger.error(`Failed to setup the application: ${e.message}`);
		server.stop();
	}
}

/* initialize the default configuration (before loading the local module!) */
logger.log('Initializing configuration...');
libConfig.InitializeConfig();

/* try to load the local configuration and otherwise perform the default-setup */
logger.log('Loading setup module...');
import("./modules/setup.js")
	.then((module) => Setup(module, null))
	.catch((err) => Setup(null, err));
