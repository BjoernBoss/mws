/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
import { Config as libConfig } from "./config.js";
import * as libLog from "./log.js";
import * as libLocation from "./location.js";
import * as libBase from "./base.js";
import * as libFs from "fs";
import * as libStream from "stream";
import * as libCrypto from "crypto";

const logger = libLog.Logger('cache');

const UNIQUE_ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz'
const UNIQUE_ID_LENGTH = 14;
const ID_EXTENSION_REGEX = RegExp(`^\\.[${UNIQUE_ID_CHARS}]{${UNIQUE_ID_LENGTH}}$`, 'i');

function ReadStats(path: string): null | [number, number] {
	try {
		const stats = libFs.statSync(path);
		if (stats.isFile())
			return [stats.size, stats.mtimeMs];
	} catch (err: any) {
		if (err.code == 'ENOENT')
			return null;
		throw new Error(`Filesystem error while checking [${path}]: ${err.message}`);
	}
	return null;
}

interface CacheEntry {
	data: Buffer;
	encodings: Record<string, Buffer>;
	mtime: number;
	age: number;
	touched: number;
}
class CacheManager {
	private map: Record<string, CacheEntry> = {};
	private nextStamp: number = 0;
	private allocated: number = 0;
	private totalCapacity: number;
	private largestSize: number;

	public constructor() {
		this.totalCapacity = libConfig.cacheSize;
		this.largestSize = libConfig.cacheFileSizeLimit;
		libConfig.subscribe(() => this.applyConfig());
	}

	private applyConfig(): void {
		this.totalCapacity = Math.max(libConfig.cacheSize, 0);
		this.largestSize = Math.max(libConfig.cacheFileSizeLimit, 0);

		/* check if the cache needs to be reduced */
		if (this.allocated > this.totalCapacity)
			this.reduce(this.totalCapacity);
	}
	private reduce(maximum: number): void {
		/* create the list of all cached objects sorted by the touched count */
		const paths: string[] = Object.keys(this.map).sort((a, b) => this.map[a].touched - this.map[b].touched);

		/* drop the first half of the entries or more, if the size has not yet been freed */
		for (let i = 0; i < (paths.length + 1) / 2 || this.allocated > maximum; ++i)
			this.drop(paths[i]);
	}

	public add(path: string, data: Buffer, mtime: number, age: number): void {
		if (!this.cacheable(data.byteLength))
			return;

		/* check if the entry is already part of the cache and check if the current entry should be evicted */
		if (path in this.map) {
			const entry = this.map[path];
			if (entry.age >= age)
				return;
			this.drop(path);
		}

		/* check if space needs to be reserved */
		if (this.allocated + data.byteLength > this.totalCapacity)
			this.reduce(this.totalCapacity - data.byteLength);

		/* add the entry to the cache */
		logger.log(`Added [${path}] to the cache (Size: ${data.byteLength})`);
		this.allocated += data.byteLength;
		this.map[path] = { data, encodings: {}, mtime, touched: ++this.nextStamp, age };
	}
	public addEncoding(path: string, data: Buffer, age: number, name: string): void {
		if (!this.cacheable(data.byteLength))
			return;

		/* check if the entry is still in the cache */
		if (!(path in this.map) || this.map[path].age != age)
			return;

		/* check if the encoding already exists */
		if (name in this.map[path].encodings)
			return;

		/* check if space needs to be reserved */
		if (this.allocated + data.byteLength > this.totalCapacity)
			this.reduce(this.totalCapacity - data.byteLength);

		/* add the entry to the cache */
		logger.log(`Added encoding [${name}] of [${path}] to the cache (Size: ${data.byteLength})`);
		this.allocated += data.byteLength;
		this.map[path].encodings[name] = data;
	}
	public drop(path: string): void {
		if (!(path in this.map))
			return;
		logger.log(`Dropped [${path}] and encodings from the cache`);

		/* remove all cached encodings and the entry itself */
		const entry = this.map[path];
		for (const key in entry.encodings)
			this.allocated -= entry.encodings[key].byteLength;
		this.allocated -= entry.data.byteLength;
		delete this.map[path];
	}
	public cacheable(size: number): boolean {
		return (size <= this.largestSize && size <= this.totalCapacity);
	}
	public flush(): void {
		this.map = {};
		this.allocated = 0;
	}
	public find(path: string, stats: { mtime: number, size: number } | null): CacheEntry | null {
		const entry = this.map[path] ?? null;
		if (entry == null)
			return null;

		/* check if the entry is still up-to-date and return it */
		if (stats == null || (entry.mtime == stats.mtime && entry.data.length == stats.size)) {
			entry.touched = ++this.nextStamp;
			return entry;
		}

		/* remove the entry as it seems to be outdated */
		this.drop(path);
		return null;
	}
}

