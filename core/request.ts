/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
import * as libLocation from "./location.js";
import * as libZlib from "zlib";
import * as libStream from "stream";

export interface StatusType {
	code: number;
	msg: string;
}
export const Status = {
	Ok: { code: 200, msg: 'Ok' },
	Created: { code: 201, msg: 'Created' },
	PartialContent: { code: 206, msg: 'Partial Content' },
	SeeOther: { code: 303, msg: 'See Other' },
	NotModified: { code: 304, msg: 'Not Modified' },
	TemporaryRedirect: { code: 307, msg: 'Temporary Redirect' },
	PermanentRedirect: { code: 308, msg: 'Permanent Redirect' },
	BadRequest: { code: 400, msg: 'Bad Request' },
	Forbidden: { code: 403, msg: 'Forbidden' },
	NotFound: { code: 404, msg: 'Not Found' },
	MethodNotAllowed: { code: 405, msg: 'Method Not Allowed' },
	Conflict: { code: 409, msg: 'Conflict' },
	PreconditionFailed: { code: 412, msg: 'Precondition Failed' },
	ContentTooLarge: { code: 413, msg: 'Content Too Large' },
	UnsupportedMediaType: { code: 415, msg: 'Unsupported Media Type' },
	RequestTimeout: { code: 408, msg: 'Request Timeout' },
	RangeIssue: { code: 416, msg: 'Range Not Satisfiable' },
	InternalError: { code: 500, msg: 'Internal Server Error' }
} as const satisfies Record<string, StatusType>

export interface MediaType {
	fileEnding: string[];
	mediaType: string;
	encoding: string;
	compressible: boolean;
}
export const Media = {
	Html: { fileEnding: ['html'], mediaType: 'text/html', encoding: 'charset=utf-8', compressible: true },
	Css: { fileEnding: ['css'], mediaType: 'text/css', encoding: 'charset=utf-8', compressible: true },
	JavaScript: { fileEnding: ['js'], mediaType: 'text/javascript', encoding: 'charset=utf-8', compressible: true },
	Text: { fileEnding: ['txt', 'text'], mediaType: 'text/plain', encoding: 'charset=utf-8', compressible: true },
	Json: { fileEnding: ['json'], mediaType: 'application/json', encoding: 'charset=utf-8', compressible: true },
	Mp4: { fileEnding: ['mp4'], mediaType: 'video/mp4', encoding: '', compressible: false },
	Png: { fileEnding: ['png'], mediaType: 'image/png', encoding: '', compressible: false },
	Gif: { fileEnding: ['gif'], mediaType: 'image/gif', encoding: '', compressible: false },
	Jpg: { fileEnding: ['jpg', 'jpeg'], mediaType: 'image/jpeg', encoding: '', compressible: false },
	Svg: { fileEnding: ['svg'], mediaType: 'image/svg+xml', encoding: '', compressible: true },
	Unknown: { fileEnding: [], mediaType: 'application/octet-stream', encoding: '', compressible: false }
} as const satisfies Record<string, MediaType>

export interface EncodingType {
	name: string;
	makeDecode(): libStream.Transform;
	makeEncode(): libStream.Transform;
	encodeBuffer(buffer: Buffer): Buffer;
}
export const Encoding = {
	Br: {
		name: 'br',
		makeDecode: () => libZlib.createBrotliDecompress(),
		makeEncode: () => libZlib.createBrotliCompress(),
		encodeBuffer: (buffer: Buffer) => libZlib.brotliCompressSync(buffer)
	},
	Zstd: {
		name: 'zstd',
		makeDecode: () => libZlib.createZstdDecompress(),
		makeEncode: () => libZlib.createZstdCompress(),
		encodeBuffer: (buffer: Buffer) => libZlib.zstdCompressSync(buffer)
	},
	Gzip: {
		name: 'gzip',
		makeDecode: () => libZlib.createGunzip(),
		makeEncode: () => libZlib.createGzip(),
		encodeBuffer: (buffer: Buffer) => libZlib.gzipSync(buffer)
	},
	Deflate: {
		name: 'deflate',
		makeDecode: () => libZlib.createInflate(),
		makeEncode: () => libZlib.createDeflate(),
		encodeBuffer: (buffer: Buffer) => libZlib.deflateSync(buffer)
	},
	Identity: {
		name: 'identity',
		makeDecode: () => new libStream.PassThrough(),
		makeEncode: () => new libStream.PassThrough(),
		encodeBuffer: (buffer: Buffer) => buffer
	}
} as const satisfies Record<string, EncodingType>


