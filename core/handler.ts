/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025-2026 Bjoern Boss Henrichsen */
import * as libClient from "./client.js";
import * as libLog from "./log.js";
import * as libLocation from "./location.js";

export interface MountedModule {
	/* forward the given client to the module, and translate the paths and logging accordingly, if the module
	*	is designated for the client; returns false if the client is still unhandled after the handler */
	handle(client: libClient.HttpRequest | libClient.HttpUpgrade): Promise<boolean>;

	/* detach the mounted module from the parent module handler (registered unmount callback will be invoked before
	*	this detach is completed; clients dispatched to the module will not be disconnected any may still be active) */
	detach(): Promise<void>;

	/* original module that was mount */
	module: ModuleHandler;
}

interface LinkedModules {
	parent: ModuleHandler | null;
	child: ModuleHandler;
	cleanup: () => Promise<void>;
	setup: (() => void) | null;
}

export abstract class ModuleHandler extends libLog.LogIdentity {
	private _stopped: Promise<void> | null;
	private _config: {
		name: string;
		tagName: boolean;
		stopOnUnmount: boolean;
	};
	private _handling: {
		active: Set<libClient.IncomingBase>;
		promise: Promise<void> | null;
		resolver: () => void;
	};
	private _mounting: {
		path: string | null;
		links: Set<LinkedModules>;
		task: {
			promise: Promise<void> | null;
			order: Promise<void>[];
			count: number;
			resolver: () => void;
		};
	};

	protected constructor(name: string) {
		super(`${name}:unmounted`);

		this._config = { name, tagName: true, stopOnUnmount: true };
		this._handling = { active: new Set<libClient.IncomingBase>(), promise: null, resolver: () => { } };
		this._stopped = null;
		this._mounting = { path: null, links: new Set<LinkedModules>(), task: { promise: null, order: [], count: 0, resolver: () => { } } };
	}

	private async drainTaskQueue(connections: boolean, order: Promise<void> | null): Promise<void> {
		const tasks = this._mounting.task;

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
		const task = this._mounting.task;

		if (task.count++ == 0)
			task.promise = new Promise((res) => task.resolver = res);
		promise.then(() => {
			if (--task.count == 0) {
				task.promise = null;
				task.resolver();
			}
		});
	}

