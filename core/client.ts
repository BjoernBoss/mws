/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2025 Bjoern Boss Henrichsen */
import * as libConfig from "./config.js";
import * as libTemplates from "./templates.js";
import * as libLog from "./log.js";
import * as libLocation from "./location.js";
import * as libPath from "path";
import * as libBuffer from "buffer";
import * as libFs from "fs";
import * as libStream from "stream";
import * as libURL from "url";
import * as libWs from "ws";
import * as libHttp from "http";

export const StatusCode = {
	Ok: 200,
	PartialContent: 206,
	PermanentlyMoved: 301,
	TemporaryRedirect: 307,
	BadRequest: 400,
	NotFound: { code: 404, msg: 'Not Fouund' },
	MethodNotAllowed: 405,
	Conflict: 409,
	ContentTooLarge: 413,
	UnsupportedMediaType: 415,
	RangeIssue: 416,
	InternalError: { code: 500, msg: 'Internal Server Error' }
};

enum RangeParseState {
	noRange,
	valid,
	issue,
	malformed
};
function ParseRangeHeader(range: string | undefined, size: number): [number, number, RangeParseState] {
	if (range == undefined)
		return [0, size, RangeParseState.noRange];

	/* check if it requests bytes */
	if (!range.startsWith('bytes='))
		return [0, size, RangeParseState.issue];
	range = range.substring(6);

	/* extract the first number */
	let firstSize = 0;
	while (firstSize < range.length && (range[firstSize] >= '0' && range[firstSize] <= '9'))
		++firstSize;

	/* check if the separator exists */
	if (firstSize >= range.length || range[firstSize] != '-')
		return [0, 0, RangeParseState.malformed];

	/* extract the second number */
	let secondSize = firstSize + 1;
	while (secondSize < range.length && (range[secondSize] >= '0' && range[secondSize] <= '9'))
		++secondSize;

	/* check if a valid end has been found or another range (only the first
	*	range will be respected) and that at least one number has been given */
	if (secondSize < range.length && range[secondSize] != ',')
		return [0, 0, RangeParseState.malformed];
	secondSize -= firstSize + 1;
	if (firstSize == 0 && secondSize == 0)
		return [0, 0, RangeParseState.malformed];

	/* parse the two numbers */
	const begin = (firstSize == 0 ? undefined : parseInt(range.substring(0, firstSize)));
	const end = (secondSize == 0 ? undefined : parseInt(range.substring(firstSize + 1, secondSize)));

	/* check if only an offset has been requested */
	if (end == undefined) {
		if (begin! >= size)
			return [0, 0, RangeParseState.issue];
		return [begin!, size - begin!, RangeParseState.valid];
	}

	/* check if only a suffix has been requested */
	if (begin == undefined) {
		if (end >= size)
			return [0, 0, RangeParseState.issue];
		return [size - end, end, RangeParseState.valid];
	}

	/* check that the range is well defined */
	if (end < begin || begin >= size || end >= size)
		return [0, 0, RangeParseState.issue];

	/* setup the corrected range */
	return [begin, end - begin + 1, RangeParseState.valid];
}

function MakeContentType(fileType: string): string {
	const typeMap: Record<string, string> = {
		'html': 'text/html; charset=utf-8',
		'css': 'text/css; charset=utf-8',
		'js': 'text/javascript; charset=utf-8',
		'txt': 'text/plain; charset=utf-8',
		'json': 'application/json; charset=utf-8',
		'mp4': 'video/mp4',
		'png': 'image/png',
		'gif': 'image/gif',
		'jpg': 'image/jpeg',
		'jpeg': 'image/jpeg',
		'svg': 'image/svg+xml'
	};

	if (fileType in typeMap)
		return typeMap[fileType];
	return 'application/octet-stream';
}

enum HttpRequestState {
	none,
	responded,
	awaiting,
	upgrading,
	received,
	finalized
}

var NextClientId: number = 0;
const WebSocketServerInstance: libWs.Server = new libWs.WebSocketServer({ noServer: true });


