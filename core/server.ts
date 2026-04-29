/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import { Config as libConfig } from "./config.js";
import * as libLog from "./log.js";
import * as libClient from "./client.js";
import * as libRequest from "./request.js";
import * as libInterface from "./interface.js";
import * as libHttps from "https";
import * as libHttp from "http";
import * as libFs from "fs";
import * as libStream from "stream";
import * as libNet from "net";

const logger = libLog.Logger('server');

export class Server {
	private stopList: ((forceShutdown: boolean) => Promise<void>)[];

	constructor() {
		logger.info(`Server object created`);
		this.stopList = [];
	}

	private respondBadEndpoint(request: libHttp.IncomingMessage, client: libClient.HttpRequest | libClient.HttpUpgrade): void {
		client.respond(`No resource found at [${request.headers.host ?? ''}]:[${client.url.pathname}]`, {
			status: libRequest.Status.NotFound,
			media: libRequest.Media.Text,
			headers: { 'Connection': 'close' }
		});
	}
	private async handleWrapper(wasRequest: boolean, request: libHttp.IncomingMessage, checkHost: libInterface.CheckHost, handler: libInterface.ModuleInterface, port: number, establish: (host: string) => libClient.HttpRequest | libClient.HttpUpgrade): Promise<void> {
		let client = null;
		try {
			/* setup the client object */
			const rawHostName = (request.headers.host ?? '').toLowerCase();
			client = establish(rawHostName);
			client.log(`${wasRequest ? 'Request' : 'Upgrade'}:${port} from [${request.socket.remoteAddress}]:${request.socket.remotePort} to [${request.headers.host}]:[${request.url}] (user-agent: [${request.headers['user-agent'] ?? ''}])`);

			/* extract the host to be used and validate its port */
			const hostNameRegex = rawHostName.match(/^(.*):(\d+)$/);
			let hostName = rawHostName;
			if (hostNameRegex != null) {
				if (parseInt(hostNameRegex[2], 10) != port) {
					client.warning(`Host [${hostName}] port does not match [${port}]`);
					return this.respondBadEndpoint(request, client);
				}
				hostName = hostNameRegex[1];
			}

			if (!checkHost(hostName)) {
				client.warning(`Host [${hostName}] not allowed for this endpoint [${port}]`);
				return this.respondBadEndpoint(request, client);
			}

			/* handle the actual client request */
			if (wasRequest)
				await handler.request(client as libClient.HttpRequest);
			else
				await handler.upgrade(client as libClient.HttpUpgrade);
		} catch (err: any) {
			logger.error(`Uncaught exception encountered for client!${client != null ? client.id : '#'}: ${err.message}`)
			if (client != null)
				client.respondBadInternalUsage();
		}

		/* finish the client handling or consume all remaining data in the pipeline */
		if (client == null)
			request.destroy();
		else try {
			await client.finishIncoming();
		} catch (err: any) {
			logger.error(`Failed to complete client!${client.id}: ${err.message}`);
			client.respondBadInternalUsage();
		}
	}
	private handleRequest(request: libHttp.IncomingMessage, response: libHttp.ServerResponse, check: libInterface.CheckHost, handler: libInterface.ModuleInterface, port: number, secure: boolean): void {
		this.handleWrapper(true, request, check, handler, port, (host: string): libClient.HttpRequest => {
			return new libClient.HttpRequest(request, response, host, (secure ? 'https:' : 'http:'));
		}).catch((err: any) => {
			logger.error(`Fatal error in request handler: ${err.message}`);
			request.destroy(new Error('Unhandled exception'));
		});
	}
	private handleUpgrade(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, check: libInterface.CheckHost, handler: libInterface.ModuleInterface, port: number, secure: boolean): void {
		this.handleWrapper(false, request, check, handler, port, (host: string): libClient.HttpUpgrade => {
			return new libClient.HttpUpgrade(request, socket, head, host, (secure ? 'https:' : 'http:'));
		}).catch((err: any) => {
			logger.error(`Fatal error in upgrade handler: ${err.message}`);
			request.destroy(new Error('Unhandled exception'));
		});
	}
	private applyConfig(server: libHttp.Server | libHttps.Server): void {
		if (libConfig.headerTimeout > 0)
			server.headersTimeout = libConfig.headerTimeout;
		if (libConfig.connectionTimeout > 0)
			server.timeout = libConfig.connectionTimeout;
		if (libConfig.keepAliveTimeout > 0)
			server.keepAliveTimeout = libConfig.keepAliveTimeout;
	}
	private setupListener(server: libHttp.Server | libHttps.Server, port: number, protocol: string, handler: libInterface.ModuleInterface): void {
		/* register the config listener and initialize the configuration */
		const updateTimeouts = () => this.applyConfig(server);
		updateTimeouts();
		libConfig.subscribe(updateTimeouts);

		/* register the stop-function */
		this.stopList.push((forceShutdown: boolean) => new Promise((resolve) => {
			libConfig.unsubscribe(updateTimeouts);
			if (forceShutdown)
				server.closeAllConnections();
			else
				server.closeIdleConnections();
			server.close(() => resolve());
		}));

		/* log the established listener once the port is actually bound */
		server.on('listening', () => {
			const address = server.address() as libNet.AddressInfo;
			logger.info(`${protocol}-server started successfully on [${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.name}]`);
		});
		server.listen(port);
	}

	public listenHttp(port: number, handler: libInterface.ModuleInterface, checkHost: libInterface.CheckHost): void {
		try {
			const server = libHttp.createServer({ requireHostHeader: true }, (req, resp) => this.handleRequest(req, resp, checkHost, handler, port, false));
			server.on('error', (err) => logger.error(`While listening to port ${port} using http: ${err.message}`));
			server.on('upgrade', (req, sock, head) => this.handleUpgrade(req, sock, head, checkHost, handler, port, false));
			this.setupListener(server, port, 'Http', handler);
		} catch (err: any) {
			logger.error(`While listening to port ${port} using http: ${err.message}`);
		}
	}
	public listenHttps(port: number, key: string, cert: string, handler: libInterface.ModuleInterface, checkHost: libInterface.CheckHost): void {
		try {
			const config = {
				requireHostHeader: true,
				key: libFs.readFileSync(key),
				cert: libFs.readFileSync(cert)
			};
			const server = libHttps.createServer(config, (req, resp) => this.handleRequest(req, resp, checkHost, handler, port, true));
			server.on('error', (err) => logger.error(`While listening to port ${port} using https: ${err.message}`));
			server.on('upgrade', (req, sock, head) => this.handleUpgrade(req, sock, head, checkHost, handler, port, true));
			this.setupListener(server, port, 'Https', handler);
		} catch (err: any) {
			logger.error(`While listening to port ${port} using https: ${err.message}`);
		}
	}

	/* force-shutdown kills all currently open and used connections */
	public async stop(forceShutdown: boolean): Promise<void> {
		for (const cb of this.stopList)
			await cb(forceShutdown);
	}
}
