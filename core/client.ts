/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import { Config as libConfig } from "./config.js";
import * as libTemplates from "./templates.js";
import * as libLog from "./log.js";
import * as libLocation from "./location.js";
import * as libBuilder from "./builder.js";
import * as libCache from "./cache.js";
import * as libRequest from "./request.js";
import * as libFs from "fs";
import * as libStream from "stream";
import * as libUrl from "url";
import * as libWs from "ws";
import * as libHttp from "http";

const NOT_DECODED_STRING: Record<string, string> = {
	'\x00': '%00', '\x01': '%01', '\x02': '%02', '\x03': '%03',
	'\x04': '%04', '\x05': '%05', '\x06': '%06', '\x07': '%07',
	'\x08': '%08', '\x09': '%09', '\x0A': '%0A', '\x0B': '%0B',
	'\x0C': '%0C', '\x0D': '%0D', '\x0E': '%0E', '\x0F': '%0F',
	'\x10': '%10', '\x11': '%11', '\x12': '%12', '\x13': '%13',
	'\x14': '%14', '\x15': '%15', '\x16': '%16', '\x17': '%17',
	'\x18': '%18', '\x19': '%19', '\x1A': '%1A', '\x1B': '%1B',
	'\x1C': '%1C', '\x1D': '%1D', '\x1E': '%1E', '\x1F': '%1F',
	'\x7F': '%7F', '/': '%2F', '\\': '%5C'
};
const BAD_HEADER_VALUE_REGEX: RegExp = /[\x00-\x1f\x7f]/;

let NextClientId: number = 0;

export class ClientContext {
	public logIdentity: string;
	public basePath: string;
	public path: string;

	constructor(logIdentity: string, basePath: string, path: string) {
		this.logIdentity = logIdentity;
		this.basePath = basePath;
		this.path = path;
	}
}

export class ClientBase extends libLog.LogIdentity {
	protected _url: libUrl.URL;
	protected _path: string;
	protected _fullPath: string;
	protected _basePath: string;

	protected constructor(url: libUrl.URL, client: boolean);
	protected constructor(client: ClientBase);
	protected constructor(arg: libUrl.URL | ClientBase, client?: boolean) {
		if (arg instanceof libUrl.URL) {
			const thisClientId = ++NextClientId;
			super(`${client ? 'client' : 'upgrade'}!${thisClientId}`);

			/* decode the string and re-encode it to ensure '/' and '\' and control
			*	characters are preserved as URI encoding, but the rest is decoded */
			const cleanPath: string = arg.pathname.split('/').map((segment) => {
				let output = '';
				for (const c of decodeURIComponent(segment))
					output += (NOT_DECODED_STRING[c] ?? c);
				return output;
			}).join('/');

			this.id = thisClientId;
			this._path = libLocation.Sanitize(cleanPath, false);
			this._url = arg;
			this._fullPath = this._path;
			this._basePath = '/';
		}
		else {
			super(arg.logIdentity);
			this._path = arg._path;
			this._url = arg.url;
			this._fullPath = arg._fullPath;
			this._basePath = arg._basePath;
			this.id = arg.id;
		}
	}

	/* unique id to identify client in logs */
	readonly id: number;

	/* path relative to current module base-path */
	public get path(): string {
		return this._path;
	}

	/* absolute path on web-server */
	public get basePath(): string {
		return this._basePath;
	}

	/* base path between the fullPath and path */
	public get fullPath(): string {
		return this._fullPath;
	}

	/* raw request origin (no host will result in '_') */
	public get url(): libUrl.URL {
		return this._url;
	}

	/* create a path relative to the current translation base */
	public makePath(path: string): string {
		return libLocation.JoinSanitized(this._basePath, path);
	}

	/* preserve the current logging and translation and tag the logging with the given identity and return a snapshot of the old context */
	public tagLog(identity: string): ClientContext {
		const current = new ClientContext(this.logIdentity, this._basePath, this._path);
		this.logIdentity = `${this.logIdentity}.${identity}`;
		return current;
	}

	/* preserve the current logging and translation and return a snapshot of it */
	public snapshot(): ClientContext {
		return new ClientContext(this.logIdentity, this._basePath, this._path);
	}

	/* restore a client log and translation and context and return the previous context */
	public restore(snapshot: ClientContext): ClientContext {
		const current = new ClientContext(this.logIdentity, this._basePath, this._path);
		this.logIdentity = snapshot.logIdentity;
		this._basePath = snapshot.basePath;
		this._path = snapshot.path;
		return current;
	}
}

/* look at the state and modify the headers accordingly (only add or remove headers, must not try to alter the response) */
export type HeaderPatch = (status: libRequest.StatusType, headers: Record<string, string>, error: boolean) => void;

/* look at the page and modify it or the headers accordingly (return true if this was only a light/shallow
*	build, due to a HEAD request; can be interrupted by returning an alternate response marked as an error) */
export type HtmlPatch = (page: libBuilder.HtmlPage, status: libRequest.StatusType, headers: Record<string, string>, shouldLightBuild: boolean) => boolean;

enum ReceiveState {
	none,
	receiving,
	completed
}
enum ResponseState {
	none,
	acknowledged,
	headerSent,
	completed,
	broken
}

/*
*	Does not throw any exceptions, unless explicitly stated.
*
*	Request is considered acknowledged, as soon as a response has been triggered or a preparation started.
*	Paths are URI decoded, except for nested '/' and '\' and any control characters
*	A request can only be responded to once, unless the response is marked as an error, in which
*		case it will either be sent (if possible) or the connection will be flushed and closed
*	Not responded to requests will result in [not-found]
*
*	All responses, which dont follow the normal execution path, should be marked as errors
*	Errors can bypass already promised responses, or kill the connection (if a response has already been sent)
*	Errors automatically add Config.errorCacheControl, if no other cache control is specified
*	Normal responses automatically add Config.responseCacheControl, if no other cache control is specified
*/
export abstract class IncomingBase extends ClientBase {
	protected request: libHttp.IncomingMessage;
	protected headerPatchers: HeaderPatch[];
	protected state: ResponseState;
	private throughput: { timer: NodeJS.Timeout, processed: number, start: number };
	private processed: { promise: Promise<void>, resolve?: () => void };

	/* write the given header and content out (no need to update state; body may be null for HEAD responses of unknown size) */
	protected abstract finalizeBufferHeader(status: libRequest.StatusType, error: boolean, headers: Record<string, string>, content: { media: libRequest.MediaType, body: Buffer | null } | null): void;

	/* finish handling the request (if an error is returned or the connection is marked
	*	as broken afterwards, will be killed gracefully, until graceful timeout elapses) */
	protected abstract handleFinishing(): Promise<Error | null>;

	/* kill the current connection (if graceful, wait for the last queued data to be sent; may be called multiple times) */
	protected abstract handleKilling(graceful: boolean, reason: Error): Promise<void>;