export class ClientBase {
	protected logLayer: string;

	/* path relative to current module base-path */
	public path: string;

	/* absolute path on web-server */
	public fullpath: string;

	/* base path between the fullpath and path */
	public basepath: string;

	/* raw (URI encoded) absolute path */
	public rawpath: string;

	/* raw host of the request */
	public host: string;

	/* incoming header fields */
	public headers: libHttp.IncomingHttpHeaders;

	/* unique id to identify client in logs */
	readonly id: number;

	protected constructor(url: libURL.URL, host: string, headers: libHttp.IncomingHttpHeaders);
	protected constructor(client: ClientBase);
	protected constructor(arg: libURL.URL | ClientBase, host?: string, headers?: libHttp.IncomingHttpHeaders) {
		if (arg instanceof libURL.URL) {
			this.logLayer = '';
			this.id = ++NextClientId;
			this.path = libLocation.Sanitize(decodeURIComponent(arg.pathname));
			this.rawpath = arg.pathname;
			this.fullpath = this.path;
			this.basepath = '/';
			this.host = host!;
			this.headers = headers!;
		}
		else {
			this.logLayer = arg.logLayer;
			this.path = arg.path;
			this.fullpath = arg.fullpath;
			this.basepath = arg.basepath;
			this.rawpath = arg.rawpath;
			this.host = arg.host;
			this.id = arg.id;
			this.headers = arg.headers;
		}
	}

	public translate(path: string): void {
		if (!libLocation.IsSubDirectory(path, this.path))
			throw new Error(`Path [${path}] is not a base of [${this.path}]`);

		this.basepath = libLocation.Join(this.basepath, path);
		this.path = this.path.substring(path.endsWith('/') ? path.length - 1 : path.length);
		if (this.path == '')
			this.path = '/';
	}
	public pushLog(name: string) {
		this.logLayer = `${this.logLayer}::${name}`;
	}
	public log(msg: string) {
		libLog.Log(`Client[${this.id}]${this.logLayer}: ${msg}`);
	}
	public error(msg: string) {
		libLog.Error(`Client[${this.id}]${this.logLayer}: ${msg}`);
	}
};

export abstract class HttpBase extends ClientBase {
	protected request: libHttp.IncomingMessage;
	protected state: HttpRequestState;
	protected outputHeaders: Record<string, string>;

	protected abstract setupResponse(status: number, message: string, content: string, fileType: string): void;

	constructor(request: libHttp.IncomingMessage, host: string) {
		super(new libURL.URL(`http://host.server${request.url}`), host, request.headers);
		this.request = request;
		this.state = HttpRequestState.none;
		this.outputHeaders = {};
	}

	public finalize() {
		if (this.state == HttpRequestState.none || this.state == HttpRequestState.received)
			throw new Error('Request has not been handled');
		if (this.state != HttpRequestState.responded)
			return;
		let that = this;
		this.request.on('data', function () {
			that.error(`Connection sent unexpected data: [${that.rawpath}]`);
			that.request.destroy();
		});
	}
	public respondInternalError(msg: string): void {
		if (this.state == HttpRequestState.none || this.state == HttpRequestState.received) {
			this.log(`Responded with Internal error [${msg}]`);
			this.outputHeaders = {};
			this.setupResponse(StatusCode.InternalError.code, StatusCode.InternalError.msg, msg, 'txt');
		}
	}
	public respondNotFound(msg: string | null = null): void {
		this.log(`Responded with Not-Found`);
		if (msg != null)
			this.setupResponse(StatusCode.NotFound.code, StatusCode.NotFound.msg, msg, 'txt');
		else {
			const content = libTemplates.ErrorNotFound({ path: this.rawpath });
			this.setupResponse(StatusCode.NotFound.code, StatusCode.NotFound.msg, content, 'html');
		}
	}
};

export class HttpRequest extends HttpBase {
	private response: libHttp.ServerResponse;

