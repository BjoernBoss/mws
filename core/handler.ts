/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025-2026 Bjoern Boss Henrichsen */
import * as libClient from "./client.js";
import * as libLog from "./log.js";
import * as libLocation from "./location.js";

export abstract class ModuleHandler {
	private _name: string;
	private _tagName: boolean;
	private _handle: { depth: number, promise: Promise<void> | null, resolver: () => void };
	private _stopped: Promise<void> | null;
	private _stopListener: (() => void)[];
	private _active: Set<libClient.IncomingBase>;

	protected constructor(name: string) {
		this._name = name;
		this._tagName = true;
		this._handle = { depth: 0, promise: null, resolver: () => { } };
		this._stopped = null;
		this._stopListener = [];
		this._active = new Set<libClient.IncomingBase>();
	}

	/* handle the client request (guaranteed to not have been claimed yet; if the promise
	*	resolves, client must either have been handled or must not be handled anymore) */
	protected async handleRequest(client: libClient.HttpRequest): Promise<void> { const _ = client; }

	/* handle the client upgrade (guaranteed to not have been claimed yet; if the promise
	*	resolves, client must either have been handled or must not be handled anymore) */
	protected async handleUpgrade(client: libClient.HttpUpgrade): Promise<void> { const _ = client; }

	/* stop this module (will only be called after an initial mount call; all clients are guaranteed to have left, but accepted WebSockets will not
	*	be closed automatically and must be closed by the module handler; module should cleanup any resources and timers; will only be called once) */
	protected async handleStop(): Promise<void> { }

	/* fetch the name of the module */
	public get moduleName(): string {
		return this._name;
	}

	/* check if the module has already been stopped or is still active and valid */
	public get moduleStopped(): boolean {
		return (this._stopped != null);
	}

	/* register a listener to be notified once the module is stopped (will not be triggered if already stopped) */
	public listenStop(cb: () => void): this {
		this._stopListener.push(cb);
		return this;
	}

	/* enable or disable the module tagging the logging output */
	public tagName(tag: boolean): this {
		this._tagName = tag;
		return this;
	}

	/* forward the given client to the module, and translate the paths and logging accordingly,
	*	if the module is designated for the client (if no path is provided, will not translate
	*	paths); returns false if the client is still unclaimed after the handler */
	public async handle(client: libClient.HttpRequest | libClient.HttpUpgrade, path?: string): Promise<boolean> {
		/* ensure that the handler is not being shut down and that the client
		*	is not being handled nested and push the logging and path */
		if (this._stopped != null || this._active.has(client) || client.claimed)
			return client.claimed;
		const snapshot = client._pushTranslation(path ?? '/', this._tagName ? this._name : '');
		if (snapshot == null)
			return client.claimed;

		/* check if the cleanup handler needs to be setup and push the client in general to be handled right now */
		if (this._handle.depth++ == 0)
			this._handle.promise = new Promise<void>((resolve) => this._handle.resolver = resolve);
		this._active.add(client);

		/* handle the client but ensure to catch any exceptions and re-throw them once the handler has been cleaned up */
		let error = null;
		try {
			if (client instanceof libClient.HttpRequest)
				await this.handleRequest(client);
			else
				await this.handleUpgrade(client);
		} catch (err: any) {
			error = err;
		}

		/* restore the context, clear the handling promise and remove the client from actively handled clients */
		this._active.delete(client);
		client._restoreSnapshot(snapshot);
		if (--this._handle.depth == 0) {
			this._handle.promise = null;
			this._handle.resolver();
		}

		if (error != null)
			throw error;
		return client.claimed;
	}

	/* close any connections to the module and stop the module itself (stopping must not
	*	be awaited while stopping itself or a parent as this can result in deadlocks) */
	public async stop(): Promise<void> {
		if (this._stopped != null)
			return this._stopped;

		this._stopped = new Promise<void>(async (resolve) => {
			/* notify the subscriber about not listening anymore */
			for (const cb of this._stopListener)
				cb();

			/* kill any current connections and wait for their handlings to be complete */
			for (const client of this._active)
				client._killConnection();
			while (this._handle.promise != null)
				await this._handle.promise;

			await this.handleStop();
			resolve();
		});

		return this._stopped;
	}
}