	constructor(request: libHttp.IncomingMessage, host: string, protocol: string, client: boolean) {
		super(new libUrl.URL(`${protocol}//${host == '' ? '_' : host}${request.url}`), client);
		this.request = request;
		this.state = ResponseState.none;
		this.headerPatchers = [];

		let resolver: any = null;
		this.processed = { promise: new Promise<void>((resolve) => resolver = resolve) };
		this.processed.resolve = resolver;

		/* setup the throughput measurement to detect any stalling connections (offset the processed
		*	count by the startup time to ensure the connection has time before the throughput is enforced) */
		this.throughput = {
			timer: setTimeout(() => this.checkThroughput(), libConfig.throughputCheck),
			processed: (libConfig.throughputStartup * libConfig.throughputThreshold) / 1000.0,
			start: Date.now()
		};
	}

	private checkThroughput(): void {
		const throughput = 1000.0 * (this.throughput.processed / Math.max(1, Date.now() - this.throughput.start));
		this.throughput.timer = setTimeout(() => this.checkThroughput(), libConfig.throughputCheck);

		/* check if the connection should be closed (if this is the first response, give it one check
		*	cycle grace to process the response, but mark it as broken to ensure it will be closed) */
		if (throughput >= libConfig.throughputThreshold)
			return;
		if (this.state != ResponseState.completed && this.state != ResponseState.broken)
			this.respondRequestTimeout(`too low throughput of [${Math.round(throughput)}] bytes/sec`, { error: true });
		else {
			this.error(`Closing connection due to too low throughput of [${Math.round(throughput)}] bytes/sec`);
			this.handleKilling(false, new Error('Throughput too low'));
		}
		this.state = ResponseState.broken;
	}
	protected updateThroughput(delta: number): void {
		this.throughput.processed += delta;
	}
	private constructQuickResponse(status: libRequest.StatusType, logReason: string, error: boolean | undefined, headers: Record<string, string> | undefined, content: { media: libRequest.MediaType, body: Buffer } | null): void {
		if (error == null)
			error = false;
		if (headers == null)
			headers = {};
		const cacheControl = (error ? libConfig.errorCacheControl : libConfig.responseCacheControl);
		if (!('Cache-Control' in headers) && cacheControl != '')
			headers['Cache-Control'] = cacheControl;

		/* check if the response can still be sent or fail the operation */
		if (this.state == ResponseState.none || (error && this.state == ResponseState.acknowledged)) {
			if (error)
				this.error(`Responding ${this.isHead ? 'to HEAD ' : ''}with [${status.msg}]${logReason}`);
			else
				this.log(`Responding ${this.isHead ? 'to HEAD ' : ''}with [${status.msg}]${logReason}`);
			this.state = ResponseState.completed;
			this.finalizeBufferHeader(status, error, headers, content);
		}
		else if (!error)
			this.respondBadInternalUsage();
		else if (this.state == ResponseState.headerSent) {
			this.error(`Broken ${this.isHead ? 'for HEAD ' : ''}with [${status.msg}]${logReason}`);
			this.state = ResponseState.broken;
		}
		else
			this.error(`Silently dropping exception ${this.isHead ? 'for HEAD ' : ''}[${status.msg}]${logReason}`);
	}

	public get headers(): libHttp.IncomingHttpHeaders {
		return this.request.headers;
	}
	public get unhandled(): boolean {
		return (this.state == ResponseState.none);
	}
	public get claimed(): boolean {
		return (this.state != ResponseState.none);
	}
	public get headerSent(): boolean {
		return (this.state != ResponseState.none && this.state != ResponseState.acknowledged);
	}
	public get broken(): boolean {
		return (this.state == ResponseState.broken);
	}
	public get method(): string {
		return this.request.method ?? '';
	}
	public get isHead(): boolean {
		return (this.request.method == 'HEAD');
	}
	public get completed(): Promise<void> {
		return this.processed.promise;
	}

	public async _finishConnection(): Promise<void> {
		let error: Error | null = null;
		try {
			if (this.state == ResponseState.none)
				this.respondNotFound();
			error = await this.handleFinishing();
		} catch (_) { }

		/* check if the connection is marked as broken, in which case the
		*	data on it are not reliable anymore and it must be destroyed */
		if (this.state == ResponseState.broken)
			error = new Error('Connection is broken');

		/* check if the connection should be killed (give it a grace timeout to receive any potential final response data) */
		if (error != null) try {
			const forceDestroy = setTimeout(() => this.handleKilling(false, error), libConfig.brokenGraceTimeout);
			await this.handleKilling(true, error);
			clearTimeout(forceDestroy);
		} catch (_) { }

		clearTimeout(this.throughput.timer);
		this.processed.resolve!();
	}
	public async _killConnection(): Promise<void> {
		return this.handleKilling(false, new Error('Closing connection'));
	}
	public _pushTranslation(path: string, identity?: string): ClientContext | null {
		if (!libLocation.IsSubDirectory(path, this._path))
			return null;
		const current = new ClientContext(this.logIdentity, this._basePath, this._path);

		/* shift the paths and the log identity */
		this._basePath = libLocation.JoinSanitized(this._basePath, path);
		this._path = this._path.substring(path.endsWith('/') ? path.length - 1 : path.length);
		if (this._path == '')
			this._path = '/';
		if (identity != null && identity != '')
			this.logIdentity = `${this.logIdentity}.${identity}`;
		return current;
	}

	/* ensure the method is one of the list and otherwise return null and auto-respond with [method-not-allowed]
	*	if [headExplicit] is false, method will substitute HEAD for GET, framework will consume the remaining body */
	public checkMethod(methods: string[] | string, options?: { headExplicit?: boolean, error?: boolean, headers?: Record<string, string> }): string | null {
		if (!Array.isArray(methods))
			methods = [methods];

		if (methods.indexOf(this.method) >= 0)
			return this.method;

		/* check if the HEAD can be converted to a GET */
		const swapAllowed = (options?.headExplicit !== true && methods.indexOf('GET') >= 0 && methods.indexOf('HEAD') < 0);
		if (this.isHead && swapAllowed)
			return 'GET';

		const allowed = methods.join(',') + (swapAllowed ? ',HEAD' : '');
		this.respondMethodNotAllowed(this.method, allowed, options);
		return null;
	}

	/* register a callback to be invoked once the response is sent, to adjust the headers to be sent */
	public patchHeaders(cb: HeaderPatch): void {
		this.headerPatchers.push(cb);
	}