interface ImmutableEntry {
	identifier: string;
	immutable: string;
	unique: string;
	path: string;
	fileSystem: string | null;
	size: number;
	mtime: number;
	fetched: boolean;
}
interface ImmutableSerialized {
	identifier: string;
	unique: string;
	path: string;
	fileSystem: string | null;
	size: number;
	mtime: number;
}
class ImmutableManager {
	private map: Record<string, ImmutableEntry> = {};
	private reverse: Record<string, string> = {};
	private writeBack: { path: string, writing: Promise<void> | null, dirty: boolean } | null = null;

	private assignId(entry: ImmutableEntry): void {
		const firstId = (entry.unique == '');
		if (!firstId)
			delete this.reverse[entry.unique];

		/* setup the new unique id */
		entry.unique = '';
		for (let i = 0; i < UNIQUE_ID_LENGTH; ++i)
			entry.unique += UNIQUE_ID_CHARS[libCrypto.randomInt(UNIQUE_ID_CHARS.length)];

		/* patch the state up to contain the new id */
		const [base, name, extension] = libLocation.SplitFilePath(entry.path);
		entry.immutable = `${base}${name}.${entry.unique}${extension}`;
		this.reverse[entry.unique] = entry.identifier;

		logger.trace(`${firstId ? 'Allocated' : 'Re-allocated'} immutable unique id [${entry.unique}] for [${entry.identifier}]`);
	}
	private async storeState(): Promise<void> {
		if (this.writeBack == null)
			return;
		this.writeBack.dirty = true;
		if (this.writeBack.writing != null)
			return;

		let resolver = () => { };
		this.writeBack.writing = new Promise((res) => resolver = res);

		/* check if the state is dirty and perform the write backs */
		while (this.writeBack.dirty) {
			this.writeBack.dirty = false;

			/* collect the list of all relevant entries */
			let output: ImmutableSerialized[] = [];
			for (const identifier in this.map) {
				const entry = this.map[identifier];
				output.push({
					unique: entry.unique,
					identifier,
					path: entry.path,
					fileSystem: entry.fileSystem,
					size: entry.size,
					mtime: entry.mtime
				});
			}
			const content: string = JSON.stringify(output);

			/* ignore any read/write failures */
			await libLocation.AtomicWrite(this.writeBack.path, content, 'immutable state', logger);
		}

		this.writeBack.writing = null;
		resolver();
	}
	private async loadState(path: string): Promise<ImmutableSerialized[]> {
		logger.trace(`Loading immutable state from [${path}]`);

		/* load the current file and parse it as json (skip any content failed to be read or if the file did not exist) */
		let state: unknown = null;
		try {
			const data = await new Promise<string>((resolve, reject) => libFs.readFile(path, { encoding: 'utf-8' }, (err: any, data: string) => {
				if (err == null)
					resolve(data);
				else
					reject(err);
			}));
			state = JSON.parse(data);
		} catch (err: any) {
			if (err.code != 'ENOENT')
				logger.error(`Error while loading immutable state from [${path}]: ${err.message}`);
			return [];
		}

		if (!Array.isArray(state)) {
			logger.error(`Immutable state [${path}] is malformed (discarding state)`);
			return [];
		}

		/* parse all of the values and validate their general structure */
		let corrupted = 0, output: ImmutableSerialized[] = [];
		for (const entry of state) {
			if (typeof entry.unique != 'string' || typeof entry.identifier != 'string' || (typeof entry.fileSystem != 'string' && entry.fileSystem !== null))
				++corrupted;
			else if (!`.${entry.unique}`.match(ID_EXTENSION_REGEX) || typeof entry.path != 'string')
				++corrupted;
			else if (typeof entry.mtime != 'number' || !isFinite(entry.mtime) || entry.mtime < 0)
				++corrupted;
			else if (typeof entry.size != 'number' || !isFinite(entry.size) || entry.size < 0 || Math.floor(entry.size) != entry.size)
				++corrupted;
			else
				output.push({ unique: entry.unique, identifier: entry.identifier, path: entry.path, fileSystem: entry.fileSystem, size: entry.size, mtime: entry.mtime });
		}

		if (corrupted > 0)
			logger.error(`Immutable loaded state [${path}] contained [${corrupted}] malformed entires`);
		return output;
	}
	private updateEntry(entry: ImmutableEntry, checkFreshness: boolean, firstAssign: boolean): boolean {
		if (entry.fetched && !checkFreshness && !libConfig.cacheAlwaysValidate)
			return true;

		/* fetch the file states of the actual filesystem entry */
		const stats = ReadStats(entry.fileSystem!);
		if (stats == null) {
			logger.warning(`Immutable path [${entry.fileSystem}] does not exist`);
			delete this.map[entry.identifier];
			delete this.reverse[entry.unique];
			this.storeState();
			return false;
		}
		const [fileSize, mtime] = stats;
		entry.fetched = true;

		/* check if the stats have changed, in which case a new unique-id needs to be assigned (thus binding the it to the stats) */
		if (!firstAssign) {
			if (entry.size == fileSize && entry.mtime == mtime)
				return true;
			this.assignId(entry);
		}
		entry.size = fileSize;
		entry.mtime = mtime;
		this.storeState();
		return true;
	}

