/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";

const logger = libLog.Logger('config');

export class CoreConfig {
	private _subscriber: (() => void)[] = [];
	private _serverName: string = '';
	private _webSocketTimeout: number = 0;
	private _webSocketAliveTimeout: number = 0;
	private _headerTimeout: number = 0;
	private _connectionTimeout: number = 0;
	private _keepAliveTimeout: number = 0;
	private _killGraceTimeout: number = 0;
	private _cacheSize: number = 0;
	private _cacheAlwaysValidate: boolean = false;
	private _cacheImmutableTagging: boolean = false;
	private _cacheFileSizeLimit: number = 0;
	private _fileCacheControl: string = '';
	private _immutableCacheControl: string = '';
	private _responseCacheControl: string = '';
	private _throughputGrace: number = 0;
	private _throughputThreshold: number = 0;
	private _throughputWindow: number = 0;
	private _commonHeaders: Record<string, string> = {};

	private changed(name: string, value: unknown): void {
		logger.info(`${name} set to [${value}]`);
		for (const fn of [...this._subscriber]) {
			try { fn(); }
			catch (err: any) {
				logger.error(`Unhandled exception in config subscriber: ${err.message}`);
			}
		}
	}

	public subscribe(cb: () => void): void {
		this._subscriber.push(cb);
	}
	public unsubscribe(cb: () => void): void {
		this._subscriber = this._subscriber.filter((v) => v != cb);
	}

	/* default server name to be used in the http:server header [empty value prevents server header] */
	public get serverName(): string { return this._serverName; }
	public set serverName(value: string) {
		if (this._serverName == value)
			return;
		this._serverName = value;
		this.changed('Server name', value);
	}

	/* defaule header values to be added to every http response [can also be done via headerPatchers] */
	public get commonHeaders(): Record<string, string> { return this._commonHeaders; }
	public set commonHeaders(value: Record<string, string>) {
		const _current = Object.entries(this._commonHeaders);
		if (_current.length == Object.keys(value).length && _current.every(([k, v]) => value[k] === v))
			return;
		this._commonHeaders = value;
		this.changed('Common headers', JSON.stringify(value));
	}

	/* default web-socket timeout before performing a ping to determine liveness [0 disables the timeout; in milliseconds] */
	public get webSocketTimeout(): number { return this._webSocketTimeout; }
	public set webSocketTimeout(value: number) {
		value = Math.max(value, 0);
		if (this._webSocketTimeout == value)
			return;
		this._webSocketTimeout = value;
		this.changed('WebSocket timeout', value);
	}

	/* default web-socket timeout to respond to a liveness ping before closing the connection [0 kills the connection without ping test; in milliseconds] */
	public get webSocketAliveTimeout(): number { return this._webSocketAliveTimeout; }
	public set webSocketAliveTimeout(value: number) {
		value = Math.max(value, 0);
		if (this._webSocketAliveTimeout == value)
			return;
		this._webSocketAliveTimeout = value;
		this.changed('WebSocket alive timeout', value);
	}

	/* default timeout for request headers to be fully received [0 disables the timeout; in milliseconds] */
	public get headerTimeout(): number { return this._headerTimeout; }
	public set headerTimeout(value: number) {
		value = Math.max(value, 0);
		if (this._headerTimeout == value)
			return;
		this._headerTimeout = value;
		this.changed('Header timeout', value);
	}

	/* default inactivity timeout — connection is closed if no data is sent or received; resets on any
	*	I/O activity, so active transfers are not affected [0 disables the timeout; in milliseconds] */
	public get connectionTimeout(): number { return this._connectionTimeout; }
	public set connectionTimeout(value: number) {
		value = Math.max(value, 0);
		if (this._connectionTimeout == value)
			return;
		this._connectionTimeout = value;
		this.changed('Connection timeout', value);
	}

	/* idle time allowed between requests before closing a keep-alive connection [0 falls back to connectionTimeout; in milliseconds] */
	public get keepAliveTimeout(): number { return this._keepAliveTimeout; }
	public set keepAliveTimeout(value: number) {
		value = Math.max(value, 0);
		if (this._keepAliveTimeout == value)
			return;
		this._keepAliveTimeout = value;
		this.changed('Keep-alive timeout', value);
	}

	/* time for a broken connection or socket to receive the response before force-closing it [0 results in immediate close; in milliseconds] */
	public get killGraceTimeout(): number { return this._killGraceTimeout; }
	public set killGraceTimeout(value: number) {
		value = Math.max(value, 0);
		if (this._killGraceTimeout == value)
			return;
		this._killGraceTimeout = value;
		this.changed('Kill grace timeout', value);
	}

	/* maximum sum of data cached before evicting old cache entries [in bytes] */
	public get cacheSize(): number { return this._cacheSize; }
	public set cacheSize(value: number) {
		if (this._cacheSize == value)
			return;
		this._cacheSize = value;
		this.changed('Cache size', value);
	}

