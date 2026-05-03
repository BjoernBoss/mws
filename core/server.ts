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
import * as libWs from "ws";

const logger = libLog.Logger('server');

const DEFAULT_SERVER_TIMEOUT_CHECK: number = 10_000;

export class Server {
	private serverStopList: (() => Promise<void>)[];
	private moduleStopList: (() => Promise<void>)[];
	private wss: libWs.WebSocketServer;

	constructor() {
		logger.info(`Server object created`);
		this.serverStopList = [];
		this.moduleStopList = [];
		this.wss = new libWs.WebSocketServer({ noServer: true });
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
			return new libClient.HttpUpgrade(request, socket, head, host, (secure ? 'https:' : 'http:'), this.wss);
		}).catch((err: any) => {
			logger.error(`Fatal error in upgrade handler: ${err.message}`);
			request.destroy(new Error('Unhandled exception'));
		});
	}
	private applyConfig(server: libHttp.Server | libHttps.Server): void {
		/* configure the server to have a minimum header receive timeout, overall connection-loss timeout,
		*	and keep-alive timeout (no request-timeout, as this is handled manually by the throughput control) */
		server.headersTimeout = libConfig.headerTimeout;
		server.requestTimeout = 0;
		server.timeout = libConfig.connectionTimeout;
		server.keepAliveTimeout = libConfig.keepAliveTimeout;
	}
	private setupListener(server: libHttp.Server | libHttps.Server, port: number, protocol: string, handler: libInterface.ModuleInterface): void {
		/* register the config listener and initialize the configuration */
		const updateTimeouts = () => this.applyConfig(server);
		updateTimeouts();
		libConfig.subscribe(updateTimeouts);

		/* register the stop-function for the server and the module */
		this.serverStopList.push(() => new Promise((resolve) => {
			libConfig.unsubscribe(updateTimeouts);
			server.close(() => resolve());
			server.closeAllConnections();
		}));
		this.moduleStopList.push(() => handler.stop());

		/* log the established listener once the port is actually bound */
		server.on('listening', () => {
			const address = server.address() as libNet.AddressInfo;
			logger.info(`${protocol}-server started successfully on [${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.name}]`);
		});
		server.listen(port);
	}

	public listenHttp(port: number, handler: libInterface.ModuleInterface, checkHost: libInterface.CheckHost): void {
		try {
			const config = {
				requireHostHeader: true,
				connectionsCheckingInterval: DEFAULT_SERVER_TIMEOUT_CHECK
			};
			const server = libHttp.createServer(config, (req, resp) => this.handleRequest(req, resp, checkHost, handler, port, false));
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
				cert: libFs.readFileSync(cert),
				connectionsCheckingInterval: DEFAULT_SERVER_TIMEOUT_CHECK
			};
			const server = libHttps.createServer(config, (req, resp) => this.handleRequest(req, resp, checkHost, handler, port, true));
			server.on('error', (err) => logger.error(`While listening to port ${port} using https: ${err.message}`));
			server.on('upgrade', (req, sock, head) => this.handleUpgrade(req, sock, head, checkHost, handler, port, true));
			this.setupListener(server, port, 'Https', handler);
		} catch (err: any) {
			logger.error(`While listening to port ${port} using https: ${err.message}`);
		}
	}

	/* shutdown the server and all modules (immediately kills all open connections and listener, can be called multiple times) */
	public async stop(): Promise<void> {
		let list: Promise<void>[] = [];

		/* kill all open connections (also stops new incoming connections) and kill all web-sockets (after the sockets have been stopped
		*	to ensure no new sockets connect; duplicate the sockets to ensure the iteration order is not broken due to in-place removal) */
		for (const cb of this.serverStopList)
			list.push(cb());
		for (const ws of [...this.wss.clients]) {
			list.push(new Promise<void>((resolve) => ws.on('close', () => resolve())));
			ws.terminate();
		}
		logger.info('Stopping server and websocket connections');
		await Promise.all(list);

		/* kill all modules (after the connections to ensure
		*	no state change occurs in the modules anymore) */
		logger.info('Stopping all modules');
		list = [];
		for (const cb of this.moduleStopList)
			list.push(cb());
		await Promise.all(list);
	}
}
