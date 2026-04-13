/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libServer from "./server.js";
import * as libLog from "core/log.js";
import * as libConfig from "core/config.js";
import * as libCache from "core/cache.js";

async function Setup(setupModule: any) {
	if (setupModule == null || setupModule.Run === undefined) {
		libLog.Error('Unable to load local module [module/setup.js:Run]');
		return;
	}
	libLog.Info('Local module loaded');

	/* load the server and configure it */
	const server = new libServer.Server();
	try {
		await setupModule.Run(server);
	}
	catch (e: any) {
		libLog.Error(`Failed to setup the application: ${e.message}`);
		server.stop();
	}
}

/* initialize the default configuration (before loading the local module!) */
libConfig.Initialize();
libCache.Initialize();

/* try to load the local configuration and otherwise perform the default-setup */
import("../modules/setup.js")
	.then(setupModule => Setup(setupModule))
	.catch(() => Setup(null));