	/* maximum file size of files considered to be cached, larger files will not be cached [in bytes] */
	public get cacheFileSizeLimit(): number { return this._cacheFileSizeLimit; }
	public set cacheFileSizeLimit(value: number) {
		if (this._cacheFileSizeLimit == value)
			return;
		this._cacheFileSizeLimit = value;
		this.changed('Cache file size limit', value);
	}

	/* update the cache to always revalidate the freshness before serving, otherwise base the decision on the on the owner */
	public get cacheAlwaysValidate(): boolean { return this._cacheAlwaysValidate; }
	public set cacheAlwaysValidate(value: boolean) {
		if (this._cacheAlwaysValidate == value)
			return;
		this._cacheAlwaysValidate = value;
		this.changed('Cache always validate', value);
	}

	/* tag served content with immutable ids, otherwise the normal files will just be served - as mutable */
	public get cacheImmutableTagging(): boolean { return this._cacheImmutableTagging; }
	public set cacheImmutableTagging(value: boolean) {
		if (this._cacheImmutableTagging == value)
			return;
		this._cacheImmutableTagging = value;
		this.changed('Cache immutable tagging', value);
	}

	/* default cache-control value for normal cache reads [empty string does not set any cache-control] */
	public get fileCacheControl(): string { return this._fileCacheControl; }
	public set fileCacheControl(value: string) {
		if (this._fileCacheControl == value)
			return;
		this._fileCacheControl = value;
		this.changed('File cache control', value);
	}

	/* default cache-control value for immutable cache reads [empty string does not set any cache-control] */
	public get immutableCacheControl(): string { return this._immutableCacheControl; }
	public set immutableCacheControl(value: string) {
		if (this._immutableCacheControl == value)
			return;
		this._immutableCacheControl = value;
		this.changed('Immutable cache control', value);
	}

	/* default cache-control value for any basic responses [empty string does not set any cache-control] */
	public get responseCacheControl(): string { return this._responseCacheControl; }
	public set responseCacheControl(value: string) {
		if (this._responseCacheControl == value)
			return;
		this._responseCacheControl = value;
		this.changed('Response cache control', value);
	}

	/* grace period before the throughput is started to be measured or for busy connections [in milliseconds] */
	public get throughputGrace(): number { return this._throughputGrace; }
	public set throughputGrace(value: number) {
		value = Math.max(value, 0);
		if (this._throughputGrace == value)
			return;
		this._throughputGrace = value;
		this.changed('Throughput grace', value);
	}

	/* throughput required for combined sending and receiving bodies of requests [0 disables the throughput check, in bytes/second] */
	public get throughputThreshold(): number { return this._throughputThreshold; }
	public set throughputThreshold(value: number) {
		value = Math.max(value, 0);
		if (this._throughputThreshold == value)
			return;
		this._throughputThreshold = value;
		this.changed('Throughput threshold', value);
	}

	/* length of sliding time window for which the throughput must be above the threshold [greater than 0, window length in milliseconds] */
	public get throughputWindow(): number { return this._throughputWindow; }
	public set throughputWindow(value: number) {
		value = Math.max(value, 1);
		if (this._throughputWindow == value)
			return;
		this._throughputWindow = value;
		this.changed('Throughput window', value);
	}

	/* directly forwarded to cache [ConfigureWriteBack] but for consistency also here [cannot be subscribed to] */
	public async cacheWriteBack(path: string | null): Promise<void> {
		logger.info(`Configuring cache writeback to [${path ?? ''}]`);

		/* defer, as the cache initialization imports this module again and interacts with it at initialization */
		const config = await import("./cache.js");
		return config.ConfigureWriteBack(path);
	}
}

/*
*	Server wide configurations of the core components
*/
export const Config: CoreConfig = new CoreConfig();

/*
*	Initial root server configuration
*/
export function Initialize(): void {
	Config.serverName = 'Modular Web Server';
	Config.commonHeaders = { 'X-Content-Type-Options': 'nosniff' };
	Config.webSocketTimeout = 180_000;
	Config.webSocketAliveTimeout = 2_000;
	Config.headerTimeout = 30_000;
	Config.connectionTimeout = 90_000;
	Config.keepAliveTimeout = 10_000;
	Config.killGraceTimeout = 1_000;
	Config.cacheSize = 50_000_000;
	Config.cacheFileSizeLimit = 10_000_000;
	Config.cacheAlwaysValidate = false;
	Config.cacheImmutableTagging = true;
	Config.responseCacheControl = 'private, no-cache';
	Config.throughputGrace = 10_000;
	Config.throughputThreshold = 1_000;
	Config.throughputWindow = 30_000;

	/* cache valid for 10minutes */
	Config.fileCacheControl = 'public, max-age=600, must-revalidate';

	/* cache valid for 30days */
	Config.immutableCacheControl = 'public, max-age=2592000, immutable';
}