export type RequestLambda = (client: libClient.HttpRequest) => Promise<void>;
export type UpgradeLambda = (client: libClient.HttpUpgrade) => Promise<void>;
export type StopLambda = () => Promise<void>;
export type RequestWrap = (client: libClient.HttpRequest, handle: () => Promise<boolean>) => Promise<void>;
export type UpgradeWrap = (client: libClient.HttpUpgrade, handle: () => Promise<boolean>) => Promise<void>;

/*
*	Simple module handler implementation, which allows requests to be handled by lambdas.
*/
export class LambdaModule extends ModuleHandler {
	private requestLambda?: RequestLambda;
	private upgradeLambda?: UpgradeLambda;
	private stopLambda?: StopLambda;

	constructor(options?: { request?: RequestLambda, upgrade?: UpgradeLambda, stop?: StopLambda, name?: string }) {
		super(options?.name ?? 'lambda');
		this.requestLambda = options?.request;
		this.upgradeLambda = options?.upgrade;
		this.stopLambda = options?.stop;
	}

	protected override async handleRequest(client: libClient.HttpRequest): Promise<void> {
		if (this.requestLambda != null)
			await this.requestLambda(client);
	}
	protected override async handleUpgrade(client: libClient.HttpUpgrade): Promise<void> {
		if (this.upgradeLambda != null)
			await this.upgradeLambda(client);
	}
	protected override async handleStop(): Promise<void> {
		if (this.stopLambda != null)
			await this.stopLambda();
	}
}

/*
*	Simple module handler implementation, which dispatches requests to different children based on the request path (longest match).
*	Stops itself once all children have been stopped.
*/
export class DispatchModule extends ModuleHandler {
	private mapping: Record<string, ModuleHandler>;

	constructor(map: Record<string, ModuleHandler>) {
		super('dispatch');
		const logger = libLog.Logger(this.moduleName);
		this.mapping = {};

		for (const [key, handler] of Object.entries(map)) {
			if (key in this.mapping)
				logger.warning(`Ignoring duplicate mapping [${key}] by [${handler.moduleName}]`);
			else if (handler.moduleStopped)
				logger.warning(`Ignoring stopped handler [${handler.moduleName}]`);
			else {
				logger.info(`Binding path [${key}] to [${handler.moduleName}]`);
				this.mapping[key] = handler.listenStop(() => {
					delete this.mapping[key];
					if (Object.keys(this.mapping).length == 0)
						this.stop();
				});
			}
		}

		if (Object.keys(this.mapping).length == 0)
			this.stop();
	}

	private async dispatchAndHandle(client: libClient.HttpRequest | libClient.HttpUpgrade): Promise<void> {
		let bestMatch: string | null = null;

		/* iterate over the mappings and look for the corresponding best handler */
		for (const path in this.mapping) {
			if (!libLocation.IsSubDirectory(path, client.path))
				continue;
			if (bestMatch == null || bestMatch.length < path.length)
				bestMatch = path;
		}

		if (bestMatch != null) {
			client.trace(`Client dispatched to handler [${this.mapping[bestMatch].moduleName}] for path [${bestMatch}]`);
			await this.mapping[bestMatch].handle(client, bestMatch);
		}
		else
			client.trace(`Request cannot be dispatched`);
	}

	protected override async handleRequest(client: libClient.HttpRequest): Promise<void> {
		return this.dispatchAndHandle(client);
	}
	protected override async handleUpgrade(client: libClient.HttpUpgrade): Promise<void> {
		return this.dispatchAndHandle(client);
	}
}

/*
*	Simple module handler implementation, which dispatches requests to different children based on the request hostname (longest match).
*	Stops itself once all children have been stopped.
*/
export class HostModule extends ModuleHandler {
	private mapping: Record<string, ModuleHandler>;

