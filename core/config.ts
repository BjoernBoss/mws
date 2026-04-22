/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
import * as libLog from "./log.js";

const logger = libLog.Logger('config');

export class CoreConfig {
	private _subscriber: (() => void)[] = [];
	private _serverName: string = '';
	private _webSocketTimeout: number = 0;
	private _requestTimeout: number = 0;
	private _responseTimeout: number = 0;
	private _keepAliveTimeout: number = 0;
	private _cacheSize: number = 0;
	private _cacheFileSizeLimit: number = 0;

	private notifyAll(): void {
		for (const fn of this._subscriber)
			fn();
	}

	public subscribe(cb: () => void): void {
		this._subscriber.push(cb);
	}
	public unsubscribe(cb: () => void): void {
		this._subscriber = this._subscriber.filter((v) => v != cb);
	}

	public get serverName(): string { return this._serverName }
	public set serverName(value: string) {
		if (this._serverName == value)
			return;

		this._serverName = value;
		logger.info(`Server name set to [${this._serverName}]`);
		this.notifyAll();
	}

	public get webSocketTimeout(): number { return this._webSocketTimeout }
	public set webSocketTimeout(value: number) {
		if (this._webSocketTimeout == value)
			return;

		this._webSocketTimeout = value;
		logger.info(`WebSocket timeout set to [${this._webSocketTimeout}]`);
		this.notifyAll();
	}

	public get requestTimeout(): number { return this._requestTimeout }
	public set requestTimeout(value: number) {
		if (this._requestTimeout == value)
			return;

		this._requestTimeout = value;
		logger.info(`Request timeout set to [${this._requestTimeout}]`);
		this.notifyAll();
	}

	public get responseTimeout(): number { return this._responseTimeout }
	public set responseTimeout(value: number) {
		if (this._responseTimeout == value)
			return;

		this._responseTimeout = value;
		logger.info(`Response timeout set to [${this._responseTimeout}]`);
		this.notifyAll();
	}

	public get keepAliveTimeout(): number { return this._keepAliveTimeout }
	public set keepAliveTimeout(value: number) {
		if (this._keepAliveTimeout == value)
			return;

		this._keepAliveTimeout = value;
		logger.info(`Keep-alive timeout set to [${this._keepAliveTimeout}]`);
		this.notifyAll();
	}

	public get cacheSize(): number { return this._cacheSize }
	public set cacheSize(value: number) {
		if (this._cacheSize == value)
			return;

		this._cacheSize = value;
		logger.info(`Cache size set to [${this._cacheSize}]`);
		this.notifyAll();
	}

	public get cacheFileSizeLimit(): number { return this._cacheFileSizeLimit }
	public set cacheFileSizeLimit(value: number) {
		if (this._cacheFileSizeLimit == value)
			return;

		this._cacheFileSizeLimit = value;
		logger.info(`Cache file size limit set to [${this._cacheFileSizeLimit}]`);
		this.notifyAll();
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
	Config.serverName = 'modular-web-server';
	Config.webSocketTimeout = 60_000;
	Config.requestTimeout = 120_000;
	Config.responseTimeout = 300_000;
	Config.keepAliveTimeout = 10_000;
	Config.cacheSize = 50_000_000;
	Config.cacheFileSizeLimit = 10_000_000;
}
