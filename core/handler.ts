/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025-2026 Bjoern Boss Henrichsen */
import * as libClient from "./client.js";
import * as libLog from "./log.js";
import * as libLocation from "./location.js";

/* translation to be used for any paths when processing the client
*	just a string maps: [/value] => [/]
*	any mapping maps the client paths to the new path (matched by longest path) */
export type PathTranslation = Record<string, string> | string;

export interface AttachedModule {
	/* forward the given client to the module, and translate the paths and logging accordingly, if the module is
	*	designated for the client; returns false if the client is still unhandled after the handler; params are
	*	passed on to the module without modification; no translation is equivalent to [/] => [/]; the translation
	*	is applied for the nested client and reversed for any paths produced by the client */
	handle(client: libClient.HttpRequest | libClient.HttpUpgrade, params?: object, translate?: PathTranslation): Promise<boolean>;

	/* detach the module from the parent module handler (registered unlinked callback will be invoked before this promise
	*	is completed; clients dispatched to the module will not be disconnected directly any may still be active) */
	unlink(): Promise<void>;

	/* original module that was attached */
	module: ModuleHandler;
}

interface LinkedModules {
	parent: ModuleHandler | null;
	child: ModuleHandler;
	cleanup: () => Promise<void>;
	setup: ((realized: Promise<void> | null) => void) | null;
}
let NextModuleId: number = 0;

export abstract class ModuleHandler extends libLog.LogIdentity {
	private _stopped: Promise<void> | null;
	private _config: {
		name: string;
		tagLogs: boolean;
		tagString: string;
		stopOnDetach: boolean;
		id: number;
	};
	private _handling: {
		active: Set<libClient.IncomingBase>;
		promise: Promise<void> | null;
		resolver: () => void;
	};
	private _attachment: {
		links: Set<LinkedModules>;
		attached: boolean;
		task: {
			promise: Promise<void> | null;
			order: Promise<void>[];
			count: number;
			resolver: () => void;
		};
	};

	protected constructor(name: string) {
		const thisModuleId = ++NextModuleId;
		super(`${name}!${thisModuleId}`);

		this._config = { name, tagLogs: true, tagString: '', stopOnDetach: true, id: thisModuleId };
		this._handling = { active: new Set<libClient.IncomingBase>(), promise: null, resolver: () => { } };
		this._stopped = null;
		this._attachment = { links: new Set<LinkedModules>(), attached: false, task: { promise: null, order: [], count: 0, resolver: () => { } } };
	}

	private async drainTaskQueue(connections: boolean, order: Promise<void> | null): Promise<void> {
		const tasks = this._attachment.task;

		/* wait for the tasks and connections to drain accordingly */
		while (true) {
			const promises = [];

			if (tasks.promise != null)
				promises.push(tasks.promise);
			if (connections && this._handling.promise != null)
				promises.push(this._handling.promise);
			const index = (order == null ? tasks.order.length - 1 : tasks.order.indexOf(order) - 1);
			if (index >= 0)
				promises.push(tasks.order[index]);

			if (promises.length == 0)
				return;
			await Promise.all(promises);
		}
	}
	private pushHandleTask(promise: Promise<void>): void {
		const task = this._attachment.task;

		if (task.count++ == 0)
			task.promise = new Promise((res) => task.resolver = res);
		promise.then(() => {
			if (--task.count == 0) {
				task.promise = null;
				task.resolver();
			}
		});
	}