	public make(handler: string, path: string, checkFreshness: boolean): string {
		const identifier = `${handler}:${path}`;
		if (!libConfig.cacheImmutableTagging)
			return path;

		while (true) {
			/* check if the entry does not yet exist and the id-tagged path needs to be created */
			let entry = this.map[identifier] ?? null;
			if (entry == null) {
				entry = (this.map[identifier] = { immutable: '', identifier, path, unique: '', fileSystem: null, size: 0, mtime: 0, fetched: false });
				this.assignId(entry);
				this.storeState();
			}

			/* check if the stats can actually be validated or if the entry should just be served (if
			*	the file does not exist/has been removed, simply restart the loop with to get a fresh id) */
			else if (entry.fileSystem != null) {
				try {
					if (!this.updateEntry(entry, checkFreshness, false))
						continue;
				} catch (err: any) {
					logger.warning(`Failed to validate immutable entry [${identifier}] and assuming unmodified: ${err.message}`);
				}
			}
			return entry.immutable;
		}
	}
	public get(path: string, checkFreshness: boolean): [ImmutableEntry | null, boolean] {
		if (!libConfig.cacheImmutableTagging)
			return [null, false];

		/* check if it might be an immutable-tagged path */
		const [base, temp, extension] = libLocation.SplitFilePath(path);
		const [_, name, tempId] = libLocation.SplitFilePath(temp);
		if (!tempId.match(ID_EXTENSION_REGEX))
			return [null, false];
		const unique = tempId.substring(1);

		/* check if the entry does not exist in the reverse mapping anymore - indicating that the unique-id
		*	is old/outdated, in which case it can be recovered by comparing the full actual path to all of
		*	the entries, looking for the actual object, thereby recovering the most recent immutable path */
		let identifier = this.reverse[unique] ?? null;
		if (identifier == null) {
			const fileSystemPath = `${base}${name}${extension}`;
			for (const tempIdentifier in this.map) {
				if (this.map[tempIdentifier].fileSystem != fileSystemPath)
					continue;
				identifier = tempIdentifier;
				break;
			}
			if (identifier == null)
				return [null, false];
		}
		const entry = this.map[identifier]!, firstAssign = (entry.fileSystem == null);
		if (entry.fileSystem == null)
			entry.fileSystem = `${base}${name}${extension}`;

		/* update the entry and return the final stats/if the unique-id changed */
		if (!this.updateEntry(entry, checkFreshness, firstAssign))
			return [null, false];
		return [entry, entry.unique != unique];
	}
	public invalidate(): void {
		for (const identifier in this.map)
			this.map[identifier].fetched = false;
	}
	public async setWriteBack(path: string): Promise<void> {
		/* fetch the new state to be written back (before updating the write-back to ensure
		*	the async operation does not result in the file being overwritten before being read) */
		let states = ((path == '' || path == this.writeBack?.path) ? [] : await this.loadState(path));

		/* wait for any current write-backs to be complete (loop to prevent race-conditions
		*	between resolving the promise and performing the next write-back) */
		while (this.writeBack?.writing != null)
			await this.writeBack.writing;
		if (path == '') {
			this.writeBack = null;
			return;
		}

		/* merge the loaded state into the current state (prefer current state over loaded state) */
		const performInitialWriteBack = (Object.keys(this.map).length > 0);
		for (const state of states) {
			if (state.identifier in this.map)
				continue;
			logger.trace(`Recovering immutable unique id [${state.unique}] for [${state.identifier}]`);

			const [base, name, extension] = libLocation.SplitFilePath(state.path);
			this.map[state.identifier] = {
				immutable: `${base}${name}.${state.unique}${extension}`,
				identifier: state.identifier,
				path: state.path,
				fileSystem: state.fileSystem,
				size: state.size,
				mtime: state.mtime,
				unique: state.unique,
				fetched: false
			};
			this.reverse[state.unique] = state.identifier;
		}

		/* check if the writeback should be configured and perform the first write back (only if the internal state contains any new data) */
		if (this.writeBack == null)
			this.writeBack = { path, writing: null, dirty: false };
		else if (this.writeBack.path == path)
			return;
		if (performInitialWriteBack)
			this.storeState();
	}
}
const cacheManager: CacheManager = new CacheManager();
const immutableManager: ImmutableManager = new ImmutableManager();