	private checkIsModuleMounted(handler: ModuleHandler): boolean {
		for (const entry of handler._mounting.links) {
			if (entry.parent == handler)
				continue;
			if (entry.parent != null && entry.parent._mounting.path == null)
				continue;
			return true;
		}
		return false;
	}
	private async handleIncoming(client: libClient.HttpRequest | libClient.HttpUpgrade): Promise<boolean> {
		/* check if the client is already being handled or has already
		*	been handled and otherwise process any outstanding tasks */
		if (this._handling.active.has(client) || client.claimed)
			return client.claimed;
		await this.drainTaskQueue(false, null);

		/* ensure that the handler is not being shut down and that the client is mounted and push the logging and path */
		if (this._stopped != null || this._mounting.path == null)
			return client.claimed;
		const snapshot = client._pushTranslation(this._mounting.path, this._config.tagName ? this._config.name : '');
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
				await this.handleRequest(client);
			else
				await this.handleUpgrade(client);
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
	private async performMountSelf(path: string): Promise<void> {
		this._mounting.path = path;
		this.logIdentity = `${this._config.name}:${path}`;
		this.info(`Handler mounted`);

		/* push the next ordered promise, to ensure the mount is fully performed before the next unmount */
		let taskResolver = () => { };
		const taskPromise = new Promise<void>((res) => taskResolver = res);
		this._mounting.task.order.push(taskPromise);

		/* trigger any mount calls (may push new independent tasks) */
		for (const link of this._mounting.links) {
			if (link.setup != null)
				link.setup();
		}

		/* drain the current task queue and convert the task back to the unordered next step */
		await this.drainTaskQueue(true, taskPromise);
		this._mounting.task.order.shift();
		this.pushHandleTask(taskPromise);

		/* notify the module itself about the mount */
		try {
			await this.handleMounted(path);
		}
		catch (err: any) {
			this.error(`Unhandled exception while mounting: ${err.message}`);
			this.stop();
		}
		taskResolver();
	}
	private async performUnmountSelf(): Promise<void> {
		if (this._mounting.path == null)
			return;
		this._mounting.path = null;
		this.logIdentity = `${this._config.name}:unmounted`;
		this.info(`Handler unmounted`);

		/* push the next ordered promise, to ensure the unmount is fully performed before the next mount */
		let taskResolver = () => { };
		const taskPromise = new Promise<void>((res) => taskResolver = res);
		this._mounting.task.order.push(taskPromise);

		/* trigger the unmount of all now unmounted children */
		for (const entry of this._mounting.links) {
			if (entry.parent == this && !this.checkIsModuleMounted(entry.child))
				this.pushHandleTask(entry.child.performUnmountSelf());
		}

		/* check if the mount should be stopped due to being unmounted */
		if (this._config.stopOnUnmount)
			this.stop();

		/* kill any current connections and wait for any current tasks and connections to complete */
		for (const client of this._handling.active)
			client._killConnection();
		await this.drainTaskQueue(true, taskPromise);

		/* convert the task back to the unordered next step */
		this._mounting.task.order.shift();
		this.pushHandleTask(taskPromise);

		/* notify the module itself about the unmount */
		try {
			await this.handleUnmount();
		}
		catch (err: any) {
			this.error(`Unhandled exception while unmounting: ${err.message}`);
			this.stop();
		}
		taskResolver();

		/* check if the module was stopped and await the proper stopping */
		if (this._stopped != null)
			await this._stopped;
	}
	private performMountToParent(parent: ModuleHandler | null, path: string, detached: () => void): MountedModule {
		const recSearchParents = (parent: ModuleHandler): boolean => {
			if (parent == this)
				return false;
			for (const entry of parent._mounting.links) {
				if (entry.child == parent && entry.parent != null && !recSearchParents(entry.parent))
					return false;
			}
			return true;
		};
		const validateLinkState = (): string | null => {
			if (this._stopped != null) {
				this.warning(`Stopped module cannot be mounted to [${parent?._config.name ?? 'root'}]`);
				return null;
			}
			let actual = '/';

			if (parent != null) {
				if (parent._stopped != null) {
					this.warning(`Module cannot be mounted to stopped module [${parent._config.name}]`);
					return null;
				}
				if (!recSearchParents(parent)) {
					this.warning('Module cannot be directly or indirectly mounted to itself');
					return null;
				}
				if (parent._mounting.path == null)
					return '';
				actual = libLocation.JoinSanitized(parent._mounting.path, path);
			}

			if (this._mounting.path != null && actual != this._mounting.path) {
				this.warning(`Mounted module cannot be mounted to [${actual}]`);
				return null;
			}
			return actual;
		};

		/* setup the link object and its creation and unmount methods */
		let detaching: Promise<void> | null = null;
		const link: LinkedModules = {
			parent,
			child: this,
			cleanup: async (): Promise<void> => {
				if (detaching != null) return detaching;
				let resolver = () => { };
				detaching = new Promise<void>((res) => resolver = res);
				link.setup = null;

				let taskResolver = () => { }, taskPromise = new Promise<void>((res) => taskResolver = res);

				/* remove the link from the parent and add its cleanup to its task list */
				if (parent != null) {
					parent._mounting.links.delete(link);
					parent.pushHandleTask(taskPromise);
				}

				/* remove the link from this handler and check if the object should be unmounted */
				this._mounting.links.delete(link);
				if (this._mounting.path != null && !this.checkIsModuleMounted(this))
					await this.performUnmountSelf();

				/* start the actual detach call */
				process.nextTick(async () => {
					try { detached(); }
					catch (err: any) {
						this.error(`Unhandled exception while detaching: ${err.message}`);
					}
					taskResolver();

					/* check if the module was stopped, in which case the stop should be awaited before resolving the cleanup promise */
					if (this._stopped != null)
						await this._stopped;
					resolver();
				});
				return detaching;
			},
			setup: (): void => {
				if (detaching != null)
					return;

				/* check if the mount is possible in theory */
				const path = validateLinkState();
				if (path == null)
					link.cleanup();

				/* check if the mount is still uncertain (can only happen once on the first time mounting,
				*	as the second execution is performed after the parent has just been mounted) */
				else if (path != '') {
					link.setup = null;
					if (this._mounting.path == null)
						this.performMountSelf(path);
				}
			}
		};

		/* register the link between the parent and this handler */
		this._mounting.links.add(link);
		if (parent != null)
			parent._mounting.links.add(link);

		/* try to immediately perform the initial load and setup the mount handler */
		link.setup!();
		return {
			handle: (client) => (detaching != null ? Promise.resolve(client.claimed) : this.handleIncoming(client)),
			detach: () => link.cleanup(),
			module: this
		};
	}

	public _mountToRoot(detached: () => void): MountedModule {
		return this.performMountToParent(null, '/', detached);
	}

	/* module is reachable under the given path on the web server (will be the first call being performed before any other calls) */
	protected async handleMounted(path: string): Promise<void> { const _ = path; }

	/* handle the client request (guaranteed to not have been claimed yet; if the promise
	*	resolves, client must either have been handled or must not be handled anymore) */
	protected async handleRequest(client: libClient.HttpRequest): Promise<void> { const _ = client; }

	/* handle the client upgrade (guaranteed to not have been claimed yet; if the promise
	*	resolves, client must either have been handled or must not be handled anymore) */
	protected async handleUpgrade(client: libClient.HttpUpgrade): Promise<void> { const _ = client; }

	/* this module has been unmounted (not necessarily stopped, but at least not attached to the URL space anymore; will only
	*	be called after a mount call; all clients are guaranteed to have left, but accepted WebSockets will be left intact) */
	protected async handleUnmount(): Promise<void> { }

	/* stop this module (will only be called when unmounted; will only be called once; module should cleanup any resources and timers;
	*	will only be called once; WebSockets will not be closed automatically and must be closed manually by the module handler) */
	protected async handleStop(): Promise<void> { }

	/* name of the module */
	public get moduleName(): string {
		return this._config.name;
	}

	/* enable or disable the module tagging the logging output [default: true] */
	public tagName(tag: boolean): this {
		this._config.tagName = tag;
		return this;
	}

	/* enable or disable the module being stopped once unmounted the next time from the URL space [default: true] */
	public stopOnUnmount(stop: boolean): this {
		this._config.stopOnUnmount = stop;
		return this;
	}

	/* mount the child to this module at the optional given path relative to this module (detached will be called once
	*	the child has been removed or is identified to not be suited for this module; will not be called if this module
	*	is not mounted or will not be mounted anymore; unless already destroyed) */
	public attachChild(child: ModuleHandler, detached?: () => void, path?: string): MountedModule {
		return child.performMountToParent(this, path ?? '/', (detached == null ? () => { } : detached));
	}

	/* convert the module relative path to a path in URL space (empty string if not mounted) */
	public makePath(path?: string): string {
		if (this._mounting.path == null)
			return '';
		if (path == null)
			return this._mounting.path;
		return libLocation.JoinSanitized(this._mounting.path, path);
	}

	/* close any connections to the module and stop the module itself (stopping must not
	*	be awaited while stopping itself or a parent as this can result in deadlocks) */
	public async stop(): Promise<void> {
		if (this._stopped != null)
			return this._stopped;
		this.info('Handler stopped');

		/* setup the stopped-promise (before performing any operations, as the first operations might otherwise
		*	call stop again, without the stopped-promise value being set, thereby recursively stopping again) */
		let resolver = () => { };
		this._stopped = new Promise<void>((res) => resolver = res);

		/* trigger the unmounting and kill all links and drain the remaining task queue (no
		*	need to kill connections manually, as the unmounting will take care of this) */
		this.performUnmountSelf();
		for (const link of this._mounting.links)
			link.cleanup();
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

export type MountLambda = (path: string, self: ModuleHandler) => Promise<void>;
export type RequestLambda = (client: libClient.HttpRequest) => Promise<void>;
export type UpgradeLambda = (client: libClient.HttpUpgrade) => Promise<void>;
export type StopLambda = () => Promise<void>;
export type RequestWrap = (client: libClient.HttpRequest, handle: () => Promise<boolean>) => Promise<void>;
export type UpgradeWrap = (client: libClient.HttpUpgrade, handle: () => Promise<boolean>) => Promise<void>;

/*
*	Simple module handler implementation, which allows requests to be handled by lambdas.
*/
export class LambdaModule extends ModuleHandler {
	private mountLambda?: MountLambda;
	private requestLambda?: RequestLambda;
	private upgradeLambda?: UpgradeLambda;
	private stopLambda?: StopLambda;

	constructor(options?: { mount?: MountLambda, request?: RequestLambda, upgrade?: UpgradeLambda, stop?: StopLambda, name?: string }) {
		super(options?.name ?? 'lambda');
		this.mountLambda = options?.mount;
		this.requestLambda = options?.request;
		this.upgradeLambda = options?.upgrade;
		this.stopLambda = options?.stop;
	}

	protected override async handleMounted(path: string): Promise<void> {
		if (this.mountLambda != null)
			await this.mountLambda(path, this);
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
	private mapping: Record<string, MountedModule>;

	constructor(map: Record<string, ModuleHandler>) {
		super('dispatch');
		this.mapping = {};

		for (const [key, handler] of Object.entries(map)) {
			if (key in this.mapping) {
				this.warning(`Ignoring duplicate mapping [${key}] by [${handler.moduleName}]`);
				continue;
			}

			this.info(`Binding path [${key}] to [${handler.moduleName}]`);
			this.mapping[key] = this.attachChild(handler, () => {
				delete this.mapping[key];
				if (Object.keys(this.mapping).length == 0)
					this.stop();
			}, key);
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
			client.trace(`Client dispatched to handler [${this.mapping[bestMatch].module.moduleName}] for path [${bestMatch}]`);
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
*	Simple module handler implementation, which dispatches requests to different children based on the request hostname (longest match).
*	Stops itself once all children have been stopped.
*/
export class HostModule extends ModuleHandler {
	private mapping: Record<string, MountedModule>;

	constructor(map: Record<string, ModuleHandler>) {
		super('host');

		this.mapping = {};
		for (const [host, handler] of Object.entries(map)) {
			if (host in this.mapping) {
				this.warning(`Ignoring duplicate mapping of host [${host}] by [${handler.moduleName}]`);
				continue;
			}

			this.info(`Binding host [${host}] to [${handler.moduleName}]`);
			this.mapping[host] = this.attachChild(handler, () => {
				delete this.mapping[host];
				if (Object.keys(this.mapping).length == 0)
					this.stop();
			});
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
			client.trace(`Client dispatched to handler [${this.mapping[bestMatch].module.moduleName}] for host [${bestMatch}]`);
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
	private handler: MountedModule;
	private requestLambda?: RequestLambda;
	private upgradeLambda?: UpgradeLambda;

	constructor(handler: ModuleHandler, options?: { request?: RequestLambda, upgrade?: UpgradeLambda }) {
		super('unhandler');

		this.handler = this.attachChild(handler, () => this.stop());
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
}

/*
*	Simple module interface implementation, which forwards any requests to a lambda.
*	Stops itself once all children have been stopped.
*/
export class WrapModule extends ModuleHandler {
	private handler: MountedModule;
	private requestWrap?: RequestWrap;
	private upgradeWrap?: UpgradeWrap;

	constructor(handler: ModuleHandler, options?: { request?: RequestWrap, upgrade?: UpgradeWrap }) {
		super('wrap');

		this.handler = this.attachChild(handler, () => this.stop());
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
}