	private checkIsModuleAttached(handler: ModuleHandler): boolean {
		for (const entry of handler._attachment.links) {
			if (entry.parent == handler)
				continue;
			if (entry.parent != null && !entry.parent._attachment.attached)
				continue;
			return true;
		}
		return false;
	}
	private async handleIncoming(client: libClient.HttpRequest | libClient.HttpUpgrade, params?: object, translate?: PathTranslation): Promise<boolean> {
		/* check if the client is already being handled or has already
		*	been handled and otherwise process any outstanding tasks */
		if (this._handling.active.has(client) || client.claimed)
			return client.claimed;
		await this.drainTaskQueue(false, null);

		/* ensure that the handler is attached and push the mapping and path (client will validate it) */
		if (!this._attachment.attached)
			return client.claimed;
		const mapping = (typeof translate == 'object' ? translate : { [translate ?? '/']: '/' });
		const logTag = (this._config.tagLogs ? (this._config.tagString == '' ? this._config.name : this._config.tagString) : '');
		const snapshot = client._pushTranslation(mapping, logTag);
		if (snapshot == null)
			return client.claimed;

		/* check if the cleanup handler needs to be setup and push the client in general to be handled right now */
		if (this._handling.active.size == 0)
			this._handling.promise = new Promise<void>((res) => this._handling.resolver = res);
		this._handling.active.add(client);

		/* handle the client but ensure to catch any exceptions and re-throw them once the handler has been cleaned up */
		let error = null;
		try {
			if (client instanceof libClient.HttpRequest)
				await this.handleRequest(client, params);
			else
				await this.handleUpgrade(client, params);
		} catch (err: any) {
			error = err;
		}

		/* restore the context, clear the handling promise and remove the client from actively handled clients */
		this._handling.active.delete(client);
		client._restoreSnapshot(snapshot);
		if (this._handling.active.size == 0) {
			this._handling.promise = null;
			this._handling.resolver();
		}

		if (error != null)
			throw error;
		return client.claimed;
	}
	private async performAttachSelf(): Promise<void> {
		this._attachment.attached = true;

		/* push the next ordered promise, to ensure the attach is fully performed before the next detach */
		let taskResolver = () => { };
		const taskPromise = new Promise<void>((res) => taskResolver = res);
		this._attachment.task.order.push(taskPromise);

		/* trigger any attach calls (may push new independent tasks) */
		for (const link of this._attachment.links) {
			if (link.setup != null)
				link.setup(taskPromise);
		}

		/* drain the current task queue and convert the task back to the unordered next step */
		await this.drainTaskQueue(true, taskPromise);
		this._attachment.task.order.shift();
		this.pushHandleTask(taskPromise);

		/* notify the module itself about the attached */
		try {
			await this.handleAttached();
		}
		catch (err: any) {
			this.error(`Unhandled exception while attaching: ${err.message}`);
			this.stop();
		}
		taskResolver();
	}
	private async performDetachSelf(): Promise<void> {
		if (!this._attachment.attached)
			return;
		this._attachment.attached = false;

		/* push the next ordered promise, to ensure the detach is fully performed before the next attach */
		let taskResolver = () => { };
		const taskPromise = new Promise<void>((res) => taskResolver = res);
		this._attachment.task.order.push(taskPromise);

		/* trigger the detach of all now detached children */
		for (const entry of this._attachment.links) {
			if (entry.parent == this && !this.checkIsModuleAttached(entry.child))
				this.pushHandleTask(entry.child.performDetachSelf());
		}

		/* check if the module should be stopped due to being detached */
		if (this._config.stopOnDetach)
			this.stop();

		/* kill any current connections and wait for any current tasks and connections to complete */
		for (const client of this._handling.active)
			client._killConnection();
		await this.drainTaskQueue(true, taskPromise);

		/* convert the task back to the unordered next step */
		this._attachment.task.order.shift();
		this.pushHandleTask(taskPromise);

		/* notify the module itself about the detached */
		try {
			await this.handleDetached();
		}
		catch (err: any) {
			this.error(`Unhandled exception while detaching: ${err.message}`);
			this.stop();
		}
		taskResolver();

		/* check if the module was stopped and await the proper stopping */
		if (this._stopped != null)
			await this._stopped;
	}
	private performAttachToParent(parent: ModuleHandler | null, unlinked: () => void, detail: string): AttachedModule {
		const recSearchParents = (parent: ModuleHandler): boolean => {
			if (parent == this)
				return false;
			for (const entry of parent._attachment.links) {
				if (entry.child == parent && entry.parent != null && !recSearchParents(entry.parent))
					return false;
			}
			return true;
		};
		const validateLinkState = (): boolean => {
			if (this._stopped != null) {
				this.warning(`Stopped module cannot be attached to [${parent?.logIdentity ?? 'root'}]`);
				return false;
			}

			if (parent == null)
				return true;
			if (parent._stopped != null) {
				this.warning(`Module cannot be attached to stopped module [${parent.logIdentity}]`);
				return false;
			}
			if (!recSearchParents(parent)) {
				this.warning('Module cannot be directly or indirectly attach to itself');
				return false;
			}
			return true;
		};
		if (detail != '')
			detail = `: ${detail}`;

		/* setup the link object and its creation and cleanup methods */
		let unlinkPromise: Promise<void> | null = null;
		let taskPromise: Promise<void> | null = null;
		let logged: boolean = false;
		const link: LinkedModules = {
			parent,
			child: this,
			setup: async (realized: Promise<void> | null): Promise<void> => {
				if (unlinkPromise != null)
					return;

				/* check if the attachment is possible in theory */
				if (!validateLinkState())
					link.cleanup();

				/* check if the attachment is still certain (uncertainty can only happen once on the first time
				*	attaching, as the second execution is performed after the parent has just been attached) */
				else if (parent == null || parent._attachment.attached) {
					link.setup = null;
					if (!this._attachment.attached) {
						if (realized != null)
							this.pushHandleTask(realized);
						await this.performAttachSelf();
					}

					if (logged = (unlinkPromise == null))
						this.info(`Attached to [${parent?.logIdentity ?? 'root'}]${detail}`);
				}
			},
			cleanup: async (): Promise<void> => {
				if (unlinkPromise != null) return unlinkPromise;
				let unlinkResolver = () => { }, taskResolver = () => { };
				unlinkPromise = new Promise<void>((res) => unlinkResolver = res);
				taskPromise = new Promise<void>((res) => taskResolver = res);
				link.setup = null;
				if (logged)
					this.info(`Detached from [${parent?.logIdentity ?? 'root'}]${detail}`);

				/* remove the link from the parent and add its cleanup to its task list (cleanup calls are only linked as task to the parent,
				*	as the child does not care for them; this implies that the module's stop method itself does not await them either) */
				if (parent != null) {
					parent._attachment.links.delete(link);
					parent.pushHandleTask(taskPromise);
				}

				/* remove the link from this handler and check if the object should be detached */
				this._attachment.links.delete(link);
				if (this._attachment.attached && !this.checkIsModuleAttached(this))
					await this.performDetachSelf();

				/* start the actual unlink call */
				process.nextTick(async () => {
					try { unlinked(); }
					catch (err: any) {
						this.error(`Unhandled exception while unlinking: ${err.message}`);
					}
					taskResolver();

					/* check if the module was stopped, in which case the stop should be awaited before resolving the cleanup promise */
					if (this._stopped != null)
						await this._stopped;
					unlinkResolver();
				});
				return unlinkPromise;
			}
		};

		/* register the link between the parent and this handler */
		this._attachment.links.add(link);
		if (parent != null)
			parent._attachment.links.add(link);

		/* try to immediately perform the initial load and setup the attach module interface */
		link.setup!(null);
		return {
			handle: (client, params, translate) => (unlinkPromise != null ? Promise.resolve(client.claimed) : this.handleIncoming(client, params, translate)),
			unlink: () => link.cleanup(),
			module: this
		};
	}

