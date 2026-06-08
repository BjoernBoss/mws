/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";
import * as libClient from "./client.js";
import * as libHandler from "./handler.js";
import * as libCache from "./cache.js";
import * as libHttps from "https";
import * as libHttp from "http";
import * as libFs from "fs";
import * as libStream from "stream";
import * as libNet from "net";
import * as libWs from "ws";

const CONNECTION_TIMEOUT_CHECKING = 10_000;

export class Server extends libLog.Logger {
	private _stop: {
		listener: (() => Promise<void>)[];
		promise: Promise<void> | null;
	};
	private _cache: libCache.CacheHost;
	private _config: BurntServerConfig;

	constructor(config?: ServerConfig) {
		super('server');

		this.info(`Server created`);
		this._config = new BurntServerConfig(config);
		this._stop = { listener: [], promise: null };
		if (config?.cache instanceof libCache.CacheHost)
			this._cache = config.cache;
		else
			this._cache = libCache.makeCache(config?.cache);
	}

	private async handleWrapper(request: libHttp.IncomingMessage, client: libClient.ClientRequest, handler: libHandler.AttachedModule, who: string): Promise<void> {
		client.log(`${who}: [${request.method ?? '_'}] from [${request.socket.remoteAddress}]:${request.socket.remotePort} to [${client.url.hostname}]:[${request.url}] (user-agent: [${request.headers['user-agent'] ?? ''}])`);

		try {
			await handler.handle(client);
		} catch (err: any) {
			client.respondInternalError(`Uncaught exception: ${err.message}`);
		}

		/* let finalize errors propagate out */
		await client.finalizeConnection();
	}
	private async handleRequest(request: libHttp.IncomingMessage, handler: libHandler.AttachedModule, config: libClient.BurntClientConfig, who: string, protocol: string, response: libHttp.ServerResponse): Promise<void> {
		try {
			const client = libClient.ClientRequest.fromRequest(this._cache, protocol, request, response, { config });
			await this.handleWrapper(request, client, handler, who);
		} catch (err: any) {
			this.error(`Fatal error in request handler: ${err.message}`);
			request.destroy(new Error('Unhandled exception'));
		}
	}
	private async handleUpgrade(request: libHttp.IncomingMessage, handler: libHandler.AttachedModule, config: libClient.BurntClientConfig, who: string, protocol: string, socket: libStream.Duplex, head: Buffer, wss: libWs.WebSocketServer): Promise<void> {
		try {
			const client = libClient.ClientRequest.fromUpgrade(this._cache, protocol, request, socket, head, { config, wss });
			await this.handleWrapper(request, client, handler, who);
		} catch (err: any) {
			this.error(`Fatal error in request handler: ${err.message}`);
			request.destroy(new Error('Unhandled exception'));
		}
	}