	constructor(request: libHttp.IncomingMessage, response: libHttp.ServerResponse, host: string) {
		super(request, host);
		this.response = response;
	}

	private closeHeader(statusCode: number, fileType: string, length: number | null = null): void {
		/* check if the header has already been sent */
		if (this.state != HttpRequestState.none && this.state != HttpRequestState.received)
			throw new Error('Request has already been handled');
		this.state = (this.state == HttpRequestState.received ? HttpRequestState.finalized : HttpRequestState.responded);

		/* setup the response */
		this.response.statusCode = statusCode;
		for (const key in this.outputHeaders)
			this.response.setHeader(key, this.outputHeaders[key]);
		this.response.setHeader('Server', libConfig.getServerName());
		this.response.setHeader('Content-Type', MakeContentType(fileType));
		this.response.setHeader('Date', new Date().toUTCString());
		if (!('Accept-Ranges' in this.outputHeaders))
			this.response.setHeader('Accept-Ranges', 'none');
		if (length != null)
			this.response.setHeader('Content-Length', length);
	}
	private respondString(code: number, fileType: string, string: string): void {
		const buffer = libBuffer.Buffer.from(string, 'utf-8');
		this.closeHeader(code, fileType, buffer.length);
		this.response.end(buffer);
	}
	private receiveClientChunks(cb: (data: Buffer | null, error: Error | null) => boolean, maxLength: number | null): boolean {
		let failed = false, accumulated = 0, that = this;

		/* check if a receiver has already been attached */
		if (this.state != HttpRequestState.none)
			throw new Error('Request has already been handled');

		/* check if too many data have been promised */
		if (maxLength != null && this.headers['content-length'] != undefined) {
			const length = parseInt(this.headers['content-length']);

			/* check if the length is valid and otherwise mark the state as 'handled' */
			if (!isFinite(length) || length < 0 || length > maxLength) {
				this.state = HttpRequestState.received;
				this.log(`Request is too large or has no size [${length}]`);
				const content = libTemplates.ErrorContentTooLarge({ path: this.rawpath, allowedLength: maxLength, providedLength: length });
				this.respondString(StatusCode.ContentTooLarge, 'html', content);
				return false;
			}
		}
		this.state = HttpRequestState.awaiting;

		/* register the data recipient */
		this.request.on('data', function (data: Buffer) {
			if (failed) return;

			/* check the maximum count */
			accumulated += data.byteLength;
			if (maxLength != null && accumulated > maxLength) {
				that.log(`Request payload is too large [${accumulated} > ${maxLength}]`);
				failed = true;
				that.request.destroy();
				cb(null, new Error('Request is too large'));
			}

			/* pass the data to the handler */
			else if (failed = !cb(data, null))
				that.request.destroy();
		});

		/* register the error and end handler */
		this.request.on('error', function (e) {
			if (!failed) {
				that.error(`Error while receiving data [${e.message}]`);
				failed = true;
				cb(null, e);
			}
		});
		this.request.on('end', function () {
			if (failed) return;
			that.state = HttpRequestState.received;
			cb(null, null);
			that.finalize();
		});
		return true;
	}
	protected setupResponse(status: number, message: string, content: string, fileType: string): void {
		this.respondString(status, fileType, content);
	}