	public _attachToRoot(unlinked: () => void): AttachedModule {
		return this.performAttachToParent(null, unlinked, '');
	}

	/* module is attached directly or indirectly to the server (will be the first call being performed before any other calls) */
	protected async handleAttached(): Promise<void> { }

	/* handle the client request (guaranteed to not have been claimed yet; if the promise
	*	resolves, client must either have been handled or must not be handled anymore) */
	protected async handleRequest(client: libClient.HttpRequest, params?: object): Promise<void> { const _0 = client, _1 = params; }

	/* handle the client upgrade (guaranteed to not have been claimed yet; if the promise
	*	resolves, client must either have been handled or must not be handled anymore) */
	protected async handleUpgrade(client: libClient.HttpUpgrade, params?: object): Promise<void> { const _0 = client, _1 = params; }

	/* module has been detached and it not attached to the server anymore, but not yet stopped
	*	(will only be called after an attach call; all clients are guaranteed to have left, but
	*	accepted WebSockets will be left intact and must be closed manually by this module) */
	protected async handleDetached(): Promise<void> { }

	/* stop this module (will only be called when detached; will only be called once; module should
	*	cleanup any resources and timers and cleanup any remaining WebSockets not disonnected on detach) */
	protected async handleStop(): Promise<void> { }

	/* name of the module */
	public get moduleName(): string {
		return this._config.name;
	}