export enum RangeState {
	noRange,
	valid,
	issue,
	malformed
}
export function ParseRangeHeader(range: string | null, fileSize: number): { first: number, last: number, state: RangeState } {
	if (range == null)
		return { first: 0, last: fileSize - 1, state: RangeState.noRange };

	/* ignore unknown range units (range units are case-insensitive) */
	if (range.length < 6 || range.substring(0, 6).toLowerCase() != 'bytes=')
		return { first: 0, last: fileSize - 1, state: RangeState.noRange };
	range = range.substring(6);

	/* extract the first number */
	let numberLength: number = 0, firstNumber: string = '', lastNumber: string = '';
	while (numberLength < range.length && (range[numberLength] >= '0' && range[numberLength] <= '9'))
		++numberLength;
	firstNumber = range.substring(0, numberLength);
	range = range.substring(numberLength);

	/* check if the separator exists */
	if (!range.startsWith('-'))
		return { first: 0, last: 0, state: RangeState.malformed };
	range = range.substring(1);

	/* extract the second number */
	numberLength = 0;
	while (numberLength < range.length && (range[numberLength] >= '0' && range[numberLength] <= '9'))
		++numberLength;
	lastNumber = range.substring(0, numberLength);
	range = range.substring(numberLength).trimStart();

	/* check if a valid end has been found or another range (only the first
	*	range will be respected) and that at least one number has been given */
	if (range != '' && !range.startsWith(','))
		return { first: 0, last: 0, state: RangeState.malformed };
	if (firstNumber == '' && lastNumber == '')
		return { first: 0, last: 0, state: RangeState.malformed };

	/* parse the two numbers */
	let first: number | null = (firstNumber.length == 0 ? null : parseInt(firstNumber));
	let last: number | null = (lastNumber.length == 0 ? null : parseInt(lastNumber));

	/* check if the range has an offset and potentially also an end */
	if (first != null) {
		if (last == null)
			last = fileSize - 1;
		if (first > last || last >= fileSize)
			return { first: 0, last: 0, state: RangeState.issue };
		return { first, last, state: RangeState.valid };
	}

	/* validate the offset at the end */
	if (last! > fileSize || last! == 0)
		return { first: 0, last: 0, state: RangeState.issue };
	return { first: fileSize - last!, last: fileSize - 1, state: RangeState.valid };
}

/* check if the [etag] matches the list (i.e. in list or list is '*'), will not match for undefined list; if [strong]
*	comparison, both must be non-weak, opaque-tags equal (strip W/ prefix and compare opaque-tags regardless of weakness) */
export function ETagMatchesList(etag: string, header: string | null, strong: boolean): boolean {
	if (header == null)
		return false;

	const list: string[] = SplitAndTrimList(header, ',', true);
	if (list.length == 1 && list[0] == '*')
		return true;
	if (strong && etag.startsWith('W/'))
		return false;

	const target = etag.startsWith('W/') ? etag.substring(2) : etag;
	for (const entry of list) {
		const current = ((strong || !entry.startsWith('W/')) ? entry : entry.substring(2));
		if (target == current)
			return true;
	}
	return false;
}

/* returns null on invalid times, [>0] for a being greater, [<0] for a being smaller, [=0] for same time */
export function TimeStampCompare(a: string, b: string): number | null {
	const _a = new Date(a).getTime();
	if (isNaN(_a))
		return null;
	const _b = new Date(b).getTime();
	if (isNaN(_b))
		return null;
	return (_a - _b);
}

