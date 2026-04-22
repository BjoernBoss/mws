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
	private stopList: (() => Promise<void>)[];

	constructor() {
		logger.info(`Server object created`);
		this.stopList = [];
	}

	private respondBadEndpoint(request: libHttp.IncomingMessage, client: libClient.HttpRequest | libClient.HttpUpgrade): void {
		client.addHeader('Connection', 'close');
		client.respondAnyText(`No resource found at [${request.headers.host ?? ''}]:[${client.url.pathname}]`, { status: libRequest.Status.NotFound, media: libRequest.Media.Text });
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
			logger.error(`Uncaught exception encountered for client [${client != null ? client.id : null}]: ${err}`)
			if (client != null)
				client.respondInternalError('Unknown internal error encountered');
		}

		/* finish the client handling or consume all remaining data in the pipline */
		if (client == null)
			request.destroy();
		else
			client.finishIncoming().catch((err: any) => logger.error(`Failed to complete client [${client!.id}]: ${err}`));
	}
	private handleRequest(request: libHttp.IncomingMessage, response: libHttp.ServerResponse, check: libInterface.CheckHost, handler: libInterface.ModuleInterface, port: number, secure: boolean): void {
		this.handleWrapper(true, request, check, handler, port, function (host: string): libClient.HttpRequest {
			return new libClient.HttpRequest(request, response, host, (secure ? 'https:' : 'http:'));
		});
	}
	private handleUpgrade(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, check: libInterface.CheckHost, handler: libInterface.ModuleInterface, port: number, secure: boolean): void {
		this.handleWrapper(false, request, check, handler, port, function (host: string): libClient.HttpUpgrade {
			return new libClient.HttpUpgrade(request, socket, head, host, (secure ? 'https:' : 'http:'));
		});
	}
	private applyConfig(server: libHttp.Server | libHttps.Server): void {
		if (libConfig.requestTimeout > 0)
			server.requestTimeout = libConfig.requestTimeout;
		if (libConfig.responseTimeout > 0)
			server.timeout = libConfig.responseTimeout;
		if (libConfig.keepAliveTimeout > 0)
			server.keepAliveTimeout = libConfig.keepAliveTimeout;
	}

	public listenHttp(port: number, handler: libInterface.ModuleInterface, checkHost: libInterface.CheckHost): void {
		try {
			/* initialize the server config */
			const config = {
				requireHostHeader: true
			};

			/* start the actual server */
			const server = libHttp.createServer(config, (req, resp) => this.handleRequest(req, resp, checkHost, handler, port, false)).listen(port);
			server.on('error', (err) => logger.error(`While listening to port ${port} using http: ${err}`));
			server.on('upgrade', (req, sock, head) => this.handleUpgrade(req, sock, head, checkHost, handler, port, false));
			if (!server.listening)
				return;

			/* register the config listener and initialize the configuration */
			const updateTimeouts = () => this.applyConfig(server);
			updateTimeouts();
			libConfig.subscribe(updateTimeouts);

			/* register the stop-function */
			this.stopList.push(() => new Promise((resolve) => {
				libConfig.unsubscribe(updateTimeouts);
				server.close(() => resolve());
			}));

			/* log the established listener */
			const address = server.address() as libNet.AddressInfo;
			logger.info(`Http-server started successfully on [${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.name}]`);
		} catch (err: any) {
			logger.error(`While listening to port ${port} using http: ${err}`);
		}
	}
	public listenHttps(port: number, key: string, cert: string, handler: libInterface.ModuleInterface, checkHost: libInterface.CheckHost): void {
		try {
			/* initialize the server config and load the key and certificate */
			const config = {
				requireHostHeader: true,
				key: libFs.readFileSync(key),
				cert: libFs.readFileSync(cert)
			};

			/* start the actual server */
			const server = libHttps.createServer(config, (req, resp) => this.handleRequest(req, resp, checkHost, handler, port, true)).listen(port);
			server.on('error', (err) => logger.error(`While listening to port ${port} using https: ${err}`));
			server.on('upgrade', (req, sock, head) => this.handleUpgrade(req, sock, head, checkHost, handler, port, true));
			if (!server.listening)
				return;

			/* register the config listener and initialize the configuration */
			const updateTimeouts = () => this.applyConfig(server);
			updateTimeouts();
			libConfig.subscribe(updateTimeouts);

			/* register the stop-function */
			this.stopList.push(() => new Promise((resolve) => {
				libConfig.unsubscribe(updateTimeouts);
				server.close(() => resolve());
			}));

			/* log the established listener */
			const address = server.address() as libNet.AddressInfo;
			logger.info(`Https-server started successfully on [${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.name}]`);
		} catch (err: any) {
			logger.error(`While listening to port ${port} using https: ${err}`);
		}
	}
	public async stop(): Promise<void> {
		for (const cb of this.stopList)
			await cb();
	}
}
