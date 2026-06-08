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

export interface Listener {
	/* returns promise which resolves once stopped, or null if already stopped */
	stopped(): Promise<void> | null;

	/* stop the listener and return promsie which resolves once fully stopped */
	stop(): Promise<void>;
}

export class Server extends libLog.Logger {
	private _stop: {
		listener: (() => Promise<void>)[];
		promise: Promise<void> | null;
	};
	private _cacheHost: libCache.CacheHost;
	private _config: BurntServerConfig;
	private _clientConfig: libClient.BurntClientConfig;

	constructor(config?: SystemConfig) {
		super('server');

		this.info(`Server created`);
		this._config = BurnServerConfig(config ?? {});
		this._clientConfig = libClient.BurnClientConfig(config ?? {});
		this._stop = { listener: [], promise: null };
		this._cacheHost = (config?.cache ?? new libCache.CacheHost(libCache.BurnCacheConfig(config ?? {})));
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
	private async handleRequest(request: libHttp.IncomingMessage, response: libHttp.ServerResponse, handler: libHandler.AttachedModule, who: string, protocol: string): Promise<void> {
		try {
			const client = libClient.ClientRequest.fromRequest(this._cacheHost, protocol, request, response, { burntConfig: this._clientConfig });
			await this.handleWrapper(request, client, handler, who);
		} catch (err: any) {
			this.error(`Fatal error in request handler: ${err.message}`);
			request.destroy(new Error('Unhandled exception'));
		}
	}
	private async handleUpgrade(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, handler: libHandler.AttachedModule, who: string, protocol: string, wss: libWs.WebSocketServer): Promise<void> {
		try {
			const client = libClient.ClientRequest.fromUpgrade(this._cacheHost, protocol, request, socket, head, { burntConfig: this._clientConfig, wss });
			await this.handleWrapper(request, client, handler, who);
		} catch (err: any) {
			this.error(`Fatal error in request handler: ${err.message}`);
			request.destroy(new Error('Unhandled exception'));
		}
	}
	private configureServer(server: libHttp.Server, who: string, secure: boolean, handler: libHandler.ModuleHandler, failed?: () => void): Listener {
		const protocol = (secure ? 'https' : 'http');
		let listenStoppedResolve = () => { }, stopping = false;
		const listenStoppedPromise = new Promise<void>((res) => listenStoppedResolve = res);
		const unlinked = { cb: () => { listenStoppedResolve(); } };

		/* initialize the unlink to just resolve the promise, later-on, it will be replaced to guarantee proper cleanup */
		try {
			const attached = handler._attachToRoot(() => unlinked.cb());
			const wss = new libWs.WebSocketServer({ noServer: true });

			const cleanup = (): Promise<void> => {
				if (stopping)
					return listenStoppedPromise;
				stopping = true;

				/* close the server and any existing connections within it */
				const address = server.address() as libNet.AddressInfo | null;
				if (address != null)
					this.info(`Stopping to listen ${protocol}:[${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.logIdentity}]`);
				const serverStopped = new Promise<void>((res) => server.close(() => res()));
				server.closeAllConnections();

				(async () => {
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
						this._stop.listener = this._stop.listener.filter((v) => v != unlinked.cb);
					listenStoppedResolve();
				})();
				return listenStoppedPromise;
			};
			this._stop.listener.push(() => cleanup());
			unlinked.cb = () => cleanup();

			/* register the corresponding connection handlers */
			server.on('request', (req, resp) => this.handleRequest(req, resp, attached, who, protocol));
			server.on('upgrade', (req, sock, head) => this.handleUpgrade(req, sock, head, attached, who, protocol, wss));

			/* configure the server to have a minimum header receive timeout, overall connection-loss timeout,
			*	and keep-alive timeout (no request-timeout, as this is handled manually by the throughput control) */
			server.headersTimeout = this._config.headerTimeout;
			server.timeout = this._config.connectionTimeout;
			server.keepAliveTimeout = this._config.keepAliveTimeout;
			server.requestTimeout = 0;

			/* register the start and error callbacks (reset the server again if the listening failed) */
			server.once('error', (err) => {
				if (stopping) return;
				this.error(`Error while listening to ${protocol}:${who}: ${err.message}`);
				unlinked.cb();

				if (failed != null) {
					try { failed(); }
					catch (err: any) { this.error(`Unhandled exception in failed handler: ${err.message}`); }
				}
			});
			server.on('listening', () => {
				if (stopping) return;
				const address = server.address() as libNet.AddressInfo;
				this.info(`Started successfully on ${protocol}:[${address.address}]:${address.port} [family: ${address.family}] with handler [${handler.logIdentity}]`);
			});
		} catch (err: any) {
			this.error(`Error starting listening server ${protocol}:${who}: ${err.message}`);
			unlinked.cb();
		}

		return {
			stopped: () => {
				if (stopping) return null;
				return listenStoppedPromise;
			},
			stop: () => {
				unlinked.cb();
				return listenStoppedPromise;
			}
		};
	}

	/* listener entry will automatically be stopped once the server is stopped or the handler stopped (failed will be invoked if starting to listen failed) */
	public listenHttp(handler: libHandler.ModuleHandler, port: number, options?: { hostname?: string, failed?: () => void }): Listener {
		const server = libHttp.createServer({
			requireHostHeader: true,
			connectionsCheckingInterval: this._config.timeoutChecking
		});

		const listener = this.configureServer(server, `${options?.hostname ?? ''}:${port}`, false, handler, options?.failed);
		server.listen(port, options?.hostname);
		return listener;
	}

	/* listener entry will automatically be stopped once the server is stopped or the handler stopped (failed will be invoked if starting to listen failed) */
	public listenHttps(handler: libHandler.ModuleHandler, key: string, cert: string, port: number, options?: { hostname?: string, failed?: () => void }): Listener {
		const server = libHttps.createServer({
			requireHostHeader: true,
			key: libFs.readFileSync(key),
			cert: libFs.readFileSync(cert),
			connectionsCheckingInterval: this._config.timeoutChecking
		});

		const listener = this.configureServer(server, `${options?.hostname ?? ''}:${port}`, true, handler, options?.failed);
		server.listen(port, options?.hostname);
		return listener;
	}

	/* listener entry will automatically be stopped once the server is stopped or the handler stopped (failed will be invoked if starting to listen failed;
	*	wraps the server into the framework; server must be triggered to listen manually; [who] should describe the server; [secure] indicates https vs http;
	*	remember to configure [connectionsCheckingInterval] manually, as it cannot be configured afterwards anymore) */
	public wrap(handler: libHandler.ModuleHandler, server: libHttp.Server, who: string, secure: boolean, options?: { failed?: () => void }): Listener {
		return this.configureServer(server, who, secure, handler, options?.failed);
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

/* Important: cache host should be shared where possible as otherwise multiple unshared caches could exist and immutable ids might overwrite each other */
export type SystemConfig = ServerConfig & libClient.ClientConfig & libCache.CacheConfig & {
	/* set the cache host to be used by the server and created clients [Default: new cache is created] */
	cache?: libCache.CacheHost;
};
