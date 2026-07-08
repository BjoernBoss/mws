/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";
import * as libClient from "./client.js";
import * as libHandler from "./handler.js";
import * as libCache from "./cache.js";
import * as libHelper from "./helper.js";
import * as libHttps from "https";
import * as libHttp from "http";
import * as libNet from "net";
import * as libWs from "ws";
import * as libFs from "fs";
import * as libEvents from "events";
import * as libStream from "stream";

const CONNECTION_TIMEOUT_CHECKING = 10_000;

type ListenerEvents = { 'listening': (address: libNet.AddressInfo | null) => void, 'failed': (err: Error) => void, 'stopped': () => void };

export class Server extends libLog.Logger {
	private _stop: {
		list: (() => Promise<void>)[];
		stoppedResolver: () => void;
		stoppedPromise: Promise<void>;
		stopping: boolean;
	};
	private _cache: libCache.CacheHost;
	private _config: BurntServerConfig;
	private _nextEndpoint: number;

	constructor(config?: ServerConfig) {
		super(config?.name ?? 'server');

		this.info(`Server created`);
		this._config = new BurntServerConfig(config);
		libHelper.logConfiguration(this._config, this);

		if (config?.cache instanceof libCache.CacheHost)
			this._cache = config.cache;
		else
			this._cache = libCache.createCache(config?.cache);
		this._nextEndpoint = 0;

		let stoppedResolver = () => { };
		this._stop = { list: [], stoppedPromise: new Promise<void>((res) => stoppedResolver = res), stoppedResolver: () => { }, stopping: false };
		this._stop.stoppedResolver = stoppedResolver;
	}

	/** listener is automatically stopped when the server is stopped or the handler stops itself */
	public listen(handler: libHandler.ModuleHandler, options?: ListenOptions): Listener {
		return Listener._fromParams(this, handler, ++this._nextEndpoint, this._stop, options ?? {});
	}

	/** shutdown the server and unlink all modules (immediately kills all open connections and listener; can be called multiple times) */
	public stop(): Promise<void> {
		if (this._stop.stopping)
			return this._stop.stoppedPromise;
		this._stop.stopping = true;

		(async () => {
			/* stop all connections and listener */
			this.info('Stopping server connections and modules');
			const promises: Promise<void>[] = [];
			for (const cb of this._stop.list)
				promises.push(cb());
			await Promise.all(promises);

			this.info('Server stopped');
			this._stop.stoppedResolver();
		})();

		return this._stop.stoppedPromise;
	}

	/** cache host used by this server */
	public get cache(): libCache.CacheHost {
		return this._cache;
	}

	/** configuration used by this server */
	public get config(): BurntServerConfig {
		return this._config;
	}

	/** resolves once the server has stopped */
	public get stopped(): Promise<void> {
		return this._stop.stoppedPromise;
	}

	/** check if the server is still running */
	public get running(): boolean {
		return !this._stop.stopping;
	}

	/** link the given module to the server (automatically unlinked upon server stop) */
	public linkModule(module: libHandler.ModuleHandler, unlinked?: () => void): libHandler.AttachedModule {
		const cleanup = (): Promise<void> => attached.unlink();
		this._stop.list.push(cleanup);

		const attached = module._rootAttachToServer(this, () => {
			if (unlinked != null)
				unlinked();
			if (!this._stop.stopping)
				this._stop.list = this._stop.list.filter((v) => v != cleanup);
		});

		return attached;
	}
}

/**
*	Either 'listening' or 'failed' is fired, followed at some point by a 'stopped' event.
*	'address' of 'listening' event is null for serverless listener.
*/
export class Listener {
	private _host: {
		self: Server;
		stop: {
			stopping: boolean;
			list: (() => Promise<void>)[];
		};
	};
	private _self: {
		endpoint: string;
		listening: string | null;
		protocol: string;
	};
	private _stop: {
		stoppedResolver: () => void;
		stoppedPromise: Promise<void>;
		stopping: boolean;
	};
	private _native: {
		server: libHttp.Server | null;
		wss: libWs.WebSocketServer;
		attached: libHandler.AttachedModule;
		cleanup: () => Promise<void>;
	};
	private _handling: {
		count: number;
		promise: Promise<void> | null;
		resolver: () => void;
	};
	private _emitter: libEvents.EventEmitter;
	private _config: libClient.BurntClientConfig;

