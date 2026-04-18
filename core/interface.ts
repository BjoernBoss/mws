/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025-2026 Bjoern Boss Henrichsen */
import * as libClient from './client.js';
import * as libLog from "./log.js";
import * as libLocation from "./location.js";

/*
*	Module interface
*	If the returned promise resolves, and the client has not yet been handled,
*	it is expected to not be handled anymore by the given client.
*/
export interface ModuleInterface {
	name: string;
	request(client: libClient.HttpRequest): Promise<void>;
	upgrade(client: libClient.HttpUpgrade): Promise<void>;
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
export type RequestWrap = (client: libClient.HttpRequest, handle: () => Promise<void>) => Promise<void>;
export type UpgradeWrap = (client: libClient.HttpUpgrade, handle: () => Promise<void>) => Promise<void>;

/*
*	Simple module interface implementation, which allows requests to be handled by a lambdas.
*/
export class LambdaModule implements ModuleInterface {
	private requestLambda?: RequestLambda;
	private upgradeLambda?: UpgradeLambda;

	public name: string = 'lambda';
	constructor(request?: RequestLambda, upgrade?: UpgradeLambda) {
		this.requestLambda = request;
		this.upgradeLambda = upgrade;
	}

	public async request(client: libClient.HttpRequest): Promise<void> {
		if (this.requestLambda != undefined)
			await this.requestLambda(client);
	}

	public async upgrade(client: libClient.HttpUpgrade): Promise<void> {
		if (this.upgradeLambda != undefined)
			await this.upgradeLambda(client);
	}
}

/*
*	Simple module interface implementation, which dispatches requests to different children.
*/
export class DispatchModule implements ModuleInterface {
	private mapping: Record<string, ModuleInterface>;

	public name: string = 'dispatch';
	constructor(map: Record<string, ModuleInterface>) {
		this.mapping = {};
		for (const key in map) {
			const handler = map[key];
			libLog.Info(`Mapping [${handler.name}] to [${key}]`);
			this.mapping[key] = handler;
		}
	}

	private dispatch(client: libClient.ClientBase): ModuleInterface | null {
		let bestMatch: string | null = null;

		/* iterate over the mappings and look for the corresponding best handler */
		for (const path in this.mapping) {
			if (!libLocation.IsSubDirectory(path, client.path))
				continue;
			if (bestMatch == null || bestMatch.length < path.length)
				bestMatch = path;
		}

		/* check if a handler has been found and translate the path accordingly */
		if (bestMatch != null) {
			client.log(`Client dispatched to handler [${this.mapping[bestMatch].name}] at [${bestMatch}]`);
			client.tryTranslate(bestMatch);
			return this.mapping[bestMatch];
		}
		client.log(`Request cannot be dispatched`);
		return null;
	}

	public async request(client: libClient.HttpRequest): Promise<void> {
		const module = this.dispatch(client);
		if (module != null) {
			client.pushLog(module.name);
			await module.request(client);
		}
	}
	public async upgrade(client: libClient.HttpUpgrade): Promise<void> {
		const module = this.dispatch(client);
		if (module != null) {
			client.pushLog(module.name);
			await module.upgrade(client);
		}
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
	constructor(handler: ModuleInterface, request?: RequestLambda, upgrade?: UpgradeLambda) {
		this.handler = handler;
		libLog.Info(`Unhandled wrapper [${handler.name}]`);
		this.requestLambda = request;
		this.upgradeLambda = upgrade;
	}

	public async request(client: libClient.HttpRequest): Promise<void> {
		client.pushLog(this.handler.name);
		await this.handler.request(client);
		if (!client.handled() && this.requestLambda != undefined)
			await this.requestLambda(client);
	}

	public async upgrade(client: libClient.HttpUpgrade): Promise<void> {
		client.pushLog(this.handler.name);
		await this.handler.upgrade(client);
		if (!client.handled() && this.upgradeLambda != undefined)
			await this.upgradeLambda(client);
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
	constructor(handler: ModuleInterface, request?: RequestWrap, upgrade?: UpgradeWrap) {
		this.handler = handler;
		libLog.Info(`Wrapping [${handler.name}]`);
		this.requestWrap = request;
		this.upgradeWrap = upgrade;
	}

	public async request(client: libClient.HttpRequest): Promise<void> {
		client.pushLog(this.handler.name);
		if (this.requestWrap != undefined)
			await this.requestWrap(client, () => this.handler.request(client));
		else
			await this.handler.request(client);
	}

	public async upgrade(client: libClient.HttpUpgrade): Promise<void> {
		client.pushLog(this.handler.name);
		if (this.upgradeWrap != undefined)
			await this.upgradeWrap(client, () => this.handler.upgrade(client));
		else
			await this.handler.upgrade(client);
	}
}