	/* respond with [internal-error] and a pre-defined html template response (always considered an error, clears any other header fields) */
	public respondInternalError(msg: string, options?: { headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.InternalError, ` due to [${msg}]`, true, options?.headers, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.ErrorInternalServerError({ path: this.url.pathname, what: msg }), 'utf-8')
		});
	}

	/* respond with [internal-error] and message 'Filesystem operation failed' */
	public respondFileSystemError(options?: { headers?: Record<string, string> }): void {
		this.respondInternalError('Filesystem operation failed', options);
	}

	/* respond with [internal-error] and message 'Internal request handling error' */
	public respondBadInternalUsage(options?: { headers?: Record<string, string> }): void {
		this.respondInternalError('Internal request handling error', options);
	}

	/* respond with a any response of the given configuration (defaults to media-type: text/unknown/-, status: ok) */
	public respond(content: string | Buffer | null, options?: { media?: libRequest.MediaType, status?: libRequest.StatusType, error?: boolean, headers?: Record<string, string> }): void {
		const status = options?.status ?? libRequest.Status.Ok;

		if (content == null)
			return this.constructQuickResponse(status, ` with no body`, options?.error, options?.headers, null);

		let media = options?.media ?? libRequest.Media.Text;
		if (typeof content == 'string')
			content = Buffer.from(content, 'utf-8');
		else if (options?.media == null)
			media = libRequest.Media.Unknown;

		const logReason = ` of type [${media.mediaType}] and size [${content.byteLength}]`;
		this.constructQuickResponse(status, logReason, options?.error, options?.headers, {
			media, body: content
		});
	}

	/* respond with [ok] and a pre-defined html template response (default operation is the method) */
	public respondOk(operation?: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const actual = (operation ?? this.method);
		this.constructQuickResponse(libRequest.Status.Ok, ` for [${operation}]`, options?.error, options?.headers, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.SuccessOk({ path: this.url.pathname, operation: actual }), 'utf-8')
		});
	}

	/* respond with [not-modified] and no body */
	public respondNotModified(options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.NotModified, '', options?.error, options?.headers, null);
	}

	/* respond with [not-modified] and a pre-defined html template response (ensure the etag and/or last-modified is set) */
	public respondPreconditionFailed(reason: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.PreconditionFailed, ` due to [${reason}]`, options?.error, options?.headers, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.ErrorPreconditionFailed({ path: this.url.pathname, reason }), 'utf-8')
		});
	}

	/* respond with [bad-request] and a pre-defined html template response */
	public respondBadRequest(reason: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.BadRequest, ` due to [${reason}]`, options?.error, options?.headers, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.ErrorBadRequest({ path: this.url.pathname, reason }), 'utf-8')
		});
	}

	/* respond with [range-not-satisfiable] and a pre-defined html template response */
	public respondRangeIssue(range: string, size: number, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Content-Range'] = `bytes */${size}`;
		this.constructQuickResponse(libRequest.Status.RangeIssue, `because [${range}] cannot be satisfied for size [${size}]`, options?.error, header, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.ErrorRangeIssue({ path: this.url.pathname, range, size }), 'utf-8')
		});
	}

	/* respond with [conflict] and a pre-defined html template response */
	public respondConflict(conflict: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.Conflict, ` due to [${conflict}]`, options?.error, options?.headers, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.ErrorConflict({ path: this.url.pathname, conflict }), 'utf-8')
		});
	}

	/* respond with [not-found] and a pre-defined html template response */
	public respondNotFound(options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.NotFound, '', options?.error, options?.headers, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.ErrorNotFound({ path: this.url.pathname }), 'utf-8')
		});
	}

	/* respond with [unsupported-media-type] and a pre-defined html template response */
	public respondUnsupported(used: string, allowed: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.UnsupportedMediaType, ` because [${used}] was used and only [${allowed}] supported`, options?.error, options?.headers, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.ErrorUnsupportedMediaType({ path: this.url.pathname, used, allowed }), 'utf-8')
		});
	}

	/* respond with [invalid-method] and a pre-defined html template response */
	public respondMethodNotAllowed(method: string, allowed: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Allow'] = allowed;
		this.constructQuickResponse(libRequest.Status.MethodNotAllowed, ` because [${method}] was used and only [${allowed}] supported`, options?.error, header, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.ErrorInvalidMethod({ path: this.url.pathname, method: method, allowed }), 'utf-8')
		});
	}

	/* respond with [request-timeout] and a pre-defined html template response */
	public respondRequestTimeout(reason: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Connection'] = 'close';
		this.constructQuickResponse(libRequest.Status.RequestTimeout, ` due to [${reason}]`, options?.error, header, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.ErrorRequestTimeout({ path: this.url.pathname, reason }), 'utf-8')
		});
	}

	/* respond with [content-too-large] and a pre-defined html template response */
	public respondContentTooLarge(allowed: number, atLeastProvided: number, options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.ContentTooLarge, ` because [${atLeastProvided}] > [${allowed}]`, options?.error, options?.headers, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.ErrorContentTooLarge({ path: this.url.pathname, allowedLength: allowed, providedLength: atLeastProvided }), 'utf-8')
		});
	}

	/* respond with [see-other] to the given target and a pre-defined html template response (forces method GET) */
	public respondSeeOther(target: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;
		this.constructQuickResponse(libRequest.Status.SeeOther, ` to [${target}]`, options?.error, header, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.SeeOther({ destination: target }), 'utf-8')
		});
	}

	/* respond with [temporary-redirect] to the given target and a pre-defined html template response (preserves method) */
	public respondTemporaryRedirect(target: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;
		this.constructQuickResponse(libRequest.Status.TemporaryRedirect, ` to [${target}]`, options?.error, header, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.TemporaryRedirect({ path: this.url.pathname, destination: target }), 'utf-8')
		});
	}

	/* respond with [permanent-redirect] to the given target and a pre-defined html template response (preserves method)  */
	public respondPermanentRedirect(target: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;
		this.constructQuickResponse(libRequest.Status.PermanentRedirect, ` to [${target}]`, options?.error, header, {
			media: libRequest.Media.Html, body: Buffer.from(libTemplates.PermanentRedirect({ path: this.url.pathname, destination: target }), 'utf-8')
		});
	}
}

/*
*	Http HEAD aware (will silently drain any data sent from a HEAD request)
*
*	Receiving data: Will automatically decode the stream and ensure a given maximum is not passed
*		=> Will drain upload if it is not being received or the request enters a broken state
*		=> Destroying receive reader will drain the remaining data
*		=> Any errors while receiving will either auto-respond or send the connection into the broken state, and fail the receive reader (stream user does not need to respond)
*		=> All data must have been received before the response is completed
*	Responding data: Will automatically encode the stream and send the header accordingly
*		=> Will automatically determine if encoding is to be used
*		=> Checks if promised number of bytes is provided
*		=> Will automatically error, if the broken state is detected, and will auto-respond or send the connection into the broken state (stream user does not need to respond)
*	Cleanup: request detects incomplete responses (headers committed but body never finished) and will auto-respond or send the connection into the broken state
*	Responding with files, data, or html can and will modify cache properties
*/
export class HttpRequest extends IncomingBase {
	private response: libHttp.ServerResponse;
	private receive: ReceiveState;
	private htmlPatcher: HtmlPatch[];

	constructor(request: libHttp.IncomingMessage, response: libHttp.ServerResponse, host: string, protocol: string) {
		super(request, host, protocol, true);
		this.response = response;
		this.receive = ReceiveState.none;
		this.htmlPatcher = [];
	}