	private constructor(server: Server, id: number, hostStop: { stopping: boolean, list: (() => Promise<void>)[] }, clientConfig: libClient.BurntClientConfig, handler: libHandler.ModuleHandler) {
		this._host = { self: server, stop: hostStop };
		this._self = { endpoint: `endpoint!${id}`, listening: null, protocol: '' };
		this._emitter = new libEvents.EventEmitter();
		this._handling = { count: 0, promise: null, resolver: () => { } };

		this._config = clientConfig;
		libHelper.logConfiguration(this._config, this._host.self, { prefix: `${this._self.endpoint}.`, ref: this._host.self.config.client });

		let stoppedResolver = () => { };
		this._stop = { stoppedPromise: new Promise<void>((res) => stoppedResolver = res), stoppedResolver: () => { }, stopping: false };
		this._stop.stoppedResolver = stoppedResolver;

		/* register the handler and the cleanup callback */
		const attached = handler._rootAttachToServer(this._host.self, () => this.stop());
		const wss = new libWs.WebSocketServer({ noServer: true });
		this._native = { wss, attached, server: null, cleanup: () => this.stop() };
		this._host.stop.list.push(this._native.cleanup);
	}
	private emitEventSync<K extends keyof ListenerEvents>(event: K, ...args: Parameters<ListenerEvents[K]>): void {
		try {
			this._emitter.emit(event as string, ...args);
		}
		catch (err: any) {
			this._host.self.error(`Unhandled exception in ${event as string} listener: ${err.message}`);
		}
	}
	private performServerListening(address: string | libNet.AddressInfo | null): void {
		if (typeof address == 'string')
			address = { address, port: 0, family: 'unix' };

		if (address == null)
			this._self.listening = 'serverless';
		else
			this._self.listening = `[${address.address}]:${address.port} [family: ${address.family}]`;

		this._host.self.info(`Successfully started ${this._self.endpoint} on ${this._self.listening} with handler [${this._native.attached.module.identity}]`);
		this.emitEventSync('listening', address);
	}
	private async handleClient(request: libHttp.IncomingMessage, client: libClient.ClientRequest): Promise<void> {
		if (this._handling.count++ == 0)
			this._handling.promise = new Promise<void>((res) => this._handling.resolver = res);
		const endpoint = `${this._host.self.identity}.${this._self.endpoint}`;

		/* register the completed log immediately to ensure it is logged as the first thing before the other completed awaits execute */
		client.log(`Connected to [${endpoint}] using [method: ${request.method ?? '_'}] from [${request.socket.remoteAddress}]:${request.socket.remotePort} to [${client.url.hostname}]:[${request.url}] (user-agent: [${request.headers['user-agent'] ?? ''}])`);
		client.completed.then(() => client.log(`Completed on [${endpoint}]`));

		try {
			if (request.httpVersion == '1.0')
				client.respondHttpVersionNotSupported('1.1');
			else
				await this._native.attached.handle(client);
		} catch (err: any) {
			client.respondInternalError(`Uncaught exception: ${err.message}`);
		}

		/* kill the connection on any errors, as the finalizing normally ensures that the response is completed */
		try {
			await client._finalizeConnection();
		} catch (err: any) {
			client.error(`Fatal error while finalizing [${client.identity}]: ${err.message}`);
			request.destroy(new Error('Unhandled exception'));
		}

		if (--this._handling.count == 0) {
			this._handling.promise = null;
			this._handling.resolver();
		}
	}
	private configure(options: ListenOptions): void {
		this._self.protocol = ((options.tls != null || options.server?.secure === true || (options.server == null && options.serverless?.secure === true)) ? 'https' : 'http');
		const who = (options.tls == null && options.server == null && options.serverless != null ? 'serverless' : `${this._self.protocol}|${options.hostname ?? ''}:${options.port ?? 0}`);

		/* defer the failure to allow the caller to attach listeners */
		const performFailure = (err: Error): void => {
			process.nextTick(() => {
				if (!this._stop.stopping)
					this.emitEventSync('failed', err);
				this.stop();
			});
		};
		this._host.self.trace(`Setting up listening to [${who}] and handler [${this._native.attached.module.identity}]`);

		/* check if the server is being stopped, in which case nothing will be listened to */
		if (this._host.stop.stopping) {
			this._host.self.error(`Stopped server cannot listen to [${who}]`);
			return performFailure(new Error('Server already stopped'));
		}

		let server: libHttp.Server | null = null;
		try {
			/* setup the actual server server */
			if (options.tls != null) {
				const config = {
					requireHostHeader: true,
					key: libFs.readFileSync(options.tls.key),
					cert: libFs.readFileSync(options.tls.cert),
					connectionsCheckingInterval: CONNECTION_TIMEOUT_CHECKING
				};
				server = libHttps.createServer(config);
			}
			else if (options.server != null)
				server = options.server.server;
			else if (options.serverless == null)
				server = libHttp.createServer({ requireHostHeader: true, connectionsCheckingInterval: CONNECTION_TIMEOUT_CHECKING });
		} catch (err: any) {
			this._host.self.error(`Error creating server [${who}]: ${err.message}`);
			return performFailure(err);
		}

		/* check if this is a serverless run, in which case the server does not need to be configured further */
		if (server == null)
			return this.performServerListening(null);
		this._native.server = server;

		/* register the corresponding connection handlers and error handlers */
		server.on('request', (req, resp) => this.handleRequest(req, resp));
		server.on('upgrade', (req, sock, head) => this.handleUpgrade(req, sock, head));
		server.once('error', (err) => {
			if (this._stop.stopping) return;
			this._host.self.error(`Error while listening to [${who}]: ${err.message}`);
			this.emitEventSync('failed', err);
			this.stop();
		});
		server.on('listening', () => {
			if (!this._stop.stopping)
				this.performServerListening(server.address());
		});

		/* configure the server to have a minimum header receive timeout, overall connection-loss timeout,
		*	and keep-alive timeout (no request-timeout, as this is handled manually by the throughput control) */
		server.headersTimeout = this._host.self.config.headerTimeout;
		server.timeout = this._host.self.config.connectionTimeout;
		server.keepAliveTimeout = this._host.self.config.keepAliveTimeout;
		server.requestTimeout = 0;

		/* start the actual server listening */
		try {
			server.listen(options.port, options.hostname);
		} catch (err: any) {
			this._host.self.error(`Error starting listener [${who}]: ${err.message}`);
			return performFailure(err);
		}
	}

