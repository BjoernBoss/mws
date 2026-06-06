/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";
import * as libClient from "./client.js";
import * as libBase from "./base.js";
import * as libHandler from "./handler.js";
import * as libCache from "./cache.js";
import * as libHttps from "https";
import * as libHttp from "http";
import * as libFs from "fs";
import * as libStream from "stream";
import * as libNet from "net";
import * as libWs from "ws";

/*
*	Validate the host passed in via the http-parameter.
*	Host string will be '_' for no or empty host-parameter.
*	Host strings optional port will have been verified and dropped.
*		=> Will only contain the lower-case host name.
*/
export type CheckHost = (host: string) => boolean;

export class Server extends libLog.LogIdentity {
	private _stop: {
		listener: (() => [Promise<void>, Promise<void>])[];
		promise: Promise<void> | null;
	};
	private _wss: libWs.WebSocketServer;
	private _cacheHost: libCache.CacheHost;
	private _config: BurntServerConfig;
	private _clientConfig: libClient.BurntClientConfig;

	constructor(config: SystemConfig) {
		super('server');

		this.info(`Server created`);
		this._config = BurnServerConfig(config);
		this._stop = { listener: [], promise: null };
		this._wss = new libWs.WebSocketServer({ noServer: true });
		this._cacheHost = new libCache.CacheHost(libCache.BurnCacheConfig(config));
		this._clientConfig = libClient.BurnClientConfig(config);
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
				this.error(`Uncaught exception: ${err.message}`)
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
			return libClient.ClientRequest._fromRequest(this._cacheHost, this._clientConfig, host, protocol, request, response);
		}).catch((err: any) => {
			this.error(`Fatal error in request handler: ${err.message}`);
			request.destroy(new Error('Unhandled exception'));
		});
	}
	private handleUpgrade(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, check: CheckHost, handler: libHandler.AttachedModule, port: number, protocol: string): void {
		this.handleWrapper(false, request, check, handler, port, (host: string): libClient.ClientRequest => {
			return libClient.ClientRequest._fromUpgrade(this._cacheHost, this._clientConfig, host, protocol, request, socket, head, this._wss);
		}).catch((err: any) => {
			this.error(`Fatal error in upgrade handler: ${err.message}`);
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

				/* configure the server to have a minimum header receive timeout, overall connection-loss timeout,
				*	and keep-alive timeout (no request-timeout, as this is handled manually by the throughput control) */
				server.headersTimeout = this._config.headerTimeout;
				server.timeout = this._config.connectionTimeout;
				server.keepAliveTimeout = this._config.keepAliveTimeout;
				server.requestTimeout = 0;

				/* register the stop functions (server can be stopped via the global server-stop or the handler being stopped) */
				let serverStopPromise: Promise<void> | null = null;
				const triggerListenStop: () => [Promise<void>, Promise<void>] = () => {
					if (serverStopPromise == null) {
						let resolver = () => { };
						serverStopPromise = new Promise((res) => resolver = res);

						const address = server.address() as libNet.AddressInfo | null;
						if (address != null)
							this.info(`Server stopping to listen ${protocol}[${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.moduleName}]`);

						server.close(() => {
							resolver();
							listenComplete();
						});
						server.closeAllConnections();
					}
					return [serverStopPromise, attached.unlink()];
				};
				this._stop.listener.push(triggerListenStop);

				/* setup the actual unlink function to perform the proper cleanup */
				unlinked.cb = async () => {
					if (this._stop.promise != null) return;

					const [module, handler] = triggerListenStop();
					await Promise.all([module, handler]);

					if (this._stop.promise == null)
						this._stop.listener = this._stop.listener.filter((v) => v != triggerListenStop);
				};

				/* reigster the start and error callbacks (reset the server again if the listening failed) */
				server.once('error', (err) => {
					this.error(`Error while listening to ${protocol}${port}: ${err.message}`);
					unlinked.cb();
				});
				server.on('listening', () => {
					if (serverStopPromise != null) return;
					const address = server.address() as libNet.AddressInfo;
					this.info(`Server started successfully on ${protocol}[${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.moduleName}]`);
				});

				/* start the actual serer */
				server.listen(port);
			} catch (err: any) {
				this.error(`Error starting listening server ${protocol}${port}: ${err.message}`);
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
				connectionsCheckingInterval: this._config.timeoutChecking
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
				connectionsCheckingInterval: this._config.timeoutChecking
			};

			return libHttps.createServer(config, listener);
		});
	}

	/* shutdown the server and all modules (immediately kills all open connections and listener, can be called multiple times) */
	public async stop(): Promise<void> {
		if (this._stop.promise != null)
			return this._stop.promise;

		/* setup the promise beforehand to ensure the promise body does not recursively
		*	enter this handler again, and sees the stopping object still being unset */
		let resolver = () => { };
		this._stop.promise = new Promise<void>((res) => resolver = res);

		(async () => {
			/* stop all servers to prevent new connections from coming in, close any in-progress connections, and start destroying the modules */
			this.info('Stopping server connections and modules');
			let promises: Promise<void>[] = [], modules: Promise<void>[] = [];
			for (const cb of this._stop.listener) {
				const [server, module] = cb();
				promises.push(server);
				modules.push(module);
			}

			/* only await the module destruction, as the server first resolves once all its connections have been closed */
			await Promise.all(modules);

			/* destroy any remaining web-sockets (to give the modules the chance to clean them up) and await the full termination */
			this.info('Stopping all websockets');
			for (const ws of [...this._wss.clients]) {
				if (ws.readyState == libWs.WebSocket.CLOSED)
					continue;
				promises.push(new Promise<void>((resolve) => ws.on('close', () => resolve())));
				ws.terminate();
			}
			await Promise.all(promises);

			this.info('Server stopped');
			resolver();
		})();

		return this._stop.promise;
	}

	/* cache host used by this server */
	public get cache(): libCache.CacheHost {
		return this._cacheHost;
	}
}

export interface ServerConfig {
	/* default timeout for request headers to be fully received [0 disables the timeout; in milliseconds; Default: 30_000] */
	headerTimeout?: number;

	/* default inactivity timeout — connection is closed if no data is sent or received; resets on any I/O activity,
	*	so active transfers are not affected [0 disables the timeout; in milliseconds; Default: 90_000] */
	connectionTimeout?: number;

	/* idle time allowed between requests before closing a keep-alive connection [0 falls back to connectionTimeout; in milliseconds; Default: 10_000] */
	keepAliveTimeout?: number;

	/* default interval to check if other timeouts have timed out [in milliseconds, Defaults: 10_000] */
	timeoutChecking?: number;
}
export interface BurntServerConfig {
	headerTimeout: number;
	connectionTimeout: number;
	keepAliveTimeout: number;
	timeoutChecking: number;
}
export function BurnServerConfig(config: ServerConfig): BurntServerConfig {
	return {
		headerTimeout: config.headerTimeout ?? 30_000,
		connectionTimeout: config.connectionTimeout ?? 90_000,
		keepAliveTimeout: config.keepAliveTimeout ?? 10_000,
		timeoutChecking: config.timeoutChecking ?? 10_000
	};
}

export type SystemConfig = ServerConfig & libClient.ClientConfig & libCache.CacheConfig;