	public addHeader(key: string, value: string): void {
		this.outputHeaders[key] = value;
	}
	public ensureMethod(methods: string[]): string | null {
		if (methods.indexOf(this.request.method!) >= 0)
			return this.request.method!;
		this.log(`Request used unsupported method [${this.request.method}]`);

		const content = libTemplates.ErrorInvalidMethod({ path: this.rawpath, method: this.request.method!, allowed: methods });
		this.respondString(StatusCode.MethodNotAllowed, 'html', content);
		return null;
	}
	public ensureMediaType(types: string[]): string | null {
		const type = this.headers['content-type'];
		if (type === undefined)
			return types[0];
		for (let i = 0; i < types.length; ++i) {
			if (type === types[i] || type.startsWith(`${types[i]};`))
				return types[i];
		}
		this.log(`Responded with Unsupported Media Type for [${type}]`);

		const content = libTemplates.ErrorUnsupportedMediaType({ path: this.rawpath, used: type, allowed: types });
		this.respondString(StatusCode.UnsupportedMediaType, 'html', content);
		return null;
	}
	public getMediaTypeCharset(defEncoding: string): string {
		const type = this.headers['content-type'];
		if (type === undefined)
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
		return type.substring(index, end);
	}
	public respondOk(operation: string, msg: string | null = null): void {
		this.log(`Responded with Ok`);

		if (msg != null)
			this.respondString(StatusCode.Ok, 'txt', msg);
		else {
			const content = libTemplates.SuccessOk({ path: this.rawpath, operation: operation });
			this.respondString(StatusCode.Ok, 'html', content);
		}
	}
	public respondConflict(conflict: string, msg: string | null = null): void {
		this.log(`Responded with Conflict of [${conflict}]`);

		if (msg != null)
			this.respondString(StatusCode.Conflict, 'txt', msg);
		else {
			const content = libTemplates.ErrorConflict({ path: this.rawpath, conflict: conflict });
			this.respondString(StatusCode.Conflict, 'html', content);
		}
	}
	public respondMoved(target: string, msg: string | null = null): void {
		this.log(`Responded with Permanently-Moved to [${target}]`);
		this.response.setHeader('Location', target);

		if (msg != null)
			this.respondString(StatusCode.PermanentlyMoved, 'txt', msg);
		else {
			const content = libTemplates.PermanentlyMoved({ path: this.rawpath, destination: target });
			this.respondString(StatusCode.PermanentlyMoved, 'html', content);
		}
	}
	public respondRedirect(target: string, msg: string | null = null): void {
		this.log(`Responded with Redirect to [${target}]`);
		this.response.setHeader('Location', target);

		if (msg != null)
			this.respondString(StatusCode.TemporaryRedirect, 'txt', msg);
		else {
			const content = libTemplates.TemporaryRedirect({ path: this.rawpath, destination: target });
			this.respondString(StatusCode.TemporaryRedirect, 'html', content);
		}
	}
	public respondBadRequest(reason: string, msg: string | null = null): void {
		this.log(`Responded with Bad-Request`);

		if (msg != null)
			this.respondString(StatusCode.BadRequest, 'txt', msg);
		else {
			const content = libTemplates.ErrorBadRequest({ path: this.rawpath, reason: reason });
			this.respondString(StatusCode.BadRequest, 'html', content);
		}
	}
	public respondText(content: string, fsKind: string = 'html', status: number = StatusCode.Ok): void {
		this.log(`Responded with ${fsKind}: [${content.substring(0, 32).replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('\t', ' ')}...]`);
		this.respondString(status, fsKind, content);
	}
	public tryRespondFile(filePath: string): void {
		/* check if the file exists */
		let fileSize: number = 0;
		try {
			if (!libFs.existsSync(filePath) || !libFs.lstatSync(filePath).isFile()) {
				this.log(`Request to unknown resource`);
				this.respondNotFound();
				return;
			}
			fileSize = libFs.statSync(filePath).size;
		} catch (e: any) {
			libLog.Error(`Filesystem error while processing [${filePath}]: ${e.message}`);
			this.respondInternalError('File operation failed');
			return;
		}

		/* mark byte-ranges to be supported in principle */
		this.outputHeaders['Accept-Ranges'] = 'bytes';

		/* parse the range and check if it is invalid */
		const [offset, size, rangeResult] = ParseRangeHeader(this.headers.range, fileSize);
		if (rangeResult == RangeParseState.malformed) {
			this.log(`Malformed range-request encountered [${this.headers.range}]`);
			const content = libTemplates.ErrorBadRequest({ path: this.rawpath, reason: `Issues while parsing http-header range: [${this.headers.range}]` });
			this.respondString(StatusCode.BadRequest, 'html', content);
			return;
		}
		else if (rangeResult == RangeParseState.issue) {
			this.log(`Unsatisfiable range-request encountered [${this.headers.range}] with file-size [${fileSize}]`);
			this.outputHeaders['Content-Range'] = `bytes */${fileSize}`;
			const content = libTemplates.ErrorRangeIssue({ path: this.rawpath, range: this.headers.range!, fileSize: fileSize });
			this.respondString(StatusCode.RangeIssue, 'html', content);
			return;
		}

		/* extract the file-type */
		let fileType = libPath.extname(filePath).toLowerCase();
		if (fileType.startsWith('.'))
			fileType = fileType.substring(1);

		/* check if the file is empty (can only happen for unused ranges) */
		if (size == 0) {
			this.log(`Sending empty content for [${filePath}]`);
			this.respondString(StatusCode.Ok, fileType, '');
			return;
		}

		/* setup the filestream object */
		let stream = libFs.createReadStream(filePath, {
			flags: 'r', start: offset, end: offset + size - 1
		});

		/* setup the response */
		if (rangeResult == RangeParseState.valid)
			this.outputHeaders['Content-Range'] = `bytes ${offset}-${offset + size - 1}/${fileSize}`;
		this.closeHeader((rangeResult == RangeParseState.noRange ? StatusCode.Ok : StatusCode.PartialContent), fileType, size);

		/* write the content to the stream */
		this.log(`Sending content [${offset} - ${offset + size - 1}/${fileSize}] from [${filePath}]`);
		libStream.pipeline(stream, this.response, (err) => {
			this.log(err == undefined ? `All content has been sent` : `Error while sending content: [${err}]`);
		});
	}
	public receiveChunks(maxLength: number | null, cb: (data: Buffer | null, error: Error | null) => boolean): boolean {
		return this.receiveClientChunks(cb, maxLength);
	}
	public receiveAllBuffer(maxLength: number | null, cb: (data: Buffer | null, error: Error | null) => void): boolean {
		const body: Buffer[] = [];

		return this.receiveClientChunks(function (buf, err): boolean {
			if (err != null)
				cb(null, err);
			else if (buf != null)
				body.push(buf);
			else
				cb(libBuffer.Buffer.concat(body), null);
			return true;
		}, maxLength);
	}
	public receiveAllText(maxLength: number | null, encoding: string, cb: (text: string | null, error: Error | null) => void): boolean {
		const body: Buffer[] = [];

		return this.receiveClientChunks(function (buf, err): boolean {
			if (err != null)
				cb(null, err);
			else if (buf != null)
				body.push(buf);

			/* convert the buffers to a string */
			else try {
				cb(libBuffer.Buffer.concat(body).toString(encoding as BufferEncoding), null);
			} catch (e: any) {
				cb(null, e);
			}
			return true;
		}, maxLength);
	}
	public receiveToFile(maxLength: number | null, file: string, cb: (error: Error | null) => void): boolean {
		this.log(`Collecting data from [${this.rawpath}] to: [${file}]`);

		/* initialize busy until the file has been opened */
		let queue: Buffer[] = [], fd: number | null = null, cbResult: Error | null = null;
		let fdBusy = true, fdClose = false, that = this;
		const failure = function (e: Error): void {
			if (cbResult == null)
				cbResult = e;
			fdClose = true;
			queue = [];
		};
		const process = function (): void {
			if (fdBusy)
				return;

			/* check if the fd is to be closed (leave if busy indefinitely) */
			if (fdClose) {
				fdBusy = true;
				if (fd == null)
					cb(cbResult);

				/* close the file and check if it should be removed */
				else libFs.close(fd, function () {
					if (cbResult != null) try {
						libFs.unlinkSync(file);
					} catch (e: any) {
						that.error(`Failed to remove file [${file}] after writing uploaded data to it failed: ${e.message}`);
					}
					cb(cbResult);
				});
				return;
			}

			/* check if further data exist to be written out */
			if (queue.length == 0)
				return;

			/* write the next data out */
			fdBusy = true;
			libFs.write(fd!, queue[0], function (e, written) {
				fdBusy = false;

				/* check if the write failed and otherwise consume the written data */
				if (e)
					failure(e);
				else if (written >= queue[0].length)
					queue = queue.splice(1);
				else
					queue[0] = queue[0].subarray(written);
				process();
			});
		};

		/* open the actual file for writing */
		libFs.open(file, 'wx', function (e, f) {
			fdBusy = false;
			if (e)
				failure(e);
			else
				fd = f;
			process();
		});

		/* setup the chunk receivers */
		return this.receiveClientChunks(function (buf, err): boolean {
			if (err != null)
				failure(err);
			else if (buf == null)
				fdClose = true;
			else if (!fdClose)
				queue.push(buf);
			process();
			return !fdClose;
		}, maxLength);
	}
};