	/* enable or disable the module tagging the logging output [default: true] */
	public tagLogs(tag: boolean): this {
		this._config.tagLogs = tag;
		return this;
	}

	/* set the tagging string the module should use in the logging with empty string being module name [default: ''] */
	public tagString(tag: string): this {
		this._config.tagString = tag;
		return this;
	}

	/* enable or disable the module being stopped once detached the next time from the server [default: true] */
	public stopOnDetach(stop: boolean): this {
		this._config.stopOnDetach = stop;
		return this;
	}

	/* link the child to this module (unlinked will be called once the child has been removed or is identified to not
	*	be suited for this module; will not be called if this module is not attached or will not be attached anymore;
	*	unless already destroyed; detail is an additional information to be logged upon linking and unlinking) */
	public linkChild(child: ModuleHandler, unlinked?: () => void, detail?: string): AttachedModule {
		return child.performAttachToParent(this, (unlinked == null ? () => { } : unlinked), detail ?? '');
	}

	/* close any connections to the module and stop the module itself (stopping must not
	*	be awaited while stopping itself or a parent as this can result in deadlocks) */
	public async stop(): Promise<void> {
		if (this._stopped != null)
			return this._stopped;

		/* setup the stopped-promise (before performing any operations, as the first operations might otherwise
		*	call stop again, without the stopped-promise value being set, thereby recursively stopping again) */
		let resolver = () => { };
		this._stopped = new Promise<void>((res) => resolver = res);

		/* trigger the detaching and kill all links and drain the remaining task queue (no need to kill connections manually,
		*	as the detaching will take care of this; will not await the unlinked calls of links where this element is the child) */
		this.performDetachSelf();
		for (const link of this._attachment.links)
			link.cleanup();
		this.info('Handler stopped');
		await this.drainTaskQueue(true, null);

		try {
			await this.handleStop();
		}
		catch (err: any) {
			this.error(`Unhandled exception while stopping: ${err.message}`);
		}

		resolver();
		return this._stopped;
	}
}

export type AttachLambda = (self: ModuleHandler) => Promise<void>;
export type DetachLambda = () => Promise<void>;
export type RequestLambda = (client: libClient.HttpRequest, params?: object) => Promise<void>;
export type UpgradeLambda = (client: libClient.HttpUpgrade, params?: object) => Promise<void>;
export type StopLambda = () => Promise<void>;
export type RequestWrap = (client: libClient.HttpRequest, handle: (params?: object, translate?: PathTranslation) => Promise<boolean>, params?: object) => Promise<void>;
export type UpgradeWrap = (client: libClient.HttpUpgrade, handle: (params?: object, translate?: PathTranslation) => Promise<boolean>, params?: object) => Promise<void>;

