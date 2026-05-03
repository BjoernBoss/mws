/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025-2026 Bjoern Boss Henrichsen */
import * as libClient from "./client.js";
import * as libLog from "./log.js";
import * as libLocation from "./location.js";

/*
*	Module interface
*	If the returned promise resolves, and the client has not yet been handled,
*	it is expected to not be handled anymore by the given client.
*	Modules expect clients to be completely unhandled when being passed to the module.
*	Stop should cleanup the module resources and any timers (no new active connections will be incoming anymore, may be called multiple times).
*/
export interface ModuleInterface {
	name: string;
	request(client: libClient.HttpRequest): Promise<void>;
	upgrade(client: libClient.HttpUpgrade): Promise<void>;
	stop(): Promise<void>;
}

/*
*	Validate the host passed in via the http-parameter.
*	Host string will be empty for no host-parameter.
*	Host strings optional port will have been verified and dropped.
*		=> Will only contain the lower-case host name.
*/
export type CheckHost = (host: string) => boolean;

export type RequestLambda = (client: libClient.HttpRequest) => Promise<void>;
export type UpgradeLambda = (client: libClient.HttpUpgrade) => Promise<void>;
export type StopLambda = () => Promise<void>;
export type RequestWrap = (client: libClient.HttpRequest, handle: () => Promise<void>) => Promise<void>;
export type UpgradeWrap = (client: libClient.HttpUpgrade, handle: () => Promise<void>) => Promise<void>;

/*
*	Simple module interface implementation, which allows requests to be handled by lambdas.
*/
export class LambdaModule implements ModuleInterface {
	private requestLambda?: RequestLambda;
	private upgradeLambda?: UpgradeLambda;
	private stopLambda?: StopLambda;

	public name: string = 'lambda';
	constructor(options?: { request?: RequestLambda, upgrade?: UpgradeLambda, stop?: StopLambda }) {
		this.requestLambda = options?.request;
		this.upgradeLambda = options?.upgrade;
		this.stopLambda = options?.stop;
	}

	public async request(client: libClient.HttpRequest): Promise<void> {
		if (this.requestLambda != null)
			await this.requestLambda(client);
	}
	public async upgrade(client: libClient.HttpUpgrade): Promise<void> {
		if (this.upgradeLambda != null)
			await this.upgradeLambda(client);
	}
	public async stop(): Promise<void> {
		if (this.stopLambda != null)
			await this.stopLambda();
	}
}

/*
*	Simple module interface implementation, which dispatches requests to different children.
*/
export class DispatchModule implements ModuleInterface {
	private mapping: Record<string, ModuleInterface>;

	public name: string = 'dispatch';
	constructor(map: Record<string, ModuleInterface>) {
		const logger = libLog.Logger(this.name);

		this.mapping = {};
		for (const [key, handler] of Object.entries(map)) {
			logger.info(`Binding [${key}] to child [${handler.name}]`);
			this.mapping[key] = handler;
		}
	}

	private dispatch(client: libClient.ClientBase): [ModuleInterface, string] | null {
		let bestMatch: string | null = null;

		/* iterate over the mappings and look for the corresponding best handler */
		for (const path in this.mapping) {
			if (!libLocation.IsSubDirectory(path, client.path))
				continue;
			if (bestMatch == null || bestMatch.length < path.length)
				bestMatch = path;
		}

		if (bestMatch != null) {
			client.trace(`Client dispatched to handler [${this.mapping[bestMatch].name}] at [${bestMatch}]`);
			return [this.mapping[bestMatch], bestMatch];
		}
		client.trace(`Request cannot be dispatched`);
		return null;
	}

	public async request(client: libClient.HttpRequest): Promise<void> {
		const match = this.dispatch(client);
		if (match == null)
			return;

		const snapshot = client.pushPath(match[1], match[0].name)!;
		await match[0].request(client);
		client.restore(snapshot);
	}
	public async upgrade(client: libClient.HttpUpgrade): Promise<void> {
		const match = this.dispatch(client);
		if (match == null)
			return;

		const snapshot = client.pushPath(match[1], match[0].name)!;
		await match[0].upgrade(client);
		client.restore(snapshot);
	}
	public async stop(): Promise<void> {
		const list: Promise<void>[] = [];
		for (const handler of Object.values(this.mapping))
			list.push(handler.stop());
		await Promise.all(list);
	}
}

/*
*	Simple module interface implementation, which forwards unhandled requests to a lambda.
*/
export class UnhandledModule implements ModuleInterface {
	private handler: ModuleInterface;
	private requestLambda?: RequestLambda;
	private upgradeLambda?: UpgradeLambda;

	public name: string = 'unhandler';
	constructor(handler: ModuleInterface, options?: { request?: RequestLambda, upgrade?: UpgradeLambda }) {
		this.handler = handler;
		libLog.Logger(this.name).info(`Binding [/] to child [${handler.name}]`);
		this.requestLambda = options?.request;
		this.upgradeLambda = options?.upgrade;
	}

	public async request(client: libClient.HttpRequest): Promise<void> {
		const snapshot = client.pushLog(this.handler.name);

		await this.handler.request(client);
		if (client.unhandled && this.requestLambda != null)
			await this.requestLambda(client);

		client.restore(snapshot);
	}
	public async upgrade(client: libClient.HttpUpgrade): Promise<void> {
		const snapshot = client.pushLog(this.handler.name);

		await this.handler.upgrade(client);
		if (client.unhandled && this.upgradeLambda != null)
			await this.upgradeLambda(client);

		client.restore(snapshot);
	}
	public async stop(): Promise<void> {
		await this.handler.stop();
	}
}

/*
*	Simple module interface implementation, which forwards any requests to a lambda.
*/
export class WrapModule implements ModuleInterface {
	private handler: ModuleInterface;
	private requestWrap?: RequestWrap;
	private upgradeWrap?: UpgradeWrap;

	public name: string = 'wrap';
	constructor(handler: ModuleInterface, options?: { request?: RequestWrap, upgrade?: UpgradeWrap }) {
		this.handler = handler;
		libLog.Logger(this.name).info(`Binding [/] to child [${handler.name}]`);
		this.requestWrap = options?.request;
		this.upgradeWrap = options?.upgrade;
	}

	public async request(client: libClient.HttpRequest): Promise<void> {
		const snapshot = client.pushLog(this.handler.name);

		if (this.requestWrap != null)
			await this.requestWrap(client, () => this.handler.request(client));
		else
			await this.handler.request(client);

		client.restore(snapshot);
	}

	public async upgrade(client: libClient.HttpUpgrade): Promise<void> {
		const snapshot = client.pushLog(this.handler.name);

		if (this.upgradeWrap != null)
			await this.upgradeWrap(client, () => this.handler.upgrade(client));
		else
			await this.handler.upgrade(client);

		client.restore(snapshot);
	}
	public async stop(): Promise<void> {
		await this.handler.stop();
	}
}