export class HttpUpgrade extends HttpBase {
	private socket: libStream.Duplex;
	private head: Buffer;

	constructor(request: libHttp.IncomingMessage, socket: libStream.Duplex, head: Buffer, host: string) {
		super(request, host);
		this.socket = socket;
		this.head = head;
	}

	private responseString(status: string, fileType: string, text: string): void {
		const buffer = libBuffer.Buffer.from(text, 'utf-8');

		/* check if the header has already been sent (always set to finalized, as it is closed) */
		if (this.state != HttpRequestState.none && this.state != HttpRequestState.received)
			throw new Error('Request has already been handled');
		this.state = HttpRequestState.finalized;

		let header = `HTTP/1.1 ${status}\r\n`;
		header += `Date: ${new Date().toUTCString()}\r\n`;
		header += `Server: ${libConfig.getServerName()}\r\n`;
		header += `Content-Type: ${MakeContentType(fileType)}\r\n`;
		header += `Content-Length: ${buffer.length}\r\n`;
		header += `Accept-Ranges: none\r\n`;
		header += 'Connection: keep-alive\r\n';
		header += 'Keep-Alive: timeout=5\r\n';
		header += '\r\n';

		this.socket.write(header, 'utf-8');
		this.socket.write(buffer);
		this.socket.destroy();
	}
	protected setupResponse(status: number, message: string, content: string, fileType: string): void {
		this.responseString(`${status} ${message}`, fileType, content);
	}