	protected override finalizeBufferHeader(status: libRequest.StatusType, error: boolean, headers: Record<string, string>, content: { media: libRequest.MediaType, body: Buffer | null } | null): void {
		if (content == null)
			this.closeHeader(status, null, null, false, '', headers, error);
		else {
			/* check if the data should be encoded (if the size is not known, pretend the buffer to be large enough) */
			let encoding: libRequest.EncodingType | null = null;
			if (libRequest.ShouldEncode(content.body?.byteLength ?? null, content.media)) {
				headers['Vary'] = 'Accept-Encoding';

				encoding = libRequest.SelectEncoding(this.headers['accept-encoding'] ?? null);
				if (encoding != null) {
					if (content.body != null)
						content.body = encoding.encodeBuffer(content.body);
					headers['Content-Encoding'] = encoding.name;
				}
			}
			this.closeHeader(status, content.media, content.body?.byteLength ?? null, false, encoding?.name ?? '', headers, error);
		}

		/* try to finalize the response (can throw an exception for invalid status or header content) */
		try {
			if (this.isHead || content?.body == null)
				this.response.end();
			else
				this.response.end(content.body);
		} catch (err: any) {
			this.error(`Failed to finalize response: ${err.message}`);
			this.state = ResponseState.broken;
		}
	}
	protected override async handleFinishing(): Promise<Error | null> {
		if (this.receive == ReceiveState.receiving) {
			/* check if the response is already completed, in which case it can be silently
			*	reset to 'header-sent' to ensure the connection is properly marked as broken */
			if (this.state == ResponseState.completed)
				this.state = ResponseState.headerSent;
			this.respondBadInternalUsage();
		}

		/* drain any remaining data in the pipeline */
		if (!this.request.readableEnded && !this.request.destroyed) {
			this.request.unpipe();
			await new Promise<void>((resolve) => {
				let resolved = false;
				const done = () => { if (!resolved) { resolved = true; resolve(); } };
				this.request.on('data', (chunk: Buffer) => this.updateThroughput(chunk.byteLength));
				this.request.on('end', done);
				this.request.on('close', done);
				this.request.resume();
			});
		}

		/* ensure that the response was properly sent */
		if (this.state != ResponseState.completed && this.state != ResponseState.broken)
			this.respondBadInternalUsage();
		return null;
	}
	protected override async handleKilling(graceful: boolean, reason: Error): Promise<void> {
		const closeConnection = () => {
			if (this.request.destroyed && this.response.destroyed)
				return;
			this.trace(`closing connection: ${reason.message}`);
			this.request.destroy(reason);
			this.response.destroy(reason);
		};

		if (!graceful || this.response.writableFinished)
			return closeConnection();

		return new Promise<void>((resolve) => {
			let settled = false;
			this.response.on('finish', () => {
				if (settled) return; settled = true;
				closeConnection();
				resolve();
			});
			this.response.on('error', () => {
				if (settled) return; settled = true;
				closeConnection();
				resolve();
			})
		});
	}
	private closeHeader(status: libRequest.StatusType, media: libRequest.MediaType | null, contentSize: number | null, updateState: boolean, encoding: string, headers: Record<string, string>, error: boolean): void {
		if (media == null)
			this.trace(`Sending ${this.isHead ? 'HEAD for ' : ''}no content`);
		else
			this.trace(`Sending ${this.isHead ? 'HEAD' : 'content'} [${media?.mediaType ?? 'none'}] of size [${contentSize ?? 'unknown'}] ${encoding.length == 0 ? 'not encoded' : `encoded using [${encoding}]`}`);

		if (updateState)
			this.state = ResponseState.headerSent;

		headers['Date'] = new Date().toUTCString();
		if (libConfig.serverName != '')
			headers['Server'] = libConfig.serverName;
		for (const [key, value] of Object.entries(libConfig.commonHeaders))
			headers[key] = value;
		if (!('Accept-Ranges' in headers))
			headers['Accept-Ranges'] = 'none';
		if (contentSize != null)
			headers['Content-Length'] = contentSize.toString();
		if (media != null)
			headers['Content-Type'] = libRequest.BuildMediaTypeIdentifier(media);

		/* perform the header post processing (in reverse order to ensure first added is last executed) */
		for (let i = this.headerPatchers.length - 1; i >= 0; --i)
			this.headerPatchers[i](status, headers, error);

		/* setup the response status and headers (guard against invalid header values from patchers or modules) */
		this.response.statusCode = status.code;
		this.response.statusMessage = status.msg;
		for (const [key, value] of Object.entries(headers)) {
			try {
				this.response.setHeader(key, value);
			} catch (err: any) {
				this.error(`Failed to set header [${key}]: ${err.message}`);
			}
		}
	}
	private receiveClientData(maxLength: number | null): libStream.Readable {
		const makeErrorStream = (msg: string) => new libStream.Readable({ read() { this.destroy(new Error(msg)) } });

		/* check if the object is ready for receiving */
		if (this.receive != ReceiveState.none) {
			this.respondBadInternalUsage();
			return makeErrorStream('Connection is already being received');
		}
		if (this.request.destroyed || this.state == ResponseState.broken)
			return makeErrorStream('Connection is broken');
		this.receive = ReceiveState.receiving;

		/* setup the accumulation transformer (which will also be returned in the end; mark receiving
		*	as completed upon destroy - will automatically drain the request on cleanup) */
		let accumulated = 0;
		const output = new libStream.Transform({
			transform: (chunk, _, cb) => {
				if (output.destroyed) return cb(new Error('Already failed'));

				/* check if the connection has been processed or marked as failed */
				if (this.state == ResponseState.completed)
					this.respondBadInternalUsage();
				if (this.state == ResponseState.broken)
					return cb(new Error('Connection is broken'));

				/* check the maximum count (is violated) */
				this.updateThroughput(chunk.byteLength);
				accumulated += chunk.byteLength;
				if (maxLength == null || accumulated <= maxLength)
					return cb(null, chunk);
				this.respondContentTooLarge(maxLength, accumulated, { error: true });
				cb(new Error('Request payload is too large'));
			},
			destroy: (err, cb) => {
				if (this.receive == ReceiveState.receiving) {
					this.request.unpipe();
					this.receive = ReceiveState.completed;
				}
				cb(err);
			}
		});

		/* check if the content is encoded and create the chain of decoders (in reverse to ensure the nesting is correct) */
		let stream: libStream.Readable = this.request;
		if (this.headers['content-encoding'] != null) {
			const encodings = libRequest.SplitAndTrimList(this.headers['content-encoding'], ',', false);

			for (let i = encodings.length - 1; i >= 0; --i) {
				const encoding = libRequest.LookupEncoding(encodings[i]);

				if (encoding == null) {
					output.destroy();
					this.respondUnsupported(encodings[i], libRequest.SupportedEncodingNames().join(','), { error: true });
					return makeErrorStream('Unsupported content encoding');
				}

				/* configure the piping accordingly */
				const decoder = encoding.makeDecode();
				stream = stream.pipe(decoder);
				decoder.on('error', (err: any) => {
					if (output.destroyed) return;
					this.respondBadRequest('Invalid data encoding', { error: true });
					output.destroy(err);
				});

				/* register the cleanup handler to ensure the decoder is destroyed on completion */
				output.on('close', () => decoder.destroy());
			}
		}

		/* check if too many data have been promised (cannot be trusted if content-encoding is enabled) */
		else if (maxLength != null && this.headers['content-length'] != null) {
			const contentSize = parseInt(this.headers['content-length']);

			/* check if the length is valid and otherwise mark the request as 'consumed' */
			if (!isFinite(contentSize) || contentSize < 0 || contentSize > maxLength) {
				output.destroy();
				this.respondContentTooLarge(maxLength, contentSize, { error: true });
				return makeErrorStream('Request payload is too large');
			}
		}

		/* register the network error handler to properly forward exceptions (no need to respond on network errors) */
		this.request.on('error', (err: any) => {
			if (!output.destroyed)
				output.destroy(err);
		});

		/* create the plumbing between stream and output (errors are already handled) */
		return stream.pipe(output);
	}
	private sendClientSetupHeader(resp: HttpRequestResponse, chunk: Buffer | null, cb: (err: any) => void): void {
		const last = (chunk == null);
		const cached = (resp.cache != null);

		/* check if previous data were cached and combine them */
		if (resp.cache != null)
			chunk = (chunk == null ? resp.cache : Buffer.concat([resp.cache, chunk]));
		resp.cache = null;

		/* check if the sending should be deferred to determine if compression
		*	should be enabled or to allow inline compression on small packets
		*	(for a head request, dont cache any data, immediately send the header) */
		if (!last && !this.isHead && (chunk!.byteLength < libRequest.MIN_ENCODING_SIZE || !cached)) {
			resp.cache = chunk;
			return cb(null);
		}

		/* for a 'HEAD' request, pretend the size to not be known yet, if it has not been explicitly provided */
		let fullContentSize = resp.contentSize;
		if (fullContentSize == null && last && !this.isHead)
			fullContentSize = (chunk?.byteLength ?? 0);

		/* check if the content comes pre-encoded */
		if (resp.contentEncoding != null) {
			resp.headers['Content-Encoding'] = resp.contentEncoding;
			resp.headers['Vary'] = 'Accept-Encoding';
			this.closeHeader(resp.status, resp.contentType, fullContentSize, true, `pre-encoded:${resp.contentEncoding}`, resp.headers, false);
			return this.sendClientWrite(resp, chunk, last, cb);
		}

		/* lookup the dynamic encoder (range content cannot be dynamically encoded, as it cannot be random
		*	accessed; for [head] and no explicit content, default to size being valid to just assume an
		*	encoding - can always be disabled in the real run, should the data be too short) */
		let encoding = null;
		if (!resp.noEncoding && libRequest.ShouldEncode(fullContentSize ?? chunk?.byteLength ?? null, resp.contentType)) {
			resp.headers['Vary'] = 'Accept-Encoding';
			encoding = libRequest.SelectEncoding(this.headers['accept-encoding'] ?? null);
		}
		if (encoding == null) {
			this.closeHeader(resp.status, resp.contentType, fullContentSize, true, '', resp.headers, false);
			return this.sendClientWrite(resp, chunk, last, cb);
		}
		resp.headers['Content-Encoding'] = encoding.name;
		resp.headers['Accept-Ranges'] = 'none';

		/* for HEAD, clear the content size, as it is not known through the encoder, and for real
		*	requests, check if the header can be encoded inplace (update the content size, as it is now
		*	exact but differs due to being encoded) and otherwise configure the encoding pipeline */
		if (this.isHead)
			fullContentSize = null;
		else if (last) {
			chunk = encoding.encodeBuffer(chunk!);
			resp.contentSize = chunk.byteLength;
			fullContentSize = chunk.byteLength;
		} else {
			fullContentSize = null;
			resp.writer = encoding.makeEncode();
			resp.writer.pipe(this.response);

			resp.writer.on('error', (err: any) => {
				if (resp.destroyed) return;
				this.respondInternalError('Data encoding error encountered');
				resp.destroy(err);
			});
		}

		/* send the final header away and write the content to the stream */
		this.closeHeader(resp.status, resp.contentType, fullContentSize, true, encoding.name, resp.headers, false);
		return this.sendClientWrite(resp, chunk, last, cb);
	}
	private sendClientWrite(resp: HttpRequestResponse, chunk: Buffer | null, last: boolean, cb: (err: any) => void): void {
		/* check if this is a head write, in which case the response can
		*	just be marked as completed, and all other data can be drained */
		if (this.isHead) {
			if (this.state != ResponseState.headerSent)
				return cb(null);
			this.state = ResponseState.completed;
			resp.writer.end(() => cb(null));
			return;
		}

		/* update the total-sent counter and check if the upper-bound is broken */
		if (chunk != null) {
			this.updateThroughput(chunk.byteLength);
			resp.totalSent += chunk.byteLength;
			if (resp.contentSize != null && resp.totalSent > resp.contentSize) {
				this.respondBadInternalUsage();
				return cb(new Error('Sending more data than promised'));
			}
		}

		/* check if this is an intermediate write, and write the data out */
		if (!last) {
			resp.writer.write(chunk!, () => cb(null));
			return;
		}

		/* check if all expected data have been provided */
		if (resp.contentSize != null && resp.totalSent < resp.contentSize) {
			this.respondBadInternalUsage();
			return cb(new Error('Responded with too few data'));
		}

		/* mark the state as completed and sent the last package */
		this.state = ResponseState.completed;
		if (chunk != null)
			resp.writer.end(chunk, () => cb(null));
		else
			resp.writer.end(() => cb(null));
	}
	private sendClientHandle(resp: HttpRequestResponse, chunk: Buffer | null, cb: (err: any) => void): void {
		if (resp.destroyed)
			return cb(new Error('Already failed'));

		/* check if the connection has been marked as failed or completed */
		if (this.state == ResponseState.completed)
			return cb(new Error('Responding to completed response'));
		if (this.state == ResponseState.broken)
			return cb(new Error('Connection is broken'));

		if (this.state == ResponseState.headerSent)
			return this.sendClientWrite(resp, chunk, chunk == null, cb);
		this.sendClientSetupHeader(resp, chunk, cb);
	}
	private sendClientData(status: libRequest.StatusType, media: libRequest.MediaType, headers: Record<string, string>, options: { encoded?: string, contentSize?: number, noEncoding?: boolean }): libStream.Writable {
		const makeErrorStream = (msg: string) => new libStream.Writable({ write(_0, _1, cb) { cb(new Error(msg)) }, final(cb) { cb(new Error(msg)) } });

		/* check if the object is already responded */
		if (this.state != ResponseState.none) {
			this.respondBadInternalUsage();
			return makeErrorStream('Connection already responded');
		}
		if (this.response.destroyed)
			return makeErrorStream('Connection is broken');
		this.state = ResponseState.acknowledged;

		const response = new HttpRequestResponse(this.response, status, headers,
			options.contentSize ?? null, media, options.encoded ?? null, options.noEncoding ?? false,
			(chunk: Buffer | null, cb: (err: any) => void) => this.sendClientHandle(response, chunk, cb),
			(err: any, cb: (err: any) => void) => {
				if (this.state == ResponseState.completed)
					return cb(err);

				/* check if the output stream was an encoder, in which case it still needs to
				*	be destroyed (only if an error occurred and the response was not completed) */
				if (response.writer !== this.response)
					response.writer.destroy();
				this.respondBadInternalUsage();
				return cb(err);
			}
		);

		/* register the network error handler to properly forward
		*	exceptions (no need to respond on network errors) */
		this.response.on('error', (err: any) => {
			if (!response.destroyed)
				response.destroy(err);
		});
		return response;
	}