class AlreadyCached implements Cached {
	private path: string;
	private entry: CacheEntry;
	private immutable: boolean;

	public constructor(path: string, entry: CacheEntry, immutable: boolean) {
		this.path = path;
		this.entry = entry;
		this.immutable = immutable;
	}

	public isImmutable(): boolean {
		return this.immutable;
	}
	public filePath(): string {
		return this.path;
	}
	public fileSize(): number {
		return this.entry.data.byteLength;
	}
	public lastModified(): string {
		return new Date(this.entry.mtime).toUTCString();
	}
	public uniqueId(): string {
		return `${this.entry.mtime}-${this.entry.data.byteLength}`;
	}
	public stream(options?: { start?: number, end?: number }): libStream.Readable {
		return libStream.Readable.from(this.entry.data.subarray(options?.start, (options?.end == null ? undefined : options.end + 1)));
	}
	public async readAsync(): Promise<Buffer> {
		return this.entry.data;
	}
	public readSync(): Buffer {
		return this.entry.data;
	}
	public encoded(encoding: libBase.EncodingType): EncodedCache {
		return EncodedCache(this, this.entry, encoding, this.entry.age);
	}
}
class NotCached implements Cached {
	private path: string;
	private size: number;
	private mtime: number;
	private immutable: boolean;
	private age: number;

	public constructor(path: string, size: number, mtime: number, age: number, immutable: boolean) {
		this.path = path;
		this.size = size;
		this.mtime = mtime;
		this.immutable = immutable;
		this.age = age;
	}
	private makeStream(options?: { start?: number, end?: number }): libStream.Readable {
		/* create the data stream */
		let stream: libFs.ReadStream | null = null;
		try {
			stream = libFs.createReadStream(this.path, { flags: 'r', start: options?.start, end: options?.end });
		} catch (err: any) {
			return new libStream.Readable({ read() { this.destroy(new Error(`Error reading file: ${err.message}`)) } });
		}

		/* check if only a partial file is being read, or it is too large, in which case it will not be added to the cache */
		if (!cacheManager.cacheable(this.size) || (options?.start != null && options.start != 0) || (options?.end != null && options.end + 1 != this.size))
			return stream;

		/* create the transformer stream to cache the data */
		let buffers: Buffer[] = [], settled: boolean = false, totalLength: number = 0;
		const sniffer = new libStream.Transform({
			transform: (chunk, _, cb) => {
				if (settled) return cb(new Error('Reading already completed'));
				totalLength += chunk.byteLength;
				buffers.push(chunk);
				cb(null, chunk);
			},
			final: (cb) => {
				if (settled) return cb(new Error('Reading already completed'));
				if (totalLength == this.size)
					cacheManager.add(this.path, Buffer.concat(buffers), this.mtime, this.age);
				cb(null);
			}
		});

		/* setup the file exceptions to be propagated to the stream */
		stream.pipe(sniffer);
		stream.once('error', (err: any) => {
			if (settled) return; settled = true;
			sniffer.destroy(err);
		});
		sniffer.once('error', (err: any) => {
			if (settled) return; settled = true;
			stream.destroy(err);
		});
		return sniffer;
	}