	public tryAcceptWebSocket(cb: (ws: ClientSocket) => void): boolean {
		let connection = this.headers?.connection?.toLowerCase().split(',').map((v) => v.trim());
		if (connection == undefined || connection.indexOf('upgrade') == -1)
			return false;
		if (this.headers?.upgrade?.toLowerCase() != 'websocket' || this.request.method != 'GET')
			return false;

		/* ensure the connection can be accepted */
		if (this.state != HttpRequestState.none)
			throw new Error('Request has already been handled');
		this.state = HttpRequestState.upgrading;

		const that = this;
		WebSocketServerInstance.handleUpgrade(this.request, this.socket, this.head, function (ws, request) {
			WebSocketServerInstance.emit('connection', ws, request);
			cb(new ClientSocket(ws, that));
		});
		return true;
	}
};

export class ClientSocket extends ClientBase {
	private ws: libWs.WebSocket;

	public onpong?: () => void;
	public ondata?: (data: libWs.RawData, isBinary: boolean) => void;
	public onclose?: () => void;

	constructor(ws: libWs.WebSocket, base: HttpUpgrade) {
		super(base);
		this.ws = ws;

		/* register the callbacks */
		const that = this;
		this.ws.on('message', function (data, isBinary) {
			if (that.ondata != null)
				that.ondata(data, isBinary);
		});
		this.ws.on('close', function () {
			if (that.onclose != null)
				that.onclose();
		});
		this.ws.on('pong', function () {
			if (that.onpong != null)
				that.onpong();
		});
	}

	public ping(): void {
		this.ws.ping();
	}
	public send(buffer: any): void {
		this.ws.send(buffer);
	}
	public close(): void {
		this.ws.close();
	}
};