	/* listener is automatically stopped when the server is stopped or the handler stops itself */
	public listen(handler: libHandler.ModuleHandler, origin: ListenOrigin, options?: { client?: libClient.ClientConfig | libClient.BurntClientConfig }): Listener {
		const events: Record<string, (() => void)[]> = { failed: [], stopped: [], listening: [] };
		const emit = (event: string) => {
			const list = events[event];
			events[event] = [];
			for (const cb of list) {
				try { cb(); }
				catch (err: any) { this.error(`Unhandled exception in ${event} listener: ${err.message}`); }
			}
		};
		const protocol = (origin.secure ? 'https' : 'http');

		/* setup the listener interface to be returned */
		let stopping: Promise<void> | null = null;
		const listener = {
			on: function (event: 'listening' | 'failed' | 'stopped', cb: () => void) { events[event]?.push(cb); return this; },
			stop: () => {
				if (stopping != null)
					return stopping;

				/* already setup the promise to ensure nested stop-calls will already see it set */
				let resolver = () => { };
				stopping = new Promise<void>((res) => resolver = res);

				performCleanup().then(() => {
					emit('stopped');
					resolver();
				});
				return stopping;
			}
		};
		const performCleanup = async (): Promise<void> => {
			if (server == null)
				return;
			const _server = server;

			/* close the server and any existing connections within it */
			const address = server.address() as libNet.AddressInfo | null;
			if (address != null)
				this.info(`Stopping to listen ${protocol}:[${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.logIdentity}]`);
			const serverStopped = new Promise<void>((res) => _server.close(() => res()));
			server.closeAllConnections();

			/* close all of the web-sockets (after unlinking the module to
			*	ensure it has a chance to clean the connections itself) */
			await attached.unlink();

			const sockets: Promise<void>[] = [];
			for (const ws of [...wss.clients]) {
				if (ws.readyState == libWs.WebSocket.CLOSED)
					continue;
				sockets.push(new Promise<void>((res) => ws.on('close', () => res())));
				ws.terminate();
			}
			await Promise.all(sockets);

			/* await the server being fully stopped */
			await serverStopped;

			/* check if the cleanup can be removed from the stop list (only if stopping is not already in progress) */
			if (this._stop.promise == null)
				this._stop.listener = this._stop.listener.filter((v) => v != listener.stop);
		};
		const performFailure = () => {
			/* defer the failure to allow the caller to attach listeners */
			process.nextTick(() => {
				if (stopping == null)
					emit('failed');
				listener.stop();
			});
		};

		/* setup the origin server */
		let server: libHttp.Server | null = null;
		try {
			server = origin.server();
		} catch (err: any) {
			this.error(`Error starting listener ${protocol}:${origin.who}: ${err.message}`);
			performFailure();
			return listener;
		}
		const attached = handler._attachToRoot(() => listener.stop());
		const wss = new libWs.WebSocketServer({ noServer: true });

		/* register the corresponding connection handlers */
		const clientConfig = (options?.client != null ? libClient.BurntClientConfig.from(options.client) : this._config.client);
		server.on('request', (req, resp) => this.handleRequest(req, attached, clientConfig, origin.who, protocol, resp));
		server.on('upgrade', (req, sock, head) => this.handleUpgrade(req, attached, clientConfig, origin.who, protocol, sock, head, wss));

		/* configure the server to have a minimum header receive timeout, overall connection-loss timeout,
		*	and keep-alive timeout (no request-timeout, as this is handled manually by the throughput control) */
		server.headersTimeout = this._config.headerTimeout;
		server.timeout = this._config.connectionTimeout;
		server.keepAliveTimeout = this._config.keepAliveTimeout;
		server.requestTimeout = 0;

		/* register the start and error callbacks (reset the server again if the listening failed) */
		server.once('error', (err) => {
			if (stopping != null) return;
			this.error(`Error while listening to ${protocol}:${origin.who}: ${err.message}`);
			emit('failed');
			listener.stop();
		});
		server.on('listening', () => {
			if (stopping != null) return;
			const address = server!.address() as libNet.AddressInfo;
			this.info(`Started successfully on ${protocol}:[${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.logIdentity}]`);
			emit('listening');
		});

		/* start the actual server listening */
		try {
			origin.start(server);
		} catch (err: any) {
			this.error(`Error starting listener ${protocol}:${origin.who}: ${err.message}`);
			performFailure();
		}
		return listener;
	}

	/* shutdown the server and unlink all modules (immediately kills all open connections and listener; can be called multiple times) */
	public async stop(): Promise<void> {
		if (this._stop.promise != null)
			return this._stop.promise;

		/* setup the promise beforehand to ensure the promise body does not recursively
		*	enter this handler again, and sees the stopping object still being unset */
		let resolver = () => { };
		this._stop.promise = new Promise<void>((res) => resolver = res);

		/* stop all connections and listener */
		this.info('Stopping server connections and modules');
		const promises: Promise<void>[] = [];
		for (const cb of this._stop.listener)
			promises.push(cb());

		/* await the stopping of all listened connections */
		await Promise.all(promises);
		this.info('Server stopped');
		resolver();

		return this._stop.promise;
	}

