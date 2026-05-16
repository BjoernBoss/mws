/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025-2026 Bjoern Boss Henrichsen */
import * as libClient from "./client.js";
import * as libLog from "./log.js";
import * as libLocation from "./location.js";

export abstract class ModuleHandler {
	private _name: string;
	private _handle: { depth: number, promise: Promise<void> | null, resolver: () => void };
	private _stop: Promise<void> | null;
	private _active: Set<libClient.IncomingBase>;

	/* handle the client request (guaranteed to not have been claimed yet; if the promise
	*	resolves, client must either have been handled or must not be handled anymore) */
	protected abstract handleRequest(client: libClient.HttpRequest): Promise<void>;

	/* handle the client upgrade (guaranteed to not have been claimed yet; if the promise
	*	resolves, client must either have been handled or must not be handled anymore) */
	protected abstract handleUpgrade(client: libClient.HttpUpgrade): Promise<void>;

	/* stop this module (all clients are guaranteed to have left, but accepted WebSockets
	*	will not be closed automatically and must be closed by the module handler; module
	*	should cleanup any resources and timers; will only be called once) */
	protected abstract handleStop(): Promise<void>;

	protected constructor(name: string) {
		this._name = name;
		this._handle = { depth: 0, promise: null, resolver: () => { } };
		this._stop = null;
		this._active = new Set<libClient.IncomingBase>();
	}

	public get moduleName(): string {
		return this._name;
	}

	/* forward the given client to the module, and translate the paths and logging accordingly,
	*	if the module is designated for the client (if no path is provided, will not translate paths) */
	public async handle(client: libClient.HttpRequest | libClient.HttpUpgrade, path?: string): Promise<void> {
		/* ensure that the handler is not being shut down and that the client
		*	is not being handled nested and push the logging and path */
		if (this._stop != null || this._active.has(client) || client.claimed)
			return;
		const snapshot = client._pushTranslation(path ?? '/', this._name);
		if (snapshot == null)
			return;

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
	}

	/* close any connections to the module and stop the module itself */
	public async stop(): Promise<void> {
		if (this._stop != null)
			return this._stop;

		this._stop = new Promise<void>(async (resolve) => {
			/* kill any current connections and wait for their handlings to be complete */
			for (const client of this._active)
				client._killConnection();
			while (this._handle.promise != null)
				await this._handle.promise;

			await this.handleStop();
			resolve();
		});

		return this._stop;
	}
}

export type RequestLambda = (client: libClient.HttpRequest) => Promise<void>;
export type UpgradeLambda = (client: libClient.HttpUpgrade) => Promise<void>;
export type StopLambda = () => Promise<void>;
export type RequestWrap = (client: libClient.HttpRequest, handle: () => Promise<void>) => Promise<void>;
export type UpgradeWrap = (client: libClient.HttpUpgrade, handle: () => Promise<void>) => Promise<void>;

/*
*	Simple module handler implementation, which allows requests to be handled by lambdas.
*/
export class LambdaModule extends ModuleHandler {
	private requestLambda?: RequestLambda;
	private upgradeLambda?: UpgradeLambda;
	private stopLambda?: StopLambda;

	constructor(options?: { request?: RequestLambda, upgrade?: UpgradeLambda, stop?: StopLambda }) {
		super('lambda');
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
*/
export class DispatchModule extends ModuleHandler {
	private mapping: Record<string, ModuleHandler>;

	constructor(map: Record<string, ModuleHandler>) {
		super('dispatch');
		const logger = libLog.Logger(this.moduleName);

		this.mapping = {};
		for (const [key, handler] of Object.entries(map)) {
			logger.info(`Binding [${key}] to child [${handler.moduleName}]`);
			this.mapping[key] = handler;
		}
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
			client.trace(`Client dispatched to handler [${this.mapping[bestMatch].moduleName}] at [${bestMatch}]`);
			return this.mapping[bestMatch].handle(client, bestMatch);
		}
		client.trace(`Request cannot be dispatched`);
	}

	protected override async handleRequest(client: libClient.HttpRequest): Promise<void> {
		return this.dispatchAndHandle(client);
	}
	protected override async handleUpgrade(client: libClient.HttpUpgrade): Promise<void> {
		return this.dispatchAndHandle(client);
	}
	protected override async handleStop(): Promise<void> {
		const list: Promise<void>[] = [];
		for (const handler of Object.values(this.mapping))
			list.push(handler.stop());
		await Promise.all(list);
	}
}

/*
*	Simple module handler implementation, which dispatches requests to different children based on the request hostname (longest match).
*/
export class HostModule extends ModuleHandler {
	private mapping: Record<string, ModuleHandler>;

	constructor(map: Record<string, ModuleHandler>) {
		super('host');
		const logger = libLog.Logger(this.moduleName);

		this.mapping = {};
		for (const [key, handler] of Object.entries(map)) {
			logger.info(`Binding [/] with host [${key}] to child [${handler.moduleName}]`);
			this.mapping[key] = handler;
		}
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
			return this.mapping[bestMatch].handle(client);
		}
		client.trace(`Request cannot be dispatched`);
	}

	protected override async handleRequest(client: libClient.HttpRequest): Promise<void> {
		return this.dispatchAndHandle(client);
	}
	protected override async handleUpgrade(client: libClient.HttpUpgrade): Promise<void> {
		return this.dispatchAndHandle(client);
	}
	protected override async handleStop(): Promise<void> {
		const list: Promise<void>[] = [];
		for (const handler of Object.values(this.mapping))
			list.push(handler.stop());
		await Promise.all(list);
	}
}

/*
*	Simple module interface implementation, which forwards unhandled requests to a lambda.
*/
export class UnhandledModule extends ModuleHandler {
	private handler: ModuleHandler;
	private requestLambda?: RequestLambda;
	private upgradeLambda?: UpgradeLambda;

	constructor(handler: ModuleHandler, options?: { request?: RequestLambda, upgrade?: UpgradeLambda }) {
		super('unhandler');

		this.handler = handler;
		libLog.Logger(this.moduleName).info(`Binding [/] to child [${handler.moduleName}]`);
		this.requestLambda = options?.request;
		this.upgradeLambda = options?.upgrade;
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
	protected override async handleStop(): Promise<void> {
		await this.handler.stop();
	}
}

/*
*	Simple module interface implementation, which forwards any requests to a lambda.
*/
export class WrapModule extends ModuleHandler {
	private handler: ModuleHandler;
	private requestWrap?: RequestWrap;
	private upgradeWrap?: UpgradeWrap;

	constructor(handler: ModuleHandler, options?: { request?: RequestWrap, upgrade?: UpgradeWrap }) {
		super('wrap');

		this.handler = handler;
		libLog.Logger(this.moduleName).info(`Binding [/] to child [${handler.moduleName}]`);
		this.requestWrap = options?.request;
		this.upgradeWrap = options?.upgrade;
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
	protected override async handleStop(): Promise<void> {
		await this.handler.stop();
	}
}
