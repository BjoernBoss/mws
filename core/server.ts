/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import { Config as libConfig } from "./config.js";
import * as libLog from "./log.js";
import * as libClient from "./client.js";
import * as libBase from "./base.js";
import * as libHandler from "./handler.js";
import * as libHttps from "https";
import * as libHttp from "http";
import * as libFs from "fs";
import * as libStream from "stream";
import * as libNet from "net";
import * as libWs from "ws";

const logger = libLog.Logger('server');

const DEFAULT_SERVER_TIMEOUT_CHECK: number = 10_000;

/*
*	Validate the host passed in via the http-parameter.
*	Host string will be '_' for no or empty host-parameter.
*	Host strings optional port will have been verified and dropped.
*		=> Will only contain the lower-case host name.
*/
export type CheckHost = (host: string) => boolean;

export class Server {
	private stopListener: (() => [Promise<void>, Promise<void>])[];
	private wss: libWs.WebSocketServer;
	private stopping: Promise<void> | null;

	constructor() {
		logger.info(`Server created`);
		this.stopListener = [];
		this.wss = new libWs.WebSocketServer({ noServer: true });
		this.stopping = null;
	}

	private respondBadEndpoint(request: libHttp.IncomingMessage, client: libClient.ClientRequest): void {
		client.respond(`No resource found at [${request.headers.host ?? ''}]:[${client.url.pathname}]`, {
			status: libBase.Status.NotFound,
			media: libBase.Media.Text,
			headers: { 'Connection': 'close' }
		});
	}
	private async handleWrapper(wasRequest: boolean, request: libHttp.IncomingMessage, checkHost: CheckHost, handler: libHandler.AttachedModule, port: number, establish: (host: string) => libClient.ClientRequest): Promise<void> {
		let client = null;
		try {
			/* setup the client object */
			const rawHostName = (request.headers.host ?? '').toLowerCase();
			client = establish(rawHostName);
			client.log(`${wasRequest ? 'Request' : 'Upgrade'}:${port} [${request.method ?? '_'}] from [${request.socket.remoteAddress}]:${request.socket.remotePort} to [${request.headers.host}]:[${request.url}] (user-agent: [${request.headers['user-agent'] ?? ''}])`);

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

			hostName = (hostName.length == 0 ? '_' : hostName);
			if (!checkHost(hostName)) {
				client.warning(`Host [${hostName}] not allowed for this endpoint [${port}]`);
				return this.respondBadEndpoint(request, client);
			}

			/* handle the actual client request */
			await handler.handle(client);
		} catch (err: any) {
			if (client != null)
				client.respondInternalError(`Uncaught exception: ${err.message}`);
			else
				logger.error(`Uncaught exception: ${err.message}`)
		}

		/* finish the client handling or consume all remaining data in the pipeline */
		if (client == null)
			request.destroy();
		else try {
			await client._finishConnection();
		} catch (err: any) {
			client.respondInternalError(`Failed to complete connection: ${err.message}`);
		}
	}
	private handleRequest(request: libHttp.IncomingMessage, response: libHttp.ServerResponse, check: CheckHost, handler: libHandler.AttachedModule, port: number, protocol: string): void {
		this.handleWrapper(true, request, check, handler, port, (host: string): libClient.ClientRequest => {
			return libClient.ClientRequest._fromRequest(request, host, protocol, response);
		}).catch((err: any) => {
			logger.error(`Fatal error in request handler: ${err.message}`);
			request.destroy(new Error('Unhandled exception'));
		});
	}
	private handleUpgrade(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, check: CheckHost, handler: libHandler.AttachedModule, port: number, protocol: string): void {
		this.handleWrapper(false, request, check, handler, port, (host: string): libClient.ClientRequest => {
			return libClient.ClientRequest._fromUpgrade(request, host, protocol, socket, head, this.wss);
		}).catch((err: any) => {
			logger.error(`Fatal error in upgrade handler: ${err.message}`);
			request.destroy(new Error('Unhandled exception'));
		});
	}
	private startServerListener(port: number, secure: boolean, handler: libHandler.ModuleHandler, checkHost: CheckHost, createServer: (listener: (req: libHttp.IncomingMessage, resp: libHttp.ServerResponse) => void) => libHttp.Server): Promise<void> {
		return new Promise<void>((listenComplete) => {
			const protocol = (secure ? 'https:' : 'http:');

			/* initialize the unlink to just resolve the promise, later-on, it will be replaced to guarantee proper cleanup */
			const unlinked = { cb: () => listenComplete() };
			try {
				const attached = handler._attachToRoot(() => unlinked.cb());

				/* create the actual server and register the corresponding connection handlers */
				const server = createServer((req, resp) => this.handleRequest(req, resp, checkHost, attached, port, protocol));
				server.on('upgrade', (req, sock, head) => this.handleUpgrade(req, sock, head, checkHost, attached, port, protocol));

				/* configure the server to have a minimum header receive timeout, overall connection-loss
				*	timeout, and keep-alive timeout (no request-timeout, as this is handled manually by the
				*	throughput control) and register the config listener and apply the initial configuration */
				const updateTimeouts = () => {
					server.headersTimeout = libConfig.headerTimeout;
					server.requestTimeout = 0;
					server.timeout = libConfig.connectionTimeout;
					server.keepAliveTimeout = libConfig.keepAliveTimeout;
				};
				updateTimeouts();
				libConfig.subscribe(updateTimeouts);

				/* register the stop functions (server can be stopped via the global server-stop or the handler being stopped) */
				let serverStopPromise: Promise<void> | null = null;
				const triggerListenStop: () => [Promise<void>, Promise<void>] = () => {
					if (serverStopPromise == null) {
						let resolver = () => { };
						serverStopPromise = new Promise((res) => resolver = res);

						const address = server.address() as libNet.AddressInfo | null;
						if (address != null)
							logger.info(`Server stopping to listen ${protocol}[${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.moduleName}]`);

						libConfig.unsubscribe(updateTimeouts);
						server.close(() => {
							resolver();
							listenComplete();
						});
						server.closeAllConnections();
					}
					return [serverStopPromise, attached.unlink()];
				};
				this.stopListener.push(triggerListenStop);

				/* setup the actual unlink function to perform the proper cleanup */
				unlinked.cb = async () => {
					if (this.stopping != null) return;

					const [module, handler] = triggerListenStop();
					await Promise.all([module, handler]);

					if (this.stopping == null)
						this.stopListener = this.stopListener.filter((v) => v != triggerListenStop);
				};

				/* reigster the start and error callbacks (reset the server again if the listening failed) */
				server.once('error', (err) => {
					logger.error(`Error while listening to ${protocol}${port}: ${err.message}`);
					unlinked.cb();
				});
				server.on('listening', () => {
					if (serverStopPromise != null) return;
					const address = server.address() as libNet.AddressInfo;
					logger.info(`Server started successfully on ${protocol}[${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.moduleName}]`);
				});

				/* start the actual serer */
				server.listen(port);
			} catch (err: any) {
				logger.error(`Error starting listening server ${protocol}${port}: ${err.message}`);
				unlinked.cb();
			}
		});
	}