/*
*	Simple module handler implementation, which allows requests to be handled by lambdas.
*	Forwards parameter to lambda functions.
*/
export class LambdaModule extends ModuleHandler {
	private attachLambda?: AttachLambda;
	private detachLambda?: DetachLambda;
	private requestLambda?: RequestLambda;
	private upgradeLambda?: UpgradeLambda;
	private stopLambda?: StopLambda;

	constructor(options?: { attach?: AttachLambda, detach?: DetachLambda, request?: RequestLambda, upgrade?: UpgradeLambda, stop?: StopLambda, name?: string }) {
		super(options?.name ?? 'lambda');
		this.attachLambda = options?.attach;
		this.detachLambda = options?.detach;
		this.requestLambda = options?.request;
		this.upgradeLambda = options?.upgrade;
		this.stopLambda = options?.stop;
	}

	protected override async handleAttached(): Promise<void> {
		if (this.attachLambda != null)
			await this.attachLambda(this);
	}
	protected override async handleRequest(client: libClient.HttpRequest, params?: object): Promise<void> {
		if (this.requestLambda != null)
			await this.requestLambda(client, params);
	}
	protected override async handleUpgrade(client: libClient.HttpUpgrade, params?: object): Promise<void> {
		if (this.upgradeLambda != null)
			await this.upgradeLambda(client, params);
	}
	protected override async handleDetached(): Promise<void> {
		if (this.detachLambda != null)
			await this.detachLambda();
	}
	protected override async handleStop(): Promise<void> {
		if (this.stopLambda != null)
			await this.stopLambda();
	}
}

/*
*	Simple module handler implementation, which dispatches requests to different children based on the request path (longest match).
*	Stops itself once all children have been stopped.
*	Forwards parameter to dispatched child.
*/
export class DispatchModule extends ModuleHandler {
	private mapping: Record<string, AttachedModule>;

	constructor(map: Record<string, ModuleHandler>) {
		super('dispatch');
		this.mapping = {};

		for (const [key, handler] of Object.entries(map)) {
			if (key in this.mapping) {
				this.warning(`Ignoring duplicate mapping [${key}] by [${handler.logIdentity}]`);
				continue;
			}

			this.mapping[key] = this.linkChild(handler, () => {
				delete this.mapping[key];
				if (Object.keys(this.mapping).length == 0)
					this.stop();
			}, `Bound to path [${key}]`);
		}

		if (Object.keys(this.mapping).length == 0)
			this.stop();
	}

	private async dispatchAndHandle(client: libClient.HttpRequest | libClient.HttpUpgrade, params?: object): Promise<void> {
		let bestMatch: string | null = null;

		/* iterate over the mappings and look for the corresponding best handler */
		for (const path in this.mapping) {
			if (!libLocation.IsSubDirectory(path, client.path))
				continue;
			if (bestMatch == null || bestMatch.length < path.length)
				bestMatch = path;
		}

		if (bestMatch != null) {
			client.trace(`Client dispatched to handler [${this.mapping[bestMatch].module.logIdentity}] for path [${bestMatch}]`);
			await this.mapping[bestMatch].handle(client, params, bestMatch);
		}
		else
			client.trace(`Request cannot be dispatched`);
	}

	protected override async handleRequest(client: libClient.HttpRequest, params?: object): Promise<void> {
		return this.dispatchAndHandle(client, params);
	}
	protected override async handleUpgrade(client: libClient.HttpUpgrade, params?: object): Promise<void> {
		return this.dispatchAndHandle(client, params);
	}
}

/*
*	Simple module handler implementation, which dispatches requests to different children based on the request hostname (longest match).
*	Stops itself once all children have been stopped.
*	Forwards parameter to dispatched child.
*/
export class HostModule extends ModuleHandler {
	private mapping: Record<string, AttachedModule>;