	public static _fromParams(server: Server, handler: libHandler.ModuleHandler, id: number, hostStop: { stopping: boolean, list: (() => Promise<void>)[] }, options: ListenOptions): Listener {
		const clientConfig = (options.client != null ? libClient.BurntClientConfig.from(options.client) : server.config.client);
		const listener = new Listener(server, id, hostStop, clientConfig, handler);
		listener.configure(options);
		return listener;
	}

	/** manually pass a request through the listener (takes ownership of the request; will kill the connection if the listener is not running anymore) */
	public async handleRequest(request: libHttp.IncomingMessage, response: libHttp.ServerResponse): Promise<void> {
		if (this._stop.stopping) {
			request.destroy(new Error('Listener not running anymore'));
			return;
		}

		const client = libClient.ClientRequest._fromRequest(this._self.protocol, request, response, this._config, this._host.self);
		await this.handleClient(request, client);
	}

	/** manually pass an upgrade through the listener (takes ownership of the connection; immediately closes the connection if the listener is not running anymore) */
	public async handleUpgrade(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer): Promise<void> {
		if (this._stop.stopping) {
			request.destroy(new Error('Listener not running anymore'));
			return;
		}

		const client = libClient.ClientRequest._fromUpgrade(this._self.protocol, request, socket, head, this._config, this._host.self, this._native.wss);
		await this.handleClient(request, client);
	}

	/** server this listener belongs to */
	public get server(): Server {
		return this._host.self;
	}

	/** client configuration used for this listener */
	public get config(): libClient.BurntClientConfig {
		return this._config;
	}