	/* listener entry will automatically be stopped once the server is stopped or the handler (returned promise resolves once the listener has been closed) */
	public listenHttp(port: number, handler: libHandler.ModuleHandler, checkHost: CheckHost): Promise<void> {
		return this.startServerListener(port, false, handler, checkHost, (listener) => {
			/* setup the config inside as the start listener catches any exceptions */
			const config = {
				requireHostHeader: true,
				connectionsCheckingInterval: DEFAULT_SERVER_TIMEOUT_CHECK
			};

			return libHttp.createServer(config, listener);
		});
	}

	/* listener entry will automatically be stopped once the server is stopped or the handler (returned promise resolves once the listener has been closed) */
	public listenHttps(port: number, key: string, cert: string, handler: libHandler.ModuleHandler, checkHost: CheckHost): Promise<void> {
		return this.startServerListener(port, true, handler, checkHost, (listener) => {
			/* setup the config inside as the start listener catches any exceptions */
			const config = {
				requireHostHeader: true,
				key: libFs.readFileSync(key),
				cert: libFs.readFileSync(cert),
				connectionsCheckingInterval: DEFAULT_SERVER_TIMEOUT_CHECK
			};

			return libHttps.createServer(config, listener);
		});
	}

	/* shutdown the server and all modules (immediately kills all open connections and listener, can be called multiple times) */
	public async stop(): Promise<void> {
		if (this.stopping != null)
			return this.stopping;

		/* setup the promise beforehand to ensure the promise body does not recursively
		*	enter this handler again, and sees the stopping object still being unset */
		let resolver = () => { };
		this.stopping = new Promise<void>((res) => resolver = res);

		(async () => {
			/* stop all servers to prevent new connections from coming in, close any in-progress connections, and start destroying the modules */
			logger.info('Stopping server connections and modules');
			let promises: Promise<void>[] = [], modules: Promise<void>[] = [];
			for (const cb of this.stopListener) {
				const [server, module] = cb();
				promises.push(server);
				modules.push(module);
			}

			/* only await the module destruction, as the server first resolves once all its connections have been closed */
			await Promise.all(modules);

			/* destroy any remaining web-sockets (to give the modules the chance to clean them up) and await the full termination */
			logger.info('Stopping all websockets');
			for (const ws of [...this.wss.clients]) {
				if (ws.readyState == libWs.WebSocket.CLOSED)
					continue;
				promises.push(new Promise<void>((resolve) => ws.on('close', () => resolve())));
				ws.terminate();
			}
			await Promise.all(promises);

			logger.info('Server stopped');
			resolver();
		})();

		return this.stopping;
	}
}