	constructor(map: Record<string, ModuleHandler>) {
		super('host');

		this.mapping = {};
		for (const [host, handler] of Object.entries(map)) {
			if (host in this.mapping) {
				this.warning(`Ignoring duplicate mapping of host [${host}] by [${handler.logIdentity}]`);
				continue;
			}

			this.mapping[host] = this.linkChild(handler, () => {
				delete this.mapping[host];
				if (Object.keys(this.mapping).length == 0)
					this.stop();
			}, `Bound to host [${host}]`);
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
	private async dispatchAndHandle(client: libClient.HttpRequest | libClient.HttpUpgrade, params?: object): Promise<void> {
		let bestMatch: string | null = null;

		/* iterate over the mappings and look for the corresponding best handler */
		for (const host in this.mapping) {
			if (!this.testSubHost(host, client.url.hostname))
				continue;
			if (bestMatch == null || bestMatch.length < host.length)
				bestMatch = host;
		}

		if (bestMatch != null) {
			client.trace(`Client dispatched to handler [${this.mapping[bestMatch].module.logIdentity}] for host [${bestMatch}]`);
			await this.mapping[bestMatch].handle(client, params);
		}
		else
			client.trace(`Request cannot be dispatched`);
	}

	protected override async handleRequest(client: libClient.HttpRequest, params?: object): Promise<void> {
		return this.dispatchAndHandle(client, params);
	}
	protected override async handleUpgrade(client: libClient.HttpUpgrade, params?: object): Promise<void> {
		return this.dispatchAndHandle(client, params);
	}
}

/*
*	Simple module interface implementation, which forwards unhandled requests to a lambda.
*	Stops itself once all children have been stopped.
*	Forwards parameter to wrapper and handler.
*/
export class UnhandledModule extends ModuleHandler {
	private handler: AttachedModule;
	private requestLambda?: RequestLambda;
	private upgradeLambda?: UpgradeLambda;

	constructor(handler: ModuleHandler, options?: { request?: RequestLambda, upgrade?: UpgradeLambda }) {
		super('unhandler');

		this.handler = this.linkChild(handler, () => this.stop());
		this.requestLambda = options?.request;
		this.upgradeLambda = options?.upgrade;
	}

	protected override async handleRequest(client: libClient.HttpRequest, params?: object): Promise<void> {
		await this.handler.handle(client, params);
		if (client.unhandled && this.requestLambda != null)
			await this.requestLambda(client, params);
	}
	protected override async handleUpgrade(client: libClient.HttpUpgrade, params?: object): Promise<void> {
		await this.handler.handle(client, params);
		if (client.unhandled && this.upgradeLambda != null)
			await this.upgradeLambda(client, params);
	}
}

/*
*	Simple module interface implementation, which forwards any requests to a lambda.
*	Stops itself once all children have been stopped.
*	Forwards parameter to wrapper or handler.
*/
export class WrapModule extends ModuleHandler {
	private handler: AttachedModule;
	private requestWrap?: RequestWrap;
	private upgradeWrap?: UpgradeWrap;

	constructor(handler: ModuleHandler, options?: { request?: RequestWrap, upgrade?: UpgradeWrap }) {
		super('wrap');

		this.handler = this.linkChild(handler, () => this.stop());
		this.requestWrap = options?.request;
		this.upgradeWrap = options?.upgrade;
	}

	protected override async handleRequest(client: libClient.HttpRequest, params?: object): Promise<void> {
		if (this.requestWrap != null)
			await this.requestWrap(client, (p?: object, t?: PathTranslation) => this.handler.handle(client, p, t), params);
		else
			await this.handler.handle(client, params);
	}
	protected override async handleUpgrade(client: libClient.HttpUpgrade, params?: object): Promise<void> {
		if (this.upgradeWrap != null)
			await this.upgradeWrap(client, (p?: object, t?: PathTranslation) => this.handler.handle(client, p, t), params);
		else
			await this.handler.handle(client, params);
	}
}