	public isImmutable(): boolean {
		return this.immutable;
	}
	public filePath(): string {
		return this.path;
	}
	public fileSize(): number {
		return this.size;
	}
	public lastModified(): string {
		return new Date(this.mtime).toUTCString();
	}
	public uniqueId(): string {
		return `${this.mtime}-${this.size}`;
	}
	public stream(options?: { start?: number, end?: number }): libStream.Readable {
		return this.makeStream(options);
	}
	public async readAsync(): Promise<Buffer> {
		return StreamToAsync(this.makeStream());
	}
	public readSync(): Buffer {
		/* just let the errors propagate out */
		const data = libFs.readFileSync(this.path);

		/* check if the file-size changed mid operation */
		if (data.byteLength != this.size)
			throw new Error(`File size changed mid operation: [${data.byteLength}] != [${this.size}]`);

		/* add the read buffer back to the cache (using the fetched data from before
		*	reading the file - to detect a file-change since before reading the file) */
		cacheManager.add(this.path, data, this.mtime, this.age);
		return data;
	}
	public encoded(encoding: libBase.EncodingType): EncodedCache {
		return EncodedCache(this, null, encoding, this.age);
	}
}

function StreamToAsync(stream: libStream.Readable): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const buffers: Buffer[] = [];
		let settled: boolean = false;

		/* register the handler to collect the data and stream them out */
		stream.on("data", (chunk) => {
			if (!settled)
				buffers.push(chunk);
		});
		stream.once("error", (err) => {
			if (!settled) {
				settled = true;
				reject(err);
			}
		});
		stream.once("end", () => {
			if (!settled) {
				settled = true;
				resolve(Buffer.concat(buffers));
			}
		});
	});
}
function EncodedCache(reader: Cached, entry: CacheEntry | null, encoding: libBase.EncodingType, age: number): EncodedCache {
	/* check if the given encoding has already been cached */
	if (entry != null && encoding.name in entry.encodings) {
		const encoded = entry.encodings[encoding.name];
		return {
			contentSize: () => encoded.byteLength,
			stream: () => libStream.Readable.from(encoded),
			readSync: () => encoded,
			readAsync: async () => encoded
		};
	}

	const makeStream: () => libStream.Readable = () => {
		let settled: boolean = false;

		/* create the encoded pipe */
		const stream = reader.stream();
		const encoder = encoding.makeEncode();
		let sniffer: libStream.Transform | null = null;
		stream.pipe(encoder);

		/* setup the stream exceptions to be propgated through */
		stream.once('error', (err: any) => {
			if (settled) return; settled = true;
			encoder.destroy(err);
			if (sniffer != null)
				sniffer.destroy(err);
		});
		encoder.once('error', (err: any) => {
			if (settled) return; settled = true;
			stream.destroy(err);
			if (sniffer != null)
				sniffer.destroy(err);
		});

		/* check if there is even a chance for the data to be cached */
		if (!cacheManager.cacheable(reader.fileSize()))
			return encoder;

		/* setup the sniffer stream to collect the cached data */
		let buffers: Buffer[] = [];
		sniffer = new libStream.Transform({
			transform: (chunk, _, cb) => {
				if (settled) return cb(new Error('Reading already completed'));
				buffers.push(chunk);
				cb(null, chunk);
			},
			final: (cb) => {
				if (settled) return cb(new Error('Reading already completed'));
				cacheManager.addEncoding(reader.filePath(), Buffer.concat(buffers), age, encoding.name);
				cb(null);
			}
		});

		/* setup the stream exceptions to be propgated through */
		sniffer.once('error', (err: any) => {
			if (settled) return; settled = true;
			stream.destroy(err);
			encoder.destroy(err);
		});
		return encoder.pipe(sniffer);
	};

	/* wrap the original reader around the encoder (let errors propagate out) */
	return {
		contentSize: () => null,
		stream: () => makeStream(),
		readAsync: () => StreamToAsync(makeStream()),
		readSync: () => {
			/* will be returned as buffer anyways, so might as well
			*	try to write it back to the cache, no matter if its too large */
			const data = encoding.encodeBuffer(reader.readSync());
			cacheManager.addEncoding(reader.filePath(), data, age, encoding.name);
			return data;
		}
	};
}
function ResolveCache(path: string, checkFreshness: boolean, checkImmutable: boolean): Cached | string | null {
	/* check if the entry is immutable and fetch its actual path or
	*	if it has been moved (due to the id having been invalidated) */
	const [immutable, immutableMoved] = (checkImmutable ? immutableManager.get(path, checkFreshness) : [null, false]);
	if (immutable != null) {
		path = immutable.fileSystem!;
		if (immutableMoved)
			return immutable.immutable;
	}
	const isImmutable = (immutable != null);

	/* check if does not need to be checked and the entry is already in the cache, in which case the file doesn't even need to be checked */
	let entry = ((checkFreshness || libConfig.cacheAlwaysValidate) ? null : cacheManager.find(path, null));
	if (entry != null && (immutable == null || (immutable.size == entry.data.byteLength && immutable.mtime == entry.mtime)))
		return new AlreadyCached(path, entry, isImmutable);

	/* check if the file exists and read its file-size and mtime (not necessary
	*	for immutable entries, as their stats are already up-to-date) */
	const stats = (immutable == null ? ReadStats(path) : [immutable.size, immutable.mtime]);
	if (stats == null)
		return null;
	const [fileSize, mtime] = stats;

	/* check if the path exists in the validated cache and otherwise return the uncached entry */
	entry = cacheManager.find(path, { mtime, size: fileSize });
	if (entry != null)
		return new AlreadyCached(path, entry, isImmutable);
	return new NotCached(path, fileSize, mtime, Date.now(), isImmutable);
}