	/* cache host used by this server */
	public get cache(): libCache.CacheHost {
		return this._cache;
	}

	/* configuration used by this server */
	public get config(): BurntServerConfig {
		return this._config;
	}
}

export interface Listener {
	/* each event fires at most once; a listener always ends with a 'stopped' event */
	on(event: 'listening' | 'failed' | 'stopped', cb: () => void): this;

	/* stop the listener and return promise which resolves once fully stopped */
	stop(): Promise<void>;
}

export interface ListenOrigin {
	/* create the underlying server (must not start listening yet; server will be
	*	configured automatically; connection timeout checking should be reasonable) */
	server(): libHttp.Server;

	/* start the server listening (called after event handlers have been registered) */
	start(server: libHttp.Server): void;

	/* logging description of the listener */
	who: string;

	/* protocol protection (either https or http) */
	secure: boolean;
}

/* wrapper to create a simple server */
export function createServer(): Server {
	return new Server();
}

/* create a listen-origin for a plain HTTP server */
export function http(port: number, options?: { hostname?: string }): ListenOrigin {
	return {
		server: () => libHttp.createServer({
			requireHostHeader: true,
			connectionsCheckingInterval: CONNECTION_TIMEOUT_CHECKING
		}),
		start: (server) => server.listen(port, options?.hostname),
		who: `${options?.hostname ?? ''}:${port}`,
		secure: false
	};
}

/* create a listen-origin for an HTTPS server */
export function https(port: number, options: { key: string; cert: string; hostname?: string }): ListenOrigin {
	return {
		server: () => libHttps.createServer({
			requireHostHeader: true,
			key: libFs.readFileSync(options.key),
			cert: libFs.readFileSync(options.cert),
			connectionsCheckingInterval: CONNECTION_TIMEOUT_CHECKING
		}),
		start: (server) => server.listen(port, options.hostname),
		who: `${options.hostname ?? ''}:${port}`,
		secure: true
	};
}

/* wrap an existing http.Server; caller must trigger listen manually;
*	connectionsCheckingInterval must be configured on the server beforehand */
export function wrap(existing: libHttp.Server, who: string, secure: boolean): ListenOrigin {
	return {
		server: () => existing,
		start: () => { },
		who,
		secure
	};
}

export interface ServerConfig {
	/* default timeout for request headers to be fully received [0 disables the timeout; in milliseconds; Default: 30_000] */
	headerTimeout?: number;

	/* default inactivity timeout — connection is closed if no data is sent or received; resets on any I/O activity, so active transfers are not affected; 
	*	is temporarily cleared by clients, which handle it themselves via throughput [0 disables the timeout; in milliseconds; Default: 90_000] */
	connectionTimeout?: number;

	/* idle time allowed between requests before closing a keep-alive connection [0 falls back to connectionTimeout; in milliseconds; Default: 10_000] */
	keepAliveTimeout?: number;

	/* default client configuration to be used */
	client?: libClient.ClientConfig | libClient.BurntClientConfig;

	/* default cache configuration to be used
	*	Important: cache host should be shared where possible as otherwise multiple unshared caches could exist and immutable ids might overwrite each other */
	cache?: libCache.CacheHost | libCache.CacheConfig | libCache.BurntCacheConfig;
}

export class BurntServerConfig {
	public readonly headerTimeout: number;
	public readonly connectionTimeout: number;
	public readonly keepAliveTimeout: number;
	public readonly client: libClient.BurntClientConfig;

	public constructor(config?: ServerConfig) {
		this.headerTimeout = config?.headerTimeout ?? 30_000;
		this.connectionTimeout = config?.connectionTimeout ?? 90_000;
		this.keepAliveTimeout = config?.keepAliveTimeout ?? 10_000;
		this.client = libClient.BurntClientConfig.from(config?.client);
	}
}
