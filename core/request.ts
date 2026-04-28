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
	PartialContent: { code: 206, msg: 'Partial Content' },
	SeeOther: { code: 303, msg: 'See Other' },
	NotModified: { code: 304, msg: 'Not Modified' },
	TemporaryRedirect: { code: 307, msg: 'Temporary Redirect' },
	PermanentRedirect: { code: 308, msg: 'Permanent Redirect' },
	BadRequest: { code: 400, msg: 'Bad Request' },
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

	/* check if it requests bytes */
	if (!range.startsWith('bytes='))
		return { first: 0, last: 0, state: RangeState.issue };
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

/* check if the [etag] matches the list (i.e. in list or list is '*'), will not match for undefined list */
export function ETagMatchesList(etag: string, header: string | null): boolean {
	if (header == null)
		return false;
	const list = header.split(',');

	if (list.length == 1 && list[0].trim() == '*')
		return true;

	for (const entry of list) {
		if (etag == entry.trim())
			return true;
	}
	return false;
}

/* returns null on invalid times, [>0] for b being greater, [<0] for b being smaller, [=0] for same time */
export function TimeStampCompare(a: string, b: string): number | null {
	const _a = new Date(a).getTime();
	if (isNaN(_a))
		return null;
	const _b = new Date(b).getTime();
	if (isNaN(_b))
		return null;
	return (_b - _a);
}

/* setup the reverse list of file-endings to media types and encoding-names to encoding types */
const FileEndingToMediaTypeMapping: Record<string, MediaType> = {}
Object.entries(Media).forEach(([_, value]) => {
	for (const fileEnding of value.fileEnding)
		FileEndingToMediaTypeMapping[fileEnding] = value;
});
const EncodingNameToEncodingTypeMapping: Record<string, EncodingType> = {}
Object.entries(Encoding).forEach(([_, value]) => {
	EncodingNameToEncodingTypeMapping[value.name] = value;
});

/* map extension of file-path/file-name to media type (defaults to Unknown) */
export function LookupMediaTypeFromFile(filePath: string): MediaType {
	const fileExtension = libLocation.SplitFileName(filePath)[1];
	if (fileExtension != '') {
		const type = FileEndingToMediaTypeMapping[fileExtension.substring(1)] ?? null;
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

/* does not respect 'no-identity' encoding requests */
export const MIN_ENCODING_SIZE: number = 1_000;
export function EncodingOption(accept: string | null, atLeastSize: number, mediaType: MediaType): EncodingType | null {
	/* check if any accepted encodings can be found or if the type/size does not make sense */
	if (accept == null || atLeastSize < MIN_ENCODING_SIZE || !mediaType.compressible)
		return null;

	/* parse the encoding types and look for a match */
	let bestMatch: EncodingType | null = null, bestScore: number = 0;
	for (const part of accept.split(',')) {
		const segments = part.split(';');

		/* check if its an supported encoding (no match includes '*' and results in identity) */
		const name = segments[0].trim().toLowerCase();
		if (!(name in EncodingNameToEncodingTypeMapping))
			continue;

		/* parse the weight score of the value but default to 1.0, if none was given */
		let score = 1.0;
		for (let i = 1; i < segments.length; ++i) {
			const match = segments[i].match(/^\s*q\s*=\s*(\d+\.?\d*)\s*$/);
			if (match != null) {
				score = parseFloat(match[1]);
				break;
			}
		}

		/* check if the encoding should be skipped and automatically skip the identity - is implicit identity on null-return */
		if (score == 0.0 || name == 'identity' || name == '*')
			continue;

		/* check if this is a better match to the request */
		if (bestMatch == null || score > bestScore)
			bestMatch = EncodingNameToEncodingTypeMapping[name], bestScore = score;
	}
	return bestMatch;
}
export function LookupEncoding(name: string): EncodingType | null {
	return EncodingNameToEncodingTypeMapping[name.trim().toLowerCase()] ?? null;
}
export function SupportedEncodingNames(): string[] {
	return Object.keys(EncodingNameToEncodingTypeMapping);
}