	/* return the string formatted media-type (or empty string for no media type) */
	public getMediaType(): string {
		const type = libRequest.SplitAndTrimList(this.headers['content-type'] ?? null, ';', true)[0] ?? '';
		return type.toLowerCase();
	}

	/* check the content-type for a media-type and otherwise return the default type */
	public getMediaTypeCharset(defEncoding: string): string {
		const type = this.headers['content-type'];
		if (type == null)
			return defEncoding;

		/* look for the first charset entry in the content-type list */
		for (const part of libRequest.SplitAndTrimList(type, ';', true)) {
			if (part.substring(0, 8).toLowerCase() != 'charset=')
				continue;
			let value = part.substring(8).trim();

			/* remove the potential quotes around the charset value */
			const quoted = value.startsWith('"');
			if (quoted != value.endsWith('"'))
				break;
			if (quoted)
				value = value.substring(1, value.length - 1).trim();

			if (value.length == 0)
				break;
			return value.trim().toLowerCase();
		}
		return defEncoding;
	}

	/* ensure the media-type is one of the list and otherwise return null and auto-respond with [unsupported-media-type] (defaults to first type, if [noneIsFirst]) */
	public checkMediaType(types: libRequest.MediaType[] | libRequest.MediaType, options?: { noneIsFirst?: boolean, error?: boolean, headers?: Record<string, string> }): libRequest.MediaType | null {
		if (!Array.isArray(types))
			types = [types];

		const type = this.getMediaType();
		if (type == '' && options?.noneIsFirst === true)
			return types[0];

		for (let i = 0; i < types.length; ++i) {
			if (type === types[i].mediaType)
				return types[i];
		}
		this.respondUnsupported(type, types.map(t => t.mediaType).join(','), options);
		return null;
	}

