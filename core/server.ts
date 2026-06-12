/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";
import * as libClient from "./client.js";
import * as libHandler from "./handler.js";
import * as libCache from "./cache.js";
import * as libHttps from "https";
import * as libHttp from "http";
import * as libNet from "net";
import * as libWs from "ws";
import * as libFs from "fs";
import * as libEvents from "events";

const CONNECTION_TIMEOUT_CHECKING = 10_000;

export class Server extends libLog.Logger {
	private _stop: {
		listener: (() => Promise<void>)[];
		stoppedResolver: () => void;
		stoppedPromise: Promise<void>;
		stopping: boolean;
	};
	private _cache: libCache.CacheHost;
	private _config: BurntServerConfig;
	private _nextId: number;

	constructor(config?: ServerConfig) {
		super('server');

		this.info(`Server created`);
		this._config = new BurntServerConfig(config);
		if (config?.cache instanceof libCache.CacheHost)
			this._cache = config.cache;
		else
			this._cache = libCache.createCache(config?.cache);
		this._nextId = 0;

		let stoppedResolver = () => { };
		this._stop = { listener: [], stoppedPromise: new Promise<void>((res) => stoppedResolver = res), stoppedResolver: () => { }, stopping: false };
		this._stop.stoppedResolver = stoppedResolver;
	}

	private async handleClient(request: libHttp.IncomingMessage, client: libClient.ClientRequest, handler: libHandler.AttachedModule, id: number): Promise<void> {
		this.log(`Listener[${id}]: Client [${client.logIdentity}] connected using [method: ${request.method ?? '_'}] from [${request.socket.remoteAddress}]:${request.socket.remotePort} to [${client.url.hostname}]:[${request.url}] (user-agent: [${request.headers['user-agent'] ?? ''}])`);

		try {
			await handler.handle(client);
		} catch (err: any) {
			client.respondInternalError(`Uncaught exception: ${err.message}`);
		}

		/* kill the connection on any errors, as the finalizing normally ensures that the response is completed */
		try {
			await client.finalizeConnection();
		} catch (err: any) {
			this.error(`Fatal error while finalizing client: ${err.message}`);
			request.destroy(new Error('Unhandled exception'));
		}

		this.log(`Listener[${id}]: Client [${client.logIdentity}] completed`);
	}
	private fetchAddress(server: libHttp.Server): libNet.AddressInfo | null {
		const raw = server.address();
		if (raw == null)
			return null;
		if (typeof raw == 'string')
			return { address: raw, port: 0, family: 'unix' };
		return raw;
	}
	private async performServerCleanup(server: libHttp.Server, id: number | null, who: string, attached: libHandler.AttachedModule, wss: libWs.WebSocketServer): Promise<void> {
		/* close the server and any existing connections within it */
		const address = this.fetchAddress(server);
		if (address != null && id != null)
			this.info(`Stopping ${who} on [${address.address}]:${address.port} [family: ${address.family}] as listener [${id}] with handler [${attached.module.logIdentity}]`);
		const serverStopped = new Promise<void>((res) => server.close(() => res()));
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
	}
	private emitEventSync<T extends Record<string, (...args: any[]) => any>, K extends keyof T>(emitter: libEvents.EventEmitter, event: K, ...args: Parameters<T[K]>): void {
		try {
			emitter.emit(event as string, ...args);
		}
		catch (err: any) {
			this.error(`Unhandled exception in ${event as string} listener: ${err.message}`);
		}
	}
	private makeServer(options?: ListenOptions): libHttp.Server {
		if (options?.tls != null) {
			const config = {
				requireHostHeader: true,
				key: libFs.readFileSync(options.tls.key),
				cert: libFs.readFileSync(options.tls.cert),
				connectionsCheckingInterval: CONNECTION_TIMEOUT_CHECKING
			};
			return libHttps.createServer(config);
		}
		if (options?.server != null)
			return options.server.server;

		return libHttp.createServer({ requireHostHeader: true, connectionsCheckingInterval: CONNECTION_TIMEOUT_CHECKING });
	}

