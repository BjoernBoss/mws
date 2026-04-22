/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libConfig from "core/config.js";
import * as libServer from "core/server.js";
import * as libLog from "core/log.js";

const logger = libLog.Logger('main');

async function Setup(setupModule) {
	if (setupModule == null || setupModule.Run === undefined) {
		logger.error('Unable to load local module [module/setup.js:Run]');
		return;
	}
	logger.info('Local module loaded');

	/* load the server and configure it */
	const server = new libServer.Server();
	try {
		await setupModule.Run(server);
	}
	catch (e) {
		logger.error(`Failed to setup the application: ${e.message}`);
		server.stop();
	}
}

/* initialize the default configuration (before loading the local module!) */
libConfig.Initialize();

/* try to load the local configuration and otherwise perform the default-setup */
import("./modules/setup.js")
	.then(setupModule => Setup(setupModule))
	.catch(() => Setup(null));