	constructor(map: Record<string, ModuleHandler>) {
		super('host');
		const logger = libLog.Logger(this.moduleName);

		this.mapping = {};
		for (const [key, handler] of Object.entries(map)) {
			if (key in this.mapping)
				logger.warning(`Ignoring duplicate mapping of host [${key}] by [${handler.moduleName}]`);
			else if (handler.moduleStopped)
				logger.warning(`Ignoring stopped handler [${handler.moduleName}]`);
			else {
				logger.info(`Binding host [${key}] to [${handler.moduleName}]`);
				this.mapping[key] = handler.listenStop(() => {
					delete this.mapping[key];
					if (Object.keys(this.mapping).length == 0)
						this.stop();
				});
			}
		}

		if (Object.keys(this.mapping).length == 0)
			this.stop();
	}

	private testSubHost(host: string, test: string): boolean {
		if (host.length > test.length)
			return false;
		if (host.length == test.length)
			return (host == test);
		if (!test.endsWith(host))
			return false;
		return (test[test.length - host.length - 1] == '.' || host.startsWith('.') || host == '');
	}
	private async dispatchAndHandle(client: libClient.HttpRequest | libClient.HttpUpgrade): Promise<void> {
		let bestMatch: string | null = null;

		/* iterate over the mappings and look for the corresponding best handler */
		for (const host in this.mapping) {
			if (!this.testSubHost(host, client.url.hostname))
				continue;
			if (bestMatch == null || bestMatch.length < host.length)
				bestMatch = host;
		}

		if (bestMatch != null) {
			client.trace(`Client dispatched to handler [${this.mapping[bestMatch].moduleName}] for host [${bestMatch}]`);
			await this.mapping[bestMatch].handle(client);
		}
		else
			client.trace(`Request cannot be dispatched`);
	}

	protected override async handleRequest(client: libClient.HttpRequest): Promise<void> {
		return this.dispatchAndHandle(client);
	}
	protected override async handleUpgrade(client: libClient.HttpUpgrade): Promise<void> {
		return this.dispatchAndHandle(client);
	}
}

/*
*	Simple module interface implementation, which forwards unhandled requests to a lambda.
*	Stops itself once all children have been stopped.
*/
export class UnhandledModule extends ModuleHandler {
	private handler: ModuleHandler;
	private requestLambda?: RequestLambda;
	private upgradeLambda?: UpgradeLambda;

	constructor(handler: ModuleHandler, options?: { request?: RequestLambda, upgrade?: UpgradeLambda }) {
		super('unhandler');

		this.handler = handler.listenStop(() => this.stop());
		this.requestLambda = options?.request;
		this.upgradeLambda = options?.upgrade;

		if (this.handler.moduleStopped) {
			libLog.Logger(this.moduleName).warning(`Ignoring stopped handler [${this.handler.moduleName}]`);
			this.stop();
		}
	}

	protected override async handleRequest(client: libClient.HttpRequest): Promise<void> {
		await this.handler.handle(client);
		if (client.unhandled && this.requestLambda != null)
			await this.requestLambda(client);
	}
	protected override async handleUpgrade(client: libClient.HttpUpgrade): Promise<void> {
		await this.handler.handle(client);
		if (client.unhandled && this.upgradeLambda != null)
			await this.upgradeLambda(client);
	}
}

/*
*	Simple module interface implementation, which forwards any requests to a lambda.
*	Stops itself once all children have been stopped.
*/
export class WrapModule extends ModuleHandler {
	private handler: ModuleHandler;
	private requestWrap?: RequestWrap;
	private upgradeWrap?: UpgradeWrap;

	constructor(handler: ModuleHandler, options?: { request?: RequestWrap, upgrade?: UpgradeWrap }) {
		super('wrap');

		this.handler = handler.listenStop(() => this.stop());
		this.requestWrap = options?.request;
		this.upgradeWrap = options?.upgrade;

		if (this.handler.moduleStopped) {
			libLog.Logger(this.moduleName).warning(`Ignoring stopped handler [${this.handler.moduleName}]`);
			this.stop();
		}
	}

	protected override async handleRequest(client: libClient.HttpRequest): Promise<void> {
		if (this.requestWrap != null)
			await this.requestWrap(client, () => this.handler.handle(client));
		else
			await this.handler.handle(client);
	}
	protected override async handleUpgrade(client: libClient.HttpUpgrade): Promise<void> {
		if (this.upgradeWrap != null)
			await this.upgradeWrap(client, () => this.handler.handle(client));
		else
			await this.handler.handle(client);
	}
}
