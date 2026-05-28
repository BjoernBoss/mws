/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import { Config as libConfig } from "./config.js";
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

const BAD_HTTP_STRING_REGEX: RegExp = /[\x00-\x1f\x7f]/;

let NextClientId: number = 0;

export class ClientContext {
	public logIdentity: string;
	public path: string;

	constructor(logIdentity: string, path: string) {
		this.logIdentity = logIdentity;
		this.path = path;
	}
}

export class ClientBase extends libLog.LogIdentity {
	protected _url: libUrl.URL;
	protected _path: string;
	protected _fullPath: string;

	protected constructor(url: libUrl.URL, kind: string);
	protected constructor(client: ClientBase, kind: string);
	protected constructor(arg: libUrl.URL | ClientBase, kind: string) {
		const thisClientId = ++NextClientId;
		super(`${kind}!${thisClientId}`);
		this.id = thisClientId;

		if (arg instanceof libUrl.URL) {
			this._path = libLocation.Sanitize(arg.pathname, false);
			this._url = arg;
			this._fullPath = this._path;
		}
		else {
			this._path = arg._path;
			this._url = arg.url;
			this._fullPath = arg._fullPath;
		}
	}

	/* unique id to identify client in logs */
	readonly id: number;

	/* path relative to current module base-path */
	public get path(): string {
		return this._path;
	}

	/* absolute path on web-server */
	public get fullPath(): string {
		return this._fullPath;
	}