/* setup the reverse list of file-endings to media types and encoding-names to encoding types */
const FileEndingToMediaTypeMapping: Record<string, MediaType> = {};
for (const media of Object.values(Media)) {
	for (const fileEnding of media.fileEnding)
		FileEndingToMediaTypeMapping[fileEnding] = media;
}

const EncodingNameToEncodingTypeMapping: Record<string, EncodingType> = {};
for (const encoding of Object.values(Encoding))
	EncodingNameToEncodingTypeMapping[encoding.name] = encoding;

/* map extension of file-path/file-name to media type (defaults to Unknown) */
export function LookupMediaTypeFromFile(filePath: string): MediaType {
	const fileExtension = libLocation.SplitFilePath(filePath)[2];
	if (fileExtension != '') {
		const type = FileEndingToMediaTypeMapping[fileExtension.substring(1).toLowerCase()] ?? null;
		if (type != null)
			return type;
	}
	return Media.Unknown;
}
export function BuildMediaTypeIdentifier(media: MediaType): string {
	if (media.encoding == '')
		return media.mediaType;
	return `${media.mediaType}; ${media.encoding}`;
}

/* does not respect 'no-identity' encoding requests; unknown at-least-size is considered valid (defaults 'identity' to null) */
export const MIN_ENCODING_SIZE: number = 1_000;
export function NegotiateEncoding(accept: string | null, atLeastSize: number | null, media: MediaType): EncodingType | null {
	if (!media.compressible || accept == null)
		return null;
	if (atLeastSize != null && atLeastSize < MIN_ENCODING_SIZE)
		return null;

	/* parse the encoding types and their score */
	const scores: Record<string, number> = {};
	let bestScore: string | null = null;
	for (const part of SplitAndTrimList(accept, ',', false)) {
		const segments = SplitAndTrimList(part, ';', false);
		const name = segments[0].toLowerCase();

		/* check if the name is even supported and otherwise drop it */
		if (!(name in EncodingNameToEncodingTypeMapping) && name != '*')
			continue;

		/* parse the weight score of the value but default to 1.0 if none was given */
		let score = 1.0;
		for (let i = 1; i < segments.length; ++i) {
			const match = segments[i].match(/^\s*q\s*=\s*(\d+\.?\d*)\s*$/i);
			if (match != null) {
				score = parseFloat(match[1]);
				break;
			}
		}

		/* update the scores and best match */
		scores[name] = (name in scores ? Math.max(scores[name], score) : score);
		if (bestScore == null || scores[bestScore] < score)
			bestScore = name;
		else if (scores[bestScore] == score && (bestScore == name || bestScore == 'identity' || (bestScore == '*' && name != 'identity')))
			bestScore = name;
	}

	/* check if a best-match has been found */
	if (bestScore == null || scores[bestScore] <= 0)
		return null;
	if (bestScore != null && bestScore != '*')
		return (bestScore == 'identity' ? null : EncodingNameToEncodingTypeMapping[bestScore]);

	/* lookup the best entry not mentioned (because '*' was the best match) */
	for (const encoding in EncodingNameToEncodingTypeMapping) {
		if (!(encoding in scores))
			return EncodingNameToEncodingTypeMapping[encoding];
	}
	return null;
}
export function LookupEncoding(name: string): EncodingType | null {
	return EncodingNameToEncodingTypeMapping[name.toLowerCase()] ?? null;
}
export function SupportedEncodingNames(): string[] {
	return Object.keys(EncodingNameToEncodingTypeMapping);
}

/* split a list value while removing whitespace and optionally respecting quotes (returns empty list on validly quoted strings) */
export function SplitAndTrimList(content: string | null, separator: string, quotesAware: boolean): string[] {
	if (content == null)
		return [];

	let output: string[] = [], current = '', inQuote = false;
	for (const c of content) {
		if (c == '"' && quotesAware)
			inQuote = !inQuote, current += c;
		else if (c != separator || inQuote)
			current += c
		else
			output.push(current.trim()), current = '';
	}

	if (inQuote)
		return [];
	output.push(current.trim());

	return output;
}