	/* [no-throw but errors] receive the payload of given max length as a readable stream
	*	automatically responds with given exceptions if the payload cannot be received properly
	*	automatically drained if the readable stream is destroyed before reading all data */
	public receiveData(maxLength: number | null): libStream.Readable {
		return this.receiveClientData(maxLength);
	}

	/* [throws] receive the payload of given max length as a single complete buffer
	*	automatically responds with given exceptions if the payload cannot be received properly */
	public async receiveAllBuffer(maxLength: number | null): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			let stream: libStream.Readable | null = null;
			try {
				stream = this.receiveClientData(maxLength);
			} catch (err: any) {
				return reject(err);
			}

			const buffers: Buffer[] = [];
			stream.on('data', (chunk: Buffer) => buffers.push(chunk));
			stream.on('end', () => resolve(Buffer.concat(buffers)));
			stream.on('error', (err: any) => reject(err));
		});
	}

	/* [throws] receive the payload of given max length as a single complete decoded string
	*	automatically responds with given exceptions if the payload cannot be received properly */
	public async receiveAllText(encoding: string, maxLength: number | null): Promise<string> {
		/* wait for the buffer (let all errors propagate out) */
		const buffer: Buffer = await this.receiveAllBuffer(maxLength);

		try {
			return buffer.toString(encoding as BufferEncoding);
		} catch (err: any) {
			this.respondBadRequest('Unable to decode content', { error: true });
			throw err;
		}
	}

	/* [throws] receive the payload of given max length and write it directly to a file; will fail
	*	if the file already exists and delete the file if it could not be received in full
	*	automatically responds with given exceptions if the payload cannot be received properly or file operations fail */
	public async receiveToFile(path: string, maxLength: number | null): Promise<void> {
		this.trace(`Collecting data from [${this.url.pathname}] to: [${path}]`);
		return new Promise((resolve, reject) => {
			let source: libStream.Readable | null = null;
			try {
				source = this.receiveClientData(maxLength);
			}
			catch (err: any) {
				return reject(err);
			}

			/* create the stream to the file to be written and setup the plumbing */
			const destination = libFs.createWriteStream(path, { flags: 'wx' });
			let fileFailed = false, sourceFailed = false, opened = false;
			source.on('error', (err: any) => {
				sourceFailed = true;
				destination.destroy(err);
			});
			destination.on('open', () => {
				opened = true;
				if (!sourceFailed)
					source.pipe(destination);
				else
					destination.destroy();
			});
			destination.on('error', (err: any) => {
				if (!sourceFailed)
					this.respondFileSystemError();
				fileFailed = true;

				/* destroy the source to clean up the receiving pipeline (will
				*	not close the underlying request, just the pass-through reader) */
				if (!source.destroyed)
					source.destroy();

				/* check if the file was opened and remove it */
				if (!opened)
					return reject(err);
				libFs.unlink(path, (err2: any) => {
					if (err2 != null)
						this.error(`Failed to remove temporary file [${path}]: ${err2.message}`);
					reject(err);
				});
			});
			destination.on('close', () => {
				if (!sourceFailed && !fileFailed)
					resolve();
			});
		});
	}

	/* register a callback to be invoked if html is built, to adjust the headers or the content to be sent */
	public patchHtmlPage(cb: HtmlPatch): void {
		this.htmlPatcher.push(cb);
	}

	/* respond with html, can be built on by parent modules, sent once the client has been fully processed
	*	(default status is ok, for HEAD builds, light build indicates that the actual content was not produced, but rather only
	*	some shallow content; if at least one build is shallow, the HEAD response will only contain an estimage of the size)
	*	automatically adds Config.responseCacheControl, if no other cache control is specified */
	public respondHtml(page: libBuilder.HtmlPage, options?: { status?: libRequest.StatusType, headers?: Record<string, string>, lightBuild?: boolean }): void {
		if (this.state != ResponseState.none)
			return this.respondBadInternalUsage();

		this.state = ResponseState.acknowledged;
		const status = (options?.status ?? libRequest.Status.Ok);
		const headers = (options?.headers ?? {});
		if (!('Cache-Control' in headers) && libConfig.responseCacheControl != '')
			headers['Cache-Control'] = libConfig.responseCacheControl;

		/* invoke all registered html patcher to let them modify the content (in reverse order to ensure
		*	first added is last executed, and check if one of them produced an alternate response) */
		let lightBuild = (options?.lightBuild ?? false);
		for (let i = this.htmlPatcher.length - 1; i >= 0; --i) {
			lightBuild = this.htmlPatcher[i](page, status, headers, this.isHead) || lightBuild;
			if (this.state != ResponseState.acknowledged)
				return;
		}
		if (!this.isHead)
			lightBuild = false;
		const content = (lightBuild ? null : Buffer.from(page.finalize(), 'utf-8'));

		/* mark first as completed now */
		this.log(`Responding with HTML content and status [${status.msg}]${lightBuild ? ' as light-build' : ''}`);
		this.state = ResponseState.completed;
		this.finalizeBufferHeader(status, false, headers, { media: libRequest.Media.Html, body: content });
	}

	/* [no-throw but errors] send data with [media type] and [status] and return a writable stream (default status is ok, media is unknown)
	*	if a content size is provided, stream expects exactly this amount of bytes
	*	the encoding can be configured, if the data is pre-encoded (warning: no checks against accepted encodings performed!)
	*	for a HEAD request, no encoding will be negotiated, no lengths verified, and the written data will just be drained (can immediately be ended using '.end()')
	*	automatically adds Config.responseCacheControl, if no other cache control is specified */
	public respondData(options?: { status?: libRequest.StatusType, media?: libRequest.MediaType, encoded?: string, contentSize?: number, noEncoding?: boolean, headers?: Record<string, string> }): libStream.Writable {
		const status: libRequest.StatusType = options?.status ?? libRequest.Status.Ok;
		this.log(`Responding with data and status [${status.msg}]`);
		const headers = (options?.headers ?? {});
		if (!('Cache-Control' in headers) && libConfig.responseCacheControl != '')
			headers['Cache-Control'] = libConfig.responseCacheControl;
		return this.sendClientData(status, options?.media ?? libRequest.Media.Unknown, headers, { encoded: options?.encoded, contentSize: options?.contentSize, noEncoding: options?.noEncoding });
	}

	/* [no-throw] try to respond with the given file, return false, if the file does not exist (range aware, HEAD aware)
	*	specify [stable] if the cache does not need to validate if the underlying file on disk has been modified
	*	the media type can be overwritten (defaults to extracting media-type from the file-path)
	*	the encoding can be configured, if the file is pre-encoded (warning: no checks against accepted encodings performed!)
	*	status will be [Ok], [partial-content], [not-modified] or according errors
	*	cache aware and etag/last-modified aware; automatically adds Config.fileCacheControl, if no other cache control is specified */
	public async tryRespondFile(filePath: string, stable: boolean, options?: { encoded?: string, media?: libRequest.MediaType, headers?: Record<string, string> }): Promise<boolean> {
		if (this.state != ResponseState.none) {
			this.respondBadInternalUsage();
			return true;
		}

		/* read the entry from the cache and check if it has been permanently moved and apply the move */
		let cached: libCache.Cached | string | null = null;
		try {
			cached = libCache.GetImmutable(filePath, stable);
			if (cached == null)
				return false;
		}
		catch (_) {
			this.respondFileSystemError();
			return true;
		}
		if (typeof cached == 'string') {
			this.respondPermanentRedirect(cached);
			return true;
		}

		/* parse the range and ensure that its well formed */
		const range = libRequest.ParseRangeHeader(this.headers.range ?? null, cached.fileSize());
		if (range.state == libRequest.RangeState.malformed) {
			this.respondBadRequest(`Issues while parsing http-header range: [${this.headers.range}]`, { error: true });
			return true;
		}
		else if (range.state == libRequest.RangeState.issue) {
			this.respondRangeIssue(this.headers.range!, cached.fileSize(), { error: true });
			return true;
		}

		/* mark byte-ranges to be supported in principle and add the caching properties */
		const headers = (options?.headers ?? {}), etag = `"${cached.uniqueId()}"`;
		const media = options?.media ?? libRequest.LookupMediaTypeFromFile(filePath);
		headers['Accept-Ranges'] = 'bytes';
		headers['Last-Modified'] = cached.lastModified();
		headers['ETag'] = etag;
		if (!('Cache-Control' in headers)) {
			if (cached.isImmutable() && libConfig.immutableCacheControl != '')
				headers['Cache-Control'] = libConfig.immutableCacheControl;
			else if (libConfig.fileCacheControl != '')
				headers['Cache-Control'] = libConfig.fileCacheControl;
		}

		/* add the variation on accept-encoding to ensure all other responses contain it */
		if (options?.encoded != null || (range.state == libRequest.RangeState.noRange && libRequest.ShouldEncode(cached.fileSize(), media)))
			headers['Vary'] = 'Accept-Encoding';

		/* validate the conditions */
		if (this.headers['if-match'] != null && !libRequest.ETagMatchesList(etag, this.headers['if-match'])) {
			this.respondPreconditionFailed(`ETag ${etag} not found`, { headers });
			return true;
		}

		/* check if the response can be skipped due to the resource not having been modified since
		*	the last fetch (etag outweighs last-modified; invalid times are not considered errors) */
		if (this.headers['if-none-match'] != null) {
			if (libRequest.ETagMatchesList(etag, this.headers['if-none-match'])) {
				this.respondNotModified({ headers });
				return true;
			}
		}
		else if (this.headers['if-modified-since'] != null) {
			const result = libRequest.TimeStampCompare(cached.lastModified(), this.headers['if-modified-since']);
			if (result != null && result >= 0) {
				this.respondNotModified({ headers });
				return true;
			}
		}

		/* check if the file is empty (can only happen for unused ranges, which would otherwise have issues) */
		if (cached.fileSize() == 0) {
			this.log(`Sending empty content for [${filePath}]`);
			this.state = ResponseState.completed;
			this.finalizeBufferHeader(libRequest.Status.Ok, false, headers, { media, body: Buffer.alloc(0) });
			return true;
		}
		if (range.state == libRequest.RangeState.valid)
			headers['Content-Range'] = `bytes ${range.first}-${range.last}/${cached.fileSize()}`;

		/* create the writer stream (doesn't throw, but errors) */
		const status = (range.state == libRequest.RangeState.noRange ? libRequest.Status.Ok : libRequest.Status.PartialContent);
		let stream = this.sendClientData(status, media, headers, {
			encoded: options?.encoded,
			contentSize: range.last - range.first + 1,
			noEncoding: range.state != libRequest.RangeState.noRange
		});
		this.log(`Sending ${this.isHead ? 'HEAD' : 'content'} [${range.first} - ${range.last}/${cached.fileSize()}] from [${filePath}]`);

		/* check if this is a head request, in which case the stream can just
		*	immediately be closed again, to prevent the file from consuming resources */
		if (this.isHead)
			return new Promise((resolve) => stream.end(() => resolve(true)));

		/* create the source stream of the file to read from (will not throw any exceptions) */
		let source: libStream.Readable = cached.stream({ start: range.first, end: range.last });

		/* pipe the components together and await completion */
		let closed = false;
		return new Promise((resolve) => {
			source.pipe(stream);
			source.on('error', (err: any) => {
				if (closed) return; closed = true;
				this.respondFileSystemError();
				this.error(`Error while sending file [${filePath}]: [${err.message}]`);
				stream.destroy(err);
			});
			stream.on('error', (err: any) => {
				if (closed) return; closed = true;
				this.error(`Error while sending file [${filePath}]: [${err.message}]`);
				source.destroy(err);
			});
			stream.on('close', () => resolve(true));
		});
	}
}