/* [throws] if [checkFreshness] is true, re-validate the file stats on disk before serving from cache (defaults
*	to false); resolve immutable ids automatically (Cached to interact with cache; null, if it does not exist,
*	string if the immutable path has been permanently moved to the new path in source space) */
export function GetImmutable(path: string, options?: { checkFreshness?: boolean }): Cached | string | null {
	return ResolveCache(path, options?.checkFreshness ?? false, true);
}

/* [throws] if [checkFreshness] is true re-validate the file stats on disk before serving from cache (defaults
*	to false); no immutable ids are resolved (Cached to interact with cache; null, if it does not exist) */
export function GetActual(path: string, options?: { checkFreshness?: boolean }): Cached | null {
	return ResolveCache(path, options?.checkFreshness ?? false, false) as (Cached | null);
}

/* generate a unique tagged path for the given query path, which will change whenever the underlying file changes;
*	[checkFreshness]: if true, re-validate the file stats on disk to detect changes (defaults to false); creates
*	a path to a file, which looks similar to the source, except that the name includes a unique id, which will be used
*	to identity the given file state (will be removed from the final target path to be served, to identify the actual source) */
export function MakeImmutable(handler: string, path: string, options?: { checkFreshness?: boolean }): string {
	return immutableManager.make(handler, path, options?.checkFreshness ?? false);
}

/* flush all cached data and invalidate immutable stats so they are re-checked on next access */
export function FlushCache(): void {
	logger.info('Flushing cache and invalidating immutable entries');
	cacheManager.flush();
	immutableManager.invalidate();
}

/* configure the write back of the immutable state to ensure persistent ids across restarts
*	(will be read upon configuring; if not configured, ids will be lost after a server restart) */
export async function ConfigureWriteBack(path: string | null): Promise<void> {
	await immutableManager.setWriteBack(path ?? '');
}

export interface Cached {
	/* check if this is an immutable file entry */
	isImmutable(): boolean;

	/* path of the file */
	filePath(): string;

	/* size in bytes of the file */
	fileSize(): number;

	/* fetch the last modified time formatted for the network */
	lastModified(): string;

	/* fetch the unique-id to identify this version of the cached file (constructed,
	*	just like the cache identifies them as equivalent: size+last-modified) */
	uniqueId(): string;

	/* [no-throw but errors] object or encoded entry must not be used anymore after reading or streaming from it */
	stream(options?: { start?: number, end?: number }): libStream.Readable;

	/* [throws] object or encoded entry must not be used anymore after reading or streaming from it */
	readAsync(): Promise<Buffer>;

	/* [throws] object or encoded entry must not be used anymore after reading or streaming from it */
	readSync(): Buffer;

	/* create an encoded version of this cached entry */
	encoded(encoding: libBase.EncodingType): EncodedCache;
}

export interface EncodedCache {
	/* size in bytes of the encoding (null if not yet determined) */
	contentSize(): number | null;

	/* [no-throw but errors] object or encoded entry must not be used anymore after reading or streaming from it */
	stream(): libStream.Readable;

	/* [throws] object or encoded entry must not be used anymore after reading or streaming from it */
	readAsync(): Promise<Buffer>;

	/* [throws] object or encoded entry must not be used anymore after reading or streaming from it */
	readSync(): Buffer;
}
