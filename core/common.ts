/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025-2026 Bjoern Boss Henrichsen */
import * as libClient from './client.js';
import * as libLog from "./log.js";
import * as libLocation from "./location.js";

export interface ModuleInterface {
	name: string;
	request(client: libClient.HttpRequest): void;
	upgrade(client: libClient.HttpUpgrade): void;
}

/*
*	Validate the host passed in via the http-parameter.
*	Host string will be empty for no host-parameter.
*	Host strings optional port will have been verified and dropped.
*		=> Will only contain the lower-case host name.
*/
export type CheckHost = (host: string) => boolean;

export type RequestLambda = (client: libClient.HttpRequest) => void;
export type UpgradeLambda = (client: libClient.HttpUpgrade) => void;

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

	public request(client: libClient.HttpRequest): void {
		if (this.requestLambda != undefined)
			this.requestLambda(client);
	}

	public upgrade(client: libClient.HttpUpgrade): void {
		if (this.upgradeLambda != undefined)
			this.upgradeLambda(client);
	}
};

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

	private dispatch(client: libClient.HttpBase): ModuleInterface | null {
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

	public request(client: libClient.HttpRequest): void {
		const module = this.dispatch(client);
		if (module != null) {
			client.pushLog(module.name);
			module.request(client);
		}
	}
	public upgrade(client: libClient.HttpUpgrade): void {
		const module = this.dispatch(client);
		if (module != null) {
			client.pushLog(module.name);
			module.upgrade(client);
		}
	}
};

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
		libLog.Info(`Wrapping [${handler.name}]`);
		this.requestLambda = request;
		this.upgradeLambda = upgrade;
	}

	public request(client: libClient.HttpRequest): void {
		client.pushLog(this.handler.name);
		this.handler.request(client);
		if (!client.handled() && this.requestLambda != undefined)
			this.requestLambda(client);
	}

	public upgrade(client: libClient.HttpUpgrade): void {
		client.pushLog(this.handler.name);
		this.handler.upgrade(client);
		if (!client.handled() && this.upgradeLambda != undefined)
			this.upgradeLambda(client);
	}
};
