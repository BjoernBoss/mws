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
	protected context: Record<string, unknown>;

	/* path relative to current module base-path */
	public path: string;

	/* absolute path on web-server */
	public fullPath: string;

	/* base path between the fullPath and path */
	public basePath: string;

	/* raw request origin (no host will result in '_') */
	public url: libUrl.URL;

	/* unique id to identify client in logs */
	readonly id: number;

	protected constructor(url: libUrl.URL);
	protected constructor(client: ClientBase);
	protected constructor(arg: libUrl.URL | ClientBase) {
		if (arg instanceof libUrl.URL) {
			const thisClientId = ++NextClientId;
			super(`client!${thisClientId}`);

			/* decode the string and re-encode it to ensure '/' and '\' are preserved as URI encoding, but the rest is decoded */
			const cleanPath: string = arg.pathname.split('/').map((segment) => {
				return decodeURIComponent(segment).replace(/[/\\]/g, (c) => (c === '/' ? '%2F' : '%5C'));
			}).join('/');

			this.context = {};
			this.id = thisClientId;
			this.path = libLocation.Sanitize(cleanPath, false);
			this.url = arg;
			this.fullPath = this.path;
			this.basePath = '/';
		}
		else {
			super(arg.logIdentity);
			this.context = arg.context;
			this.path = arg.path;
			this.fullPath = arg.fullPath;
			this.basePath = arg.basePath;
			this.url = arg.url;
			this.id = arg.id;
		}
	}

	public getContext(name: string): unknown | null {
		if (name in this.context)
			return this.context[name];
		return null;
	}
	public setContext(name: string, value: unknown): void {
		this.context[name] = value;
	}
	public makePath(path: string): string {
		return libLocation.JoinSanitized(this.basePath, path);
	}

	/* check if path is a substring of the current path, and if so, shift the path and identity and return
	*	a snapshot of the old context (to be able to recover the old state), otherwise it returns null */
	public translate(path: string, identity: string): ClientContext | null {
		if (!libLocation.IsSubDirectory(path, this.path))
			return null;
		const current = new ClientContext(this.logIdentity, this.basePath, this.path);

		/* shift the paths and the log identity */
		this.basePath = libLocation.JoinSanitized(this.basePath, path);
		this.path = this.path.substring(path.endsWith('/') ? path.length - 1 : path.length);
		if (this.path == '')
			this.path = '/';
		this.logIdentity = `${this.logIdentity}.${identity}`;
		return current;
	}

	/* only shift onto the logging identity and return a snapshot of the old context */
	public shiftLog(identity: string): ClientContext {
		const current = new ClientContext(this.logIdentity, this.basePath, this.path);
		this.logIdentity = `${this.logIdentity}.${identity}`;
		return current;
	}

	/* preserve the current logging and translation context */
	public snapshot(): ClientContext {
		return new ClientContext(this.logIdentity, this.basePath, this.path);
	}

	/* restore a client log and translation context and return the previous context */
	public restore(snapshot: ClientContext): ClientContext {
		const current = new ClientContext(this.logIdentity, this.basePath, this.path);
		this.logIdentity = snapshot.logIdentity;
		this.basePath = snapshot.basePath;
		this.path = snapshot.path;
		return current;
	}
}

enum ResponseState {
	none,
	acknowledged,
	headerSent,
	completed,
	broken
}

let NextClientId: number = 0;
const WebSocketServerInstance: libWs.Server = new libWs.WebSocketServer({ noServer: true });

/*
*	Request is considered acknowledged, as soon as a response has been triggered or a preparation started.
*	Paths are URI decoded, except for nested '/' and '\'
*	A request can only be responded to once, unless the response is marked as an exception, in which
*		case it will either be sent (if possible) or the connection will be flushed and closed
*	Not responded to requests will result in [not-found]
*/
export abstract class IncomingBase extends ClientBase {
	protected request: libHttp.IncomingMessage;
	protected state: ResponseState;
	protected outputHeaders: Record<string, string>;

	/* write the given header and content out (no need to update state) */
	protected abstract finalizeTextHeader(status: libRequest.StatusType, media: libRequest.MediaType, content: string): void;

	/* finish handling the request (if ends on 'broken', must close the connection) */
	protected abstract finishSelfHandling(): Promise<void>;