	/** stop the listener and return promise which resolves once fully stopped */
	public stop(): Promise<void> {
		if (this._stop.stopping)
			return this._stop.stoppedPromise;
		this._stop.stopping = true;

		(async () => {
			/* close the server and any existing connections within it */
			let serverStopped: Promise<void> | null = null;
			if (this._native.server != null) {
				serverStopped = new Promise<void>((res) => this._native.server!.close(() => res()));
				this._native.server.closeAllConnections();
			}
			else
				serverStopped = Promise.resolve();

			await this._native.attached.unlink();

			/* close all of the web-sockets (after unlinking the module to
			*	ensure it has a chance to clean the connections itself) */
			const sockets: Promise<void>[] = [];
			for (const ws of [...this._native.wss.clients]) {
				if (ws.readyState == libWs.WebSocket.CLOSED)
					continue;
				sockets.push(new Promise<void>((res) => ws.on('close', () => res())));
				ws.terminate();
			}
			await Promise.all(sockets);

			/* wait for any handled connections to be over and for the server to be fully stopped */
			while (this._handling.promise != null)
				await this._handling.promise;
			await serverStopped;

			if (this._self.listening != null)
				this._host.self.info(`Stopped ${this._self.endpoint} on ${this._self.listening} with handler [${this._native.attached.module.identity}]`);

			/* check if the cleanup can be removed from the stop list (only if stopping is not already in progress) */
			if (!this._host.stop.stopping)
				this._host.stop.list = this._host.stop.list.filter((v) => v != this._native.cleanup);

			this.emitEventSync('stopped');
			this._stop.stoppedResolver();
		})();

		return this._stop.stoppedPromise;
	}

	/** resolves once the server has stopped */
	public get stopped(): Promise<void> {
		return this._stop.stoppedPromise;
	}

	/** check if the server is still running */
	public get running(): boolean {
		return !this._stop.stopping;
	}

	/* -------- event handler interfaces -------- */
	public on<K extends keyof ListenerEvents>(event: K, listener: ListenerEvents[K]): Listener {
		this._emitter.on(event, listener);
		return this;
	}
	public once<K extends keyof ListenerEvents>(event: K, listener: ListenerEvents[K]): Listener {
		this._emitter.once(event, listener);
		return this;
	}
	public off<K extends keyof ListenerEvents>(event: K, listener: ListenerEvents[K]): Listener {
		this._emitter.off(event, listener);
		return this;
	}
}

/** server order: (tls > server > shallow > http.Server) */
export interface ListenOptions {
	/** port to listen on (omit/0 for an OS-assigned port) */
	port?: number;

	/** hostname/interface to bind to (omit to listen on all interfaces) */
	hostname?: string;

	/** client configuration to use for this listener, otherwise the server's is used */
	client?: libClient.ClientConfig | libClient.BurntClientConfig;

	/** tls configuration to be used */
	tls?: { key: string, cert: string };

	/** custom configured server to be used (connectionsCheckingInterval must be configured
	 *	accordingly beforehand; ownership will be taken; secure to encode https compared to http) */
	server?: { server: libHttp.Server, secure: boolean };

	/** create a serverless listener, designed to only be passed connections to */
	serverless?: { secure: boolean };
}

/** wrapper to create a simple server */
export function createServer(config?: ServerConfig): Server {
	return new Server(config);
}

export interface ServerConfig {
	/** logging string used for the server (default: server) */
	name?: string;

	/** default timeout for request headers to be fully received [0 disables the timeout; in milliseconds; Default: 30_000] */
	headerTimeout?: number;

	/** default inactivity timeout — connection is closed if no data is sent or received; resets on any I/O activity, so active transfers are not affected;
	 *	is temporarily cleared by clients, which handle it themselves via throughput [0 disables the timeout; in milliseconds; Default: 90_000] */
	connectionTimeout?: number;

	/** idle time allowed between requests before closing a keep-alive connection [0 falls back to connectionTimeout; in milliseconds; Default: 10_000] */
	keepAliveTimeout?: number;

	/** default client configuration to be used */
	client?: libClient.ClientConfig | libClient.BurntClientConfig;

	/** default cache configuration to be used
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