class HttpRequestResponse extends libStream.Writable {
	public writer: libStream.Writable;
	public totalSent: number;
	public cache: Buffer | null;
	public status: libRequest.StatusType;
	public headers: Record<string, string>;
	public contentSize: number | null;
	public contentType: libRequest.MediaType;
	public contentEncoding: string | null;
	public noEncoding: boolean;

	constructor(response: libStream.Writable, status: libRequest.StatusType, headers: Record<string, string>, contentSize: number | null, contentType: libRequest.MediaType,
		contentEncoding: string | null, noEncoding: boolean, handleData: (chunk: Buffer | null, cb: (err: any) => void) => void, destroy: (err: any, cb: (err: any) => void) => void
	) {
		super({
			write: (chunk, _, cb) => handleData(chunk, cb),
			final: (cb) => handleData(null, cb),
			destroy: (err, cb) => destroy(err, cb)
		});
		this.writer = response;
		this.totalSent = 0;
		this.cache = null;
		this.status = status;
		this.headers = headers;
		this.contentSize = contentSize;
		this.contentType = contentType;
		this.contentEncoding = contentEncoding;
		this.noEncoding = noEncoding;
	}
}

/*
*	WebSocket upgrade requests, which were not accepted, will be closed after responding
*	Responses will not add or modify any cache configurations
*/
export class HttpUpgrade extends IncomingBase {
	private socket: libStream.Duplex;
	private head: Buffer;
	private wss: libWs.WebSocketServer;