	constructor(request: libHttp.IncomingMessage, host: string, protocol: string) {
		super(new libUrl.URL(`${protocol}//${host == '' ? '_' : host}${request.url}`));
		this.request = request;
		this.state = ResponseState.none;
		this.outputHeaders = {};
	}
	protected constructTextResponse(status: libRequest.StatusType, media: libRequest.MediaType, content: string, logReason: string, exception: boolean): void {
		if (this.state == ResponseState.none || (exception && this.state == ResponseState.acknowledged)) {
			this.log(`Responding ${this.isHead ? 'to HEAD ' : ''}with [${status.msg}]${logReason}`);
			this.finalizeTextHeader(status, media, content);
			this.state = ResponseState.completed;
		}
		else if (exception) {
			if (this.state == ResponseState.headerSent) {
				this.error(`Broken ${this.isHead ? 'for HEAD ' : ''}with [${status.msg}]${logReason}`);
				this.state = ResponseState.broken;
			}
			else
				this.error(`Silently dropping exception ${this.isHead ? 'for HEAD ' : ''}[${status.msg}]${logReason}`);
		}
		else
			throw new Error('Request has already been handled');
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
	public get responding(): boolean {
		return (this.state == ResponseState.acknowledged || this.state == ResponseState.headerSent);
	}
	public get completed(): boolean {
		return (this.state == ResponseState.completed);
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

	/* add the given header to the response (should be title cased) */
	public addHeader(key: string, value: string): void {
		if (this.state != ResponseState.none && this.state != ResponseState.acknowledged)
			throw new Error('Cannot modify headers of sent response');
		this.outputHeaders[key] = value;
	}

	/* called by framework to finish this incoming object (sends queued content, not-found if unhandled, or internal-error if incomplete/broken) */
	public async finishIncoming(): Promise<void> {
		if (this.state == ResponseState.none)
			return this.respondNotFound();
		await this.finishSelfHandling();
	}

	/* respond with [internal-error] and a pre-defined html template response (always considered an exception, clears any other header fields) */
	public respondInternalError(msg: string): void {
		this.outputHeaders = {};
		const content = libTemplates.ErrorInternalServerError({ path: this.url.pathname, what: msg });
		this.constructTextResponse(libRequest.Status.InternalError, libRequest.Media.Html, content, ` due to [${msg}]`, true);
	}

	/* respond with [internal-error] and message 'Filesystem operation failed' */
	public respondFileSystemError(): void {
		this.respondInternalError('Filesystem operation failed');
	}

	/* respond with a textual response of the given configuration (defaults to media-type: text, status: ok) */
	public respondAnyText(content: string, options?: { media?: libRequest.MediaType, status?: libRequest.StatusType, exception?: boolean }): void {
		const media = options?.media ?? libRequest.Media.Text;
		const status = options?.status ?? libRequest.Status.Ok;
		const logReason = ` of type [${media.mediaType}]: [${content.substring(0, 32).replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('\t', ' ')}${content.length > 32 ? '...' : ''}]`;
		this.constructTextResponse(status, media, content, logReason, options?.exception ?? false);
	}

	/* respond with [ok] and a pre-defined html template response */
	public respondOk(operation: string, options?: { exception?: boolean }): void {
		const content = libTemplates.SuccessOk({ path: this.url.pathname, operation: operation });
		this.constructTextResponse(libRequest.Status.Ok, libRequest.Media.Html, content, ` for [${operation}]`, options?.exception ?? false);
	}

	/* respond with [bad-request] and a pre-defined html template response */
	public respondBadRequest(reason: string, options?: { exception?: boolean }): void {
		const content = libTemplates.ErrorBadRequest({ path: this.url.pathname, reason });
		this.constructTextResponse(libRequest.Status.BadRequest, libRequest.Media.Html, content, ` due to [${reason}]`, options?.exception ?? false);
	}

	/* respond with [range-not-satisfiable] and a pre-defined html template response */
	public respondRangeIssue(range: string, size: number, options?: { exception?: boolean }): void {
		this.outputHeaders['Content-Range'] = `bytes */${size}`;
		const content = libTemplates.ErrorRangeIssue({ path: this.url.pathname, range, size });
		const logReason = `because [${range}] cannot be satisfied for size [${size}]`;
		this.constructTextResponse(libRequest.Status.RangeIssue, libRequest.Media.Html, content, logReason, options?.exception ?? false);
	}

	/* respond with [conflict] and a pre-defined html template response */
	public respondConflict(conflict: string, options?: { exception?: boolean }): void {
		const content = libTemplates.ErrorConflict({ path: this.url.pathname, conflict });
		this.constructTextResponse(libRequest.Status.Conflict, libRequest.Media.Html, content, ` due to [${conflict}]`, options?.exception ?? false);
	}

	/* respond with [not-found] and a pre-defined html template response */
	public respondNotFound(options?: { exception?: boolean }): void {
		const content = libTemplates.ErrorNotFound({ path: this.url.pathname });
		this.constructTextResponse(libRequest.Status.NotFound, libRequest.Media.Html, content, '', options?.exception ?? false);
	}

	/* respond with [unsupported-media-type] and a pre-defined html template response */
	public respondUnsupported(used: string, allowed: string, options?: { exception?: boolean }): void {
		const content = libTemplates.ErrorUnsupportedMediaType({ path: this.url.pathname, used, allowed });
		const logReason = ` because [${used}] was used and only [${allowed}] supported`;
		this.constructTextResponse(libRequest.Status.UnsupportedMediaType, libRequest.Media.Html, content, logReason, options?.exception ?? false);
	}

	/* respond with [invalid-method] and a pre-defined html template response */
	public respondMethodNotAllowed(method: string, allowed: string, options?: { exception?: boolean }): void {
		this.outputHeaders['Allow'] = allowed;
		const content = libTemplates.ErrorInvalidMethod({ path: this.url.pathname, method: method, allowed });
		const logReason = ` because [${method}] was used and only [${allowed}] supported`;
		this.constructTextResponse(libRequest.Status.MethodNotAllowed, libRequest.Media.Html, content, logReason, options?.exception ?? false);
	}

	/* respond with [content-too-large] and a pre-defined html template response */
	public respondContentTooLarge(allowed: number, atLeastProvided: number, options?: { exception?: boolean }): void {
		const content = libTemplates.ErrorContentTooLarge({ path: this.url.pathname, allowedLength: allowed, providedLength: atLeastProvided });
		this.constructTextResponse(libRequest.Status.ContentTooLarge, libRequest.Media.Html, content, ` because [${atLeastProvided}] > [${allowed}]`, options?.exception ?? false);
	}

	/* respond with [see-other] to the given target and a pre-defined html template response (forces method GET) */
	public respondSeeOther(target: string, options?: { exception?: boolean }): void {
		this.outputHeaders['Location'] = target;
		const content = libTemplates.SeeOther({ destination: target });
		this.constructTextResponse(libRequest.Status.SeeOther, libRequest.Media.Html, content, ` to [${target}]`, options?.exception ?? false);
	}

	/* respond with [temporary-redirect] to the given target and a pre-defined html template response (preserves method) */
	public respondTemporaryRedirect(target: string, options?: { exception?: boolean }): void {
		this.outputHeaders['Location'] = target;
		const content = libTemplates.TemporaryRedirect({ path: this.url.pathname, destination: target });
		this.constructTextResponse(libRequest.Status.TemporaryRedirect, libRequest.Media.Html, content, ` to [${target}]`, options?.exception ?? false);
	}

	/* respond with [permanent-redirect] to the given target and a pre-defined html template response (preserves method)  */
	public respondPermanentRedirect(target: string, options?: { exception?: boolean }): void {
		this.outputHeaders['Location'] = target;
		const content = libTemplates.PermanentRedirect({ path: this.url.pathname, destination: target });
		this.constructTextResponse(libRequest.Status.PermanentRedirect, libRequest.Media.Html, content, ` to [${target}]`, options?.exception ?? false);
	}
}

/*
*	Html response is sent once its content has been set and the modules have completed the processing
*	Http HEAD aware (will silently drain any data sent from a HEAD request)
*
*	Receiving data: Will automatically decode the stream and ensure a given maximum is not passed
*		=> Will drain upload if it is not being received or the request enters a broken state
*		=> Destroying receive reader will drain the remaining data
*		=> Any errors while receiving will either auto-respond or send the connection into the broken state, and fail the receive reader (stream user does not need to respond)
*	Responding data: Will automatically encode the stream and send the header accordingly
*		=> Will automatically determine if encoding is to be used
*		=> Checks if promised number of bytes is provided
*		=> Will automatically error, if the broken state is detected, and will auto-respond or send the connection into the broken state (stream user does not need to respond)
*	Cleanup: request detects incomplete responses (headers committed but body never finished) and will auto-respond or send the connection into the broken state
*/
export class HttpRequest extends IncomingBase {
	private response: libHttp.ServerResponse;
	private receiving: boolean;
	private htmlResponse?: { page: libBuilder.HtmlPage, status: libRequest.StatusType, lightBuild: boolean };

	constructor(request: libHttp.IncomingMessage, response: libHttp.ServerResponse, host: string, protocol: string) {
		super(request, host, protocol);
		this.response = response;
		this.receiving = false;
	}

	protected override finalizeTextHeader(status: libRequest.StatusType, media: libRequest.MediaType, content: string | null): void {
		let buffer: Buffer | null = (content == null ? null : Buffer.from(content, 'utf-8'));

		/* check if the data should be encoded (if no content is given, pretend the contend is large enough) */
		const encoding = libRequest.EncodingOption(this.headers['accept-encoding'] ?? null, buffer?.byteLength ?? libRequest.MIN_ENCODING_SIZE, media);
		if (encoding != null) {
			if (buffer != null)
				buffer = encoding.encodeBuffer(buffer);
			this.outputHeaders['Content-Encoding'] = encoding.name;
			this.outputHeaders['Vary'] = 'Accept-Encoding';
		}

		this.closeHeader(status, media, buffer?.byteLength ?? null, false, encoding?.name ?? '');
		if (this.isHead)
			this.response.end();
		else
			this.response.end(buffer);
	}
	protected override async finishSelfHandling(): Promise<void> {
		if (!this.receiving)
			this.request.resume();

		/* check if html has been queued and respond with it */
		if (this.state == ResponseState.acknowledged && this.htmlResponse != null) {
			if (this.htmlResponse.lightBuild)
				this.finalizeTextHeader(this.htmlResponse.status, libRequest.Media.Html, null);
			else
				this.finalizeTextHeader(this.htmlResponse.status, libRequest.Media.Html, this.htmlResponse.page.finalize());
			this.state = ResponseState.completed;
		}

		/* check if data were started but not completed or if data were promised but not provided */
		if (this.state == ResponseState.headerSent)
			this.respondInternalError('Response started but not completed');
		if (this.state == ResponseState.acknowledged)
			this.respondInternalError('Request processing failed');

		/* check if the connection is considered broken, in which case the
		*	data on it are not reliable anymore and it must be destroyed */
		if (this.state != ResponseState.broken)
			return;
		this.request.destroy();
		this.response.destroy();
	}
	private closeHeader(status: libRequest.StatusType, media: libRequest.MediaType, contentSize: number | null, updateState: boolean, encoding: string): void {
		this.trace(`Sending ${this.isHead ? 'HEAD' : 'content'} [${media.mediaType}] of size [${contentSize ?? 'unknown'}] ${encoding.length == 0 ? 'not encoded' : `encoded using [${encoding}]`}`);
		if (updateState)
			this.state = ResponseState.headerSent;

		/* setup the response status and headers */
		this.response.statusCode = status.code;
		this.response.statusMessage = status.msg;
		for (const key in this.outputHeaders)
			this.response.setHeader(key, this.outputHeaders[key]);
		this.response.setHeader('Server', libConfig.serverName);
		this.response.setHeader('Content-Type', libRequest.BuildMediaTypeIdentifier(media));
		this.response.setHeader('Date', new Date().toUTCString());
		if (!('Accept-Ranges' in this.outputHeaders))
			this.response.setHeader('Accept-Ranges', 'none');
		if (contentSize != null)
			this.response.setHeader('Content-Length', contentSize);
	}
	private receiveClientData(maxLength: number | null): libStream.Readable {
		/* check if the object is ready for receiving */
		if (this.receiving)
			throw new Error('Payload has already been handled');
		this.receiving = true;
		if (this.request.destroyed || this.state == ResponseState.broken)
			throw new Error('Connection is broken');

		/* add the accept-encoding list */
		const acceptedEncodings = libRequest.SupportedEncodingNames().join(',');
		this.outputHeaders['Accept-Encoding'] = acceptedEncodings;

		/* setup the accumulation transformer (which will also be returned in the end) */
		let accumulated = 0;
		const output = new libStream.Transform({
			transform: (chunk, _, cb) => {
				if (output.destroyed) return cb(new Error('Already failed'));

				/* check if the connection has been marked as failed */
				if (this.state == ResponseState.broken)
					return cb(new Error('Connection is broken'));

				/* check the maximum count (is violated) */
				accumulated += chunk.byteLength;
				if (maxLength == null || accumulated <= maxLength)
					return cb(null, chunk);
				this.respondContentTooLarge(maxLength, accumulated, { exception: true });
				cb(new Error('Request is too large'));
			}
		});

		/* drain the remainder of the request, if the output is closed/destroyed */
		output.on('close', () => {
			this.request.unpipe();
			if (!this.request.readableEnded)
				this.request.resume();
		});

		/* check if the content is encoded */
		let stream: libStream.Readable = this.request;
		if (this.headers['content-encoding'] != null) {
			const encoding: libRequest.EncodingType | null = libRequest.LookupEncoding(this.headers['content-encoding']);

			/* check if the encoding is unsupported and otherwise ensure the request is drained */
			if (encoding == null) {
				this.respondUnsupported(this.headers['content-encoding'], acceptedEncodings, { exception: true });
				this.request.resume();
				throw new Error('Unsupported content encoding');
			}

			/* wrap the request and register the compression stream failure handler */
			const decoder = encoding.makeDecode();
			stream = this.request.pipe(decoder);
			decoder.on('error', (err: any) => {
				if (output.destroyed) return;
				this.respondBadRequest('Invalid data encoding', { exception: true });
				output.destroy(err);
			});
			output.on('close', () => decoder.destroy());
		}

		/* check if too many data have been promised */
		else if (maxLength != null && this.headers['content-length'] != null) {
			const contentSize = parseInt(this.headers['content-length']);

			/* check if the length is valid and otherwise mark the request as 'consumed' */
			if (!isFinite(contentSize) || contentSize < 0 || contentSize > maxLength) {
				this.respondContentTooLarge(maxLength, contentSize, { exception: true });
				this.request.resume();
				throw new Error('Request payload is too large');
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
			this.outputHeaders['Content-Encoding'] = resp.contentEncoding;
			this.outputHeaders['Vary'] = 'Accept-Encoding';
			this.closeHeader(resp.status, resp.contentType, fullContentSize, true, `pre-encoded:${resp.contentEncoding}`);
			return this.sendClientWrite(resp, chunk, last, cb);
		}

		/* lookup the dynamic encoder (range content cannot be dynamically encoded, as it cannot be random accessed,
		*	and otherwise skip trivial checks like no content; for [head] and no explicit content, default to MIN_ENCODING_SIZE
		*	to just assume an encoding - can always be disabled in the real run, should the data be too short) */
		let encoding = null, minContentSize = (fullContentSize ?? chunk?.byteLength ?? libRequest.MIN_ENCODING_SIZE);
		if (!resp.noEncoding && minContentSize > 0)
			encoding = libRequest.EncodingOption(this.headers['accept-encoding'] ?? null, minContentSize, resp.contentType);
		if (encoding == null) {
			this.closeHeader(resp.status, resp.contentType, fullContentSize, true, '');
			return this.sendClientWrite(resp, chunk, last, cb);
		}
		this.outputHeaders['Content-Encoding'] = encoding.name;
		this.outputHeaders['Vary'] = 'Accept-Encoding';
		this.outputHeaders['Accept-Ranges'] = 'none';

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
		this.closeHeader(resp.status, resp.contentType, fullContentSize, true, encoding.name);
		return this.sendClientWrite(resp, chunk, last, cb);
	}
	private sendClientWrite(resp: HttpRequestResponse, chunk: Buffer | null, last: boolean, cb: (err: any) => void): void {
		/* check if this is a head write, in which case the response can
		*	just be marked as completed, and all other data can be drained */
		if (this.isHead) {
			if (this.state == ResponseState.headerSent) {
				this.state = ResponseState.completed;
				resp.writer.end(() => cb(null));
			}
			else
				cb(null);
			return;
		}

		/* update the total-sent counter and check if the upper-bound is broken */
		if (chunk != null) {
			resp.totalSent += chunk.byteLength;
			if (resp.contentSize != null && resp.totalSent > resp.contentSize) {
				this.respondInternalError('Response handling issue encountered');
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
			this.respondInternalError('Response handling issue encountered');
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
	private sendClientData(media: libRequest.MediaType, status: libRequest.StatusType, options: { encoded?: string, contentSize?: number, noEncoding?: boolean }): libStream.Writable {
		/* check if the object is already responded */
		if (this.state != ResponseState.none)
			throw new Error('Request has already been handled');
		if (this.response.destroyed)
			throw new Error('Connection is broken');
		this.state = ResponseState.acknowledged;

		const response = new HttpRequestResponse(this.response, status,
			options.contentSize ?? null, options.encoded ?? null, media, options.noEncoding ?? false,
			(chunk: Buffer | null, cb: (err: any) => void) => this.sendClientHandle(response, chunk, cb),
			(err: any, cb: (err: any) => void) => {
				if (this.state == ResponseState.completed)
					return cb(err);

				/* check if the output stream was an encoder, in which case it still needs to
				*	be destroyed (only if an error occurred and the response was not completed) */
				if (response.writer !== this.response)
					response.writer.destroy();
				this.respondInternalError('Response handling issue encountered');
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

	/* ensure the method is one of the list and otherwise return null and auto-respond with [method-not-allowed]
	*	if [headExplicit] is false, method will substitute HEAD for GET, framework will consume the remaining body */
	public ensureMethod(methods: string[], headExplicit?: boolean): string | null {
		if (methods.indexOf(this.method) >= 0)
			return this.method;

		/* check if the HEAD can be converted to a GET */
		const swapAllowed = (headExplicit !== true && methods.indexOf('GET') >= 0 && methods.indexOf('HEAD') < 0);
		if (this.isHead && swapAllowed)
			return 'GET';

		const allowed = methods.join(',') + (swapAllowed ? ',HEAD' : '');
		this.respondMethodNotAllowed(this.method, allowed, { exception: true });
		return null;
	}

	/* ensure the media-type is one of the list and otherwise return null and auto-respond with [unsupported-media-type] (defaults to first type) */
	public ensureMediaType(types: libRequest.MediaType[]): libRequest.MediaType | null {
		const type = this.headers['content-type']?.toLowerCase().split(';')[0].trim();
		if (type == null)
			return types[0];
		for (let i = 0; i < types.length; ++i) {
			if (type === types[i].mediaType)
				return types[i];
		}
		this.respondUnsupported(type, types.join(','), { exception: true });
		return null;
	}

	/* check the content-type for a media-type and otherwise return the default type */
	public getMediaTypeCharset(defEncoding: string): string {
		const type = this.headers['content-type'];
		if (type == null)
			return defEncoding;

		let index = type.indexOf('charset=');
		if (index == -1)
			return defEncoding;
		index += 8;

		let end = index;
		while (end < type.length && type[end] != ';')
			++end;

		if (index == end)
			return defEncoding;
		return type.substring(index, end).trim().toLowerCase();
	}

	/* return the html-page, if a child module plans to produce html */
	public getHtmlPage(): libBuilder.HtmlPage | null {
		return this.htmlResponse?.page ?? null;
	}

	/* returns true, if a page is built, and method is HEAD (triggers a size unspecific header to be sent due to incomplete builds;
	*	if at least one light build occurs, the entire page will be deemed a light-build, otherwise a full accurate header is returned) */
	public htmlLightBuild(): boolean {
		if (this.htmlResponse == null || !this.isHead)
			return false;
		this.htmlResponse.lightBuild = true;
		return true;
	}

	/* respond with html, can be built on by parent modules, sent once the client has been fully processed */
	public respondHtml(page: libBuilder.HtmlPage | null, status: libRequest.StatusType): libBuilder.HtmlPage {
		if (this.state != ResponseState.none)
			throw new Error('Request has already been handled');

		this.log(`Responding with HTML content and status [${status.msg}]`);
		this.state = ResponseState.acknowledged;
		this.htmlResponse = { page: page ?? new libBuilder.HtmlPage(), status, lightBuild: false };
		return this.htmlResponse.page;
	}

	/* send data with [media type] and [status] and return a writable stream (default status is ok)
	*	if a content size is provided, stream expects exactly this amount of bytes
	*	the encoding can be configured, if the data is pre-encoded (warning: no checks against accepted encodings performed!)
	*	for a HEAD request, no encoding will be negotiated, no lengths verified, and the written data will just be drained (can immediately be ended using '.end()') */
	public respondData(media: libRequest.MediaType = libRequest.Media.Unknown, options?: { status?: libRequest.StatusType, encoded?: string, contentSize?: number, noEncoding?: boolean }): libStream.Writable {
		const status: libRequest.StatusType = options?.status ?? libRequest.Status.Ok;
		this.log(`Responding with data and status [${status.msg}]`);
		return this.sendClientData(media, status, { encoded: options?.encoded, contentSize: options?.contentSize, noEncoding: options?.noEncoding });
	}

	/* try to respond with the given file, and return false, if not found (range aware, HEAD aware)
	*	the media type can be overwritten (defaults to extracting media-type from the file-path)
	*	the encoding can be configured, if the file is pre-encoded (warning: no checks against accepted encodings performed!)
	*	status will be [Ok] or [partial-content] */
	public async tryRespondFile(filePath: string, options?: { encoded?: string, media?: libRequest.MediaType }): Promise<boolean> {
		if (this.state != ResponseState.none)
			throw new Error('Request has already been handled');

		let cached: libCache.Cached | null = null;
		try {
			cached = libCache.Get(filePath);
			if (cached == null)
				return false;
		}
		catch (_) {
			this.respondFileSystemError();
			return true;
		}
		const media = (options?.media ?? libRequest.LookupMediaTypeFromFile(filePath));

		/* mark byte-ranges to be supported in principle */
		this.outputHeaders['Accept-Ranges'] = 'bytes';

		/* parse the range and ensure that its well formed */
		const range = libRequest.ParseRangeHeader(this.headers.range ?? null, cached.fileSize());
		if (range.state == libRequest.RangeState.malformed) {
			this.respondBadRequest(`Issues while parsing http-header range: [${this.headers.range}]`, { exception: true });
			return true;
		}
		else if (range.state == libRequest.RangeState.issue) {
			this.respondRangeIssue(this.headers.range!, cached.fileSize(), { exception: true });
			return true;
		}

		/* check if the file is empty (can only happen for unused ranges, which would otherwise have issues) */
		if (cached.fileSize() == 0) {
			this.log(`Sending empty content for [${filePath}]`);
			this.closeHeader(libRequest.Status.Ok, media, 0, true, '');
			this.response.end();
			return true;
		}
		if (range.state == libRequest.RangeState.valid)
			this.outputHeaders['Content-Range'] = `bytes ${range.first}-${range.last}/${cached.fileSize()}`;

		/* create the writer stream */
		let stream: libStream.Writable | null = null;
		try {
			const status = (range.state == libRequest.RangeState.noRange ? libRequest.Status.Ok : libRequest.Status.PartialContent);
			stream = this.sendClientData(media, status, {
				encoded: options?.encoded,
				contentSize: range.last - range.first + 1,
				noEncoding: range.state != libRequest.RangeState.noRange
			});
			this.log(`Sending ${this.isHead ? 'HEAD' : 'content'} [${range.first} - ${range.last}/${cached.fileSize()}] from [${filePath}]`);
		}
		catch (err: any) {
			this.error(`Failed to upload file [${filePath}]: ${err.message}`);
			return true;
		}

		/* check if this is a head request, in which case the stream can just
		*	immediately be closed again, to prevent the file from consuming resources */
		if (this.isHead)
			return new Promise((resolve) => stream.end(() => resolve(true)));

		/* create the source stream of the file to read from */
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
				source.destroy(err);
			});
			stream.on('close', () => resolve(true));
		});
	}

	/* receive the payload of given max length as a readable stream
	*	automatically responds with given exceptions if the payload cannot be received properly */
	public receiveData(maxLength: number | null): libStream.Readable {
		return this.receiveClientData(maxLength);
	}

	/* receive the payload of given max length as a single complete buffer
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

	/* receive the payload of given max length as a single complete decoded string
	*	automatically responds with given exceptions if the payload cannot be received properly */
	public async receiveAllText(encoding: string, maxLength: number | null): Promise<string> {
		/* wait for the buffer (let all errors propagate out) */
		const buffer: Buffer = await this.receiveAllBuffer(maxLength);

		try {
			return buffer.toString(encoding as BufferEncoding);
		} catch (err: any) {
			this.respondBadRequest('Unable to decode content', { exception: true });
			throw err;
		}
	}

	/* receive the payload of given max length and write it directly to a file; will fail
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
}

class HttpRequestResponse extends libStream.Writable {
	public writer: libStream.Writable;
	public totalSent: number;
	public cache: Buffer | null;
	public status: libRequest.StatusType;
	public contentSize: number | null;
	public contentEncoding: string | null;
	public contentType: libRequest.MediaType;
	public noEncoding: boolean;

	constructor(response: libStream.Writable, status: libRequest.StatusType, contentSize: number | null, contentEncoding: string | null, contentType: libRequest.MediaType,
		noEncoding: boolean, handleData: (chunk: Buffer | null, cb: (err: any) => void) => void, destroy: (err: any, cb: (err: any) => void) => void
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
		this.contentSize = contentSize;
		this.contentEncoding = contentEncoding;
		this.contentType = contentType;
		this.noEncoding = noEncoding;
	}
}

/*
*	WebSocket upgrade requests, which were not accepted, will be closed after responding
*/
export class HttpUpgrade extends IncomingBase {
	private socket: libStream.Duplex;
	private head: Buffer;

	constructor(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, host: string, protocol: string) {
		super(request, host, protocol);
		this.socket = socket;
		this.head = head;
	}

	protected override finalizeTextHeader(status: libRequest.StatusType, media: libRequest.MediaType, content: string): void {
		const buffer = Buffer.from(content, 'utf-8');

		this.outputHeaders['Date'] = new Date().toUTCString();
		this.outputHeaders['Server'] = libConfig.serverName;
		this.outputHeaders['Content-Type'] = libRequest.BuildMediaTypeIdentifier(media);
		this.outputHeaders['Content-Length'] = buffer.byteLength.toString();
		this.outputHeaders['Accept-Ranges'] = 'none';
		this.outputHeaders['Connection'] = 'close';

		/* construct the entire header content and send it away */
		let header = `HTTP/1.1 ${status.code} ${status.msg}\r\n`;
		for (const key in this.outputHeaders)
			header += `${key}: ${this.outputHeaders[key]}\r\n`;
		header += '\r\n';
		this.socket.write(header, 'utf-8');

		if (this.isHead)
			this.socket.end();
		else
			this.socket.end(buffer);
	}
	protected override async finishSelfHandling(): Promise<void> {
		/* check if the connection was accepted (only reason to keep it alive;
		*	header-sent is only set by the accept web-socket method) */
		if (this.state == ResponseState.headerSent)
			return;
		if (this.state != ResponseState.completed)
			this.respondInternalError('Request processing failed');

		if (this.socket.writableFinished) {
			this.socket.destroy();
			this.request.destroy();
		}
		else this.socket.on('finish', () => {
			this.socket.destroy();
			this.request.destroy();
		});
	}

	/* marks the object as having been handled (returns false, if connection is not a valid websocket upgrade request) */
	public tryAcceptWebSocket(cb: (ws: ClientSocket) => void): boolean {
		if (this.state != ResponseState.none)
			throw new Error('Request has already been handled');

		/* check if the connection is a valid upgrade request */
		let connection = this.headers?.connection?.toLowerCase().split(',').map((v) => v.trim());
		if (connection == null || connection.indexOf('upgrade') == -1)
			return false;
		if (this.headers?.upgrade?.toLowerCase() != 'websocket' || this.request.method != 'GET')
			return false;

		this.state = ResponseState.headerSent;

		/* save the current path state so that the ClientSocket receives the correct
		*	shifted paths even if the caller restores before the async callback fires */
		const snapshot = this.snapshot();

		/* perform the upgrade (websocket will automatically send http error responses and close the socket
		*	on errors in the upgrade process) and restore the context when the accept was performed */
		this.trace(`Performing upgrade on web socket connection [${this.fullPath}]`);
		WebSocketServerInstance.handleUpgrade(this.request, this.socket, this.head, (ws, request) => {
			const current = this.restore(snapshot);
			try {
				WebSocketServerInstance.emit('connection', ws, request);

				/* the restored client ensures the websocket object is in the right logging and path context */
				cb(new ClientSocket(ws, this));
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

	public ondata?: (data: libWs.RawData, isBinary: boolean) => void;
	public onclose?: () => void;

	constructor(ws: libWs.WebSocket, base: HttpUpgrade) {
		super(base);
		this.ws = ws;
		this.aliveTimer = null;
		this.isAlive = true;

		this.ws.on('pong', () => {
			this.trace(`Alive check pong received`);
			this.selfIsAlive();
		});
		this.ws.on('message', (data, isBinary) => {
			this.selfIsAlive();
			if (this.ondata != null)
				this.ondata(data, isBinary);
		});
		this.ws.on('close', () => {
			if (this.aliveTimer != null)
				clearTimeout(this.aliveTimer);
			this.aliveTimer = null;

			if (this.onclose != null)
				this.onclose();
		});
		this.ws.on('error', (err: any) => {
			this.error(`WebSocket error: ${err.message}`);
			this.closeSelf();
		});

		/* start the first alive check */
		this.selfIsAlive();
	}

	private checkIsAlive(): void {
		this.aliveTimer = null;

		/* cycle through the alive state and check again */
		if (!this.isAlive)
			return this.closeSelf();
		this.isAlive = false;
		this.aliveTimer = setTimeout(() => this.checkIsAlive(), libConfig.webSocketTimeout);

		/* try to ping the remote to check the liveliness */
		try {
			this.trace(`Sending ping to determine if connection is alive`);
			this.ws.ping();
		} catch (err: any) {
			this.error(`WebSocket error while pinging: ${err.message}`);
			this.closeSelf();
		}
	}
	private selfIsAlive(): void {
		this.isAlive = true;
		if (this.aliveTimer != null)
			clearTimeout(this.aliveTimer);
		this.aliveTimer = setTimeout(() => this.checkIsAlive(), libConfig.webSocketTimeout);
	}
	private closeSelf(): void {
		if (this.ws.readyState != libWs.WebSocket.CLOSED)
			this.ws.close();
	}

	public send(data: string | Buffer): void {
		try {
			this.ws.send(data);
		} catch (err: any) {
			this.error(`WebSocket error while sending data: ${err.message}`);
			this.closeSelf();
		}
	}
	public close(): void {
		this.closeSelf();
	}
}