	/* raw request origin (no host will result in '_') */
	public get url(): libUrl.URL {
		return this._url;
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
enum UpgradeState {
	none,
	upgrading,
	upgraded
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
*	Request is considered acknowledged, as soon as a response has been triggered or a preparation started
*	Path remains URI encoded, as it was received, and path building will use the same encoded paths.
*	A request can only be responded to once, unless the response is marked as an error, in which
*		case it will either be sent (if possible) or the connection will be flushed and closed
*	Not responded to requests will result in [not-found]
*
*	All responses, which dont follow the normal execution path, should be marked as errors
*	Errors can bypass already promised responses, or kill the connection (if a response has already been sent)
*	Responses automatically add Config.responseCacheControl, if no other cache control is specified
*/
export abstract class IncomingBase extends ClientBase {
	protected request: libHttp.IncomingMessage;
	protected headerPatchers: HeaderPatch[];
	protected state: ResponseState;
	protected breakState: {
		listener: (() => void)[];
		completed: Promise<void> | null;
	};
	private throughput: {
		timer: NodeJS.Timeout | null,
		deadline: number,
		start: number,
		threshold: number,
		window: number
	};
	private processed: { promise: Promise<void>, resolve?: () => void };

	/* write the given header and content out (no need to update state; body may be null for HEAD responses of unknown size) */
	protected abstract finalizeBufferHeader(status: libRequest.StatusType, error: boolean, headers: Record<string, string>, content: { media: libRequest.MediaType, body: Buffer | null } | null): void;

	/* finish handling the request */
	protected abstract handleFinishing(): void;

	/* kill the current connection (if graceful, wait for the last queued data to be sent; may be called multiple times) */
	protected abstract handleKilling(graceful: boolean): Promise<void>;

	constructor(request: libHttp.IncomingMessage, host: string, protocol: string, kind: string) {
		super(new libUrl.URL(`${protocol}//${host == '' ? '_' : host}${request.url}`), kind);
		this.request = request;
		this.state = ResponseState.none;
		this.breakState = { listener: [], completed: null };
		this.headerPatchers = [];

		let resolver: any = null;
		this.processed = { promise: new Promise<void>((resolve) => resolver = resolve) };
		this.processed.resolve = resolver;

		/* setup the throughput measurement to detect any stalling connections */
		this.throughput = { timer: null, deadline: 0, start: 0, threshold: libConfig.throughputThreshold, window: libConfig.throughputWindow };
		if (this.throughput.threshold > 0) {
			this.throughput.start = Date.now() + libConfig.throughputStartup;
			this.updateThroughput(0);
		}
	}

	private constructQuickResponse(status: libRequest.StatusType, logReason: string | null, error: boolean | undefined, headers: Record<string, string> | undefined, content: { media: libRequest.MediaType, body: Buffer } | null): void {
		if (error == null)
			error = false;
		if (headers == null)
			headers = {};
		const description = `${this.isHead ? 'HEAD:' : ''}[${status.msg}]${logReason == null ? '' : `: ${logReason}`}`;

		if (!('Cache-Control' in headers) && libConfig.responseCacheControl != '')
			headers['Cache-Control'] = libConfig.responseCacheControl;

		/* check if the response can still be sent */
		if (this.state == ResponseState.none || (error && this.state == ResponseState.acknowledged)) {
			if (error)
				this.error(`Responding with ${description}`);
			else
				this.log(`Responding with ${description}`);

			/* check if the connection was already acknowledged for different content, in which case
			*	it can be marked as broken to notify the original intent that something failed */
			const closing = (this.state == ResponseState.acknowledged);
			if (closing)
				headers['Connection'] = 'close';

			this.state = ResponseState.completed;
			this.finalizeBufferHeader(status, error, headers, content);

			if (closing)
				this.markAsBroken('Broken due to error while preparing response', true);
		}
		else if (!error)
			this.respondBadInternalUsage();
		else if (this.state == ResponseState.headerSent)
			this.markAsBroken(`Broken due to ${description}`, false);
		else
			this.error(`Silently dropping exception for ${description}`);
	}
	private failThroughput(): void {
		if (this.throughput.threshold <= 0 || this.state == ResponseState.broken)
			return;

		const closing = (this.state == ResponseState.none || this.state == ResponseState.acknowledged);
		if (closing)
			this.respondRequestTimeout(`throughput below [${this.throughput.threshold}] bytes/sec`, { error: true, headers: { 'Connection': 'close' } });
		this.markAsBroken(`Throughput below [${this.throughput.threshold}] bytes/sec`, closing);
	}
	protected updateThroughput(delta: number): void {
		if (this.throughput.timer != null)
			clearTimeout(this.throughput.timer);
		this.throughput.timer = null;
		if (this.throughput.threshold <= 0)
			return;
		const _now = Date.now();
		const now = Math.max(_now, this.throughput.start);

		/* shift the deadline according to the bought time by the throughput */
		const bought = (delta / this.throughput.threshold) * 1000;
		this.throughput.deadline = now + Math.min(this.throughput.window, Math.max(0, this.throughput.deadline - now) + bought);
		this.throughput.timer = setTimeout(() => this.failThroughput(), this.throughput.deadline - _now);
	}
	protected connectionWasLost(closed: boolean): void {
		if (this.state != ResponseState.completed && this.state != ResponseState.broken)
			this.markAsBroken((closed ? 'Connection closed by remote' : 'Connection lost'), false);
	}
	protected markAsBroken(reason: string, graceful: boolean): void {
		this.error(`Connection broken: [${reason}]`);
		this.state = ResponseState.broken;
		if (this.breakState.completed != null) {
			if (!graceful)
				this.handleKilling(false);
			return;
		}

		/* setup the promise beforehand to ensure the promise body does not recursively
		*	enter this handler again, and sees the completed object still being unset */
		let resolver = () => { };
		this.breakState.completed = new Promise<void>((res) => resolver = res);

		/* setup the break promise to ensure the connection is killed properly with the given grace */
		(async () => {
			let settled = false;

			const forceDestroy = setTimeout(() => {
				if (settled) return; settled = true;
				this.handleKilling(false);
				resolver();
			}, libConfig.killGraceTimeout);

			await this.handleKilling(graceful);
			clearTimeout(forceDestroy);

			if (settled) return; settled = true;
			resolver();
		})();

		/* notify all broken listener */
		for (const cb of this.breakState.listener)
			cb();
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
	public get completion(): Promise<void> {
		return this.processed.promise;
	}

	public async _finishConnection(): Promise<void> {
		try {
			if (this.state == ResponseState.none)
				this.respondNotFound();
			this.handleFinishing();
		} catch (_) { }

		/* kill the throughput timer, as it either does not need to be checked anymore, or it
		*	will have left the connection as broken, and will automatically be closed now */
		if (this.throughput.timer != null)
			clearTimeout(this.throughput.timer);
		this.throughput.timer = null;
		this.throughput.threshold = 0;

		/* check if the connection is broken and await its grace cleanup completion */
		if (this.state == ResponseState.broken)
			await this.breakState.completed!;

		this.log('Request processing completed');
		this.processed.resolve!();
	}
	public _killConnection(): void {
		this.markAsBroken('Closing connection', false);
	}
	public _pushTranslation(path: string, identity: string): ClientContext | null {
		if (!libLocation.IsSubDirectory(path, this._fullPath))
			return null;
		const current = new ClientContext(this.logIdentity, this._path);

		this._path = this._fullPath.substring(path.endsWith('/') ? path.length - 1 : path.length);
		if (this._path == '')
			this._path = '/';

		if (identity != '')
			this.logIdentity = `${this.logIdentity}.${identity}`;
		return current;
	}
	public _restoreSnapshot(snapshot: ClientContext): void {
		this.logIdentity = snapshot.logIdentity;
		this._path = snapshot.path;
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
	public respondInternalError(reason: string, options?: { headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.InternalError, reason, true, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`An internal server error occurred while processing the request for [${this.url.pathname}]:\n${reason}`, 'utf-8')
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
			return this.constructQuickResponse(status, `no body`, options?.error, options?.headers, null);

		let media = options?.media ?? libRequest.Media.Text;
		if (typeof content == 'string')
			content = Buffer.from(content, 'utf-8');
		else if (options?.media == null)
			media = libRequest.Media.Unknown;

		this.constructQuickResponse(status, `[${media.mediaType}] and size [${content.byteLength}]`, options?.error, options?.headers, {
			media, body: content
		});
	}

	/* respond with [ok] and either a message or a default response */
	public respondOk(options?: { message?: string, error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.Ok, options?.message ?? null, options?.error, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(options?.message ?? `${this.method} was successful for [${this.url.pathname}].`, 'utf-8')
		});
	}

	/* respond with [created] and either a message or a default response (ensure target is properly URI encoded) */
	public respondCreated(target: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;

		this.constructQuickResponse(libRequest.Status.Created, target, options?.error, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Resource [${this.url.pathname}] successfully created:\n${target}`, 'utf-8')
		});
	}

	/* respond with [not-modified] and no body */
	public respondNotModified(options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.NotModified, null, options?.error, options?.headers, null);
	}

	/* respond with [not-modified] and a default text response (ensure the etag and/or last-modified is set) */
	public respondPreconditionFailed(reason: string, options?: { etag?: string, lastModified?: string, error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		if (options?.etag != null && !('ETag' in header))
			header['ETag'] = options.etag;
		if (options?.lastModified != null && !('Last-Modified' in header))
			header['Last-Modified'] = options.lastModified;

		this.constructQuickResponse(libRequest.Status.PreconditionFailed, reason, options?.error, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Precondition for resource [${this.url.pathname}] failed:\n${reason}`, 'utf-8')
		});
	}

	/* respond with [bad-request] and a default text response */
	public respondBadRequest(reason: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.BadRequest, reason, options?.error, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Request for [${this.url.pathname}] is perceived as malformed:\n${reason}`, 'utf-8')
		});
	}

	/* respond with [range-not-satisfiable] and a default text response */
	public respondRangeIssue(range: string, size: number, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Content-Range'] = `bytes */${size}`;

		this.constructQuickResponse(libRequest.Status.RangeIssue, `[${range}] cannot be satisfied for size [${size}]`, options?.error, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Range [${range}] cannot be satisfied for [${this.url.pathname}] of size ${size}.`, 'utf-8')
		});
	}

	/* respond with [conflict] and a default text response */
	public respondConflict(conflict: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.Conflict, conflict, options?.error, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Conflict for resource [${this.url.pathname}]:\n${conflict}`, 'utf-8')
		});
	}

	/* respond with [not-found] and a default text response */
	public respondNotFound(options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.NotFound, null, options?.error, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Resource [${this.url.pathname}] could not be found.`, 'utf-8')
		});
	}

	/* respond with [unsupported-media-type] and a default text response */
	public respondUnsupported(used: string, allowed: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.UnsupportedMediaType, `Allowed was [${allowed}] but [${used}] was used`, options?.error, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Media type [${used}] not supported for [${this.url.pathname}].\nAllowed: ${allowed}`, 'utf-8')
		});
	}

	/* respond with [invalid-method] and a default text response */
	public respondMethodNotAllowed(method: string, allowed: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Allow'] = allowed;

		this.constructQuickResponse(libRequest.Status.MethodNotAllowed, `Allowed was [${allowed}] but [${method}] was used`, options?.error, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Method ${method} not allowed for [${this.url.pathname}].\nAllowed: ${allowed}`, 'utf-8')
		});
	}

	/* respond with [request-timeout] and a default text response */
	public respondRequestTimeout(reason: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Connection'] = 'close';

		this.constructQuickResponse(libRequest.Status.RequestTimeout, reason, options?.error, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Request processing of [${this.url.pathname}] timed out:\n${reason}`, 'utf-8')
		});
	}

	/* respond with [content-too-large] and a default text response */
	public respondContentTooLarge(allowed: number, atLeastProvided: number, options?: { error?: boolean, headers?: Record<string, string> }): void {
		this.constructQuickResponse(libRequest.Status.ContentTooLarge, `[${atLeastProvided}] > [${allowed}]`, options?.error, options?.headers, {
			media: libRequest.Media.Text, body: Buffer.from(`Content of at least size ${atLeastProvided} too large for [${this.url.pathname}].\nAt most ${allowed} bytes are allowed.`, 'utf-8')
		});
	}

	/* respond with [see-other] to the given target and a default text response (forces method GET; ensure target is properly URI encoded) */
	public respondSeeOther(target: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;

		this.constructQuickResponse(libRequest.Status.SeeOther, target, options?.error, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Continue at: ${target}`, 'utf-8')
		});
	}

	/* respond with [temporary-redirect] to the given target and a default text response (preserves method; ensure target is properly URI encoded) */
	public respondTemporaryRedirect(target: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;

		this.constructQuickResponse(libRequest.Status.TemporaryRedirect, target, options?.error, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Resource [${this.url.pathname}] temporarily redirects to:\n${target}`, 'utf-8')
		});
	}

	/* respond with [permanent-redirect] to the given target and a default text response (preserves method; ensure target is properly URI encoded)  */
	public respondPermanentRedirect(target: string, options?: { error?: boolean, headers?: Record<string, string> }): void {
		const header = (options?.headers ?? {});
		header['Location'] = target;

		this.constructQuickResponse(libRequest.Status.PermanentRedirect, target, options?.error, header, {
			media: libRequest.Media.Text, body: Buffer.from(`Resource [${this.url.pathname}] permanently redirects to:\n${target}`, 'utf-8')
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
*
*	Defaults [Accept-Ranges] to none
*	Defaults [Vary] to 'Accept-Encoding'
*/
export class HttpRequest extends IncomingBase {
	private response: libHttp.ServerResponse;
	private receive: ReceiveState;
	private htmlPatcher: HtmlPatch[];

	constructor(request: libHttp.IncomingMessage, response: libHttp.ServerResponse, host: string, protocol: string) {
		super(request, host, protocol, 'client');
		this.response = response;
		this.receive = ReceiveState.none;
		this.htmlPatcher = [];

		/* register the necessary network error handlers */
		request.once('error', () => this.connectionWasLost(false));
		request.once('aborted', () => this.connectionWasLost(true));
		response.once('error', () => this.connectionWasLost(false));
		response.once('close', () => this.connectionWasLost(true));
	}

	protected override finalizeBufferHeader(status: libRequest.StatusType, error: boolean, headers: Record<string, string>, content: { media: libRequest.MediaType, body: Buffer | null } | null): void {
		if (content == null)
			this.closeHeader(status, null, null, false, '', headers, error);
		else {
			headers['Vary'] = 'Accept-Encoding';

			/* check if the data should be encoded (if the size is not known, pretend the buffer to be large enough) */
			const encoding: libRequest.EncodingType | null = libRequest.NegotiateEncoding(this.headers['accept-encoding'] ?? null, content.body?.byteLength ?? null, content.media);
			if (encoding != null) {
				if (content.body != null)
					content.body = encoding.encodeBuffer(content.body);
				headers['Content-Encoding'] = encoding.name;
			}
			this.closeHeader(status, content.media, content.body?.byteLength ?? null, false, encoding?.name ?? '', headers, error);
		}

		/* try to finalize the response (can throw an exception for invalid status or header content) */
		try {
			if (!this.isHead && content?.body != null) {
				this.updateThroughput(content.body.length);
				this.response.end(content.body);
			}
			else
				this.response.end();
		} catch (err: any) {
			this.markAsBroken(`Failed to finalize response: ${err.message}`, false);
		}
	}
	protected override handleFinishing(): void {
		if (this.receive == ReceiveState.receiving) {
			/* check if the response is already completed, in which case it can be silently
			*	reset to 'header-sent' to ensure the connection is properly marked as broken */
			if (this.state == ResponseState.completed)
				this.state = ResponseState.headerSent;
			this.respondBadInternalUsage();
		}

		/* ensure that the response was properly sent */
		if (this.state != ResponseState.completed && this.state != ResponseState.broken)
			this.respondBadInternalUsage();

		/* check if a definitive end of the connection has been reached */
		if (this.state == ResponseState.broken || this.request.readableEnded || this.request.destroyed)
			return;

		/* check if data remain in the pipeline, in which case the connection needs
		*	to be closed to ensure the sender does not pipe more data over */
		const length = parseInt(this.headers['content-length'] ?? '0');
		const chunked = (this.headers['transfer-encoding'] != null);
		if (length != 0 || chunked)
			this.markAsBroken((this.request.readableLength > 0 ? 'Uploaded data not consumed' : 'Potential uploaded data not consumed'), true);
	}
	protected override async handleKilling(graceful: boolean): Promise<void> {
		const closeConnection = () => {
			if (this.request.destroyed && this.response.destroyed)
				return;
			const error = new Error('Connection broken');
			this.request.destroy(error);
			this.response.destroy(error);
		};

		if (!graceful || this.response.writableFinished || this.response.destroyed)
			return closeConnection();

		return new Promise<void>((resolve) => {
			let settled = false, handler = () => {
				if (settled) return; settled = true;
				closeConnection();
				resolve();
			};
			this.response.once('finish', () => handler());
			this.response.once('error', () => handler());
			this.response.once('close', () => handler());
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
		if (!('Vary' in headers))
			headers['Vary'] = 'Accept-Encoding';
		if (contentSize != null)
			headers['Content-Length'] = contentSize.toString();
		if (media != null)
			headers['Content-Type'] = libRequest.BuildMediaTypeIdentifier(media);

		/* perform the header post processing (in reverse order to ensure first added is last executed) */
		for (let i = this.headerPatchers.length - 1; i >= 0; --i) {
			try { this.headerPatchers[i](status, headers, error); }
			catch (err: any) { this.error(`Unhandled exception in header patcher: ${err.message}`); }
		}

		/* setup the response status and headers (guard against invalid header values from patchers or modules) */
		this.response.statusCode = status.code;
		this.response.statusMessage = status.msg;
		for (const [key, value] of Object.entries(headers)) {
			try {
				this.response.setHeader(key, value);
			} catch (_) {
				this.error(`Failed to set header [${key}]: Bad header value`);
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
		if (this.state == ResponseState.broken)
			return makeErrorStream('Connection broken');
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
					return cb(new Error('Connection broken'));

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
				decoder.once('error', (err: any) => {
					if (output.destroyed) return;
					this.respondBadRequest('Invalid data encoding', { error: true });
					output.destroy(err);
				});

				/* register the cleanup handler to ensure the decoder is destroyed on completion */
				output.once('close', () => decoder.destroy());
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

		/* register the broken handler to detect closed or failed connections */
		this.breakState.listener.push(() => {
			if (!output.destroyed)
				output.destroy(new Error('Connection broken'));
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
		resp.headers['Vary'] = 'Accept-Encoding';
		if (resp.contentEncoding != null) {
			resp.headers['Content-Encoding'] = resp.contentEncoding;
			this.closeHeader(resp.status, resp.contentType, fullContentSize, true, `pre-encoded:${resp.contentEncoding}`, resp.headers, false);
			return this.sendClientWrite(resp, chunk, last, cb);
		}

		/* lookup the dynamic encoder (for [head] and no explicit content, default to size being valid to just
		*	assume an encoding - can always be disabled in the real run, should the data be too short) */
		let encoding = resp.dynamicEncoder;
		if (encoding === undefined)
			encoding = libRequest.NegotiateEncoding(this.headers['accept-encoding'] ?? null, fullContentSize ?? chunk?.byteLength ?? null, resp.contentType);
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

			resp.writer.once('error', (err: any) => {
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
			return cb(new Error('Connection broken'));

		/* handle the data accordingly and check for any errors due to malformed headers */
		try {
			if (this.state == ResponseState.headerSent)
				return this.sendClientWrite(resp, chunk, chunk == null, cb);
			this.sendClientSetupHeader(resp, chunk, cb);
		}
		catch (err: any) {
			this.markAsBroken(`Failed to process response: ${err.message}`, false);
			return cb(new Error('Connection broken'));
		}
	}
	private sendClientData(status: libRequest.StatusType, media: libRequest.MediaType, headers: Record<string, string>, options: { encoded?: string, encoder?: libRequest.EncodingType | null, contentSize?: number }): libStream.Writable {
		const makeErrorStream = (msg: string) => new libStream.Writable({ write(_0, _1, cb) { cb(new Error(msg)) }, final(cb) { cb(new Error(msg)) } });

		/* check if the object is already responded */
		if (this.state == ResponseState.broken)
			return makeErrorStream('Connection broken');
		if (this.state != ResponseState.none) {
			this.respondBadInternalUsage();
			return makeErrorStream('Connection already responded');
		}
		this.state = ResponseState.acknowledged;

		const response = new HttpRequestResponse(this.response, status, headers,
			options.contentSize ?? null, media, options.encoded ?? null, options.encoder,
			(chunk: Buffer | null, cb: (err: any) => void) => this.sendClientHandle(response, chunk, cb),
			(err: any, cb: (err: any) => void) => {
				if (this.state == ResponseState.completed)
					return cb(err);

				/* check if the output stream was an encoder, in which case it still needs to
				*	be destroyed (only if an error occurred and the response was not completed) */
				if (response.writer !== this.response)
					response.writer.destroy();

				/* check if the error originated from the outside and ensure the connection is closed */
				if (!this.response.destroyed) {
					const closing = (this.state == ResponseState.acknowledged);
					if (closing)
						this.respondBadInternalUsage({ headers: { 'Connection': 'close' } });
					this.markAsBroken(`Data transfer failed: ${err.message}`, closing);
				}
				return cb(err);
			}
		);

		/* register the broken handler to detect closed or failed connections */
		this.breakState.listener.push(() => {
			if (!response.destroyed)
				response.destroy(new Error('Connection broken'));
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
			stream.once('end', () => resolve(Buffer.concat(buffers)));
			stream.once('error', (err: any) => reject(err));
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
			source.once('error', (err: any) => {
				sourceFailed = true;
				destination.destroy(err);
			});
			destination.once('open', () => {
				opened = true;
				if (!sourceFailed)
					source.pipe(destination);
				else
					destination.destroy();
			});
			destination.once('error', (err: any) => {
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
			destination.once('close', () => {
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
			try {
				lightBuild = this.htmlPatcher[i](page, status, headers, this.isHead) || lightBuild;
				if (this.state != ResponseState.acknowledged)
					return;
			} catch (err: any) {
				this.error(`Unhandled exception in HTML patcher: ${err.message}`);
				this.respondBadInternalUsage();
				return;
			}
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
	*	if not pre-encoded, the encoder can be selected manually/disabled (warning: no checks against accepted encodings performed!)
	*	otherwise, if encoder is undefined, it will be negotiated based on the content
	*	for a HEAD request, no encoding will be negotiated, no lengths verified, and the written data will just be drained (can immediately be ended using '.end()')
	*	automatically adds Config.responseCacheControl, if no other cache control is specified */
	public respondData(options?: { status?: libRequest.StatusType, media?: libRequest.MediaType, encoded?: string, contentSize?: number, encoder?: libRequest.EncodingType | null, headers?: Record<string, string> }): libStream.Writable {
		const status: libRequest.StatusType = options?.status ?? libRequest.Status.Ok;
		this.log(`Responding with data and status [${status.msg}]`);
		const headers = (options?.headers ?? {});
		if (!('Cache-Control' in headers) && libConfig.responseCacheControl != '')
			headers['Cache-Control'] = libConfig.responseCacheControl;
		return this.sendClientData(status, options?.media ?? libRequest.Media.Unknown, headers, { encoded: options?.encoded, contentSize: options?.contentSize, encoder: options?.encoder });
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

		/* mark byte-ranges to be supported in principle and add the caching properties (use a weak
		*	ETag when dynamic compression may produce different byte representations; dont use a dynamic
		*	encoder on range requests, as random access cannot be provided in that case) */
		const headers = (options?.headers ?? {}), media = (options?.media ?? libRequest.LookupMediaTypeFromFile(filePath));
		const dynamicEncoder = ((options?.encoded != null || range.state != libRequest.RangeState.noRange) ? null : libRequest.NegotiateEncoding(this.headers['accept-encoding'] ?? null, cached.fileSize(), media));
		const etag = (dynamicEncoder != null ? `W/"${cached.uniqueId()}"` : `"${cached.uniqueId()}"`);
		headers['Vary'] = 'Accept-Encoding';
		headers['Accept-Ranges'] = 'bytes';
		headers['Last-Modified'] = cached.lastModified();
		headers['ETag'] = etag;
		if (!('Cache-Control' in headers)) {
			if (cached.isImmutable() && libConfig.immutableCacheControl != '')
				headers['Cache-Control'] = libConfig.immutableCacheControl;
			else if (libConfig.fileCacheControl != '')
				headers['Cache-Control'] = libConfig.fileCacheControl;
		}

		/* validate the conditions (e-tag more relevant than last-modified; invalid times are not
		*	considered errors; no need to set etag/last-modified, as they are already set) */
		if (this.headers['if-match'] != null) {
			if (!libRequest.ETagMatchesList(etag, this.headers['if-match'], true)) {
				this.respondPreconditionFailed(`New etag [${etag}]`, { headers });
				return true;
			}
		}
		else if (this.headers['if-unmodified-since'] != null) {
			const result = libRequest.TimeStampCompare(cached.lastModified(), this.headers['if-unmodified-since']);
			if (result != null && result > 0) {
				this.respondPreconditionFailed(`Modified at [${cached.lastModified()}]`, { headers });
				return true;
			}
		}

		/* check if the response can be skipped due to the resource not having been modified since
		*	the last fetch (etag outweighs last-modified; invalid times are not considered errors) */
		if (this.headers['if-none-match'] != null) {
			if (libRequest.ETagMatchesList(etag, this.headers['if-none-match'], false)) {
				this.respondNotModified({ headers });
				return true;
			}
		}
		else if (this.headers['if-modified-since'] != null) {
			const result = libRequest.TimeStampCompare(cached.lastModified(), this.headers['if-modified-since']);
			if (result != null && result <= 0) {
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

		/* create the writer stream (doesn't throw, but errors, enforce the selected encoder) */
		const status = (range.state == libRequest.RangeState.noRange ? libRequest.Status.Ok : libRequest.Status.PartialContent);
		let stream = this.sendClientData(status, media, headers, {
			encoded: options?.encoded,
			encoder: dynamicEncoder,
			contentSize: range.last - range.first + 1
		});
		this.log(`Sending ${this.isHead ? 'HEAD' : 'content'} [${range.first} - ${range.last}/${cached.fileSize()}] from [${filePath}]`);

		/* check if this is a head request, in which case the stream can just immediately be closed again, to prevent
		*	the file from consuming resources (null-catch any errors to ensure they are not propagated out of the connection) */
		if (this.isHead) {
			stream.once('error', () => { });
			return new Promise((resolve) => stream.end(() => resolve(true)));
		}

		/* create the source stream of the file to read from (will not throw any exceptions) */
		let source: libStream.Readable = cached.stream({ start: range.first, end: range.last });

		/* pipe the components together and await completion */
		let settled = false;
		return new Promise((resolve) => {
			source.pipe(stream);
			source.once('error', (err: any) => {
				if (settled) return; settled = true;
				this.respondFileSystemError();
				stream.destroy(err);
			});
			stream.once('error', (err: any) => {
				if (settled) return; settled = true;
				source.destroy(err);
			});
			stream.once('close', () => {
				settled = true;
				resolve(true);
			});
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
	public dynamicEncoder: libRequest.EncodingType | null | undefined;
	public contentType: libRequest.MediaType;
	public contentEncoding: string | null;

	constructor(response: libStream.Writable, status: libRequest.StatusType, headers: Record<string, string>, contentSize: number | null, contentType: libRequest.MediaType,
		contentEncoding: string | null, dynamicEncoder: libRequest.EncodingType | null | undefined, handleData: (chunk: Buffer | null, cb: (err: any) => void) => void, destroy: (err: any, cb: (err: any) => void) => void
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
		this.dynamicEncoder = dynamicEncoder;
		this.contentType = contentType;
		this.contentEncoding = contentEncoding;
	}
}

/*
*	WebSocket upgrade requests, which were not accepted, will be closed after responding
*	Responses will not add or modify any cache configurations
*	An accept attempt must be fully awaited before completing the upgrade procedure
*/
export class HttpUpgrade extends IncomingBase {
	private socket: libStream.Duplex;
	private head: Buffer;
	private wss: libWs.WebSocketServer;
	private upgrade: UpgradeState;

	constructor(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, host: string, protocol: string, wss: libWs.WebSocketServer) {
		super(request, host, protocol, 'upgrade');
		this.socket = socket;
		this.head = head;
		this.wss = wss;
		this.upgrade = UpgradeState.none;

		/* register the necessary network error handlers */
		request.once('error', () => this.connectionWasLost(false));
		request.once('close', () => this.connectionWasLost(true));
		socket.once('error', () => this.connectionWasLost(false));
		socket.once('close', () => this.connectionWasLost(true));
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
		for (let i = this.headerPatchers.length - 1; i >= 0; --i) {
			try { this.headerPatchers[i](status, headers, error); }
			catch (err: any) { this.error(`Unhandled exception in header patcher: ${err.message}`); }
		}

		/* construct the entire header content and send it away (sanitize values to prevent response splitting) */
		if (status.msg.match(BAD_HTTP_STRING_REGEX))
			return this.markAsBroken(`Failed to finalize response: Bad status message`, false);

		let headerText = `HTTP/1.1 ${status.code} ${status.msg}\r\n`;
		for (const [key, value] of Object.entries(headers)) {
			if (value.match(BAD_HTTP_STRING_REGEX))
				this.error(`Failed to set header [${key}]: Bad header value`);
			else
				headerText += `${key}: ${value}\r\n`;
		}
		headerText += '\r\n';
		this.socket.write(headerText, 'utf-8');

		if (!this.isHead && content?.body != null) {
			this.updateThroughput(content.body.length);
			this.socket.end(content.body);
		}
		else
			this.socket.end();
	}
	protected override handleFinishing(): void {
		/* check if the upgrade was not fully awaited */
		if (this.upgrade == UpgradeState.upgrading)
			this.respondBadInternalUsage();

		/* check if the connection was accepted (only reason to keep it alive,
		*	as source web-server will not clean this connection up anymore) */
		if (this.state == ResponseState.completed && this.upgrade == UpgradeState.upgraded)
			return;

		/* check if the state is incomplete and break the connection but ensure it is closed
		*	either way (to ensure the connection is definitely closed, if not upgrade) */
		if (this.state != ResponseState.completed && this.state != ResponseState.broken)
			this.respondBadInternalUsage();
		if (this.state != ResponseState.broken)
			this.markAsBroken('Upgrade was not accepted', true);
	}
	protected override async handleKilling(graceful: boolean): Promise<void> {
		const closeConnection = () => {
			if (this.request.destroyed && this.socket.destroyed)
				return;
			const error = new Error('Connection broken');
			this.request.destroy(error);
			this.socket.destroy(error);
		};

		if (!graceful || this.socket.writableFinished || this.socket.destroyed)
			return closeConnection();

		return new Promise<void>((resolve) => {
			let settled = false, handler = () => {
				if (settled) return; settled = true;
				closeConnection();
				resolve();
			};
			this.socket.once('finish', () => handler());
			this.socket.once('error', () => handler());
			this.socket.once('close', () => handler());
		});
	}

	/* [no-throw] marks the object as having been handled and returns a web socket or
	*	automatically responds with a corresponding error and returns null */
	public async acceptWebSocket(): Promise<ClientSocket | null> {
		if (this.state != ResponseState.none) {
			this.respondBadInternalUsage();
			return null;
		}

		/* check if the connection is a valid upgrade request */
		let connection = libRequest.SplitAndTrimList(this.headers.connection?.toLowerCase() ?? null, ',', false);
		if (connection.indexOf('upgrade') == -1 || this.headers?.upgrade?.toLowerCase() != 'websocket' || this.request.method != 'GET') {
			this.respondBadRequest('Endpoint designed for WebSockets', { error: true });
			return null;
		}

		/* mark the connection as being accepted */
		this.state = ResponseState.headerSent;
		this.upgrade = UpgradeState.upgrading;
		this.trace(`Performing upgrade on web socket connection: [${this._fullPath}]`);
		const ws = await new Promise<ClientSocket | null>((resolve) => {
			let settled = false;

			/* register the broken listener (to detect failures of the upgrading or network errors) */
			this.breakState.listener.push(() => {
				if (settled) return; settled = true;
				this.error('Failed to upgrade to WebSocket');
				resolve(null);
			});

			/* start the upgrade process (web-socket upgrade handler will automatically send error messages) */
			this.wss.handleUpgrade(this.request, this.socket, this.head, (ws, _) => {
				if (!settled && this.state == ResponseState.headerSent) {
					settled = true, this.state = ResponseState.completed;

					/* ensure that the socket is valid as otherwise proper cleanup might not be guaranteed (no
					*	need to log errors, as this will trigger the broken state, which will be logged) */
					if (this.socket.destroyed)
						return resolve(null);
					return resolve(new ClientSocket(ws, this));
				}
				const settler = !settled;
				settled = true;
				this.markAsBroken('Broken connection upgraded', false);
				if (settler)
					resolve(null);
			});
		});
		this.upgrade = UpgradeState.upgraded;
		return ws;
	}
}

/*
*	WebSocket with integrated alive checks
*	Structured WebSocket, which takes care of error handling.
*	close() is guaranteed to be called exactly once and no data or others will follow.
*	Closing promise resolves once the close callback has been fully invoked.
*/
export class ClientSocket extends ClientBase {
	private ws: libWs.WebSocket;
	private timer: null | NodeJS.Timeout;
	private isAlive: boolean;
	private closing: { promise: Promise<void> | null, closed: (() => void) | null, defer: number };
	private logging: {
		root: libLog.LogIdentity,
		tags: { value: string }[]
	};

	public ondata?: (data: libWs.RawData, isBinary: boolean) => void;
	public onclose?: () => void;

	constructor(ws: libWs.WebSocket, base: HttpUpgrade) {
		super(base, 'socket');
		this.ws = ws;
		this.timer = null;
		this.isAlive = true;
		this.closing = { promise: null, closed: null, defer: 0 };
		this.logging = { root: libLog.Logger(this.logIdentity), tags: [] };

		this.ws.on('pong', () => {
			this.logging.root.trace(`Alive check pong received`);
			this.selfIsAlive();
		});
		this.ws.on('message', (data, isBinary) => {
			this.selfIsAlive();
			if (this.closing.promise != null || this.ondata == null)
				return;

			++this.closing.defer;
			try { this.ondata(data, isBinary); }
			catch (err: any) {
				this.handleClosing(`Unhandled exception in message handler: ${err.message}`);
			}
			--this.closing.defer;

			if (this.closing.promise != null)
				this.handleClosing();
		});
		this.ws.once('close', () => {
			this.handleClosing();

			/* check if any timers remain (must be the grace-kill timer, can be stopped, as this point can
			*	only be reached with an active timer, if defer was somehow still > 0, in which case its
			*	nested leaving will trigger the proper cleanup, but the timer is not necessary anymore) */
			if (this.timer != null)
				clearTimeout(this.timer);
			this.timer = null;
		});
		this.ws.once('error', (err: any) => {
			this.handleClosing(`WebSocket error: ${err.message}`);
		});

		/* start the first alive check */
		this.selfIsAlive();

		/* perserve the log tags of the base */
		base.log(`WebSocket acccepted: [${this.logIdentity}]`);
		const logTagList = base.logIdentity.indexOf('.');
		if (logTagList >= 0) {
			this.logging.tags.push({ value: base.logIdentity.substring(logTagList + 1) });
			this.updateLogging();
		}
	}

	private checkIsAlive(): void {
		if (this.closing.promise != null)
			return;

		this.timer = null;
		if (libConfig.webSocketTimeout == 0)
			return;

		/* check if the connection is not alive anymore and should be killed */
		if (!this.isAlive || libConfig.webSocketAliveTimeout == 0)
			return this.handleClosing('Closing dead websocket');
		this.isAlive = false;
		this.timer = setTimeout(() => this.checkIsAlive(), libConfig.webSocketAliveTimeout);

		/* try to ping the remote to check the liveliness */
		try {
			this.logging.root.trace(`Sending ping to determine if connection is alive`);
			this.ws.ping();
		} catch (err: any) {
			this.handleClosing(`WebSocket error while pinging: ${err.message}`);
		}
	}
	private selfIsAlive(): void {
		this.isAlive = true;
		if (this.closing.promise != null)
			return;

		if (this.timer != null)
			clearTimeout(this.timer);
		this.timer = (libConfig.webSocketTimeout == 0 ? null : setTimeout(() => this.checkIsAlive(), libConfig.webSocketTimeout));
	}
	private handleClosing(terminate?: string): void {
		/* register the initial closing to mark a closing being imminent */
		if (this.closing.promise == null) {
			this.closing.promise = new Promise<void>((res) => this.closing.closed = res);

			/* kill the last timer (alive timer) */
			if (this.timer != null)
				clearTimeout(this.timer);
			this.timer = null;

			/* check if a termination should be triggered and otherwise start the grace termination timer */
			if (terminate != null) {
				this.logging.root.error(terminate);
				this.ws.terminate();
			}
			else {
				this.timer = setTimeout(() => {
					this.timer = null;
					if (this.closing.closed != null) {
						this.logging.root.error('Closing connection');
						this.ws.terminate();
					}
				}, libConfig.killGraceTimeout);
			}
		}

		if (this.closing.closed == null || this.closing.defer > 0)
			return;
		const closed = this.closing.closed;
		this.closing.closed = null;

		if (this.onclose != null) {
			try { this.onclose(); }
			catch (err: any) {
				this.logging.root.error(`Unhandled exception in WebSocket close handler: ${err.message}`);
			}
		}
		this.logging.root.trace('Socket connection closed');

		closed();
	}
	private updateLogging(): void {
		let identity = this.logging.root.logIdentity;

		for (const tag of this.logging.tags) {
			if (tag.value != '')
				identity += `.${tag.value}`;
		}

		this.logIdentity = identity;
	}

	/* tag the logging with the given identity and return a callback to update the tag (empty string will
	*	hide the tag entry; null will completely remove the tag; other values will update the tag) */
	public tagLog(identity: string): ((value?: string) => void) {
		let tag: { value: string } | null = { value: identity };

		this.logging.tags.push(tag);
		if (tag.value != '')
			this.updateLogging();

		/* setup the handler responsible to update the logging */
		return (value?: string) => {
			if (tag == null) return;

			/* check if the tag should be removed or if the value should just be updated */
			if (value == null) {
				this.logging.tags = this.logging.tags.filter((v) => v != tag);
				tag = null;
			}
			else if (value != tag.value)
				tag.value = value;

			this.updateLogging();
		};
	}

	public send(data: string | Buffer): void {
		if (this.closing.promise != null)
			return;

		try {
			this.ws.send(data);
		} catch (err: any) {
			this.handleClosing(`WebSocket error while sending data: ${err.message}`);
		}
	}
	public close(): Promise<void> {
		if (this.closing.promise == null) {
			this.ws.close();
			this.handleClosing();
		}
		return this.closing.promise!;
	}
}