	/* listener is automatically stopped when the server is stopped or the handler stops itself */
	public listen(handler: libHandler.ModuleHandler, options?: ListenOptions): Listener {
		const protocol = ((options?.tls != null || options?.server?.secure === true) ? 'https' : 'http');
		const who = `${protocol}:${options?.hostname ?? ''}:${options?.port ?? 0}`, idListener = this._nextId++;
		const emitter = new libEvents.EventEmitter();

		/* setup the listener interface to be returned */
		let stopping: Promise<void> | null = null, listenLogged = false;
		let server: libHttp.Server | null = null;
		const listener: Listener = {
			on: function (event: string, cb: (...args: any[]) => void) { emitter.on(event, cb); return this; },
			once: function (event: string, cb: (...args: any[]) => void) { emitter.once(event, cb); return this; },
			off: function (event: string, cb: (...args: any[]) => void) { emitter.off(event, cb); return this; },
			stop: () => {
				if (stopping != null)
					return stopping;

				/* already setup the promise to ensure nested stop-calls will already see it set */
				let resolver = () => { };
				stopping = new Promise<void>((res) => resolver = res);

				(async () => {
					if (server != null)
						await this.performServerCleanup(server, (listenLogged ? idListener : null), who, attached, wss);

					/* check if the cleanup can be removed from the stop list (only if stopping is not already in progress) */
					if (!this._stop.stopping)
						this._stop.listener = this._stop.listener.filter((v) => v != listener.stop);

					this.emitEventSync(emitter, 'stopped');
					resolver();
				})();
				return stopping;
			}
		};
		const performFailure = (err: Error) => {
			/* defer the failure to allow the caller to attach listeners */
			process.nextTick(() => {
				if (stopping == null)
					this.emitEventSync(emitter, 'failed', err);
				listener.stop();
			});
		};

		/* check if the server is being stopped, in which case nothing will be listened to */
		if (this._stop.stopping) {
			this.error(`Stopped server cannot listen to ${who}`);
			performFailure(new Error('Server already stopped'));
			return listener;
		}

		/* setup the origin server */
		try {
			server = this.makeServer(options);
		} catch (err: any) {
			this.error(`Error creating server ${who}: ${err.message}`);
			performFailure(err);
			return listener;
		}

		/* register the handler properly and register the cleanup callback */
		const attached = handler._rootAttachToServer(this, () => listener.stop());
		const wss = new libWs.WebSocketServer({ noServer: true });
		this._stop.listener.push(listener.stop);

		/* register the corresponding connection handlers and error handlers */
		const clientConfig = (options?.client != null ? libClient.BurntClientConfig.from(options.client) : this._config.client);
		server.on('request', (req, resp) => {
			const client = libClient.ClientRequest.fromRequest(protocol, req, resp, { cache: this._cache, config: clientConfig });
			this.handleClient(req, client, attached, idListener);
		});
		server.on('upgrade', (req, sock, head) => {
			const client = libClient.ClientRequest.fromUpgrade(protocol, req, sock, head, { cache: this._cache, config: clientConfig, wss });
			this.handleClient(req, client, attached, idListener);
		});
		server.once('error', (err) => {
			if (stopping != null) return;
			this.error(`Error while listening to ${who}: ${err.message}`);
			this.emitEventSync(emitter, 'failed', err);
			listener.stop();
		});
		server.on('listening', () => {
			if (stopping != null) return;
			const address = this.fetchAddress(server)!;
			this.info(`Successfully started ${who} on [${address.address}]:${address.port} [family: ${address.family}] as listener [${idListener}] with handler [${handler.logIdentity}]`);
			listenLogged = true;
			this.emitEventSync(emitter, 'listening', address);
		});

		/* configure the server to have a minimum header receive timeout, overall connection-loss timeout,
		*	and keep-alive timeout (no request-timeout, as this is handled manually by the throughput control) */
		server.headersTimeout = this._config.headerTimeout;
		server.timeout = this._config.connectionTimeout;
		server.keepAliveTimeout = this._config.keepAliveTimeout;
		server.requestTimeout = 0;

		/* start the actual server listening */
		try {
			server.listen(options?.port, options?.hostname);
		} catch (err: any) {
			this.error(`Error starting listener ${who}: ${err.message}`);
			performFailure(err);
		}
		return listener;
	}

	/* shutdown the server and unlink all modules (immediately kills all open connections and listener; can be called multiple times) */
	public async stop(): Promise<void> {
		if (this._stop.stopping)
			return this._stop.stoppedPromise;
		this._stop.stopping = true;

		/* stop all connections and listener */
		this.info('Stopping server connections and modules');
		const promises: Promise<void>[] = [];
		for (const cb of this._stop.listener)
			promises.push(cb());
		await Promise.all(promises);

		this.info('Server stopped');
		this._stop.stoppedResolver();
		return this._stop.stoppedPromise;
	}

	/* cache host used by this server */
	public get cache(): libCache.CacheHost {
		return this._cache;
	}

	/* configuration used by this server */
	public get config(): BurntServerConfig {
		return this._config;
	}

	/* resolves once the server has stopped */
	public get stopped(): Promise<void> {
		return this._stop.stoppedPromise;
	}

	/* check if the server is still running */
	public get running(): boolean {
		return !this._stop.stopping;
	}

	/* link the given module to the server (automatically unlinked upon server stop) */
	public linkModule(module: libHandler.ModuleHandler, unlinked?: () => void): libHandler.AttachedModule {
		const cleanup = (): Promise<void> => attached.unlink();
		this._stop.listener.push(cleanup);

		const attached = module._rootAttachToServer(this, () => {
			if (unlinked != null)
				unlinked();
			if (!this._stop.stopping)
				this._stop.listener = this._stop.listener.filter((v) => v != cleanup);
		});

		return attached;
	}
}

/* either 'listening' or 'failed' is fired, followed at some point by a 'stopped' event */
export interface Listener {
	/* stop the listener and return promise which resolves once fully stopped */
	stop(): Promise<void>;

	/* -------- event handler interfaces -------- */
	on<K extends keyof ListenerEvents>(event: K, listener: ListenerEvents[K]): Listener;
	off<K extends keyof ListenerEvents>(event: K, listener: ListenerEvents[K]): Listener;
	once<K extends keyof ListenerEvents>(event: K, listener: ListenerEvents[K]): Listener;
}
type ListenerEvents = { 'listening': (address: libNet.AddressInfo) => void, 'failed': (err: Error) => void, 'stopped': () => void };

export interface ListenOptions {
	/* port to listen on (omit/0 for an OS-assigned port) */
	port?: number;

	/* hostname/interface to bind to (omit to listen on all interfaces) */
	hostname?: string;

	/* client configuration to use for this listener, otherwise the server's is used */
	client?: libClient.ClientConfig | libClient.BurntClientConfig;

	/* tls configuration to be used */
	tls?: { key: string, cert: string };

	/* custom configured server to be used (connectionsCheckingInterval must be configured
	*	accordingly beforehand; ownership will be taken; secure to encode https compared to http) */
	server?: { server: libHttp.Server, secure: boolean };
}

/* wrapper to create a simple server */
export function createServer(config?: ServerConfig): Server {
	return new Server(config);
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