	constructor(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, host: string, protocol: string, wss: libWs.WebSocketServer) {
		super(request, host, protocol, false);
		this.socket = socket;
		this.head = head;
		this.wss = wss;
	}

	protected override finalizeBufferHeader(status: libRequest.StatusType, error: boolean, headers: Record<string, string>, content: { media: libRequest.MediaType, body: Buffer | null } | null): void {
		if (content != null) {
			if (content.body != null)
				headers['Content-Length'] = content.body.byteLength.toString();
			headers['Content-Type'] = libRequest.BuildMediaTypeIdentifier(content.media);
		}
		headers['Date'] = new Date().toUTCString();
		if (libConfig.serverName != '')
			headers['Server'] = libConfig.serverName;
		for (const [key, value] of Object.entries(libConfig.commonHeaders))
			headers[key] = value;
		headers['Accept-Ranges'] = 'none';
		headers['Connection'] = 'close';

		/* perform the header post processing (in reverse order to ensure first added is last executed) */
		for (let i = this.headerPatchers.length - 1; i >= 0; --i)
			this.headerPatchers[i](status, headers, error);

		/* construct the entire header content and send it away (sanitize values to prevent response splitting) */
		let headerText = `HTTP/1.1 ${status.code} ${status.msg}\r\n`;
		for (const [key, value] of Object.entries(headers)) {
			if (value.match(BAD_HEADER_VALUE_REGEX))
				this.error(`Failed to set header [${key}]: Bad header value`);
			else
				headerText += `${key}: ${value}\r\n`;
		}
		headerText += '\r\n';
		this.socket.write(headerText, 'utf-8');

		if (this.isHead || content?.body == null)
			this.socket.end();
		else
			this.socket.end(content.body);
	}
	protected override async handleFinishing(): Promise<Error | null> {
		/* check if the connection was accepted (only reason to keep it alive;
		*	header-sent is only set by the accept web-socket method) */
		if (this.state == ResponseState.headerSent)
			return null;

		/* check if the state is incomplete and break the connection but ensure it is closed
		*	either way (to ensure the connection is definitely closed, if not upgrade) */
		if (this.state != ResponseState.completed && this.state != ResponseState.broken)
			this.respondBadInternalUsage();
		if (this.state == ResponseState.broken)
			return null;
		return new Error('Upgrade was not accepted');
	}
	protected override async handleKilling(graceful: boolean, reason: Error): Promise<void> {
		const closeConnection = () => {
			if (this.request.destroyed && this.socket.destroyed)
				return;
			this.trace(`closing connection: ${reason.message}`);
			this.request.destroy(reason);
			this.socket.destroy(reason);
		};

		if (!graceful || this.socket.writableFinished)
			return closeConnection();

		return new Promise<void>((resolve) => {
			let settled = false;
			this.socket.on('finish', () => {
				if (settled) return; settled = true;
				closeConnection();
				resolve();
			});
			this.socket.on('error', () => {
				if (settled) return; settled = true;
				closeConnection();
				resolve();
			})
		});
	}

	/* marks the object as having been handled (return false, if connection is not a valid websocket upgrade request) */
	public tryAcceptWebSocket(cb: (ws: ClientSocket) => Promise<void>): boolean {
		if (this.state != ResponseState.none) {
			this.respondBadInternalUsage();
			return true;
		}

		/* check if the connection is a valid upgrade request */
		let connection = libRequest.SplitAndTrimList(this.headers.connection?.toLowerCase() ?? null, ',', false);
		if (connection.indexOf('upgrade') == -1)
			return false;
		if (this.headers?.upgrade?.toLowerCase() != 'websocket' || this.request.method != 'GET')
			return false;

		/* save the current path state so that the ClientSocket receives the correct
		*	shifted paths even if the caller restores before the async callback fires */
		const snapshot = this.snapshot();

		/* perform the upgrade (websocket will automatically send http error responses and close the socket
		*	on errors in the upgrade process) and restore the context when the accept was performed */
		this.state = ResponseState.headerSent;
		this.trace(`Performing upgrade on web socket connection: [${this._fullPath}]`);
		this.wss.handleUpgrade(this.request, this.socket, this.head, async (ws, _) => {
			const current = this.restore(snapshot);
			try {
				/* the restored client ensures the websocket object is in the right logging and path context */
				await cb(new ClientSocket(ws, this));
			} catch (err: any) {
				this.error(`Unhandled exception while processing web socket accept: ${err.message}`);
				ws.close();
			}
			this.restore(current);
		});
		return true;
	}
}

/*
*	WebSocket with integrated alive checks
*/
export class ClientSocket extends ClientBase {
	private ws: libWs.WebSocket;
	private aliveTimer: null | NodeJS.Timeout;
	private isAlive: boolean;
	private wsLogger: libLog.LogIdentity;

	public ondata?: (data: libWs.RawData, isBinary: boolean) => void;
	public onclose?: () => void;

	constructor(ws: libWs.WebSocket, base: HttpUpgrade) {
		super(base);
		this.ws = ws;
		this.aliveTimer = null;
		this.isAlive = true;
		this.wsLogger = (base as libLog.LogIdentity);

		this.ws.on('pong', () => {
			this.wsLogger.trace(`Alive check pong received`);
			this.selfIsAlive();
		});
		this.ws.on('message', (data, isBinary) => {
			this.selfIsAlive();
			if (this.ondata != null)
				this.ondata(data, isBinary);
		});
		this.ws.on('close', () => {
			this.wsLogger.trace('Socket connection closed');
			if (this.aliveTimer != null)
				clearTimeout(this.aliveTimer);
			this.aliveTimer = null;

			if (this.onclose != null)
				this.onclose();
		});
		this.ws.on('error', (err: any) => {
			this.wsLogger.error(`WebSocket error: ${err.message}`);
			this.terminateSelf();
		});

		/* start the first alive check */
		this.selfIsAlive();
	}

	private checkIsAlive(): void {
		this.aliveTimer = null;
		if (libConfig.webSocketTimeout == 0)
			return;

		/* cycle through the alive state and check again */
		if (!this.isAlive)
			return this.terminateSelf();
		this.isAlive = false;
		this.aliveTimer = setTimeout(() => this.checkIsAlive(), libConfig.webSocketTimeout);

		/* try to ping the remote to check the liveliness */
		try {
			this.wsLogger.trace(`Sending ping to determine if connection is alive`);
			this.ws.ping();
		} catch (err: any) {
			this.wsLogger.error(`WebSocket error while pinging: ${err.message}`);
			this.terminateSelf();
		}
	}
	private selfIsAlive(): void {
		this.isAlive = true;
		if (this.aliveTimer != null)
			clearTimeout(this.aliveTimer);
		this.aliveTimer = (libConfig.webSocketTimeout == 0 ? null : setTimeout(() => this.checkIsAlive(), libConfig.webSocketTimeout));
	}
	private terminateSelf(): void {
		if (this.ws.readyState != libWs.WebSocket.CLOSED)
			this.ws.terminate();
	}

	public send(data: string | Buffer): void {
		try {
			this.ws.send(data);
		} catch (err: any) {
			this.wsLogger.error(`WebSocket error while sending data: ${err.message}`);
			this.terminateSelf();
		}
	}
	public close(): void {
		if (this.ws.readyState != libWs.WebSocket.CLOSED)
			this.ws.close();
	}
}
